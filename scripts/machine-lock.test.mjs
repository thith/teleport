import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, lockPaths, describeHolder, readHolder } from './machine-lock.mjs';
import { parseHeavyArgs, isGradlew, heldByAncestor, main as heavyMain } from './heavy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEAVY = path.join(HERE, 'heavy.mjs');
const MERGE = path.join(HERE, 'merge.mjs');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-lock-'));
/** Probe from ANOTHER process: 'free' | 'busy'. */
const probe = (dir, name = 'build') => (spawnSync('flock', ['-n', '-E', '75', lockPaths(name, dir).lock, 'true']).status === 0 ? 'free' : 'busy');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(50); } };
// 'exit', not 'close': a leftover background process may hold our stdout pipe open.
const exitOf = (child) => new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
// Without TELEPORT_HEAVY_HELD, even if this suite itself runs under heavy.
// TELEPORT_HEAVY_MIN_FREE_MB=0: never wait for RAM (RFC 18 F) on a busy test box.
const cleanEnv = (extra) => { const e = { ...process.env, TELEPORT_HEAVY_MIN_FREE_MB: '0', ...extra }; delete e.TELEPORT_HEAVY_HELD; return e; };
// --own-target: lock tests don't care about target dirs (and the ℹ️ line would be the first stderr chunk).
const heavy = (dir, args, extra = {}) => spawn(process.execPath, [HEAVY, '--own-target', ...args], { env: cleanEnv({ TELEPORT_LOCK_DIR: dir }), stdio: ['ignore', 'pipe', 'pipe'], ...extra });

test('lock names: only ^[a-z][a-z0-9-]{0,31}$ (no paths)', () => {
  assert.throws(() => lockPaths('../x'), /bad lock name/);
  assert.throws(() => lockPaths('Build'), /bad lock name/);
  assert.ok(lockPaths('build', '/d').lock.endsWith('/d/build.lock'));
});

test('acquire: held while alive (other process sees busy), free after release; holder shown, removed; lock file kept; dir 0700', async () => {
  const dir = path.join(tmpDir(), 'locks');
  const l = await acquireLock('build', { dir, label: 'A', cmd: './gradlew x' });
  assert.equal(probe(dir), 'busy');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const h = readHolder(lockPaths('build', dir).holder);
  assert.equal(h.label, 'A'); assert.equal(h.alive, true);
  assert.match(describeHolder(h), /^A — \.\/gradlew x — từ \d\d:\d\d \(0 phút\)$/);
  // a second open file description (same process) is a separate contender
  const waits = [];
  const t = await acquireLock('build', { dir, waitSec: 0.3, pollMs: 50, onWait: (x) => waits.push(x) });
  assert.equal(t.timeout, true); assert.equal(t.holder.label, 'A'); assert.equal(waits.length, 1, 'notice once (same holder, < noticeMs)');
  l.release(); l.release();
  assert.equal(probe(dir), 'free');
  assert.equal(fs.existsSync(lockPaths('build', dir).holder), false);
  assert.equal(fs.existsSync(lockPaths('build', dir).lock), true, 'never unlinked');
  assert.equal(describeHolder(null), '(chưa rõ ai giữ)');
  assert.match(describeHolder({ alive: false }), /đã chết/);
});

test('waiter gets the lock as soon as the holder releases', async () => {
  const dir = tmpDir();
  const a = await acquireLock('merge', { dir });
  setTimeout(() => a.release(), 300);
  const b = await acquireLock('merge', { dir, pollMs: 50, waitSec: 5 });
  assert.ok(!b.timeout && b.waitedMs >= 200, JSON.stringify(b.waitedMs));
  b.release();
});

test('holder SIGKILLed → lock free at once (kernel releases; no TTL)', async () => {
  const dir = tmpDir();
  const code = `import('${path.join(HERE, 'machine-lock.mjs')}').then(async (m) => { await m.acquireLock('build', { dir: ${JSON.stringify(dir)} }); console.log('held'); setInterval(() => {}, 1e6); });`;
  const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => c.stdout.once('data', r));
  assert.equal(probe(dir), 'busy');
  c.kill('SIGKILL'); await exitOf(c);
  assert.equal(probe(dir), 'free');
});

