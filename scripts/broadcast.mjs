// `/broadcast <text>` — a daemon command (no project). Injects ONE system message
// into every topic that `/ls` shows (running agent: claude proc or tele-* screen) — dead
// topics are skipped and counted . Use-case: tell every running
// agent "reload the telegram guide, rules changed". Nothing posted to a group; each
// agent picks it up as a prompt with `broadcast:true` and applies it (may ack briefly).
// Admin-only (gated by commands.json minRole). Identity from the daemon via TELE_FROM_*.
//
//   /broadcast <text>            → every group the admin configures (RFC 11)
//   /broadcast --chat <id> <text> → limit to one group
//
// Durable fan-out (RFC 03 §5.1): each topic's prompt is coalesced/spooled under its
// per-convo write-lock — a busy topic no longer bounces (nothing skipped); a dead
// agent's prompt just waits. Prints a sent summary for the daemon to relay.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { listLiveTopics } from './handover.mjs';
import { lsHashtagSet, personaByHashtag } from './spawn.mjs';
import { formatPersona } from './persona.mjs';
import { durableWrite } from './steer.mjs';
import { DEFAULT_TMP_DIR } from './tele-listen.mjs';
import { readProjectsConfig, resolveDefaultChatId, projectEntries, resolveProjectKey } from './projects-config.mjs';
import { lookupAllocationByConvo, CONVO_SCHEMA_VERSION } from './convo-registry.mjs';
import { tokenizeArgs } from './commands.mjs';
import { PARENT_DIR } from './workspace.mjs';
import { worktreeOf, gitCommonDir } from './machine-lock.mjs';

export const USAGE = 'usage: /broadcast [--now] [--p:<dự án>[,…]] [--chat <id>] <text>';

// All group chat ids (catch-all + dedicated) — the default broadcast scope.
export function groupChatIds(config, { env = process.env, envFile = {} } = {}) {
  const ids = new Set();
  const def = resolveDefaultChatId(config, { env, envFile });
  if (def) ids.add(String(def));
  for (const [, p] of projectEntries(config)) if (p && p.chatId && String(p.chatId).trim()) ids.add(String(p.chatId).trim());
  return [...ids];
}

/**
 * RFC 38 §3.1 — the ONE parser of the LEADING options, in any order: `--now`, `--p:<a>[,<b>]` (also `--p=`,
 * `--project:`, `--project=`), `--chat <id>` / `--chat=<id>`. `input` = the raw text (the rest stays VERBATIM:
 * quotes, newlines) or a token array. The first word NOT starting with `--` begins the text; an unknown `--word`,
 * an empty `--p:` part, a repeated option, no text → `error` (nothing is ever sent on an error). A `--chat`
 * inside the text is refused (RFC 37 compat: an old `… --chat` at the end must not widen the scope). Pure.
 */
export function parseBroadcastOptions(input) {
  const raw = typeof input === 'string';
  let s = raw ? input.trim() : '', i = 0;
  const head = () => (raw ? (s.match(/^\S+/)?.[0] ?? null) : (input[i] ?? null));
  const shift = () => { if (raw) s = s.replace(/^\S+\s*/, ''); else i++; };
  const out = { chat: null, now: false, projects: null, text: '', error: null };
  const bad = (m) => ({ ...out, text: '', error: `${m} — ${USAGE}` });
  for (let w = head(); w != null && w.startsWith('--'); w = head()) {
    shift();
    const low = w.toLowerCase();
    let m;
    if (low === '--now') { if (out.now) return bad('--now lặp lại'); out.now = true; }
    else if ((m = low.match(/^--(?:p|project)[:=]/))) {
      if (out.projects) return bad('--p lặp lại');
      const parts = w.slice(m[0].length).split(',').map((x) => x.trim());
      if (!parts.length || parts.some((x) => !x || /\s/.test(x))) return bad('--p: có phần rỗng');
      out.projects = [...new Set(parts.map((x) => x.toLowerCase()))];
    } else if (low === '--chat' || low.startsWith('--chat=')) {
      if (out.chat != null) return bad('--chat lặp lại');
      let id = low === '--chat' ? head() : w.slice('--chat='.length);
      if (low === '--chat') shift();
      if (!id || id.startsWith('--')) return bad('--chat thiếu id');
      out.chat = id;
    } else return bad(/chat/i.test(w) ? '--chat phải đứng đầu (không trong ngoặc)' : `tuỳ chọn lạ: ${w.slice(0, 40)} (tuỳ chọn phải đứng đầu, không trong ngoặc)`);
  }
  out.text = (raw ? s : input.slice(i).join(' ')).trim();
  if (!out.text) return bad('thiếu nội dung');
  if (/--chat/i.test(out.text)) return bad('--chat phải đứng đầu (không trong ngoặc)');
  return out;
}
export const parseBroadcastRaw = parseBroadcastOptions;
export const parseBroadcastArgs = parseBroadcastOptions;

