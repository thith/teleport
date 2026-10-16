// RFC 23 — two slots for the build lock: slot files, N, FIFO with slots,
// exclusive, heavy's per-slot env / RAM budget, display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, lockPaths, readHolders, readQueue, readClaimed, resolveBuildSlots, slotsFor, MAX_SLOTS, TWO_SLOT_MIN_RAM, acquireHelperLock } from './machine-lock.mjs';
import { slotEnv, slotBlockers, holderBefore, isUnbounded, waitForSlotTurn, heldByAncestor, describeBusy, main as heavyMain, SCOPE_MEM_FRACTION, SCOPE_MEM_FRACTION_SHARED } from './heavy.mjs';
import { formatQueue, leave, setSlots, pruneSkipLines, shortCmd, parseArgs } from './lock-queue.mjs';
import { notePruneSkip } from './cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GiB = 1024 ** 3;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-slots-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (dir, slot) => (spawnSync('flock', ['-n', '-E', '75', lockPaths('build', dir, slot).lock, 'true']).status === 0 ? 'free' : 'busy');
async function queuedFor(dir, label) { for (let i = 0; i < 200; i++) { if (readQueue('build', { dir }).some((t) => t.label === label)) return; await sleep(50); } throw new Error(`no ticket for ${label}`); }

// A child taking the build lock with `slots`; prints "got <label> <slot>", holds until killed or holdMs.
function child(dir, label, { slots = 2, holdMs = 60_000 } = {}) {
  const code = `
    import { acquireLock } from ${JSON.stringify(path.join(HERE, 'machine-lock.mjs'))};
    const l = await acquireLock('build', { dir: ${JSON.stringify(dir)}, label: ${JSON.stringify(label)}, pollMs: 50, convoId: null, slots: ${slots} });
    console.log('got ${label} ' + l.slot);
    await new Promise((r) => setTimeout(r, ${holdMs}));
    l.release();`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.done = new Promise((r) => p.on('close', r));
  return p;
}
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(50); } };

// ── N ──

test('resolveBuildSlots: RAM decides, build.slots only lowers, any doubt → 1, non-default dir → 1', () => {
  const d = '/x/locks';
  const opt = (o) => ({ defaultDir: d, read: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }, ...o });
  assert.equal(resolveBuildSlots(d, opt({ total: 16 * GiB })), 1);
  assert.equal(resolveBuildSlots(d, opt({ total: 32 * GiB })), 2);
  assert.equal(resolveBuildSlots(d, opt({ total: TWO_SLOT_MIN_RAM })), 2);
  assert.equal(resolveBuildSlots(d, opt({ total: 32 * GiB, read: () => '1\n' })), 1);
  assert.equal(resolveBuildSlots(d, opt({ total: 32 * GiB, read: () => 'garbage' })), 1, 'odd content → 1, never auto');
  assert.equal(resolveBuildSlots(d, opt({ total: 32 * GiB, read: () => '2' })), 1, 'the file never raises');
  assert.equal(resolveBuildSlots(d, opt({ total: 32 * GiB, read: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } })), 1, 'unreadable → 1');
  assert.equal(resolveBuildSlots('/tmp/test-locks', opt({ total: 32 * GiB })), 1, 'a test dir (TELEPORT_LOCK_DIR / dir) → 1');
});

test('slotsFor: only the build lock ever has 2 slots; clamped to 1..MAX', () => {
  assert.equal(slotsFor('merge', { slots: 2 }), 1);
  assert.equal(slotsFor('cleanup', { slots: 2 }), 1);
  assert.equal(slotsFor('build', { slots: 2 }), 2);
  assert.equal(slotsFor('build', { slots: 7 }), MAX_SLOTS);
  assert.equal(slotsFor('build', { slots: 0 }), 1);
  assert.equal(slotsFor('build', { slots: 'x' }), 1);
});

