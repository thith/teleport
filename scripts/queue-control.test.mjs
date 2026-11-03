// RFC 29 — queue-control.mjs (the owner's operations), lock-queue.mjs CLI/formatQueue additions. Temp lock dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readQueue, lockPaths, readStruck, acquireHelperLock } from './machine-lock.mjs';
import { defaultPolicy, readPolicy, policyFile, writePolicy, TICKET_V } from './build-policy.mjs';
import {
  updatePolicy, setMax, stepMax, toggleMax, setRetry, setPaused, kickTicket, topTicket, blockPlan, blockOwner, unblockOwner, resetPolicy,
  writeNotice, readNotices, deliverNotices, resolveQueueTarget, blockMatches, parseBlockArgs, NOTICE_DIR,
} from './queue-control.mjs';
import { formatQueue, parseArgs, control } from './lock-queue.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-qctl-'));
const me = process.pid;
const myStart = String(spawnSync('cut', ['-d', ' ', '-f', '22', `/proc/${me}/stat`]).stdout).trim();
/** A ticket file for a live process (this test process), optionally pre-RFC 29 (no `v`). */
let seq = 0;
function ticket(dir, label, extra = {}) {
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  const name = `${String(1_700_000_000_000 + (seq++)).padStart(15, '0')}-${me}-${String(seq).padStart(6, 'a')}.json`;
  const body = { v: TICKET_V, pid: me, procStart: null, label, cmd: `cmd of ${label}`, worktree: '/w/repo', owner: `convo:${label}`, convoId: label, createdAt: Date.now() - 7 * 60_000, ...extra };
  if (body.v === undefined) delete body.v;
  fs.writeFileSync(path.join(q, name), JSON.stringify(body));
  return name;
}

test('updatePolicy: validated atomic write under the lock; busy lock → ⏳ and no write; corrupt file refuses every write', async () => {
  const dir = tmpDir();
  assert.equal((await setMax(dir, 4)).ok, true);
  assert.equal(readPolicy(dir).policy.max, 4);
  assert.equal((fs.statSync(policyFile(dir)).mode & 0o777), 0o600);
  const rel = await acquireHelperLock('build.policy', { dir, waitMs: 500 });
  const busy = await setMax(dir, 9, { waitMs: 200 });
  rel();
  assert.equal(busy.ok, false); assert.equal(busy.why, 'busy'); assert.match(busy.message, /bận/);
  assert.equal(readPolicy(dir).policy.max, 4, 'unchanged');
  fs.writeFileSync(policyFile(dir), '{broken');
  const r = await setMax(dir, 2);
  assert.equal(r.why, 'corrupt');
  assert.equal(fs.readFileSync(policyFile(dir), 'utf8'), '{broken', 'never overwritten behind the owner\'s back');
  assert.equal((await resetPolicy(dir)).ok, true, 'the explicit reset works');
  assert.equal(readPolicy(dir).corrupt, false);
  assert.deepEqual(readPolicy(dir).policy, defaultPolicy());
});

test('max: set / step / toggle; off remembers lastMax; out of range refused; retry 1..120; pause', async () => {
  const dir = tmpDir();
  assert.equal(readPolicy(dir).policy.lastMax, 4);
  await setMax(dir, 6);
  assert.deepEqual([readPolicy(dir).policy.max, readPolicy(dir).policy.lastMax], [6, 6]);
  await toggleMax(dir);
  assert.deepEqual([readPolicy(dir).policy.max, readPolicy(dir).policy.lastMax], [null, 6], 'off keeps 6');
  await stepMax(dir, -1);
  assert.equal(readPolicy(dir).policy.max, 6, 'off + minus/plus → back to lastMax (no step)');
  await stepMax(dir, +1);
  assert.equal(readPolicy(dir).policy.max, 7);
  await setMax(dir, 0); await stepMax(dir, -1);
  assert.equal(readPolicy(dir).policy.max, 0, 'floor 0');
  await setMax(dir, 20); await stepMax(dir, +1);
  assert.equal(readPolicy(dir).policy.max, 20, 'ceiling 20');
  assert.equal((await setMax(dir, 21)).ok, false);
  await setMax(dir, null);
  assert.equal(readPolicy(dir).policy.max, null);
  assert.equal((await setRetry(dir, 15)).ok, true);
  assert.equal(readPolicy(dir).policy.retryMin, 15);
  assert.equal((await setRetry(dir, 0)).ok, false);
  assert.equal((await setRetry(dir, 121)).ok, false);
  await setPaused(dir, true);
  assert.equal(readPolicy(dir).policy.paused, true);
});