/** Raw text AND its tokenized reading (quotes honoured) must both parse and agree on the options (RFC 38 §3.1). */
export function parseBroadcastBoth(raw) {
  const a = parseBroadcastOptions(raw);
  if (a.error) return a;
  const b = parseBroadcastOptions(tokenizeArgs(raw));
  const key = (x) => JSON.stringify([x.chat, x.now, x.projects]);
  if (b.error || key(a) !== key(b)) return { ...a, text: '', error: `❌ tuỳ chọn phải đứng đầu, không trong ngoặc — ${USAGE}` };
  return a;
}

// ── RFC 37: the pieces the `/broadcast` button board is built from ──

export const OTHER_PROJECT = 'khác';
const normTag = (h) => String(h).replace(/^#/, '').toLowerCase();

/**
 * One candidate per convo (RFC 37 §3.2): listLiveTopics gives a row per (chat, convo); the chat kept is
 * the one of the NEWEST topic (`ts`), a tie → the smaller chat id (string order). Pure.
 */
export function candidateTopics(store, chatIds) {
  const best = new Map();
  for (const t of listLiveTopics(store, chatIds)) {
    const cur = best.get(t.convoId);
    if (!cur || t.ts > cur.ts || (t.ts === cur.ts && t.chatId < cur.chatId)) best.set(t.convoId, t);
  }
  return [...best.values()];
}

/**
 * Which of `targets` ({convoId, hashtag}) are running, in /ls order → [{ target, row, i }]. The SAME rule at
 * board time and at Send time (RFC 37 §3.1): an /ls row with a convoId matches that convo exactly; a row with
 * only a hashtag (an empty tele-* screen) matches only when that hashtag is UNIQUE across the whole store
 * (every chat, distinct convoIds). Pure.
 */
export function resolveLive(targets, lsRows, store) {
  const entries = [...(lsRows || [])];
  const tagOwners = new Map(); // hashtag → distinct convoIds in the store
  for (const t of listLiveTopics(store, Object.keys(store || {}))) {
    const k = normTag(t.hashtag);
    if (!tagOwners.has(k)) tagOwners.set(k, new Set());
    tagOwners.get(k).add(String(t.convoId));
  }
  const indexOf = (t) => entries.findIndex((e) => {
    const isObj = e && typeof e === 'object';
    if (isObj && e.convoId != null) return String(e.convoId) === String(t.convoId);
    const h = isObj ? e.hashtag : e;
    if (!h || normTag(h) !== normTag(t.hashtag)) return false;
    const owners = tagOwners.get(normTag(t.hashtag)); // the UNIQUE current owner of the hashtag must be this very target
    return !!owners && owners.size === 1 && owners.has(String(t.convoId));
  });
  return targets.map((target) => ({ target, i: indexOf(target) })).filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i).map((x) => ({ ...x, row: entries[x.i] }));
}

