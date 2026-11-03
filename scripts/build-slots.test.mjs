// RFC 23 — two slots for the build lock: slot files, N, FIFO with slots,
// exclusive, heavy's per-slot env / RAM budget, display.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, lockPaths, readHolders, readQueue, readClaimed, resolveBuildSlots, slotsFor, MAX_SLOTS, TWO_SLOT_MIN_RAM, acquireHelperLock, secondSlotOk, secondSlotVerdict, gateText, defaultCpuGate, realCpuGate, effectiveSlots, hasFreeSlot, cpuGateNote, DEFAULT_LOCK_DIR } from './machine-lock.mjs';
import { setPaused } from './queue-control.mjs';
import { longBuildCandidates } from './long-build.mjs';
import { blockingHolders, slotEnv, slotBlockers, holderBefore, isUnbounded, waitForSlotTurn, heldByAncestor, describeBusy, main as heavyMain, earlyPolicyCheck, SCOPE_MEM_FRACTION, SCOPE_MEM_FRACTION_SHARED } from './heavy.mjs';
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
  assert.deepEqual(flags, [true], 'waitingRam is cleared by admit(), together with admitted');
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
  holders: () => [], sweepLock: async () => () => {}, slotTurn: async () => ({ alone: true }) };

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
  assert.deepEqual({ ...updates[0], unit: undefined }, { pending: undefined, scoped: true, memMax: pf.memMax, unit: undefined });
  assert.match(updates[0].unit, /^heavy-\d+-[a-z0-9]+\.scope$/, 'RFC 24: the unit is published with the cap');
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
  assert.deepEqual(updates[0], { pending: undefined, scoped: false, unbounded: true });
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
const fq = (holders, extra = {}) => formatQueue('build', { now: 6 * 60_000, struck: () => [], read: () => [], slots: 2, gate: () => ({ ok: true }),
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

test('heavy main: sweeps orphans again right before starting; --no-ram-wait keeps the slot gate', async () => {
  let sweeps = 0, turn = null;
  const lock = { release() {}, update() {}, waitedMs: 0, slot: 1, slots: 2, startedAt: 7 };
  const base = { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock, run: async () => 0 };
  await heavyMain(['--no-ram-wait', '--', 'cargo', 'b'], { ...base, scopeOps: { ...OPS, sweepLock: async () => { sweeps++; return () => {}; }, slotTurn: async (o) => { turn = o; return { waited: true }; } } });
  assert.equal(sweeps, 2);
  assert.equal(turn.minBytes, 3 * GiB);
  sweeps = 0;
  await heavyMain(['--', 'cargo', 'b'], { ...base, scopeOps: { ...OPS, sweepLock: async () => { sweeps++; return () => {}; } } });
  assert.equal(sweeps, 2, 'always swept again right before the build starts');
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
    scopeOps: { ...OPS, memTotal: T, holders, slotTurn: turn } });
  assert.equal(code, 0);
  assert.deepEqual(events, ['wait', 'wait', 'wait', 'run']);
});

test('heavy main: a 2-slot build whose cap cannot be written to its holder does not run', async () => {
  let ran = false;
  const lock = { release() {}, update: () => false, waitedMs: 0, slot: 1, slots: 2, startedAt: 7 };
  const code = await heavyMain(['--', 'cargo', 'b'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock,
    run: async () => { ran = true; return 0; }, scopeOps: OPS });
  assert.equal(code, 1);
  assert.equal(ran, false);
  const small = await heavyMain(['--', 'cargo', 'b'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {},
    acquire: async () => ({ ...lock, slot: 0, slots: 1 }), run: async () => 0, scopeOps: { ...OPS, memTotal: 16 * GiB } });
  assert.equal(small, 0, '16 GiB machine, N = 1: the holder stays display-only');
});

// ── round-3 review: admission is serialized ──

