import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhisperPrompt, doWhisper } from './whisper.mjs';

const CONVO = '12345678901234'; // a watchable numeric convoId
// A topics-store with one live topic in catch-all group -100.
const STORE = { '-100': { [CONVO]: 7, _ts: { [CONVO]: 1000 } } };
const CONFIG = { _default: { chatId: '-100' } };

test('buildWhisperPrompt: injected shape with whisper flag + real fromRole', () => {
  const p = buildWhisperPrompt({ targetConvoId: '2205483045424020', targetChatId: '-100', fromUserId: '144242180', fromName: 'Thi', fromRole: 'admin', text: 'hãy confirm' });
  assert.equal(p.whisper, true);
  assert.equal(p.messageId, null);       // injected, not a real message
  assert.equal(p.convoId, 2205483045424020);
  assert.equal(p.chatId, '-100');
  assert.equal(p.fromRole, 'admin');
  assert.equal(p.fromUserId, '144242180');
  assert.equal(p.text, 'hãy confirm');
  assert.deepEqual(p.attachments, []);
});

test('doWhisper: resolves convoId target, writes prompt, carries identity', () => {
  const writes = [];
  const res = doWhisper([CONVO, 'nhắc', 'nhẹ', 'nhé'], {
    from: { id: '7', role: 'admin', name: 'Thi' }, config: CONFIG, store: STORE,
    tmpDir: '/tmp/tele', writePrompt: (prompt, file) => writes.push({ prompt, file }),
  });
  assert.equal(res.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, '/tmp/tele/prompt-convo-' + CONVO + '.json');
  assert.equal(writes[0].prompt.text, 'nhắc nhẹ nhé');
  assert.equal(writes[0].prompt.whisper, true);
  assert.equal(writes[0].prompt.fromRole, 'admin');
  assert.equal(writes[0].prompt.fromUserId, '7');
});

test('doWhisper: usage errors on missing target / missing text', () => {
  const noop = () => {};
  assert.equal(doWhisper([], { config: CONFIG, store: STORE, writePrompt: noop }).ok, false);
  assert.equal(doWhisper([CONVO], { config: CONFIG, store: STORE, writePrompt: noop }).ok, false); // no message
});

test('doWhisper: target not among live topics → not found', () => {
  const res = doWhisper(['99999999999999', 'hi'], { from: { id: '7' }, config: CONFIG, store: STORE, writePrompt: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
});

test('doWhisper: EEXIST (prompt still pending) → "đang bận", not a throw', () => {
  const res = doWhisper([CONVO, 'hi'], {
    from: { id: '7' }, config: CONFIG, store: STORE, tmpDir: '/tmp/tele',
    writePrompt: () => { const e = new Error('exists'); e.code = 'EEXIST'; throw e; },
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /đang bận/);
});

test('doWhisper: unmapped sender defaults fromRole to member (target still gates)', () => {
  const writes = [];
  doWhisper([CONVO, 'hi'], {
    from: { id: '7' }, config: CONFIG, store: STORE, tmpDir: '/tmp/tele',
    writePrompt: (prompt) => writes.push(prompt),
  });
  assert.equal(writes[0].fromRole, 'member');
});
