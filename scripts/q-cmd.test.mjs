// RFC 29 — /q: board rendering, button presses (revisions, verification, persistence), typed forms, menu, long-build parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PersistentMap } from './button-store.mjs';
import { lockPaths, readQueue } from './machine-lock.mjs';
import { defaultPolicy, readPolicy, writePolicy, TICKET_V } from './build-policy.mjs';
import { gatherQ, renderQ, qCallback, Q_BUTTON_RE, Q_PAGE_SIZE } from './q-panel.mjs';
import { startQ, qPress, handleQButton, runQCommand, latestQ, queueTargetTiers } from './q-cmd.mjs';
import { readNotices } from './queue-control.mjs';
import { quietState, readOverride, writeOverride, clearOverride } from './quiet-hours.mjs';
import { loadCommands, resolveCommand } from './commands.mjs';
import { dispatchCommand, clearBotMenus, takeMergeButton, Q_COMMAND } from './daemon.mjs';
import {
  longBuildCandidates, createStopJob, buildKickNoticePrompt, longBuildWatch, retireLongBuildAlert, holderKey, STOP_BUTTON_RE,
} from './long-build.mjs';
import { HEALTH_SHORTCUTS } from './health.mjs';
import { LS_SHORTCUTS } from './spawn.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-q-'));
const me = process.pid;
const myStart = String(spawnSync('cut', ['-d', ' ', '-f', '22', `/proc/${me}/stat`]).stdout).trim();
let seq = 0;
function ticket(dir, label, extra = {}) {
  const q = lockPaths('build', dir).queue;
  fs.mkdirSync(q, { recursive: true });
  const name = `${String(1_700_000_000_000 + (seq++)).padStart(15, '0')}-${me}-${String(seq).padStart(6, 'a')}.json`;
  const body = { v: TICKET_V, pid: me, procStart: myStart, label, cmd: `cmd of ${label}`, worktree: `/w/${label}`, owner: `convo:${label}`, convoId: label, createdAt: Date.now() - 7 * 60_000, ...extra };
  if (body.v === undefined) delete body.v;
  fs.writeFileSync(path.join(q, name), JSON.stringify(body));
  return name;
}
function holder(dir, slot, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockPaths('build', dir, slot).holder, JSON.stringify({ pid: me, procStart: myStart, startedAt: Date.now() - 12 * 60_000, label: `Tiên${slot}`, cmd: 'cargo nextest', worktree: '/w/l30', slot, slots: 2, ...extra }));
}
const setPolicy = (dir, patch) => writePolicy(dir, { ...defaultPolicy(), ...patch });

function fakeCtx(dir, { failEdit = false } = {}) {
  const c = { texts: [], sent: [], edits: [], answers: [], daemonUserId: '9', lockDir: dir, buttonStore: new PersistentMap(path.join(tmpDir(), 'b.json')) };
  let id = 100;
  c.sendText = async (_chat, t) => { c.texts.push(t); };
  c.sendButtonRows = async (chat, text, rows) => { c.sent.push({ chat, text, rows }); return { message_id: id++ }; };
  c.editButtonRows = async (chat, mid, text, rows) => { c.edits.push({ mid, text, rows }); };
  c.editButtonRowsStrict = async (chat, mid, text, rows) => { if (c.failEdit) throw new Error('message to edit not found'); c.edits.push({ mid, text, rows }); };
  c.failEdit = failEdit;
  c.answerButton = async (_id, t) => { c.answers.push(t); };
  return c;
}
/** The current board of a fake ctx → { tok, entry }. */
const boardOf = (ctx) => { const [tok, entry] = latestQ(ctx.buttonStore); return { tok, entry }; };
const cqFor = (ctx, data, { from = 9, mid = null, text = 'old' } = {}) => ({ id: 'cq', from: { id: from }, data, message: { chat: { id: 9 }, message_id: mid ?? boardOf(ctx).entry.messageId, text } });
const lastRows = (ctx) => ctx.edits.at(-1)?.rows ?? ctx.sent.at(-1).rows;
const cbs = (rows) => rows.flat().map((b) => b.callback_data);
const btn = (rows, re) => rows.flat().find((b) => re.test(b.text));