/** Repo name from a git common dir: `/x/repo/.git` → `repo`, a bare `/x/repo.git` → `repo`. */
const repoNameOf = (common) => {
  const base = path.basename(common);
  return base === '.git' ? path.basename(path.dirname(common)) : base.replace(/\.git$/, '');
};

/**
 * The project of one running session (RFC 37 §3.2, RFC 15 order, no `git` subprocess):
 * allocation of the convo → cwd's git repo (worktrees fold into the main repo; outside a repo: nothing) →
 * the chat when it is the dedicated group of exactly ONE project → 'khác'.
 */
export function projectOf({ convoId, chatId, cwd }, { config = {}, allocRows: rawRows = [], botId = null, worktreeFn = worktreeOf, commonDirFn = gitCommonDir } = {}) {
  const allocRows = Array.isArray(rawRows) ? rawRows : rawRows?.rows ?? []; // readRows() returns { rows, … }
  try {
    const a = allocRows.length ? lookupAllocationByConvo(allocRows, Number(convoId), botId) : null;
    if (a && a.projectKey) return resolveProjectKey(a.projectKey, config);
  } catch { /* fall through */ }
  if (cwd) {
    try {
      const common = commonDirFn(worktreeFn(cwd));
      if (common) { const name = repoNameOf(common); if (name) return resolveProjectKey(name, config); }
    } catch { /* fall through */ }
  }
  const owners = projectEntries(config).filter(([, p]) => p && p.chatId != null && String(p.chatId).trim() === String(chatId));
  if (owners.length === 1) return owners[0][0];
  return OTHER_PROJECT;
}

/**
 * The running sessions for the board: [{ convoId, chatId, hashtag, project, label }], deduped by convo,
 * in /ls order (projects are grouped by the caller in first-seen order). `ls` = /ls rows (with `cwd`).
 */
export function listTargets({ store, chatIds, ls, config = {}, allocRows = [], botId = null, projectDeps = {} }) {
  const live = resolveLive(candidateTopics(store, chatIds), ls, store);
  return live.map(({ target: t, row }) => ({
    convoId: String(t.convoId), chatId: String(t.chatId), hashtag: t.hashtag,
    project: projectOf({ convoId: t.convoId, chatId: t.chatId, cwd: row && typeof row === 'object' ? row.cwd : null }, { config, allocRows, botId, ...projectDeps }),
    label: `${t.persona ? `${formatPersona(t.persona)} ` : ''}#${t.hashtag}`,
  }));
}

/**
 * RFC 38 §3.2 — every project name `--p:` may use → Map(lowercase → [names]). Exact names only (the typed text never
 * goes through resolveProjectKey): config keys, running sessions, VALID allocation rows (same rule as
 * lookupAllocationByConvo), sibling git dirs of the teleport dir (worktrees fold into their repo), and 'khác'.
 */
export function knownProjects({ config = {}, targets = [], allocRows: rawRows = [], botId = null, parentDir = PARENT_DIR, listDirs = null, worktreeFn = worktreeOf, commonDirFn = gitCommonDir } = {}) {
  const names = new Set([OTHER_PROJECT, ...projectEntries(config).map(([k]) => k), ...targets.map((t) => t.project)]);
  const rows = Array.isArray(rawRows) ? rawRows : rawRows?.rows ?? [];
  for (const r of rows) {
    if (!r || (typeof r.v === 'number' && r.v > CONVO_SCHEMA_VERSION) || r.botId !== botId || r.messageId !== r.convoId || !r.projectKey || r.resolvedBy === 'default-unresolved') continue;
    names.add(resolveProjectKey(r.projectKey, config));
  }
  try {
    const dirs = listDirs ? listDirs() : fs.readdirSync(parentDir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => path.join(parentDir, d.name));
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(path.join(dir, '.git'))) continue;
        const common = commonDirFn(worktreeFn(dir));
        const name = common ? repoNameOf(common) : '';
        if (name) names.add(resolveProjectKey(name, config));
      } catch { /* skip this dir */ }
    }
  } catch { /* no sibling dirs known */ }
  const map = new Map();
  for (const n of names) { const k = n.toLowerCase(); map.set(k, [...(map.get(k) || []), n]); }
  return map;
}

