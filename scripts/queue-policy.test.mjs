// RFC 29 — the owner's build-queue policy: build-policy.mjs, acquireLock({ policy:true }) admission / final check /
// kick / block / pause, queueOrder boosts. Every lock dir is a temp dir: never the machine's real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  acquireLock, readQueue, readStruck, lockPaths, queueOrder, hasPreBoostWaiter, cancelTickets, withPolicyLock, acquireHelperLock,
} from './machine-lock.mjs';
import {
  defaultPolicy, readPolicy, validatePolicy, writePolicy, policyFile, parseDuration, blockActive, pruneForWrite, TICKET_V,
} from './build-policy.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-qpol-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(30); } };
const setPolicy = (dir, patch) => writePolicy(dir, { ...defaultPolicy(), ...patch });
const base = { pollMs: 30, slots: 1, policy: true, warn: () => {} };
const probe = (dir) => (spawnSync('flock', ['-n', '-E', '75', lockPaths('build', dir, 0).lock, 'true']).status === 0 ? 'free' : 'busy');
/** A waiter in the background (the pending acquireLock promise); use queued() to wait for its ticket. */
const waiter = (dir, label, extra = {}) => acquireLock('build', { dir, label, convoId: extra.convoId ?? label, waitSec: 20, ...base, ...extra });
const queued = (dir, n) => until(() => readQueue('build', { dir }).length >= n);

// ── build-policy.mjs ──

test('policy: missing file = no restriction; corrupt JSON / wrong schema = corrupt (defaults + flag)', () => {
  const dir = tmpDir();
  assert.deepEqual(readPolicy(dir), { policy: defaultPolicy(), corrupt: false, missing: true });
  fs.writeFileSync(policyFile(dir), '{nope');
  assert.equal(readPolicy(dir).corrupt, true);
  assert.deepEqual(readPolicy(dir).policy, defaultPolicy(), 'a corrupt file restricts nothing');
  fs.writeFileSync(policyFile(dir), JSON.stringify({ ...defaultPolicy(), max: 99 }));
  assert.equal(readPolicy(dir).corrupt, true, 'max out of range');
  fs.writeFileSync(policyFile(dir), JSON.stringify({ ...defaultPolicy(), retryMin: 0 }));
  assert.equal(readPolicy(dir).corrupt, true);
});

test('policy: validate bounds (max 0..20|null, lastMax, retryMin 1..120, ≤ 50 blocks / boosts, until > now on write)', () => {
  const ok = defaultPolicy();
  assert.equal(validatePolicy(ok), null);
  assert.match(validatePolicy({ ...ok, max: -1 }), /max/);
  assert.match(validatePolicy({ ...ok, max: 21 }), /max/);
  assert.equal(validatePolicy({ ...ok, max: 0 }), null);
  assert.match(validatePolicy({ ...ok, lastMax: 21 }), /lastMax/);
  assert.match(validatePolicy({ ...ok, retryMin: 121 }), /retryMin/);
  assert.match(validatePolicy({ ...ok, paused: 'yes' }), /paused/);
  const blocks = Array.from({ length: 51 }, (_, i) => ({ owner: `convo:${i}`, until: 9e15 }));
  assert.match(validatePolicy({ ...ok, blocks }), /blocks/);
  const boosts = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`t${i}`, 1]));
  assert.match(validatePolicy({ ...ok, boosts }), /boosts/);
  assert.match(validatePolicy({ ...ok, blocks: [{ owner: 'convo:1', until: 5 }] }, { now: 10, requireFuture: true }), /tương lai/);
  assert.equal(validatePolicy({ ...ok, blocks: [{ owner: 'convo:1', until: 5 }] }, { now: 10 }), null, 'on READ an expired block is just filtered');
  assert.throws(() => writePolicy(tmpDir(), { ...ok, max: 50 }), /không hợp lệ/);
});

