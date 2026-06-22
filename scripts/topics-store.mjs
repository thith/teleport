// Persistent storage for Telegram forum-topic mappings.
//
// Schema (`topics.json`), RFC 01 team mode — one topic PER CONVO:
//
//   {
//     "<chatId>": {
//       "<convoId>": <message_thread_id>,   // one entry per convo (key = convoId)
//       "_is_forum": true,                  // positive forum-detection cache
//       "_ts": { "<convoId>": <epoch_ms> }, // durable last-use, for GC
//       ...
//     },
//     ...
//   }
//
// (Historically the non-`_` key was `<projectCode>` for a project→topic model;
// single-mode team keys by convoId. The store code is key-agnostic — it just
// treats any non-`_` key as a topic mapping.)
//
// Semantics:
// - Positive cache (`<convoId>: <thread_id>`) is sticky. Cleared by the consumer
//   on `MESSAGE_THREAD_NOT_FOUND` / `TOPIC_DELETED`, or by GC when the convo's
//   `_ts` is older than the topic TTL.
// - There is NO negative topic-create cache: every send re-attempts topic
//   creation on a cache miss. A previous `_no_topic_support` TTL cache would
//   keep dropping reports for up to an hour AFTER an admin fixed the mis-config
//   (enabled Topics / granted the right) — no retry. Re-attempting each time
//   costs one extra createForumTopic call while genuinely misconfigured, but
//   self-heals the instant config is fixed.
// - Underscore-prefixed keys are reserved for store metadata; topic keys
//   starting with `_` are not supported (convoIds/cwd basenames never do).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TOPICS_FILE = path.join(__dirname, 'tmp', 'topics.json');

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

export function recordThreadId(store, chatId, projectCode, threadId) {
  if (!projectCode || projectCode.startsWith('_')) return store;
  const key = String(chatId);
  const entry = store[key] ?? {};
  entry[projectCode] = threadId;
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
