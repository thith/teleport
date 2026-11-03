// queue-control.mjs — RFC 29: the owner's operations on the `build` queue, shared by the
// daemon (`/q` buttons) and the CLI (`lock-queue.mjs max|retry|kick|top|block|unblock|pause|resume`).
//
// Every write goes through updatePolicy(): the `build.policy` helper lock (5 s), a strict read
// (a corrupt file refuses the write), the mutation, a validated atomic write. A kick / block also
// renames tickets (`.json` → `.kicked`, or `.left` for a waiter on pre-RFC 29 code) under that same lock,
// and leaves a notice file in `<LOCK_DIR>/build.notices/` — the daemon delivers it to the agent's convo.
// Role checks are the CALLER's job (the daemon is owner-only; an agent checks its own role before
// shelling out to lock-queue.mjs, like `leave --pid`).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LOCK_DIR, withPolicyLock, readQueue, cancelTickets, recordOwner, hasPreBoostWaiter, procStat,
} from './machine-lock.mjs';
import {
  readPolicy, writePolicy, defaultPolicy, pruneForWrite, parseDuration,
  MAX_QUEUE_LIMIT, RETRY_MIN_RANGE, MAX_BLOCKS, MAX_BOOSTS, TICKET_V,
} from './build-policy.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { normalizeAgentName } from './agent-target.mjs';

export const NOTICE_DIR = 'build.notices';
export const NOTICE_MAX_AGE_MS = 24 * 3600_000;
const NOT_SAVED = '⏳ bận (policy đang được cập nhật), thử lại';

// ── the guarded write ──

/**
 * mutate(policy, { dir, now }) runs under the policy lock on a pruned copy; it returns
 * `{ error }` (nothing written) or a value. `write:false` = it only renames tickets (kick): allowed even when the
 * policy file is corrupt. → { ok: true, value, policy } | { ok: false, why: 'busy'|'corrupt'|'invalid'|'rejected'|'noflock', message }.
 */
export async function updatePolicy(dir, mutate, { now = Date.now(), write = true, waitMs = 5000, queueNames = null, after = null } = {}) {
  let res;
  try {
    res = await withPolicyLock(dir, () => {
      const cur = readPolicy(dir, { now });
      if (cur.corrupt && write) return { ok: false, why: 'corrupt', message: `⚠️ build.policy.json đang hỏng (${cur.error}) — dùng /q → "Ghi lại policy mặc định" hoặc xoá file.` };
      const names = queueNames || new Set(readQueue('build', { dir, now }).map((t) => t.name));
      const pol = pruneForWrite(cur.policy, { now, tickets: names });
      const out = mutate(pol, { dir, now });
      if (out && out.error) return { ok: false, why: 'rejected', message: out.error };
      if (write) {
        try { writePolicy(dir, pol, { now }); } catch (e) { return { ok: false, why: 'invalid', message: `❌ ${e.message}` }; }
      }
      // `after` runs once the policy is on disk, still under the lock (block: strike tickets only AFTER the block exists)
      const extra = after ? after(pol, { dir, now }) : null;
      return { ok: true, value: extra ? { ...out, ...extra } : out, policy: pol };
    }, { waitMs });
  } catch (e) {
    return { ok: false, why: 'noflock', message: `❌ không lấy được policy lock (${e?.message ?? e})` };
  }
  if (res.busy) return { ok: false, why: 'busy', message: NOT_SAVED };
  return res.value;
}

/** Overwrite a corrupt (or any) policy with the defaults. Keeps nothing — the owner asked. */
export async function resetPolicy(dir, { now = Date.now(), waitMs = 5000 } = {}) {
  try {
    const res = await withPolicyLock(dir, () => { writePolicy(dir, defaultPolicy(), { now }); return { ok: true }; }, { waitMs });
    return res.busy ? { ok: false, why: 'busy', message: NOT_SAVED } : res.value;
  } catch (e) { return { ok: false, why: 'invalid', message: `❌ ${e?.message ?? e}` }; }
}

// ── settings ──

const intIn = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;

/** value: null (off) | 0..20. Remembers a numeric value as lastMax. */
export const setMax = (dir, value, opts = {}) => updatePolicy(dir, (p) => {
  if (!(value === null || intIn(value, 0, MAX_QUEUE_LIMIT))) return { error: `❌ max phải là off hoặc 0..${MAX_QUEUE_LIMIT}` };
  p.max = value;
  if (value !== null) p.lastMax = value;
  return { max: p.max };
}, opts);