test('policy: blocks expire; a sid:/pid: block dies with its process identity (a reused pid is not blocked)', () => {
  const dir = tmpDir();
  const now = 1_000_000;
  const blocks = [
    { owner: 'convo:1', label: 'a', until: now + 5000, at: now },
    { owner: 'convo:2', label: 'b', until: now - 1, at: now - 9 },
    { owner: 'pid:7', label: 'c', until: now + 5000, at: now, ident: { pid: 7, procStart: '111' } },
    { owner: 'sid:8', label: 'd', until: now + 5000, at: now, ident: { pid: 8, procStart: '222' } },
  ];
  fs.writeFileSync(policyFile(dir), JSON.stringify({ ...defaultPolicy(), blocks }));
  const startOf = (pid) => ({ 7: '111', 8: '999' })[pid] ?? null; // pid 8 now belongs to another process
  assert.deepEqual(readPolicy(dir, { now, startOf }).policy.blocks.map((b) => b.owner), ['convo:1', 'pid:7']);
  assert.equal(blockActive(blocks[2], { now, startOf: () => null }), false, 'pid gone');
  assert.equal(pruneForWrite({ ...defaultPolicy(), blocks, boosts: { a: 1, b: 2 } }, { now, tickets: new Set(['a']), startOf }).boosts.b, undefined, 'boost of a vanished ticket dropped');
});

test('parseDuration: 30m, 1h, 2h30m, today; junk refused', () => {
  const now = new Date(2026, 10, 3, 10, 0, 0).getTime();
  assert.equal(parseDuration('30m', { now }).until, now + 30 * 60_000);
  assert.equal(parseDuration('1h', { now }).until, now + 3600_000);
  assert.equal(parseDuration('2h30m', { now }).until, now + 150 * 60_000);
  assert.equal(parseDuration('today', { now }).until, new Date(2026, 10, 4, 0, 0, 0).getTime());
  for (const bad of ['', 'abc', '0m', '30', 'h', '1x', '999h']) assert.ok(parseDuration(bad, { now }).error, bad);
});

// ── queueOrder boosts ──

test('queueOrder: newest boost first (ties by name), then the fair order; no boosts = unchanged', () => {
  const T = (name, owner, status = 'live') => ({ name, owner, status, pid: 1, v: TICKET_V });
  const q = [T('1', 'A'), T('2', 'A'), T('3', 'B'), T('4', 'C')];
  const plain = queueOrder(q, { fair: true }).map((t) => t.name);
  assert.deepEqual(plain, ['1', '3', '4', '2']);
  assert.deepEqual(queueOrder(q, { fair: true, boosts: {} }).map((t) => t.name), plain, 'fair order untouched without boosts');
  assert.deepEqual(queueOrder(q, { fair: true, boosts: { 4: 100, 2: 200 } }).map((t) => t.name), ['2', '4', '1', '3'], 'newest boost (2) first');
  assert.deepEqual(queueOrder(q, { fair: true, boosts: { 4: 100, 2: 100 } }).map((t) => t.name), ['2', '4', '1', '3'], 'same instant: by name');
  assert.deepEqual(queueOrder([T('1', 'A'), T('2', 'B', 'stalled')], { boosts: { 2: 5 } }).map((t) => t.name), ['1', '2'], 'only live tickets are boosted');
});

test('hasPreBoostWaiter: a live ticket without v ≥ 29 switches boosts off everywhere', () => {
  const old = { name: '1', owner: 'A', status: 'live', pid: 1 };
  const neu = { name: '2', owner: 'B', status: 'live', pid: 2, v: TICKET_V };
  assert.equal(hasPreBoostWaiter([old, neu]), true);
  assert.equal(hasPreBoostWaiter([neu, { ...old, status: 'stalled' }]), false, 'only LIVE ones count');
  assert.deepEqual(queueOrder([old, neu], { boosts: { 2: 99 } }).map((t) => t.name), ['1', '2'], 'boost ignored while the old waiter is in line');
  assert.deepEqual(queueOrder([{ ...old, v: TICKET_V }, neu], { boosts: { 2: 99 } }).map((t) => t.name), ['2', '1']);
});

// ── admission ──

test('admission: no policy file → plain behaviour (runs at once; a waiter queues with a v:29 ticket)', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, label: 'H', convoId: 'H', waitSec: 5, ...base });
  assert.ok(h.release);
  const w = waiter(dir, 'W'); await queued(dir, 1);
  assert.equal(readQueue('build', { dir })[0].v, TICKET_V);
  h.release();
  (await w).release();
});