test('blockingHolders: earlier ones, plus any admitted one even if it sorts later', () => {
  const me = { pid: 1, startedAt: 5, slot: 0 };
  const hs = [me, { pid: 2, startedAt: 9, slot: 1 }, { pid: 3, startedAt: 9, slot: 1, admitted: true }, { pid: 4, startedAt: 1, slot: 1 }];
  assert.deepEqual(blockingHolders(hs, me).map((h) => h.pid), [3, 4]);
});

test('waitForSlotTurn: a build that published late (sorts earlier) still waits for one already admitted', async () => {
  const T = 32 * GiB;
  const hs = [{ pid: 2, startedAt: 9, slot: 1, unbounded: true, admitted: true, label: 'B' }]; // B passed while A had no holder yet
  let polls = 0;
  const r = await waitForSlotTurn({ me: { pid: 1, startedAt: 5, slot: 0 }, myMax: 0.3 * T, unbounded: false, total: T, minBytes: 0, holders: () => hs,
    log: () => {}, readState: () => ({ avail: 30 * GiB }), sleep: async () => { if (++polls === 3) hs.pop(); } });
  assert.equal(polls, 3, 'A waited for the admitted unbounded B although B sorts later');
  assert.equal(r.alone, true);
});

test('waitForSlotTurn: check + admit run inside the admit lock; lock busy → wait; admit failure → failed', async () => {
  const ev = [];
  const r = await waitForSlotTurn({ me: { pid: 1, startedAt: 5, slot: 0 }, myMax: GiB, unbounded: false, total: 32 * GiB, minBytes: 0, holders: () => { ev.push('read'); return []; },
    admitLock: async () => { ev.push('lock'); return () => ev.push('unlock'); }, admit: () => { ev.push('admit'); return true; }, log: () => {}, sleep: async () => {} });
  assert.deepEqual(ev, ['lock', 'read', 'admit', 'unlock']);
  assert.equal(r.alone, true);
  let tries = 0;
  await waitForSlotTurn({ me: { pid: 1, startedAt: 5, slot: 0 }, myMax: GiB, unbounded: false, total: 32 * GiB, minBytes: 0, holders: () => [],
    admitLock: async () => (++tries < 3 ? null : () => {}), log: () => {}, sleep: async () => {} });
  assert.equal(tries, 3);
  const f = await waitForSlotTurn({ me: { pid: 1, startedAt: 5, slot: 0 }, myMax: GiB, unbounded: false, total: 32 * GiB, minBytes: 0, holders: () => [],
    admit: () => false, log: () => {}, sleep: async () => {} });
  assert.equal(f.failed, true);
});

test('heavy main: the build is marked admitted (waitingRam cleared) before it runs; admit failure on a 2-slot machine → no run', async () => {
  const updates = [];
  const lock = { release() {}, update: (f) => { updates.push(f); return true; }, waitedMs: 0, slot: 1, slots: 2, startedAt: 7 };
  const base = { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock };
  let ran = false;
  await heavyMain(['--', 'cargo', 'b'], { ...base, run: async () => { ran = true; assert.ok(updates.some((u) => u.admitted === true)); return 0; },
    scopeOps: { ...OPS, slotTurn: waitForSlotTurn, holders: () => [] } });
  assert.equal(ran, true);
  assert.deepEqual(updates.find((u) => u.admitted), { admitted: true, waitingRam: undefined });
  ran = false;
  const failing = { ...lock, update: (f) => !f.admitted };
  const code = await heavyMain(['--', 'cargo', 'b'], { ...base, acquire: async () => failing, run: async () => { ran = true; return 0; },
    scopeOps: { ...OPS, slotTurn: waitForSlotTurn, holders: () => [] } });
  assert.equal(code, 1);
  assert.equal(ran, false);
});

// ── RFC 32: the CPU gate for the 2nd slot ──

const CLOSED = (reason = 'cpu') => ({ ok: false, reason, load1: 11.2, cores: 12 });
const OPEN = { ok: true, reason: null, load1: 1, cores: 12 };
const runningFor = (ms, now = 1_000_000) => ({ running: true, runningSince: now - ms });
const idleBusyGate = ({ busy }) => (busy > 0 ? CLOSED() : OPEN); // closed whenever another build exists

