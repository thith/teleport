// heavy.mjs: arg parsing, never a shared cargo target (RFC 18 C removed), F (RAM wait).
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseHeavyArgs,
  waitForRam, minFreeBytes, readMemAvailable, readMemState, memBlockers, swapLow, parseSize, scopeMemMax, scopeArgv, scopePreflight, stopScope, orphanScopes, cargoJobsConfigured, memPressurePath, runForwarded, main as heavyMain,
  RAM_POLL_MS, RAM_PLATEAU_MS, RAM_CAP_MS,
} from './heavy.mjs';

const HEAVY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'heavy.mjs');
const GiB = 1024 ** 3;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
/** Temp repo `myrepo` with a linked worktree `wt` (outside it) and a subdir. */
function repoWithWorktree() {
  const root = fs.realpathSync(tmp('tp-heavy-git-'));
  const repo = path.join(root, 'myrepo');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'sub', 'f'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const wt = path.join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'other', wt);
  return { root, repo, wt };
}

test('parse: --own-target accepted as a no-op; --shared-target no longer exists; --no-ram-wait', () => {
  assert.deepEqual(parseHeavyArgs(['--', 'a']), { cmd: ['a'], stop: true, scope: true, waitSec: Infinity, ramWait: true });
  assert.deepEqual(parseHeavyArgs(['--no-scope', '--', 'boot-emulator']), { cmd: ['boot-emulator'], stop: true, scope: false, waitSec: Infinity, ramWait: true });
  assert.deepEqual(parseHeavyArgs(['--own-target', '--no-stop', '--no-ram-wait', '--wait', '1', '--', 'cargo', '--shared-target']),
    { cmd: ['cargo', '--shared-target'], stop: false, scope: false, waitSec: 60, ramWait: false }, '--no-stop also means no scope (the kept daemon must survive)');
  assert.match(parseHeavyArgs(['--shared-target', '--', 'a']).error, /unexpected/);
});

test('real process: heavy never sets CARGO_TARGET_DIR (each worktree builds into its own target/)', async () => {
  const { wt } = repoWithWorktree();
  const env = { ...process.env, TELEPORT_LOCK_DIR: tmp('tp-heavy-lock-'), TELEPORT_HEAVY_MIN_FREE_MB: '0' };
  delete env.TELEPORT_HEAVY_HELD; delete env.CARGO_TARGET_DIR;
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [HEAVY, '--', 'sh', '-c', 'echo "T=${CARGO_TARGET_DIR:-none}"'], { cwd: wt, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /T=none/);
  assert.doesNotMatch(r.err, /CARGO_TARGET_DIR/);
});

/** Fake clock: sleep advances `now`; readMem plays `seq` (GiB) one value per read, last repeats. */
function fake(seq) {
  let t = 0, i = 0;
  const logs = [], sleeps = [];
  return {
    logs, sleeps,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    readMem: () => { const v = seq[Math.min(i++, seq.length - 1)]; return v == null ? null : v * GiB; },
    log: (s) => logs.push(s),
  };
}

test('F: enough RAM → no wait; unreadable meminfo → no wait', async () => {
  let f = fake([5]);
  assert.deepEqual(await waitForRam({ minBytes: 3 * GiB, ...f }), { reason: 'ok', waitedMs: 0 });
  assert.equal(f.sleeps.length, 0);
  f = fake([null]);
  assert.deepEqual(await waitForRam({ minBytes: 3 * GiB, ...f }), { reason: 'unreadable', waitedMs: 0 });
  assert.equal(f.logs.length, 0);
});

test('F: waits (polling every 10 s) and proceeds as soon as RAM rises above the threshold', async () => {
  const f = fake([1, 1.5, 2, 2.5, 3.2]);
  const r = await waitForRam({ minBytes: 3 * GiB, ...f });
  assert.deepEqual(r, { reason: 'ok', waitedMs: 4 * RAM_POLL_MS });
  assert.ok(f.sleeps.every((ms) => ms === 10_000));
  assert.equal(f.logs.length, 1, 'at most one line per minute');
  assert.match(f.logs[0], /^⏳ chờ RAM: còn 1\.0 GiB, cần 3\.0 GiB…$/);
});

