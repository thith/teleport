import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, readQueue, cancelTickets, ticketStatus, procStat, lockPaths } from './machine-lock.mjs';
import { leave, formatQueue, parseArgs } from './lock-queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-q-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait (≤10 s) until `label` has a ticket in the queue — child start-up time varies with load.
async function queuedFor(dir, label) { for (let i = 0; i < 200; i++) { if (readQueue('build', { dir }).some((t) => t.label === label)) return; await sleep(50); } throw new Error(`no ticket for ${label}`); }

// A child that takes lock `build` in `dir`, prints "got <label>", holds `holdMs`, exits.
function child(dir, label, holdMs, extra = {}) {
  const code = `
    import { acquireLock } from ${JSON.stringify(path.join(HERE, 'machine-lock.mjs'))};
    const l = await acquireLock('build', { dir: ${JSON.stringify(dir)}, label: ${JSON.stringify(label)}, pollMs: 50, convoId: ${JSON.stringify(extra.convoId ?? null)} });
    if (l.left) { console.log('left ${label}'); process.exit(0); }
    console.log('got ${label} ' + Date.now());
    await new Promise((r) => setTimeout(r, ${holdMs}));
    l.release();`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.done = new Promise((r) => p.on('close', r));
  return p;
}

test('FIFO: waiters get the lock in arrival order (no racing past an older waiter)', async () => {
  const dir = tmpDir();
  const order = [];
  const a = child(dir, 'A', 3000);
  for (let i = 0; i < 200 && !a.out.includes('got A'); i++) await sleep(50);
  const kids = [];
  for (const l of ['B', 'C', 'D', 'E']) { kids.push(child(dir, l, 150)); await queuedFor(dir, l); }
  const all = [a, ...kids];
  await Promise.all(all.map((k) => k.done));
  // (from each child's own "got X <ms>" line — a listener attached late could miss one)
  for (const k of all) for (const m of k.out.matchAll(/got (\w) (\d+)/g)) order.push([m[1], Number(m[2])]);
  assert.deepEqual(order.sort((x, y) => x[1] - y[1]).map((x) => x[0]), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(fs.readdirSync(lockPaths('build', dir).queue).filter((f) => !f.startsWith('.')), [], 'no tickets left behind');
});

test('try-once never jumps a LIVE waiter, but a stalled / stopped one does not block it', async () => {
  const dir = tmpDir();
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  const me = procStat(process.ppid);
  const mk = (age) => {
    const f = path.join(q, `${String(Date.now() - 5000).padStart(15, '0')}-${process.ppid}-abc.json`);
    fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, procStart: me.start, label: 'parent', createdAt: Date.now() }));
    const t = new Date(Date.now() - age); fs.utimesSync(f, t, t);
    return f;
  };
  const f = mk(0); // live, fresh heartbeat
  assert.equal((await acquireLock('build', { dir, waitSec: 0 })).timeout, true);
  fs.utimesSync(f, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // stalled
  const l = await acquireLock('build', { dir, waitSec: 0 });
  assert.ok(l.release, 'stalled ticket ignored');
  l.release();
  assert.ok(fs.existsSync(f), 'a stalled ticket of a live process is never deleted');
});


// The test process itself holds the lock (no child start-up race), and releases it when told.
async function holdHere(dir) { const l = await acquireLock('build', { dir, waitSec: 5, label: 'H', convoId: null }); assert.ok(l.release); return l; }

test('leave: a struck waiter exits without ever holding the lock; the next one goes on', async () => {
  const dir = tmpDir();
  const h = await holdHere(dir);
  const b = child(dir, 'B', 100, { convoId: '111' });
  await queuedFor(dir, 'B');
  const c = child(dir, 'C', 100, { convoId: '222' });
  await queuedFor(dir, 'C');
  const r = leave({ lock: 'build' }, { dir, convoId: '111' });
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /đã rời hàng build: B/);
  await b.done;
  h.release();
  await c.done;
  assert.match(b.out, /left B/);
  assert.doesNotMatch(b.out, /got B/);
  assert.match(c.out, /got C/);
});

test('leave: refuses without a convo; never matches daemon tickets (convoId null); a running job (holder or .acq) is reported', async () => {
  assert.equal(leave({}, { convoId: null }).code, 1);
  const dir = tmpDir();
  const h = await holdHere(dir);
  const w = child(dir, 'W', 50); // convoId null, daemon-like
  await queuedFor(dir, 'W');
  const r = leave({ lock: 'build' }, { dir, convoId: '999' });
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /Không có vé/);
  h.release();
  await w.done;
  assert.match(w.out, /got W/);
  const viaHolder = leave({ lock: 'build' }, { dir, convoId: '5', holderOf: () => ({ alive: true, pid: 1, convoId: '5', cmd: 'cargo test' }), cancel: () => [], claimed: () => [] });
  assert.match(viaHolder.lines.join('\n'), /đang chạy rồi \(cargo test\)/);
  const viaAcq = leave({ lock: 'build' }, { dir, convoId: '5', holderOf: () => null, cancel: () => [], claimed: () => [{ pid: 2, convoId: '5', cmd: 'gradle' }] });
  assert.match(viaAcq.lines.join('\n'), /đang chạy rồi \(gradle\)/);
});