test('RFC32 secondSlotOk: load 10/12 closed; low load but a 30 s old build closed; 120 s open; busy 0 open; unreadable load/cores open', () => {
  const now = 1_000_000;
  const base = { busy: 1, holders: [runningFor(120_000, now)], unnamed: 0, now, loadavg: [3, 3, 3], cores: 12 };
  assert.equal(secondSlotOk({ ...base, loadavg: [10, 9, 8] }), false);
  assert.equal(secondSlotVerdict({ ...base, loadavg: [10, 9, 8] }).reason, 'cpu');
  assert.equal(secondSlotOk({ ...base, loadavg: [8.99, 9, 8] }), true, '0.75 × 12 = 9 is the line');
  assert.equal(secondSlotOk({ ...base, holders: [runningFor(30_000, now)] }), false);
  assert.equal(secondSlotVerdict({ ...base, holders: [runningFor(30_000, now)] }).reason, 'young');
  assert.equal(secondSlotOk(base), true);
  assert.equal(secondSlotOk({ ...base, busy: 0, holders: [], loadavg: [50, 50, 50] }), true, 'nobody running → the head of the queue always runs');
  assert.equal(secondSlotOk({ ...base, loadavg: [0, 0, 0], holders: [runningFor(1, now)] }), true, 'Windows: loadavg [0,0,0] → RFC 23 behaviour');
  assert.equal(secondSlotOk({ ...base, cores: 0, loadavg: [50, 50, 50] }), true);
  assert.equal(secondSlotOk({ ...base, holders: [{ running: false }] }), false, 'a holder not yet running its command');
  assert.equal(secondSlotOk({ ...base, holders: [{ running: true }] }), false, 'running without runningSince');
  assert.equal(secondSlotOk({ ...base, holders: [], unnamed: 1, busy: 1 }), false, 'a claimed ticket with no holder yet');
  // startedAt (lock taken, before sweep / RAM wait) is NOT the clock: only runningSince is
  assert.equal(secondSlotOk({ ...base, holders: [{ running: true, runningSince: now - 10_000, startedAt: now - 600_000 }] }), false);
});

test('RFC32 quiet hours close the gate whenever a build runs, whatever the load; overridden → back to the CPU rules', () => {
  const now = 1_000_000;
  const q = { enabled: true, active: true, overridden: false, maxBuilds: 1 };
  const base = { busy: 1, holders: [runningFor(300_000, now)], now, loadavg: [0.5, 0.5, 0.5], cores: 12, quiet: q };
  const v = secondSlotVerdict(base);
  assert.deepEqual([v.ok, v.reason], [false, 'quiet']);
  assert.equal(secondSlotOk({ ...base, busy: 0, holders: [] }), true, 'an empty machine still starts the first build');
  assert.equal(secondSlotOk({ ...base, quiet: { ...q, overridden: true } }), true);
  assert.equal(secondSlotOk({ ...base, quiet: { ...q, active: false } }), true);
  assert.equal(secondSlotOk({ ...base, quiet: { ...q, maxBuilds: 2 } }), true, 'maxBuilds 2 allows the 2nd');
  assert.equal(secondSlotOk({ ...base, quiet: { ...q, overridden: true }, loadavg: [10, 10, 10] }), false, 'overridden: the §3.2 rules');
  assert.equal(gateText(v), '🌙 giờ im lặng');
  assert.equal(gateText(CLOSED('cpu')), 'chờ CPU (load 11.2/12)');
  assert.equal(gateText(CLOSED('cpu'), 'wait'), 'CPU bận (load 11.2/12)');
  assert.equal(gateText(CLOSED('young')), 'build kia mới chạy <90s');
  assert.equal(gateText(OPEN), '');
});