test('heavy: exit code passthrough (3 → 3, 75 → 75, not "busy"); lock free afterwards', async () => {
  const dir = tmpDir();
  assert.equal((await exitOf(heavy(dir, ['--', 'sh', '-c', 'exit 3']))).code, 3);
  assert.equal((await exitOf(heavy(dir, ['--', 'sh', '-c', 'exit 75']))).code, 75);
  assert.equal(probe(dir), 'free');
});

test('heavy: a background process the command leaves behind does NOT keep the lock', async () => {
  const dir = tmpDir();
  const pidFile = path.join(dir, 'orphan.pid');
  const r = await exitOf(heavy(dir, ['--', 'sh', '-c', `sleep 30 & echo $! > ${pidFile}; exit 0`]));
  assert.equal(r.code, 0);
  const orphan = Number(fs.readFileSync(pidFile, 'utf8'));
  try { assert.equal(probe(dir), 'free'); } finally { try { process.kill(orphan, 'SIGKILL'); } catch {} }
});

test('heavy: two concurrent runs serialize; the second says who it waits for', async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'log');
  const job = (tag) => ['--', 'sh', '-c', `echo ${tag}-start >> ${log}; sleep 1; echo ${tag}-end >> ${log}`];
  const a = heavy(dir, job('a'));
  await until(() => fs.existsSync(log));
  const b = heavy(dir, job('b'));
  let errB = ''; b.stderr.on('data', (d) => { errB += d; });
  await Promise.all([exitOf(a), exitOf(b)]);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['a-start', 'a-end', 'b-start', 'b-end']);
  assert.match(errB, /⏳ build đang bận: .* — sh -c echo a-start/);
});

test('heavy: --wait timeout → exit 75 and the command never runs', async () => {
  const dir = tmpDir();
  const l = await acquireLock('build', { dir, label: 'Ma' });
  const marker = path.join(dir, 'ran');
  const c = heavy(dir, ['--wait', '0.02', '--', 'touch', marker]); // 1.2 s
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  assert.equal((await exitOf(c)).code, 75);
  l.release();
  assert.equal(fs.existsSync(marker), false);
  assert.match(err, /chờ quá .* build vẫn bận: Ma/);
});

test('heavy: SIGTERM is forwarded to the command group; we exit only after it is gone; lock free', async () => {
  const dir = tmpDir();
  const pidFile = path.join(dir, 'pid');
  const c = heavy(dir, ['--', 'sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`]);
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim());
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  c.kill('SIGTERM');
  const r = await exitOf(c);
  assert.equal(r.code, 128 + 15);
  assert.throws(() => process.kill(grandchild, 0), 'the whole group was signalled');
  assert.equal(probe(dir), 'free');
});

test('heavy: waiter killed while waiting leaves nothing behind (command never runs)', async () => {
  const dir = tmpDir();
  const l = await acquireLock('build', { dir });
  const marker = path.join(dir, 'ran');
  const c = heavy(dir, ['--', 'touch', marker]);
  // really waiting (⏳), not just started; exiting first means it never waited → the marker check fails
  await new Promise((r) => { let s = ''; c.stderr.on('data', (d) => { s += d; if (/⏳/.test(s)) r(); }); c.on('exit', r); });
  if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await exitOf(c); }
  l.release();
  await sleep(1500);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(probe(dir), 'free');
});

// no real systemd here: scope preflight "fails" → the pre-RFC-20 path
const NO_SCOPE = { preflight: () => ({ ok: false, why: 'test' }), stop: () => true, orphans: () => [], oomKills: () => null, jobsConfigured: () => true, memTotal: 16 * 1024 ** 3 };

