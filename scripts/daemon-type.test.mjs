import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startType, handleTypeButton, takeTypeButton, typeStep2, takeMergeButton, dispatchCommand } from './daemon.mjs';

const T = { pid: 644406, procStart: '5', sessionId: 'S', screenPid: 644405, screen: 'tele-c2383556', hashtag: 'c2383556', cwd: '/w' };
const T2 = { ...T, pid: 331131, screenPid: 331130, screen: 'tele-d8133684', hashtag: 'd8133684' };
const idle = { mismatch: null, state: 'idle', status: 'shell', bridge: null, usage: { compacted: false, tokens: 693000, model: 'm' } };
const agent = (t, obs = idle) => ({ target: t, obs, line: `#${t.hashtag} · PID ${t.pid} · rảnh` });

function ui() {
  const calls = [];
  let nextId = 100;
  return {
    calls,
    ctx: {
      daemonUserId: '42', projectsConfig: {}, buttonStore: new Map(),
      sendText: async (c, t) => { calls.push(['text', t]); },
      sendButtonRows: async (c, t, rows) => { calls.push(['send', t, rows]); return { message_id: nextId++ }; },
      editButtonRows: async (c, m, t, rows) => { calls.push(['edit', t, rows]); },
      answerButton: async (id, t) => { calls.push(['answer', t]); },
    },
  };
}
const cq = (data, text, messageId = 100) => ({ id: 'q', data, from: { id: 42 }, message: { chat: { id: 42 }, message_id: messageId, text } });

