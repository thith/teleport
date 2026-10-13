#!/usr/bin/env node
// heavy.mjs — run a heavy build under the machine-wide `build` lock (RFC 17),
// so two agents never build at once and OOM the box.
//
//   node ../teleport/scripts/heavy.mjs [--no-stop] [--wait <minutes>] [--no-ram-wait] -- <command> [args…]
//
// Busy → prints who holds it ("⏳ build đang bận: 🧛 Ma #c2383556 — ./gradlew …")
// and waits (forever by default; --wait N gives up after N minutes, exit 75,
// command never run). The command runs in its own process group; SIGINT/
// SIGTERM/SIGHUP are forwarded to the group and we exit only once it is gone,
// so the lock is released when the build is really over. Exit code = the
// command's (128+n if it died by signal n).
// A `gradlew` command is followed — still under the lock, same cwd/env (same
// GRADLE_USER_HOME) — by `<that gradlew> --stop`, which frees the Gradle daemon's
// GBs (and, ~1 s later, the shared Kotlin daemon once its last client is gone).
// --no-stop skips it. No `flock` on this machine → runs unlocked, loudly.
// Nested heavy (a wrapped CI script that itself calls heavy) sees
// TELEPORT_HEAVY_HELD=<pid of the outer heavy> and runs straight away instead
// of waiting on its own parent's lock forever — but only while that pid is the
// live holder of record: something the build left behind (adb server, emulator…)
// inherits the env too, and must not skip the lock after the build is over.
//
// No shared cargo target (RFC 18 C was removed): worktrees of one repo build path
// crates with the same name+version → same artifact files, and cargo's mtime
// fingerprint then links another branch's build — wrong code, even green tests on
// it (found by 🪱 Giun, 2026-10-13). Each worktree keeps its own target/; disk is
// reclaimed by the daily cleanup. `--own-target` is still accepted (a no-op).
// RFC 18 F — RAM wait: before queueing for the lock (not while holding it), wait
// while MemAvailable < TELEPORT_HEAVY_MIN_FREE_MB (default 3 GiB), OR swap is
// nearly full (free < 10% and < 1 GiB… see swapLow), OR memory pressure is high
// (PSI `full avg10` ≥ 10% — systemd-oomd kills at 50% sustained); give up — and
// build anyway, with a warning — once RAM has not risen for 2 min, or after 15 min.
// Skipped for nested heavy and with --no-ram-wait.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, describeHolder, readHolder, lockPaths } from './machine-lock.mjs';
import { isMainModule } from './is-direct-run.mjs';

export const WAIT_TIMEOUT_EXIT = 75;
export const HELD_ENV = 'TELEPORT_HEAVY_HELD';
const USAGE = 'usage: heavy.mjs [--no-stop] [--wait <minutes>] [--no-ram-wait] -- <command> [args…]';

/** argv → { cmd, stop, waitSec, ramWait } | { error }. Pure. */
export function parseHeavyArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) return { error: USAGE };
  let stop = true, waitSec = Infinity, ramWait = true;
  const opts = argv.slice(0, sep);
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--no-stop') stop = false;
    else if (opts[i] === '--own-target') { /* no-op: each worktree always has its own target/ */ }
    else if (opts[i] === '--no-ram-wait') ramWait = false;
    else if (opts[i] === '--wait') {
      const n = Number(opts[++i]);
      if (!(n > 0)) return { error: `--wait needs minutes > 0\n${USAGE}` };
      waitSec = n * 60;
    } else return { error: `unexpected: ${opts[i]}\n${USAGE}` };
  }
  return { cmd: argv.slice(sep + 1), stop, waitSec, ramWait };
}

// ── RFC 18 F: wait for free RAM ──

export const RAM_POLL_MS = 10_000;
export const RAM_PLATEAU_MS = 2 * 60_000;
export const RAM_CAP_MS = 15 * 60_000;
const RAM_LOG_EVERY_MS = 60_000;
const GiB = 1024 ** 3;
const gib = (b) => (b / GiB).toFixed(1);

/** MemAvailable in bytes from /proc/meminfo, or null if unreadable. */
export function readMemAvailable(file = '/proc/meminfo') {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
}

