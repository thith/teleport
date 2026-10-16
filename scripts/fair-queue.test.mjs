// RFC 24 part A — fair build queue between owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, readQueue, lockPaths, gitCommonDir, ownerOf, recordOwner, queueOrder, markServed, readServed, SERVED_MAX_AGE_MS, SERVED_PRUNE_MS } from './machine-lock.mjs';
import { formatQueue } from './lock-queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-fair-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 10_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(50); } };
async function queuedFor(dir, label) { await until(() => readQueue('build', { dir }).some((t) => t.label === label)); }

function child(dir, label, convoId, { slots = 1 } = {}) {
  const code = `
    import { acquireLock } from ${JSON.stringify(path.join(HERE, 'machine-lock.mjs'))};
    const l = await acquireLock('build', { dir: ${JSON.stringify(dir)}, label: ${JSON.stringify(label)}, pollMs: 40, convoId: ${JSON.stringify(convoId)}, slots: ${slots} });
    console.log('got ${label} ' + Date.now());
    await new Promise((r) => setTimeout(r, 150));
    l.release();`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.done = new Promise((r) => p.on('close', r));
  return p;
}
const gotAt = (p) => Number((/got \S+ (\d+)/.exec(p.out) || [])[1]);

test('gitCommonDir: a .git dir, a worktree .git file + commondir; ownerOf chain convo → git → session → pid', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'main', '.git', 'worktrees', 'w1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main', '.git', 'worktrees', 'w1', 'commondir'), '../..\n');
  fs.mkdirSync(path.join(root, 'w1'));
  fs.writeFileSync(path.join(root, 'w1', '.git'), `gitdir: ${path.join(root, 'main', '.git', 'worktrees', 'w1')}\n`);
  assert.equal(gitCommonDir(path.join(root, 'main')), path.join(root, 'main', '.git'));
  assert.equal(gitCommonDir(path.join(root, 'w1')), path.join(root, 'main', '.git'), 'every worktree of a repo → one owner');
  assert.equal(gitCommonDir(null), null);
  assert.equal(ownerOf({ convoId: '5', worktree: path.join(root, 'w1'), pid: 1 }), 'convo:5');
  assert.equal(ownerOf({ worktree: path.join(root, 'w1'), pid: 1 }), `git:${path.join(root, 'main', '.git')}`);
  assert.equal(ownerOf({ pid: 7 }, { commonDir: () => null, stat: () => ({ session: '42' }) }), 'sid:42');
  assert.equal(ownerOf({ pid: 7 }, { commonDir: () => null, stat: () => null }), 'pid:7');
  assert.equal(recordOwner({ owner: 'x', convoId: '5' }), 'x');
  assert.equal(recordOwner({ convoId: '5' }), 'convo:5', 'older records: fallback chain');
});

test('queueOrder: FIFO for non-fair locks; fair = (rank incl. running builds, last service, name); non-live last', () => {
  const T = (name, owner, status = 'live') => ({ name, owner, status, pid: 1 });
  const q = [T('1', 'A'), T('2', 'A'), T('3', 'A'), T('4', 'B'), T('0', 'C', 'stalled')];
  assert.deepEqual(queueOrder(q).map((t) => t.name), ['1', '2', '3', '4', '0']);
  assert.deepEqual(queueOrder(q, { fair: true }).map((t) => t.name), ['1', '4', '2', '3', '0'], 'first ticket of every owner, then the second…');
  assert.deepEqual(queueOrder(q, { fair: true, running: [{ owner: 'A' }] }).map((t) => t.name), ['4', '1', '2', '3', '0'], 'A already runs a build → B first');
  assert.deepEqual(queueOrder([T('1', 'A'), T('4', 'B')], { fair: true, served: { A: 100 } }).map((t) => t.name), ['4', '1'], 'same rank: served longest ago first');
  assert.deepEqual(queueOrder([T('1', 'A'), T('4', 'B')], { fair: true, served: { A: 100, B: 200 } }).map((t) => t.name), ['1', '4']);
});

test('served ledger: one file per owner (concurrent winners never overwrite), old entries pruned', () => {
  const dir = tmpDir();
  markServed('build', 'convo:1', { dir, now: 1_000_000 });
  markServed('build', 'convo:2', { dir, now: 2_000_000 });
  assert.deepEqual(readServed('build', { dir, now: 2_000_000 }), { 'convo:1': 1_000_000, 'convo:2': 2_000_000 });
  assert.deepEqual(readServed('build', { dir, now: 1_000_000 + SERVED_MAX_AGE_MS + 1, prune: true }), { 'convo:2': 2_000_000 }, 'ignored after 24 h');
  assert.equal(fs.readdirSync(path.join(dir, 'build.served')).length, 2, '…but not deleted yet (a prune must not race a refresh)');
  readServed('build', { dir, now: 2_000_000 + SERVED_PRUNE_MS + 1, prune: true });
  assert.equal(fs.readdirSync(path.join(dir, 'build.served')).length, 0, 'deleted after 7 days');
  assert.deepEqual(readServed('build', { dir: path.join(dir, 'nope') }), {});
});