test('lockPaths: slot 0 keeps the old names, slot 1 is build.1.*, same queue; bad slot throws', () => {
  assert.match(lockPaths('build', '/d').lock, /\/build\.lock$/);
  assert.match(lockPaths('build', '/d', 1).lock, /\/build\.1\.lock$/);
  assert.match(lockPaths('build', '/d', 1).holder, /\/build\.1\.holder\.json$/);
  assert.equal(lockPaths('build', '/d', 1).queue, lockPaths('build', '/d').queue);
  assert.throws(() => lockPaths('build', '/d', 2), /bad lock slot/);
});

// ── slots in acquireLock ──

test('two holders get slots 0 and 1; a third try-once is busy; holders of both slots are read', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null });
  const b = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'B', convoId: null });
  assert.deepEqual([a.slot, b.slot], [0, 1]);
  assert.deepEqual([probe(dir, 0), probe(dir, 1)], ['busy', 'busy']);
  const c = await acquireLock('build', { dir, waitSec: 0, slots: 2, convoId: null });
  assert.equal(c.timeout, true);
  assert.deepEqual(c.holders.map((h) => h.label).sort(), ['A', 'B']);
  assert.equal(c.slots, 2);
  b.release();
  assert.equal(probe(dir, 1), 'free');
  assert.equal(fs.existsSync(lockPaths('build', dir, 1).holder), false, 'release removes its own slot holder');
  a.release();
});

test('N = 1 (default in a test dir): a second caller is busy even though slot 1 is free — old behaviour', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, waitSec: 0, convoId: null });
  assert.equal(a.slot, 0);
  assert.equal(a.slots, 1);
  assert.equal((await acquireLock('build', { dir, waitSec: 0, convoId: null })).timeout, true);
  a.release();
});

test('FIFO with 2 slots: A then B queue behind two holders; first freed slot → A, the next → B', async () => {
  const dir = tmpDir();
  const h0 = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'H0', convoId: null });
  const h1 = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'H1', convoId: null });
  const A = child(dir, 'A'); await queuedFor(dir, 'A');
  await sleep(5);
  const B = child(dir, 'B'); await queuedFor(dir, 'B');
  h1.release();
  await until(() => /got A 1/.test(A.out));
  await sleep(300);
  assert.equal(B.out, '', 'B (behind A) does not run yet');
  h0.release();
  await until(() => /got B 0/.test(B.out));
  A.kill(); B.kill(); await Promise.all([A.done, B.done]);
});

test('position 0 always tries flock, even if a stale holder file says the free slot is taken', async () => {
  const dir = tmpDir();
  const h0 = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'H0', convoId: null });
  // slot 1: holder file names a LIVE process (us) but nobody holds its flock
  fs.writeFileSync(lockPaths('build', dir, 1).holder, JSON.stringify({ pid: process.pid, label: 'ghost', startedAt: 1 }));
  const l = await acquireLock('build', { dir, waitSec: 5, pollMs: 50, slots: 2, label: 'me', convoId: null });
  assert.equal(l.slot, 1);
  l.release(); h0.release();
});

test('readClaimed names the ticket each .acq belongs to', () => {
  const dir = tmpDir();
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  fs.writeFileSync(path.join(q, '000000000000001-1-abc.acq'), JSON.stringify({ pid: process.pid }));
  assert.equal(readClaimed('build', { dir })[0].ticket, '000000000000001-1-abc.json');
});