/** The Max − / + buttons: off → back to lastMax (no step); otherwise ±1 within 0..20. */
export const stepMax = (dir, delta, opts = {}) => updatePolicy(dir, (p) => {
  p.max = p.max == null ? p.lastMax : Math.min(MAX_QUEUE_LIMIT, Math.max(0, p.max + delta));
  p.lastMax = p.max;
  return { max: p.max };
}, opts);

/** The middle Max button: off ⇄ lastMax. */
export const toggleMax = (dir, opts = {}) => updatePolicy(dir, (p) => {
  if (p.max == null) { p.max = p.lastMax; } else { p.lastMax = p.max; p.max = null; }
  return { max: p.max };
}, opts);

export const setRetry = (dir, minutes, opts = {}) => updatePolicy(dir, (p) => {
  if (!intIn(minutes, RETRY_MIN_RANGE[0], RETRY_MIN_RANGE[1])) return { error: `❌ số phút phải là ${RETRY_MIN_RANGE[0]}..${RETRY_MIN_RANGE[1]}` };
  p.retryMin = minutes;
  return { retryMin: minutes };
}, opts);

export const setPaused = (dir, paused, opts = {}) => updatePolicy(dir, (p) => { p.paused = !!paused; return { paused: p.paused }; }, opts);

// ── notices (outbox: the daemon delivers them to the agent's convo) ──