test('heavy args + gradlew --stop policy (after success AND failure, not with --no-stop, not for non-gradle)', async () => {
  assert.match(parseHeavyArgs(['./gradlew']).error, /usage/);
  assert.match(parseHeavyArgs(['--']).error, /usage/);
  assert.match(parseHeavyArgs(['--wait', 'x', '--', 'a']).error, /minutes/);
  assert.match(parseHeavyArgs(['--bogus', '--', 'a']).error, /unexpected/);
  assert.deepEqual(parseHeavyArgs(['--no-stop', '--wait', '2', '--', 'a', '--b']), { cmd: ['a', '--b'], stop: false, scope: false, waitSec: 120, ramWait: true });
  assert.equal(isGradlew(['./gradlew', 'build']), true);
  assert.equal(isGradlew(['/x/android/gradlew']), true);
  assert.equal(isGradlew(['cargo', 'build']), false);
  const run = async (argv, code) => {
    const ev = [];
    const lock = { release() { ev.push('release'); }, waitedMs: 0 };
    const rc = await heavyMain(argv, { env: {}, waitRam: async () => {}, nested: () => false, scopeOps: NO_SCOPE, acquire: async () => lock, run: async () => { ev.push('run'); return code; }, stopGradle: async (c) => { ev.push(`stop ${c[0]}`); }, log: () => {} });
    return { rc, ev };
  };
  // --stop runs while the lock is still held (the reason it can't hit another build's daemon)
  assert.deepEqual(await run(['--', './gradlew', 'build'], 0), { rc: 0, ev: ['run', 'stop ./gradlew', 'release'] });
  assert.deepEqual(await run(['--', './gradlew', 'build'], 1), { rc: 1, ev: ['run', 'stop ./gradlew', 'release'] });
  assert.deepEqual(await run(['--', './gradlew', 'build'], 127), { rc: 127, ev: ['run', 'release'] }, 'never started → no --stop');
  assert.deepEqual(await run(['--no-stop', '--', './gradlew', 'build'], 0), { rc: 0, ev: ['run', 'release'] });
  assert.deepEqual(await run(['--', 'cargo', 'build'], 0), { rc: 0, ev: ['run', 'release'] });
  // nested heavy (ancestor already holds the build lock) → no acquire at all
  let acquired = false;
  assert.equal(await heavyMain(['--', 'x'], { env: {}, waitRam: async () => {}, nested: () => true, acquire: async () => { acquired = true; }, run: async () => 0, log: () => {} }), 0);
  assert.equal(acquired, false);
  // the env token only counts while it names the live holder of record
  const H = (h) => () => h;
  assert.equal(heldByAncestor({ TELEPORT_HEAVY_HELD: '42' }, H({ pid: 42, alive: true })), true);
  assert.equal(heldByAncestor({ TELEPORT_HEAVY_HELD: '42' }, H({ pid: 43, alive: true })), false, 'someone else holds it now');
  assert.equal(heldByAncestor({ TELEPORT_HEAVY_HELD: '42' }, H({ pid: 42, alive: false })), false);
  assert.equal(heldByAncestor({ TELEPORT_HEAVY_HELD: '42' }, H(null)), false);
  assert.equal(heldByAncestor({ TELEPORT_HEAVY_HELD: 'build' }, H({ pid: 42, alive: true })), false);
  assert.equal(heldByAncestor({}, H({ pid: 42, alive: true })), false);
  // flock unavailable → runs anyway (fail-open), loudly
  const logs = [];
  assert.equal(await heavyMain(['--', 'x'], { env: {}, waitRam: async () => {}, acquire: async () => { throw new Error('spawn flock ENOENT'); }, nested: () => false, scopeOps: NO_SCOPE, run: async () => 0, log: (s) => logs.push(s) }), 0);
  assert.match(logs.join('\n'), /KHÔNG khoá/);
});