test('exclusive: takes every slot file (even beyond N) or none; holder says exclusive; try-once only', async () => {
  const dir = tmpDir();
  const x = await acquireLock('build', { dir, waitSec: 0, exclusive: true, cmd: 'cleanup', convoId: null });
  assert.equal(x.slot, 0);
  assert.deepEqual([probe(dir, 0), probe(dir, 1)], ['busy', 'busy']);
  assert.equal(readHolders('build', { dir })[0].exclusive, true);
  assert.equal((await acquireLock('build', { dir, waitSec: 0, slots: 2, convoId: null })).timeout, true);
  x.release();
  assert.deepEqual([probe(dir, 0), probe(dir, 1)], ['free', 'free']);
  // a build still running in slot 1 while N is now 1: exclusive must still fail, and give slot 0 back
  const b = await acquireLock('build', { dir, waitSec: 0, slots: 2, convoId: null });
  const b1 = await acquireLock('build', { dir, waitSec: 0, slots: 2, convoId: null });
  b.release();
  assert.equal(b1.slot, 1);
  assert.equal((await acquireLock('build', { dir, waitSec: 0, exclusive: true, slots: 1, convoId: null })).timeout, true);
  assert.equal(probe(dir, 0), 'free', 'the slot it did get is given back');
  b1.release();
  await assert.rejects(acquireLock('build', { dir, waitSec: 5, exclusive: true }), /try-once/);
});

test('exclusive yields to a live waiter (no queue jumping)', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: null });
  const A = child(dir, 'A', { slots: 1 }); await queuedFor(dir, 'A');
  h.release();
  await until(() => /got A/.test(A.out));
  assert.equal((await acquireLock('build', { dir, waitSec: 0, exclusive: true, convoId: null })).timeout, true);
  A.kill(); await A.done;
});

test('pending + update(): the holder declares its cap later, atomically; undefined removes a field', async () => {
  const dir = tmpDir();
  const l = await acquireLock('build', { dir, waitSec: 0, slots: 2, pending: true, convoId: null });
  assert.equal(readHolders('build', { dir })[0].pending, true);
  l.update({ pending: undefined, memMax: 123 });
  const h = readHolders('build', { dir })[0];
  assert.equal(h.pending, undefined);
  assert.equal(h.memMax, 123);
  assert.equal(h.slots, 2);
  l.release();
  l.update({ memMax: 1 });
  assert.equal(fs.existsSync(lockPaths('build', dir).holder), false, 'no update after release');
});

test('acquireHelperLock: second taker waits, times out → null', async () => {
  const dir = tmpDir();
  const r = await acquireHelperLock('build.sweep', { dir, waitMs: 0 });
  assert.equal(typeof r, 'function');
  assert.equal(await acquireHelperLock('build.sweep', { dir, waitMs: 200, pollMs: 50 }), null);
  r();
  const r2 = await acquireHelperLock('build.sweep', { dir, waitMs: 200, pollMs: 50 });
  assert.equal(typeof r2, 'function');
  r2();
});

// ── heavy: per-slot env ──

test('slotEnv: slot 0 changes nothing; slot 1 → own registry + Kotlin in-process, last in GRADLE_OPTS, no dotted names', () => {
  assert.deepEqual(slotEnv({}, 0), {});
  const e = slotEnv({}, 1, { home: '/home/u' });
  assert.equal(e.GRADLE_OPTS, '-Dorg.gradle.daemon.registry.base=/home/u/.gradle/daemon-slot1 -Dorg.gradle.project.kotlin.compiler.execution.strategy=in-process');
  assert.ok(Object.keys(e).every((k) => !k.includes('.')), 'dash drops env names with dots');
  assert.match(slotEnv({ GRADLE_USER_HOME: '/g', GRADLE_OPTS: '-Xmx1g' }, 1).GRADLE_OPTS, /^-Xmx1g -Dorg\.gradle\.daemon\.registry\.base=\/g\/daemon-slot1 /);
  assert.match(slotEnv({ GRADLE_USER_HOME: '/my gradle' }, 1, { lockDir: '/locks' }).GRADLE_OPTS, /registry\.base=\/locks\/gradle-daemon-slot1 /);
  assert.match(slotEnv({ GRADLE_USER_HOME: 'rel/g' }, 1).GRADLE_OPTS, new RegExp(`registry\\.base=${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/rel/g/daemon-slot1 `), 'relative home made absolute');
});

// ── heavy: RAM budget ──

