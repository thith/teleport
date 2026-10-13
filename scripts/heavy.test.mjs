// heavy.mjs: arg parsing, never a shared cargo target (RFC 18 C removed), F (RAM wait).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseHeavyArgs,
  waitForRam, minFreeBytes, readMemAvailable, readMemState, memBlockers, swapLow, main as heavyMain,
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
  assert.deepEqual(parseHeavyArgs(['--', 'a']), { cmd: ['a'], stop: true, waitSec: Infinity, ramWait: true });
  assert.deepEqual(parseHeavyArgs(['--own-target', '--no-stop', '--no-ram-wait', '--wait', '1', '--', 'cargo', '--shared-target']),
    { cmd: ['cargo', '--shared-target'], stop: false, waitSec: 60, ramWait: false });
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

test('F: main waits BEFORE acquiring the lock; skipped when nested or --no-ram-wait; threshold from env', async () => {
  const go = async (argv, { nested = false, env = {} } = {}) => {
    const ev = [];
    await heavyMain(argv, {
      env, nested: () => nested, log: () => {},
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