test('kick: a v:29 ticket → .kicked + a "kicked" notice; a pre-RFC 29 ticket → .left; a vanished/claimed ticket → refused', async () => {
  const dir = tmpDir();
  const a = ticket(dir, 'A'), old = ticket(dir, 'OLD', { v: undefined });
  const r = await kickTicket(dir, { name: a, pid: me });
  assert.equal(r.ok, true);
  const q = lockPaths('build', dir).queue;
  assert.ok(fs.existsSync(path.join(q, a.replace('.json', '.kicked'))));
  assert.equal(readStruck('build', { dir }).find((t) => t.label === 'A').status, 'kicked');
  const r2 = await kickTicket(dir, { name: old, pid: me });
  assert.equal(r2.ok, true);
  assert.ok(fs.existsSync(path.join(q, old.replace('.json', '.left'))), 'old code does not know .kicked → .left');
  const notices = readNotices(dir).map((n) => n.notice);
  assert.deepEqual(notices.map((n) => [n.kind, n.convoId]), [['kicked', 'A'], ['kicked', 'OLD']]);
  assert.equal(notices[0].cmd, 'cmd of A');
  assert.equal(notices[0].worktree, '/w/repo');
  // the ticket was claimed meanwhile (.acq): refused, no notice
  const c = ticket(dir, 'C');
  fs.renameSync(path.join(q, c), path.join(q, c.replace('.json', '.acq')));
  const r3 = await kickTicket(dir, { name: c, pid: me });
  assert.equal(r3.ok, false);
  assert.match(r3.message, /⏹/, 'points at the stop button');
  assert.equal(readNotices(dir).length, 2);
  // wrong pid pin (the slot got a different process): refused
  const d = ticket(dir, 'D');
  assert.equal((await kickTicket(dir, { name: d, pid: me + 999999 })).ok, false);
  // kick works even when the policy file is corrupt (it writes no policy)
  fs.writeFileSync(policyFile(dir), 'xx');
  assert.equal((await kickTicket(dir, { name: d, pid: me })).ok, true);
});

test('top: boost = now; toggle removes it; refused while a pre-RFC 29 waiter is in line or the ticket is not live', async () => {
  const dir = tmpDir();
  const a = ticket(dir, 'A'), b = ticket(dir, 'B');
  assert.equal((await topTicket(dir, { name: b, pid: me })).value.boosted, true);
  assert.ok(readPolicy(dir).policy.boosts[b] > 0);
  assert.equal((await topTicket(dir, { name: b, pid: me, toggle: true })).value.boosted, false, 'press again → boost removed');
  assert.equal(readPolicy(dir).policy.boosts[b], undefined);
  const old = ticket(dir, 'OLD', { v: undefined });
  const r = await topTicket(dir, { name: a, pid: me });
  assert.equal(r.ok, false);
  assert.match(r.message, /code cũ/);
  fs.unlinkSync(path.join(lockPaths('build', dir).queue, old));
  assert.equal((await topTicket(dir, { name: 'nope.json' })).ok, false);
  const out = formatQueue('build', { dir, now: Date.now() });
  assert.ok(out.some((l) => /1\. A/.test(l)), 'A first (no boost)');
  await topTicket(dir, { name: b, pid: me });
  const out2 = formatQueue('build', { dir, now: Date.now() });
  assert.ok(out2.find((l) => /1\./.test(l)).includes('B'), 'formatQueue honours boosts (same queueOrder as the waiters)');
});

test('block: owner written with ident, every waiting ticket of that owner kicked (one notice each, kind blocked + until); unblock; expiry', async () => {
  const dir = tmpDir();
  const a1 = ticket(dir, 'A'), a2 = ticket(dir, 'A'), b = ticket(dir, 'B');
  const until = Date.now() + 3600_000;
  const r = await blockOwner(dir, { owner: 'convo:A', label: '🐭 A', until });
  assert.equal(r.ok, true);
  assert.equal(r.value.struck.length, 2);
  assert.deepEqual(readPolicy(dir).policy.blocks.map((x) => [x.owner, x.until]), [['convo:A', until]]);
  assert.deepEqual(readQueue('build', { dir }).map((t) => t.name), [b], 'only B still waits');
  const n = readNotices(dir).map((x) => x.notice);
  assert.deepEqual(n.map((x) => [x.kind, x.until]), [['blocked', until], ['blocked', until]]);
  assert.equal((await blockOwner(dir, { owner: 'convo:A', label: 'A', until: Date.now() - 5 })).ok, false, 'a block in the past is refused');
  assert.equal((await unblockOwner(dir, 'convo:A')).ok, true);
  assert.equal(readPolicy(dir).policy.blocks.length, 0);
  assert.equal((await unblockOwner(dir, 'convo:A')).ok, false);
  void a1; void a2;
});

