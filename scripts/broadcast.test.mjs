import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortConvoHash } from './convo-hash.mjs';
import { parseBroadcastArgs, parseBroadcastRaw, buildBroadcastPrompt, groupChatIds, doBroadcast } from './broadcast.mjs';

test('parseBroadcastArgs: text join; --chat (space/=) extracted; empty → usage error', () => {
  assert.deepEqual(parseBroadcastArgs(['reload', 'guide', 'now']), { chat: null, now: false, projects: null, text: 'reload guide now', error: null });
  let r = parseBroadcastArgs(['--chat', '-100', 'hi', 'there']);
  assert.equal(r.chat, '-100'); assert.equal(r.text, 'hi there');
  r = parseBroadcastArgs(['--chat=-101', 'msg']);
  assert.equal(r.chat, '-101'); assert.equal(r.text, 'msg');
  assert.match(parseBroadcastArgs(['--chat', '-100']).error, /usage/);
});

test('buildBroadcastPrompt: broadcast field, non-privileged role, injected (messageId null)', () => {
  const p = buildBroadcastPrompt({ targetConvoId: '111', targetChatId: '-100', fromUserId: '144', fromName: 'Alice', fromRole: 'admin', text: 'reload guide' });
  assert.equal(p.messageId, null);
  assert.equal(p.fromRole, 'admin');           // sender's real role carried for the receiver's gate
  assert.equal(p.fromMember, null);
  assert.equal(p.convoId, 111);
  assert.deepEqual(p.broadcast, { from: { role: 'admin' }, text: 'reload guide' });
  assert.equal(p.text, 'reload guide');
});

test('groupChatIds: distinct group ids from _default + dedicated projects', () => {
  const cfg = { _default: { chatId: '-100' }, a: { chatId: '-200' }, b: { chatId: '-200' }, c: { chatId: '' }, _config: {} };
  const ids = groupChatIds(cfg, { env: {}, envFile: {}, lsHashtags: ALL_LS });
  assert.deepEqual(new Set(ids), new Set(['-100', '-200']));   // deduped; empty skipped
});

// Fan-out: two live topics. RFC 03: a busy topic COALESCES (no skip); only a hard
// write failure is counted (as `failed`, still surfaced via the `skipped` field).
const STORE = { '-100': { '111': 5, '222': 6, _ts: {} } };
const CFG = { _default: { chatId: '-100' }, _config: {} };
const ALL_LS = () => new Set(['111', '222'].map((c) => shortConvoHash(Number(c))));   // both topics running in /ls