/** Write `{ kind: 'kicked'|'blocked', convoId, cmd, worktree, until? }` atomically. Best effort. */
export function writeNotice(dir, n, { now = Date.now() } = {}) {
  try {
    const d = path.join(dir, NOTICE_DIR);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const id = `${String(now).padStart(15, '0')}-${crypto.randomBytes(4).toString('hex')}`;
    const tmp = path.join(d, `${id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ ...n, at: now }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, path.join(d, `${id}.json`));
    return true;
  } catch { return false; }
}

/** → [{ file, notice }] oldest first (unreadable ones skipped; very old ones deleted). */
export function readNotices(dir, { now = Date.now() } = {}) {
  const d = path.join(dir, NOTICE_DIR);
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => /^\d{15}-[0-9a-f]{8}\.json$/.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    const file = path.join(d, f);
    try {
      const notice = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now - (notice.at ?? now) > NOTICE_MAX_AGE_MS) { fs.unlinkSync(file); continue; }
      out.push({ file, notice });
    } catch {}
  }
  return out;
}

/**
 * Deliver every pending notice: `deliver({ convoId, kind, until, text }, { build })` into the agent's convo, then delete the file.
 * No convo → just delete. A failed delivery stays for the next beat. → how many were handled.
 */
export async function deliverNotices({ dir = LOCK_DIR, deliver, build, now = Date.now(), log = (m) => console.error(m) } = {}) {
  let n = 0;
  for (const { file, notice } of readNotices(dir, { now })) {
    try {
      if (notice.convoId != null) await deliver({ convoId: notice.convoId, kind: notice.kind, until: notice.until ?? null, text: `${notice.cmd || ''}${notice.worktree ? ` (worktree ${path.basename(notice.worktree)})` : ''}` }, { build });
      fs.unlinkSync(file);
      n++;
    } catch (e) { log(`[queue-control] notice ${path.basename(file)}: ${e?.message ?? e}`); }
  }
  return n;
}

// ── kick / top / block ──

/** Strike matching waiting tickets (under the policy lock): `.kicked`, or `.left` for a ticket of pre-RFC 29 code; one notice each. */
function strike(dir, match, { kind, until = null, stat = procStat, now = Date.now() } = {}) {
  const struck = cancelTickets('build', match, { dir, stat, ext: (t) => (t.v >= TICKET_V ? 'kicked' : 'left') });
  for (const t of struck) writeNotice(dir, { kind, convoId: t.convoId ?? null, cmd: t.cmd || '', worktree: t.worktree || null, ...(until ? { until } : {}) }, { now });
  return struck;
}

/** Kick one waiting ticket (`name` = its file name; pid/procStart pin the waiter). Never touches a running build. */
export const kickTicket = (dir, { name, pid = null, procStart = null }, opts = {}) => updatePolicy(dir, (p) => {
  const struck = strike(dir, (t) => t.name === name && (pid == null || t.pid === pid) && (procStart == null || String(t.procStart) === String(procStart)), { kind: 'kicked', now: opts.now });
  if (!struck.length) return { error: '✖ vé đó không còn chờ (vừa bắt đầu chạy? dùng ⏹ để dừng build đang chạy)' };
  delete p.boosts[name];
  return { struck };
}, { ...opts, write: false });

/**
 * Put a waiting ticket first (boost = now). `toggle`: a ticket that is already boosted loses it.
 * Refused while a pre-RFC 29 waiter is in line (it ignores boosts).
 */
export const topTicket = (dir, { name, pid = null, procStart = null, toggle = false }, opts = {}) => updatePolicy(dir, (p, { now }) => {
  const tickets = readQueue('build', { dir, now });
  const t = tickets.find((x) => x.name === name && x.status === 'live' && (pid == null || x.pid === pid) && (procStart == null || String(x.procStart) === String(procStart)));
  if (!t) return { error: '✖ vé đó không còn ở trạng thái chờ' };
  if (hasPreBoostWaiter(tickets)) return { error: '⏳ còn người chờ chạy code cũ — chờ họ xong' };
  if (toggle && Number.isFinite(p.boosts[name])) { delete p.boosts[name]; return { boosted: false }; }
  if (Object.keys(p.boosts).length >= MAX_BOOSTS && !(name in p.boosts)) return { error: `❌ tối đa ${MAX_BOOSTS} vé lên đầu` };
  p.boosts[name] = now;
  return { boosted: true };
}, opts);

/**
 * The block a ⛔ press on this ticket would write, with a plain statement of its reach (§4.4).
 * → { owner, label, ident, scope, warn }. `repoName` for a git: owner.
 */
export function blockPlan(ticket, { stat = procStat } = {}) {
  const owner = recordOwner(ticket);
  const label = ticket.label || `pid ${ticket.pid}`;
  const [kind, ...restParts] = owner.split(':');
  const rest = restParts.join(':');
  if (kind === 'convo') return { owner, label, ident: null, scope: `chặn ${label} (convo ${rest})`, warn: false };
  if (kind === 'git') {
    const repo = path.basename(rest.replace(/\/\.git\/?$/, '')) || rest;
    return { owner, label, ident: null, scope: `⚠️ vé không có convo — chặn CẢ REPO ${repo} (mọi build không convo của repo này)`, warn: true };
  }
  // sid: / pid: — bound to the process identity, so a reused pid is never blocked by mistake
  const pid = kind === 'sid' ? Number(rest) : ticket.pid;
  const start = kind === 'sid' ? stat(pid)?.start : (ticket.procStart ?? stat(pid)?.start);
  return { owner, label, ident: Number.isSafeInteger(pid) && start != null ? { pid, procStart: String(start) } : null, scope: 'chặn riêng tiến trình/phiên này', warn: false };
}

/**
 * A typed owner string → a block plan. `sid:`/`pid:` get { pid, procStart } from the live process (a reused pid is then never
 * blocked); one whose identity can't be established is refused. convo:/git: need none. → plan | { error }.
 */
export function plainOwnerPlan(owner, { stat = procStat } = {}) {
  const m = /^(convo|git|sid|pid):(.+)$/.exec(String(owner));
  if (!m) return { error: `❌ owner không hợp lệ: ${owner}` };
  if (m[1] === 'sid' || m[1] === 'pid') {
    const pid = Number(m[2]);
    const st = Number.isSafeInteger(pid) && pid > 1 ? stat(pid) : null;
    if (!st || st.state === 'Z' || st.state === 'X') return { error: `❌ không xác định được tiến trình ${owner} (đã thoát?) — không chặn` };
    return { owner, label: owner, ident: { pid, procStart: String(st.start) }, scope: `chặn ${owner} (riêng tiến trình/phiên này)` };
  }
  return { owner, label: owner, ident: null, scope: `chặn ${owner}` };
}

/** Block `owner` until `until` and kick all its waiting tickets, under ONE hold of the policy lock. */
export const blockOwner = (dir, { owner, label, until, ident = null }, opts = {}) => updatePolicy(dir, (p, { now }) => {
  if (!(until > now)) return { error: '❌ thời hạn đã qua' };
  if (/^(sid|pid):/.test(owner) && !(ident && Number.isSafeInteger(ident.pid))) return { error: `❌ không xác định được tiến trình của ${owner} (đã thoát?) — không chặn` };
  p.blocks = p.blocks.filter((b) => b.owner !== owner);
  if (p.blocks.length >= MAX_BLOCKS) return { error: `❌ tối đa ${MAX_BLOCKS} mục chặn` };
  p.blocks.push({ owner, label: label || owner, until, at: now, ...(ident ? { ident } : {}) });
  return {};
}, { ...opts, after: (p, { now }) => ({ struck: strike(dir, (t) => recordOwner(t) === owner, { kind: 'blocked', until, now }) }) });

export const unblockOwner = (dir, owner, opts = {}) => updatePolicy(dir, (p) => {
  const before = p.blocks.length;
  p.blocks = p.blocks.filter((b) => b.owner !== owner);
  if (p.blocks.length === before) return { error: '✖ không thấy mục chặn đó (đã hết hạn?)' };
  return { removed: before - p.blocks.length };
}, opts);

// ── who is "Chuột" / "#a7611284"? ──

const strip = (s) => String(s ?? '').trim().replace(/^[^\p{L}\p{N}]+\s*/u, '').toLowerCase();

/**
 * Resolve a persona name or #hashtag to exactly one convo. `tiers` = candidate lists in priority order
 * (tickets+holders, then live agents, then topics.json); each candidate { convoId, names: [persona…], hashtag? }.
 * A tier with exactly one distinct convo wins; several → refuse and list them; none → the next tier.
 * → { convoId, label } | { error }. Pure.
 */
export function resolveQueueTarget(query, tiers) {
  const raw = String(query ?? '').trim();
  const hash = /^#?([a-j]\d{7}|t\d+)$/i.exec(raw);
  const byHash = hash ? hash[1].toLowerCase() : null;
  const lit = strip(raw), norm = normalizeAgentName(raw.replace(/_+/g, ' '));
  if (!raw) return { error: 'thiếu persona / #hashtag' };
  const hit = (c) => {
    const tag = (c.hashtag || shortConvoHash(c.convoId) || '').toLowerCase();
    if (byHash) return tag === byHash;
    return (c.names || []).some((n) => strip(n) === lit) || (c.names || []).some((n) => normalizeAgentName(n) === norm);
  };
  const show = (c) => `${(c.names || [])[0] || '?'} #${c.hashtag || shortConvoHash(c.convoId)} (convo ${c.convoId})`;
  for (const tier of tiers) {
    const byConvo = new Map();
    for (const c of tier) if (c && c.convoId != null && hit(c) && !byConvo.has(String(c.convoId))) byConvo.set(String(c.convoId), c);
    if (byConvo.size === 1) { const c = [...byConvo.values()][0]; return { convoId: String(c.convoId), label: `${(c.names || [])[0] || `#${c.hashtag || shortConvoHash(c.convoId)}`}` }; }
    if (byConvo.size > 1) return { error: `"${raw}" khớp ${byConvo.size} convo: ${[...byConvo.values()].map(show).join('; ')} — dùng #hashtag hoặc số trong bảng /q.` };
  }
  return { error: `không thấy "${raw}" (trong hàng, build đang chạy, agent đang sống, topics).` };
}

/** Does `query` (persona / #hash / owner string) name this stored block? Pure. */
export function blockMatches(b, query) {
  const raw = String(query ?? '').trim();
  if (!raw) return false;
  if (b.owner === raw) return true;
  const hash = /^#?([a-j]\d{7}|t\d+)$/i.exec(raw);
  if (hash) { const m = /^convo:(\d+)$/.exec(b.owner); return !!m && shortConvoHash(m[1]).toLowerCase() === hash[1].toLowerCase(); }
  return strip(String(b.label || '').replace(/\s#[a-z0-9]+$/i, '')) === strip(raw) || normalizeAgentName(String(b.label || '').replace(/\s#[a-z0-9]+$/i, '')) === normalizeAgentName(raw);
}

/** `<target…> <duration>` → { target, until } | { error }: the LAST token is the duration (so a multi-word persona works). */
export function parseBlockArgs(text, { now = Date.now() } = {}) {
  const toks = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (toks.length < 2) return { error: 'usage: block <số | persona | #hash> <30m | 1h | 2h30m | today>' };
  const d = parseDuration(toks[toks.length - 1], { now });
  if (d.error) return { error: d.error };
  return { target: toks.slice(0, -1).join(' '), until: d.until };
}
