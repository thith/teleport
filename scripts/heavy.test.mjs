// RFC 18 C (shared cargo target dir) + F (RAM wait) in heavy.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseHeavyArgs, resolveCargoTarget, sharedTargetDir, gitCommonDir, hasCargoClean,
  waitForRam, minFreeBytes, readMemAvailable, main as heavyMain,
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

test('parse: --own-target / --no-ram-wait (defaults off/on), mixed with old flags', () => {
  assert.deepEqual(parseHeavyArgs(['--', 'a']), { cmd: ['a'], stop: true, waitSec: Infinity, ownTarget: false, ramWait: true });
  assert.deepEqual(parseHeavyArgs(['--own-target', '--no-stop', '--no-ram-wait', '--wait', '1', '--', 'cargo', '--own-target']),
    { cmd: ['cargo', '--own-target'], stop: false, waitSec: 60, ownTarget: true, ramWait: false });
});

test('C: every worktree (and subdir) of one repo → the same <repo>-<hash6> dir under ~/.cache/teleport/cargo-target', () => {
  const { repo, wt } = repoWithWorktree();
  const home = '/h';
  const a = resolveCargoTarget({ env: {}, cwd: repo, home });
  const b = resolveCargoTarget({ env: {}, cwd: wt, home });
  const c = resolveCargoTarget({ env: {}, cwd: path.join(wt, 'sub'), home });
  assert.match(a, /^\/h\/\.cache\/teleport\/cargo-target\/myrepo-[0-9a-f]{6}$/);
  assert.equal(b, a);
  assert.equal(c, a);
  assert.equal(gitCommonDir(wt), path.join(repo, '.git'));
  // same basename, different repo → different hash
  assert.notEqual(sharedTargetDir('/x/myrepo/.git', home), sharedTargetDir('/y/myrepo/.git', home));
});

test('C: inherited CARGO_TARGET_DIR respected; --own-target; outside git → unset', () => {
  const { repo } = repoWithWorktree();
  assert.equal(resolveCargoTarget({ env: { CARGO_TARGET_DIR: '/mine' }, cwd: repo }), null);
  assert.equal(resolveCargoTarget({ env: {}, ownTarget: true, cwd: repo }), null);
  const out = tmp('tp-heavy-nogit-');
  assert.equal(gitCommonDir(out), null, 'tmpdir is not inside a git repo');
  assert.equal(resolveCargoTarget({ env: {}, cwd: out }), null);
  assert.equal(resolveCargoTarget({ env: {}, cwd: out, commonDir: () => null }), null);
});

test('C: main passes CARGO_TARGET_DIR to the command (and gradlew --stop), says so; cargo clean warns but still runs', async () => {
  const go = async (argv, env = {}, target = '/t/repo-abc123') => {
    const logs = [], envs = [];
    const rc = await heavyMain(argv, {
      env, log: (s) => logs.push(s), nested: () => false, waitRam: async () => {},
      cargoTarget: ({ env: e, ownTarget }) => (e.CARGO_TARGET_DIR || ownTarget ? null : target),
      acquire: async () => ({ release() {}, waitedMs: 0 }),
      run: async (cmd, o) => { envs.push(o.env.CARGO_TARGET_DIR); return 0; },
      stopGradle: async (cmd, o) => { envs.push(`stop ${o.env.CARGO_TARGET_DIR}`); },
    });
    return { rc, logs: logs.join('\n'), envs };
  };
  let r = await go(['--', './gradlew', 'build']);
  assert.deepEqual(r.envs, ['/t/repo-abc123', 'stop /t/repo-abc123']);
  assert.match(r.logs, /ℹ️ CARGO_TARGET_DIR=\/t\/repo-abc123 \(dùng chung giữa các worktree; --own-target để tắt\)/);
  r = await go(['--own-target', '--', 'cargo', 'build']);
  assert.deepEqual(r.envs, [undefined]);
  assert.doesNotMatch(r.logs, /CARGO_TARGET_DIR/);
  r = await go(['--', 'cargo', 'build'], { CARGO_TARGET_DIR: '/mine' });
  assert.deepEqual(r.envs, ['/mine']);
  assert.doesNotMatch(r.logs, /ℹ️/);
  r = await go(['--', 'cargo', 'clean']);
  assert.equal(r.rc, 0);
  assert.deepEqual(r.envs, ['/t/repo-abc123'], 'still runs');
  assert.match(r.logs, /cargo clean.*DÙNG CHUNG/);
  r = await go(['--', 'cargo', 'build']);
  assert.doesNotMatch(r.logs, /cargo clean/);
});

