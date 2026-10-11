import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, lockPaths, describeHolder, readHolder } from './machine-lock.mjs';
import { parseHeavyArgs, isGradlew, main as heavyMain } from './heavy.mjs';

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
const heavy = (dir, args, extra = {}) => spawn(process.execPath, [HEAVY, ...args], { env: { ...process.env, TELEPORT_LOCK_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], ...extra });

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
  await new Promise((r) => c.stderr.once('data', r)); // the ⏳ notice
  c.kill('SIGKILL'); await exitOf(c);
  l.release();
  await sleep(1500);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(probe(dir), 'free');
});

test('heavy args + gradlew --stop policy (after success AND failure, not with --no-stop, not for non-gradle)', async () => {
  assert.match(parseHeavyArgs(['./gradlew']).error, /usage/);
  assert.match(parseHeavyArgs(['--']).error, /usage/);
  assert.match(parseHeavyArgs(['--wait', 'x', '--', 'a']).error, /minutes/);
  assert.match(parseHeavyArgs(['--bogus', '--', 'a']).error, /unexpected/);
  assert.deepEqual(parseHeavyArgs(['--no-stop', '--wait', '2', '--', 'a', '--b']), { cmd: ['a', '--b'], stop: false, waitSec: 120 });
  assert.equal(isGradlew(['./gradlew', 'build']), true);
  assert.equal(isGradlew(['/x/android/gradlew']), true);
  assert.equal(isGradlew(['cargo', 'build']), false);
  const lock = { release() {}, waitedMs: 0 };
  const run = async (argv, code) => {
    const stops = [];
    const rc = await heavyMain(argv, { acquire: async () => lock, run: async () => code, stopGradle: (c) => stops.push(c[0]), log: () => {} });
    return { rc, stops };
  };
  assert.deepEqual(await run(['--', './gradlew', 'build'], 0), { rc: 0, stops: ['./gradlew'] });
  assert.deepEqual(await run(['--', './gradlew', 'build'], 1), { rc: 1, stops: ['./gradlew'] });
  assert.deepEqual(await run(['--no-stop', '--', './gradlew', 'build'], 0), { rc: 0, stops: [] });
  assert.deepEqual(await run(['--', 'cargo', 'build'], 0), { rc: 0, stops: [] });
  // flock unavailable → runs anyway (fail-open), loudly
  const logs = [];
  assert.equal(await heavyMain(['--', 'x'], { acquire: async () => { throw new Error('spawn flock ENOENT'); }, run: async () => 0, log: (s) => logs.push(s) }), 0);
  assert.match(logs.join('\n'), /KHÔNG khoá/);
});

test('merge.mjs: a real merge waits for the merge lock and gives up with the holder; --preview never takes it', async () => {
  const dir = tmpDir();
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "fake gh: offline" >&2\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, TELEPORT_LOCK_DIR: dir, TELEPORT_MERGE_LOCK_WAIT_SEC: '1', PATH: `${bin}:${process.env.PATH}` };
  const l = await acquireLock('merge', { dir, label: 'Thi (daemon)', cmd: 'merge o/r#1' });
  try {
    const url = 'https://github.com/o/r/pull/7';
    const m = spawnSync(process.execPath, [MERGE, url], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(m.status, 1);
    assert.match(m.stdout, /đang có merge khác chạy quá 1s: Thi \(daemon\) — merge o\/r#1/);
    assert.match(m.stderr, /⏳ đang có merge khác chạy/);
    const p = spawnSync(process.execPath, [MERGE, url, '--preview'], { env, encoding: 'utf8', timeout: 15000 });
    assert.doesNotMatch(p.stdout + p.stderr, /merge khác/, 'preview does not wait');
    assert.match(p.stdout, /cannot read PR/);
  } finally { l.release(); }
});