test('doBroadcast: durable fan-out — a hard write failure on one topic is counted, others still sent', async () => {
  const written = [];
  const writePrompt = async (obj, file) => {
    if (file.includes('222')) throw new Error('disk full'); // 222 fails hard (NOT busy — busy coalesces)
    written.push(file);
  };
  const r = await doBroadcast(['reload', 'guide'], { from: { id: '144', role: 'admin', name: 'Alice' }, config: CFG, store: STORE, writePrompt, env: {}, envFile: {}, lsHashtags: ALL_LS });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(r.skipped, 1);   // 1 hard failure
  assert.equal(r.total, 2);
  assert.ok(written[0].includes('prompt-convo-111.json'));
  assert.match(r.message, /^📢 broadcast — 2 session\n\n✅ Đã gửi\n.*#t111\n\n❌ Lỗi\n.*#t222 — không ghi được hàng đợi$/);
  assert.doesNotMatch(r.message, /bỏ qua/);
});

test('doBroadcast: --chat limits scope; no live topics → ok:false', async () => {
  const r = await doBroadcast(['--chat', '-999', 'hi'], { from: {}, config: CFG, store: STORE, writePrompt: () => {}, env: {}, envFile: {}, lsHashtags: ALL_LS });
  assert.equal(r.ok, false);
  assert.match(r.message, /no live topics/);
});

test('doBroadcast: empty text → usage error', async () => {
  const r = await doBroadcast([], { config: CFG, store: STORE, writePrompt: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /usage/);
});

test('parseBroadcastRaw: a LEADING --chat (space or =) is split off; the message is verbatim', () => {
  assert.deepEqual(parseBroadcastRaw(`reload "guide"\nit's new`), { chat: null, now: false, projects: null, text: `reload "guide"\nit's new`, error: null });
  assert.deepEqual(parseBroadcastRaw('--chat -100 hi\nthere'), { chat: '-100', now: false, projects: null, text: 'hi\nthere', error: null });
  assert.deepEqual(parseBroadcastRaw('--chat=-100   hi'), { chat: '-100', now: false, projects: null, text: 'hi', error: null });
  assert.match(parseBroadcastRaw('hi --chat -100').error, /--chat phải đứng đầu/, 'a later --chat is refused, never a broadcast to every group');
  assert.match(parseBroadcastRaw('--chat -100 a --chat=-200').error, /đứng đầu/);
  assert.match(parseBroadcastRaw('"--chat" -100 hi').error, /đứng đầu/, 'a quoted --chat never widens to every group');
  assert.match(parseBroadcastRaw('“--chat=-100” hi').error, /đứng đầu/);
  assert.ok(parseBroadcastRaw('--chat -100').error);
  assert.ok(parseBroadcastRaw('--chat').error);
  assert.ok(parseBroadcastRaw('--chat=').error);
  assert.ok(parseBroadcastRaw('   ').error);
});

test('doBroadcast: raw (TELE_RAW_ARGS) wins over argv; --chat still scopes it', async () => {
  const writes = [];
  const r = await doBroadcast(['x'], { from: {}, config: CFG, store: STORE, writePrompt: (p) => writes.push(p), env: {}, envFile: {}, lsHashtags: ALL_LS, raw: `line 1\n"line 2"` });
  assert.equal(r.ok, true);
  assert.ok(writes.length > 0 && writes.every((p) => p.text === `line 1\n"line 2"`));
  const none = await doBroadcast(['--chat', '-999', 'hi'], { from: {}, config: CFG, store: STORE, writePrompt: () => {}, env: {}, envFile: {}, lsHashtags: ALL_LS, raw: '--chat -999 hi' });
  assert.match(none.message, /no live topics/);
});

test('doBroadcast raw: a disguised --chat (quotes inside the flag) is refused — the scope must match argv', async () => {
  const run = (raw, argv) => doBroadcast(argv, { from: {}, config: CFG, store: STORE, writePrompt: () => { throw new Error('must not send'); }, env: {}, envFile: {}, raw });
  for (const [raw, argv] of [[`--"chat" -100 hi`, ['--chat', '-100', 'hi']], [`--ch'at'=-100 hi`, ['--chat=-100', 'hi']]]) {
    const r = await run(raw, argv);
    assert.equal(r.ok, false, raw);
    assert.match(r.message, /đứng đầu/);
  }
});

test('doBroadcast: topics not in the /ls set are not sent', async () => {
  const written = [];
  const only111 = () => new Set([shortConvoHash(111).toUpperCase()]);   // case-insensitive
  const r = await doBroadcast(['hi'], { from: {}, config: CFG, store: STORE, writePrompt: async (o, f) => { written.push(f); }, env: {}, envFile: {}, lsHashtags: only111, personaOf: () => null });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1); assert.equal(r.total, 1);
  assert.equal(written.length, 1); assert.ok(written[0].includes('prompt-convo-111.json'));
  assert.equal(r.message, '📢 broadcast — 1 session\n\n✅ Đã gửi\n#t111');
});

test('doBroadcast: /ls order, persona names (best-effort), no skipped count', async () => {
  const personaOf = (h) => { if (h === shortConvoHash(222)) throw new Error('boom'); return '🪼 Sứa'; };
  const rows = () => [shortConvoHash(222), { convoId: '111', hashtag: shortConvoHash(111) }];   // /ls lists 222 first
  const r = await doBroadcast(['hi'], { from: {}, config: CFG, store: STORE, writePrompt: async () => {}, env: {}, envFile: {}, lsHashtags: rows, personaOf });
  assert.equal(r.message, `📢 broadcast — 2 session\n\n✅ Đã gửi\n#${shortConvoHash(222)}\n🪼 Sứa #${shortConvoHash(111)}`);
});

test('doBroadcast: empty /ls set → ok:false, nothing written, skipped count in message', async () => {
  const r = await doBroadcast(['hi'], { from: {}, config: CFG, store: STORE, writePrompt: () => { throw new Error('must not send'); }, env: {}, envFile: {}, lsHashtags: () => new Set() });
  assert.equal(r.ok, false);
  assert.equal(r.message, '📢 broadcast — không có session nào đang chạy (/ls trống), không gửi gì.');
});

test('doBroadcast: /ls listing throws → fail closed (ok:false, nothing written)', async () => {
  const r = await doBroadcast(['hi'], { from: {}, config: CFG, store: STORE, writePrompt: () => { throw new Error('must not send'); }, env: {}, envFile: {}, lsHashtags: () => { throw new Error('ps failed'); } });
  assert.equal(r.ok, false);
  assert.match(r.message, /ps failed/);
  assert.match(r.message, /nothing sent/);
});

test('doBroadcast: hashtag collision — a convoId row matches only its own topic; a hashtag-only row is skipped when ambiguous', async () => {
  const A = 1205483045424020, B = 2205483045424020;
  assert.equal(shortConvoHash(A), shortConvoHash(B));
  const store = { '-100': { [A]: 5, [B]: 6, _ts: {} } };
  const run = async (lsHashtags) => {
    const written = [];
    const r = await doBroadcast(['hi'], { from: {}, config: CFG, store, writePrompt: async (o, f) => { written.push(f); }, env: {}, envFile: {}, lsHashtags });
    return { r, written };
  };
  const byConvo = await run(() => [{ convoId: String(A), hashtag: shortConvoHash(A) }]);
  assert.equal(byConvo.written.length, 1); assert.ok(byConvo.written[0].includes(`convo-${A}.json`));
  const byTag = await run(() => [{ convoId: null, hashtag: shortConvoHash(A) }]);   // empty screen: ambiguous
  assert.equal(byTag.r.ok, false); assert.equal(byTag.written.length, 0);
  assert.match(byTag.r.message, /\/ls trống/);
});

test('doBroadcast --chat: a hashtag-only row is ambiguous if another chat holds a topic with the same hashtag', async () => {
  const A = 1205483045424020, B = 2205483045424020;
  const store = { '-100': { [A]: 5, _ts: {} }, '-200': { [B]: 6, _ts: {} } };
  const cfg = { _default: { chatId: '-100' }, p: { chatId: '-200' }, _config: {} };
  const run = (argv) => doBroadcast(argv, { from: {}, config: cfg, store, writePrompt: () => { throw new Error('must not send'); }, env: {}, envFile: {}, lsHashtags: () => [{ convoId: null, hashtag: shortConvoHash(A) }] });
  const r = await run(['--chat', '-100', 'hi']);
  assert.equal(r.ok, false);
  assert.match(r.message, /\/ls trống/);
});
