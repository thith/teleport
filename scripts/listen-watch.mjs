// RFC 18 §B (v2): "is anyone still hearing Telegram?"
//
// Every successful getUpdates (agent tele-listen fetch path AND the daemon's
// co-op harvest) stamps `tmp/tele-reply/last-fetch-ok`. Two readers use it:
//   • the daemon watchdog (an independent setInterval) DMs the owner once when
//     nobody has fetched for > 5 min (throttled 30 min, state persisted), and
//     once more when fetching resumes;
//   • each agent listener prints a stdout warning line (Monitor turns it into
//     an event) at most every 15 min per convo.
// The signal is "a fetch completed", not "I got the lock": missing the shared
// lock is normal, and a lock-centric signal misses getUpdates failing forever.
//
// Self-contained on purpose (own tmp path + atomic write) so tele-listen.mjs can
// import it without a circular import.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LISTEN_TMP_DIR = path.join(__dirname, 'tmp', 'tele-reply');
export const LAST_FETCH_OK_FILE = path.join(LISTEN_TMP_DIR, 'last-fetch-ok');
export const LISTEN_WATCH_STATE_FILE = path.join(__dirname, 'tmp', 'listen-watch.json');
export const LISTEN_POLL_LOCK_FILE = path.join(LISTEN_TMP_DIR, 'poll.lock');

export const LISTEN_STALE_MS = 5 * 60 * 1000;          // no fetch for this long = deaf
export const DAEMON_ALERT_THROTTLE_MS = 30 * 60 * 1000;
export const LISTENER_WARN_THROTTLE_MS = 15 * 60 * 1000;
export const WATCHDOG_EVERY_MS = 60 * 1000;

let counter = 0;
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${counter++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function readNumber(file) {
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Stamp "a getUpdates just succeeded". Best-effort: never throws. */
export function recordFetchOk({ file = LAST_FETCH_OK_FILE, now = Date.now() } = {}) {
  try { atomicWrite(file, String(now)); } catch (e) {
    console.error(`[listen-watch] cannot write ${file}: ${e?.message ?? e}`);
  }
}

/** Timestamp of the last successful fetch, or null when never recorded/unreadable. */
export function readLastFetchOk(file = LAST_FETCH_OK_FILE) {
  return readNumber(file);
}

const minutes = (ms) => Math.max(0, Math.floor(ms / 60_000));

/** Human description of the poll lock for the alert: age + body, or "không có". */
export function describePollLock(lockFile = LISTEN_POLL_LOCK_FILE, now = Date.now()) {
  let body;
  let mtime;
  try {
    body = fs.readFileSync(lockFile, 'utf8').trim();
    mtime = fs.statSync(lockFile).mtimeMs;
  } catch { return 'không có'; }
  const ts = parseInt(body, 10);
  const age = now - (Number.isFinite(ts) ? ts : mtime);
  const shown = body === '' ? 'rỗng' : JSON.stringify(body.slice(0, 60));
  return `tuổi ${Math.max(0, Math.round(age / 1000))}s, nội dung ${shown}`;
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

/**
 * One watchdog tick (daemon). Pure-ish: clock, files and send are injectable.
 * Returns 'alert' | 'recovered' | null (what it sent).
 *   - last-fetch-ok missing → nothing (we cannot tell how long; no false alarm);
 *   - gap > 5 min → DM once, again at most every 30 min (state persisted);
 *   - fresh again after an alert → one recovery DM, state cleared.
 */
export async function listenWatchdogTick({
  now = Date.now(),
  lastFetchOkFile = LAST_FETCH_OK_FILE,
  stateFile = LISTEN_WATCH_STATE_FILE,
  lockFile = LISTEN_POLL_LOCK_FILE,
  send,
} = {}) {
  const last = readLastFetchOk(lastFetchOkFile);
  if (last == null) return null;
  const state = readState(stateFile);
  const gap = now - last;
  if (gap > LISTEN_STALE_MS) {
    if (state.alertedAt != null && now - state.alertedAt < DAEMON_ALERT_THROTTLE_MS) return null;
    // Persist BEFORE sending: a send that throws must not turn into a DM per tick.
    atomicWrite(stateFile, JSON.stringify({ alertedAt: now, outageSince: state.outageSince ?? last }));
    await send(`📡 Không ai nghe được Telegram đã ${minutes(gap)} phút (poll.lock: ${describePollLock(lockFile, now)}). Gửi tin vẫn chạy.`);
    return 'alert';
  }
  if (state.alertedAt != null) {
    const since = state.outageSince ?? state.alertedAt;
    atomicWrite(stateFile, JSON.stringify({}));
    await send(`✅ Đã nghe Telegram lại (gián đoạn ${minutes(last - since)} phút).`);
    return 'recovered';
  }
  return null;
}

/** Start the daemon watchdog: independent of the main loop, unref'd. */
export function startListenWatchdog({ send, everyMs = WATCHDOG_EVERY_MS, tick = listenWatchdogTick } = {}) {
  const t = setInterval(() => {
    Promise.resolve()
      .then(() => tick({ now: Date.now(), send }))
      .catch((e) => console.error(`[daemon] listen watchdog: ${e?.message ?? e}`));
  }, everyMs);
  t.unref?.();
  return t;
}

export function listenWarnMarkerFile(convo, tmpDir = LISTEN_TMP_DIR) {
  return path.join(tmpDir, `listen-warn-${convo}.txt`);
}

/**
 * Listener side: the stdout warning line to print at the start of a poll, or
 * null. Throttled to once per 15 min per convo via a marker file (written only
 * when a line is returned). Missing last-fetch-ok → null.
 */
export function listenerStaleWarning({
  convo,
  now = Date.now(),
  lastFetchOkFile = LAST_FETCH_OK_FILE,
  markerFile = listenWarnMarkerFile(convo),
} = {}) {
  const last = readLastFetchOk(lastFetchOkFile);
  if (last == null) return null;
  const gap = now - last;
  if (gap <= LISTEN_STALE_MS) return null;
  const warned = readNumber(markerFile);
  if (warned != null && now - warned < LISTENER_WARN_THROTTLE_MS) return null;
  try { atomicWrite(markerFile, String(now)); } catch { return null; } // can't throttle → stay quiet
  return `[tele-listen] ⚠️ Không ai nghe được Telegram đã ${minutes(gap)} phút — listener có thể đang kẹt (không phải prompt, đừng đăng vào topic).`;
}