test('F: stops after 2 min without any rise (plateau), with a warning', async () => {
  // best 1.5 at t=10 s, never beaten; 1.2 → 1.4 is a rise vs the previous reading but not vs the best
  const f = fake([1, 1.5, 1.2, 1.4, 1.4]);
  const r = await waitForRam({ minBytes: 3 * GiB, ...f });
  assert.equal(r.reason, 'plateau');
  assert.equal(r.waitedMs, RAM_POLL_MS + RAM_PLATEAU_MS);
  assert.match(f.logs.at(-1), /không tăng trong 2 phút/);
  assert.equal(f.logs.filter((l) => l.startsWith('⏳')).length, 3, 'one ⏳ per minute (t=0, 60, 120 s)');
});

test('F: slowly rising RAM is capped at 15 min total', async () => {
  let v = 0.1;
  const f = fake([]);
  f.readMem = () => (v += 0.03) * GiB; // rising ~30 MiB per poll (a real rise), never enough
  const r = await waitForRam({ minBytes: 3 * GiB, ...f });
  assert.equal(r.reason, 'cap');
  assert.equal(r.waitedMs, RAM_CAP_MS);
  assert.match(f.logs.at(-1), /đã chờ 15 phút \(còn/);
});

const NO_SCOPE = { preflight: () => ({ ok: false, why: 'test' }), stop: () => true, orphans: () => [], oomKills: () => null, jobsConfigured: () => false, memTotal: 16 * 1024 ** 3 };

test('F: main waits BEFORE acquiring the lock AND again after it; skipped when nested or --no-ram-wait; threshold from env', async () => {
  const go = async (argv, { nested = false, env = {} } = {}) => {
    const ev = [];
    await heavyMain(argv, {
      env, nested: () => nested, log: () => {}, scopeOps: NO_SCOPE,
      waitRam: async ({ minBytes }) => { ev.push(`ram ${minBytes / 1024 / 1024}`); },
      acquire: async () => { ev.push('acquire'); return { release() { ev.push('release'); }, waitedMs: 0 }; },
      run: async () => { ev.push('run'); return 0; },
    });
    return ev;
  };
  assert.deepEqual(await go(['--', 'x']), ['ram 3072', 'acquire', 'ram 3072', 'run', 'release']);
  assert.deepEqual(await go(['--', 'x'], { env: { TELEPORT_HEAVY_MIN_FREE_MB: '512' } }), ['ram 512', 'acquire', 'ram 512', 'run', 'release']);
  assert.deepEqual(await go(['--no-ram-wait', '--', 'x']), ['acquire', 'run', 'release']);
  assert.deepEqual(await go(['--', 'x'], { nested: true }), ['run']);
  assert.equal(minFreeBytes({}), 3 * GiB);
  assert.equal(minFreeBytes({ TELEPORT_HEAVY_MIN_FREE_MB: '0' }), 0);
  assert.equal(minFreeBytes({ TELEPORT_HEAVY_MIN_FREE_MB: 'abc' }), 3 * GiB);
});

test('F: readMemAvailable parses kB from meminfo; missing file / field → null', () => {
  const d = tmp('tp-heavy-mem-');
  const f = path.join(d, 'meminfo');
  fs.writeFileSync(f, 'MemTotal:       16000000 kB\nMemFree:         100 kB\nMemAvailable:    2097152 kB\n');
  assert.equal(readMemAvailable(f), 2 * GiB);
  fs.writeFileSync(f, 'MemTotal: 1 kB\n');
  assert.equal(readMemAvailable(f), null);
  assert.equal(readMemAvailable(path.join(d, 'nope')), null);
});

test('F: swap nearly full or high memory pressure → wait too, even with enough MemAvailable', async () => {
  const seq = [
    { avail: 5 * GiB, swapTotal: 33 * GiB, swapFree: 0.5 * GiB, psiFull: 0 },
    { avail: 5 * GiB, swapTotal: 33 * GiB, swapFree: 20 * GiB, psiFull: 35 },
    { avail: 5 * GiB, swapTotal: 33 * GiB, swapFree: 20 * GiB, psiFull: 1 },
  ];
  let t = 0, i = 0;
  const logs = [];
  const r = await waitForRam({ minBytes: 3 * GiB, readState: () => seq[Math.min(i++, seq.length - 1)], now: () => t, sleep: async (ms) => { t += ms; }, log: (s) => logs.push(s) });
  assert.deepEqual(r, { reason: 'ok', waitedMs: 2 * RAM_POLL_MS });
  assert.match(logs[0], /swap gần đầy \(còn 0\.5 \/ 33\.0 GiB\)/);
});

test('F: memBlockers / swapLow thresholds; TELEPORT_HEAVY_MIN_FREE_MB=0 disables every wait', () => {
  assert.equal(swapLow({ swapTotal: 2 * GiB, swapFree: 0.4 * GiB }), true, '< 25% of a small swap');
  assert.equal(swapLow({ swapTotal: 2 * GiB, swapFree: 0.9 * GiB }), false, 'a 2 GiB swap is not "full" at half use');
  assert.equal(swapLow({ swapTotal: 0.5 * GiB, swapFree: 0.2 * GiB }), false, '512 MiB swap, 40% free');
  assert.equal(swapLow({ swapTotal: 33 * GiB, swapFree: 3 * GiB }), true, '< 10% of a big swap');
  assert.equal(swapLow({ swapTotal: 33 * GiB, swapFree: 4 * GiB }), false);
  assert.equal(swapLow({ swapTotal: 0, swapFree: 0 }), false, 'no swap at all');
  assert.deepEqual(memBlockers({ avail: 8 * GiB, swapTotal: 33 * GiB, swapFree: 20 * GiB, psiFull: 9.9 }, 3 * GiB), []);
  assert.deepEqual(memBlockers({ avail: 8 * GiB, swapTotal: 33 * GiB, swapFree: 0.5 * GiB }, 3 * GiB), [], 'full swap with plenty of free RAM is not a reason');
  assert.equal(memBlockers({ avail: 8 * GiB, psiFull: 10 }, 3 * GiB).length, 1);
  assert.deepEqual(memBlockers({ avail: 0, swapTotal: 2 * GiB, swapFree: 0, psiFull: 90 }, 0), []);
});

test('F: readMemState parses meminfo + PSI; missing pieces → null', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-psi-'));
  const mi = path.join(d, 'meminfo'), ps = path.join(d, 'pressure');
  fs.writeFileSync(mi, 'MemAvailable:    2097152 kB\nSwapTotal:      4194304 kB\nSwapFree:       1048576 kB\n');
  fs.writeFileSync(ps, 'some avg10=3.10 avg60=1.00 avg300=0.50 total=1\nfull avg10=2.50 avg60=0.75 avg300=0.33 total=1\n');
  assert.deepEqual(readMemState({ meminfo: mi, pressure: ps }), { avail: 2 * GiB, swapTotal: 4 * GiB, swapFree: 1 * GiB, psiFull: 2.5 });
  assert.deepEqual(readMemState({ meminfo: path.join(d, 'no'), pressure: path.join(d, 'no') }), { avail: null, swapTotal: null, swapFree: null, psiFull: null });
});