test('holderBefore is a strict total order (ties broken by slot); isUnbounded is fail-closed', () => {
  assert.equal(holderBefore({ startedAt: 1, slot: 1 }, { startedAt: 2, slot: 0 }), true);
  assert.equal(holderBefore({ startedAt: 5, slot: 0 }, { startedAt: 5, slot: 1 }), true);
  assert.equal(holderBefore({ startedAt: 5, slot: 1 }, { startedAt: 5, slot: 0 }), false);
  const T = 32 * GiB;
  assert.equal(isUnbounded({ memMax: 9 * GiB }, T), false);
  for (const h of [{ pending: true, memMax: GiB }, { unbounded: true }, {}, { memMax: 'x' }, { memMax: 0.7 * T }, { exclusive: true, memMax: GiB }]) assert.equal(isUnbounded(h, T), true, JSON.stringify(h));
});

test('slotBlockers: 30%+30% passes, 45%+30% waits, unbounded waits both ways, RAM gate = my cap + 3 GiB', () => {
  const T = 32 * GiB, m30 = 0.3 * T, m45 = 0.45 * T, base = { total: T, minBytes: 3 * GiB, avail: 20 * GiB };
  assert.deepEqual(slotBlockers({ ...base, earlier: [], myMax: m45 }), []);
  assert.deepEqual(slotBlockers({ ...base, earlier: [{ memMax: m30 }], myMax: m30 }), []);
  assert.match(slotBlockers({ ...base, earlier: [{ memMax: m45 }], myMax: m30 })[0], /ngân sách/);
  assert.match(slotBlockers({ ...base, earlier: [{ pending: true }], myMax: m30 })[0], /chưa khai báo/);
  assert.match(slotBlockers({ ...base, earlier: [{ memMax: m30 }], myMax: 0, unbounded: true })[0], /không giới hạn/);
  assert.deepEqual(slotBlockers({ ...base, earlier: [], myMax: 0, unbounded: true }), [], 'unbounded alone runs');
  assert.match(slotBlockers({ ...base, earlier: [{ memMax: m30 }], myMax: m30, avail: 12 * GiB })[0], /cần/);
  assert.deepEqual(slotBlockers({ ...base, earlier: [{ memMax: m30 }], myMax: m30, avail: 12 * GiB, minBytes: 0 }), [], 'MIN_FREE_MB=0 turns the RAM gate off');
  assert.deepEqual(slotBlockers({ ...base, earlier: [], extra: 1, myMax: m30 }), [], 'the earliest build never waits, not even on a fresh claim');
  assert.match(slotBlockers({ ...base, earlier: [{ memMax: m30 }], extra: 1, myMax: m30 })[0], /chưa ghi tên/);
});

test('waitForSlotTurn: no plateau escape — waits as long as the earlier build blocks, then goes once it is alone', async () => {
  const T = 32 * GiB;
  let t = 0, polls = 0, hs = [{ pid: 1, startedAt: 1, slot: 0, memMax: 0.45 * T, label: 'old' }];
  const flags = [];
  const r = await waitForSlotTurn({ me: { pid: 2, startedAt: 2, slot: 1 }, myMax: 0.3 * T, unbounded: false, total: T, minBytes: 3 * GiB,
    holders: () => hs, readState: () => ({ avail: 1 * GiB }), setWaiting: (w) => flags.push(w), log: () => {}, now: () => t,
    sleep: async (ms) => { t += ms; if (++polls === 200) hs = []; } }); // ~33 min of polls
  assert.equal(polls, 200);
  assert.equal(r.alone, true);
  assert.deepEqual(flags, [true, false]);
  assert.equal(r.waited, true);
});