test('merge.mjs: a real merge waits for the merge lock and gives up with the holder; --preview never takes it', async () => {
  const dir = tmpDir();
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const called = path.join(dir, 'gh-called');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ntouch ${called}\necho "fake gh: offline" >&2\nexit 1\n`, { mode: 0o755 });
  const env = { ...process.env, TELEPORT_LOCK_DIR: dir, TELEPORT_MERGE_LOCK_WAIT_SEC: '1', PATH: `${bin}:${process.env.PATH}` };
  const l = await acquireLock('merge', { dir, label: 'Thi (daemon)', cmd: 'merge o/r#1' });
  try {
    const url = 'https://github.com/o/r/pull/7';
    const m = spawnSync(process.execPath, [MERGE, url], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(m.status, 1);
    assert.match(m.stdout, /đang có merge khác chạy quá 1s: Thi \(daemon\) — merge o\/r#1/);
    assert.match(m.stderr, /⏳ đang có merge khác chạy/);
    assert.equal(fs.existsSync(called), false, 'GitHub never touched before the lock is taken');
    const p = spawnSync(process.execPath, [MERGE, url, '--preview'], { env, encoding: 'utf8', timeout: 15000 });
    assert.doesNotMatch(p.stdout + p.stderr, /merge khác/, 'preview does not wait');
    assert.match(p.stdout, /cannot read PR/);
    assert.equal(fs.existsSync(called), true);
  } finally { l.release(); }
});

test('acquire: re-notices every noticeMs and when the holder changes', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, label: 'A' });
  const seen = [];
  const t = await acquireLock('build', { dir, waitSec: 0.5, pollMs: 40, noticeMs: 150, onWait: (h) => seen.push(h?.label) });
  assert.ok(t.timeout && seen.length >= 3 && seen.length <= 5, JSON.stringify(seen));
  seen.length = 0;
  const p = lockPaths('build', dir).holder;
  setTimeout(() => fs.writeFileSync(p, JSON.stringify({ pid: process.pid, label: 'B', startedAt: Date.now() })), 150);
  await acquireLock('build', { dir, waitSec: 0.4, pollMs: 40, noticeMs: 60000, onWait: (h) => seen.push(h?.label) });
  assert.deepEqual(seen, ['A', 'B']);
  a.release();
});

test('acquire: no flock binary → rejects (heavy runs unlocked, merge refuses) instead of waiting forever', () => {
  const dir = tmpDir();
  const code = `import('${path.join(HERE, 'machine-lock.mjs')}').then((m) => m.acquireLock('build', { dir: ${JSON.stringify(dir)}, waitSec: 2 })).then((r) => console.log('resolved', JSON.stringify(r)), (e) => console.log('rejected', e.code || e.message))`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, PATH: '/nonexistent' }, encoding: 'utf8', timeout: 10000 });
  assert.match(r.stdout, /rejected ENOENT/);
});

test('heavy: wrapper SIGKILLed → the build dies too (setpriv --pdeathsig); lock free', { skip: spawnSync('setpriv', ['--version']).status !== 0 }, async () => {
  const dir = tmpDir();
  const c = heavy(dir, ['--', 'sleep', '30']);
  await until(() => fs.existsSync(lockPaths('build', dir).holder));
  await sleep(200);
  const kids = spawnSync('pgrep', ['-P', String(c.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number);
  assert.equal(kids.length, 1);
  c.kill('SIGKILL'); await exitOf(c);
  await until(() => { try { process.kill(kids[0], 0); return false; } catch { return true; } }, 3000);
  assert.equal(probe(dir), 'free');
});

test('heavy: nested heavy inside a heavy command runs at once (no self-deadlock)', async () => {
  const dir = tmpDir();
  const marker = path.join(dir, 'inner-ran');
  const c = heavy(dir, ['--', process.execPath, HEAVY, '--wait', '0.05', '--', 'touch', marker]);
  assert.equal((await exitOf(c)).code, 0);
  assert.equal(fs.existsSync(marker), true);
});

test('heavy: a leftover of a finished build (inherited env) does NOT skip the lock while someone else holds it', async () => {
  const dir = tmpDir();
  const marker = path.join(dir, 'ran');
  // the outer heavy is long gone (pid of this test's dead child), another holder took the lock
  const dead = spawnSync('true').pid;
  const other = await acquireLock('build', { dir, label: 'OTHER' });
  const c = spawn(process.execPath, [HEAVY, '--wait', '0.03', '--', 'touch', marker], { env: { ...cleanEnv({ TELEPORT_LOCK_DIR: dir }), TELEPORT_HEAVY_HELD: String(dead) }, stdio: 'ignore' });
  assert.equal((await exitOf(c)).code, 75, 'waited, then gave up');
  other.release();
  assert.equal(fs.existsSync(marker), false);
});