test('F: RAM jittering by MBs does not reset the 2-min plateau', async () => {
  let v = 1, i = 0;
  const f = fake([]);
  f.readMem = () => (v + ((i++ % 2) ? 0.002 : 0) + i * 0.0005) * GiB; // tiny wobble + creep, never a real rise
  const r = await waitForRam({ minBytes: 3 * GiB, ...f });
  assert.equal(r.reason, 'plateau');
  assert.ok(r.waitedMs <= 3 * 60_000, `gave up after ${r.waitedMs} ms`);
});

// ── RFC 20: the build's own scope ──

test('RFC20: parseSize / scopeMemMax (45% of RAM default, env override, 0 = no limit, page-aligned)', () => {
  assert.equal(parseSize('8G'), 8 * GiB);
  assert.equal(parseSize('512M'), 512 * 1024 ** 2);
  assert.equal(parseSize('0'), 0);
  assert.equal(parseSize('lots'), null);
  assert.equal(scopeMemMax({}, 16 * GiB), Math.floor(16 * GiB * 0.45 / 4096) * 4096);
  assert.equal(scopeMemMax({ TELEPORT_HEAVY_MEM_MAX: '8G' }, 16 * GiB), 8 * GiB);
  assert.equal(scopeMemMax({ TELEPORT_HEAVY_MEM_MAX: '0' }, 16 * GiB), 0);
  assert.equal(scopeMemMax({ TELEPORT_HEAVY_MEM_MAX: 'junk' }, 16 * GiB), Math.floor(16 * GiB * 0.45 / 4096) * 4096);
});