test('typeStep2: buttons follow the state (idle → /compact + /remote-control; busy → /compact (queued) + Esc; waiting → Esc; bridged → no /remote-control)', () => {
  const ops = (obs) => typeStep2({ target: T, obs, tok: 'a'.repeat(16) }).rows[0].map((b) => b.callback_data.split(':')[2]);
  assert.deepEqual(ops(idle), ['c', 'r', 'i', 'x']);
  assert.deepEqual(ops({ ...idle, state: 'busy' }), ['c', 'e', 'i', 'x']);
  assert.deepEqual(ops({ ...idle, state: 'waiting' }), ['e', 'x']);
  assert.deepEqual(ops({ ...idle, bridge: 'session_B' }), ['c', 'i', 'x']);
  assert.deepEqual(ops({ mismatch: 'phiên đã đổi' }), ['x']);
  const s = typeStep2({ target: T, obs: { ...idle, bridge: 'session_B' }, persona: '🧛 Ma', tok: 'a'.repeat(16) });
  assert.match(s.text, /🧛 Ma #c2383556 · PID 644406 · rảnh · ctx 693k · 📡/);
  assert.match(s.text, /claude\.ai\/code\/session_B/);
});

test('/type (no arg): one pick button per agent, no stored entry; /type #hash: step 2 + one entry bound to its message', async () => {
  const { ctx, calls } = ui();
  await startType('', ctx, { list: () => [agent(T), agent(T2)] });
  assert.equal(calls[0][0], 'send');
  assert.deepEqual(calls[0][2].map((r) => r[0].callback_data), ['ty:pick:c2383556', 'ty:pick:d8133684']);
  assert.equal(ctx.buttonStore.size, 0);
  await startType('#c2383556', ctx, { list: () => [agent(T), agent(T2)] });
  const [tok, e] = [...ctx.buttonStore][0];
  assert.equal(e.kind, 'type');
  assert.equal(e.messageId, 101);
  assert.equal(e.target.pid, 644406);
  assert.ok(calls[1][2][0].some((b) => b.callback_data === `ty:${tok}:c`));
  await startType('#ffffffff', ctx, { list: () => [agent(T)] });
  assert.match(calls.at(-1)[1], /không thấy agent #ffffffff/);
});

test('/type is owner-only (an admin who is not the owner is refused)', async () => {
  const { ctx, calls } = ui();
  await dispatchCommand({ cmd: 'type', rest: '' }, { id: 7 }, { ...ctx, registry: {}, projectsConfig: { _config: { roles: { 7: 'admin' } } } });
  assert.match(calls[0][1], /chỉ owner/);
});

test('pick: hash must be in the message; the agent is looked up FRESH; step 2 replaces the message', async () => {
  const { ctx, calls } = ui();
  await handleTypeButton(cq('ty:pick:c2383556', 'menu without it'), ctx, { list: () => [agent(T)] });
  assert.match(calls[0][1], /không khớp/);
  await handleTypeButton(cq('ty:pick:c2383556', '⌨️ /type — chọn agent:\n• #c2383556 · PID 644406'), ctx, { list: () => [agent(T)] });
  const edit = calls.find((c) => c[0] === 'edit');
  assert.match(edit[1], /#c2383556 · PID 644406/);
  assert.equal([...ctx.buttonStore.values()][0].messageId, 100);
  await handleTypeButton(cq('ty:pick:c2383556', '• #c2383556'), ctx, { list: () => [] });
  assert.match(calls.at(-1)[1], /không còn trong screen/);
});

test('op press: runs the FIXED op on the stored target; one-shot; result edited in; the agent is told after a confirmed compact', async () => {
  const { ctx, calls } = ui();
  const target = { ...T, sessionId: 'ae61d4f1-5ecc-46fe-9cea-75b4c9d9b751' };
  ctx.buttonStore.set('a'.repeat(16), { kind: 'type', target, chatId: 42, messageId: 100, createdAt: Date.now() });
  const delivered = [];
  const deliver = async (res, opts) => { delivered.push(opts.build({ ...res, chatId: '-100' })); };
  const ran = [];
  const runner = { run: async (op, t) => { ran.push([op, t.pid]); return { text: '⌨️ đã gõ /compact vào #c2383556 — đang chờ kết quả…', watch: async () => '✅ đã compact: 763k → 8k' }; } };
  const text = '⌨️ /type — #c2383556 · PID 644406 · rảnh\nChọn lệnh';
  await handleTypeButton(cq(`ty:${'a'.repeat(16)}:c`, text), ctx, { runner, deliver });
  assert.deepEqual(ran, [['c', 644406]]);
  assert.match(calls.at(-1)[1], /đã gõ \/compact vào #c2383556\n✅ đã compact: 763k → 8k/);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].convoId, 3067763322383556); // the compacted agent's own convo
  assert.equal(delivered[0].text, '🤖 Teleport daemon: Owner vừa compact bạn thông qua daemon (/type) — 763k → 8k.');
  assert.equal(delivered[0].fromRole, 'daemon');
  await handleTypeButton(cq(`ty:${'a'.repeat(16)}:c`, text), ctx, { runner, deliver }); // double tap
  assert.equal(ran.length, 1);
  assert.match(calls.at(-1)[1], /Hết hạn/);
});

test('op press refused: tampered target (not named in the message), other message, expired, cancel', async () => {
  const text = '⌨️ /type — #c2383556 · PID 644406 · rảnh';
  const runner = { run: async () => { throw new Error('must not run'); } };
  const cases = [
    [{ kind: 'type', target: T2, chatId: 42, messageId: 100, createdAt: Date.now() }, /không khớp/],      // entry swapped to another agent
    [{ kind: 'type', target: T, chatId: 42, messageId: 999, createdAt: Date.now() }, /không khớp/],       // entry of another message
    [{ kind: 'type', target: T, chatId: 7, messageId: 100, createdAt: Date.now() }, /không khớp/],        // another chat
    [{ kind: 'type', target: T, chatId: 42, messageId: 100, createdAt: Date.now() - 11 * 60_000 }, /Hết hạn/],
  ];
  for (const [entry, re] of cases) {
    const { ctx, calls } = ui();
    ctx.buttonStore.set('b'.repeat(16), entry);
    await handleTypeButton(cq(`ty:${'b'.repeat(16)}:c`, text), ctx, { runner });
    assert.match(calls.at(-1)[1], re);
  }
  const { ctx, calls } = ui();
  ctx.buttonStore.set('b'.repeat(16), { kind: 'type', target: T, chatId: 42, messageId: 100, createdAt: Date.now() });
  await handleTypeButton(cq(`ty:${'b'.repeat(16)}:x`, text), ctx, { runner });
  assert.match(calls.at(-1)[1], /Đã huỷ/);
});

test('button store: merge taker never consumes /type (or any kind) entries; /type taker sweeps only its own kind', () => {
  const store = new Map([
    ['t', { kind: 'type', target: T, createdAt: 0 }],
    ['old', { kind: 'type', target: T, createdAt: 0 }],
    ['m', { links: ['x'], createdAt: 0 }],
    ['c', { kind: 'cleanup', createdAt: 0 }],
  ]);
  assert.equal(takeMergeButton('t', { store, now: 1000 }), null);
  assert.ok(store.has('t'), 'mg:<type token> must not delete the type entry');
  assert.equal(takeTypeButton('m', { store, now: 11 * 60_000 }), null); // not a type entry
  assert.ok(store.has('m') && store.has('c'));
  assert.ok(!store.has('old') && !store.has('t'), 'expired type entries swept');
  const fresh = new Map([['f', { kind: 'type', createdAt: 0 }]]);
  assert.equal(takeTypeButton('f', { store: fresh, now: 1000 }).kind, 'type');
  assert.equal(fresh.size, 0);
});

test('/type arguments: one optional #hashtag; anything else → usage (never a lookup of junk)', async () => {
  for (const bad of ['#c2383556 /compact', 'not-a-hash', '#c23835']) {
    const { ctx, calls } = ui();
    await startType(bad, ctx, { list: () => { throw new Error('must not list'); } });
    assert.match(calls[0][1], /usage: \/type/);
  }
});

test('compact notice: only after a CONFIRMED compaction (not on "not enough", timeout, Esc or /remote-control)', async () => {
  const target = { ...T, sessionId: 'ae61d4f1-5ecc-46fe-9cea-75b4c9d9b751' };
  const text = '⌨️ /type — #c2383556 · PID 644406 · rảnh';
  for (const [op, res] of [
    ['c', { text: '⌨️ đã gõ /compact vào #c2383556 — đang chờ kết quả…', watch: async () => 'ℹ️ Claude báo: chưa đủ tin nhắn để compact.' }],
    ['c', { text: '⌨️ đã gõ /compact vào #c2383556 — đang chờ kết quả…', watch: async () => '❔ chưa thấy compact xong sau 5 phút — kiểm tra tay.' }],
    ['e', { text: '⌨️ đã gửi Esc — đã ngắt, giờ rảnh.' }],
    ['r', { text: '📡 Remote Control đã bật: https://claude.ai/code/session_X' }],
  ]) {
    const { ctx } = ui();
    ctx.buttonStore.set('c'.repeat(16), { kind: 'type', target, chatId: 42, messageId: 100, createdAt: Date.now() });
    const delivered = [];
    await handleTypeButton(cq(`ty:${'c'.repeat(16)}:${op}`, text), ctx, { runner: { run: async () => res }, deliver: async (r) => { delivered.push(r); } });
    assert.equal(delivered.length, 0, `${op}: ${res.text}`);
  }
});