test('RFC32 default gate: open for a test dir (the real one only for the default lock dir)', () => {
  assert.equal(defaultCpuGate('/tmp/some-test-dir')({ busy: 1, holders: [], unnamed: 0, now: 0, dir: '/x' }).ok, true);
  assert.equal(defaultCpuGate(DEFAULT_LOCK_DIR), realCpuGate);
});

test('RFC32 2 → 1 with slot 1 alive: A in slot 0 ends, B still runs in slot 1, CPU busy → C does NOT take slot 0; once B ends it does', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null });
  const b = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'B', convoId: null });
  assert.deepEqual([a.slot, b.slot], [0, 1]);
  a.release();
  const calls = [];
  const gate = (x) => { calls.push(x.busy); return idleBusyGate(x); };
  const c = await acquireLock('build', { dir, waitSec: 0.5, pollMs: 50, slots: 2, label: 'C', convoId: null, cpuGate: gate });
  assert.equal(c.timeout, true, 'slot 0 is free, but another build runs and the gate is closed');
  assert.ok(calls.length > 1 && calls.every((n) => n === 1), 'the head of the queue computes busy too');
  assert.equal(probe(dir, 0), 'free');
  let got = null;
  const p = acquireLock('build', { dir, waitSec: 5, pollMs: 50, slots: 2, label: 'C2', convoId: null, cpuGate: idleBusyGate }).then((l) => { got = l; return l; });
  await sleep(300);
  assert.equal(got, null);
  b.release();
  const l = await p;
  assert.equal(l.slot, 0);
  l.release();
});

test('RFC32 MemoryMax does not follow the CPU gate: a build admitted after the gate closed then opened still gets N = 2 (30%)', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null });
  a.update({ running: true, runningSince: Date.now() - 200_000, memMax: Math.floor(0.3 * 32 * GiB) });
  let n = 0;
  let pf = null;
  const code = await heavyMain(['--', 'cargo', 'b'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {},
    acquire: (name, o) => acquireLock(name, { ...o, dir, slots: 2, convoId: null, label: 'B', pollMs: 30, cpuGate: () => (++n <= 3 ? CLOSED() : OPEN) }),
    run: async () => 0,
    scopeOps: { ...OPS, preflight: (s) => { pf = s; return { ok: true }; }, holders: () => readHolders('build', { dir }) } });
  assert.equal(code, 0);
  assert.ok(n > 3, 'it waited behind the closed gate');
  assert.equal(pf.memMax, Math.floor(32 * GiB * SCOPE_MEM_FRACTION_SHARED / 4096) * 4096);
  a.release();
});

test('RFC32 a build.slots file → the gate is never consulted', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'build.slots'), '1\n');
  let called = 0;
  const gate = () => { called++; return CLOSED(); };
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null, cpuGate: gate });
  const b = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'B', convoId: null, cpuGate: gate });
  assert.deepEqual([a.slot, b.slot], [0, 1]);
  assert.equal(called, 0);
  assert.equal(effectiveSlots({ dir, N: 2, holders: [{}], gate }), 2);
  assert.equal(called, 0);
  a.release(); b.release();
});

test('RFC32 try-once: gate closed → timeout, slot given back; open → granted', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null });
  const r = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'B', convoId: null, cpuGate: () => CLOSED() });
  assert.equal(r.timeout, true);
  assert.equal(probe(dir, 1), 'free', 'the slot we won to check is given back');
  const ok = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'B', convoId: null, cpuGate: () => OPEN });
  assert.equal(ok.slot, 1);
  ok.release(); a.release();
});

test('RFC32 fast path (policy, empty queue): gate closed → the ticket is queued instead of taking the slot; opens → granted', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null });
  let open = false;
  let got = null;
  const p = acquireLock('build', { dir, waitSec: 8, pollMs: 50, slots: 2, label: 'B', convoId: null, policy: true, cpuGate: () => (open ? OPEN : CLOSED()) }).then((l) => { got = l; return l; });
  await queuedFor(dir, 'B');
  await sleep(200);
  assert.equal(got, null);
  assert.equal(probe(dir, 1), 'free', 'slot 1 stays free while the gate is closed');
  assert.equal(readClaimed('build', { dir }).length, 0);
  open = true;
  const l = await p;
  assert.equal(l.slot, 1);
  l.release(); a.release();
});

