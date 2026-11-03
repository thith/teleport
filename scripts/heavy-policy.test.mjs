// RFC 29 — heavy.mjs: early policy check, exit codes 76/78/79, messages, lock dir plumbing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main as heavyMain, earlyPolicyCheck, refusalExit, QUEUE_FULL_EXIT, BLOCKED_EXIT, LEFT_QUEUE_EXIT } from './heavy.mjs';
import { defaultPolicy, writePolicy } from './build-policy.mjs';
import { acquireLock, lockPaths, acquireHelperLock } from './machine-lock.mjs';

const GiB = 1024 ** 3;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-hpol-'));
const setPolicy = (dir, patch) => writePolicy(dir, { ...defaultPolicy(), ...patch });
const rawPolicy = (dir, patch) => fs.writeFileSync(path.join(dir, 'build.policy.json'), JSON.stringify({ ...defaultPolicy(), ...patch }));
const OPS = { preflight: () => ({ ok: true }), stop: () => true, orphans: () => [], oomKills: () => null, jobsConfigured: () => true, memTotal: 32 * GiB,
  holders: () => [], sweepLock: async () => () => {}, slotTurn: async () => ({ alone: true }), selfOwner: () => 'convo:ME' };
const T = (name, status = 'live') => ({ name, status });

test('exit codes: 76 left/kicked, 77 stopped, 78 full/busy, 79 blocked', () => {
  assert.equal(LEFT_QUEUE_EXIT, 76); assert.equal(QUEUE_FULL_EXIT, 78); assert.equal(BLOCKED_EXIT, 79);
});

test('earlyPolicyCheck: blocked → 79 data; at max → full; the "build now" exception; paused; corrupt/none → pass', () => {
  const dir = tmpDir();
  const o = { dir, owner: 'convo:ME', now: 1000, holders: [], queue: [], slots: 1 };
  assert.equal(earlyPolicyCheck(o), null, 'no policy file');
  rawPolicy(dir, { blocks: [{ owner: 'convo:ME', label: 'me', until: 5000, at: 1 }] });
  assert.deepEqual(earlyPolicyCheck(o), { refused: 'blocked', until: 5000 });
  assert.equal(earlyPolicyCheck({ ...o, owner: 'convo:OTHER' }), null);
  setPolicy(dir, { max: 2, retryMin: 9 });
  assert.equal(earlyPolicyCheck({ ...o, queue: [T('1')] }), null, 'below max');
  assert.deepEqual(earlyPolicyCheck({ ...o, queue: [T('1'), T('2', 'stalled')] }), { refused: 'full', max: 2, retryMin: 9 }, 'stalled counts');
  assert.equal(earlyPolicyCheck({ ...o, queue: [T('1'), T('2', 'dead')] }), null, 'dead does not');
  setPolicy(dir, { max: 0 });
  assert.equal(earlyPolicyCheck({ ...o, holders: [], queue: [] }), null, 'max 0 + free slot + nobody waiting: build now');
  assert.equal(earlyPolicyCheck({ ...o, holders: [{ pid: 1 }], queue: [] })?.refused, 'full', 'max 0 and the slot is taken');
  assert.equal(earlyPolicyCheck({ ...o, holders: [], queue: [T('1')] })?.refused, 'full', 'max 0 and somebody waits');
  setPolicy(dir, { max: 0, paused: true });
  assert.equal(earlyPolicyCheck({ ...o, holders: [], queue: [] })?.refused, 'full', 'paused: no exception');
  fs.writeFileSync(path.join(dir, 'build.policy.json'), 'garbage');
  assert.equal(earlyPolicyCheck(o), null, 'corrupt = no restriction');
});