test('blockPlan: convo / git (warns: WHOLE repo) / sid / pid (ident pinned to the process start)', () => {
  assert.match(blockPlan({ owner: 'convo:7', label: '🐭 Chuột', pid: 1 }).scope, /^chặn 🐭 Chuột \(convo 7\)$/);
  const g = blockPlan({ owner: 'git:/home/x/proj/.git', label: 'L', pid: 1 });
  assert.equal(g.warn, true);
  assert.match(g.scope, /⚠️ vé không có convo — chặn CẢ REPO proj/);
  const s = blockPlan({ owner: 'sid:555', label: 'L', pid: 9 }, { stat: (p) => (p === 555 ? { start: '4242' } : null) });
  assert.deepEqual(s.ident, { pid: 555, procStart: '4242' });
  assert.match(s.scope, /tiến trình\/phiên này/);
  const p = blockPlan({ owner: 'pid:9', label: 'L', pid: 9, procStart: '77' });
  assert.deepEqual(p.ident, { pid: 9, procStart: '77' });
});

test('notices: outbox files delivered through deliver() into the convo, then removed; no convo → just removed; failed delivery stays', async () => {
  const dir = tmpDir();
  writeNotice(dir, { kind: 'kicked', convoId: '5', cmd: 'cargo test', worktree: '/w/r' });
  writeNotice(dir, { kind: 'blocked', convoId: null, cmd: 'x', worktree: null, until: 5 });
  assert.equal(fs.readdirSync(path.join(dir, NOTICE_DIR)).length, 2);
  const got = [];
  const n = await deliverNotices({ dir, deliver: async (r, o) => { got.push([r, o]); }, build: 'BUILD' });
  assert.equal(n, 2);
  assert.equal(got.length, 1, 'the convo-less one is only deleted');
  assert.equal(got[0][0].convoId, '5');
  assert.equal(got[0][0].kind, 'kicked');
  assert.match(got[0][0].text, /cargo test \(worktree r\)/);
  assert.equal(got[0][1].build, 'BUILD');
  assert.equal(fs.readdirSync(path.join(dir, NOTICE_DIR)).length, 0);
  writeNotice(dir, { kind: 'kicked', convoId: '5', cmd: 'c', worktree: null });
  const logs = [];
  assert.equal(await deliverNotices({ dir, deliver: async () => { throw new Error('queue down'); }, log: (m) => logs.push(m) }), 0);
  assert.equal(readNotices(dir).length, 1, 'kept for the next beat');
  assert.match(logs[0], /queue down/);
});

test('resolveQueueTarget: tiers in order, exactly one convo, multi-word persona, #hash, ambiguity lists candidates', () => {
  const t1 = [{ convoId: '1', names: ['🐭 Chuột'], hashtag: 'a1111111' }, { convoId: '2', names: ['🦈 Cá Mập'], hashtag: 'a2222222' }];
  const t2 = [{ convoId: '3', names: ['🐭 Chuột'], hashtag: 'a3333333' }, { convoId: '4', names: ['🦉 Cú'], hashtag: 'a4444444' }];
  assert.equal(resolveQueueTarget('Chuột', [t1, t2]).convoId, '1', 'first tier with a hit wins (an agent in the queue beats a live namesake)');
  assert.equal(resolveQueueTarget('Cá Mập', [t1, t2]).convoId, '2', 'multi-word persona');
  assert.equal(resolveQueueTarget('cú', [t1, t2]).convoId, '4', 'falls to tier 2; case-insensitive');
  assert.equal(resolveQueueTarget('#a4444444', [t1, t2]).convoId, '4');
  const amb = resolveQueueTarget('Chuột', [[...t1, { convoId: '9', names: ['🐭 Chuột'], hashtag: 'a9999999' }]]);
  assert.match(amb.error, /khớp 2 convo/);
  assert.match(amb.error, /convo 1/); assert.match(amb.error, /convo 9/);
  assert.match(resolveQueueTarget('Ma', [t1, t2]).error, /không thấy/);
  assert.equal(resolveQueueTarget('Chuột', [[{ convoId: '1', names: ['🐭 Chuột'] }, { convoId: '1', names: ['Chuột'] }]]).convoId, '1', 'one convo seen twice is still one');
});