/**
 * { avail, swapTotal, swapFree, psiFull } — bytes, and PSI memory `full avg10`
 * (percent) from /proc/pressure/memory; a field that can't be read is null.
 */
export function readMemState({ meminfo = '/proc/meminfo', pressure = '/proc/pressure/memory' } = {}) {
  let text = '';
  try { text = fs.readFileSync(meminfo, 'utf8'); } catch {}
  const kb = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm').exec(text); return m ? Number(m[1]) * 1024 : null; };
  let psiFull = null;
  try { const m = /^full\s.*?avg10=([\d.]+)/m.exec(fs.readFileSync(pressure, 'utf8')); if (m) psiFull = Number(m[1]); } catch {}
  return { avail: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree'), psiFull };
}

export const PSI_FULL_MAX = 10; // % — wait above this (oomd's kill threshold is 50% for 20 s)

/** Swap nearly full: free < 1 GiB, or < 10% of a swap of 10 GiB+. No swap → not "low". Pure. */
export function swapLow({ swapTotal, swapFree }) {
  if (!swapTotal || swapFree == null) return false;
  return swapFree < Math.max(GiB, swapTotal * 0.1);
}

/** Why a build should wait now ([] = go). Pure. */
export function memBlockers(st, minBytes) {
  const why = [];
  if (st.avail != null && st.avail < minBytes) why.push(`còn ${gib(st.avail)} GiB, cần ${gib(minBytes)} GiB`);
  if (minBytes > 0 && swapLow(st)) why.push(`swap gần đầy (còn ${gib(st.swapFree)} / ${gib(st.swapTotal)} GiB)`);
  if (minBytes > 0 && st.psiFull != null && st.psiFull >= PSI_FULL_MAX) why.push(`memory pressure ${st.psiFull}%`);
  return why;
}

/** Threshold in bytes from TELEPORT_HEAVY_MIN_FREE_MB (default 3 GiB; 0 = never wait). */
export function minFreeBytes(env = process.env) {
  const v = env.TELEPORT_HEAVY_MIN_FREE_MB;
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1024 * 1024 : 3 * GiB;
}


/**
 * Wait while memBlockers() says so (low MemAvailable, swap nearly full, high
 * memory pressure). Resolves { reason, waitedMs }: 'ok', 'unreadable' (no
 * meminfo → no wait), 'plateau' (RAM no rise for 2 min), 'cap' (15 min total).
 * Injectable readState (or the older readMem → bytes) / sleep / now / log.
 */
export async function waitForRam({ minBytes, readMem = null, readState = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = (s) => console.error(s) } = {}) {
  const read = readState || (readMem ? () => ({ avail: readMem() }) : () => readMemState());
  const start = now();
  let st = read();
  let mem = st.avail;
  if (mem == null) return { reason: 'unreadable', waitedMs: 0 };
  let why = memBlockers(st, minBytes);
  if (!why.length) return { reason: 'ok', waitedMs: 0 };
  let best = mem, bestAt = start, loggedAt = -Infinity;
  for (;;) {
    const t = now();
    if (t - loggedAt >= RAM_LOG_EVERY_MS) { log(`⏳ chờ RAM: ${why.join(' · ')}…`); loggedAt = t; }
    await sleep(RAM_POLL_MS);
    const t2 = now();
    st = read();
    mem = st.avail;
    if (mem == null) return { reason: 'unreadable', waitedMs: t2 - start };
    why = memBlockers(st, minBytes);
    if (!why.length) return { reason: 'ok', waitedMs: t2 - start };
    if (mem > best) { best = mem; bestAt = t2; }
    if (t2 - start >= RAM_CAP_MS) { log(`⚠️ heavy: đã chờ RAM ${Math.round((t2 - start) / 60000)} phút (còn ${gib(mem)} GiB) — chạy luôn, dễ OOM.`); return { reason: 'cap', waitedMs: t2 - start }; }
    if (t2 - bestAt >= RAM_PLATEAU_MS) { log(`⚠️ heavy: RAM không tăng trong 2 phút (còn ${gib(mem)} GiB, có tiến trình sống lâu đang giữ) — chạy luôn, dễ OOM.`); return { reason: 'plateau', waitedMs: t2 - start }; }
  }
}

/** True when the command is a Gradle wrapper (called directly — not via `sh -c`). Pure. */
export const isGradlew = (cmd) => path.basename(cmd[0] || '') === 'gradlew';

const hasSetpriv = () => spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).status === 0;