test('RFC32 paused (RFC 29) keeps its old behaviour with the gate present', async () => {
  const dir = tmpDir();
  await setPaused(dir, true);
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null, cpuGate: () => OPEN });
  assert.equal(a.timeout, true, 'paused → nobody gets a slot, gate or not');
  const b = await acquireLock('build', { dir, waitSec: 0.3, pollMs: 50, slots: 2, label: 'B', convoId: null, policy: true, cpuGate: () => OPEN });
  assert.equal(b.timeout, true);
});

test('RFC32 gate inputs: a holder that is not running yet, and a claimed ticket without holder, are reported', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null });
  const seen = [];
  const spy = (x) => { seen.push({ busy: x.busy, unnamed: x.unnamed, running: x.holders.map((h) => h.running) }); return CLOSED(); };
  await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'B', convoId: null, cpuGate: spy });
  assert.deepEqual(seen[0], { busy: 1, unnamed: 0, running: [undefined] }, 'holder A has not published running: the real gate treats that as closed');
  assert.equal(secondSlotOk({ busy: 1, holders: [{ label: 'A' }], now: 1, loadavg: [1, 1, 1], cores: 12 }), false);
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  fs.writeFileSync(path.join(q, '000000000000002-' + process.pid + '-bbbbbb.acq'), JSON.stringify({ pid: process.pid }));
  a.release();
  seen.length = 0;
  await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'C', convoId: null, cpuGate: spy });
  assert.equal(seen[0]?.unnamed, 1, 'the .acq without holder counts as busy: the gate is consulted with busy 1 though no holder file exists');
});

test('RFC32 race: two waiters that both see busy 0 → only the first to claim runs; the other is re-checked under build.gate and waits', async () => {
  const dir = tmpDir();
  const mk = (label) => acquireLock('build', { dir, waitSec: 1.2, pollMs: 40, slots: 2, label, convoId: null, cpuGate: idleBusyGate });
  const [x, y] = await Promise.all([mk('X'), mk('Y')]);
  const won = [x, y].filter((r) => !r.timeout);
  assert.equal(won.length, 1, 'exactly one build starts');
  assert.equal([x, y].filter((r) => r.timeout).length, 1);
  assert.equal(readHolders('build', { dir }).length, 1);
  won[0].release();
});

test('RFC32 build.gate is free again once the holder file names the winner', async () => {
  const dir = tmpDir();
  const a = await acquireLock('build', { dir, waitSec: 0, slots: 2, label: 'A', convoId: null, cpuGate: () => OPEN });
  const rel = await acquireHelperLock('build.gate', { dir, waitMs: 500 });
  assert.ok(rel, 'released after the holder write');
  rel();
  assert.ok(readHolders('build', { dir }).some((h) => h.label === 'A'));
  a.release();
});

test('RFC32 effectiveSlots: gate closed → the builds running (min 1); open → N; long-build uses it so a stuck night build still gets its ⏹', () => {
  const dir = tmpDir();
  const h = { pid: 1, startedAt: 0, running: true, runningSince: 0, label: 'A' };
  assert.equal(effectiveSlots({ dir, N: 2, holders: [h], gate: () => CLOSED() }), 1);
  assert.equal(effectiveSlots({ dir, N: 2, holders: [h], gate: () => OPEN }), 2);
  assert.equal(effectiveSlots({ dir, N: 2, holders: [], gate: () => CLOSED() }), 1);
  assert.equal(effectiveSlots({ dir, N: 1, holders: [h], gate: () => CLOSED() }), 1);
  const now = 60 * 60_000;
  const queue = [{ status: 'live', createdAt: now - 20 * 60_000 }];
  assert.equal(longBuildCandidates({ holders: [h], queue, slots: 2, now }).length, 0, 'with N = 2 and one holder there is still "a free slot"');
  assert.equal(longBuildCandidates({ holders: [h], queue, slots: effectiveSlots({ dir, N: 2, holders: [h], gate: () => CLOSED('quiet') }), now }).length, 1);
});