test('waitForSlotTurn: two builds that took slots together never wait on each other — the earlier one goes', async () => {
  const T = 32 * GiB;
  const hs = [{ pid: 1, startedAt: 5, slot: 0, memMax: 0.3 * T }, { pid: 2, startedAt: 5, slot: 1, memMax: 0.3 * T }];
  const opts = { myMax: 0.3 * T, unbounded: false, total: T, minBytes: 3 * GiB, holders: () => hs, readState: () => ({ avail: 2 * GiB }), log: () => {} };
  const first = await waitForSlotTurn({ ...opts, me: { pid: 1, startedAt: 5, slot: 0 }, sleep: async () => { throw new Error('the first must not wait'); } });
  assert.equal(first.alone, true);
  let waited = false;
  const p = waitForSlotTurn({ ...opts, me: { pid: 2, startedAt: 5, slot: 1 }, sleep: async () => { waited = true; hs.shift(); } });
  assert.equal((await p).alone, true);
  assert.equal(waited, true, 'the later one waited for RAM');
});

test('heldByAncestor sees the outer heavy in slot 1 too', () => {
  const env = { TELEPORT_HEAVY_HELD: '4242' };
  assert.equal(heldByAncestor(env, () => [{ alive: true, pid: 9, slot: 0 }, { alive: true, pid: 4242, slot: 1 }]), true);
  assert.equal(heldByAncestor(env, () => [{ alive: true, pid: 9, slot: 0 }]), false);
});

test('describeBusy: "(2/2): A; B" with two slots, the old one-holder text otherwise', () => {
  const h = (label) => ({ alive: true, label, startedAt: Date.now(), cmd: 'x' });
  assert.equal(describeBusy(h('A'), { holders: [h('A'), h('B')], slots: 2 }), 'build đang bận (2/2): A — x, B — x');
  assert.match(describeBusy(h('A'), { holders: [h('A')], slots: 1 }), /^build đang bận: A — x/);
  assert.match(describeBusy(null, null), /chưa rõ ai giữ/);
});

// ── heavy main with a slot ──

const OPS = { preflight: () => ({ ok: true }), stop: () => true, orphans: () => [], oomKills: () => null, jobsConfigured: () => true, memTotal: 32 * GiB,
  holders: () => [], claimedOnly: () => 0, sweepLock: async () => () => {}, slotTurn: async () => ({ alone: true }) };

test('heavy main, slot 1 of 2: own Gradle env, 30% cap declared to the holder, budget wait called', async () => {
  let runOpts = null, pf = null, turn = null;
  const updates = [];
  const lock = { release() {}, update: (f) => updates.push(f), waitedMs: 0, slot: 1, slots: 2, startedAt: 7 };
  const code = await heavyMain(['--', './gradlew', 'build'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {},
    acquire: async (name, o) => { assert.equal(o.pending, true); return lock; }, run: async (c, o) => { runOpts = o; return 0; }, stopGradle: async () => 0,
    scopeOps: { ...OPS, preflight: (s) => { pf = s; return { ok: true }; }, slotTurn: async (o) => { turn = o; return { alone: true }; } } });
  assert.equal(code, 0);
  assert.match(runOpts.env.GRADLE_OPTS, /daemon-slot1/);
  assert.equal(pf.memMax, Math.floor(32 * GiB * SCOPE_MEM_FRACTION_SHARED / 4096) * 4096);
  assert.deepEqual(updates[0], { pending: undefined, memMax: pf.memMax });
  assert.equal(turn.me.slot, 1);
  assert.equal(turn.myMax, pf.memMax);
});

test('heavy main, slot 0 alone at N=1: env untouched, 45% cap; preflight failure → declared unbounded', async () => {
  let runOpts = null, pf = null;
  const updates = [];
  const lock = { release() {}, update: (f) => updates.push(f), waitedMs: 0, slot: 0, slots: 1, startedAt: 7 };
  await heavyMain(['--', 'cargo', 'build'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock,
    run: async (c, o) => { runOpts = o; return 0; }, scopeOps: { ...OPS, preflight: (s) => { pf = s; return { ok: false, why: 'no bus' }; } } });
  assert.equal(runOpts.env.GRADLE_OPTS, undefined);
  assert.equal(pf.memMax, Math.floor(32 * GiB * SCOPE_MEM_FRACTION / 4096) * 4096);
  assert.deepEqual(updates[0], { pending: undefined, unbounded: true });
});

