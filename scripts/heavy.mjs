#!/usr/bin/env node
// heavy.mjs — run a heavy build under the machine-wide `build` lock (RFC 17),
// so two agents never build at once and OOM the box.
//
//   node ../teleport/scripts/heavy.mjs [--no-stop] [--wait <minutes>] [--own-target] [--no-ram-wait] -- <command> [args…]
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
// RFC 18 C — shared cargo target: inside a git repo, with CARGO_TARGET_DIR unset,
// the command gets CARGO_TARGET_DIR=~/.cache/teleport/cargo-target/<repo>-<hash6>,
// one dir for every worktree of that repo (<repo> = basename of the dir holding the
// git common dir, hash6 = sha256 of the common dir's path). Safe because builds are
// already serialized by the lock (and cargo locks its own dir). --own-target opts out.
// RFC 18 F — RAM wait: before queueing for the lock (not while holding it), wait
// while MemAvailable < TELEPORT_HEAVY_MIN_FREE_MB (default 3 GiB); give up — and
// build anyway, with a warning — once it has not risen for 2 min, or after 15 min.
// Skipped for nested heavy and with --no-ram-wait.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, describeHolder, readHolder, lockPaths } from './machine-lock.mjs';
import { isMainModule } from './is-direct-run.mjs';

export const WAIT_TIMEOUT_EXIT = 75;
export const HELD_ENV = 'TELEPORT_HEAVY_HELD';
const USAGE = 'usage: heavy.mjs [--no-stop] [--wait <minutes>] [--own-target] [--no-ram-wait] -- <command> [args…]';

/** argv → { cmd, stop, waitSec, ownTarget, ramWait } | { error }. Pure. */
export function parseHeavyArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) return { error: USAGE };
  let stop = true, waitSec = Infinity, ownTarget = false, ramWait = true;
  const opts = argv.slice(0, sep);
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--no-stop') stop = false;
    else if (opts[i] === '--own-target') ownTarget = true;
    else if (opts[i] === '--no-ram-wait') ramWait = false;
    else if (opts[i] === '--wait') {
      const n = Number(opts[++i]);
      if (!(n > 0)) return { error: `--wait needs minutes > 0\n${USAGE}` };
      waitSec = n * 60;
    } else return { error: `unexpected: ${opts[i]}\n${USAGE}` };
  }
  return { cmd: argv.slice(sep + 1), stop, waitSec, ownTarget, ramWait };
}

// ── RFC 18 C: shared cargo target dir ──

/** Absolute git common dir of `cwd`, or null (not in a repo / no git). */
export function gitCommonDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const out = r.status === 0 ? r.stdout.trim() : '';
  return out && path.isAbsolute(out) ? out : null;
}

/** Shared target dir for a git common dir: <home>/.cache/teleport/cargo-target/<repo>-<hash6>. Pure. */
export function sharedTargetDir(commonDir, home = os.homedir()) {
  const repo = path.basename(path.dirname(commonDir)) || 'repo';
  const hash6 = crypto.createHash('sha256').update(commonDir).digest('hex').slice(0, 6);
  return path.join(home, '.cache', 'teleport', 'cargo-target', `${repo}-${hash6}`);
}

/** CARGO_TARGET_DIR to set for the child, or null (inherited / --own-target / not in git). */
export function resolveCargoTarget({ env = process.env, ownTarget = false, cwd = process.cwd(), home = os.homedir(), commonDir = gitCommonDir } = {}) {
  if (env.CARGO_TARGET_DIR || ownTarget) return null;
  const cd = commonDir(cwd);
  return cd ? sharedTargetDir(cd, home) : null;
}

/** Does the command line run `cargo clean` (also inside `sh -c "…"`)? Pure. */
export function hasCargoClean(cmd) {
  const toks = cmd.join(' ').split(/\s+/);
  return toks.some((t, i) => path.basename(t) === 'cargo' && toks[i + 1] === 'clean');
}

// ── RFC 18 F: wait for free RAM ──

export const RAM_POLL_MS = 10_000;
export const RAM_PLATEAU_MS = 2 * 60_000;
export const RAM_CAP_MS = 15 * 60_000;
const RAM_LOG_EVERY_MS = 60_000;
const GiB = 1024 ** 3;

/** MemAvailable in bytes from /proc/meminfo, or null if unreadable. */
export function readMemAvailable(file = '/proc/meminfo') {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
}

/** Threshold in bytes from TELEPORT_HEAVY_MIN_FREE_MB (default 3 GiB; 0 = never wait). */
export function minFreeBytes(env = process.env) {
  const v = env.TELEPORT_HEAVY_MIN_FREE_MB;
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 1024 * 1024 : 3 * GiB;
}

const gib = (b) => (b / GiB).toFixed(1);

/**
 * Wait while MemAvailable < minBytes. Resolves { reason, waitedMs }:
 * 'ok' (enough RAM), 'unreadable' (no meminfo → no wait), 'plateau' (no rise for
 * 2 min), 'cap' (15 min total). Injectable readMem/sleep/now/log for tests.
 */
export async function waitForRam({ minBytes, readMem = readMemAvailable, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = (s) => console.error(s) } = {}) {
  const start = now();
  let mem = readMem();
  if (mem == null) return { reason: 'unreadable', waitedMs: 0 };
  if (mem >= minBytes) return { reason: 'ok', waitedMs: 0 };
  let best = mem, bestAt = start, loggedAt = -Infinity;
  for (;;) {
    const t = now();
    if (t - loggedAt >= RAM_LOG_EVERY_MS) { log(`⏳ chờ RAM: còn ${gib(mem)} GiB, cần ${gib(minBytes)} GiB…`); loggedAt = t; }
    await sleep(RAM_POLL_MS);
    const t2 = now();
    mem = readMem();
    if (mem == null) return { reason: 'unreadable', waitedMs: t2 - start };
    if (mem >= minBytes) return { reason: 'ok', waitedMs: t2 - start };
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
  cargoTarget = resolveCargoTarget, waitRam = waitForRam,
} = {}) {
  const a = parseHeavyArgs(argv);
  if (a.error) { log(a.error); return 2; }
  const cmdText = a.cmd.join(' ').slice(0, 200);
  const childEnv = { ...env, [HELD_ENV]: String(process.pid) };
  const target = cargoTarget({ env, ownTarget: a.ownTarget });
  if (target) {
    childEnv.CARGO_TARGET_DIR = target;
    log(`ℹ️ CARGO_TARGET_DIR=${target} (dùng chung giữa các worktree; --own-target để tắt)`);
  }
  if (childEnv.CARGO_TARGET_DIR && hasCargoClean(a.cmd)) log(`⚠️ heavy: \`cargo clean\` xoá ${childEnv.CARGO_TARGET_DIR} — cache build DÙNG CHUNG của mọi worktree (vẫn chạy).`);
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
