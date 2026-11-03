// build-policy.mjs — RFC 29: the owner's rules for the `build` queue, stored in
// `<LOCK_DIR>/build.policy.json` (mode 0600, atomic writes under the `build.policy`
// helper lock — see machine-lock.mjs `withPolicyLock`).
//
//   { v:1, max, lastMax, retryMin, paused, blocks:[{owner,label,until,at,ident?}], boosts:{<ticket>:<ms>} }
//
// No file = no restriction. A corrupt / wrong-schema file = "corrupt": readers treat it as
// no restriction (so a bad file never blocks every build), but every OTHER write is refused
// until the owner resets it. Pure functions + tiny file IO; no dependency on machine-lock
// (which imports this file).

import fs from 'node:fs';
import path from 'node:path';

export const POLICY_FILE = 'build.policy.json';
export const MAX_QUEUE_LIMIT = 20;
export const DEFAULT_LAST_MAX = 4;
export const DEFAULT_RETRY_MIN = 10;
export const RETRY_MIN_RANGE = [1, 120];
export const MAX_BLOCKS = 50;
export const MAX_BOOSTS = 50;
/** Tickets written by RFC 29 code carry v ≥ 29: they understand `.kicked` and boosts. */
export const TICKET_V = 29;

export const policyFile = (dir) => path.join(dir, POLICY_FILE);

export const defaultPolicy = () => ({ v: 1, max: null, lastMax: DEFAULT_LAST_MAX, retryMin: DEFAULT_RETRY_MIN, paused: false, blocks: [], boosts: {} });

const isInt = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;

/**
 * Schema check → null (ok) | reason. `now` + `requireFuture`: on WRITE every block must still be in
 * the future; on READ an expired block is simply filtered, not an error.
 */
export function validatePolicy(p, { now = Date.now(), requireFuture = false } = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'không phải object';
  if (p.v !== 1) return 'v phải là 1';
  if (!(p.max === null || isInt(p.max, 0, MAX_QUEUE_LIMIT))) return `max phải là null hoặc 0..${MAX_QUEUE_LIMIT}`;
  if (!isInt(p.lastMax, 0, MAX_QUEUE_LIMIT)) return `lastMax phải là 0..${MAX_QUEUE_LIMIT}`;
  if (!isInt(p.retryMin, RETRY_MIN_RANGE[0], RETRY_MIN_RANGE[1])) return `retryMin phải là ${RETRY_MIN_RANGE[0]}..${RETRY_MIN_RANGE[1]}`;
  if (typeof p.paused !== 'boolean') return 'paused phải là boolean';
  if (!Array.isArray(p.blocks) || p.blocks.length > MAX_BLOCKS) return `blocks phải là mảng ≤ ${MAX_BLOCKS}`;
  for (const b of p.blocks) {
    if (!b || typeof b !== 'object' || typeof b.owner !== 'string' || !b.owner) return 'block thiếu owner';
    if (!Number.isFinite(b.until)) return 'block thiếu until';
    if (requireFuture && !(b.until > now)) return 'block.until phải ở tương lai';
    if (b.ident != null && !(b.ident && Number.isSafeInteger(b.ident.pid))) return 'block.ident sai';
  }
  if (!p.boosts || typeof p.boosts !== 'object' || Array.isArray(p.boosts) || Object.keys(p.boosts).length > MAX_BOOSTS) return `boosts phải là object ≤ ${MAX_BOOSTS}`;
  for (const v of Object.values(p.boosts)) if (!Number.isFinite(v)) return 'boost sai';
  return null;
}

const procStartOf = (pid) => {
  try { const t = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return t.slice(t.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; }
};

/** A block still in force: not expired, and (sid:/pid: blocks) its process identity still alive — a reused pid never inherits it. */
export function blockActive(b, { now = Date.now(), startOf = procStartOf } = {}) {
  if (!(b.until > now)) return false;
  if (b.ident) {
    const s = startOf(b.ident.pid);
    if (s == null || (b.ident.procStart != null && String(s) !== String(b.ident.procStart))) return false;
  }
  return true;
}

/** → { policy, corrupt, error? }. Missing file → defaults. Corrupt → defaults + corrupt:true. Inactive blocks filtered out. */
export function readPolicy(dir, { now = Date.now(), read = (f) => fs.readFileSync(f, 'utf8'), startOf = procStartOf } = {}) {
  let text;
  try { text = read(policyFile(dir)); } catch (e) {
    if (e?.code === 'ENOENT') return { policy: defaultPolicy(), corrupt: false, missing: true };
    return { policy: defaultPolicy(), corrupt: true, error: e?.message ?? String(e) };
  }
  let p;
  try { p = JSON.parse(text); } catch (e) { return { policy: defaultPolicy(), corrupt: true, error: `JSON: ${e.message}` }; }
  const err = validatePolicy(p, { now });
  if (err) return { policy: defaultPolicy(), corrupt: true, error: err };
  return { policy: { ...p, blocks: p.blocks.filter((b) => blockActive(b, { now, startOf })) }, corrupt: false };
}

/** The active block on `owner`, or null. */
export const blockOf = (policy, owner, opts = {}) => policy.blocks.find((b) => b.owner === owner && blockActive(b, opts)) || null;

/** Atomic write (temp + rename), mode 0600. Validates first (throws). Caller holds the policy lock. */
export function writePolicy(dir, policy, { now = Date.now() } = {}) {
  const err = validatePolicy(policy, { now, requireFuture: true });
  if (err) throw new Error(`build.policy không hợp lệ: ${err}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = policyFile(dir);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(policy) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Drop blocks no longer in force and boosts of tickets that are gone (keeps the file small). */
export function pruneForWrite(policy, { now = Date.now(), tickets = null, startOf = procStartOf } = {}) {
  const out = { ...policy, blocks: policy.blocks.filter((b) => blockActive(b, { now, startOf })), boosts: { ...policy.boosts } };
  if (tickets) for (const k of Object.keys(out.boosts)) if (!tickets.has(k)) delete out.boosts[k];
  return out;
}

/** "2h30m" / "90m" / "1h" / "today" → ms from `now` (today = until local midnight). Errors → { error }. Pure. */
export function parseDuration(text, { now = Date.now() } = {}) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return { error: 'thiếu thời hạn' };
  if (t === 'today' || t === 'hôm nay' || t === 'hết hôm nay') {
    const d = new Date(now); d.setHours(24, 0, 0, 0);
    return { until: d.getTime() };
  }
  const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(t);
  if (!m || (m[1] == null && m[2] == null)) return { error: `thời hạn không hiểu: "${text}" (vd 30m, 1h, 2h30m, today)` };
  const ms = (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60_000;
  if (!(ms > 0)) return { error: 'thời hạn phải > 0' };
  if (ms > 7 * 24 * 3600_000) return { error: 'thời hạn tối đa 7 ngày' };
  return { until: now + ms };
}
