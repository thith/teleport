import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startType, handleTypeButton, takeTypeButton, typeStep2, takeMergeButton, dispatchCommand, killViaSpawn, runTypeCommand, startTapKill, parseDaemonCommand } from './daemon.mjs';

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
  assert.deepEqual(ops(idle), ['c', 'r', 'i', 'k', 'x']);
  assert.deepEqual(ops({ ...idle, state: 'busy' }), ['c', 'e', 'i', 'k', 'x']);
  assert.deepEqual(ops({ ...idle, state: 'waiting' }), ['e', 'k', 'x']);
  assert.deepEqual(ops({ ...idle, state: 'unknown' }), ['k', 'x']); // nothing to type, still killable
  assert.deepEqual(ops({ ...idle, bridge: 'session_B' }), ['c', 'i', 'k', 'x']);
  assert.deepEqual(ops({ mismatch: 'phiên đã đổi' }), ['x']);
  assert.deepEqual(ops({ ...idle, usage: { tokens: 99_999 } }), ['r', 'i', 'k', 'x'], 'under 100k: no /compact');
  assert.deepEqual(ops({ ...idle, usage: { tokens: 100_000 } }), ['c', 'r', 'i', 'k', 'x']);
  assert.deepEqual(ops({ ...idle, usage: null }), ['c', 'r', 'i', 'k', 'x'], 'unknown usage keeps it');
  const s = typeStep2({ target: T, obs: { ...idle, bridge: 'session_B' }, persona: '🧛 Ma', tok: 'a'.repeat(16) });
  assert.match(s.text, /🧛 Ma #c2383556 · PID 644406 · rảnh · ctx 693k · 📡/);
  assert.match(s.text, /claude\.ai\/code\/session_B/);
});

