// Persistent per-convo "waiting for admin reply" tracker.
//
// Schema (`scripts/tmp/pending.json`):
//
//   {
//     "<convoId>": {
//       "project": "tea_game",
//       "lastBotSend": "2026-05-22T10:00:00.000Z",
//       "lastBotSendMessageId": 2700,
//       "lastAdminReply": "2026-05-22T09:55:00.000Z" | null,
//       "remindedAt": "2026-05-22T12:00:00.000Z" | null
//     },
//     ...
//   }
//
// Semantics:
// - "Pending" = `lastBotSend > (lastAdminReply ?? 0)` AND elapsed > threshold.
// - `remindedAt` prevents the heartbeat from spamming the same convo; cleared
//   on the next admin reply (admin engaged → reset the counter).
// - Entry is keyed by convoId (numeric, but JSON object keys are strings).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shortConvoHash } from './convo-hash.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PENDING_FILE = path.join(__dirname, 'tmp', 'pending.json');
export const REMIND_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours
export const PENDING_CAP = 500; // GC ceiling to keep file bounded
// Hard TTL: entries older than this are excluded from /pending output and
// auto-reminders, and are dropped from disk on the next write. Prevents stale
// agents that finished long ago from permanently appearing as "waiting".
// Hoisted above `writePendingStore` so the TTL sweep can reference it without
// TDZ risk on synchronous module init paths.
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

function atomicWriteFileSync(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function readPendingStore(file = DEFAULT_PENDING_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

export function writePendingStore(data, file = DEFAULT_PENDING_FILE, { now = Date.now() } = {}) {
  // TTL sweep: drop entries whose lastBotSend is older than PENDING_MAX_AGE_MS
  // (24h). This prevents the disk file from growing unboundedly between
  // PENDING_CAP triggers and matches the "hard TTL" semantic that
  // listPending already enforces in memory.
  const survivors = {};
  for (const [k, v] of Object.entries(data)) {
    const t = Date.parse(v.lastBotSend ?? '') || 0;
    // Drop entries with NO bot-send timestamp at all (phantom entries from
    // race-safe `recordAdminReply` upsert with no prior send). They never
    // surface in `listPending` (botSendT === 0 filter) but would otherwise
    // count against PENDING_CAP and accumulate indefinitely.
    if (t === 0) continue;
    if (now - t <= PENDING_MAX_AGE_MS) survivors[k] = v;
  }
  data = survivors;
  // GC: when surviving entries exceed PENDING_CAP, keep newest `lastBotSend` only.
  const entries = Object.entries(data);
  if (entries.length > PENDING_CAP) {
    entries.sort(([, a], [, b]) => {
      const ta = Date.parse(a.lastBotSend ?? '') || 0;
      const tb = Date.parse(b.lastBotSend ?? '') || 0;
      return tb - ta;
    });
    data = Object.fromEntries(entries.slice(0, PENDING_CAP));
  }
  atomicWriteFileSync(file, JSON.stringify(data, null, 2));
}

const LOCK_MAX_WAIT_MS = 1000;
const LOCK_RETRY_MS = 25;

function acquireFileLock(file) {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) fs.unlinkSync(lockPath);
      } catch {}
      const t = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < t) { /* busy wait, cheap */ }
    }
  }
  return null;
}

function releaseFileLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch {}
}

/**
 * Atomic read-modify-write under a coarse file lock. Best-effort: if lock can't
 * be acquired within LOCK_MAX_WAIT_MS, fall back to unlocked RMW so the caller's
 * Telegram pipeline is never blocked.
 */
// Throttled lock-warning state: emit at most once per LOCK_WARN_THROTTLE_MS
// per process. Per-process is fine because each tele-listen child is short-
// lived; once it exits, the next process re-starts the throttle clock.
const LOCK_WARN_THROTTLE_MS = 60_000;
let lastLockWarnAt = 0;

export function updatePendingStore(mutator, file = DEFAULT_PENDING_FILE) {
  const lock = acquireFileLock(file);
  if (!lock) {
    const now = Date.now();
    if (now - lastLockWarnAt > LOCK_WARN_THROTTLE_MS) {
      // Lock contention exceeded LOCK_MAX_WAIT_MS. Surface a throttled warning
      // so operators can spot pathological contention, but still proceed with
      // an unlocked RMW — blocking the calling Telegram send is worse than a
      // potential lost pending-cache update (the bot's send already succeeded
      // by this point).
      console.error('[pending-store] lock contention > 1s; falling back to unlocked RMW (may lose concurrent update)');
      lastLockWarnAt = now;
    }
  }
  try {
    const store = readPendingStore(file);
    const proceed = mutator(store);
    if (proceed !== false) writePendingStore(store, file);
    return store;
  } finally {
    releaseFileLock(lock);
  }
}