/** Spawn `cmd` in its own process group; forward signals; resolve its exit code. */
export function runForwarded(cmd, { spawnFn = spawn, setpriv = hasSetpriv(), proc = process, env = { ...process.env, [HELD_ENV]: String(process.pid) } } = {}) {
  // setpriv --pdeathsig: if WE are SIGKILLed (uncatchable, lock released), the build dies too.
  const argv = setpriv ? ['setpriv', '--pdeathsig', 'TERM', '--', ...cmd] : cmd;
  return new Promise((resolve) => {
    const child = spawnFn(argv[0], argv.slice(1), { stdio: 'inherit', detached: true, env });
    const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let hits = 0;
    const fwd = (sig) => {
      hits++;
      try { process.kill(-child.pid, hits > 2 ? 'SIGKILL' : sig); } catch {}
    };
    for (const s of sigs) proc.on(s, fwd);
    const done = (code) => { for (const s of sigs) proc.off(s, fwd); resolve(code); };
    child.on('error', (e) => { console.error(`❌ heavy: cannot run ${cmd[0]}: ${e.message}`); done(127); });
    child.on('close', (code, signal) => done(code ?? 128 + (os.constants.signals[signal] || 0)));
  });
}

// `--stop` goes through runForwarded too: signals stay handled (and forwarded)
// until it is over, so it never outlives the lock.
/** Is the build lock held by the heavy named in `env` (our live ancestor)? */
export const heldByAncestor = (env, holder = () => readHolder(lockPaths('build').holder)) => {
  const pid = Number(env[HELD_ENV]);
  if (!(pid > 0)) return false;
  const h = holder();
  return !!h && h.alive && h.pid === pid;
};

export async function main(argv, {
  acquire = acquireLock, run = (cmd, o) => runForwarded(cmd, o), stopGradle = (cmd, o) => runForwarded([cmd[0], '--stop'], o),
  log = (s) => console.error(s), env = process.env, nested = heldByAncestor,
  waitRam = waitForRam,
} = {}) {
  const a = parseHeavyArgs(argv);
  if (a.error) { log(a.error); return 2; }
  const cmdText = a.cmd.join(' ').slice(0, 200);
  const childEnv = { ...env, [HELD_ENV]: String(process.pid) };
  const isNested = nested(env);
  if (!isNested && a.ramWait) await waitRam({ minBytes: minFreeBytes(env), log });
  let lock;
  if (isNested) {
    log('ℹ️ heavy: đã ở trong build lock của tiến trình cha — chạy luôn.');
    lock = { release() {}, waitedMs: 0 };
  } else try {
    lock = await acquire('build', {
      waitSec: a.waitSec, cmd: cmdText,
      onWait: (h, waited) => log(`⏳ build đang bận: ${describeHolder(h)} — ${waited ? `đã chờ ${Math.round(waited / 60000)} phút, ` : ''}chờ tới lượt…`),
    });
  } catch (e) {
    log(`⚠️ heavy: không lấy được build lock (${e.message}) — chạy KHÔNG khoá.`);
    lock = { release() {}, waitedMs: 0 };
  }
  if (lock.timeout) { log(`❌ heavy: chờ quá ${a.waitSec / 60} phút, build vẫn bận: ${describeHolder(lock.holder)} — không chạy.`); return WAIT_TIMEOUT_EXIT; }
  if (lock.waitedMs > 1000) log(`▶️ tới lượt (đã chờ ${Math.round(lock.waitedMs / 1000)}s): ${cmdText}`);
  try {
    const code = await run(a.cmd, { env: childEnv });
    // 126/127: gradlew couldn't even start — nothing to stop.
    if (a.stop && isGradlew(a.cmd) && code !== 126 && code !== 127) { log('🧹 gradlew --stop (trả RAM)…'); try { await stopGradle(a.cmd, { env: childEnv }); } catch {} }
    return code;
  } finally { lock.release(); }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