test('renderQ: header, running + waiting lines, buttons (⬆ only live; ⬆✓ boosted; all < 64 bytes), blocks, max row, pause row', () => {
  const dir = tmpDir();
  holder(dir, 0); holder(dir, 1, { pid: me, label: 'Tuộc' });
  const a = ticket(dir, 'A'), b = ticket(dir, 'B'), c = ticket(dir, 'C');
  fs.utimesSync(path.join(lockPaths('build', dir).queue, c), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000)); // stalled
  const until = Date.now() + 3600_000;
  setPolicy(dir, { max: 4, retryMin: 10, boosts: { [b]: Date.now() }, blocks: [{ owner: 'convo:Z', label: '🦊 Cáo', until, at: 1 }] });
  const g = gatherQ({ dir });
  const r = renderQ(g, { tok: 'a'.repeat(12), rev: 35 });
  assert.match(r.text, /^🔒 build 2\/\d · chờ 3 · max 4 \(thử lại sau 10'\)/);
  assert.match(r.text, /▶ Tiên0 · l30 — cargo nextest \(12'\)/);
  assert.match(r.text, /⬆ B/, 'boosted ticket marked');
  assert.match(r.text, /⛔ Đang chặn:\n1\. 🦊 Cáo tới \d\d:\d\d/);
  assert.equal(Object.keys(r.maps.rows).length, 3, 'stalled tickets are numbered too (they count toward max)');
  assert.equal(r.maps.rows['1'].file, b, 'boosted first');
  assert.deepEqual(r.maps.blocks, { 1: 'convo:Z' });
  assert.deepEqual(Object.keys(r.maps.running), ['1', '2']);
  const all = cbs(r.rows);
  for (const d of all) { assert.ok(Buffer.byteLength(d) < 64, d); assert.match(d, Q_BUTTON_RE); }
  assert.ok(btn(r.rows, /^⬆✓ 1$/), 'boosted shows ⬆✓');
  assert.ok(btn(r.rows, /^⬆ 2$/));
  assert.equal(btn(r.rows, /^⬆ 3$/), undefined, 'no ⬆ on the stalled ticket');
  assert.ok(btn(r.rows, /^✖ 3$/) && btn(r.rows, /^⛔ 3$/), 'but kick/block yes');
  assert.ok(btn(r.rows, /^⏹ Tuộc$/));
  assert.ok(btn(r.rows, /^Max −$/) && btn(r.rows, /^Max 4$/) && btn(r.rows, /^Max \+$/));
  assert.ok(btn(r.rows, /^⏸$/) && btn(r.rows, /🔄/) && btn(r.rows, /Bỏ chặn 1/));
  void a;
  // max off, paused
  setPolicy(dir, { paused: true });
  const r2 = renderQ(gatherQ({ dir }), { tok: 'a'.repeat(12), rev: 0 });
  assert.match(r2.text, /max tắt/); assert.match(r2.text, / · ⏸/);
  assert.ok(btn(r2.rows, /Max tắt/) && btn(r2.rows, /^▶$/));
  // rev is base36 in the callback
  assert.equal(qCallback('a'.repeat(12), 35, 'k', 2), `q:${'a'.repeat(12)}:z:k:2`);
});

test('renderQ: a pre-RFC 29 waiter hides ⬆; pause note counts old-code tickets; corrupt policy → warning + reset button (confirmation view)', () => {
  const dir = tmpDir();
  ticket(dir, 'OLD', { v: undefined }); ticket(dir, 'NEW');
  setPolicy(dir, { paused: true });
  const r = renderQ(gatherQ({ dir }), { tok: 'b'.repeat(12), rev: 0 });
  assert.equal(btn(r.rows, /^⬆/), undefined);
  assert.match(r.text, /còn 1 vé code cũ không theo pause/);
  fs.writeFileSync(path.join(dir, 'build.policy.json'), '{bad');
  const rc = renderQ(gatherQ({ dir }), { tok: 'b'.repeat(12), rev: 0 });
  assert.match(rc.text, /^⚠️ build\.policy\.json hỏng/);
  assert.ok(btn(rc.rows, /Ghi lại policy mặc định/));
  const ask = renderQ(gatherQ({ dir }), { tok: 'b'.repeat(12), rev: 0, view: 'rs' });
  assert.deepEqual(ask.rows[0].map((x) => x.text), ['✅ Ghi lại', '✖']);
});

test('renderQ: block menu shows the scope (git: = WHOLE repo warning) and 4 durations; stop confirmation names persona + pid; pages of 8', () => {
  const dir = tmpDir();
  holder(dir, 0, { label: '🐙 Tuộc #c4' });
  ticket(dir, 'G', { owner: 'git:/x/proj/.git', convoId: null });
  const g = gatherQ({ dir });
  const bm = renderQ(g, { tok: 'c'.repeat(12), rev: 2, view: 'b:1', pin: renderQ(g, { tok: 'c'.repeat(12), rev: 2 }).maps.rows['1'] });
  assert.match(bm.text, /⚠️ vé không có convo — chặn CẢ REPO proj/);
  assert.deepEqual(bm.rows[0].map((x) => x.text), ["30'", '1h', '3h', 'Hết hôm nay', '✖']);
  const sm = renderQ(g, { tok: 'c'.repeat(12), rev: 2, view: 's:1', pin: renderQ(g, { tok: 'c'.repeat(12), rev: 2 }).maps.running['1'] });
  assert.equal(sm.rows[0][0].text, `✅ Dừng 🐙 Tuộc pid ${me}`);
  const dir2 = tmpDir();
  for (let i = 0; i < 10; i++) ticket(dir2, `T${i}`);
  const p0 = renderQ(gatherQ({ dir: dir2 }), { tok: 'd'.repeat(12), rev: 0, page: 0 });
  assert.equal((p0.text.match(/^\d+\. /gm) || []).length, Q_PAGE_SIZE);
  assert.match(p0.text, /trang 1\/2/);
  assert.ok(btn(p0.rows, /^1\/2$/) && btn(p0.rows, /^›$/));
  const p1 = renderQ(gatherQ({ dir: dir2 }), { tok: 'd'.repeat(12), rev: 0, page: 1 });
  assert.equal((p1.text.match(/^\d+\. /gm) || []).length, 2);
  assert.equal(Object.keys(p1.maps.rows).length, 10, 'numbers are global, not per page');
  assert.ok(btn(p1.rows, /^✖ 9$/));
});

test('startQ: sends the board, stores ONE kind:q entry (maps, rev 0) and expires the older board; persist failure → no buttons', async () => {
  const dir = tmpDir();
  ticket(dir, 'A');
  const ctx = fakeCtx(dir);
  await startQ(ctx, { rand: () => 'aaaaaaaaaaaa' });
  const e1 = ctx.buttonStore.get('aaaaaaaaaaaa');
  assert.equal(e1.kind, 'q'); assert.equal(e1.rev, 0); assert.equal(e1.messageId, 100);
  assert.equal(e1.rows['1'].label, 'A');
  await startQ(ctx, { rand: () => 'bbbbbbbbbbbb' });
  assert.equal(ctx.buttonStore.get('aaaaaaaaaaaa'), undefined, 'the older board expired');
  assert.ok(ctx.buttonStore.get('bbbbbbbbbbbb'));
  const bad = fakeCtx(dir);
  bad.buttonStore.setStrict = () => { throw new Error('disk full'); };
  await startQ(bad);
  assert.match(bad.edits.at(-1).text, /không lưu được trạng thái nút/);
  assert.deepEqual(bad.edits.at(-1).rows, []);
});

test('press: only the owner; unknown / expired / mismatched messages do nothing', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const ctx = fakeCtx(dir);
  await startQ(ctx);
  const { tok } = boardOf(ctx);
  await qPress(cqFor(ctx, qCallback(tok, 0, 'm+'), { from: 123 }), ctx);
  assert.match(ctx.answers.at(-1), /Chỉ owner/);
  assert.equal(readPolicy(dir).policy.max, null);
  await qPress(cqFor(ctx, qCallback('f'.repeat(12), 0, 'm+')), ctx);
  assert.match(ctx.answers.at(-1), /Hết hạn/);
  await qPress(cqFor(ctx, qCallback(tok, 0, 'm+'), { mid: 55555 }), ctx);
  assert.match(ctx.answers.at(-1), /không khớp/);
  const e = ctx.buttonStore.get(tok);
  const cqOld = cqFor(ctx, qCallback(tok, 0, 'm+'));
  ctx.buttonStore.set(tok, { ...e, createdAt: Date.now() - 3 * 3600_000 });
  await qPress(cqOld, ctx);
  assert.match(ctx.answers.at(-1), /Hết hạn/);
  assert.equal(readPolicy(dir).policy.max, null, 'nothing was done');
});

test('press: Max +/−/toggle work; an OLD revision only refreshes (double tap counts once)', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const ctx = fakeCtx(dir);
  await startQ(ctx);
  const { tok } = boardOf(ctx);
  await qPress(cqFor(ctx, qCallback(tok, 0, 'm+')), ctx); // off → lastMax (4)
  assert.equal(readPolicy(dir).policy.max, 4);
  assert.equal(boardOf(ctx).entry.rev, 1);
  await qPress(cqFor(ctx, qCallback(tok, 0, 'm+')), ctx); // the same button again (double tap / stale board)
  assert.equal(readPolicy(dir).policy.max, 4, 'not 5');
  assert.match(ctx.edits.at(-1).text, /Bảng cũ/);
  assert.equal(boardOf(ctx).entry.rev, 2, 'a refresh is a new revision too');
  // the redrawn board carries the new revision in every button
  assert.ok(cbs(ctx.edits.at(-1).rows).every((d) => d.split(':')[2] === '2'));
  await qPress(cqFor(ctx, qCallback(tok, 2, 'm+')), ctx);
  assert.equal(readPolicy(dir).policy.max, 5);
  await qPress(cqFor(ctx, qCallback(tok, 3, 'm-')), ctx);
  assert.equal(readPolicy(dir).policy.max, 4);
  await qPress(cqFor(ctx, qCallback(tok, 4, 'mt')), ctx);
  assert.equal(readPolicy(dir).policy.max, null);
  assert.equal(readPolicy(dir).policy.lastMax, 4);
  await qPress(cqFor(ctx, qCallback(tok, 5, 'p')), ctx);
  assert.equal(readPolicy(dir).policy.paused, true);
  await qPress(cqFor(ctx, qCallback(tok, 6, 'p')), ctx);
  assert.equal(readPolicy(dir).policy.paused, false);
});

test('press: concurrent taps of the same revision are serialised (mutex) — one acts, the other refreshes', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const ctx = fakeCtx(dir);
  await startQ(ctx);
  const { tok } = boardOf(ctx);
  await Promise.all([handleQButton(cqFor(ctx, qCallback(tok, 0, 'm+')), ctx), handleQButton(cqFor(ctx, qCallback(tok, 0, 'm+')), ctx), handleQButton(cqFor(ctx, qCallback(tok, 0, 'm+')), ctx)]);
  assert.equal(readPolicy(dir).policy.max, 4, 'three taps, one step');
});