/**
 * Record that the bot just sent a message in `convoId`. Resets `remindedAt`
 * because a fresh send means we're starting a new "wait" window — admin
 * should get reminded again later if this one is ignored too.
 */
export function recordBotSend(store, { convoId, project, messageId, now = Date.now() }) {
  if (convoId == null) return store;
  const key = String(convoId);
  const entry = store[key] ?? {};
  entry.project = project || entry.project || null;
  entry.lastBotSend = new Date(now).toISOString();
  entry.lastBotSendMessageId = messageId ?? null;
  // Don't touch lastAdminReply on send.
  entry.remindedAt = null;
  store[key] = entry;
  return store;
}

/**
 * Record that admin just replied in `convoId`. Reset `remindedAt` so the
 * next pending window (if bot sends again without reply) gets a fresh remind.
 */
export function recordAdminReply(store, { convoId, project = null, now = Date.now() }) {
  if (convoId == null) return store;
  const key = String(convoId);
  // Upsert: if no prior bot send was tracked (e.g. recordBotSend lost a race
  // earlier), still record the admin reply so we have correct lastAdminReply.
  // A subsequent bot send will bump lastBotSend; pending logic compares the
  // two timestamps to decide "waiting" state.
  const entry = store[key] ?? { project };
  if (project && !entry.project) entry.project = project;
  entry.lastAdminReply = new Date(now).toISOString();
  entry.remindedAt = null;
  store[key] = entry;
  return store;
}

/**
 * Returns array of pending entries with `convoId`, ordered by `lastBotSend` desc.
 * Pending = bot sent AND (no admin reply OR admin reply older than bot send) AND
 * elapsed > `minElapsedMs` (default 0 — caller decides threshold).
 */
export function listPending(store, { now = Date.now(), minElapsedMs = 0, maxAgeMs = PENDING_MAX_AGE_MS } = {}) {
  const out = [];
  for (const [convoId, entry] of Object.entries(store)) {
    const botSendT = Date.parse(entry.lastBotSend ?? '') || 0;
    if (botSendT === 0) continue;
    const replyT = Date.parse(entry.lastAdminReply ?? '') || 0;
    if (replyT >= botSendT) continue;
    const age = now - botSendT;
    if (age < minElapsedMs) continue;
    if (age > maxAgeMs) continue; // hard TTL: drop entries too old to be useful
    out.push({ convoId, ...entry, elapsedMs: age });
  }
  // Oldest-first: truncation in formatPendingList preserves the most urgent
  // (longest-waiting) entries when the list exceeds PENDING_LIST_CAP.
  out.sort((a, b) => Date.parse(a.lastBotSend) - Date.parse(b.lastBotSend));
  return out;
}

/**
 * Returns array of pending entries that should trigger an auto-reminder right
 * now: pending AND elapsed > REMIND_AFTER_MS AND `remindedAt` is null.
 */
export function listDueReminders(store, { now = Date.now(), remindAfterMs = REMIND_AFTER_MS } = {}) {
  return listPending(store, { now, minElapsedMs: remindAfterMs })
    .filter((p) => p.remindedAt == null);
}

export function markReminded(store, { convoId, now = Date.now() }) {
  if (convoId == null) return store;
  const key = String(convoId);
  const entry = store[key];
  if (!entry) return store;
  entry.remindedAt = new Date(now).toISOString();
  store[key] = entry;
  return store;
}

/**
 * Format `listPending` output as a human-readable Telegram message body.
 * Returns a string ready for `--plain` send (no markdown, no escape).
 */
// Telegram caps a sendMessage payload at 4096 chars; we cap the list at
// PENDING_LIST_CAP entries with a tail "...and N more" to stay well under.
export const PENDING_LIST_CAP = 20;

export function formatPendingList(pending, { now = Date.now(), maxEntries = PENDING_LIST_CAP } = {}) {
  if (pending.length === 0) return '📋 No pending convos. Everyone is up to date.';
  const lines = [`📋 ${pending.length} pending convo${pending.length > 1 ? 's' : ''}:`, ''];
  const slice = pending.slice(0, maxEntries);
  for (const p of slice) {
    const elapsedMin = Math.floor(p.elapsedMs / 60_000);
    const hours = Math.floor(elapsedMin / 60);
    const minutes = elapsedMin % 60;
    const elapsedStr = hours > 0
      ? (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`)
      : `${elapsedMin}m`;
    const reminded = p.remindedAt ? ' (reminded)' : '';
    // Use shortConvoHash so /pending hashtags match the ones embedded in
    // outgoing messages — admin tap → Telegram search hits both.
    lines.push(`• ${p.project ?? '?'} #${shortConvoHash(p.convoId)}: waiting ${elapsedStr} (msg ${p.lastBotSendMessageId})${reminded}`);
  }
  if (pending.length > maxEntries) {
    lines.push('', `…and ${pending.length - maxEntries} more`);
  }
  return lines.join('\n');
}