test('admission: max counts live, stalled and stopped tickets; over max → refused full with retryMin', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  setPolicy(dir, { max: 2, retryMin: 7 });
  const w1 = waiter(dir, 'W1'); await queued(dir, 1);
  const w2 = waiter(dir, 'W2'); await queued(dir, 2);
  assert.equal(readQueue('build', { dir })[0].v, TICKET_V);
  const r = await acquireLock('build', { dir, label: 'W3', convoId: 'W3', waitSec: 5, ...base });
  assert.deepEqual(r, { refused: 'full', max: 2, retryMin: 7 });
  assert.equal(readQueue('build', { dir }).length, 2, 'no ticket written for a refused caller');
  // a stalled ticket (no heartbeat) still counts toward max
  const [first] = readQueue('build', { dir });
  fs.utimesSync(first.file, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  assert.equal(readQueue('build', { dir })[0].status, 'stalled');
  assert.equal((await acquireLock('build', { dir, label: 'W4', convoId: 'W4', waitSec: 5, ...base })).refused, 'full');
  cancelTickets('build', () => true, { dir });
  await Promise.all([w1, w2]);
  h.release();
});

test('admission: max 0, nobody waiting, slot free → "build now" holding exactly ONE slot; with a waiter / paused → full', async () => {
  const dir = tmpDir();
  setPolicy(dir, { max: 0 });
  const l = await acquireLock('build', { dir, label: 'N', convoId: 'N', waitSec: 5, ...base });
  assert.ok(l.release, 'ran at once despite max 0');
  assert.equal(l.slot, 0);
  assert.equal(probe(dir), 'busy', 'slot 0 is held (by this very process)');
  assert.equal(readQueue('build', { dir }).length, 0, 'the ticket was claimed and dropped');
  assert.equal(fs.readdirSync(lockPaths('build', dir).queue).filter((f) => f.endsWith('.acq') || f.endsWith('.json')).length, 0);
  // slot taken → max 0 means no queue at all
  assert.deepEqual((await acquireLock('build', { dir, label: 'X', convoId: 'X', waitSec: 5, ...base })), { refused: 'full', max: 0, retryMin: 10 });
  l.release();
  assert.equal(probe(dir), 'free', 'released');
  // paused: the exception is off
  setPolicy(dir, { max: 0, paused: true });
  assert.equal((await acquireLock('build', { dir, label: 'P', convoId: 'P', waitSec: 5, ...base })).refused, 'full');
  assert.equal(probe(dir), 'free', 'a refused caller keeps no slot');
});

test('admission: max 0 with someone already waiting → full (no "build now")', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  const w = waiter(dir, 'W'); await queued(dir, 1);
  setPolicy(dir, { max: 0 });
  h.release();
  assert.equal((await acquireLock('build', { dir, label: 'Z', convoId: 'Z', waitSec: 5, ...base })).refused, 'full');
  (await w).release();
});

test('admission: two simultaneous callers never exceed max (the policy lock serialises the check + the write)', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  setPolicy(dir, { max: 1 });
  const rs = await Promise.all([1, 2, 3, 4].map((i) => acquireLock('build', { dir, label: `C${i}`, convoId: `C${i}`, waitSec: 0.4, ...base, pollMs: 20 })));
  const refused = rs.filter((r) => r.refused === 'full').length;
  assert.equal(refused, 3, 'exactly one got a ticket');
  assert.equal(rs.filter((r) => r.timeout).length, 1, 'that one waited and timed out');
  h.release();
});

test('admission: policy lock not obtained in time → refused busy (never fail-open), nothing written', async () => {
  const dir = tmpDir();
  setPolicy(dir, { max: 5 });
  const release = await acquireHelperLock('build.policy', { dir, waitMs: 1000 });
  const t = Date.now();
  const r = await acquireLock('build', { dir, label: 'B', convoId: 'B', waitSec: 5, ...base, policyWaitMs: 300 });
  release();
  assert.deepEqual(r, { refused: 'busy' });
  assert.ok(Date.now() - t < 3000);
  assert.equal(readQueue('build', { dir }).length, 0);
});