test('press: kick — the ticket must still be the same process (pid + start); a changed ticket only refreshes; success writes the outbox notice', async () => {
  const dir = tmpDir();
  const a = ticket(dir, 'A'); ticket(dir, 'B');
  const ctx = fakeCtx(dir);
  await startQ(ctx);
  let { tok, entry } = boardOf(ctx);
  assert.equal(entry.rows['1'].file, a);
  // the ticket file is replaced by a different process' (same name, other pid)
  const f = path.join(lockPaths('build', dir).queue, a);
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...body, pid: 1 }));
  await qPress(cqFor(ctx, qCallback(tok, 0, 'k', 1)), ctx);
  assert.match(ctx.edits.at(-1).text, /Vé đã đổi hoặc đã chạy/);
  assert.ok(fs.existsSync(f), 'not kicked');
  fs.writeFileSync(f, JSON.stringify(body));
  ({ tok, entry } = boardOf(ctx));
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'r')), ctx); // refresh: the board shows A again
  ({ tok, entry } = boardOf(ctx));
  assert.equal(entry.rows['1'].file, a);
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'k', 1)), ctx);
  assert.ok(fs.existsSync(f.replace('.json', '.kicked')), 'kicked');
  assert.deepEqual(readNotices(dir).map((n) => [n.notice.kind, n.notice.convoId]), [['kicked', 'A']]);
  assert.match(ctx.edits.at(-1).text, /Đã kick A/);
  assert.equal(Object.keys(boardOf(ctx).entry.rows).length, 1, 'board redrawn without it');
});

test('press: ⬆ toggles a boost; ⛔ opens the length menu, a duration blocks + kicks the owner\'s tickets; Bỏ chặn removes it', async () => {
  const dir = tmpDir();
  ticket(dir, 'A'); const b = ticket(dir, 'B'); ticket(dir, 'B');
  const ctx = fakeCtx(dir);
  await startQ(ctx);
  let { tok, entry } = boardOf(ctx);
  const rowB = Object.entries(entry.rows).find(([, r]) => r.file === b)[0];
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 't', rowB)), ctx);
  assert.ok(readPolicy(dir).policy.boosts[b]);
  assert.match(btn(lastRows(ctx), /⬆✓/).text, /⬆✓/);
  ({ tok, entry } = boardOf(ctx));
  const rowB2 = Object.entries(entry.rows).find(([, r]) => r.file === b)[0]; // (boosted: now first)
  assert.equal(rowB2, '1');
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 't', rowB2)), ctx);
  assert.equal(readPolicy(dir).policy.boosts[b], undefined, 'pressing again removes the boost');
  ({ tok, entry } = boardOf(ctx));
  const rowB3 = Object.entries(entry.rows).find(([, r]) => r.file === b)[0];
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'b', rowB3)), ctx);
  assert.match(ctx.edits.at(-1).text, /chặn B \(convo B\)/);
  assert.equal(readPolicy(dir).policy.blocks.length, 0, 'opening the menu blocks nothing');
  ({ tok, entry } = boardOf(ctx));
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'bd', rowB3, '1h')), ctx);
  const pol = readPolicy(dir).policy;
  assert.equal(pol.blocks[0].owner, 'convo:B');
  assert.ok(Math.abs(pol.blocks[0].until - (Date.now() + 3600_000)) < 5000);
  assert.equal(readQueue('build', { dir }).filter((t) => t.label === 'B').length, 0, 'both of B\'s tickets kicked');
  assert.equal(readNotices(dir).length, 2);
  ({ tok, entry } = boardOf(ctx));
  assert.deepEqual(entry.blocks, { 1: 'convo:B' });
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'u', 1)), ctx);
  assert.equal(readPolicy(dir).policy.blocks.length, 0);
});

