// RFC 18 §E: start cleanup.mjs DETACHED and return at once.
//
// Used two ways:
//   • `/cleanup [--dry-run]` (commands.json → this script): the daemon runs
//     registry commands inline with a 5-minute timeout, and a cleanup can take
//     longer, so this wrapper only launches the real run and replies
//     "đang dọn"; cleanup.mjs DMs the owner its report when done.
//   • the daemon's daily scheduler (startCleanupScheduler): first tick 10 min
//     after start, then whenever 24 h have passed since `lastCleanupAt`
//     (persisted in its own atomic state file). Runs stay DRY until
//     cleanup.mjs records `dryRunReportedAt` after a dry-run report reached
//     the owner — a missing/unreadable state file means dry run.
//
// Light imports only: daemon.mjs imports this file.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { PARENT_DIR } from './workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLEANUP_SCRIPT = path.join(__dirname, 'cleanup.mjs');
export const CLEANUP_STATE_FILE = path.join(__dirname, 'tmp', 'cleanup-state.json');
export const CLEANUP_LOG_FILE = path.join(__dirname, 'tmp', 'cleanup.log');
export const CLEANUP_FIRST_DELAY_MS = 10 * 60 * 1000;
export const CLEANUP_EVERY_MS = 24 * 3600 * 1000;
export const CLEANUP_TICK_MS = 10 * 60 * 1000;
const LOG_MAX_BYTES = 1024 * 1024;

/** Spawn `node cleanup.mjs --report-to-owner [--dry-run]` detached; never awaited. → child pid. */
export function launchCleanup({ dryRun = false, env = process.env, spawnFn = spawn, logFile = CLEANUP_LOG_FILE, cwd = PARENT_DIR } = {}) {
  let fd = 'ignore';
  try { // keep the run's own output for diagnosis (stdout/stderr → small log file)
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try { if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.truncateSync(logFile, 0); } catch {}
    fd = fs.openSync(logFile, 'a', 0o600);
  } catch { fd = 'ignore'; }
  try {
    const child = spawnFn(process.execPath, [CLEANUP_SCRIPT, '--report-to-owner', ...(dryRun ? ['--dry-run'] : [])], {
      detached: true, stdio: ['ignore', fd, fd], env, cwd,
    });
    child.on?.('error', (e) => console.error(`[cleanup-launch] spawn failed: ${e?.message ?? e}`));
    child.unref?.();
    return child.pid;
  } finally { if (typeof fd === 'number') try { fs.closeSync(fd); } catch {} }
}

/** Raw state object, or null when missing/garbled/not an object. */
function readRawState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  } catch { return null; }
}
const num = (v) => (Number.isFinite(v) ? v : null);

/**
 * State file → { lastCleanupAt, dryRunReportedAt } (each a number or null), or
 * null when missing/garbled (= treat as first ever run).
 */
export function readCleanupState(file = CLEANUP_STATE_FILE) {
  const s = readRawState(file);
  return s ? { lastCleanupAt: num(s.lastCleanupAt), dryRunReportedAt: num(s.dryRunReportedAt) } : null;
}

export function writeCleanupState(state, file = CLEANUP_STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(state) + '\n'); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

/** Merge `patch` into the state file (atomic). */
export function updateCleanupState(patch, file = CLEANUP_STATE_FILE) {
  writeCleanupState({ ...(readRawState(file) || {}), ...patch }, file);
}

/** cleanup.mjs calls this only AFTER a dry-run report reached the owner: from then on, scheduled runs are real. */
export function recordDryRunReported(file = CLEANUP_STATE_FILE, now = Date.now()) {
  updateCleanupState({ dryRunReportedAt: now }, file);
}

/**
 * Is a scheduled run due, and must it be a dry run? Pure. It stays a dry run
 * until a dry-run report was DELIVERED (`dryRunReportedAt`), so a crashed or
 * undelivered first run never leads to a real one.
 */
export function decideScheduledRun(state, now, everyMs = CLEANUP_EVERY_MS) {
  const dryRun = !Number.isFinite(state?.dryRunReportedAt);
  if (!state || !Number.isFinite(state.lastCleanupAt)) return { run: true, dryRun };
  const age = now - state.lastCleanupAt;
  // A timestamp far in the future (clock jump) must not block cleanup forever.
  if (age >= everyMs || age < -3600_000) return { run: true, dryRun };
  return { run: false };
}

/** One scheduler tick: record the run FIRST (an unwritable state file → no launch, so no hourly re-runs). */
export function cleanupTick({ stateFile = CLEANUP_STATE_FILE, launch, now = Date.now(), log = console.error } = {}) {
  const d = decideScheduledRun(readCleanupState(stateFile), now);
  if (!d.run) return d;
  try { updateCleanupState({ lastCleanupAt: now, lastDryRun: d.dryRun }, stateFile); }
  catch (e) { log(`[cleanup] cannot write state, not launching: ${e?.message ?? e}`); return { run: false, error: true }; }
  try { launch({ dryRun: d.dryRun }); } catch (e) { log(`[cleanup] launch failed: ${e?.message ?? e}`); }
  return d;
}

/** Daily scheduler for the daemon (own timers, independent of the poll loop). → stop(). */
export function startCleanupScheduler({ launch, stateFile = CLEANUP_STATE_FILE, firstDelayMs = CLEANUP_FIRST_DELAY_MS, tickMs = CLEANUP_TICK_MS, log = console.error } = {}) {
  let iv = null;
  const tick = () => { try { cleanupTick({ stateFile, launch, log }); } catch (e) { log(`[cleanup] tick: ${e?.message ?? e}`); } };
  const t = setTimeout(() => { tick(); iv = setInterval(tick, tickMs); }, firstDelayMs);
  return () => { clearTimeout(t); if (iv) clearInterval(iv); };
}

/** `/cleanup` arguments: none, or exactly `--dry-run`. Anything else (incl. a phone's `—dry-run`) throws. */
export function parseLaunchArgs(argv) {
  const bad = argv.filter((a) => a !== '--dry-run');
  if (bad.length) throw new Error(`❌ /cleanup: không hiểu ${bad.join(' ')} — dùng /cleanup hoặc /cleanup --dry-run`);
  return { dryRun: argv.includes('--dry-run') };
}

// CLI (the /cleanup command): launch and reply at once.
if (isMainModule(import.meta.url)) {
  let opts;
  try { opts = parseLaunchArgs(process.argv.slice(2)); } catch (e) { console.log(e.message); process.exit(2); }
  launchCleanup({ dryRun: opts.dryRun });
  console.log(`🧹 Đang dọn${opts.dryRun ? ' (dry-run: chỉ liệt kê, không xoá)' : ''}, sẽ báo khi xong.`);
}