test('parseBlockArgs: the LAST token is the duration, the rest the target (multi-word persona)', () => {
  const now = 1_000_000;
  assert.deepEqual(parseBlockArgs('Cá Mập 1h', { now }), { target: 'Cá Mập', until: now + 3600_000 });
  assert.equal(parseBlockArgs('3 30m', { now }).target, '3');
  assert.ok(parseBlockArgs('Chuột', { now }).error);
  assert.ok(parseBlockArgs('Chuột soon', { now }).error);
});

test('blockMatches: direct match on policy.blocks incl. git:/sid:/pid: owners, #hash and persona', () => {
  const b = { owner: 'git:/x/.git', label: 'repo' };
  assert.equal(blockMatches(b, 'git:/x/.git'), true);
  assert.equal(blockMatches({ owner: 'convo:1', label: '🐭 Chuột #a1' }, 'chuột'), true);
  assert.equal(blockMatches({ owner: 'convo:1', label: '🐭 Chuột' }, 'Cú'), false);
  assert.equal(blockMatches({ owner: 'pid:9', label: 'x' }, 'pid:9'), true);
});

// ── lock-queue.mjs: formatQueue / CLI ──

test('formatQueue: paused header (no "chỗ trống" / "đang nhận lock"), kicked ticket status, ids', async () => {
  const dir = tmpDir();
  const a = ticket(dir, 'A');
  await setPaused(dir, true);
  const lines = formatQueue('build', { dir, now: Date.now(), ids: true });
  assert.match(lines[0], /⏸ tạm dừng phát chỗ/);
  assert.doesNotMatch(lines[0], /chỗ trống|đang nhận lock/);
  assert.ok(lines.some((l) => l.includes(a) && l.includes('convo:A')), '--ids shows the file name and the owner');
  await kickTicket(dir, { name: a, pid: me });
  assert.ok(formatQueue('build', { dir, now: Date.now() }).some((l) => /bị kick \(đang rời\)/.test(l)));
});

test('lock-queue CLI: parseArgs for max / retry / kick / top / block / unblock / pause / resume', () => {
  assert.deepEqual(parseArgs(['max', '4']), { cmd: 'max', value: 4 });
  assert.deepEqual(parseArgs(['max', 'off']), { cmd: 'max', value: null });
  assert.ok(parseArgs(['max', '21']).error); assert.ok(parseArgs(['max']).error); assert.ok(parseArgs(['max', 'x']).error);
  assert.deepEqual(parseArgs(['retry', '15']), { cmd: 'retry', value: 15 });
  assert.ok(parseArgs(['retry', '0']).error);
  assert.deepEqual(parseArgs(['kick', 'T.json']), { cmd: 'kick', target: 'T.json' });
  assert.deepEqual(parseArgs(['block', 'convo:5', '1h']), { cmd: 'block', target: 'convo:5', duration: '1h' });
  assert.ok(parseArgs(['block', 'convo:5', 'soon']).error);
  assert.deepEqual(parseArgs(['pause']), { cmd: 'pause' });
  assert.ok(parseArgs(['pause', 'x']).error);
  assert.equal(parseArgs(['ls', '--ids']).ids, true);
});

test('lock-queue CLI: control() runs the operations against the lock dir', async () => {
  const dir = tmpDir();
  const a = ticket(dir, 'A'), b = ticket(dir, 'B');
  assert.equal((await control(parseArgs(['max', '3']), { dir })).code, 0);
  assert.equal(readPolicy(dir).policy.max, 3);
  assert.equal((await control(parseArgs(['top', b]), { dir })).code, 0);
  assert.ok(readPolicy(dir).policy.boosts[b]);
  assert.equal((await control(parseArgs(['pause']), { dir })).code, 0);
  assert.equal(readPolicy(dir).policy.paused, true);
  const k = await control(parseArgs(['kick', a]), { dir });
  assert.equal(k.code, 0);
  assert.equal(readNotices(dir).length, 1, 'the CLI writes the outbox notice too');
  assert.equal((await control(parseArgs(['kick', 'nope.json']), { dir })).code, 1);
  const bl = await control(parseArgs(['block', b, '30m']), { dir });
  assert.equal(bl.code, 0);
  assert.equal(readPolicy(dir).policy.blocks[0].owner, 'convo:B');
  assert.equal((await control(parseArgs(['unblock', 'convo:B']), { dir })).code, 0);
  assert.equal((await control(parseArgs(['resume']), { dir })).code, 0);
  const cli = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'lock-queue.mjs'), 'max', 'banana'], { encoding: 'utf8' });
  assert.equal(cli.status, 2, 'usage error exits 2');
});