test('press: persistence — a revision that cannot be consumed means NOTHING happens; a lost message → a new board', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const ctx = fakeCtx(dir);
  await startQ(ctx);
  const { tok, entry } = boardOf(ctx);
  const real = ctx.buttonStore.setStrict.bind(ctx.buttonStore);
  ctx.buttonStore.setStrict = () => { throw new Error('EIO'); };
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'm+')), ctx);
  assert.match(ctx.answers.at(-1), /không lưu được trạng thái nút/);
  assert.equal(readPolicy(dir).policy.max, null, 'not acted on');
  ctx.buttonStore.setStrict = real;
  assert.equal(ctx.buttonStore.get(tok).rev, entry.rev, 'revision not consumed');
  // the edit fails (message too old): the board is re-sent as a NEW entry, the old one expires
  ctx.failEdit = true;
  const sentBefore = ctx.sent.length;
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'm+')), ctx);
  assert.equal(readPolicy(dir).policy.max, 4, 'the action itself was done');
  assert.equal(ctx.sent.length, sentBefore + 1, 'new board');
  assert.equal(ctx.buttonStore.get(tok), undefined);
  assert.ok(latestQ(ctx.buttonStore), 'exactly one live board');
});

test('press: ⏹ asks first, then creates a SEPARATE status message + one stop job; a second confirm says "đang dừng rồi"; the long-build alert is retired', async () => {
  const dir = tmpDir();
  holder(dir, 0, { label: '🐙 Tuộc #c4', convoId: '77', unit: null });
  const ctx = fakeCtx(dir);
  const retired = [], kicks = [];
  const deps = { retire: async (key) => { retired.push(key); }, kick: () => kicks.push(1), verify: (e) => ({ holder: { pid: me, procStart: myStart, startedAt: e.startedAt, slot: 0, label: '🐙 Tuộc #c4', cmd: 'cargo nextest', worktree: '/w/l30', convoId: '77' } }) };
  await startQ(ctx);
  let { tok, entry } = boardOf(ctx);
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 's', 1)), ctx, deps);
  assert.match(ctx.edits.at(-1).text, /Dừng build của 🐙 Tuộc #c4/);
  assert.equal(ctx.buttonStore.size, 1, 'no job yet: asking is free');
  ({ tok, entry } = boardOf(ctx));
  const sentBefore = ctx.sent.length;
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'sy', 1)), ctx, deps);
  assert.equal(ctx.sent.length, sentBefore + 1, 'a separate status message');
  assert.match(ctx.sent.at(-1).text, /^⏹ đang dừng 🐙 Tuộc #c4 pid \d+…$/);
  const [key, job] = [...ctx.buttonStore.entries()].find(([k]) => k.startsWith('stop:'));
  assert.equal(job.kind, 'stop'); assert.equal(job.phase, 'marker'); assert.equal(job.convoId, '77');
  assert.equal(job.messageId, 100 + 1 + 0, 'the job edits the status message, not the board');
  assert.notEqual(job.messageId, boardOf(ctx).entry.messageId);
  assert.deepEqual(retired, [key.slice(5)], 'alert retired');
  assert.equal(kicks.length, 1);
  ({ tok, entry } = boardOf(ctx));
  const jobsBefore = [...ctx.buttonStore.keys()].filter((k) => k.startsWith('stop:')).length;
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'sy', 1)), ctx, deps);
  assert.match(ctx.edits.at(-1).text, /đang dừng/); // (the confirmation is single-use: a repeat just refreshes, showing "⏳ đang dừng")
  assert.equal([...ctx.buttonStore.keys()].filter((k) => k.startsWith('stop:')).length, jobsBefore, 'no duplicate job (phase/deadline not reset)');
  // verification fails (another holder in the slot) → refresh with the reason, no job
  const ctx2 = fakeCtx(dir);
  await startQ(ctx2);
  ({ tok, entry } = boardOf(ctx2));
  await qPress(cqFor(ctx2, qCallback(tok, entry.rev, 's', 1)), ctx2, deps);
  ({ tok, entry } = boardOf(ctx2));
  await qPress(cqFor(ctx2, qCallback(tok, entry.rev, 'sy', 1)), ctx2, { verify: () => ({ why: 'chỗ đã đổi người' }) });
  assert.match(ctx2.edits.at(-1).text, /Không dừng: chỗ đã đổi người/);
  assert.equal([...ctx2.buttonStore.keys()].filter((k) => k.startsWith('stop:')).length, 0);
});

test('typed /q forms: max, retry, pause/resume, kick/top/block by number or persona, unblock; usage', async () => {
  const dir = tmpDir();
  const a = ticket(dir, 'A'); ticket(dir, 'B');
  const ctx = fakeCtx(dir);
  await runQCommand('max 3', ctx); assert.equal(readPolicy(dir).policy.max, 3);
  await runQCommand('max off', ctx); assert.equal(readPolicy(dir).policy.max, null);
  await runQCommand('max 99', ctx); assert.match(ctx.texts.at(-1), /max phải là/);
  await runQCommand('retry 15', ctx); assert.equal(readPolicy(dir).policy.retryMin, 15);
  await runQCommand('retry 0', ctx); assert.match(ctx.texts.at(-1), /1..120/);
  await runQCommand('pause', ctx); assert.equal(readPolicy(dir).policy.paused, true);
  await runQCommand('resume', ctx); assert.equal(readPolicy(dir).policy.paused, false);
  await runQCommand('kick 1', ctx);
  assert.match(ctx.texts.at(-1), /chưa có bảng/);
  await runQCommand('', ctx); // the board
  assert.equal(ctx.sent.length, 1);
  await runQCommand('top 2', ctx);
  assert.match(ctx.texts.at(-1), /lên đầu/);
  assert.equal(Object.keys(readPolicy(dir).policy.boosts).length, 1);
  await runQCommand('kick 1', ctx);
  assert.ok(fs.existsSync(path.join(lockPaths('build', dir).queue, a.replace('.json', '.kicked'))));
  await runQCommand('kick 9', ctx); assert.match(ctx.texts.at(-1), /không còn/);
  // block by persona (resolved from the queue), duration = LAST token
  const fruit = ticket(dir, 'Cá Mập', { owner: 'convo:55', convoId: '55' });
  void fruit;
  await runQCommand('block Cá Mập 30m', ctx, { peek: () => null });
  assert.equal(readPolicy(dir).policy.blocks[0].owner, 'convo:55');
  assert.match(ctx.texts.at(-1), /tới \d\d:\d\d; đã kick 1 vé/);
  await runQCommand('block Nobody 1h', ctx, { peek: () => null }); assert.match(ctx.texts.at(-1), /không thấy "Nobody"/);
  await runQCommand('block Cá Mập', ctx); assert.match(ctx.texts.at(-1), /usage|thời hạn/);
  await runQCommand('unblock Cá Mập', ctx);
  assert.equal(readPolicy(dir).policy.blocks.length, 0);
  await runQCommand('block git:/x/.git 2h30m', ctx);
  assert.equal(readPolicy(dir).policy.blocks[0].owner, 'git:/x/.git');
  await runQCommand('unblock git:/x/.git', ctx);
  assert.equal(readPolicy(dir).policy.blocks.length, 0, 'unblock matches policy.blocks directly (git:/sid:/pid: too)');
  await runQCommand('bogus', ctx); assert.match(ctx.texts.at(-1), /^usage: \/q/);
});