test('admission: a caller WITHOUT policy never gets `refused` (cleanup / merge / old callers), whatever the policy says', async () => {
  const dir = tmpDir();
  setPolicy(dir, { max: 0, paused: false, blocks: [{ owner: 'convo:Q', label: 'Q', until: Date.now() + 60_000, at: Date.now() }] });
  const l = await acquireLock('build', { dir, label: 'Q', convoId: 'Q', waitSec: 2, slots: 1, pollMs: 30 });
  assert.ok(l.release && !l.refused, 'no policy flag → ignores max and the block');
  const r = await acquireLock('build', { dir, label: 'Q2', convoId: 'Q2', waitSec: 0.2, slots: 1, pollMs: 30 });
  assert.equal(r.refused, undefined);
  assert.equal(r.timeout, true);
  l.release();
});

test('admission: corrupt policy → no restriction (warned once)', async () => {
  const dir = tmpDir();
  fs.writeFileSync(policyFile(dir), 'garbage');
  const warns = [];
  const l = await acquireLock('build', { dir, label: 'C', convoId: 'C', waitSec: 5, ...base, warn: (m) => warns.push(m) });
  assert.ok(l.release);
  assert.ok(warns.some((m) => /build\.policy\.json hỏng/.test(m)));
  l.release();
});

// ── block ──

test('block: a blocked owner is refused with `until` — even when a slot is free; other owners are not', async () => {
  const dir = tmpDir();
  const until = Date.now() + 600_000;
  setPolicy(dir, { blocks: [{ owner: 'convo:Bad', label: 'Bad', until, at: Date.now() }] });
  assert.deepEqual(await acquireLock('build', { dir, label: 'Bad', convoId: 'Bad', waitSec: 5, ...base }), { refused: 'blocked', until });
  assert.equal(probe(dir), 'free');
  const ok = await acquireLock('build', { dir, label: 'Good', convoId: 'Good', waitSec: 5, ...base });
  assert.ok(ok.release);
  ok.release();
  // expired → gone
  setPolicy(dir, { blocks: [{ owner: 'convo:Bad', label: 'Bad', until: Date.now() + 1, at: Date.now() }] });
  await sleep(10);
  const again = await acquireLock('build', { dir, label: 'Bad', convoId: 'Bad', waitSec: 5, ...base });
  assert.ok(again.release, 'block expired by itself');
  again.release();
});

test('block: a waiter blocked mid-wait (ticket kicked) exits blocked(79), not "kicked"(76); the ticket is gone', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  const w = waiter(dir, 'V'); await queued(dir, 1);
  const until = Date.now() + 600_000;
  setPolicy(dir, { blocks: [{ owner: 'convo:V', label: 'V', until, at: Date.now() }] });
  assert.equal(cancelTickets('build', (t) => t.label === 'V', { dir, ext: 'kicked' }).length, 1);
  assert.deepEqual(await w, { refused: 'blocked', until });
  assert.equal(fs.readdirSync(lockPaths('build', dir).queue).length, 0, 'ticket + .kicked removed');
  h.release();
});

test('block: the final check (under the policy lock, before the claim) catches a block that landed after the flock win', async () => {
  const dir = tmpDir();
  const until2 = Date.now() + 600_000;
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  const w = acquireLock('build', {
    dir, label: 'V', convoId: 'V', waitSec: 10, ...base,
    afterWin: () => setPolicy(dir, { blocks: [{ owner: 'convo:V', label: 'V', until: until2, at: Date.now() }] }),
  });
  await queued(dir, 1);
  h.release();
  assert.deepEqual(await w, { refused: 'blocked', until: until2 });
  assert.equal(probe(dir), 'free', 'the slot it won was given back');
  assert.equal(fs.readdirSync(lockPaths('build', dir).queue).length, 0);
});

// ── pause ──

test('pause: waiters do not try the flock (build.lock stays free); resume lets the head through', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  const msgs = [];
  const w = acquireLock('build', { dir, label: 'W', convoId: 'W', waitSec: 20, ...base, onWait: (hh, ms, q) => msgs.push(q.paused) });
  await until(() => readQueue('build', { dir }).length === 1);
  setPolicy(dir, { paused: true });
  h.release();
  await sleep(400);
  assert.equal(probe(dir), 'free', 'free lock, a head waiter — and nobody took it');
  assert.ok(msgs.includes(true), 'onWait learns about the pause');
  setPolicy(dir, { paused: false });
  const l = await w;
  assert.ok(l.release);
  l.release();
});