test('heavy main: 30% even at N=1 when another build still holds a slot; sweep lock timeout → no run', async () => {
  let pf = null;
  const lock = { release() {}, update() {}, waitedMs: 0, slot: 0, slots: 1, startedAt: 7 };
  await heavyMain(['--', 'cargo', 'build'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock, run: async () => 0,
    scopeOps: { ...OPS, holders: () => [{ pid: 1, startedAt: 1, slot: 1, alive: true }], preflight: (s) => { pf = s; return { ok: true }; } } });
  assert.equal(pf.memMax, Math.floor(32 * GiB * SCOPE_MEM_FRACTION_SHARED / 4096) * 4096);
  let ran = false;
  const code = await heavyMain(['--', 'cargo', 'build'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock,
    run: async () => { ran = true; return 0; }, scopeOps: { ...OPS, sweepLock: async () => null } });
  assert.equal(code, 75);
  assert.equal(ran, false);
});

// ── display / owner commands ──

const H = (o) => ({ alive: true, pid: 1, startedAt: 0, ...o });
const fq = (holders, extra = {}) => formatQueue('build', { now: 6 * 60_000, struck: () => [], read: () => [], slots: 2,
  holderOf: (f) => holders[/build\.1\.holder/.test(f) ? 1 : 0] ?? null, ...extra });

test('formatQueue layout: trống (0/N), 1/2 còn chỗ, 2/2 with ▶ lines and Chờ (k), cut commands, (chờ RAM), exclusive', () => {
  assert.deepEqual(fq([]), ['🔒 build: trống (0/2)']);
  assert.deepEqual(fq([], { slots: 1 }), ['🔒 build: trống (0/1)']);
  const one = fq([H({ label: 'Ma', cmd: './gradlew test' })]);
  assert.equal(one[0], '🔒 build: đang chạy 1/2 — còn 1 chỗ trống');
  assert.match(one[1], /^ {2}▶ Ma — \.\/gradlew test — từ \d\d:\d\d \(6 phút\)$/);
  const long = 'x'.repeat(300);
  const two = fq([H({ label: 'Ma', cmd: long }), H({ pid: 2, label: 'Tiên', startedAt: 60_000, waitingRam: true })],
    { read: () => [{ name: 'a.json', status: 'live', pid: 3, label: 'Q', cmd: 'cargo test', createdAt: 0 }] });
  assert.equal(two[0], '🔒 build: đang chạy 2/2');
  assert.ok(two[1].length < 140 && two[1].includes(' …'), 'long command cut');
  assert.match(two[2], /▶ Tiên .*\(chờ RAM\)$/);
  assert.equal(two[3], '  Chờ (1):');
  assert.equal(two[4], '  1. Q — cargo test — chờ 6 phút');
  assert.equal(fq([H({ label: 'X' })], { slots: 1 })[0], '🔒 build: đang chạy 1/1');
  assert.equal(fq([H({ label: 'A' }), H({ pid: 2, label: 'B' })], { slots: 1 })[0], '🔒 build: đang chạy 2/1', 'N lowered while slot 1 still runs');
  const x = fq([H({ label: 'cleanup', exclusive: true })]);
  assert.equal(x[0], '🔒 build: đang chạy 2/2');
  assert.match(x[1], /\(giữ cả 2 chỗ\)$/);
  assert.equal(shortCmd('a  b\n c'), 'a b c');
});

test('formatQueue: merge keeps one slot with the same layout; "đang nhận lock" still shown', () => {
  const m = formatQueue('merge', { struck: () => [], holderOf: () => null, read: () => [{ name: 'a.json', status: 'live', pid: 2, label: 'L', createdAt: 0 }] });
  assert.match(m[0], /^🔒 merge: trống \(0\/1\) — L đang nhận lock$/);
});

