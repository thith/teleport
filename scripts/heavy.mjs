#!/usr/bin/env node
// heavy.mjs — run a heavy build under the machine-wide `build` lock (RFC 17),
// so two agents never build at once and OOM the box.
//
//   node ../teleport/scripts/heavy.mjs [--no-stop] [--no-scope] [--wait <minutes>] [--no-ram-wait] -- <command> [args…]
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
//
// RFC 20 — the build runs in its OWN transient systemd scope (a sibling of the
// agent's scope under app.slice), so when systemd-oomd kills for memory
// pressure it most likely takes the build, not the agent's whole session. The
// scope gets MemoryMax (default 45% of RAM) + MemorySwapMax=2G (containment,
// not a guarantee), and is stopped — leftovers killed — BEFORE the lock is
// released. CARGO_BUILD_JOBS defaults to 4. Pressure is read where oomd reads
// it (user@<uid>.service/memory.pressure) and re-checked after the lock.
// TELEPORT_HEAVY_SCOPE=0 / TELEPORT_HEAVY_MEM_MAX=<size|0> tune it. Anything the
// command leaves running dies with the scope — so `--no-scope` (e.g. booting an
// emulator that must stay up) and `--no-stop` (keep the Gradle daemon) run
// without one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, describeHolder, readHolder, lockPaths } from './machine-lock.mjs';
import { isMainModule } from './is-direct-run.mjs';

export const WAIT_TIMEOUT_EXIT = 75;
export const HELD_ENV = 'TELEPORT_HEAVY_HELD';
const USAGE = 'usage: heavy.mjs [--no-stop] [--no-scope] [--wait <minutes>] [--no-ram-wait] -- <command> [args…]';

/** argv → { cmd, stop, scope, waitSec, ramWait } | { error }. Pure. */
export function parseHeavyArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) return { error: USAGE };
  let stop = true, scope = true, waitSec = Infinity, ramWait = true;
  const opts = argv.slice(0, sep);
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--no-stop') { stop = false; scope = false; } // a kept daemon must outlive us: no scope to kill it
    else if (opts[i] === '--no-scope') scope = false;
    else if (opts[i] === '--own-target') { /* no-op: each worktree always has its own target/ */ }
    else if (opts[i] === '--no-ram-wait') ramWait = false;
    else if (opts[i] === '--wait') {
      const n = Number(opts[++i]);
      if (!(n > 0)) return { error: `--wait needs minutes > 0\n${USAGE}` };
      waitSec = n * 60;
    } else return { error: `unexpected: ${opts[i]}\n${USAGE}` };
  }
  return { cmd: argv.slice(sep + 1), stop, scope, waitSec, ramWait };
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
 * (percent) from memPressurePath() (user@<uid>.service, else global); a field that can't be read is null.
 */
