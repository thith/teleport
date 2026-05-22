// Persistent storage for Telegram forum-topic mappings.
//
// Schema (`topics.json`):
//
//   {
//     "<chatId>": {
//       "_no_topic_support": true | false,
//       "_checked_at": "2026-05-22T10:00:00.000Z",
//       "<projectCode>": <message_thread_id>,
//       ...
//     },
//     ...
//   }
//
// Semantics:
// - Positive cache (`<projectCode>: <thread_id>`) is sticky. Only cleared by
//   the consumer on `MESSAGE_THREAD_NOT_FOUND` / `TOPIC_DELETED` errors.
// - Negative cache (`_no_topic_support: true`) has a TTL: if more than
//   `NO_SUPPORT_TTL_MS` since `_checked_at`, the caller may retry topic
//   creation. This handles the case where an admin enables Topics after a
//   failed first attempt — we self-heal within an hour.
// - Underscore-prefixed keys are reserved for store metadata; project codes
//   starting with `_` are not supported (cwd basenames never start with `_`
//   in practice; defensive check below).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TOPICS_FILE = path.join(__dirname, 'tmp', 'topics.json');
export const NO_SUPPORT_TTL_MS = 60 * 60 * 1000; // 1 hour

function atomicWriteFileSync(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// Coarse lock: O_CREAT | O_EXCL on `<file>.lock`. Used for read-modify-write
// to prevent two concurrent send-telegram processes from clobbering each
// other's topic mappings. Best-effort: if lock contention exceeds ~1s of
// retries, callers proceed without the lock (last-write-wins fallback is
// preferable to blocking a Telegram send indefinitely).
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
      // Stale lock detection: > 10s old → reap
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) fs.unlinkSync(lockPath);
      } catch {}
      const sleepDeadline = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < sleepDeadline) { /* busy wait, cheap */ }
    }
  }
  return null;
}

function releaseFileLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch {}
}

/**
 * Atomic read-modify-write under a coarse file lock. `mutator(store)` may
 * mutate store in place; if it returns false, the write is skipped.
 * Returns the (possibly-mutated) store. Best-effort lock — if lock can't be
 * acquired within LOCK_MAX_WAIT_MS, fall back to unlocked RMW (last-write-
 * wins) rather than block the caller's Telegram send.
 */
export function updateTopicsStore(mutator, file = DEFAULT_TOPICS_FILE) {
  const lock = acquireFileLock(file);
  try {
    const store = readTopicsStore(file);
    const proceed = mutator(store);
    if (proceed !== false) writeTopicsStore(store, file);
    return store;
  } finally {
    releaseFileLock(lock);
  }
}

export function readTopicsStore(file = DEFAULT_TOPICS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeTopicsStore(data, file = DEFAULT_TOPICS_FILE) {
  atomicWriteFileSync(file, JSON.stringify(data, null, 2));
}

export function getThreadId(store, chatId, projectCode) {
  if (!projectCode || projectCode.startsWith('_')) return null;
  const entry = store[String(chatId)];
  if (!entry) return null;
  const v = entry[projectCode];
  return typeof v === 'number' && v > 0 ? v : null;
}

export function isNoTopicSupportFresh(store, chatId, now = Date.now()) {
  const entry = store[String(chatId)];
  if (!entry || entry._no_topic_support !== true) return false;
  const t = Date.parse(entry._checked_at ?? '');
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  // Negative age = system clock moved backward since the mark. Treat as
  // stale so we re-check, rather than extending the cache indefinitely.
  return age >= 0 && age < NO_SUPPORT_TTL_MS;
}

export function recordThreadId(store, chatId, projectCode, threadId) {
  if (!projectCode || projectCode.startsWith('_')) return store;
  const key = String(chatId);
  const entry = store[key] ?? {};
  entry[projectCode] = threadId;
  entry._no_topic_support = false;
  delete entry._checked_at;
  store[key] = entry;
  return store;
}

export function recordNoTopicSupport(store, chatId, now = Date.now()) {
  const key = String(chatId);
  const entry = store[key] ?? {};
  entry._no_topic_support = true;
  entry._checked_at = new Date(now).toISOString();
  store[key] = entry;
  return store;
}

export function clearThreadId(store, chatId, projectCode) {
  if (!projectCode || projectCode.startsWith('_')) return store;
  const entry = store[String(chatId)];
  if (!entry) return store;
  delete entry[projectCode];
  return store;
}