test('RFC20: scopeArgv — .scope unit, TimeoutStopSec, limits only when capped', () => {
  const a = scopeArgv({ unit: 'heavy-1-ab.scope', memMax: 8 * GiB }, ['setpriv', '--', 'cargo', 'test']);
  assert.deepEqual(a, ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--unit=heavy-1-ab.scope', '-p', 'TimeoutStopSec=10s',
    '-p', `MemoryMax=${8 * GiB}`, '-p', `MemorySwapMax=${2 * GiB}`, '--', 'setpriv', '--', 'cargo', 'test']);
  assert.ok(!scopeArgv({ unit: 'u.scope', memMax: 0 }, ['x']).some((x) => /Memory/.test(x)), 'no MemoryMax=0 ever');
});

test('RFC20: runForwarded wraps systemd-run OUTSIDE setpriv (setpriv\'s parent stays heavy)', async () => {
  let argv;
  const spawnFn = (bin, args) => { argv = [bin, ...args]; const ee = new EventEmitter(); ee.pid = 1; setImmediate(() => ee.emit('close', 0)); return ee; };
  await runForwarded(['cargo', 'build'], { spawnFn, setpriv: true, proc: { on() {}, off() {} }, scope: { unit: 'heavy-9-x.scope', memMax: GiB } });
  assert.equal(argv[0], 'systemd-run');
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['setpriv', '--pdeathsig', 'TERM', '--', 'cargo', 'build']);
});

test('RFC20: scopePreflight checks the limits are really enforced', () => {
  const ok = scopePreflight({ memMax: GiB }, { run: () => ({ status: 0, stdout: `${GiB}\n${2 * GiB}\n` }) });
  assert.equal(ok.ok, true);
  assert.equal(scopePreflight({ memMax: GiB }, { run: () => ({ status: 0, stdout: 'max\nmax\n' }) }).ok, false);
  assert.equal(scopePreflight({ memMax: GiB }, { run: () => ({ status: 1, stderr: 'Failed to connect to bus' }) }).ok, false);
  assert.equal(scopePreflight({ memMax: 0 }, { run: () => ({ status: 0, stdout: 'max\nmax\n' }) }).ok, true, 'uncapped: only "can we make a scope"');
});

