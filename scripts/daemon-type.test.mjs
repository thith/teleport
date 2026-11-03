import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startType, handleTypeButton, takeTypeButton, typeStep2, takeMergeButton, dispatchCommand, killViaSpawn, runTypeCommand, startTapKill, nudgeAll, parseDaemonCommand, compactKillVisible } from './daemon.mjs';
import { TypeRunner } from './type-cmd.mjs';

const T = { pid: 644406, procStart: '5', sessionId: 'S', screenPid: 644405, screen: 'tele-c2383556', hashtag: 'c2383556', cwd: '/w' };
const T2 = { ...T, pid: 331131, screenPid: 331130, screen: 'tele-d8133684', hashtag: 'd8133684' };
const idle = { mismatch: null, state: 'idle', status: 'shell', bridge: null, usage: { compacted: false, tokens: 693000, model: 'm' } };
const asRow = (t) => ({ ...t, ppid: t.screenPid, guessed: false }); // a /ls row for a pinned target
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
  await startType('#c2383556', ctx, { list: () => [agent(T), agent(T2)], procs: () => [asRow(T), asRow(T2)] });
  const [tok, e] = [...ctx.buttonStore][0];
  assert.equal(e.kind, 'type');
  assert.equal(e.messageId, 101);
  assert.equal(e.target.pid, 644406);
  assert.ok(calls[1][2][0].some((b) => b.callback_data === `ty:${tok}:c`));
  await startType('#ffffffff', ctx, { list: () => [agent(T)], procs: () => [asRow(T)] });
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
  await handleTypeButton(cq('ty:pick:c2383556', '⌨️ /type — chọn agent:\n• #c2383556 · PID 644406'), ctx, { list: () => [agent(T)], procs: () => [asRow(T)] });
  const edit = calls.find((c) => c[0] === 'edit');
  assert.match(edit[1], /#c2383556 · PID 644406/);
  assert.equal([...ctx.buttonStore.values()][0].messageId, 100);
  await handleTypeButton(cq('ty:pick:c2383556', '• #c2383556'), ctx, { list: () => [], procs: () => [asRow(T)] });
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

test('/type <x>: the same lookup as /compact (hashtag, tail, name); junk or an unknown target → refusal + usage, never a menu or a keystroke', async () => {
  for (const bad of ['#c2383556 /compact', 'not-a-hash', '#c23835', '999']) {
    const { ctx, calls } = ui();
    await startType(bad, ctx, { list: () => { throw new Error('must not list'); }, procs: () => [asRow(T), asRow(T2)] });
    assert.match(calls[0][1], /❌ \/type: .*\nusage: \/type/s);
    assert.equal(ctx.buttonStore.size, 0);
  }
});

test('/type <3 digits | name> (RFC 28): resolved over ALL live rows; a terminal twin of the tail makes it ambiguous; a name goes by the row\'s own persona', async () => {
  const personaOf = (x) => ({ c2383556: '👻 Ma' })[x.hashtag] || null;
  // tail 556 → T only → step 2 for T
  const a = ui();
  await startType('556', a.ctx, { list: () => [agent(T), agent(T2)], procs: () => [asRow(T), asRow(T2)], personaOf });
  assert.match(a.calls[0][1], /👻 Ma #c2383556/);
  assert.equal([...a.ctx.buttonStore.values()][0].target.pid, 644406);
  // a terminal claude (not typeable) shares the tail with a different hashtag → refuse, list both
  const b = ui();
  await startType('556', b.ctx, { list: () => [agent(T), agent(T2)], procs: () => [asRow(T), asRow(T2), { pid: 9, hashtag: 'e9999556', sessionId: 'X', screen: null, ppid: 1 }], personaOf });
  assert.match(b.calls[0][1], /khớp 2 agent.*#c2383556.*#e9999556/s);
  assert.equal(b.ctx.buttonStore.size, 0);
  // name → persona
  const c = ui();
  await startType('ma', c.ctx, { list: () => [agent(T), agent(T2)], procs: () => [asRow(T), asRow(T2)], personaOf });
  assert.equal([...c.ctx.buttonStore.values()][0].target.pid, 644406);
});

test('pick button: two live agents behind one hashtag → nothing is picked', async () => {
  const { ctx, calls } = ui();
  await handleTypeButton(cq('ty:pick:c2383556', '⌨️ /type — chọn agent:\n• #c2383556 · PID 644406'), ctx, { list: () => [agent(T), agent({ ...T, pid: 7 })], procs: () => [asRow(T), asRow({ ...T, pid: 7 })] });
  assert.match(calls.at(-1)[1], /2 process/);
  assert.equal(ctx.buttonStore.size, 0);
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
  const personaOf = (x) => (x.hashtag === 'c2383556' ? '👻 Ma' : null);
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
  await startType('#c2383556', ctx, { list: () => [agent(T)], procs: () => [asRow(T)] });
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
  await runTypeCommand('c', 'Ma', { id: 42 }, ctx, { list: () => [row({ pid: 644406, hashtag: 'c2383556', sessionId: 'S', name: 'umipay-ae' })], io: liveIo, runner, personaOf: (x) => (x.hashtag === 'c2383556' ? '👻 Ma' : null), deliver: async (p) => delivered.push(p) });
  assert.deepEqual(ran, [['c', 644406]]);
  assert.match(sent[0], /ctx 42k/);
  assert.match(sent[1], /^👻 Ma #c2383556: ✅ đã compact/);
});

test('/compact with no target → usage', async () => {
  const sent = []; const ctx = { daemonUserId: '42', sendText: async (c, t) => sent.push(t), projectsConfig: {} };
  await runTypeCommand('c', '', { id: 42 }, ctx, { list: () => [], io: liveIo, runner: { run: async () => { throw new Error('must not run'); } } });
  assert.match(sent.at(-1), /usage: \/compact/);
});

test('/nudge with no target: every agent with listener off or mail, never a healthy one, a twin hashtag or a drifted one', async () => {
  const sent = []; const ran = [];
  const ctx = { daemonUserId: '42', sendText: async (c, t) => sent.push(t), projectsConfig: {} };
  const runner = { run: async (op, t, who, o) => { ran.push([op, t.hashtag, o.persona]); return { text: `👋 đã nudge ${o.persona ? `${o.persona} ` : ''}#${t.hashtag}.` }; } };
  const sig = { aaaa0001: { listener: 'off', mail: 0 }, aaaa0002: { listener: 'on', mail: 2 }, aaaa0003: { listener: 'on', mail: 0 }, aaaa0004: { listener: 'off', mail: 1 }, aaaa0005: { listener: null, mail: null } };
  const rows = [
    row({ pid: 101, hashtag: 'aaaa0001', sessionId: 'S' }), row({ pid: 102, hashtag: 'aaaa0002', sessionId: 'S' }),
    row({ pid: 103, hashtag: 'aaaa0003', sessionId: 'S' }), row({ pid: 104, hashtag: 'aaaa0004', sessionId: 'S' }),
    { pid: 900, hashtag: 'aaaa0004', sessionId: 'S9', procStart: '5' }, // a terminal twin of aaaa0004
    row({ pid: 105, hashtag: 'aaaa0005', sessionId: 'S' }),
  ];
  const io = { ...liveIo, ppid: (pid) => pid - 1, nudgeSignals: (t) => sig[t.hashtag] };
  await nudgeAll({ id: 42 }, ctx, { list: () => rows, io, runner, personaOf: (x) => (x.hashtag === 'aaaa0001' ? '🐺 Sói' : null) });
  assert.deepEqual(ran, [['n', 'aaaa0001', '🐺 Sói'], ['n', 'aaaa0002', null]]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /đã nudge 🐺 Sói #aaaa0001\.\n👋 đã nudge #aaaa0002\.\n❌ #aaaa0004: hashtag trùng 2 process/);
  await nudgeAll({ id: 42 }, ctx, { list: () => [rows[2]], io, runner });
  assert.match(sent.at(-1), /không có agent nào cần nudge/);
  await nudgeAll({ id: 42 }, ctx, { list: () => [rows[1]], io, runner: { run: async () => ({ text: '❌ agent đang chờ hộp thoại — không gõ x.' }) } });
  assert.match(sent.at(-1), /^#aaaa0002: ❌ agent đang chờ hộp thoại/, 'a refusal is prefixed with the agent');
  await runTypeCommand('n', '', { id: 42 }, ctx, { list: () => [rows[0]], io: { ...io, windows: () => 2 }, runner });
  assert.match(sent.at(-1), /#aaaa0001: .*2 cửa sổ.*bỏ qua/);
});

test('/nudge: unknown → error; drifted target → no run', async () => {
  const sent = []; const ctx = { daemonUserId: '42', sendText: async (c, t) => sent.push(t), projectsConfig: {} };
  const runner = { run: async () => { throw new Error('must not run'); } };
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
  await startTapKill('#c2383556', ctx, { list: () => [r, { ...r, pid: 8 }], io: liveIo });
  assert.match(sent.at(-1), /khớp 2 process/, 'two pids on ONE session too');
  await startTapKill('#c2383556', ctx, { list: () => [r], io: { ...liveIo, proc: () => ({ comm: 'claude', start: '9' }) } });
  assert.match(sent.at(-1), /vừa đổi/, 'identity re-checked before the prompt');
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

test('pick button: a TERMINAL twin sharing the hashtag (never in the menu list) refuses the pick, like a typed /type #h', async () => {
  const { ctx, calls } = ui();
  const twin = { pid: 9, hashtag: 'c2383556', sessionId: 'X', screen: null, ppid: 1, procStart: '1' };
  await handleTypeButton(cq('ty:pick:c2383556', '⌨️ /type — chọn agent:\n• #c2383556 · PID 644406'), ctx, { list: () => [agent(T)], procs: () => [asRow(T), twin] });
  assert.match(calls.at(-1)[1], /2 process/);
  assert.equal(ctx.buttonStore.size, 0);
  assert.ok(!calls.some((c) => c[0] === 'edit' && /rảnh/.test(c[1]) && c[2]?.length), 'no step-2 keyboard was offered');
});

// ── RFC 35: 🗜️→💀 compact then kill ───────────────────────────────────────────

const SCREEN = '644405.tele-c2383556';
const qUsage = { tokens: 140_000 };
/** A live io for a typeable agent; `st` is mutable (status, tokens, windows, procStart, compact result, order log). */
function qIo(over = {}) {
  const st = { status: 'idle', usage: qUsage, windows: 1, start: '5', compact: { preTokens: 140000, postTokens: 20000 }, log: [], audits: [], now: 0, ...over };
  const io = {
    now: () => st.now, sleep: async (ms) => { st.now += ms; },
    session: () => ({ sessionId: 'S', status: st.status, bridgeSessionId: null }),
    proc: () => ({ comm: 'claude', start: st.start }), ppid: () => 644405, windows: () => st.windows,
    transcript: () => ({ ended: true, usage: st.usage }),
    hardcopy: async () => '', compactAfter: (f, o, opt) => { st.log.push(['compactAfter', opt]); return typeof st.compact === 'function' ? st.compact() : st.compact; },
    audit: (e) => st.audits.push(e),
  };
  return { io, st };
}
/** A real TypeRunner whose keystroke part is stubbed (it is covered in type-cmd.test.mjs). */
function qRunner(io, { ok = true } = {}) {
  const runner = new TypeRunner(io);
  runner.typeAndEnter = async () => (ok ? { ok: true, file: '/t.jsonl', offset: { size: 1 }, queued: false } : { text: '❌ agent đang bận — không gõ /compact.' });
  return runner;
}
const tr = (t) => ({ ...t, screenPid: 644405 });
const TQ = tr(T);

test('compactKillVisible: typeable + no mismatch + idle/busy + tokens > 100k; hidden at exactly 100k, unknown usage, terminal agent, waiting, 2 windows', () => {
  const vis = (over, t = TQ) => compactKillVisible(t, qIo(over).io);
  assert.equal(vis({}), true);
  assert.equal(vis({ status: 'busy' }), true);
  assert.equal(vis({ usage: { tokens: 100_001 } }), true);
  assert.equal(vis({ usage: { tokens: 100_000 } }), false);
  assert.equal(vis({ usage: null }), false);
  assert.equal(vis({ usage: {} }), false);
  assert.equal(vis({}, { ...TQ, screen: null, screenPid: null }), false);
  assert.equal(vis({}, { ...TQ, screen: 'tele-other' }), false);
  assert.equal(vis({ status: 'waiting' }), false);
  assert.equal(vis({ windows: 2 }), false);
  assert.equal(vis({ start: '9' }), false, 'process changed');
  assert.equal(compactKillVisible(TQ, { ...qIo().io, windows: () => { throw new Error('x'); } }), false);
});

test('💀 confirm: middle 🗜️→💀 only when visible (fresh observation, not step-2 ops); token ops follow', async () => {
  const text = '⌨️ /type — #c2383556 · PID 644406 · rảnh\nChọn lệnh';
  for (const [over, want] of [[{}, ['✅', '🗜️→💀', '✖']], [{ usage: { tokens: 100_000 } }, ['✅', '✖']]]) {
    const { ctx, calls } = ui();
    ctx.buttonStore.set('a'.repeat(16), { kind: 'type', target: TQ, chatId: 42, messageId: 100, createdAt: Date.now(), ops: ['k', 'x'] });
    await handleTypeButton(cq(`ty:${'a'.repeat(16)}:k`, text), ctx, { runner: {}, io: qIo(over).io });
    const ask = calls.at(-1);
    assert.deepEqual(ask[2][0].map((b) => b.text), want);
    const tok = ask[2][0][0].callback_data.split(':')[1];
    assert.deepEqual(ctx.buttonStore.get(tok).ops, want.length === 3 ? ['y', 'q', 'x'] : ['y', 'x']);
  }
});

test('/kill_<hash> confirm: same helper — 🗜️→💀 for a big typeable agent, plain [✅][✖] for a terminal agent', async () => {
  const r = row({ pid: 644406, hashtag: 'c2383556', sessionId: 'S' });
  const { io } = qIo();
  const { ctx, calls } = ui();
  await startTapKill('#c2383556', ctx, { list: () => [r], io });
  assert.deepEqual(calls.at(-1)[2][0].map((b) => b.text), ['✅', '🗜️→💀', '✖']);
  assert.deepEqual(ctx.buttonStore.get(calls.at(-1)[2][0][0].callback_data.split(':')[1]).ops, ['y', 'q', 'x']);
  await startTapKill('#c2383556', ctx, { list: () => [{ ...r, screen: null, screenPid: null, ppid: 1 }], io });
  assert.deepEqual(calls.at(-1)[2][0].map((b) => b.text), ['✅', '✖']);
});

/** Put a q token in the store and tap it. */
async function tapQ({ runner, io, ops = ['y', 'q', 'x'], kill, target = TQ, store } = {}) {
  const { ctx, calls } = ui();
  if (store) ctx.buttonStore = store;
  const text = '💀 #c2383556 · PID 644406 · rảnh · ctx 140k\n\nKill agent này';
  if (ops !== 'legacy') ctx.buttonStore.set('b'.repeat(16), { kind: 'type', target, chatId: 42, messageId: 100, createdAt: Date.now(), ops });
  else ctx.buttonStore.set('b'.repeat(16), { kind: 'type', target, chatId: 42, messageId: 100, createdAt: Date.now() });
  await handleTypeButton(cq(`ty:${'b'.repeat(16)}:q`, text), ctx, { runner, io, kill, deliver: async () => { throw new Error('no notice for the dying agent'); } });
  return { ctx, calls };
}

test('q → compact OK (with summary) → kill once, AFTER the compact; message keeps the compact line; buttons gone first; no notice', async () => {
  const { io, st } = qIo();
  const runner = qRunner(io);
  const order = [];
  const kill = async (t) => { order.push('kill'); st.log.push(['kill']); assert.ok(runner.reserved.has(t.pid), 'still reserved at the kill'); return '[spawn] ✅ PID 644406 stopped'; };
  const { calls } = await tapQ({ runner, io, kill });
  const edits = calls.filter((c) => c[0] === 'edit');
  assert.match(edits[0][1], /\n\n⏳ đang compact…$/);
  assert.deepEqual(edits[0][2], [], 'no keyboard');
  assert.match(edits[1][1], /\n\n✅ đã compact: 140k → 20k\n⏳ đang kill PID 644406…$/);
  assert.match(edits.at(-1)[1], /\n\n✅ đã compact: 140k → 20k\n\[spawn\] ✅ PID 644406 stopped$/);
  assert.deepEqual(order, ['kill']);
  assert.deepEqual(st.log.map((l) => l[0]), ['compactAfter', 'kill']);
  assert.deepEqual(st.log[0][1], { requireSummary: true });
  assert.equal(runner.reserved.size, 0, 'released');
  assert.equal(runner.compactWatches.size, 0);
  assert.deepEqual(st.audits.filter((a) => a.step !== 'result').map((a) => a.step), ['compact-kill', 'kill']);
  assert.match(st.audits.find((a) => a.step === 'compact-kill').result, /đã compact/);
});

test('q → compact NOT ok (timeout / transcript missing / refused type) → no kill, "— không kill.", fresh [✅][✖]', async () => {
  for (const [name, mk, re] of [
    ['timeout', () => { const f = qIo({ compact: null }); return { ...f, runner: qRunner(f.io) }; }, /chưa thấy compact xong sau 5 phút.* — không kill\.$/],
    ['refused type', () => { const f = qIo(); return { ...f, runner: qRunner(f.io, { ok: false }) }; }, /không gõ \/compact\. — không kill\.$/],
    ['no transcript', () => { const f = qIo(); const runner = qRunner(f.io); runner.typeAndEnter = async () => ({ ok: true, file: null, offset: null }); return { ...f, runner }; }, /không tìm thấy transcript.* — không kill\.$/],
    ['compactAfter error', () => { const f = qIo({ compact: { error: 'transcript bị cắt ngắn / thay' } }); return { ...f, runner: qRunner(f.io) }; }, /không theo dõi được.* — không kill\.$/],
  ]) {
    const { io, runner } = mk();
    const killed = [];
    const { ctx, calls } = await tapQ({ runner, io, kill: async (t) => { killed.push(t.pid); return 'x'; } });
    assert.equal(killed.length, 0, name);
    const last = calls.at(-1);
    assert.match(last[1], re, name);
    assert.deepEqual(last[2][0].map((b) => b.text), ['✅', '✖'], name);
    const fresh = ctx.buttonStore.get(last[2][0][0].callback_data.split(':')[1]);
    assert.deepEqual(fresh.ops, ['y', 'x']);
    assert.equal(fresh.target.pid, 644406);
    assert.equal(runner.reserved.size, 0, `${name}: released`);
  }
});

test('q: the boundary without isCompactSummary keeps waiting (no kill) until the summary shows', async () => {
  let n = 0;
  const { io, st } = qIo({ compact: () => (++n < 3 ? null : { preTokens: 140000, postTokens: 20000 }) });
  const killed = [];
  const { calls } = await tapQ({ runner: qRunner(io), io, kill: async (t) => { killed.push([t.pid, n]); return 'ok'; } });
  assert.deepEqual(killed, [[644406, 3]], 'killed only on the 3rd poll, when compactAfter finally returned');
  assert.ok(st.now >= 3000 + 5000 * 2 + 2000);
  assert.match(calls.at(-1)[1], /✅ đã compact/);
});

test('q: identity changes during the wait → no kill (PID reused / session changed)', async () => {
  for (const change of [(st) => { st.start = '9'; }, (st) => { st.sess = 'OTHER'; }]) {
    const { io, st } = qIo({ compact: () => { change(st); return { preTokens: 140000, postTokens: 20000 }; } });
    if (st.sess === undefined) io.session = () => ({ sessionId: st.sess ?? 'S', status: 'idle' });
    const killed = [];
    const runner = qRunner(io);
    const { calls } = await tapQ({ runner, io, kill: async (t) => { killed.push(t.pid); return 'x'; } });
    assert.equal(killed.length, 0);
    assert.match(calls.at(-1)[1], /✅ đã compact: 140k → 20k\n❌ agent đã đổi .* — không kill/);
    assert.equal(runner.reserved.size, 0);
  }
  // …and before the compact starts: nothing typed, nothing reserved
  const { io } = qIo({ start: '9' });
  const runner = qRunner(io); let typed = 0; runner.typeAndEnter = async () => { typed++; return { text: 'x' }; };
  const { calls } = await tapQ({ runner, io, kill: async () => { throw new Error('no'); } });
  assert.equal(typed, 0);
  assert.match(calls.at(-1)[1], /agent đã đổi.*không kill/);
});

test('q is refused from a token whose ops lack it, and from a legacy token without ops (nothing typed)', async () => {
  for (const ops of [['y', 'x'], 'legacy']) {
    const { io } = qIo();
    const runner = qRunner(io); let typed = 0; runner.typeAndEnter = async () => { typed++; return { text: 'x' }; };
    const { calls } = await tapQ({ runner, io, ops, kill: async () => { throw new Error('no kill'); } });
    assert.equal(typed, 0);
    assert.match(calls.at(-1)[1], /Nút không khớp/);
    assert.equal(runner.reserved.size, 0);
  }
});

test('q refused while a lock / Esc / kill / earlier compact watch is in flight, or when already reserved; nothing typed; others\' state kept', async () => {
  for (const arm of [(r) => r.locks.add(644406), (r) => r.escInFlight.add(644406), (r) => r.killsPending.add(644406), (r) => r.compactWatches.set(644406, 1), (r) => r.reserved.set(644406, { tok: 'other' })]) {
    const { io } = qIo();
    const runner = qRunner(io); let typed = 0; runner.typeAndEnter = async () => { typed++; return { text: 'x' }; };
    arm(runner);
    const before = runner.reserved.get(644406);
    const { calls } = await tapQ({ runner, io, kill: async () => { throw new Error('no kill'); } });
    assert.equal(typed, 0);
    assert.match(calls.at(-1)[1], /(bận lệnh khác|compact→kill).* — không kill\.$/);
    assert.equal(runner.reserved.get(644406), before, 'a refused q does not touch the holder\'s reservation');
  }
});

test('✅ on a reserved pid is refused (no kill); ✅ marks the kill pending while it runs; cleared after', async () => {
  const { io } = qIo();
  const runner = qRunner(io);
  const text = '💀 #c2383556 · PID 644406 · rảnh\n\nKill';
  const killed = [];
  let pendingDuring = null;
  const kill = async (t) => { pendingDuring = runner.killsPending.has(t.pid); killed.push(t.pid); return 'ok'; };
  let c = ui();
  runner.reserved.set(644406, { tok: 'z' });
  c.ctx.buttonStore.set('c'.repeat(16), { kind: 'type', target: TQ, chatId: 42, messageId: 100, createdAt: Date.now(), ops: ['y', 'x'] });
  await handleTypeButton(cq(`ty:${'c'.repeat(16)}:y`, text), c.ctx, { runner, io, kill });
  assert.equal(killed.length, 0);
  assert.match(c.calls.at(-1)[1], /đang compact→kill — không kill/);
  runner.reserved.clear();
  c = ui();
  c.ctx.buttonStore.set('d'.repeat(16), { kind: 'type', target: TQ, chatId: 42, messageId: 100, createdAt: Date.now(), ops: ['y', 'x'] });
  await handleTypeButton(cq(`ty:${'d'.repeat(16)}:y`, text), c.ctx, { runner, io, kill });
  assert.deepEqual(killed, [644406]);
  assert.equal(pendingDuring, true);
  assert.equal(runner.killsPending.size, 0);
});

test('a second ✅ while the first kill is still running is refused (one kill per pid)', async () => {
  const { io } = qIo();
  const runner = qRunner(io);
  const text = '💀 #c2383556 · PID 644406 · rảnh\n\nKill';
  const killed = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const kill = async (t) => { killed.push(t.pid); await gate; return 'ok'; };
  const a = ui(), b = ui();
  a.ctx.buttonStore.set('e'.repeat(16), { kind: 'type', target: TQ, chatId: 42, messageId: 100, createdAt: Date.now(), ops: ['y', 'x'] });
  b.ctx.buttonStore.set('f'.repeat(16), { kind: 'type', target: TQ, chatId: 42, messageId: 100, createdAt: Date.now(), ops: ['y', 'x'] });
  const first = handleTypeButton(cq(`ty:${'e'.repeat(16)}:y`, text), a.ctx, { runner, io, kill });
  await new Promise((r) => setImmediate(r));
  await handleTypeButton(cq(`ty:${'f'.repeat(16)}:y`, text), b.ctx, { runner, io, kill });
  assert.match(b.calls.at(-1)[1], /đang kill bởi lần bấm khác/);
  assert.equal(runner.reserve?.(TQ, 'q1') == null ? 'reserved' : 'refused', 'refused', 'q cannot reserve while a kill is pending');
  release();
  await first;
  assert.deepEqual(killed, [644406]);
  assert.equal(runner.killsPending.size, 0);
});

test('a second q while the first is still waiting is refused (one compact can\'t satisfy two watchers); reservation held through the wait', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { io, st } = qIo();
  io.sleep = async (ms) => { st.now += ms; if (ms === 3000) await gate; };
  const runner = qRunner(io);
  const killed = [];
  const kill = async (t) => { killed.push(t.pid); return 'ok'; };
  const first = tapQ({ runner, io, kill });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(runner.reserved.has(644406), 'held while the compact is awaited');
  const second = await tapQ({ runner, io, kill });
  assert.match(second.calls.at(-1)[1], /compact→kill.* — không kill\.$/);
  assert.match((await runner.run('n', TQ)).text, /compact→kill/);
  release();
  await first;
  assert.deepEqual(killed, [644406], 'killed exactly once');
  assert.equal(runner.reserved.size, 0);
});

test('plain 🗜️ via the button/command releases its compact watch counter (finish) after notice delivery', async () => {
  const { io } = qIo();
  const runner = qRunner(io);
  const { ctx } = ui();
  ctx.buttonStore.set('e'.repeat(16), { kind: 'type', target: { ...TQ, sessionId: 'ae61d4f1-5ecc-46fe-9cea-75b4c9d9b751' }, chatId: 42, messageId: 100, createdAt: Date.now() });
  io.session = () => ({ sessionId: 'ae61d4f1-5ecc-46fe-9cea-75b4c9d9b751', status: 'idle' });
  let during = null;
  await handleTypeButton(cq(`ty:${'e'.repeat(16)}:c`, '⌨️ /type — #c2383556 · PID 644406'), ctx, { runner, io, deliver: async () => { during = runner.compactWatches.get(644406); } });
  assert.equal(during, 1, 'still counted while the notice is delivered');
  assert.equal(runner.compactWatches.size, 0);
});
