import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shortConvoHash } from './convo-hash.mjs';
import { PersistentMap } from './button-store.mjs';
import { listTargets, projectOf, resolveLive, candidateTopics, OTHER_PROJECT } from './broadcast.mjs';
import {
  renderBroadcast, runBroadcastCommand, bcPress, handleBroadcastButton, bcCallback, BC_BUTTON_RE, BC_MAX_TARGETS, BC_TTL_MS, MSG_STALE, MSG_INTERRUPTED,
} from './broadcast-panel.mjs';

const OWNER = '42';
const BOT = 777;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
const CFG = { _default: { chatId: '-100' }, umipay: { chatId: '-200' }, digesty: { chatId: '-300' }, shared1: { chatId: '-400' }, shared2: { chatId: '-400' }, _config: {} };
const C = (n) => String(1000000000000000 + n); // distinct convo ids
const topics = (spec) => { // spec: { chat: { convo: ts } }
  const s = {};
  let th = 1;
  for (const [chat, m] of Object.entries(spec)) { s[chat] = { _ts: {} }; for (const [c, ts] of Object.entries(m)) { s[chat][c] = th++; s[chat]._ts[c] = ts; } }
  return s;
};
const cfgFor = (store) => ({ ...CFG });
const alloc = (convoId, projectKey) => ({ v: 1, convoId: Number(convoId), botId: BOT, messageId: Number(convoId), ts: 1, projectKey, resolvedBy: 'git' });

function harness({ store: topicStore, ls, allocRows = [], role = 'admin', config = CFG, writes = [], extra = {} } = {}) {
  const buttons = new PersistentMap(path.join(tmp(), 'b.json'));
  const out = { sent: [], boards: [], edits: [], answers: [] };
  const ctx = {
    daemonUserId: OWNER, token: `${BOT}:abc`, projectsConfig: config, buttonStore: buttons,
    sendText: async (_id, t) => { out.sent.push(t); },
    sendButtonRows: async (_id, text, rows) => { out.boards.push({ text, rows }); return { message_id: 77 }; },
    editButtonRows: async (c, m, text, rows) => { out.edits.push({ c, m, text, rows }); },
    answerButton: async (id, text) => { out.answers.push(text); },
  };
  const state = { ls, now: 1_000_000 };
  const deps = {
    store: topicStore, lsRows: async () => state.ls, allocRows: () => allocRows, config, roleOf: () => role, botId: BOT, rand: () => 'a1b2c3d4e5f6',
    now: () => state.now, tmpDir: '/x', writePrompt: async (p, f) => { writes.push({ p, f }); }, ...extra,
  };
  const tok = 'a1b2c3d4e5f6';
  const cq = (data, o = {}) => ({ id: 'cq', data, from: { id: Number(OWNER) }, message: { chat: { id: OWNER }, message_id: 77, ...(o.message || {}) }, ...o.top });
  const press = (op, idx, rev, o) => handleBroadcastButton(cq(bcCallback(tok, rev ?? buttons.get(tok).rev, op, idx), o), ctx, deps);
  const start = (text = 'hello', from = { id: Number(OWNER), first_name: 'Thi' }) => runBroadcastCommand(text, from, ctx, deps);
  return { ctx, deps, buttons, out, state, tok, cq, press, start, writes };
}

// five sessions: umipay (alloc) x2, teleport (cwd worktree) x1, digesty (dedicated chat) x1, khác x1
const A = C(1), B = C(2), D = C(3), E = C(4), F = C(5);
const TOP = () => topics({ '-100': { [A]: 10, [B]: 10, [D]: 10, [F]: 10 }, '-300': { [E]: 10 } });
const LS = () => [
  { convoId: A, hashtag: shortConvoHash(A), cwd: null }, { convoId: B, hashtag: shortConvoHash(B), cwd: null },
  { convoId: D, hashtag: shortConvoHash(D), cwd: null }, { convoId: E, hashtag: shortConvoHash(E), cwd: null }, { convoId: F, hashtag: shortConvoHash(F), cwd: null },
];