test('pause: the final check releases a slot won just as the owner paused; no claim', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  let paused = false;
  const w = acquireLock('build', { dir, label: 'W', convoId: 'W', waitSec: 20, ...base, afterWin: async () => { if (!paused) { paused = true; setPolicy(dir, { paused: true }); } } });
  await until(() => readQueue('build', { dir }).length === 1);
  h.release();
  await until(() => paused);
  await sleep(300);
  assert.equal(probe(dir), 'free', 'slot given back');
  assert.equal(readQueue('build', { dir }).length, 1, 'still waiting, not claimed (.acq)');
  setPolicy(dir, { paused: false });
  const l = await w;
  assert.ok(l.release);
  l.release();
});

test('pause: a plain try-once is busy; the EXCLUSIVE try-once (cleanup) still runs although waiters exist', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  const w = waiter(dir, 'W'); await queued(dir, 1);
  setPolicy(dir, { paused: true });
  await sleep(150); // the waiter has seen the pause
  h.release();
  await sleep(150);
  assert.equal(probe(dir), 'free', 'nobody is trying for the lock');
  const plain = await acquireLock('build', { dir, waitSec: 0, convoId: 'T', slots: 1 });
  assert.equal(plain.timeout, true, 'try-once while paused = busy');
  const ex = await acquireLock('build', { dir, waitSec: 0, exclusive: true, slots: 1, cmd: 'cleanup' });
  assert.ok(ex.release && ex.slot === 0, 'cleanup runs although a live ticket is waiting');
  ex.release();
  // not paused: the live waiter keeps the exclusive try-once out, as before
  setPolicy(dir, { paused: false });
  await sleep(100);
  const w2 = await w; // the waiter takes the free lock once resumed
  assert.ok(w2.release);
  w2.release();
});

test('kick: a `.kicked` ticket → the waiter exits left+kicked (76); vanished-without-marker is still put back', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  const w = waiter(dir, 'K'); await queued(dir, 1);
  const struck = cancelTickets('build', (t) => t.label === 'K', { dir, ext: 'kicked' });
  assert.equal(struck[0].struckAs, 'kicked');
  assert.equal(readStruck('build', { dir })[0].status, 'kicked');
  const r = await w;
  assert.equal(r.left, true);
  assert.equal(r.kicked, true);
  assert.equal(fs.readdirSync(lockPaths('build', dir).queue).length, 0, '.kicked cleaned like .left');
  // a plain `.left` is not "kicked"
  const w2 = waiter(dir, 'L'); await queued(dir, 1);
  cancelTickets('build', (t) => t.label === 'L', { dir });
  const r2 = await w2;
  assert.equal(r2.left, true);
  assert.equal(r2.kicked, undefined);
  h.release();
});

test('kick: racing the claim — exactly one side wins (kick between flock win and claim → waiter does not run)', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  let kicked = false;
  const w = acquireLock('build', { dir, label: 'R', convoId: 'R', waitSec: 20, ...base, beforeClaim: async (ticket) => { kicked = true; fs.renameSync(ticket, ticket.replace(/\.json$/, '.kicked')); } });
  await until(() => readQueue('build', { dir }).length === 1);
  h.release();
  const r = await w;
  assert.ok(kicked);
  assert.equal(r.kicked, true);
  assert.equal(probe(dir), 'free', 'the waiter gave the lock back');
  // other order: the waiter claims first → the kick finds no `.json`
  const w2 = acquireLock('build', { dir, label: 'S', convoId: 'S', waitSec: 20, ...base });
  const l = await w2;
  assert.equal(cancelTickets('build', () => true, { dir, ext: 'kicked' }).length, 0, 'a claimed (running) build can never be kicked');
  l.release();
});

test('policy lock helpers: withPolicyLock reports busy instead of waiting forever', async () => {
  const dir = tmpDir();
  const rel = await acquireHelperLock('build.policy', { dir, waitMs: 500 });
  const r = await withPolicyLock(dir, () => 1, { waitMs: 200, pollMs: 30 });
  rel();
  assert.deepEqual(r, { busy: true });
  assert.deepEqual(await withPolicyLock(dir, () => 7, { waitMs: 200 }), { value: 7 });
});

// ── failure modes ──