export function readMemState({ meminfo = '/proc/meminfo', pressure = memPressurePath() } = {}) {
  let text = '';
  try { text = fs.readFileSync(meminfo, 'utf8'); } catch {}
  const kb = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm').exec(text); return m ? Number(m[1]) * 1024 : null; };
  let psiFull = null;
  try { const m = /^full\s.*?avg10=([\d.]+)/m.exec(fs.readFileSync(pressure, 'utf8')); if (m) psiFull = Number(m[1]); } catch {}
  return { avail: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree'), psiFull };
}

export const PLATEAU_RISE = 256 * 1024 ** 2;
export const PSI_FULL_MAX = 10; // % — wait above this (oomd's kill threshold is 50% for 20 s)

/** The memory.pressure oomd watches (user@<uid>.service) if present, else the global one. */
export function memPressurePath({ uid = process.getuid?.() ?? 0, exists = fs.existsSync } = {}) {
  const p = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/memory.pressure`;
  return exists(p) ? p : '/proc/pressure/memory';
}

// ── RFC 20: the build's own scope ──

export const SCOPE_SWAP_MAX = 2 * 1024 ** 3;
export const SCOPE_MEM_FRACTION = 0.45;
export const DEFAULT_CARGO_JOBS = '4';

/** '8G' / '8192M' / '512K' / '1073741824' → bytes; '0' → 0; junk → null. Pure. */
export function parseSize(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const mul = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()];
  return Math.floor(Number(m[1]) * mul);
}

/** MemoryMax in bytes for the build scope (page-aligned), or 0 = no limit. Pure. */
export function scopeMemMax(env = process.env, memTotal = os.totalmem()) {
  const raw = env.TELEPORT_HEAVY_MEM_MAX;
  const v = raw === undefined || raw === '' ? null : parseSize(raw);
  const bytes = v ?? Math.floor(memTotal * SCOPE_MEM_FRACTION);
  return bytes > 0 ? Math.max(4096, Math.floor(bytes / 4096) * 4096) : 0;
}

/** systemd-run argv putting `cmd` into its own scope. Pure. */
export function scopeArgv({ unit, memMax }, cmd) {
  return ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '-p', 'TimeoutStopSec=10s',
    ...(memMax > 0 ? ['-p', `MemoryMax=${memMax}`, '-p', `MemorySwapMax=${SCOPE_SWAP_MAX}`] : []), '--', ...cmd];
}

/**
 * Preflight: can we create such a scope, with the limits really enforced?
 * Runs a tiny `sh` in a test scope that prints its memory.max / memory.swap.max.
 */
export function scopePreflight({ memMax }, { run = spawnSync } = {}) {
  const unit = `heavy-pre-${process.pid}-${Math.random().toString(36).slice(2, 8)}.scope`;
  const sh = 'd=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); cat "$d/memory.max" "$d/memory.swap.max"';
  const argv = scopeArgv({ unit, memMax }, ['sh', '-c', sh]);
  const r = run(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 15_000 });
  if (r.error || r.status !== 0) return { ok: false, why: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0] };
  if (memMax > 0) {
    const [mx, sw] = String(r.stdout).trim().split('\n');
    if (Number(mx) !== memMax || Number(sw) !== SCOPE_SWAP_MAX) return { ok: false, why: `giới hạn không có hiệu lực (memory.max=${mx}, swap.max=${sw})` };
  }
  return { ok: true };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Does the cgroup (or any descendant) still hold a process? Unreadable → true (can't prove empty). */
export function cgroupPopulated(cg, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let t;
  try { t = read(`/sys/fs/cgroup${cg}/cgroup.events`); } catch (e) { return e.code !== 'ENOENT'; } // gone = empty
  const m = /^populated (\d)/m.exec(t);
  return m ? m[1] !== '0' : true;
}

/**
 * Stop the build scope and VERIFY nothing is left in it (descendants included).
 * Exit 5 "not loaded" = already collected. Leftovers → SIGKILL, re-checked.
 * → true only when the scope is proven empty / gone.
 */
export function stopScope(unit, { run = spawnSync, populated = cgroupPopulated, sleep = sleepSync, tries = 4 } = {}) {
  run('systemctl', ['--user', 'stop', unit], { encoding: 'utf8', timeout: 30_000 });
  for (let i = 0; i < tries; i++) {
    const sh = run('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', unit], { encoding: 'utf8', timeout: 10_000 });
    if (sh.error || sh.status !== 0) { sleep(500); continue; } // bus trouble: can't tell — retry
    const cg = String(sh.stdout || '').trim();
    if (!cg || !populated(cg)) return true; // unit gone (collected) or its cgroup empty
    run('systemctl', ['--user', 'kill', '-s', 'KILL', unit], { encoding: 'utf8', timeout: 10_000 });
    sleep(500);
  }
  // One last look: the final KILL may have emptied it.
  const sh = run('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', unit], { encoding: 'utf8', timeout: 10_000 });
  if (sh.error || sh.status !== 0) return false;
  const cg = String(sh.stdout || '').trim();
  return !cg || !populated(cg);
}

/**
 * Stale heavy-<pid>-*.scope units: their heavy is dead, or the pid now belongs
 * to something that isn't heavy.mjs (reused). A LIVE heavy's scope is never
 * touched — even one holding a different lock dir (tests, TELEPORT_LOCK_DIR).
 * Known gap: a holder whose final cleanup failed is still alive for a moment
 * after releasing the lock; a heavy starting in that instant won't see it as
 * stale (the one after will).
 */
export function orphanScopes({ run = spawnSync, alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }, isHeavy = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('heavy.mjs'); } catch { return true; } }} = {}) {
  const out = String(run('systemctl', ['--user', 'list-units', 'heavy-*.scope', '--all', '--plain', '--no-legend'], { encoding: 'utf8', timeout: 10_000 }).stdout || '');
  const units = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(heavy-(\d+)-[a-z0-9]+\.scope)\b/.exec(line);
    const pid = m && Number(m[2]);
    // (no self-exclusion: we haven't made our scope yet, and a dead heavy's pid
    // may have been reused by US — its scope is still an orphan)
    if (m && (!alive(pid) || !isHeavy(pid))) units.push(m[1]);
  }
  return units;
}

/** oom_kill count of app.slice (hierarchical), or null. */
export function appSliceOomKills({ uid = process.getuid?.() ?? 0, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  try { const m = /^oom_kill (\d+)/m.exec(read(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/memory.events`)); return m ? Number(m[1]) : null; } catch { return null; }
}

