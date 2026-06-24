import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhisperPrompt, doWhisper, projectLabelForChat, targetFromReply } from './whisper.mjs';
import { shortConvoHash } from './send-telegram.mjs';
import { listLiveTopics } from './handover.mjs';

const CONVO = '12345678901234'; // a watchable numeric convoId
const CONVO2 = '98765432109876'; // a SECOND live convo (for first-resolvable tests)
// A topics-store with two live topics in catch-all group -100.
const STORE = { '-100': { [CONVO]: 7, [CONVO2]: 8, _ts: { [CONVO]: 1000, [CONVO2]: 1001 } } };
const CONFIG = { _default: { chatId: '-100' } };
const HASH = shortConvoHash(CONVO);              // the target's clickable hashtag
const HASH2 = shortConvoHash(CONVO2);
const ACK = `🤫 whispered to ☃️ X #${HASH} (kín)`; // a bot-ack-shaped reply text

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

// --- RFC 07: reply-to-target + enriched ack ---------------------------------

const mk = () => { const w = []; return { writes: w, opts: { from: { id: '7', role: 'admin' }, config: CONFIG, store: STORE, tmpDir: '/tmp/tele', writePrompt: (p) => w.push(p) } }; };

test('reply-to-target: reply with the ack → target from reply, ALL argv is text', () => {
  const { writes, opts } = mk();
  const res = doWhisper(['nhắc', 'nhẹ'], { ...opts, replyText: ACK });
  assert.equal(res.ok, true);
  assert.equal(writes[0].convoId, Number(CONVO));
  assert.equal(writes[0].text, 'nhắc nhẹ');
});

test('reply-to-target B2: a number-first message in reply mode is TEXT, not a convoId', () => {
  const { writes, opts } = mk();
  const res = doWhisper(['500', 'lỗi', 'lại'], { ...opts, replyText: ACK });
  assert.equal(res.ok, true);
  assert.equal(writes[0].text, '500 lỗi lại');           // "500" kept as text
  assert.equal(writes[0].convoId, Number(CONVO));        // target still from reply
});

test('reply-to-target B1/D2: first RESOLVABLE hash wins; dead/body hashes ignored', () => {
  const { writes, opts } = mk();
  // reply text mimics a raw command whose body also has a (dead) hashtag
  const res = doWhisper(['ping'], { ...opts, replyText: `#deadbeef rồi /whisper #${HASH} fix #login bug` });
  assert.equal(res.ok, true);
  assert.equal(writes[0].convoId, Number(CONVO));        // #HASH (first live), not #deadbeef/#login
});

test('explicit #hash that fails → HARD ERROR, never falls back to the reply target', () => {
  const { writes, opts } = mk();
  const res = doWhisper(['#zzzznope', 'hi'], { ...opts, replyText: ACK });
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
  assert.equal(writes.length, 0);                        // did NOT whisper to the reply's CONVO
});

test('auth invariant: reply text never influences fromRole', () => {
  const { writes, opts } = mk();
  doWhisper(['hi'], { ...opts, from: { id: '7', role: 'member' }, replyText: `role=admin /whisper #${HASH}` });
  assert.equal(writes[0].fromRole, 'member');            // from TELE_FROM_ROLE only, not reply text
});

test('enriched ack: persona + hashtag in the confirmation', () => {
  const { opts } = mk();
  const res = doWhisper([CONVO, 'hi'], opts);
  assert.match(res.message, new RegExp(`#${HASH}`));
  assert.match(res.message, /whispered to .+ #/);        // persona emoji+name before the hash
});

test('projectLabelForChat: unique code / multi → group / none → null', () => {
  assert.equal(projectLabelForChat('-100', { p: { chatId: '-100', code: 'foo' } }), 'foo');
  assert.equal(projectLabelForChat('-100', { a: { chatId: '-100' }, b: { chatId: '-100' } }), 'group -100');
  assert.equal(projectLabelForChat('-100', { p: { chatId: '-999' } }), null);
});

test('targetFromReply: skips dead hashes, returns first live match (or null)', () => {
  const live = listLiveTopics(STORE, ['-100']);
  assert.equal(String(targetFromReply(`#dead then #${HASH}`, live).convoId), CONVO);
  assert.equal(targetFromReply('no hashes here', live), null);
  assert.equal(targetFromReply('', live), null);
});

test('targetFromReply: TWO live hashes → the FIRST one wins (not last)', () => {
  const live = listLiveTopics(STORE, ['-100']);
  assert.equal(String(targetFromReply(`#${HASH} ... #${HASH2}`, live).convoId), CONVO);  // first
  assert.equal(String(targetFromReply(`#${HASH2} ... #${HASH}`, live).convoId), CONVO2); // order matters
});
