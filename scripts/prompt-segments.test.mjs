import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptData, buildCombinedPromptData, mergePromptData, promptSegments, resyncPromptSegments } from './tele-listen.mjs';

// A merged batch used to keep metadata from the LAST message only, so a reply-to
// that belonged to an earlier bubble was dropped ("Reply/quote metadata from
// earlier messages in the batch is intentionally dropped"). The admin's real
// pattern — tap reply on a bot message, then type one more bubble inside the
// 8-12s settle window — therefore lost the reply-to entirely. `messages[]` keeps
// every message whole, so the batch stays addressable per message.

const TOPIC_ROOT = { message_id: 500, forum_topic_created: { name: 'topic' } };
const msg = (id, text, { reply = null, date = 1000 } = {}) => ({
  message_id: id,
  text,
  date,
  chat: { id: -100777, type: 'supergroup' },
  from: { id: 42, first_name: 'Alice' },
  ...(reply ? { reply_to_message: reply } : {}),
});

test('a lone message still gets messages[] — one shape for every reader', () => {
  const d = buildPromptData(msg(10, 'hello'), null, null, null);
  assert.equal(d.messages.length, 1);
  assert.equal(d.messages[0].messageId, 10);
  assert.equal(d.messages[0].text, 'hello');
  assert.equal(d.text, 'hello');                       // top level unchanged
});

test('THE BUG: a reply in an EARLIER bubble survives the batch', () => {
  const parent = { message_id: 9, text: 'bot: here is the plan', from: { id: 777, is_bot: true } };
  const batch = buildCombinedPromptData([
    { msg: msg(11, 'do this one', { reply: parent }) },   // the admin tapped reply here…
    { msg: msg(12, 'and also this') },                    // …then typed one more bubble
  ], null, null, null);
  // Top level keeps "newest wins" — routing/compat unchanged.
  assert.equal(batch.messageId, 12);
  assert.equal(batch.replyToMessageId, null);
  // …but the reply-to is no longer LOST: it lives on its own message.
  assert.equal(batch.messages.length, 2);
  assert.equal(batch.messages[0].messageId, 11);
  assert.equal(batch.messages[0].replyToMessageId, 9);
  assert.equal(batch.messages[0].replyToText, 'bot: here is the plan');
  assert.equal(batch.messages[1].replyToMessageId, null);
});

test('the forum-topic phantom reply stays suppressed per segment', () => {
  const batch = buildCombinedPromptData([
    { msg: msg(13, 'plain message in a topic', { reply: TOPIC_ROOT }) },
  ], null, null, null);
  assert.equal(batch.messages[0].replyToMessageId, null);
});

test('every message keeps its ID through a merge — a reply INSIDE the batch is resolvable', () => {
  const first = buildCombinedPromptData([{ msg: msg(20, 'first') }, { msg: msg(21, 'second') }], null, null, null);
  const later = buildPromptData(msg(22, 'third', { reply: { message_id: 21, text: 'second' } }), null, null, null);
  const merged = mergePromptData(first, later);
  assert.deepEqual(merged.messages.map((m) => m.messageId), [20, 21, 22]);
  // The reply target is a message that lives INSIDE this very batch → resolvable.
  const target = merged.messages.find((m) => m.messageId === merged.messages[2].replyToMessageId);
  assert.equal(target.text, 'second');
  // Rendering + routing unchanged.
  assert.match(merged.text, /first/);
  assert.match(merged.text, /third/);
  assert.equal(merged.messageId, 22);
});

test('promptSegments: a prompt from an OLDER build is synthesized, never dropped', () => {
  const legacy = { text: 'written before messages[] existed', messageId: 5, fromName: 'Alice', replyToMessageId: 4 };
  const segs = promptSegments(legacy);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].messageId, 5);
  assert.equal(segs[0].replyToMessageId, 4);
  // …and it merges with a modern prompt without losing either side.
  const merged = mergePromptData(legacy, buildPromptData(msg(6, 'new'), null, null, null));
  assert.deepEqual(merged.messages.map((m) => m.messageId), [5, 6]);
  assert.equal(promptSegments(null).length, 0);
});

test('kind-flags and steer routing identity stay TOP-LEVEL through a merge', () => {
  const whisper = { text: 'private steer', instruct: true, fromUserId: '144', replyToMessageId: 900, messageId: 900 };
  const plain = buildPromptData(msg(901, 'a later group message'), null, null, null);
  const merged = mergePromptData(whisper, plain);
  assert.equal(merged.instruct, true);            // fail-closed batch property survives
  assert.equal(merged.fromUserId, '144');         // steer's DM target restored
  assert.equal(merged.messages.length, 2);        // and both messages are still whole
});

test('segments SHARE the attachment objects with the top level (download hydration is in-place)', () => {
  const withPhoto = { ...msg(30, 'look'), photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 90, height: 90, file_size: 100 }] };
  const d = buildCombinedPromptData([{ msg: withPhoto, update: { update_id: 7 } }], 999, null, null);
  assert.equal(d.attachments.length, 1);
  assert.equal(d.messages[0].attachments.length, 1);
  // downloadAttachments mutates the top-level array in place; a segment holding a
  // COPY would forever report localPath: null and the agent would drop the media.
  assert.equal(d.messages[0].attachments[0], d.attachments[0], 'must be the same object, not a copy');
  d.attachments[0].localPath = '/tmp/photo.jpg';
  assert.equal(d.messages[0].attachments[0].localPath, '/tmp/photo.jpg');
});

test('resyncPromptSegments: a synthetic prompt\'s segment cannot contradict its neutered identity', () => {
  const synthetic = buildCombinedPromptData([{ msg: { message_id: null, chat: { id: -100777 }, from: null, text: 'ask', date: 1 } }], null, null, null);
  assert.equal(synthetic.messages[0].fromUserId, '-100777');   // pre-override: the chat id leaks in
  synthetic.messageId = null; synthetic.fromUserId = null; synthetic.fromRole = 'agent-ask'; synthetic.attachments = [];
  resyncPromptSegments(synthetic);
  assert.equal(synthetic.messages[0].fromUserId, null);        // …and is scrubbed to match the top level
  assert.equal(synthetic.messages[0].fromRole, 'agent-ask');
  assert.equal(synthetic.messages[0].messageId, null);
});

test('the announce is ALWAYS one line — a multi-line message must not strand the claim token', async () => {
  const { announceBody, claimSuffix } = await import('./tele-listen.mjs');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'announce-'));
  const f = path.join(d, 'p.json');
  fs.writeFileSync(f, JSON.stringify({ text: 'line 1\nline 2 with "quotes"\nline 3', messageId: 77 }));
  const line = `[tele-listen] prompt ready: ${f} (claimed by listener) ${announceBody(f)}${claimSuffix('abc123')}`;
  assert.equal(line.split('\n').length, 1, 'Monitor turns each stdout line into its own event');
  assert.match(line, /\[claim: abc123\]$/);      // the token stays on the announce line
  assert.match(line, /line 2 with/);             // …and the full text is still delivered
  fs.rmSync(d, { recursive: true, force: true });
});