test('ticket cannot be written (policy caller) → refused busy and NO slot kept — never "run without a ticket"', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockPaths('build', dir).queue, 'a file where the queue dir should be'); // mkdir/write of tickets fails
  // free slot → the "build now" path writes the ticket after winning the flock
  const r = await acquireLock('build', { dir, label: 'F', convoId: 'F', waitSec: 5, ...base });
  assert.deepEqual(r, { refused: 'busy' });
  assert.equal(probe(dir), 'free', 'the slot it had won was released');
  // busy slot → the enqueue path
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  assert.deepEqual(await acquireLock('build', { dir, label: 'F2', convoId: 'F2', waitSec: 5, ...base }), { refused: 'busy' });
  h.release();
  // the old behaviour (no policy flag) is unchanged: warn and wait without a ticket
  const warns = [];
  const l = await acquireLock('build', { dir, label: 'OLD', convoId: 'OLD', waitSec: 2, slots: 1, pollMs: 30, warn: (m) => warns.push(m) });
  assert.ok(l.release);
  assert.ok(warns.some((m) => /không ghi được vé/.test(m)));
  l.release();
});

test('a vanished ticket is put back; if it cannot be put back 3 beats in a row, the policy caller leaves with busy', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  const warns = [];
  const w = waiter(dir, 'V', { warn: (m) => warns.push(m) });
  await queued(dir, 1);
  const [t] = readQueue('build', { dir });
  fs.unlinkSync(t.file); // pruned by someone who misjudged us
  await until(() => warns.some((m) => /đã ghi lại đúng chỗ cũ/.test(m)));
  assert.equal(readQueue('build', { dir }).length, 1, 'put back');
  // now make restoring impossible: remove the ticket, then take away write access to the queue dir
  const q = lockPaths('build', dir).queue;
  const [t2] = readQueue('build', { dir });
  if (process.getuid?.() === 0) { h.release(); (await Promise.race([w, sleep(10)])); return; } // root ignores modes: nothing to test
  fs.unlinkSync(t2.file);
  fs.chmodSync(q, 0o500); // (no await in between: the waiter cannot restore the ticket first)
  try {
    assert.deepEqual(await w, { refused: 'busy' });
  } finally { fs.chmodSync(q, 0o700); h.release(); }
});

test('no flock binary: the policy lock error propagates (heavy then runs unlocked, loudly) instead of becoming "busy"', async () => {
  const dir = tmpDir();
  const saved = process.env.PATH;
  process.env.PATH = path.join(dir, 'nowhere');
  try {
    await assert.rejects(acquireLock('build', { dir, label: 'N', convoId: 'N', waitSec: 5, ...base }), (e) => e.code === 'ENOENT' && (e.syscall === 'spawn flock' || e.path === 'flock'));
  } finally { process.env.PATH = saved; }
});

test('R1 claim failure: a ticket that vanishes between mineState and the claim does NOT run; slot given back; ticket restored; policy caller never throws', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, convoId: 'H', slots: 1 });
  let n = 0;
  const w = acquireLock('build', { dir, label: 'V', convoId: 'V', waitSec: 20, ...base, beforeClaim: async (ticket) => { if (n++ === 0) fs.unlinkSync(ticket); } });
  await queued(dir, 1);
  h.release();
  const l = await w; // 1st claim fails (ENOENT, no marker) → no run, restored, 2nd beat claims properly
  assert.ok(l.release, 'ran only after a successful claim');
  assert.ok(n >= 2, 'the failed claim was retried, not run');
  l.release();
  // if it can never be restored → busy, not a run
  const dir2 = tmpDir();
  const h2 = await acquireLock('build', { dir: dir2, waitSec: 0, convoId: 'H', slots: 1 });
  const q2 = lockPaths('build', dir2).queue;
  const w2 = acquireLock('build', { dir: dir2, label: 'V2', convoId: 'V2', waitSec: 20, ...base, beforeClaim: async (ticket) => { try { fs.unlinkSync(ticket); } catch {} fs.chmodSync(q2, 0o500); } });
  await queued(dir2, 1);
  h2.release();
  try {
    if (process.getuid?.() === 0) return;
    assert.deepEqual(await w2, { refused: 'busy' });
    assert.equal(probe(dir2), 'free');
  } finally { fs.chmodSync(q2, 0o700); }
});