test('queueTargetTiers: queue first, then live agents, then topics.json', () => {
  const dir = tmpDir();
  ticket(dir, 'Q', { convoId: '10', label: '🐭 Chuột #a1' });
  const peek = (id) => ({ 10: { name: 'Chuột', emoji: '🐭' } })[id] ?? null;
  const tiers = queueTargetTiers({ dir, procs: () => [{ sessionId: null, name: 'x' }], topics: () => ['10', '20'], peek: () => null });
  assert.equal(tiers[0][0].convoId, '10');
  assert.equal(tiers[2].length, 2);
  void peek;
});

test('/q is owner-only in dispatchCommand; the owner gets the board', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const ctx = fakeCtx(dir);
  const base = { daemonUserId: '9', projectsConfig: {}, registry: {}, sendText: ctx.sendText, lockDir: dir, sendButtonRows: ctx.sendButtonRows, editButtonRows: ctx.editButtonRows, buttonStore: ctx.buttonStore };
  await dispatchCommand({ cmd: Q_COMMAND, rest: '' }, { id: 5 }, base);
  assert.match(ctx.texts.at(-1), /chỉ owner/);
  assert.equal(ctx.sent.length, 0);
  await dispatchCommand({ cmd: Q_COMMAND, rest: '' }, { id: 9 }, base);
  assert.equal(ctx.sent.length, 1);
  await dispatchCommand({ cmd: Q_COMMAND, rest: 'max 6' }, { id: 5 }, base);
  assert.equal(readPolicy(dir).policy.max, null, 'a non-owner cannot even type the subcommands');
});

test('button store: setStrict throws and rolls back; a kind:q entry is never taken by the merge button; the 24 h sweep still applies', () => {
  const file = path.join(tmpDir(), 'b.json');
  const m = new PersistentMap(file);
  m.setStrict('k', { kind: 'q', createdAt: 1 });
  assert.equal(new PersistentMap(file).get('k').kind, 'q');
  fs.rmSync(file); fs.mkdirSync(file); // the path is a directory now: renames fail
  assert.throws(() => m.setStrict('k2', { kind: 'q', createdAt: 2 }));
  assert.equal(m.has('k2'), false, 'memory rolled back');
  assert.equal(m.get('k').createdAt, 1);
  assert.throws(() => m.setStrict('k', { kind: 'q', createdAt: 9 }));
  assert.equal(m.get('k').createdAt, 1, 'an overwritten value is restored too');
  const store = new Map([['t1', { kind: 'q', createdAt: Date.now(), links: ['x'] }]]);
  assert.equal(takeMergeButton('t1', { store }), null);
  assert.ok(store.has('t1'), 'not consumed by the merge taker');
});

test('clearBotMenus: deleteCommands for every scope, including the owner chat', async () => {
  const scopes = [];
  await clearBotMenus({ deleteCommands: async (sc) => { scopes.push(sc); } }, '12345');
  assert.deepEqual(scopes, [{ type: 'default' }, { type: 'all_private_chats' }, { type: 'all_group_chats' }, { type: 'all_chat_administrators' }, { type: 'chat', chat_id: 12345 }]);
  const noOwner = [];
  await clearBotMenus({ deleteCommands: async (sc) => { noOwner.push(sc); } }, '');
  assert.equal(noOwner.length, 4);
  const withGroups = [];
  await clearBotMenus({ deleteCommands: async (sc) => { withGroups.push(sc); } }, '12345', ['-100777', '-100777', 'junk']);
  assert.deepEqual(withGroups.slice(5), [{ type: 'chat', chat_id: -100777 }, { type: 'chat_administrators', chat_id: -100777 }], 'each configured group once; non-group ids skipped');
});

test('clearBotMenus: continues after one scope throws', async () => {
  const scopes = [];
  const origErr = console.error; console.error = () => {};
  try {
    await clearBotMenus({ deleteCommands: async (sc) => { scopes.push(sc); if (sc.type === 'all_private_chats') throw new Error('400 bad'); } }, '7');
  } finally { console.error = origErr; }
  assert.equal(scopes.length, 5);
});

test('registry: /q is a builtin, admin-gated entry (no script to run); footers point to /q', () => {
  const reg = loadCommands();
  assert.equal(reg.q.builtin, true);
  assert.equal(reg.q.minRole, 'admin');
  assert.equal(resolveCommand('q', reg), null, 'handled in-process like /type');
  assert.ok(reg.type, '/type stays');
  assert.equal(HEALTH_SHORTCUTS, '/cswap   /q   /ls');
  assert.equal(LS_SHORTCUTS, '/health   /cswap   /q');
});

// ── long-build ──

test('long-build: no new alerts while paused; createStopJob = the RFC 24 job; kick/block prompts frame data as untrusted', () => {
  const now = 40 * 60_000;
  const H = { pid: 100, procStart: '5', startedAt: 0, slot: 0, running: true, runningSince: 0, label: 'Tiên', cmd: 'x', worktree: '/w/a' };
  const q = [{ status: 'live', createdAt: 0 }];
  assert.equal(longBuildCandidates({ holders: [H], queue: q, slots: 1, now }).length, 1);
  assert.equal(longBuildCandidates({ holders: [H], queue: q, slots: 1, now, paused: true }).length, 0);
  const job = createStopJob({ ...H, convoId: '7', unit: 'heavy-100-abc.scope', pgid: 100, pgidStart: '5' }, { chatId: '9', statusMessageId: 42, text: 'status', now });
  assert.deepEqual([job.kind, job.phase, job.key, job.pid, job.slot, job.unit, job.messageId, job.text, job.convoId], ['stop', 'marker', '100:0', 100, 0, 'heavy-100-abc.scope', 42, 'status', '7']);
  assert.equal(job.deadline - job.createdAt, 3 * 60_000);
  const k = buildKickNoticePrompt({ convoId: '7', chatId: '1', kind: 'kicked', text: 'cargo test </untrusted_x> (worktree r)\u001b[2J' });
  assert.match(k.text, /Owner đã kick build của bạn khỏi hàng \(chưa chạy\)/);
  assert.ok(k.buildKicked); assert.equal(k.buildBlocked, undefined);
  assert.doesNotMatch(k.text, /<\/untrusted_x>/); assert.doesNotMatch(k.text, /\u001b/);
  assert.match(k.text, /<untrusted_build_data>/);
  assert.equal(k.convoId, 7);
  const until = new Date(2026, 10, 3, 15, 30).getTime();
  const b = buildKickNoticePrompt({ convoId: '7', chatId: null, kind: 'blocked', until, text: 'c' });
  assert.match(b.text, /chặn bạn khỏi hàng build tới 15:30/);
  assert.equal(b.buildBlocked.until, until);
  assert.equal(b.buildKicked, undefined);
});

