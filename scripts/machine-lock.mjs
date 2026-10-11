// Machine-wide exclusive locks (RFC 17): at most one heavy build, one merge.
//
// The lock is flock(2) on `~/.local/state/teleport/locks/<name>.lock`, HELD BY
// THIS NODE PROCESS: we open the file (Node opens with O_CLOEXEC, so nothing we
// spawn inherits it) and run `flock -n 3` as a short-lived child on that fd. The
// lock belongs to our open file description, so it outlives the helper and is
// released by the kernel the moment we exit — normally, by signal, or SIGKILL.
// No TTL, no pid liveness guessing, nothing to clean up.
//
// Why not `flock <file> <cmd>`: cmd inherits the fd, so anything it backgrounds
// (`… &`, emulator, adb server) holds the lock forever; signals stop at flock
// (the cmd is orphaned, still locked); and a daemon timeout that kills only the
// direct child leaves a waiting merge to merge later, unreported. All measured.
//
// `<name>.holder.json` is for DISPLAY only ("waiting for 🧛 Ma — ./gradlew …");
// it never decides who holds the lock.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveConvoIdFromEnv } from './convo-registry.mjs';
import { peekPersona } from './persona-store.mjs';
import { formatPersona } from './persona.mjs';
import { shortConvoHash } from './convo-hash.mjs';

// $HOME, not $XDG_STATE_HOME: the daemon and the agents must agree on one file.
export const LOCK_DIR = process.env.TELEPORT_LOCK_DIR || path.join(os.homedir(), '.local', 'state', 'teleport', 'locks');
export const LOCK_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const BUSY = 75; // flock -E: "lock is held" (helper runs no command, so 75 is unambiguous)

export function lockPaths(name, dir = LOCK_DIR) {
  if (!LOCK_NAME_RE.test(String(name))) throw new Error(`bad lock name: ${name}`);
  return { lock: path.join(dir, `${name}.lock`), holder: path.join(dir, `${name}.holder.json`) };
}

/** One non-blocking try on `fd` → 'acquired' | 'busy'; throws on flock errors (missing binary, 66…). */
function tryFlock(fd) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('flock', ['-n', '-E', String(BUSY), '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] }); }
    catch (e) { reject(e); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject); // ENOENT: no flock binary
    child.on('close', (code) => {
      if (code === 0) resolve('acquired');
      else if (code === BUSY) resolve('busy');
      else reject(new Error(`flock exited ${code}${err ? `: ${err.trim()}` : ''}`));
    });
  });
}

/** Holder info for display; null if absent/garbled. `alive` = its pid still exists. Pure-ish. */
export function readHolder(file) {
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try { process.kill(h.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    return { ...h, alive };
  } catch { return null; }
}

/** "🧛 Ma #c2383556 — ./gradlew assembleDebug — từ 12:40 (3 phút)". Pure. */
export function describeHolder(h, now = Date.now()) {
  if (!h) return '(chưa rõ ai giữ)';
  if (!h.alive) return '(không rõ ai giữ — tiến trình ghi tên đã chết)';
  const mins = Math.max(0, Math.round((now - h.startedAt) / 60000));
  const at = new Date(h.startedAt).toTimeString().slice(0, 5);
  return `${h.label || `pid ${h.pid}`}${h.cmd ? ` — ${h.cmd}` : ''} — từ ${at} (${mins} phút)`;
}

/** Best-effort label for whoever runs this: daemon sender, else the agent ("🧛 Ma #c2383556"). */
export function selfLabel(env = process.env) {
  if (env.TELE_FROM_NAME) return `${env.TELE_FROM_NAME} (daemon)`;
  try {
    const { convoId } = resolveConvoIdFromEnv({ env });
    if (convoId != null) {
      const p = peekPersona(convoId);
      return `${p ? `${formatPersona(p)} ` : ''}#${shortConvoHash(convoId)}`;
    }
  } catch {}
  return `pid ${process.pid}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Take lock `name`, waiting up to `waitSec` (Infinity = forever). While busy,
 * `onWait(holder, waitedMs)` is called at once, then every `noticeMs` or when
 * the holder changes. Never blocks the event loop; dying while waiting leaves
 * nothing behind.
 * → { release(), waitedMs } | { timeout: true, holder }. Throws if flock can't run.
 */
export async function acquireLock(name, {
  waitSec = Infinity, label = selfLabel(), cmd = '', onWait = () => {}, pollMs = 1000, noticeMs = 60000, dir = LOCK_DIR, now = Date.now,
} = {}) {
  const p = lockPaths(name, dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // O_RDONLY is enough for flock and works even where the file isn't writable.
  const fd = fs.openSync(p.lock, fs.constants.O_RDONLY | fs.constants.O_CREAT, 0o600);
  const start = now();
  let lastNotice = -Infinity, lastKey = null;
  try {
    for (;;) {
      if (await tryFlock(fd) === 'acquired') break;
      const t = now(), holder = readHolder(p.holder);
      const key = holder ? `${holder.pid}:${holder.startedAt}` : '';
      if (key !== lastKey || t - lastNotice >= noticeMs) { onWait(holder, t - start); lastNotice = t; lastKey = key; }
      if (t - start >= waitSec * 1000) { fs.closeSync(fd); return { timeout: true, holder }; }
      await sleep(pollMs);
    }
  } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
  const me = { pid: process.pid, label, cmd, cwd: process.cwd(), startedAt: now() };
  try { // atomic, so a waiter never reads half a file; display only → failure is harmless
    const tmp = `${p.holder}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(me) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p.holder);
  } catch {}
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Holder file first, while we still hold the lock — no race with the next holder.
    try { if (readHolder(p.holder)?.pid === process.pid) fs.unlinkSync(p.holder); } catch {}
    try { fs.closeSync(fd); } catch {}
  };
  return { release, waitedMs: me.startedAt - start };
}