test('C: hasCargoClean — token `clean` right after a token named cargo (also inside sh -c)', () => {
  assert.equal(hasCargoClean(['cargo', 'clean']), true);
  assert.equal(hasCargoClean(['/home/u/.cargo/bin/cargo', 'clean', '-p', 'x']), true);
  assert.equal(hasCargoClean(['sh', '-c', 'cd a && cargo clean && cargo build']), true);
  assert.equal(hasCargoClean(['cargo', 'build', 'clean']), false);
  assert.equal(hasCargoClean(['make', 'clean']), false);
  assert.equal(hasCargoClean(['cargo-clean']), false);
});

test('C: real process — inside a repo the command sees the shared dir; outside git it does not', { skip: spawnSync('git', ['--version']).status !== 0 }, async () => {
  const { wt } = repoWithWorktree();
  const lockDir = tmp('tp-heavy-lock-');
  const home = tmp('tp-heavy-home-');
  const runIn = (cwd) => new Promise((resolve) => {
    const env = { ...process.env, TELEPORT_LOCK_DIR: lockDir, TELEPORT_HEAVY_MIN_FREE_MB: '0', HOME: home, GIT_CEILING_DIRECTORIES: path.dirname(cwd) };
    delete env.TELEPORT_HEAVY_HELD; delete env.CARGO_TARGET_DIR;
    const c = spawn(process.execPath, [HEAVY, '--', 'sh', '-c', 'echo "T=${CARGO_TARGET_DIR:-none}"'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
  const r = await runIn(wt);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`T=${home}/\\.cache/teleport/cargo-target/myrepo-[0-9a-f]{6}`));
  assert.match(r.err, /ℹ️ CARGO_TARGET_DIR=/);
  const r2 = await runIn(fs.realpathSync(tmp('tp-heavy-nogit-')));
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /T=none/);
});

// ── F ──

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
  const f = fake([1, 1.2, 1.2, 1.1]); // best 1.2 at t=10 s, never beaten
  const r = await waitForRam({ minBytes: 3 * GiB, ...f });
  assert.equal(r.reason, 'plateau');
  assert.equal(r.waitedMs, RAM_POLL_MS + RAM_PLATEAU_MS);
  assert.match(f.logs.at(-1), /không tăng trong 2 phút/);
  assert.equal(f.logs.filter((l) => l.startsWith('⏳')).length, 3, 'one ⏳ per minute (t=0, 60, 120 s)');
});

test('F: slowly rising RAM is capped at 15 min total', async () => {
  let v = 0.5;
  const f = fake([]);
  f.readMem = () => (v += 0.001) * GiB; // always rising, never enough
  const r = await waitForRam({ minBytes: 3 * GiB, ...f });
  assert.equal(r.reason, 'cap');
  assert.equal(r.waitedMs, RAM_CAP_MS);
  assert.match(f.logs.at(-1), /đã chờ RAM 15 phút/);
});

test('F: main waits BEFORE acquiring the lock; skipped when nested or --no-ram-wait; threshold from env', async () => {
  const go = async (argv, { nested = false, env = {} } = {}) => {
    const ev = [];
    await heavyMain(argv, {
      env, nested: () => nested, log: () => {}, cargoTarget: () => null,
      waitRam: async ({ minBytes }) => { ev.push(`ram ${minBytes / 1024 / 1024}`); },
      acquire: async () => { ev.push('acquire'); return { release() { ev.push('release'); }, waitedMs: 0 }; },
      run: async () => { ev.push('run'); return 0; },
    });
    return ev;
  };
  assert.deepEqual(await go(['--', 'x']), ['ram 3072', 'acquire', 'run', 'release']);
  assert.deepEqual(await go(['--', 'x'], { env: { TELEPORT_HEAVY_MIN_FREE_MB: '512' } }), ['ram 512', 'acquire', 'run', 'release']);
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