// ── listTargets / projects ──

test('listTargets: groups by project (alloc → cwd worktree → dedicated chat → khác), /ls order, deduped', () => {
  const root = tmp();
  const repo = path.join(root, 'teleport');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  const wt = path.join(repo, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  const cfg = { ...CFG, teleport: { chatId: '-100x' } };
  const ls = LS();
  ls[2].cwd = path.join(wt, 'sub');           // D → worktree of teleport, from a subdir
  ls[4].cwd = root;                           // F → cwd is NOT in a git repo: nothing, falls to the chat/khác
  const t = listTargets({ store: TOP(), chatIds: ['-100', '-300'], ls, config: cfg, allocRows: [alloc(A, 'umipay'), alloc(B, 'umipay')], botId: BOT });
  assert.deepEqual(t.map((x) => [x.convoId, x.project]), [[A, 'umipay'], [B, 'umipay'], [D, 'teleport'], [E, 'digesty'], [F, OTHER_PROJECT]]);
  assert.match(t[0].label, new RegExp(`#${shortConvoHash(A)}$`));
});

test('projectOf: allocation beats cwd; chat shared by two projects → khác; no git → no cwd project', () => {
  const root = tmp(); const repo = path.join(root, 'repo-x'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const cfg = { ...CFG };
  assert.equal(projectOf({ convoId: A, chatId: '-100', cwd: repo }, { config: cfg, allocRows: [alloc(A, 'umipay')], botId: BOT }), 'umipay');
  assert.equal(projectOf({ convoId: A, chatId: '-100', cwd: repo }, { config: cfg, allocRows: [], botId: BOT }), 'repo-x');
  assert.equal(projectOf({ convoId: A, chatId: '-400', cwd: null }, { config: cfg }), OTHER_PROJECT);
  assert.equal(projectOf({ convoId: A, chatId: '-300', cwd: os.tmpdir() }, { config: cfg }), 'digesty');
  // other bot's allocation is ignored
  assert.equal(projectOf({ convoId: A, chatId: '-100', cwd: null }, { config: cfg, allocRows: [{ ...alloc(A, 'umipay'), botId: 1 }], botId: BOT }), OTHER_PROJECT);
});

test('listTargets: one convo with topics in two groups → ONE candidate, chat of the newest topic (tie → smaller chat)', () => {
  const s = topics({ '-100': { [A]: 5 }, '-200': { [A]: 9 } });
  assert.equal(candidateTopics(s, ['-100', '-200']).length, 1);
  assert.equal(candidateTopics(s, ['-100', '-200'])[0].chatId, '-200');
  const tie = topics({ '-200': { [A]: 5 }, '-100': { [A]: 5 } });
  assert.equal(candidateTopics(tie, ['-100', '-200'])[0].chatId, '-100');
});

test('resolveLive: hashtag-only /ls row matches only when the hashtag is unique store-wide; convoId rows exact', () => {
  const X = 1205483045424020, Y = 2205483045424020;
  assert.equal(shortConvoHash(X), shortConvoHash(Y));
  const s = { '-100': { [X]: 5, _ts: {} }, '-200': { [Y]: 6, _ts: {} } };
  const tg = [{ convoId: String(X), hashtag: shortConvoHash(X) }];
  assert.equal(resolveLive(tg, [{ convoId: null, hashtag: shortConvoHash(X) }], s).length, 0);   // ambiguous
  assert.equal(resolveLive(tg, [{ convoId: String(X), hashtag: shortConvoHash(X) }], s).length, 1);
  const s2 = { '-100': { [X]: 5, _ts: {} } };
  assert.equal(resolveLive(tg, [{ convoId: null, hashtag: shortConvoHash(X) }], s2).length, 1);   // unique
  assert.equal(resolveLive(tg, [], s2).length, 0);
});

// ── render ──

const entryOf = (targets, o = {}) => ({ kind: 'broadcast', rev: 0, text: 'hi', targets, projects: [...new Set(targets.map((t) => t.project))], selected: targets.map((_, i) => i), hidden: 0, ...o });
const mkT = (n, project = 'p') => ({ convoId: C(n), chatId: '-100', hashtag: shortConvoHash(C(n)), project, label: `🦊 Cáo #${shortConvoHash(C(n))}` });

test('render: all selected by default, ✅/⬜ labels, n/m on project rows, Gửi (n), callbacks < 64 bytes', () => {
  const e = entryOf([mkT(1, 'umipay'), mkT(2, 'umipay'), mkT(3, 'digesty')], { selected: [0, 2] });
  const { text, rows } = renderBroadcast(e, 'a1b2c3d4e5f6');
  assert.match(text, /Gửi tới 2\/3 session/);
  const flat = rows.flat();
  assert.match(flat[0].text, /^📁 umipay ◐ 1\/2$/);
  assert.match(flat[1].text, /^✅ /); assert.match(flat[2].text, /^⬜ /);
  assert.match(flat.find((b) => b.text.startsWith('📁 digesty')).text, /✅ 1\/1/);
  assert.equal(flat.at(-2).text, '📢 Gửi (2)');
  for (const b of flat) { assert.ok(Buffer.byteLength(b.callback_data) < 64); assert.match(b.callback_data, BC_BUTTON_RE); }
  const all = renderBroadcast(entryOf([mkT(1), mkT(2)]), 'a1b2c3d4e5f6');
  assert.match(all.rows[0][0].text, /✅ 2\/2/);
  assert.equal(renderBroadcast(entryOf([mkT(1)], { selected: [] }), 't'.padEnd(12, '0')).rows[0][0].text, '📁 p ⬜ 0/1');
});

test('render: long text cut at 600 with (+N ký tự); text stays < 4096 even with control chars; > 40 sessions hint', () => {
  const long = 'x'.repeat(1000);
  const r = renderBroadcast(entryOf([mkT(1)], { text: long }), 'a1b2c3d4e5f6');
  assert.match(r.text, /… \(\+400 ký tự\)/);
  assert.ok(r.text.includes('x'.repeat(600)) && !r.text.includes('x'.repeat(601)));
  const nasty = renderBroadcast(entryOf([mkT(1)], { text: '\u0001'.repeat(3500) }), 'a1b2c3d4e5f6');
  assert.ok(nasty.text.length < 4096);
  const many = renderBroadcast(entryOf([mkT(1)], { hidden: 5 }), 'a1b2c3d4e5f6');
  assert.match(many.text, /chỉ hiện 1\/6/);
});

test('board: cap of 40 sessions, only those 40 are ever sendable', async () => {
  const spec = {}, ls = [];
  for (let i = 0; i < 45; i++) { spec[C(100 + i)] = 10; ls.push({ convoId: C(100 + i), hashtag: shortConvoHash(C(100 + i)) }); }
  const h = harness({ store: topics({ '-100': spec }), ls });
  await h.start();
  const e = h.buttons.get(h.tok);
  assert.equal(e.targets.length, BC_MAX_TARGETS); assert.equal(e.hidden, 5);
  assert.match(h.out.boards[0].text, /chỉ hiện 40\/45/);
  assert.ok(h.out.boards[0].text.length < 4096);
  assert.ok(h.out.boards[0].rows.flat().every((b) => Buffer.byteLength(b.callback_data) < 64));
});

// ── the builtin ──

const mk2 = (o = {}) => harness({ store: TOP(), ls: LS(), allocRows: [alloc(A, 'umipay'), alloc(B, 'umipay')], ...o });

test('/broadcast: text keeps newlines and brackets; board stored with all selected', async () => {
  const h = mk2();
  await h.start('line1\nline [2] «x» "q"');
  const e = h.buttons.get(h.tok);
  assert.equal(e.text, 'line1\nline [2] «x» "q"');
  assert.equal(e.kind, 'broadcast'); assert.equal(e.state, 'open'); assert.equal(e.messageId, 77); assert.equal(e.selected.length, 5);
  assert.deepEqual(e.from, { id: Number(OWNER), name: 'Thi', role: 'admin' });
});

test('/broadcast: a disguised --chat is refused; role < admin refused; non-owner refused; > 3500 refused; empty → usage', async () => {
  let h = mk2(); await h.start('--"chat" -100 hi');
  assert.match(h.out.sent[0], /--chat phải đứng đầu/); assert.equal(h.out.boards.length, 0);
  h = mk2({ role: 'maintainer' }); await h.start('hi');
  assert.match(h.out.sent[0], /cần quyền admin/); assert.equal(h.out.boards.length, 0);
  h = mk2(); await h.start('hi', { id: 999 });
  assert.match(h.out.sent[0], /chỉ owner/); assert.equal(h.out.boards.length, 0);
  h = mk2(); await h.start('y'.repeat(3501));
  assert.match(h.out.sent[0], /quá dài/); assert.equal(h.out.boards.length, 0);
  h = mk2(); await h.start('   ');
  assert.match(h.out.sent[0], /usage/);
});

test('/broadcast --chat narrows the candidates; nothing running → no board', async () => {
  let h = mk2(); await h.start('--chat -300 hi');
  assert.deepEqual(h.buttons.get(h.tok).targets.map((t) => t.convoId), [E]);
  h = mk2({ ls: [] }); await h.start('hi');
  assert.match(h.out.sent[0], /\/ls trống/); assert.equal(h.out.boards.length, 0);
  h = mk2({ extra: { lsRows: async () => { throw new Error('ps failed'); } } }); await h.start('hi');
  assert.match(h.out.sent[0], /ps failed/); assert.equal(h.out.boards.length, 0);
});

// ── presses ──

test('press: toggle session, toggle project both ways; rev+selected persisted in one write before the redraw', async () => {
  const h = mk2(); await h.start();
  const order = [];
  const origSet = h.buttons.setStrict.bind(h.buttons);
  h.buttons.setStrict = (...a) => { order.push('set'); return origSet(...a); };
  const origEdit = h.ctx.editButtonRows;
  h.ctx.editButtonRows = async (...a) => { order.push('edit'); return origEdit(...a); };
  await h.press('t', 0);
  let e = h.buttons.get(h.tok);
  assert.deepEqual(e.selected, [1, 2, 3, 4]); assert.equal(e.rev, 1);
  assert.deepEqual(order, ['set', 'edit']);
  assert.match(h.out.edits.at(-1).rows.flat()[1].text, /^⬜/);
  await h.press('p', 0);                       // umipay has [1] selected, [0] not → select all
  assert.deepEqual(h.buttons.get(h.tok).selected, [0, 1, 2, 3, 4]);
  await h.press('p', 0);                       // all selected → clear project
  assert.deepEqual(h.buttons.get(h.tok).selected, [2, 3, 4]);
  assert.equal(h.buttons.get(h.tok).rev, 3);
});

test('press: Send with nothing selected → "Chưa chọn ai", nothing written, entry untouched', async () => {
  const h = mk2(); await h.start();
  await h.press('p', 0); await h.press('p', 1); await h.press('p', 2); await h.press('p', 3);
  assert.equal(h.buttons.get(h.tok).selected.length, 0);
  const rev = h.buttons.get(h.tok).rev;
  await h.press('s');
  assert.equal(h.out.answers.at(-1), 'Chưa chọn ai');
  assert.equal(h.writes.length, 0); assert.equal(h.buttons.get(h.tok).state, 'open'); assert.equal(h.buttons.get(h.tok).rev, rev);
});

test('press: wrong revision → stale message, nothing changes; Send with old rev refreshes and sends nothing', async () => {
  const h = mk2(); await h.start();
  await h.press('t', 0);
  await h.press('t', 1, 0);                   // old rev
  assert.equal(h.out.answers.at(-1), MSG_STALE);
  assert.deepEqual(h.buttons.get(h.tok).selected, [1, 2, 3, 4]);
  const edits = h.out.edits.length;
  await h.press('s', undefined, 0);
  assert.equal(h.writes.length, 0); assert.match(h.out.answers.at(-1), /Bảng vừa đổi/);
  assert.equal(h.out.edits.length, edits + 1); assert.ok(h.out.edits.at(-1).rows.length > 0);   // board redrawn, still open
  assert.equal(h.buttons.get(h.tok).state, 'open');
});

test('press: Send once — only selected AND running sessions, one prompt per convo, second press refused', async () => {
  const h = mk2(); await h.start('go');
  await h.press('t', 0);                      // deselect A
  h.state.ls = LS().filter((r) => r.convoId !== E);   // E stopped meanwhile
  await h.press('s');
  assert.deepEqual(h.writes.map((w) => w.f).sort(), [B, D, F].map((c) => `/x/prompt-convo-${c}.json`).sort());
  assert.equal(h.writes[0].p.text, 'go'); assert.equal(h.writes[0].p.broadcast.from.role, 'admin'); assert.equal(h.writes[0].p.fromName, 'Thi');
  assert.equal(h.buttons.get(h.tok), undefined);
  const res = h.out.edits.at(-1);
  assert.deepEqual(res.rows, []);
  assert.match(res.text, /Đã gửi 3\/4/); assert.match(res.text, /⏹ .*đã tắt/); assert.match(res.text, /Bỏ qua \(bạn bỏ chọn\): 1/);
  await h.press('s', undefined, 5);           // second press: entry gone
  assert.equal(h.writes.length, 3);
  assert.equal(h.out.answers.at(-1), MSG_STALE);
});

test('press: /ls fails at Send → fail closed, board stays open, nothing written', async () => {
  const h = mk2(); await h.start();
  h.deps.lsRows = async () => { throw new Error('ps failed'); };
  await h.press('s');
  assert.equal(h.writes.length, 0); assert.match(h.out.answers.at(-1), /ps failed/);
  assert.equal(h.buttons.get(h.tok).state, 'open');
});

test("press: 'sending' is persisted BEFORE the first prompt write; a failed state write sends nothing", async () => {
  const h = mk2(); await h.start();
  h.deps.writePrompt = async () => { assert.equal(h.buttons.get(h.tok).state, 'sending'); h.writes.push(1); };
  await h.press('s');
  assert.equal(h.writes.length, 5);
  const g = mk2(); await g.start();
  const real = g.buttons.setStrict.bind(g.buttons);
  g.buttons.setStrict = () => { throw new Error('disk full'); };
  await g.press('s');
  assert.equal(g.writes.length, 0); assert.match(g.out.answers.at(-1), /không gửi/);
  g.buttons.setStrict = real;
  assert.equal(g.buttons.get(g.tok).state, 'open');
});

test('press: failed edit of the result neither reopens the board nor re-sends (result goes out as a new message)', async () => {
  const h = mk2(); await h.start();
  h.ctx.editButtonRowsStrict = async () => { throw new Error('message to edit not found'); };
  await h.press('s');
  assert.equal(h.writes.length, 5);
  assert.equal(h.buttons.get(h.tok), undefined);
  assert.match(h.out.sent.at(-1), /Đã gửi 5\/5/);
  assert.equal(h.out.boards.length, 1);
});

test("press: a 'sending' entry (press or expiry sweep) → interrupted message, never re-sent", async () => {
  const h = mk2(); await h.start();
  h.buttons.setStrict(h.tok, { ...h.buttons.get(h.tok), state: 'sending', rev: 1 });
  await h.press('s', undefined, 1);
  assert.equal(h.writes.length, 0);
  assert.equal(h.out.edits.at(-1).text, MSG_INTERRUPTED); assert.deepEqual(h.out.edits.at(-1).rows, []);
  assert.equal(h.buttons.get(h.tok), undefined);
  // the sweep at the next /broadcast
  const g = mk2(); await g.start();
  g.buttons.setStrict(g.tok, { ...g.buttons.get(g.tok), state: 'sending', rev: 1 });
  g.deps.rand = () => 'ffffffffffff';
  await g.start('again');
  assert.equal(g.out.edits.at(-1).text, MSG_INTERRUPTED);
  assert.equal(g.buttons.get(g.tok), undefined); assert.ok(g.buttons.get('ffffffffffff'));
  assert.equal(g.writes.length, 0);
});

test('press: restart after toggle → Send does not reach the deselected session', async () => {
  const h = mk2(); await h.start();
  await h.press('t', 2);
  const file = h.buttons.file;
  h.ctx.buttonStore = new PersistentMap(file);       // "restart": reloaded from disk
  await handleBroadcastButton(h.cq(bcCallback(h.tok, 1, 's')), h.ctx, h.deps);
  assert.ok(!h.writes.some((w) => w.f.includes(`convo-${D}.json`)));
  assert.equal(h.writes.length, 4);
});

test('press: cancel and expiry', async () => {
  let h = mk2(); await h.start();
  await h.press('x');
  assert.equal(h.out.edits.at(-1).text, '✖ Đã huỷ — không gửi gì.'); assert.equal(h.buttons.get(h.tok), undefined); assert.equal(h.writes.length, 0);
  h = mk2(); await h.start();
  h.state.now += BC_TTL_MS + 1;
  await h.press('s');
  assert.equal(h.out.edits.at(-1).text, '⌛ Hết hạn — không gửi gì.'); assert.equal(h.writes.length, 0); assert.equal(h.buttons.get(h.tok), undefined);
});

test('press: wrong chatId / messageId / kind / idx out of range / non-owner / unknown token → refused, entry untouched', async () => {
  const h = mk2(); await h.start();
  const before = JSON.stringify(h.buttons.get(h.tok));
  const tryIt = async (cq) => { await handleBroadcastButton(cq, h.ctx, h.deps); assert.equal(h.out.answers.at(-1) === undefined, false); };
  await tryIt(h.cq(bcCallback(h.tok, 0, 't', 0), { message: { chat: { id: '555' } } }));
  await tryIt(h.cq(bcCallback(h.tok, 0, 't', 0), { message: { message_id: 99 } }));
  await tryIt(h.cq(bcCallback(h.tok, 0, 't', 5)));
  await tryIt(h.cq(bcCallback(h.tok, 0, 'p', 4)));
  await tryIt(h.cq(bcCallback('0'.repeat(12), 0, 's')));
  assert.equal(JSON.stringify(h.buttons.get(h.tok)), before); assert.equal(h.writes.length, 0);
  await handleBroadcastButton(h.cq(bcCallback(h.tok, 0, 's'), { top: { from: { id: 1 } } }), h.ctx, h.deps);
  assert.match(h.out.answers.at(-1), /owner/); assert.equal(h.writes.length, 0);
  h.buttons.setStrict('bbbbbbbbbbbb', { kind: 'q', createdAt: 1_000_000, chatId: OWNER, messageId: 77, rev: 0 });
  await handleBroadcastButton(h.cq(bcCallback('bbbbbbbbbbbb', 0, 's')), h.ctx, h.deps);
  assert.equal(h.out.answers.at(-1), MSG_STALE); assert.ok(h.buttons.get('bbbbbbbbbbbb'));
  assert.equal(h.writes.length, 0);
});

test('callback prefix does not collide with other button handlers', async () => {
  const { Q_BUTTON_RE } = await import('./q-panel.mjs');
  const { STOP_BUTTON_RE } = await import('./long-build.mjs');
  const { TYPE_BUTTON_RE } = await import('./type-cmd.mjs');
  const { CLEANUP_BUTTON_RE } = await import('./cleanup-inbox.mjs');
  const d = bcCallback('a1b2c3d4e5f6', 3, 't', 7);
  assert.ok(BC_BUTTON_RE.test(d));
  for (const re of [Q_BUTTON_RE, STOP_BUTTON_RE, TYPE_BUTTON_RE, CLEANUP_BUTTON_RE, /^(mg|cl|mc):/]) assert.ok(!re.test(d));
});

// ── review round 1 ──

test('resolveLive: a hashtag-only row never marks a target live when another convo now owns the hashtag', () => {
  const X = 1205483045424020, Y = 2205483045424020;
  const tg = [{ convoId: String(X), hashtag: shortConvoHash(X) }];
  const row = [{ convoId: null, hashtag: shortConvoHash(X) }];
  assert.equal(resolveLive(tg, row, { '-100': { [Y]: 6, _ts: {} } }).length, 0);   // X replaced by Y in the store
  assert.equal(resolveLive(tg, row, { '-100': { [X]: 6, _ts: {} } }).length, 1);
});

test('press: store changes between board and Send (hashtag now owned by another convo) → stopped target gets no prompt', async () => {
  const X = 1205483045424020, Y = 2205483045424020;
  const tgt = { convoId: String(X), chatId: '-100', hashtag: shortConvoHash(X), project: 'p', label: 'x' };
  const h = harness({ store: { '-100': { [X]: 5, _ts: {} } }, ls: [{ convoId: null, hashtag: shortConvoHash(X), cwd: null }] });
  h.buttons.setStrict(h.tok, { ...entryOf([tgt]), createdAt: h.state.now, chatId: OWNER, messageId: 77, state: 'open' });
  h.deps.store = { '-100': { [Y]: 6, _ts: {} } };
  await h.press('s', undefined, 0);
  assert.equal(h.writes.length, 0);
});

test('/broadcast: sweep of an interrupted board runs even with empty /ls and with failing /ls', async () => {
  for (const extra of [{ lsRows: async () => [] }, { lsRows: async () => { throw new Error('ps failed'); } }]) {
    const h = mk2({ extra }); h.deps.rand = () => 'ffffffffffff';
    h.buttons.setStrict('oldtoken0000', { kind: 'broadcast', state: 'sending', chatId: OWNER, messageId: 55, createdAt: h.state.now, rev: 1, targets: [], projects: [], selected: [] });
    await h.start('hi');
    assert.equal(h.out.boards.length, 0);
    assert.equal(h.out.edits.at(-1).text, MSG_INTERRUPTED); assert.equal(h.out.edits.at(-1).m, 55);
    assert.equal(h.buttons.get('oldtoken0000'), undefined);
  }
});

test("'sending' record survives a failed interruption edit (press and sweep); a later working edit removes it; never re-sends", async () => {
  const h = mk2(); await h.start();
  h.buttons.setStrict(h.tok, { ...h.buttons.get(h.tok), state: 'sending', rev: 1 });
  const ok = h.ctx.editButtonRows;
  h.ctx.editButtonRows = async () => { throw new Error('tg down'); };
  await h.press('s', undefined, 1);
  assert.ok(h.buttons.get(h.tok)); assert.equal(h.buttons.get(h.tok).state, 'sending');
  assert.match(h.out.answers.at(-1), /gián đoạn/); assert.equal(h.writes.length, 0);
  h.deps.rand = () => 'ffffffffffff';
  await h.start('again');                      // sweep with failing edit: still kept
  assert.ok(h.buttons.get(h.tok));
  h.ctx.editButtonRows = ok;
  await h.start('third');                      // sweep with working edit: removed
  assert.equal(h.buttons.get(h.tok), undefined);
  assert.equal(h.out.edits.at(-1).text, MSG_INTERRUPTED); assert.equal(h.writes.length, 0);
});