test('/type (no arg): one pick button per agent, no stored entry; /type #hash: step 2 + one entry bound to its message', async () => {
  const { ctx, calls } = ui();
  await startType('', ctx, { list: () => [agent(T), agent(T2)] });
  assert.equal(calls[0][0], 'send');
  assert.deepEqual(calls[0][2].map((r) => r[0].callback_data), ['ty:pick:c2383556', 'ty:pick:d8133684']);
  assert.match(calls[0][1], /#c2383556 · PID 644406/); // the list keeps the #hash (the pick is checked against it)
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

test('/type (no arg): the pick button shows persona (or #hash) + context use, not just the hashtag', async () => {
  const { ctx, calls } = ui();
  const personaOf = (h) => (h === 'c2383556' ? '👻 Ma' : null);
  await startType('', ctx, { personaOf, list: () => [{ ...agent(T), ctx: 'ctx 693k (35%)' }, { ...agent(T2), ctx: 'ctx 12k (1%)' }, agent({ ...T2, hashtag: 'e0000001' })] });
  assert.deepEqual(calls[0][2].map((r) => r[0].text), ['👻 Ma · 693k (35%)', '#d8133684 · 12k (1%)', '#e0000001']);
});

test('step 2 buttons are emoji only except Esc', () => {
  const s = typeStep2({ target: T, obs: { ...idle, state: 'busy' }, tok: 'a'.repeat(16) });
  assert.deepEqual(s.rows[0].map((b) => b.text), ['🗜️', 'Esc', '🔍', '💀', '✖']);
  assert.deepEqual(typeStep2({ target: T, obs: idle, tok: 'a'.repeat(16) }).rows[0].map((b) => b.text), ['🗜️', '📡', '🔍', '💀', '✖']);
});

test('💀 asks first (fresh one-shot ✅ token); ✅ re-checks the pinned process, then runs /kill pid:', async () => {
  const text = '⌨️ /type — #c2383556 · PID 644406 · rảnh\nChọn lệnh';
  const runner = { run: async () => { throw new Error('kill must not type'); } };
  const { ctx, calls } = ui();
  ctx.buttonStore.set('a'.repeat(16), { kind: 'type', target: T, chatId: 42, messageId: 100, createdAt: Date.now() });
  const killed = [];
  const kill = async (t, from) => { killed.push([t.pid, from.id]); return '[spawn] ✅ PID 644406 stopped'; };
  await handleTypeButton(cq(`ty:${'a'.repeat(16)}:k`, text), ctx, { runner, kill });
  assert.equal(killed.length, 0); // the first tap only asks
  const ask = calls.at(-1);
  assert.match(ask[1], /^⌨️ \/type — #c2383556 · PID 644406 · rảnh\n\n💀 Kill/);
  assert.deepEqual(ask[2][0].map((b) => b.text), ['✅', '✖']);
  const yes = ask[2][0][0].callback_data;
  assert.match(yes, /^ty:[0-9a-f]{16}:y$/);
  // identity only: a second screen window (windows 2) does not block the kill
  const audits = [];
  const live = { session: () => ({ sessionId: 'S', status: 'idle' }), proc: () => ({ comm: 'claude', start: '5' }), windows: () => 2, audit: (e) => audits.push(e) };
  await handleTypeButton(cq(yes, ask[1]), ctx, { runner, kill, io: live });
  assert.deepEqual(killed, [[644406, 42]]);
  assert.match(calls.at(-1)[1], /PID 644406 stopped/);
  await handleTypeButton(cq(yes, ask[1]), ctx, { runner, kill, io: live }); // double tap
  assert.equal(killed.length, 1);
  // the pid now belongs to another process → refused, nothing killed
  const { ctx: c2, calls: k2 } = ui();
  c2.buttonStore.set('c'.repeat(16), { kind: 'type', target: T, chatId: 42, messageId: 100, createdAt: Date.now(), ops: ['y', 'x'] });
  await handleTypeButton(cq(`ty:${'c'.repeat(16)}:y`, text), c2, { runner, kill, io: { ...live, proc: () => ({ comm: 'claude', start: '9' }) } });
  assert.equal(killed.length, 1);
  assert.match(k2.at(-1)[1], /không kill/);
  assert.deepEqual(audits.map((a) => [a.step, a.reason]), [['kill', undefined], ['refused', 'PID đã thuộc tiến trình khác']]);
});

test('a token answers only its own buttons: ✅ from a step-2 or 🧹 token is refused (the confirm cannot be skipped)', async () => {
  const text = '⌨️ /type — #c2383556 · PID 644406 · rảnh';
  const kill = async () => { throw new Error('must not kill'); };
  for (const ops of [['c', 'r', 'i', 'k', 'x'], ['u', 'x'], undefined]) {
    const { ctx, calls } = ui();
    ctx.buttonStore.set('d'.repeat(16), { kind: 'type', target: T, chatId: 42, messageId: 100, createdAt: Date.now(), ops });
    await handleTypeButton(cq(`ty:${'d'.repeat(16)}:y`, text), ctx, { kill });
    assert.match(calls.at(-1)[1], /Nút không khớp/);
  }
  const { ctx, calls } = ui(); // /type #hash stores the ops it showed
  await startType('#c2383556', ctx, { list: () => [agent(T)] });
  assert.deepEqual([...ctx.buttonStore.values()][0].ops, ['c', 'r', 'i', 'k', 'x']);
  assert.ok(calls.length);
});

test('killViaSpawn: spawn.mjs --kill pid:<PID> --expect-start <start>, sender id in env; error output surfaced', async () => {
  const seen = [];
  const ok = async (bin, argv, opts) => { seen.push([argv.slice(1), opts.env.TELE_FROM_ID]); return { stdout: '[spawn] ✅ stopped\n', stderr: '' }; };
  const ctx = { registry: { kill: { run: 'spawn.mjs', args: ['--kill'], minRole: 'maintainer' } }, projectsConfig: {}, secretEnvKeys: [] };
  assert.equal(await killViaSpawn(T, { id: 42 }, ctx, { runner: ok, scriptsDir: '/s' }), '[spawn] ✅ stopped');
  assert.deepEqual(seen[0], [['--kill', 'pid:644406', '--expect-start', '5'], '42']);
  const fail = async () => { const e = new Error('exit 1'); e.stdout = ''; e.stderr = '[spawn] ❌ pid reused'; throw e; };
  assert.match(await killViaSpawn(T, { id: 42 }, ctx, { runner: fail }), /pid reused/);
});

// ── RFC 26: 👋, /compact, /nudge, /kill_<hash> ───────────────────────────────

test('typeStep2: 👋 only when the listener is off or mail waits, and only idle/busy', () => {
  const ops = (obs, signals) => typeStep2({ target: T, obs, tok: 'a'.repeat(16), signals }).rows[0].map((b) => b.callback_data.split(':')[2]);
  assert.deepEqual(ops(idle, { listener: 'on', mail: 0 }), ['c', 'r', 'i', 'k', 'x']);
  assert.deepEqual(ops(idle, { listener: 'off', mail: 0 }), ['c', 'r', 'i', 'n', 'k', 'x']);
  assert.deepEqual(ops({ ...idle, state: 'busy' }, { listener: 'on', mail: 2 }), ['c', 'e', 'i', 'n', 'k', 'x']);
  assert.deepEqual(ops({ ...idle, state: 'waiting' }, { listener: 'off', mail: 1 }), ['e', 'k', 'x']);
  assert.deepEqual(ops(idle, null), ['c', 'r', 'i', 'k', 'x'], 'unknown signals → no 👋');
  assert.match(typeStep2({ target: T, obs: idle, tok: 'a'.repeat(16), signals: { listener: 'off', mail: 3 } }).text, /🔇 listener tắt · 📬 3 thư chưa đọc/);
});

const row = (o) => ({ screen: `tele-${o.hashtag}`, screenPid: o.pid - 1, ppid: o.pid - 1, guessed: false, procStart: '5', cwd: '/w', ...o });
const liveIo = { session: () => ({ sessionId: 'S', status: 'idle' }), proc: () => ({ comm: 'claude', start: '5' }), ppid: () => 644405, windows: () => 1, transcript: () => ({ ended: true, usage: { tokens: 42000 } }) };

test('/compact <name>: runs TypeRunner op c on the found agent; under 100k it still runs, with a note; result sent after', async () => {
  const sent = []; const ran = []; const delivered = [];
  const ctx = { daemonUserId: '42', sendText: async (c, t) => sent.push(t), projectsConfig: {} };
  const runner = { run: async (op, t) => { ran.push([op, t.pid]); return { text: '⌨️ đã gõ /compact vào #c2383556 — đang chờ kết quả…', watch: async () => '✅ đã compact: 42k → 8k' }; } };
  await runTypeCommand('c', 'Ma', { id: 42 }, ctx, { list: () => [row({ pid: 644406, hashtag: 'c2383556', sessionId: 'S', name: 'umipay-ae' })], io: liveIo, runner, personaOf: (h) => (h === 'c2383556' ? '👻 Ma' : null), deliver: async (p) => delivered.push(p) });
  assert.deepEqual(ran, [['c', 644406]]);
  assert.match(sent[0], /ctx 42k/);
  assert.match(sent[1], /#c2383556: ✅ đã compact/);
});

test('/nudge: no target → usage; unknown → error; drifted target → no run', async () => {
  const sent = []; const ctx = { daemonUserId: '42', sendText: async (c, t) => sent.push(t), projectsConfig: {} };
  const runner = { run: async () => { throw new Error('must not run'); } };
  await runTypeCommand('n', '', { id: 42 }, ctx, { list: () => [], io: liveIo, runner });
  assert.match(sent.at(-1), /usage: \/nudge/);
  await runTypeCommand('n', 'Nobody', { id: 42 }, ctx, { list: () => [], io: liveIo, runner });
  assert.match(sent.at(-1), /không thấy/);
  await runTypeCommand('n', '#c2383556', { id: 42 }, ctx, { list: () => [row({ pid: 644406, hashtag: 'c2383556', sessionId: 'S' })], io: { ...liveIo, windows: () => 2 }, runner });
  assert.match(sent.at(-1), /2 cửa sổ/);
});

test('/kill_<hash>: asks ✅ with the /type layout; guessed / twin / absent refused; ✅ goes through the 💀 branch', async () => {
  const { ctx, calls } = ui();
  const sent = []; ctx.sendText = async (c, t) => sent.push(t);
  const r = row({ pid: 644406, hashtag: 'c2383556', sessionId: 'S' });
  await startTapKill('#c2383556', ctx, { list: () => [], io: liveIo });
  assert.match(sent.at(-1), /không chạy — \/resume_c2383556/);
  await startTapKill('#c2383556', ctx, { list: () => [{ ...r, guessed: true }], io: liveIo });
  assert.match(sent.at(-1), /không xác định chắc/);
  await startTapKill('#c2383556', ctx, { list: () => [r, { ...r, pid: 7, sessionId: 'S2' }], io: liveIo });
  assert.match(sent.at(-1), /khớp 2 process/);
  await startTapKill('#c2383556', ctx, { list: () => [{ ...r, screen: null, screenPid: null, ppid: 1 }], io: liveIo, personaOf: () => '👻 Ma' });
  const ask = calls.at(-1);
  assert.match(ask[1], /^💀 👻 Ma #c2383556 · PID 644406 · rảnh · ctx 42k\n\nKill agent này/);
  const yes = ask[2][0][0].callback_data;
  const killed = [];
  await handleTypeButton(cq(yes, ask[1]), ctx, { kill: async (t) => { killed.push(t.pid); return 'ok'; }, io: { ...liveIo, audit: () => {} } });
  assert.deepEqual(killed, [644406], 'terminal agent killed through the same ✅ branch');
});

test('dispatch: /compact, /nudge, a tapped /kill are owner-only; typed /kill still goes to the registry', async () => {
  const sent = [];
  const base = { daemonUserId: '42', projectsConfig: {}, registry: {}, sendText: async (c, t) => sent.push(t) };
  for (const text of ['/compact Ma', '/nudge_c2383556', '/kill_c2383556']) {
    await dispatchCommand(parseDaemonCommand(text), { id: 7 }, base);
    assert.match(sent.at(-1), /chỉ owner/);
  }
  assert.deepEqual(parseDaemonCommand('/kill_c2383556'), { cmd: 'kill', rest: '#c2383556', tapped: true });
  assert.deepEqual(parseDaemonCommand('/kill c2383556'), { cmd: 'kill', rest: 'c2383556' });
});