test('RFC32 heavy earlyPolicyCheck: a closed gate means no free slot, so a full queue is refused up front', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'build.policy.json'), JSON.stringify({ v: 1, max: 0, lastMax: 4, retryMin: 10, paused: false, blocks: [], boosts: {} }));
  const h = { pid: 1, startedAt: 0, label: 'A' };
  const args = { dir, owner: 'convo:9', holders: [h], queue: [], slots: 2 };
  assert.equal(earlyPolicyCheck({ ...args, gate: () => OPEN }), null, 'free slot + nobody waiting = the "build now" exception');
  assert.equal(earlyPolicyCheck({ ...args, gate: () => CLOSED() })?.refused, 'full');
});

test('RFC32 display: cpuGateNote only for N = 2 with one build and a closed gate; ls header replaces the text; heavy wait notice shows the reason', async () => {
  const dir = tmpDir();
  const h = { pid: 1, startedAt: 0, label: 'A', running: true, runningSince: 0 };
  const note = (o) => cpuGateNote({ dir, N: 2, holders: [h], claimed: [], ...o });
  assert.equal(note({ gate: () => CLOSED() }), 'chờ CPU (load 11.2/12)');
  assert.equal(note({ gate: () => CLOSED('quiet') }), '🌙 giờ im lặng');
  assert.equal(note({ gate: () => CLOSED('young') }), 'build kia mới chạy <90s');
  assert.equal(note({ gate: () => OPEN }), '');
  assert.equal(note({ holders: [h, { ...h, pid: 2 }], gate: () => CLOSED() }), '', '2/2: no free slot to explain');
  assert.equal(note({ holders: [], gate: () => CLOSED() }), '', 'idle machine');
  assert.equal(note({ N: 1, gate: () => CLOSED() }), '');
  const lines = fq([H({ label: 'Ma', cmd: 'x' })], { gate: () => CLOSED() });
  assert.equal(lines[0], '🔒 build: đang chạy 1/2 — còn 1 chỗ — chờ CPU (load 11.2/12)');
  assert.equal(fq([H({ label: 'Ma' })])[0], '🔒 build: đang chạy 1/2 — còn 1 chỗ trống');
  const logs = [];
  const lock = { release() {}, update: () => true, waitedMs: 0, slot: 1, slots: 2, startedAt: 7 };
  await heavyMain(['--', 'cargo', 'b'], { env: {}, nested: () => false, log: (m) => logs.push(m), waitRam: async () => {},
    acquire: async (name, o) => { o.onWait({ label: 'A', alive: true, startedAt: 0, pid: 1 }, 0, { position: 1, ahead: [], holders: [{ label: 'A', pid: 1 }], slots: 2, gate: CLOSED() }); return lock; },
    run: async () => 0, scopeOps: OPS });
  assert.ok(logs.some((m) => /CPU bận \(load 11\.2\/12\)/.test(m)), logs.join('\n'));
});

test('RFC32 heavy: syncs the quiet CPU limit before the scope exists and every syncEveryMs while the build runs; the holder says scoped', async () => {
  const order = [];
  const updates = [];
  const lock = { release() {}, update: (f) => { updates.push(f); return true; }, waitedMs: 0, slot: 0, slots: 1, startedAt: 7 };
  await heavyMain(['--', 'cargo', 'b'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock,
    run: async () => { order.push('run'); await sleep(120); return 0; },
    scopeOps: { ...OPS, preflight: () => { order.push('preflight'); return { ok: true }; }, syncQuiet: () => order.push('sync'), syncEveryMs: 20 } });
  assert.deepEqual(order.slice(0, 4), ['sync', 'preflight', 'sync', 'run'], 'a sync before the scope check and another right before spawn');
  assert.ok(order.filter((x) => x === 'sync').length >= 3, `timer syncs while it runs: ${order.join(',')}`);
  assert.equal(updates[0].scoped, true);
  const order2 = [], up2 = [];
  await heavyMain(['--no-scope', '--', 'cargo', 'b'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => ({ ...lock, update: (f) => { up2.push(f); return true; } }),
    run: async () => { await sleep(80); return 0; }, scopeOps: { ...OPS, syncQuiet: () => order2.push('sync'), syncEveryMs: 20 } });
  assert.deepEqual(order2, [], '--no-scope: nothing to limit, no timer');
  assert.equal(up2[0].scoped, false);
  const code = await heavyMain(['--', 'cargo', 'b'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => {}, acquire: async () => lock, run: async () => 0,
    scopeOps: { ...OPS, syncQuiet: () => { throw new Error('boom'); } } });
  assert.equal(code, 0, 'a sync that throws never fails the build');
});