test('atomic hand-off: struck between winning flock and the claim → the lock is given straight back', async () => {
  const dir = tmpDir();
  const r = await acquireLock('build', { dir, pollMs: 20, label: 'me', convoId: '7',
    beforeClaim: () => { assert.equal(cancelTickets('build', (t) => t.convoId === '7', { dir }).length, 1); } });
  assert.equal(r.left, true);
  assert.equal(r.timeout, true, 'old callers see a timeout');
  const next = await acquireLock('build', { dir, waitSec: 0 }); // the lock really was given back
  assert.ok(next.release);
  next.release();
});

test('struck while waiting (not at the head) → leaves on the next poll; a vanished ticket WITHOUT .left is put back', async () => {
  const dir = tmpDir();
  const h = await holdHere(dir);
  const warns = [];
  const p = acquireLock('build', { dir, pollMs: 20, label: 'w', convoId: '8', waitSec: 5, warn: (m) => warns.push(m) });
  await queuedFor(dir, 'w');
  const [t] = readQueue('build', { dir });
  fs.unlinkSync(t.file); // vanished, no .left
  await sleep(150);
  assert.ok(fs.existsSync(t.file), 'put back in the same place');
  assert.match(warns.join('\n'), /ghi lại đúng chỗ cũ/);
  cancelTickets('build', (x) => x.convoId === '8', { dir });
  const r = await p;
  assert.equal(r.left, true);
  h.release();
});

test('onWait fires again when the place in line changes; no exit listeners leak', async () => {
  const dir = tmpDir();
  const before = process.listenerCount('exit');
  const h = await holdHere(dir);
  const a = child(dir, 'A', 50);
  await queuedFor(dir, 'A');
  const seen = [];
  const p = acquireLock('build', { dir, pollMs: 20, noticeMs: 1e9, label: 'me', onWait: (hd, w, q) => seen.push(q.position) });
  await sleep(200);
  cancelTickets('build', (t) => t.label === 'A', { dir });
  await sleep(300);
  h.release();
  const l = await p;
  l.release();
  await a.done;
  assert.deepEqual([...new Set(seen)], [2, 1]);
  assert.equal(process.listenerCount('exit'), before);
});

test('an unwritable queue dir → old-style wait (warned), still exclusive — never unlocked', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'build.queue'), 'not a dir'); // mkdir of the queue fails
  const warns = [];
  const l = await acquireLock('build', { dir, warn: (m) => warns.push(m) });
  assert.ok(l.release);
  assert.match(warns.join('\n'), /không ghi được vé/);
  assert.equal((await acquireLock('build', { dir, waitSec: 0.1, pollMs: 20, warn: () => {} })).timeout, true, 'still exclusive');
  l.release();
});

test('ticketStatus: dead (gone / zombie / reused pid) vs stopped vs stalled vs live; only dead pruned', () => {
  const stat = (pid) => ({ 1: { state: 'S', start: '10' }, 2: { state: 'Z', start: '10' }, 3: { state: 'T', start: '10' } })[pid] || null;
  const now = 100_000;
  assert.equal(ticketStatus({ pid: 1, procStart: '10' }, now, { now, stat }), 'live');
  assert.equal(ticketStatus({ pid: 1, procStart: '11' }, now, { now, stat }), 'dead', 'pid reused');
  assert.equal(ticketStatus({ pid: 2, procStart: '10' }, now, { now, stat }), 'dead');
  assert.equal(ticketStatus({ pid: 9, procStart: '10' }, now, { now, stat }), 'dead');
  assert.equal(ticketStatus({ pid: 3, procStart: '10' }, now, { now, stat }), 'stopped');
  assert.equal(ticketStatus({ pid: 1, procStart: '10' }, now - 31_000, { now, stat }), 'stalled');
  const dir = tmpDir();
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  fs.writeFileSync(path.join(q, `${'1'.padStart(15, '0')}-999999-aa.json`), JSON.stringify({ pid: 999999, createdAt: 1 }));
  assert.equal(readQueue('build', { dir }).length, 1, 'a read-only look (/health) deletes nothing');
  assert.equal(readQueue('build', { dir, prune: true }).length, 0);
  assert.equal(fs.readdirSync(q).length, 0, 'dead ticket deleted by a pruning waiter');
});

test('formatQueue (for /health and ls): holder, order, every status incl. struck; parseArgs', () => {
  const now = 10 * 60_000;
  const lines = formatQueue('build', { now, holderOf: () => ({ alive: true, pid: 1, label: '🧚 Tiên', cmd: 'cargo test', startedAt: 0 }),
    read: () => [{ name: 'b.json', status: 'live', pid: 2, label: '🐭 Chuột', cmd: 'clip', createdAt: 5 * 60_000 }, { name: 'd.json', status: 'stopped', pid: 4, createdAt: 0 }, { name: 'c.json', status: 'stalled', pid: 3, createdAt: 0 }],
    struck: () => [{ name: 'a.left', pid: 5, label: 'X', createdAt: 0 }] });
  assert.match(lines[0], /build: đang giữ — 🧚 Tiên — cargo test/);
  assert.match(lines[1], /1\. X — đã gạch \(đang rời\)/);
  assert.match(lines[2], /2\. 🐭 Chuột — clip — chờ 5 phút/);
  assert.match(lines[3], /3\. pid 3 — kẹt \(mất nhịp tim\)/);
  assert.match(lines[4], /4\. pid 4 — bị dừng/);
  assert.deepEqual(parseArgs(['leave', '--lock', 'build', '--pid', '42']), { cmd: 'leave', lock: 'build', pid: 42 });
  assert.match(parseArgs(['leave', '--lock', 'nope']).error, /lock phải/);
});
