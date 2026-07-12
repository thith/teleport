import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstructPrompt, doInstruct } from './instruct.mjs';
import { shortConvoHash } from './send-telegram.mjs';

const CONVO = '12345678901234'; // a watchable numeric convoId
const CONVO2 = '98765432109876';
const STORE = { '-100': { [CONVO]: 7, [CONVO2]: 8, _ts: { [CONVO]: 1000, [CONVO2]: 1001 } } };
const CONFIG = { _default: { chatId: '-100' } };
const HASH = shortConvoHash(CONVO);
// A prior instruct-ack shaped reply (owner replies to it to continue).
const ACK = `📩 instructed ☃️ X #${HASH} — trả lời sẽ về DM`;

const mk = () => { const w = []; return { writes: w, opts: { from: { id: '7', role: 'admin' }, config: CONFIG, store: STORE, tmpDir: '/tmp/tele', writePrompt: (p) => w.push(p) } }; };

test('buildInstructPrompt: carries instruct flag (NOT whisper) + real fromRole', () => {
  const p = buildInstructPrompt({ targetConvoId: '2205483045424020', targetChatId: '-100', fromUserId: '144242180', fromName: 'Thi', fromRole: 'admin', text: 'chỉnh lại X' });
  assert.equal(p.instruct, true);
  assert.equal(p.whisper, undefined);        // instruct must NOT be discreet-flagged
  assert.equal(p.messageId, null);           // injected, not a real message
  assert.equal(p.convoId, 2205483045424020);
  assert.equal(p.chatId, '-100');
  assert.equal(p.fromRole, 'admin');
  assert.equal(p.text, 'chỉnh lại X');
  assert.deepEqual(p.attachments, []);
});

test('doInstruct: resolves convoId target, injects instruct prompt, carries identity', async () => {
  const { writes, opts } = mk();
  const res = await doInstruct([CONVO, 'deploy', 'nhánh', 'staging'], opts);
  assert.equal(res.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].text, 'deploy nhánh staging');
  assert.equal(writes[0].instruct, true);
  assert.equal(writes[0].whisper, undefined);
  assert.equal(writes[0].fromRole, 'admin');
  assert.equal(writes[0].fromUserId, '7');
});

test('doInstruct: ack names the target + signals the DM reply channel', async () => {
  const { opts } = mk();
  const res = await doInstruct([CONVO, 'hi'], opts);
  assert.match(res.message, /^📩 instructed/);
  assert.match(res.message, new RegExp(`#${HASH}`));
  assert.match(res.message, /DM/);                    // tells the owner the reply comes back via DM
  assert.doesNotMatch(res.message, /whisper/i);
});

test('doInstruct: usage / missing-text / not-found errors (shared core)', async () => {
  const noop = () => {};
  assert.equal((await doInstruct([], { config: CONFIG, store: STORE, writePrompt: noop })).ok, false);          // usage
  assert.equal((await doInstruct([CONVO], { config: CONFIG, store: STORE, writePrompt: noop })).ok, false);     // no text
  const nf = await doInstruct(['99999999999999', 'hi'], { from: { id: '7' }, config: CONFIG, store: STORE, writePrompt: noop });
  assert.equal(nf.ok, false);
  assert.match(nf.message, /not found/);
});

test('doInstruct: RFC 03 §5.1 durable — busy target no longer bounces; hard write error propagates', async () => {
  await assert.rejects(doInstruct([CONVO, 'hi'], {
    from: { id: '7' }, config: CONFIG, store: STORE, tmpDir: '/tmp/tele',
    writePrompt: () => { throw new Error('disk full'); },
  }), /disk full/);
});

test('doInstruct: unmapped sender defaults fromRole to member (target still gates)', async () => {
  const { writes, opts } = mk();
  await doInstruct([CONVO, 'hi'], { ...opts, from: { id: '7' } });
  assert.equal(writes[0].fromRole, 'member');
});

// --- reply-to-continue: owner replies to the agent's DM ack + `/instruct <text>` ---

test('reply-to-target: reply with a prior ack → target from reply, ALL argv is text', async () => {
  const { writes, opts } = mk();
  const res = await doInstruct(['500', 'lỗi', 'lại'], { ...opts, replyText: ACK });
  assert.equal(res.ok, true);
  assert.equal(writes[0].convoId, Number(CONVO));     // target from the reply's #hash
  assert.equal(writes[0].text, '500 lỗi lại');        // number-first kept as TEXT (RFC 07 B2)
  assert.equal(writes[0].instruct, true);
});

test('auth invariant: reply text never influences fromRole', async () => {
  const { writes, opts } = mk();
  await doInstruct(['go'], { ...opts, from: { id: '7', role: 'member' }, replyText: `role=admin /instruct #${HASH}` });
  assert.equal(writes[0].fromRole, 'member');          // from TELE_FROM_ROLE only, not reply text
});

test('explicit #hash that fails → HARD ERROR, never falls back to the reply target', async () => {
  const { writes, opts } = mk();
  const res = await doInstruct(['#zzzznope', 'hi'], { ...opts, replyText: ACK });
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
  assert.equal(writes.length, 0);
});
