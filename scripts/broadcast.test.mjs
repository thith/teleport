import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBroadcastArgs, parseBroadcastRaw, buildBroadcastPrompt, groupChatIds, doBroadcast } from './broadcast.mjs';

test('parseBroadcastArgs: text join; --chat (space/=) extracted; empty → usage error', () => {
  assert.deepEqual(parseBroadcastArgs(['reload', 'guide', 'now']), { chat: null, text: 'reload guide now', error: null });
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
  const ids = groupChatIds(cfg, { env: {}, envFile: {} });
  assert.deepEqual(new Set(ids), new Set(['-100', '-200']));   // deduped; empty skipped
});

// Fan-out: two live topics. RFC 03: a busy topic COALESCES (no skip); only a hard
// write failure is counted (as `failed`, still surfaced via the `skipped` field).
const STORE = { '-100': { '111': 5, '222': 6, _ts: {} } };
const CFG = { _default: { chatId: '-100' }, _config: {} };

test('doBroadcast: durable fan-out — a hard write failure on one topic is counted, others still sent', async () => {
  const written = [];
  const writePrompt = async (obj, file) => {
    if (file.includes('222')) throw new Error('disk full'); // 222 fails hard (NOT busy — busy coalesces)
    written.push(file);
  };
  const r = await doBroadcast(['reload', 'guide'], { from: { id: '144', role: 'admin', name: 'Alice' }, config: CFG, store: STORE, writePrompt, env: {}, envFile: {} });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(r.skipped, 1);   // 1 hard failure
  assert.equal(r.total, 2);
  assert.ok(written[0].includes('prompt-convo-111.json'));
  assert.match(r.message, /sent 1, failed 1/);
});

test('doBroadcast: --chat limits scope; no live topics → ok:false', async () => {
  const r = await doBroadcast(['--chat', '-999', 'hi'], { from: {}, config: CFG, store: STORE, writePrompt: () => {}, env: {}, envFile: {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /no live topics/);
});

test('doBroadcast: empty text → usage error', async () => {
  const r = await doBroadcast([], { config: CFG, store: STORE, writePrompt: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /usage/);
});

test('parseBroadcastRaw: a LEADING --chat (space or =) is split off; the message is verbatim', () => {
  assert.deepEqual(parseBroadcastRaw(`reload "guide"\nit's new`), { chat: null, text: `reload "guide"\nit's new`, error: null });
  assert.deepEqual(parseBroadcastRaw('--chat -100 hi\nthere'), { chat: '-100', text: 'hi\nthere', error: null });
  assert.deepEqual(parseBroadcastRaw('--chat=-100   hi'), { chat: '-100', text: 'hi', error: null });
  assert.match(parseBroadcastRaw('hi --chat -100').error, /--chat phải đứng đầu/, 'a later --chat is refused, never a broadcast to every group');
  assert.match(parseBroadcastRaw('--chat -100 a --chat=-200').error, /đứng đầu/);
  assert.ok(parseBroadcastRaw('--chat -100').error);
  assert.ok(parseBroadcastRaw('--chat').error);
  assert.ok(parseBroadcastRaw('--chat=').error);
  assert.ok(parseBroadcastRaw('   ').error);
});

test('doBroadcast: raw (TELE_RAW_ARGS) wins over argv; --chat still scopes it', async () => {
  const writes = [];
  const r = await doBroadcast(['x'], { from: {}, config: CFG, store: STORE, writePrompt: (p) => writes.push(p), env: {}, envFile: {}, raw: `line 1\n"line 2"` });
  assert.equal(r.ok, true);
  assert.ok(writes.length > 0 && writes.every((p) => p.text === `line 1\n"line 2"`));
  const none = await doBroadcast([], { from: {}, config: CFG, store: STORE, writePrompt: () => {}, env: {}, envFile: {}, raw: '--chat -999 hi' });
  assert.match(none.message, /no live topics/);
});
