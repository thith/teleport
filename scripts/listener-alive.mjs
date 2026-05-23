// Per-convo listener liveness store. Each active tele-listen invocation
// touches `tmp/listener-alive/<convoId>` at the top of its poll cycle; the
// file's mtime is the heartbeat. Stale convos (last touch older than
// `freshMs`) signal an agent that has exited / crashed without cleanup, so
// pending-store can drop their effective TTL from 24h to 60min and stop
// nagging the admin with reminders for dead conversations.
//
// File-per-convo (not a JSON registry) so concurrent writers never collide —
// each convo owns its own path, no locks needed. GC is a one-shot rmSync on
// files older than PENDING_MAX_AGE_MS, mirroring the pending-store sweep.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ALIVE_DIR = path.join(__dirname, 'tmp', 'listener-alive');
// Default freshness threshold. Poll cycles touch every ~5–15s (5s noMatch
// backoff worst-case + 12s outer Monitor restart); 90s gives ~6× headroom for
// transient hiccups (slow fetchUpdates, brief GC pause) without false-stale.
export const DEFAULT_FRESH_MS = 90_000;
// In-process throttle: skip the syscall if we already touched this convo
// within the last 30s. Heartbeat granularity is minutes — sub-30s writes are
// pure noise and only matter for SSD wear / inotify spam.
const TOUCH_THROTTLE_MS = 30_000;
// Cap on the in-process throttle map. For convo-mode listeners (one convoId
// per process) this never matters; for long-lived multi-convo supervisors
// it prevents the map from growing unbounded as convos come and go.
const LAST_TOUCH_CAP = 500;
const lastTouchMs = new Map();

function safeName(convoId) {
  // Defense in depth — convoId is internally numeric/string, never path-
  // bearing, but treat it as untrusted so an injected `../` can't escape.
  return String(convoId).replace(/[^A-Za-z0-9_-]/g, '_');
}

export function alivePath(convoId, dir = DEFAULT_ALIVE_DIR) {
  return path.join(dir, safeName(convoId));
}

/**
 * Touch the alive file for `convoId`. Throttled per-process to 30s.
 * Best-effort: filesystem errors are logged once and swallowed so a broken
 * tmp dir can never crash the listener poll loop.
 */
export function recordAlive(convoId, { dir = DEFAULT_ALIVE_DIR, now = Date.now() } = {}) {
  if (convoId == null || convoId === '') return false;
  const key = String(convoId);
  const last = lastTouchMs.get(key) ?? 0;
  if (now - last < TOUCH_THROTTLE_MS) return false;
  // Bounded LRU: drop the oldest entry when we'd exceed the cap. Map
  // iteration order is insertion order, so the first key is the oldest.
  if (!lastTouchMs.has(key) && lastTouchMs.size >= LAST_TOUCH_CAP) {
    const oldest = lastTouchMs.keys().next().value;
    if (oldest !== undefined) lastTouchMs.delete(oldest);
  }
  lastTouchMs.delete(key); // re-insert at tail to refresh recency
  lastTouchMs.set(key, now);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = alivePath(convoId, dir);
    // openSync+closeSync creates the file if missing; utimesSync updates
    // mtime even if it already exists (writeFileSync('') would also work but
    // costs a write — utimes is a single inode update).
    const fd = fs.openSync(p, 'a');
    fs.closeSync(fd);
    const t = now / 1000;
    fs.utimesSync(p, t, t);
    return true;
  } catch (e) {
    console.error(`[listener-alive] touch failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * True iff the alive file exists and was touched within `freshMs`.
 * Missing file = not alive (never registered, or GC swept it).
 */
export function isAlive(convoId, { dir = DEFAULT_ALIVE_DIR, now = Date.now(), freshMs = DEFAULT_FRESH_MS } = {}) {
  if (convoId == null || convoId === '') return false;
  try {
    const st = fs.statSync(alivePath(convoId, dir));
    return now - st.mtimeMs < freshMs;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    // Unexpected error (permissions, etc.) — bias to "alive" so we don't
    // start dropping reminders due to a transient FS hiccup. Stale detection
    // is an optimization; false-fresh just preserves current behavior.
    console.error(`[listener-alive] stat failed for ${convoId}: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

/**
 * Remove alive files older than `maxAgeMs`. Caller decides cadence (we run
 * this from the heartbeat reminder pass since that already iterates pending
 * state and runs on every poll cycle).
 */
export function pruneStale({ dir = DEFAULT_ALIVE_DIR, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return 0;
    console.error(`[listener-alive] prune readdir failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > maxAgeMs) {
        fs.rmSync(p, { force: true });
        removed++;
      }
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        console.error(`[listener-alive] prune ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return removed;
}

/**
 * Returns the alive file's mtime in epoch ms, or null if the file is missing
 * or unreadable. Suitable for `getLastAliveMs` in pending-store callers.
 */
export function getLastAliveMs(convoId, { dir = DEFAULT_ALIVE_DIR } = {}) {
  if (convoId == null || convoId === '') return null;
  try {
    return fs.statSync(alivePath(convoId, dir)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Test-only: reset the per-process throttle map. Production code should
 * never call this; tests need it so consecutive recordAlive() calls in the
 * same process actually hit disk.
 */
export function _resetThrottle() {
  lastTouchMs.clear();
}