test('refusalExit: messages + codes', () => {
  const logs = [];
  const log = (s) => logs.push(s);
  assert.equal(refusalExit({ refused: 'full', max: 4, retryMin: 10 }, log), 78);
  assert.equal(logs.at(-1), '⛔ Hàng build đã đủ 4 vé chờ. Thử lại sau 10 phút; trong lúc đó làm việc khác.');
  const until = new Date(2026, 10, 3, 15, 30).getTime();
  assert.equal(refusalExit({ refused: 'blocked', until }, log), 79);
  assert.equal(logs.at(-1), '⛔ Owner chặn bạn khỏi hàng build tới 15:30. Đừng thử lại trước giờ đó.');
  assert.equal(refusalExit({ refused: 'busy' }, log), 78);
  assert.match(logs.at(-1), /hàng build đang bận cập nhật — thử lại sau 1 phút/);
});

test('main: the early check runs BEFORE the RAM wait and before acquire (78 full / 79 blocked)', async () => {
  const dir = tmpDir();
  const calls = [];
  const logs = [];
  const mk = (extra = {}) => ({ env: {}, nested: () => false, log: (s) => logs.push(s), waitRam: async () => { calls.push('ram'); }, acquire: async () => { calls.push('acquire'); return { release() {}, waitedMs: 0 }; }, run: async () => 0, stopGradle: async () => 0, scopeOps: { ...OPS, lockDir: dir }, ...extra });
  setPolicy(dir, { blocks: [{ owner: 'convo:ME', label: 'me', until: Date.now() + 3600_000, at: 1 }] });
  assert.equal(await heavyMain(['--', 'true'], mk()), 79);
  assert.deepEqual(calls, [], 'neither the RAM wait nor the queue was touched');
  assert.match(logs.at(-1), /Owner chặn bạn khỏi hàng build tới \d\d:\d\d/);
  setPolicy(dir, { max: 1 });
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  fs.writeFileSync(path.join(q, `${String(Date.now()).padStart(15, '0')}-${process.pid}-aaaaaa.json`), JSON.stringify({ pid: process.pid, procStart: null, label: 'w', createdAt: Date.now(), v: 29, owner: 'convo:W' }));
  assert.equal(await heavyMain(['--', 'true'], mk()), 78);
  assert.deepEqual(calls, []);
  assert.match(logs.at(-1), /Hàng build đã đủ 1 vé chờ/);
});

test('main: max 0 + free slot + nobody waiting is NOT stopped by the early check ("build now")', async () => {
  const dir = tmpDir();
  setPolicy(dir, { max: 0 });
  let acquired = null;
  const code = await heavyMain(['--', 'true'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async (n, o) => { acquired = o; return { release() {}, waitedMs: 0 }; }, run: async () => 0, stopGradle: async () => 0, scopeOps: { ...OPS, lockDir: dir } });
  assert.equal(code, 0);
  assert.equal(acquired.policy, true, 'heavy asks for the policy check');
  assert.equal(acquired.dir, dir, 'the resolved lock dir is passed on');
});

test('main: lock dir = scopeOps.lockDir || env.TELEPORT_LOCK_DIR; an injected acquire without either never reads the real policy', async () => {
  const dir = tmpDir();
  setPolicy(dir, { max: 0, paused: true });
  const base = { nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => ({ release() {}, waitedMs: 0 }), run: async () => 0, stopGradle: async () => 0 };
  assert.equal(await heavyMain(['--', 'true'], { ...base, env: { TELEPORT_LOCK_DIR: dir }, scopeOps: OPS }), 78, 'env var dir is honoured');
  assert.equal(await heavyMain(['--', 'true'], { ...base, env: {}, scopeOps: OPS }), 0, 'no dir given + mocked acquire: policy not consulted');
});

test('main: nested heavy skips the early check and the queue', async () => {
  const dir = tmpDir();
  setPolicy(dir, { blocks: [{ owner: 'convo:ME', label: 'me', until: Date.now() + 3600_000, at: 1 }], max: 0, paused: true });
  let acquired = false;
  const code = await heavyMain(['--', 'true'], { env: {}, nested: () => true, log: () => {}, waitRam: async () => {}, acquire: async () => { acquired = true; return {}; }, run: async () => 0, stopGradle: async () => 0, scopeOps: { ...OPS, lockDir: dir } });
  assert.equal(code, 0);
  assert.equal(acquired, false);
});