/** A TOML line without its comment (a `#` inside a "…" / '…' string is kept). Pure. */
function stripTomlComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}
/** A TOML key path → its segments: `"build" . 'jobs'` → ['build','jobs']; `"build.jobs"` → ['build.jobs']. Pure. */
function keyPath(k) {
  const segs = [];
  let cur = '', q = null, quoted = false;
  for (const c of k.trim()) {
    if (q) { if (c === q) q = null; else cur += c; }
    else if (c === '"' || c === "'") { q = c; quoted = true; }
    else if (c === '.') { segs.push(cur.trim()); cur = ''; quoted = false; }
    else if (!/\s/.test(c) || quoted) cur += /\s/.test(c) ? '' : c;
  }
  segs.push(cur.trim());
  return segs;
}
const normKey = (k) => keyPath(k).join('\u0000'); // segment boundary that a quoted key can't fake with "."
/** String contents blanked (so `"…jobs = 8…"` inside a value can't match). Pure. */
const blankStrings = (v) => v.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

/** Does this Cargo TOML set build.jobs? `jobs` under [build], `build.jobs = …`, `build = { jobs = … }`; comments / quoted keys handled. Pure. */
export function tomlHasBuildJobs(text) {
  let table = '';
  for (const raw of String(text).split('\n')) {
    const line = stripTomlComment(raw.replace(/\r$/, '')).trim();
    if (!line) continue;
    if (/^\[\[/.test(line)) { table = '[[array]]'; continue; } // [[bin]] etc.: not [build]
    const h = /^\[([^\[\]]+)\]$/.exec(line);
    if (h) { table = normKey(h[1]); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = normKey(line.slice(0, eq));
    const val = line.slice(eq + 1).trim();
    if (table === 'build' && key === 'jobs') return true;
    if (table === '' && key === 'build\u0000jobs') return true;
    if (table === '' && key === 'build' && val.startsWith('{') && /[{,]\s*["']?jobs["']?\s*=/.test(blankStrings(val))) return true;
  }
  return false;
}

/** Is `build.jobs` set in a Cargo config from cwd up, or in CARGO_HOME / ~/.cargo? */
export function cargoJobsConfigured({ cwd = process.cwd(), env = process.env, read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } } } = {}) {
  const dirs = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) { dirs.push(path.join(d, '.cargo')); if (path.dirname(d) === d) break; }
  dirs.push(env.CARGO_HOME || path.join(os.homedir(), '.cargo'));
  for (const d of dirs) for (const f of ['config.toml', 'config']) {
    const t = read(path.join(d, f));
    if (t && tomlHasBuildJobs(t)) return true;
  }
  return false;
}

/**
 * Swap nearly full: free under max(1 GiB, 10%) — capped at 25% of the swap so a
 * small swap isn't "full" at half use. No swap → not "low". Pure.
 */
export function swapLow({ swapTotal, swapFree }) {
  if (!swapTotal || swapFree == null) return false;
  return swapFree < Math.min(Math.max(GiB, swapTotal * 0.1), swapTotal * 0.25);
}

/** Why a build should wait now ([] = go). Pure. */
export function memBlockers(st, minBytes) {
  const why = [];
  if (st.avail != null && st.avail < minBytes) why.push(`còn ${gib(st.avail)} GiB, cần ${gib(minBytes)} GiB`);
  // Full swap with plenty of free RAM is old swapped-out pages, not danger:
  // it only counts while RAM is also tight.
  if (minBytes > 0 && swapLow(st) && st.avail != null && st.avail < 2 * minBytes) why.push(`swap gần đầy (còn ${gib(st.swapFree)} / ${gib(st.swapTotal)} GiB)`);
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
    if (mem > best + PLATEAU_RISE) { best = mem; bestAt = t2; } // a real rise, not MB-level jitter
    if (t2 - start >= RAM_CAP_MS) { log(`⚠️ heavy: đã chờ ${Math.round((t2 - start) / 60000)} phút (${why.join(' · ')}) — chạy luôn, dễ OOM.`); return { reason: 'cap', waitedMs: t2 - start }; }
    if (t2 - bestAt >= RAM_PLATEAU_MS) { log(`⚠️ heavy: RAM không tăng trong 2 phút (${why.join(' · ')}; có tiến trình sống lâu đang giữ) — chạy luôn, dễ OOM.`); return { reason: 'plateau', waitedMs: t2 - start }; }
  }
}

/** True when the command is a Gradle wrapper (called directly — not via `sh -c`). Pure. */
export const isGradlew = (cmd) => path.basename(cmd[0] || '') === 'gradlew';

const hasSetpriv = () => spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).status === 0;

/** Spawn `cmd` in its own process group; forward signals; resolve its exit code. */
export function runForwarded(cmd, { spawnFn = spawn, setpriv = hasSetpriv(), proc = process, env = { ...process.env, [HELD_ENV]: String(process.pid) }, scope = null } = {}) {
  // setpriv --pdeathsig: if WE are SIGKILLed (uncatchable, lock released), the build dies too.
  // Inside the scope: systemd-run --scope execs setpriv, which execs the command
  // (same pid / process group → signal forwarding unchanged).
  const inner = setpriv ? ['setpriv', '--pdeathsig', 'TERM', '--', ...cmd] : cmd;
  const argv = scope ? scopeArgv(scope, inner) : inner;
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
  scopeOps = { preflight: scopePreflight, stop: stopScope, orphans: orphanScopes, oomKills: appSliceOomKills, jobsConfigured: cargoJobsConfigured, memTotal: os.totalmem() },
} = {}) {
  const a = parseHeavyArgs(argv);
  if (a.error) { log(a.error); return 2; }
  const cmdText = a.cmd.join(' ').slice(0, 200);
  const isNested = nested(env);
  // Nested: keep the OUTERMOST owner's pid, so a third level still sees its
  // ancestor's lock (overwriting it with ours deadlocked depth 3).
  const childEnv = { ...env, [HELD_ENV]: isNested ? env[HELD_ENV] : String(process.pid) };
  if (!childEnv.CARGO_BUILD_JOBS && !isNested && !scopeOps.jobsConfigured({ env })) childEnv.CARGO_BUILD_JOBS = DEFAULT_CARGO_JOBS;
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
  let scope = null;
  try {
    if (!isNested) {
      // A heavy SIGKILLed earlier lost its lock, but its build may still run: stop it now.
      for (const u of scopeOps.orphans()) {
        log(`🧹 heavy: dừng build mồ côi ${u}`);
        if (!scopeOps.stop(u)) { log(`❌ heavy: không dừng được build mồ côi ${u} — không chạy chồng lên nó. Thử lại sau / systemctl --user kill -s KILL ${u} (rồi systemctl --user reset-failed ${u})`); return WAIT_TIMEOUT_EXIT; }
      }
      // Pressure may have changed while we queued: check again, now that we're next.
      if (a.ramWait) await waitRam({ minBytes: minFreeBytes(env), log });
      if (a.scope && env.TELEPORT_HEAVY_SCOPE !== '0') {
        const memMax = scopeMemMax(env, scopeOps.memTotal);
        const pf = scopeOps.preflight({ memMax });
        if (pf.ok) scope = { unit: `heavy-${process.pid}-${Math.random().toString(36).slice(2, 8)}.scope`, memMax };
        else log(`⚠️ heavy: không tạo được scope riêng (${pf.why}) — chạy như cũ, không giới hạn RAM.`);
      }
    }
    // A Gradle daemon started earlier lives outside our scope (unlimited): stop it first.
    // Ctrl-C / TERM during these pre-steps cancels the build (it must not start anyway).
    let cancelled = null;
    const onSig = (sig) => { cancelled = sig || 'SIGINT'; };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSig);
    try {
      if (scope && a.stop && isGradlew(a.cmd)) {
        log('🧹 gradlew --stop (daemon cũ, trước build)…');
        let rc = 0;
        try { rc = await stopGradle(a.cmd, { env: childEnv }); } catch { rc = 1; }
        if (rc && !cancelled) log('⚠️ heavy: gradlew --stop trước build thất bại — daemon cũ (ngoài scope, không giới hạn RAM) có thể bị dùng lại.');
      }
    } finally { for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, onSig); }
    if (cancelled) { log('⏹ heavy: bị huỷ trước khi build bắt đầu — không chạy.'); return 128 + (os.constants.signals[cancelled] || 2); }
    const oomBefore = scope ? scopeOps.oomKills() : null;
    const code = await run(a.cmd, { env: childEnv, ...(scope ? { scope } : {}) });
    // 126/127: gradlew couldn't even start — nothing to stop.
    if (a.stop && isGradlew(a.cmd) && code !== 126 && code !== 127) { log('🧹 gradlew --stop (trả RAM)…'); try { await stopGradle(a.cmd, { env: childEnv }); } catch {} }
    const oomAfter = scope ? scopeOps.oomKills() : null;
    // (app.slice counts every agent's OOMs too: only blame the build if it died by a signal)
    if (code >= 128 && oomBefore != null && oomAfter != null && oomAfter > oomBefore) {
      log(`⚠️ heavy: kernel đã giết tiến trình của build vì vượt giới hạn RAM ${(scope.memMax / GiB).toFixed(1)} GiB — giảm CARGO_BUILD_JOBS / chia nhỏ test, hoặc đặt TELEPORT_HEAVY_MEM_MAX.`);
    }
    return code;
  } finally {
    // Leftovers (a daemon, a stray child) die BEFORE the next build may start.
    if (scope) {
      // Ignore Ctrl-C / TERM while stopping: dying here would drop the lock with the build maybe still alive.
      const ign = () => {};
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, ign);
      let stopped = false;
      try { stopped = scopeOps.stop(scope.unit); } catch {}
      finally { for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, ign); }
      if (!stopped) log(`⚠️ heavy: KHÔNG xác nhận được scope ${scope.unit} đã trống (systemctl lỗi) — nhả lock để không chặn mọi build; build kế tiếp sẽ thử dọn và không chạy chồng nếu không dọn được.`);
    }
    lock.release();
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