test('RFC20: stopScope stops the .scope unit and VERIFIES it is empty; leftovers → KILL + recheck; unprovable → false', () => {
  const mk = (pops, { showFail = 0 } = {}) => {
    const calls = []; let k = 0, f = showFail;
    const run = (bin, args) => { calls.push(args.slice(1).join(' ')); if (args[1] === 'show') { if (f-- > 0) return { status: 1, error: new Error('bus') }; return { status: 0, stdout: '/u/x.scope\n' }; } return { status: 0 }; };
    return { calls, opts: { run, populated: () => pops[Math.min(k++, pops.length - 1)], sleep: () => {} } };
  };
  let t = mk([false]);
  assert.equal(stopScope('heavy-1-a.scope', t.opts), true);
  assert.deepEqual(t.calls, ['stop heavy-1-a.scope', 'show -p ControlGroup --value heavy-1-a.scope']);
  t = mk([true, false]);
  assert.equal(stopScope('heavy-1-a.scope', t.opts), true, 'leftover killed, then verified empty');
  assert.ok(t.calls.includes('kill -s KILL heavy-1-a.scope'));
  t = mk([true]);
  assert.equal(stopScope('heavy-1-a.scope', t.opts), false, 'still populated after every KILL → not proven');
  t = mk([false], { showFail: 99 });
  assert.equal(stopScope('heavy-1-a.scope', t.opts), false, 'bus down → cannot prove');
  const gone = { run: (b, a) => (a[1] === 'show' ? { status: 0, stdout: '\n' } : { status: 5 }), populated: () => true, sleep: () => {} };
  assert.equal(stopScope('heavy-1-a.scope', gone), true, 'unit already collected (not loaded)');
});