test('main: acquireLock refusals map to exit codes (before `timeout`); kicked → 76 with the owner message; plain leave → 76', async () => {
  const logs = [];
  const run = (res) => heavyMain(['--', 'true'], { env: {}, nested: () => false, log: (s) => logs.push(s), waitRam: async () => {}, acquire: async () => res, run: async () => { throw new Error('must not run'); }, scopeOps: OPS });
  assert.equal(await run({ refused: 'full', max: 3, retryMin: 5, timeout: true }), 78);
  assert.equal(await run({ refused: 'blocked', until: Date.now() + 60_000 }), 79);
  assert.equal(await run({ refused: 'busy' }), 78);
  assert.equal(await run({ timeout: true, left: true, kicked: true, holder: null }), 76);
  assert.equal(logs.at(-1), '⛔ Owner đã kick vé này khỏi hàng build. Đừng xếp lại ngay; hỏi owner nếu cần.');
  assert.equal(await run({ timeout: true, left: true, holder: null }), 76);
  assert.match(logs.at(-1), /đã rời hàng đợi/);
});

test('main: no flock binary → runs unlocked and says LOUDLY that the queue AND the policy are not applied; other lock errors → no run', async () => {
  const logs = [];
  let ran = false;
  const noFlock = Object.assign(new Error('spawn flock ENOENT'), { code: 'ENOENT', syscall: 'spawn flock', path: 'flock' });
  const code = await heavyMain(['--', 'true'], { env: {}, nested: () => false, log: (s) => logs.push(s), waitRam: async () => {}, acquire: async () => { throw noFlock; }, run: async () => { ran = true; return 0; }, stopGradle: async () => 0, scopeOps: OPS });
  assert.equal(code, 0); assert.equal(ran, true);
  assert.ok(logs.some((l) => /KHÔNG khoá/.test(l) && /policy/.test(l) && /max hàng chờ/.test(l)));
  ran = false; logs.length = 0;
  const other = await heavyMain(['--', 'true'], { env: {}, nested: () => false, log: (s) => logs.push(s), waitRam: async () => {}, acquire: async () => { throw new Error('flock exited 66'); }, run: async () => { ran = true; return 0; }, scopeOps: OPS });
  assert.equal(other, 1); assert.equal(ran, false);
});

test('main + the REAL acquireLock: blocked → 79; policy lock unavailable → refused busy → 78 (never fail-open); free dir → runs', async () => {
  const dir = tmpDir();
  const logs = [];
  const viaLock = (extra = {}) => (n, o) => acquireLock(n, { ...o, convoId: 'ME', slots: 1, ...extra });
  const mk = (acq, lockDir, owner = 'convo:NOBODY') => ({ env: {}, nested: () => false, log: (s) => logs.push(s), waitRam: async () => {}, acquire: acq, run: async () => 0, stopGradle: async () => 0, scopeOps: { ...OPS, lockDir, selfOwner: () => owner } });
  // (selfOwner differs from the real owner so the EARLY check passes and acquireLock's own check is what answers)
  setPolicy(dir, { blocks: [{ owner: 'convo:ME', label: 'me', until: Date.now() + 3600_000, at: 1 }] });
  assert.equal(await heavyMain(['--', 'true'], mk(viaLock(), dir)), 79);
  assert.match(logs.at(-1), /Owner chặn bạn/);
  const dir2 = tmpDir();
  setPolicy(dir2, { max: 5 });
  const rel = await acquireHelperLock('build.policy', { dir: dir2, waitMs: 1000 });
  assert.equal(await heavyMain(['--', 'true'], mk(viaLock({ policyWaitMs: 200 }), dir2)), 78);
  rel();
  assert.match(logs.at(-1), /đang bận cập nhật/);
  const dir3 = tmpDir();
  assert.equal(await heavyMain(['--', 'true'], mk(viaLock(), dir3)), 0, 'no policy: runs');
});
