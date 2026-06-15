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