test('cgroupPopulated: reads cgroup.events (descendants included); gone = empty; unreadable = populated', async () => {
  const { cgroupPopulated } = await import('./heavy.mjs');
  assert.equal(cgroupPopulated('/x', { read: () => 'populated 0\nfrozen 0\n' }), false);
  assert.equal(cgroupPopulated('/x', { read: () => 'populated 1\n' }), true);
  assert.equal(cgroupPopulated('/x', { read: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), false);
  assert.equal(cgroupPopulated('/x', { read: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }), true);
});

test('RFC20: orphanScopes — only scopes of DEAD heavies (not ours, not live ones)', () => {
  const run = () => ({ stdout: 'heavy-111-aa.scope loaded active running x\nheavy-222-bb.scope loaded active running y\nheavy-pre-5-cc.scope loaded active running\nother.scope x\n' });
  assert.deepEqual(orphanScopes({ run, alive: (pid) => pid === 222, self: 999 }), ['heavy-111-aa.scope']);
  assert.deepEqual(orphanScopes({ run, alive: () => false, self: 111 }), ['heavy-222-bb.scope']);
});

test('RFC20: cargoJobsConfigured finds build.jobs up the tree or in CARGO_HOME', () => {
  const files = { '/w/proj/.cargo/config.toml': '[build]\njobs = 2\n' };
  const read = (f) => files[f] ?? null;
  assert.equal(cargoJobsConfigured({ cwd: '/w/proj/sub', env: { CARGO_HOME: '/h' }, read }), true);
  assert.equal(cargoJobsConfigured({ cwd: '/w/other', env: { CARGO_HOME: '/h' }, read }), false);
  assert.equal(cargoJobsConfigured({ cwd: '/x', env: { CARGO_HOME: '/h' }, read: (f) => (f === '/h/config.toml' ? '[build]\njobs=8' : null) }), true);
});

test('RFC20: memPressurePath prefers user@<uid>.service/memory.pressure', () => {
  assert.equal(memPressurePath({ uid: 1000, exists: () => true }), '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/memory.pressure');
  assert.equal(memPressurePath({ uid: 1000, exists: () => false }), '/proc/pressure/memory');
});

test('RFC20 main: orphans stopped, scope used, gradle stopped before AND after, scope stopped BEFORE the lock is released; CARGO_BUILD_JOBS', async () => {
  const ev = [];
  let runOpts;
  const ops = {
    preflight: () => ({ ok: true }), stop: (u) => { ev.push(`stop ${u.replace(new RegExp(`-${process.pid}-[a-z0-9]+`), '-P-R')}`); return true; },
    orphans: () => ['heavy-1-dead.scope'], oomKills: () => 0, jobsConfigured: () => false, memTotal: 16 * GiB,
  };
  await heavyMain(['--', './gradlew', 'test'], {
    env: {}, nested: () => false, log: () => {}, scopeOps: ops, waitRam: async () => {},
    acquire: async () => ({ release() { ev.push('release'); }, waitedMs: 0 }),
    run: async (cmd, o) => { runOpts = o; ev.push('run'); return 0; },
    stopGradle: async () => { ev.push('gradle-stop'); },
  });
  assert.deepEqual(ev, ['stop heavy-1-dead.scope', 'gradle-stop', 'run', 'gradle-stop', 'stop heavy-P-R.scope', 'release']);
  assert.match(runOpts.scope.unit, /^heavy-\d+-[a-z0-9]+\.scope$/);
  assert.equal(runOpts.env.CARGO_BUILD_JOBS, '4');
  // agent's own setting / project config wins
  await heavyMain(['--', 'cargo', 'build'], { env: { CARGO_BUILD_JOBS: '2' }, nested: () => false, log: () => {}, scopeOps: ops, waitRam: async () => {},
    acquire: async () => ({ release() {}, waitedMs: 0 }), run: async (c, o) => { runOpts = o; return 0; } });
  assert.equal(runOpts.env.CARGO_BUILD_JOBS, '2');
  await heavyMain(['--', 'cargo', 'build'], { env: {}, nested: () => false, log: () => {}, scopeOps: { ...ops, jobsConfigured: () => true }, waitRam: async () => {},
    acquire: async () => ({ release() {}, waitedMs: 0 }), run: async (c, o) => { runOpts = o; return 0; } });
  assert.equal(runOpts.env.CARGO_BUILD_JOBS, undefined);
});

test('RFC20 main: scope stopped and lock released even when the build throws; oom_kill rise is reported', async () => {
  const ev = [], logs = [];
  let n = 0;
  const ops = { preflight: () => ({ ok: true }), stop: () => { ev.push('stop'); return true; }, orphans: () => [], oomKills: () => n++, jobsConfigured: () => true, memTotal: 16 * GiB };
  const code = await heavyMain(['--', 'cargo', 'test'], { env: {}, nested: () => false, log: (s) => logs.push(s), scopeOps: ops, waitRam: async () => {},
    acquire: async () => ({ release() { ev.push('release'); }, waitedMs: 0 }), run: async () => 137 });
  assert.equal(code, 137);
  assert.ok(logs.some((l) => /vượt giới hạn RAM/.test(l)));
  await assert.rejects(heavyMain(['--', 'x'], { env: {}, nested: () => false, log: () => {}, scopeOps: ops, waitRam: async () => {},
    acquire: async () => ({ release() { ev.push('release'); }, waitedMs: 0 }), run: async () => { throw new Error('boom'); } }));
  assert.deepEqual(ev.slice(-2), ['stop', 'release']);
});

test('RFC20 main: preflight fails → runs WITHOUT a scope (warned); TELEPORT_HEAVY_SCOPE=0 → no preflight; nested → no scope, owner pid kept', async () => {
  let runOpts, pf = 0;
  const logs = [];
  const base = { nested: () => false, log: (s) => logs.push(s), waitRam: async () => {}, acquire: async () => ({ release() {}, waitedMs: 0 }), run: async (c, o) => { runOpts = o; return 0; } };
  await heavyMain(['--', 'x'], { ...base, env: {}, scopeOps: { ...NO_SCOPE, preflight: () => { pf++; return { ok: false, why: 'no bus' }; } } });
  assert.equal(runOpts.scope, undefined);
  assert.ok(logs.some((l) => /không tạo được scope riêng \(no bus\)/.test(l)));
  await heavyMain(['--', 'x'], { ...base, env: { TELEPORT_HEAVY_SCOPE: '0' }, scopeOps: { ...NO_SCOPE, preflight: () => { pf++; return { ok: true }; } } });
  assert.equal(pf, 1);
  await heavyMain(['--', 'x'], { ...base, nested: () => true, env: { TELEPORT_HEAVY_HELD: '4242' }, scopeOps: { ...NO_SCOPE, preflight: () => { pf++; return { ok: true }; } } });
  assert.equal(runOpts.scope, undefined);
  assert.equal(runOpts.env.TELEPORT_HEAVY_HELD, '4242', 'nested keeps the outermost owner (depth 3 must still see it)');
  assert.equal(pf, 1);
});

test('RFC20 review: --no-scope → no preflight/scope; oom_kill rise with exit 0 is NOT blamed on the build; stop failure warned', async () => {
  let pf = 0, runOpts;
  const logs = [];
  let n = 0;
  const ops = { preflight: () => { pf++; return { ok: true }; }, stop: () => false, orphans: () => [], oomKills: () => n++, jobsConfigured: () => true, memTotal: 16 * GiB };
  const base = { env: {}, nested: () => false, log: (s) => logs.push(s), waitRam: async () => {}, acquire: async () => ({ release() {}, waitedMs: 0 }), run: async (c, o) => { runOpts = o; return 0; } };
  await heavyMain(['--no-scope', '--', 'emu'], { ...base, scopeOps: ops });
  assert.equal(pf, 0);
  assert.equal(runOpts.scope, undefined);
  await heavyMain(['--', 'cargo', 'test'], { ...base, scopeOps: ops });
  assert.ok(!logs.some((l) => /vượt giới hạn RAM/.test(l)), 'someone else\'s OOM, our build exited 0');
  assert.ok(logs.some((l) => /KHÔNG xác nhận được scope/.test(l)));
});

test('RFC20 review: cargoJobsConfigured — dotted key and inline table', () => {
  for (const t of ['build.jobs = 2', 'build = { jobs = 2 }', '[build]\n  jobs=3']) {
    assert.equal(cargoJobsConfigured({ cwd: '/p', env: { CARGO_HOME: '/h' }, read: (f) => (f === '/p/.cargo/config.toml' ? t : null) }), true, t);
  }
  assert.equal(cargoJobsConfigured({ cwd: '/p', env: { CARGO_HOME: '/h' }, read: (f) => (f === '/p/.cargo/config.toml' ? 'codegen-units = 1' : null) }), false);
});

test('post-merge: tomlHasBuildJobs ignores comments and other tables', async () => {
  const { tomlHasBuildJobs } = await import('./heavy.mjs');
  assert.equal(tomlHasBuildJobs('# jobs = 8\n[build]\n# jobs = 2\ntarget-dir = "x"'), false);
  assert.equal(tomlHasBuildJobs('[profile.dev]\njobs = 2'), false);
  assert.equal(tomlHasBuildJobs('[build]\njobs = 2 # fewer'), true);
  assert.equal(tomlHasBuildJobs('build.jobs = 3'), true);
  assert.equal(tomlHasBuildJobs('build = { jobs = 2, target = "x" }'), true);
});

test('post-merge: an orphan that cannot be stopped → refuse to run (no overlap)', async () => {
  let ran = false;
  const logs = [];
  const code = await heavyMain(['--', 'cargo', 'build'], { env: {}, nested: () => false, log: (s) => logs.push(s), waitRam: async () => {},
    scopeOps: { ...NO_SCOPE, orphans: () => ['heavy-1-dead.scope'], stop: () => false },
    acquire: async () => ({ release() {}, waitedMs: 0 }), run: async () => { ran = true; return 0; } });
  assert.equal(ran, false);
  assert.equal(code, 75);
  assert.ok(logs.some((l) => /không dừng được build mồ côi/.test(l)));
});

test('post-merge: Ctrl-C during the pre-build gradlew --stop cancels the build', async () => {
  let ran = false;
  const code = await heavyMain(['--', './gradlew', 'build'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {},
    scopeOps: { ...NO_SCOPE, preflight: () => ({ ok: true }) },
    acquire: async () => ({ release() {}, waitedMs: 0 }),
    stopGradle: async () => { process.emit('SIGINT', 'SIGINT'); return 130; },
    run: async () => { ran = true; return 0; } });
  assert.equal(ran, false);
  assert.equal(code, 130);
});