/** `wanted` (lowercase names) against the known set → { set: Set(lowercase), names: Map(lower → name) } | { error }. */
export function checkProjects(wanted, known, running = []) {
  const unknown = wanted.filter((w) => !known.has(w));
  if (unknown.length) {
    const list = running.join(', ');
    return { error: `❌ không có dự án: ${unknown.join(', ')}. Đang chạy: ${list.length > 600 ? `${list.slice(0, 600)}…` : list || '(không có)'}` };
  }
  const amb = wanted.filter((w) => known.get(w).length > 1);
  if (amb.length) return { error: `❌ tên dự án mơ hồ (chỉ khác hoa thường): ${amb.map((w) => known.get(w).join(' / ')).join('; ')}` };
  return { set: new Set(wanted), names: new Map(wanted.map((w) => [w, known.get(w)[0]])) };
}

/** Durable prompt write (RFC 03 §5.1) to each target → { sent: [target], failed: [target] }. One write per convo. */
export async function sendTo(targets, text, from = {}, { tmpDir = DEFAULT_TMP_DIR, writePrompt = durableWrite } = {}) {
  const sent = [], failed = [];
  for (const t of targets) {
    const prompt = buildBroadcastPrompt({ targetConvoId: t.convoId, targetChatId: t.chatId, fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text });
    try { await writePrompt(prompt, path.join(tmpDir, `prompt-convo-${t.convoId}.json`)); sent.push(t); }
    catch { failed.push(t); }
  }
  return { sent, failed };
}

// The injected system prompt. `broadcast:true` marks it; non-privileged `fromRole`
// (the sender's real role is carried for the receiver's sensitive-action gate, but
// 'broadcast' itself grants nothing). `messageId:null` = injected, not a real message.
export function buildBroadcastPrompt({ targetConvoId, targetChatId, fromUserId, fromName, fromRole, text }) {
  return {
    text,
    messageId: null,
    chatId: targetChatId == null ? null : String(targetChatId),
    fromUserId: fromUserId == null || fromUserId === '' ? null : String(fromUserId),
    fromName: fromName || 'admin',
    fromRole: fromRole || 'member',
    fromMember: null,
    replyToMessageId: null,
    replyToText: null,
    quotedText: null,
    timestamp: Math.floor(Date.now() / 1000),
    attachments: [],
    convoId: Number(targetConvoId),
    broadcast: { from: { role: fromRole || 'member' }, text },
  };
}