test('leave: a job running in slot 1 is reported as running', () => {
  const dir = tmpDir();
  const r = leave({ lock: 'build' }, { dir, convoId: '5', cancel: () => [], claimed: () => [],
    holderOf: (f) => (/build\.1\.holder/.test(f) ? { alive: true, pid: 9, convoId: '5', cmd: 'cargo test' } : null) });
  assert.match(r.lines.join('\n'), /đang chạy rồi \(cargo test\)/);
});

test('slots 1 / auto / show; prune-skip warning after 5 skips in a row', () => {
  const dir = tmpDir();
  assert.match(setSlots('1', { dir, total: 32 * GiB })[0], /giới hạn 1/);
  assert.equal(fs.readFileSync(path.join(dir, 'build.slots'), 'utf8').trim(), '1');
  assert.match(setSlots('auto', { dir, total: 32 * GiB })[0], /tự động theo RAM 32 GiB → 2/);
  assert.equal(fs.existsSync(path.join(dir, 'build.slots')), false);
  setSlots('auto', { dir }); // removing twice is fine
  assert.deepEqual(parseArgs(['slots', '1']), { cmd: 'slots', value: '1' });
  assert.match(parseArgs(['slots', '2']).error, /usage/);
  for (let i = 1; i <= 4; i++) assert.equal(notePruneSkip(dir, true), i);
  assert.deepEqual(pruneSkipLines({ dir }), []);
  notePruneSkip(dir, true);
  assert.match(pruneSkipLines({ dir })[0], /5 lần/);
  assert.equal(notePruneSkip(dir, false), 0);
  assert.deepEqual(pruneSkipLines({ dir }), []);
});

// ── round-1 review additions ──

test('a lost claim at slot 1 gives the slot back', async () => {
  const dir = tmpDir();
  const h0 = await acquireLock('build', { dir, waitSec: 0, slots: 2, convoId: null });
  const r = await acquireLock('build', { dir, waitSec: 5, pollMs: 50, slots: 2, convoId: null,
    beforeClaim: (t) => fs.renameSync(t, t.replace(/\.json$/, '.left')) });
  assert.equal(r.left, true);
  assert.equal(probe(dir, 1), 'free');
  h0.release();
});

test('position 1 only tries while 1 < N − busy (a claimed ticket without holder counts as busy)', async () => {
  const dir = tmpDir();
  const h0 = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'H0', convoId: null });
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  // a live waiter ahead of us (our own pid keeps it alive; fresh mtime = live), and a claim with no holder yet
  const ahead = path.join(q, '000000000000001-' + process.pid + '-aaaaaa.json');
  fs.writeFileSync(ahead, JSON.stringify({ pid: process.pid, label: 'AHEAD', createdAt: 1 }));
  const claim = path.join(q, '000000000000002-' + process.pid + '-bbbbbb.acq');
  fs.writeFileSync(claim, JSON.stringify({ pid: process.pid }));
  let got = null;
  const p = acquireLock('build', { dir, waitSec: 5, pollMs: 50, slots: 2, label: 'me', convoId: null }).then((l) => { got = l; return l; });
  const keep = setInterval(() => { try { const t = new Date(); fs.utimesSync(ahead, t, t); } catch {} }, 100);
  await sleep(400);
  assert.equal(got, null, 'position 1 with N − busy = 2 − (1 holder + 1 claim) = 0 → no try, though slot 1 is free');
  fs.unlinkSync(claim);
  await sleep(400);
  assert.equal(got, null, 'busy = 1 holder → position 1 < 2 − 1 is false: the slot is for the waiter ahead');
  clearInterval(keep);
  fs.unlinkSync(ahead);
  const l = await p;
  assert.equal(l.slot, 1, 'now at position 0 → tries and gets slot 1');
  l.release(); h0.release();
});

