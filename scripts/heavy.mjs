#!/usr/bin/env node
// heavy.mjs — run a heavy build under the machine-wide `build` lock (RFC 17),
// so two agents never build at once and OOM the box.
//
//   node ../teleport/scripts/heavy.mjs [--no-stop] [--wait <minutes>] -- <command> [args…]
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

import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, describeHolder } from './machine-lock.mjs';
import { isMainModule } from './is-direct-run.mjs';

export const WAIT_TIMEOUT_EXIT = 75;
const USAGE = 'usage: heavy.mjs [--no-stop] [--wait <minutes>] -- <command> [args…]';

/** argv → { cmd, stop, waitSec } | { error }. Pure. */
export function parseHeavyArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) return { error: USAGE };
  let stop = true, waitSec = Infinity;
  const opts = argv.slice(0, sep);
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--no-stop') stop = false;
    else if (opts[i] === '--wait') {
      const n = Number(opts[++i]);
      if (!(n > 0)) return { error: `--wait needs minutes > 0\n${USAGE}` };
      waitSec = n * 60;
    } else return { error: `unexpected: ${opts[i]}\n${USAGE}` };
  }
  return { cmd: argv.slice(sep + 1), stop, waitSec };
}

/** True when the command is a Gradle wrapper (called directly — not via `sh -c`). Pure. */
export const isGradlew = (cmd) => path.basename(cmd[0] || '') === 'gradlew';

const hasSetpriv = () => spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).status === 0;

/** Spawn `cmd` in its own process group; forward signals; resolve its exit code. */
export function runForwarded(cmd, { spawnFn = spawn, setpriv = hasSetpriv(), proc = process } = {}) {
  // setpriv --pdeathsig: if WE are SIGKILLed (uncatchable, lock released), the build dies too.
  const argv = setpriv ? ['setpriv', '--pdeathsig', 'TERM', '--', ...cmd] : cmd;
  return new Promise((resolve) => {
    const child = spawnFn(argv[0], argv.slice(1), { stdio: 'inherit', detached: true });
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

export async function main(argv, { acquire = acquireLock, run = runForwarded, stopGradle = (cmd) => spawnSync(cmd[0], ['--stop'], { stdio: 'inherit' }), log = (s) => console.error(s) } = {}) {
  const a = parseHeavyArgs(argv);
  if (a.error) { log(a.error); return 2; }
  const cmdText = a.cmd.join(' ').slice(0, 200);
  let lock;
  try {
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
    const code = await run(a.cmd);
    if (a.stop && isGradlew(a.cmd)) { log('🧹 gradlew --stop (trả RAM)…'); try { stopGradle(a.cmd); } catch {} }
    return code;
  } finally { lock.release(); }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