test('R4 busy counts claimed (.acq) tickets and an exclusive holder; no misleading note when there is no free slot', () => {
  const dir = tmpDir();
  const h = { pid: 1, startedAt: 0, label: 'A', running: true, runningSince: 0 };
  const claim = [{ ticket: 'x.json' }];
  assert.equal(effectiveSlots({ dir, N: 2, holders: [], claimed: claim, gate: () => CLOSED() }), 1, 'one claim, no holder file yet → max(1, busy)');
  assert.equal(effectiveSlots({ dir, N: 2, holders: [h], claimed: claim, gate: () => CLOSED() }), 2, 'holder + claim = both slots busy');
  assert.equal(hasFreeSlot({ dir, N: 2, holders: [h], claimed: claim, gate: () => OPEN }), false);
  assert.equal(hasFreeSlot({ dir, N: 2, holders: [h], claimed: [], gate: () => OPEN }), true);
  assert.equal(hasFreeSlot({ dir, N: 2, holders: [h], claimed: [], gate: () => CLOSED() }), false);
  const ex = { ...h, exclusive: true };
  assert.equal(hasFreeSlot({ dir, N: 2, holders: [ex], claimed: [], gate: () => OPEN }), false, 'cleanup holds every slot');
  assert.equal(cpuGateNote({ dir, N: 2, holders: [ex], claimed: [], gate: () => CLOSED('young') }), '');
  assert.equal(cpuGateNote({ dir, N: 2, holders: [h], claimed: claim, gate: () => CLOSED('young') }), '', 'claim + holder: full');
  // earlyPolicyCheck uses it: max 0, one holder + one claim, open gate → no "build now" exception
  fs.writeFileSync(path.join(dir, 'build.policy.json'), JSON.stringify({ v: 1, max: 0, lastMax: 4, retryMin: 10, paused: false, blocks: [], boosts: {} }));
  assert.equal(earlyPolicyCheck({ dir, owner: 'convo:9', holders: [h, ], queue: [], slots: 2, gate: () => OPEN }), null);
  assert.equal(earlyPolicyCheck({ dir, owner: 'convo:9', holders: [ex], queue: [], slots: 2, gate: () => OPEN })?.refused, 'full');
});

test('R2 heavy syncs once more right before the scope is spawned (after the RAM wait / gradlew --stop)', async () => {
  const order = [];
  const lock = { release() {}, update: () => true, waitedMs: 0, slot: 0, slots: 1, startedAt: 7 };
  await heavyMain(['--', './gradlew', 'b'], { env: {}, nested: () => false, log: () => {}, waitRam: async () => { order.push('ram'); }, acquire: async () => lock,
    stopGradle: async () => { order.push('stop'); return 0; }, run: async (c) => { order.push('run'); return 0; },
    scopeOps: { ...OPS, preflight: () => ({ ok: true }), syncQuiet: () => order.push('sync'), syncEveryMs: 1e9 } });
  const iStop = order.indexOf('stop'), iRun = order.indexOf('run');
  assert.ok(order.slice(iStop, iRun).includes('sync'), order.join(','));
  assert.equal(order[iRun - 1], 'sync');
});
