import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAdminMessages } from './tele-listen.mjs';

const ADMINS = ['-1001234'];

function upd(id, { thread = null, text = 'hi', replyTo = null } = {}) {
  const message = { message_id: id, chat: { id: -1001234 }, from: { id: 7, first_name: 'Thi' }, text };
  if (thread != null) message.message_thread_id = thread;
  if (replyTo != null) message.reply_to_message = { message_id: replyTo };
  return { update_id: id, message };
}

test('team threadId: accepts plain message in the owned topic (no reply needed)', () => {
  const out = filterAdminMessages([upd(1, { thread: 55 })], ADMINS, null, 'convo', 55);
  assert.equal(out.length, 1);
  assert.equal(out[0].msg.message_id, 1);
});

test('team threadId: ignores General (no thread_id)', () => {
  const out = filterAdminMessages([upd(2, { thread: null })], ADMINS, null, 'convo', 55);
  assert.equal(out.length, 0);
});

test('team threadId: ignores foreign topic', () => {
  const out = filterAdminMessages([upd(3, { thread: 99 })], ADMINS, null, 'convo', 55);
  assert.equal(out.length, 0);
});

test('team threadId: a reply inside the owned topic also matches', () => {
  const out = filterAdminMessages([upd(4, { thread: 55, replyTo: 10 })], ADMINS, null, 'convo', 55);
  assert.equal(out.length, 1);
});

test('team threadId: foreign-chat message excluded even if thread matches', () => {
  const u = upd(5, { thread: 55 });
  u.message.chat.id = -999;
  const out = filterAdminMessages([u], ADMINS, null, 'convo', 55);
  assert.equal(out.length, 0);
});

test('no threadId: legacy reply-to matching unchanged', () => {
  const updates = [upd(6, { thread: 55, replyTo: 10 }), upd(7, { thread: 55, replyTo: 999 })];
  // Only the message replying to 10 passes; thread is ignored when threadId null.
  const out = filterAdminMessages(updates, ADMINS, new Set([10]), 'legacy');
  assert.equal(out.length, 1);
  assert.equal(out[0].msg.message_id, 6);
});