// Fan out to every live topic. Returns { ok, sent, skipped, total, message }.
// Pure-ish: deps injectable for tests.
export async function doBroadcast(argv, {
  from = {}, config = readProjectsConfig(), store = readTopicsStore(),
  tmpDir = DEFAULT_TMP_DIR, writePrompt = durableWrite, env = process.env, envFile = {},
  raw = process.env.TELE_RAW_ARGS, // the daemon's untokenized text; unset/'' → argv
  lsHashtags = lsHashtagSet,       // () => /ls rows ({convoId,hashtag} | hashtag); throws → fail closed
  personaOf = null,                // (hashtag) → name; default = /ls's lookup (personaByHashtag + formatPersona)
} = {}) {
  // Raw mode keeps the text verbatim but must agree with the tokenized reading: never send wider.
  const args = raw ? parseBroadcastBoth(raw) : parseBroadcastOptions(argv);
  if (args.error) return { ok: false, message: args.error };
  if (args.now || args.projects) return { ok: false, message: '❌ --now / --p: chỉ dùng qua daemon (/broadcast trong Telegram).' };
  const chatIds = args.chat ? [String(args.chat)] : groupChatIds(config, { env, envFile });
  const all = listLiveTopics(store, chatIds);
  if (!all.length) return { ok: false, message: '📢 broadcast: no live topics found (nothing sent).' };
  // Only topics /ls shows (running agents). Fail closed if the listing itself breaks.
  // Entries are `{convoId, hashtag}` (a bare string = hashtag only). A convoId matches exactly; a
  // hashtag-only row matches only when that hashtag belongs to ONE candidate topic (short hashes can
  // collide across convoIds — ambiguous → skipped, counted as not running).
  let entries;
  try { entries = [...(await lsHashtags())]; }
  catch (e) { return { ok: false, message: `📢 broadcast: không liệt kê được agent đang chạy (${e?.message || e}) — nothing sent.` }; }
  const norm = (h) => String(h).replace(/^#/, '').toLowerCase();
  const tagCount = new Map();
  // Uniqueness is store-wide (every chat), not just the --chat scope: a hashtag-only row may belong to
  // a topic in another chat. Distinct convoIds only.
  const seenConvo = new Set();
  for (const t of listLiveTopics(store, Object.keys(store || {}))) {
    if (seenConvo.has(t.convoId)) continue;
    seenConvo.add(t.convoId);
    tagCount.set(norm(t.hashtag), (tagCount.get(norm(t.hashtag)) || 0) + 1);
  }
  // Position of a topic in /ls order (first matching row), or -1.
  const lsIndex = (t) => entries.findIndex((e) => {
    const isObj = e && typeof e === 'object';
    if (isObj && e.convoId != null) return String(e.convoId) === String(t.convoId);
    const h = isObj ? e.hashtag : e;
    return !!h && norm(h) === norm(t.hashtag) && tagCount.get(norm(t.hashtag)) === 1;
  });
  const live = all.map((t) => ({ t, i: lsIndex(t) })).filter((x) => x.i >= 0).sort((x, y) => x.i - y.i).map((x) => x.t);
  if (!live.length) return { ok: false, total: 0, message: '📢 broadcast — không có session nào đang chạy (/ls trống), không gửi gì.' };

  // RFC 03 §5.1: durable coalesce/spool into each topic — a busy topic no longer
  // bounces, so nothing is skipped; a hard write/lock failure (rare) is surfaced.
  const label = (t) => {
    let p = null;
    try { p = personaOf(t.hashtag); } catch { /* hashtag only */ }
    return `${p ? `${p} ` : ''}#${t.hashtag}`;
  };
  let pmap = {};
  if (!personaOf) { try { pmap = personaByHashtag(store); } catch { /* hashtag only */ } personaOf = (h) => (pmap[h] ? formatPersona(pmap[h]) : null); }
  let sent = 0; const okLines = []; const failLines = [];
  for (const t of live) {
    const prompt = buildBroadcastPrompt({
      targetConvoId: t.convoId, targetChatId: t.chatId,
      fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text: args.text,
    });
    const promptFile = path.join(tmpDir, `prompt-convo-${t.convoId}.json`);
    try {
      await writePrompt(prompt, promptFile);
      sent++; okLines.push(label(t));
    } catch (e) {
      failLines.push(`${label(t)} — không ghi được hàng đợi`);   // real write/lock failure (not busy) → continue fan-out
    }
  }
  const msg = [`📢 broadcast — ${live.length} session`, '', '✅ Đã gửi', ...okLines,
    ...(failLines.length ? ['', '❌ Lỗi', ...failLines] : [])].join('\n');
  return { ok: true, sent, skipped: failLines.length, total: live.length, message: msg };
}

if (isMainModule(import.meta.url)) {
  const from = { id: process.env.TELE_FROM_ID, role: process.env.TELE_FROM_ROLE, name: process.env.TELE_FROM_NAME };
  const res = await doBroadcast(process.argv.slice(2), { from });
  process.stdout.write((res.message || '') + '\n');
  process.exit(res.ok ? 0 : 1);
}