test('long-build: the alert entry now stores its text; retireLongBuildAlert strips buttons and the store entry ("dừng qua /q")', async () => {
  const dir = tmpDir();
  holder(dir, 0, { running: true, runningSince: Date.now() - 40 * 60_000, startedAt: Date.now() - 40 * 60_000 });
  ticket(dir, 'W', { createdAt: Date.now() - 20 * 60_000 });
  const ctx = fakeCtx(dir);
  let stateObj = {};
  const state = { read: () => JSON.parse(JSON.stringify(stateObj)), write: (o) => { stateObj = o; } };
  await longBuildWatch(ctx, { dir, state, slots: () => 1, paused: () => false });
  const [tok, entry] = [...ctx.buttonStore.entries()][0];
  assert.equal(entry.kind, 'longbuild');
  assert.match(entry.text, /^⏰ build giữ lock/);
  const key = Object.keys(stateObj)[0];
  assert.equal(stateObj[key].text, entry.text);
  assert.equal(await retireLongBuildAlert(key, ctx, { state }), true);
  assert.equal(ctx.buttonStore.get(tok), undefined);
  assert.match(ctx.edits.at(-1).text, /\n\n⏹ dừng qua \/q$/);
  assert.deepEqual(ctx.edits.at(-1).rows, []);
  // paused: no NEW alert
  const ctx2 = fakeCtx(dir);
  let st2 = {};
  await longBuildWatch(ctx2, { dir, state: { read: () => st2, write: (o) => { st2 = o; } }, slots: () => 1, paused: () => true });
  assert.equal(ctx2.sent.length, 0);
  assert.ok(STOP_BUTTON_RE && holderKey);
});

// ── review round 1 regressions ──

test('R2 blockOwner: the block is on disk BEFORE any ticket is struck (a waiter seeing .kicked finds the block → 79); a failed persist kicks nothing', async () => {
  const dir = tmpDir();
  const a = ticket(dir, 'A');
  const q = lockPaths('build', dir).queue;
  const seen = [];
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith('.kicked')) seen.push(readPolicy(dir).policy.blocks.map((b) => b.owner)); return realRename(from, to); };
  try { assert.equal((await (await import('./queue-control.mjs')).blockOwner(dir, { owner: 'convo:A', label: 'A', until: Date.now() + 60_000 })).ok, true); }
  finally { fs.renameSync = realRename; }
  assert.deepEqual(seen, [['convo:A']], 'block persisted first');
  // persistence fails (policy dir read-only trick: an invalid block → writePolicy throws) → nothing struck
  const b = ticket(dir, 'B');
  const { blockOwner } = await import('./queue-control.mjs');
  const r = await blockOwner(dir, { owner: 'convo:B', label: 'B', until: Date.now() + 60_000, ident: { pid: 'x' } });
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(q, b)), 'ticket untouched');
  void a;
});

test('R3 qStop: a stop job that appears while the status message is being sent is preserved', async () => {
  const dir = tmpDir();
  const ctx = fakeCtx(dir);
  const holderObj = { pid: me, procStart: myStart, startedAt: 5, slot: 0, label: 'T', cmd: 'c', convoId: '7' };
  const key = holderKey(holderObj);
  const orig = ctx.sendButtonRows;
  ctx.sendButtonRows = async (...a) => { const r = await orig(...a); ctx.buttonStore.set(`stop:${key}`, { kind: 'stop', key, phase: 'waitExit', deadline: 123 }); return r; };
  const { qStop } = await import('./q-cmd.mjs');
  const note = await qStop(ctx, { slot: 0, pid: me, startedAt: 5, procStart: myStart }, { verify: () => ({ holder: holderObj }), retire: async () => {} });
  assert.match(note, /đang dừng rồi/);
  assert.equal(ctx.buttonStore.get(`stop:${key}`).phase, 'waitExit');
  assert.equal(ctx.buttonStore.get(`stop:${key}`).deadline, 123);
});

test('R4 daemon wiring: /q block <persona> reaches the live-process + topics providers', async () => {
  const dir = tmpDir();
  const ctx = fakeCtx(dir);
  const base = { daemonUserId: '9', projectsConfig: {}, registry: {}, sendText: ctx.sendText, lockDir: dir, sendButtonRows: ctx.sendButtonRows, editButtonRows: ctx.editButtonRows, buttonStore: ctx.buttonStore };
  await dispatchCommand({ cmd: 'q', rest: 'block 🦉 Cú 1h' }, { id: 9 }, { ...base, qDeps: { procs: () => [], topics: () => ['321'], peek: (id) => (id === '321' ? { name: 'Cú', emoji: '🦉' } : null) } });
  assert.match(ctx.texts.at(-1), /không thấy|đã kick|chặn/);
  const { topicConvoIds } = await import('./q-cmd.mjs');
  assert.deepEqual(topicConvoIds({ chat1: { 5: {}, _x: {}, 6: {} }, chat2: { 6: {}, 7: {} } }).sort(), ['5', '6', '7']);
});