test('fair, 1 slot, with release: A1 holds; A2, A3 then B1 queue → when A1 lets go, B1 goes before A2', async () => {
  const dir = tmpDir();
  const a1 = await acquireLock('build', { dir, waitSec: 0, label: 'A1', convoId: 'A' });
  const kids = {};
  for (const [l, c] of [['A2', 'A'], ['A3', 'A'], ['B1', 'B']]) { kids[l] = child(dir, l, c); await queuedFor(dir, l); await sleep(5); }
  const lines = formatQueue('build', { dir });
  assert.match(lines.join('\n'), /1\. B1[\s\S]*2\. A2[\s\S]*3\. A3/, 'the display shows the order waiters use');
  a1.release();
  await Promise.all(Object.values(kids).map((k) => k.done));
  assert.ok(gotAt(kids.B1) < gotAt(kids.A2), `B1 ${gotAt(kids.B1)} before A2 ${gotAt(kids.A2)}`);
  assert.ok(gotAt(kids.A2) < gotAt(kids.A3));
});

test('fair, 2 slots: A1 runs in one slot; when the other frees, B1 takes it before the older A2', async () => {
  const dir = tmpDir();
  const a1 = await acquireLock('build', { dir, waitSec: 0, label: 'A1', convoId: 'A', slots: 2 });
  const x = await acquireLock('build', { dir, waitSec: 0, label: 'X', convoId: 'X', slots: 2 });
  const a2 = child(dir, 'A2', 'A', { slots: 2 }); await queuedFor(dir, 'A2'); await sleep(5);
  const b1 = child(dir, 'B1', 'B', { slots: 2 }); await queuedFor(dir, 'B1');
  x.release();
  await Promise.all([a2.done, b1.done]);
  assert.ok(gotAt(b1) < gotAt(a2), `B1 ${gotAt(b1)} took the freed slot before the older A2 ${gotAt(a2)} (A already had a build running)`);
  a1.release();
});

test('merge stays FIFO', () => {
  const T = (name, convoId) => ({ name, convoId, status: 'live', pid: 1, createdAt: 0, label: name });
  const lines = formatQueue('merge', { holderOf: () => null, struck: () => [], read: () => [T('1', 'A'), T('2', 'A'), T('3', 'B')] });
  assert.match(lines.join('\n'), /1\. 1[\s\S]*2\. 2[\s\S]*3\. 3/);
});

test('gitCommonDir is canonical: a symlinked path to the repo gives the same owner', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
  fs.symlinkSync(path.join(root, 'repo'), path.join(root, 'alias'));
  assert.equal(gitCommonDir(path.join(root, 'alias')), gitCommonDir(path.join(root, 'repo')));
});

test('rollout: while an old-code ticket (no `owner`) waits, the queue is FIFO for everyone — a newer one never blocks us', async () => {
  const dir = tmpDir();
  const h = await acquireLock('build', { dir, waitSec: 0, label: 'H', convoId: 'H' });
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  // an old-code ticket NEWER than ours (far-future name), owner never served: must not block us
  const old = path.join(q, `999999999999999-${process.pid}-oldxxx.json`);
  fs.writeFileSync(old, JSON.stringify({ pid: process.pid, label: 'OLD', convoId: 'Z', createdAt: 0 }));
  const keep = setInterval(() => { try { const t = new Date(); fs.utimesSync(old, t, t); } catch {} }, 100);
  markServed('build', 'convo:me', { dir }); // we were just served: a fair order would put OLD (never served) first
  const p = acquireLock('build', { dir, waitSec: 5, pollMs: 40, label: 'me', convoId: 'me' });
  await sleep(100);
  h.release();
  const l = await p;
  clearInterval(keep);
  assert.ok(l.release, 'we got it: the newer old-code ticket did not count as ahead');
  l.release();
});

test('rollout: 3-way case (N1 owner A, O2 old code, N3 owner B, A running) → FIFO, so N1 goes first, no cycle', () => {
  const T = (name, owner) => ({ name, owner, status: 'live', pid: 1 });
  const tickets = [T('1', 'convo:A'), { name: '2', status: 'live', pid: 2, convoId: 'Z' }, T('3', 'convo:B')];
  const fair = !tickets.some((t) => t.status === 'live' && !t.owner);
  assert.equal(fair, false);
  assert.deepEqual(queueOrder(tickets, { fair, running: [{ owner: 'convo:A' }] }).map((t) => t.name), ['1', '2', '3']);
  const lines = formatQueue('build', { holderOf: () => null, struck: () => [], claimedOf: () => [], servedOf: () => ({}),
    read: () => tickets.map((t) => ({ ...t, label: `T${t.name}`, createdAt: 0 })) });
  assert.match(lines.join('\n'), /1\. T1[\s\S]*2\. T2[\s\S]*3\. T3/, 'the display shows the FIFO the waiters use');
});
