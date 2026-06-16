import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFromName, buildPromptData, buildCombinedPromptData } from './tele-listen.mjs';

test('formatFromName: full name from first + last', () => {
  assert.equal(formatFromName({ first_name: 'Thi', last_name: 'Truong' }), 'Thi Truong');
});

test('formatFromName: first name only', () => {
  assert.equal(formatFromName({ first_name: 'Thi' }), 'Thi');
});

test('formatFromName: falls back to @username', () => {
  assert.equal(formatFromName({ username: 'thith' }), '@thith');
});

test('formatFromName: null when no identity', () => {
  assert.equal(formatFromName({}), null);
  assert.equal(formatFromName(null), null);
});

test('buildPromptData includes fromName', () => {
  const msg = { message_id: 1, chat: { id: -100 }, from: { id: 7, first_name: 'Thi' }, text: 'hi' };
  const out = buildPromptData(msg);
  assert.equal(out.fromName, 'Thi');
  assert.equal(out.fromUserId, '7');
});

test('buildCombinedPromptData uses last sender for fromName', () => {
  const mk = (id, name) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id: id, first_name: name }, text: `m${id}` } });
  const out = buildCombinedPromptData([mk(1, 'Thi'), mk(2, 'Nam')]);
  assert.equal(out.fromName, 'Nam');
  assert.match(out.text, /Admin follow-up:/);
});

// Forum phantom-reply: Telegram sets reply_to_message → the topic-creation
// service message for EVERY message in a topic. That is NOT a real reply, so it
// must not surface as bogus reply context to the agent.
test('buildPromptData: forum phantom reply_to is suppressed', () => {
  const msg = {
    message_id: 95, chat: { id: -100 }, from: { id: 7, first_name: 'Thi' }, text: 'hi',
    reply_to_message: { message_id: 93, forum_topic_created: { name: '🐍 Rắn' } },
  };
  const out = buildPromptData(msg);
  assert.equal(out.replyToMessageId, null);
  assert.equal(out.replyToText, null);
});

test('buildPromptData: a genuine reply is preserved as context', () => {
  const msg = {
    message_id: 96, chat: { id: -100 }, from: { id: 7, first_name: 'Thi' }, text: 'theo ý đó',
    reply_to_message: { message_id: 50, text: 'đề xuất A' },
  };
  const out = buildPromptData(msg);
  assert.equal(out.replyToMessageId, 50);
  assert.equal(out.replyToText, 'đề xuất A');
});

test('buildCombinedPromptData: phantom suppressed, real reply kept (from last msg)', () => {
  const phantom = { message_id: 93, forum_topic_created: { name: 'x' } };
  const mk = (id, replyTo) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: 'Thi' }, text: `m${id}`, reply_to_message: replyTo } });

  const allPhantom = buildCombinedPromptData([mk(1, phantom), mk(2, phantom)]);
  assert.equal(allPhantom.replyToMessageId, null);
  assert.equal(allPhantom.replyToText, null);

  const lastReal = buildCombinedPromptData([mk(1, phantom), mk(2, { message_id: 50, text: 'gốc' })]);
  assert.equal(lastReal.replyToMessageId, 50);
  assert.equal(lastReal.replyToText, 'gốc');
});