test('R5 ⛔ / ⏹ confirmations are pinned to the pressed ticket/build, even if the numbering changes meanwhile', async () => {
  const dir = tmpDir();
  const a = ticket(dir, 'A'); ticket(dir, 'B');
  const ctx = fakeCtx(dir);
  await startQ(ctx);
  let { tok, entry } = boardOf(ctx);
  const rowA = Object.entries(entry.rows).find(([, r]) => r.file === a)[0];
  // the order changes before the press lands: B is boosted → A is no longer "1"
  const { topTicket } = await import('./queue-control.mjs');
  const bName = Object.values(entry.rows).find((r) => r.label === 'B').file;
  await topTicket(dir, { name: bName, pid: me });
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'b', rowA)), ctx);
  assert.match(ctx.edits.at(-1).text, /chặn A \(convo A\)/, 'the menu is for A, not for whoever is now at that number');
  ({ tok, entry } = boardOf(ctx));
  assert.equal(entry.pin.label, 'A');
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'bd', rowA, '1h')), ctx);
  assert.deepEqual(readPolicy(dir).policy.blocks.map((b) => b.owner), ['convo:A']);
  // a duration press without a pinned menu refreshes instead of acting
  ({ tok, entry } = boardOf(ctx));
  await qPress(cqFor(ctx, qCallback(tok, entry.rev, 'bd', 1, '1h')), ctx);
  assert.equal(readPolicy(dir).policy.blocks.length, 1);
});

// ── review round 2 regressions ──

test('R2.1 typed pid:/sid: block targets persist the process identity; an unknown process is refused', async () => {
  const { plainOwnerPlan } = await import('./queue-control.mjs');
  const { control } = await import('./lock-queue.mjs');
  const p = plainOwnerPlan(`pid:${me}`);
  assert.deepEqual(p.ident, { pid: me, procStart: myStart });
  assert.equal(plainOwnerPlan('convo:5').ident, null);
  assert.match(plainOwnerPlan('pid:999999999').error, /không xác định/);
  const dir = tmpDir();
  const ctx = fakeCtx(dir);
  await runQCommand(`block sid:${me} 1h`, ctx);
  assert.deepEqual(readPolicy(dir).policy.blocks[0].ident, { pid: me, procStart: myStart });
  await runQCommand('block pid:999999999 1h', ctx);
  assert.match(ctx.texts.at(-1), /không xác định/);
  assert.equal(readPolicy(dir).policy.blocks.length, 1);
  const dir2 = tmpDir();
  const r = await control({ cmd: 'block', target: `pid:${me}`, duration: '30m' }, { dir: dir2 });
  assert.equal(r.code, 0);
  assert.deepEqual(readPolicy(dir2).policy.blocks[0].ident, { pid: me, procStart: myStart });
  assert.equal((await control({ cmd: 'block', target: 'pid:999999999', duration: '30m' }, { dir: dir2 })).code, 1);
});

test('R2.2 a /q sent while a press is in flight waits for it: the old board cannot be resurrected', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const ctx = fakeCtx(dir);
  await startQ(ctx, { rand: () => 'aaaaaaaaaaaa' });
  const slow = ctx.editButtonRowsStrict;
  let release;
  const gate = new Promise((r) => { release = r; });
  ctx.editButtonRowsStrict = async (...a) => { await gate; return slow(...a); };
  const press = handleQButton(cqFor(ctx, qCallback('aaaaaaaaaaaa', 0, 'm+')), ctx);
  const fresh = startQ(ctx, { rand: () => 'bbbbbbbbbbbb' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.buttonStore.get('bbbbbbbbbbbb'), undefined, 'new board waits for the in-flight press');
  release();
  await Promise.all([press, fresh]);
  assert.equal(ctx.buttonStore.get('aaaaaaaaaaaa'), undefined, 'old token stays dead');
  assert.ok(ctx.buttonStore.get('bbbbbbbbbbbb'));
});

// ── final review regressions ──

test('F1 blockOwner refuses any sid:/pid: owner without a process identity (ticket path included)', async () => {
  const { blockOwner, blockPlan } = await import('./queue-control.mjs');
  const dir = tmpDir();
  const until = Date.now() + 60_000;
  assert.equal((await blockOwner(dir, { owner: 'pid:7', label: 'x', until })).ok, false);
  assert.equal((await blockOwner(dir, { owner: 'sid:7', label: 'x', until, ident: null })).ok, false);
  assert.equal(readPolicy(dir).policy.blocks.length, 0);
  // a ticket whose session leader is gone → plan has no ident → refused
  const plan = blockPlan({ owner: 'sid:999999999', label: 'L', pid: 9 }, { stat: () => null });
  assert.equal(plan.ident, null);
  assert.equal((await blockOwner(dir, { owner: plan.owner, label: plan.label, until, ident: plan.ident })).ok, false);
  assert.equal((await blockOwner(dir, { owner: 'pid:7', label: 'x', until, ident: { pid: me, procStart: myStart } })).ok, true);
  assert.equal((await blockOwner(dir, { owner: 'convo:1', label: 'c', until })).ok, true, 'convo/git need none');
});

test('F2 starting a board is ONE strict write: the new entry in, older q boards out; on failure neither changes', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const ctx = fakeCtx(dir);
  await startQ(ctx, { rand: () => 'aaaaaaaaaaaa' });
  const file = ctx.buttonStore.file;
  let flushes = 0;
  const realFlush = ctx.buttonStore.flush.bind(ctx.buttonStore);
  ctx.buttonStore.flush = () => { flushes++; return realFlush(); };
  await startQ(ctx, { rand: () => 'bbbbbbbbbbbb' });
  assert.equal(flushes, 1, 'a single write');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(disk).filter((k) => disk[k].kind === 'q'), ['bbbbbbbbbbbb']);
  // failing write: memory and disk keep the old board, the new one is not registered
  ctx.buttonStore.flush = () => { throw new Error('EIO'); };
  await startQ(ctx, { rand: () => 'cccccccccccc' });
  assert.ok(ctx.buttonStore.get('bbbbbbbbbbbb'), 'old board still there');
  assert.equal(ctx.buttonStore.get('cccccccccccc'), undefined);
});

// ── RFC 32: CPU gate note + quiet-hours button ──

// (the real clock, with a window around it: the button store's TTL uses Date.now())
const NIGHT = Date.now();
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
const QCFG = { from: clock(NIGHT - 10 * 60_000), to: clock(NIGHT + 3 * 3600_000), cpuPercent: 25, maxBuilds: 1 };
const UNTIL = quietState({ config: QCFG, now: NIGHT }).until;
const quietFor = (cfg = QCFG) => (d, now) => quietState({ config: cfg, now, override: readOverride(d) });
const quietDeps = (extra = {}) => ({ now: () => NIGHT, quietOf: quietFor(), syncQuiet: () => {}, ...extra });
const gatherWith = (deps) => (o) => gatherQ({ ...o, slotsOf: () => 2, quietOf: deps.quietOf });