test('a waiter without `slots` (N from the machine; 1 in a test dir) never takes slot 1, even when it frees', async () => {
  const dir = tmpDir();
  const h0 = await acquireLock('build', { dir, waitSec: 0, slots: 2, convoId: null });
  const h1 = await acquireLock('build', { dir, waitSec: 0, slots: 2, convoId: null });
  // N defaults to 1 in a test dir: a waiter without `slots` must never take slot 1 even when it frees
  let got = null;
  const p = acquireLock('build', { dir, waitSec: 5, pollMs: 50, convoId: null }).then((l) => { got = l; return l; });
  h1.release();
  await sleep(400);
  assert.equal(got, null, 'slot 1 free but N = 1 → not granted');
  h0.release();
  const l = await p;
  assert.equal(l.slot, 0);
  l.release();
});

test('with 2 slots a holder that cannot be written means no run (the other build budgets RAM from it)', async () => {
  const dir = tmpDir();
  fs.mkdirSync(lockPaths('build', dir).holder); // a directory where the holder file goes → write fails
  await assert.rejects(acquireLock('build', { dir, waitSec: 0, slots: 2, convoId: null }), /không ghi được holder/);
  assert.equal(probe(dir, 0), 'free', 'slot given back');
  const l = await acquireLock('build', { dir, waitSec: 0, slots: 1, convoId: null });
  assert.ok(l.release, 'N = 1: display only, as before');
  l.release();
});

test('heavy main: after waiting for an earlier build it sweeps orphans again; --no-ram-wait keeps the slot gate', async () => {
  let sweeps = 0, turn = null;
  const lock = { release() {}, update() {}, waitedMs: 0, slot: 1, slots: 2, startedAt: 7 };
  const base = { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock, run: async () => 0 };
  await heavyMain(['--no-ram-wait', '--', 'cargo', 'b'], { ...base, scopeOps: { ...OPS, sweepLock: async () => { sweeps++; return () => {}; }, slotTurn: async (o) => { turn = o; return { waited: true }; } } });
  assert.equal(sweeps, 2);
  assert.equal(turn.minBytes, 3 * GiB);
  sweeps = 0;
  await heavyMain(['--', 'cargo', 'b'], { ...base, scopeOps: { ...OPS, sweepLock: async () => { sweeps++; return () => {}; } } });
  assert.equal(sweeps, 1, 'no wait → no second sweep');
  const zero = await heavyMain(['--', 'cargo', 'b'], { ...base, env: { TELEPORT_HEAVY_MIN_FREE_MB: '0' }, scopeOps: { ...OPS, slotTurn: async (o) => { turn = o; return {}; } } });
  assert.equal(zero, 0);
  assert.equal(turn.minBytes, 0, 'MIN_FREE_MB=0 turns the gate off');
});

test('heavy main + real acquireLock and waitForSlotTurn: slot 1 waits for slot 0 (45%) to finish', async () => {
  const dir = tmpDir();
  const T = 32 * GiB;
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null });
  a.update({ memMax: Math.floor(0.45 * T) });
  const holders = () => readHolders('build', { dir });
  const events = [];
  const turn = (o) => waitForSlotTurn({ ...o, readState: () => ({ avail: 20 * GiB }), sleep: async () => { events.push('wait'); if (events.length === 3) a.release(); await sleep(10); } });
  const code = await heavyMain(['--', 'cargo', 'b'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {},
    acquire: (name, o) => acquireLock(name, { ...o, dir, slots: 2, convoId: null, label: 'B' }),
    run: async () => { events.push('run'); return 0; },
    scopeOps: { ...OPS, memTotal: T, holders, claimedOnly: () => 0, slotTurn: turn } });
  assert.equal(code, 0);
  assert.deepEqual(events, ['wait', 'wait', 'wait', 'run']);
});