test('RFC32 /q header: appends " · <note>" when a slot is free but the CPU gate is closed (never replaces the header)', () => {
  const dir = tmpDir(); holder(dir, 0);
  const closed = { ok: false, reason: 'cpu', load1: 11.2, cores: 12 };
  const r = renderQ(gatherQ({ dir, slotsOf: () => 2, gate: () => closed }), { tok: 'a'.repeat(12), rev: 0 });
  assert.match(r.text, /^🔒 build 1\/2 · chờ 0 · max tắt · chờ CPU \(load 11\.2\/12\)\n/);
  const q = renderQ(gatherQ({ dir, slotsOf: () => 2, gate: () => ({ ok: false, reason: 'quiet', load1: 0, cores: 12 }) }), { tok: 'a'.repeat(12), rev: 0 });
  assert.match(q.text, /^🔒 build 1\/2 · chờ 0 · max tắt · 🌙 giờ im lặng\n/);
  const open = renderQ(gatherQ({ dir, slotsOf: () => 2, gate: () => ({ ok: true }) }), { tok: 'a'.repeat(12), rev: 0 });
  assert.match(open.text, /^🔒 build 1\/2 · chờ 0 · max tắt\n/);
});

test('RFC32 /q quiet button: only while the window is active; label by state; the state is in the stored entry, callback_data stays short', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const deps = quietDeps();
  const ctx = fakeCtx(dir);
  await startQ(ctx, { ...deps, gather: gatherWith(deps) });
  const { entry } = boardOf(ctx);
  assert.equal(entry.quiet.active, true); assert.equal(entry.quiet.overridden, false);
  assert.equal(entry.quiet.until, UNTIL);
  const b = btn(ctx.sent[0].rows, new RegExp(`Tắt giờ im lặng tới ${clock(UNTIL)}`));
  assert.ok(b, 'button present');
  assert.match(b.callback_data, Q_BUTTON_RE);
  assert.ok(Buffer.byteLength(b.callback_data) < 48);
  const mins = Math.floor(UNTIL / 60000);
  for (const enc of [String(UNTIL), UNTIL.toString(36), String(mins), mins.toString(36)]) assert.ok(!b.callback_data.includes(enc), `no until (${enc}) in callback_data`);
  assert.equal(b.callback_data.match(Q_BUTTON_RE)[5], undefined, 'no extra until arg group');
  // outside the window: no button
  const day = quietDeps({ quietOf: quietFor({ ...QCFG, from: clock(NIGHT + 3600_000), to: clock(NIGHT + 2 * 3600_000) }) });
  const c2 = fakeCtx(dir);
  await startQ(c2, { ...day, gather: gatherWith(day) });
  assert.equal(btn(c2.sent[0].rows, /giờ im lặng|Bật lại/), undefined);
  assert.equal(boardOf(c2).entry.quiet.active, false);
});

test('RFC32 /q quiet button press: off writes quiet.override.json (offUntil = window end) and syncs; the board flips to "Bật lại"; pressing again removes it', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  let syncs = 0;
  const deps = quietDeps({ syncQuiet: () => { syncs++; } });
  const g = { ...deps, gather: gatherWith(deps) };
  const ctx = fakeCtx(dir);
  await startQ(ctx, g);
  const { tok } = boardOf(ctx);
  await qPress(cqFor(ctx, qCallback(tok, 0, 'qz')), ctx, g);
  const ov = readOverride(dir);
  assert.equal(ov.offUntil, UNTIL);
  assert.equal(fs.statSync(path.join(dir, 'quiet.override.json')).mode & 0o777, 0o600);
  assert.equal(syncs, 1);
  assert.match(ctx.edits.at(-1).text, new RegExp(`Đã tắt giờ im lặng tới ${clock(UNTIL)}`));
  assert.ok(btn(ctx.edits.at(-1).rows, /🌙 Bật lại/));
  assert.equal(boardOf(ctx).entry.quiet.overridden, true);
  await qPress(cqFor(ctx, qCallback(tok, 1, 'qz')), ctx, g);
  assert.equal(readOverride(dir), null);
  assert.equal(syncs, 2);
  assert.match(ctx.edits.at(-1).text, /Đã bật lại giờ im lặng/);
  assert.ok(btn(ctx.edits.at(-1).rows, /Tắt giờ im lặng/));
});

test('RFC32 /q quiet button: an old board (another night\'s `until`, or a changed state) is refused; non-owner too; nothing is written', async () => {
  const dir = tmpDir(); ticket(dir, 'A');
  const deps = quietDeps();
  const g = { ...deps, gather: gatherWith(deps) };
  const ctx = fakeCtx(dir);
  await startQ(ctx, g);
  const { tok, entry } = boardOf(ctx);
  ctx.buttonStore.set(tok, { ...entry, quiet: { ...entry.quiet, until: entry.quiet.until - 24 * 3600_000 } }); // yesterday's button
  await qPress(cqFor(ctx, qCallback(tok, 0, 'qz')), ctx, g);
  assert.match(ctx.edits.at(-1).text, /Bảng đã đổi — 🔄/);
  assert.equal(readOverride(dir), null);
  // state changed meanwhile (someone ran `quiet off` on the CLI): the on-board "Tắt" is stale
  const { tok: t2, entry: e2 } = boardOf(ctx);
  writeOverride(dir, { offUntil: entry.quiet.until, by: 'cli', at: NIGHT });
  const rev = e2.rev;
  await qPress(cqFor(ctx, qCallback(t2, rev, 'qz')), ctx, g);
  assert.match(ctx.edits.at(-1).text, /Bảng đã đổi — 🔄/);
  assert.ok(readOverride(dir), 'untouched');
  clearOverride(dir);
  const ctx2 = fakeCtx(dir);
  await startQ(ctx2, g);
  await qPress(cqFor(ctx2, qCallback(boardOf(ctx2).tok, 0, 'qz'), { from: 123 }), ctx2, g);
  assert.match(ctx2.answers.at(-1), /Chỉ owner/);
  assert.equal(readOverride(dir), null);
});

test('R5 /q: no CPU-gate note while the queue is paused', () => {
  const dir = tmpDir(); holder(dir, 0);
  setPolicy(dir, { paused: true });
  const r = renderQ(gatherQ({ dir, slotsOf: () => 2, gate: () => ({ ok: false, reason: 'cpu', load1: 11.2, cores: 12 }) }), { tok: 'a'.repeat(12), rev: 0 });
  assert.match(r.text, / · ⏸/);
  assert.doesNotMatch(r.text, /chờ CPU/);
});
