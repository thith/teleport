import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAdminMessages } from './tele-listen.mjs';

const ADMINS = ['-1001234'];
const TMAP = new Map([['-1001234', 55]]);

function upd(id, { thread = null, text = 'hi', replyTo = null, chatId = -1001234 } = {}) {
  const message = { message_id: id, chat: { id: chatId }, from: { id: 7, first_name: 'Thi' }, text };
  if (thread != null) message.message_thread_id = thread;
  if (replyTo != null) message.reply_to_message = { message_id: replyTo };
  return { update_id: id, message };
}

test('team thread map: accepts plain message in the owned topic (no reply needed)', () => {
  const out = filterAdminMessages([upd(1, { thread: 55 })], ADMINS, null, 'convo', TMAP);
  assert.equal(out.length, 1);
  assert.equal(out[0].msg.message_id, 1);
});

test('team thread map: ignores General (no thread_id)', () => {
  const out = filterAdminMessages([upd(2, { thread: null })], ADMINS, null, 'convo', TMAP);
  assert.equal(out.length, 0);
});

test('team thread map: ignores foreign topic', () => {
  const out = filterAdminMessages([upd(3, { thread: 99 })], ADMINS, null, 'convo', TMAP);
  assert.equal(out.length, 0);
});

test('team thread map: a reply inside the owned topic also matches', () => {
  const out = filterAdminMessages([upd(4, { thread: 55, replyTo: 10 })], ADMINS, null, 'convo', TMAP);
  assert.equal(out.length, 1);
});

test('team thread map: per-chat keying — same thread number in a DIFFERENT chat is NOT matched (G-C1)', () => {
  const admins = ['-1001234', '-1009999'];
  // Map only owns chat -1001234 thread 55. A msg in chat -1009999 with thread 55
  // must NOT match (no entry for that chat) — guards cross-chat thread collision.
  const out = filterAdminMessages([upd(5, { thread: 55, chatId: -1009999 })], admins, null, 'convo', TMAP);
  assert.equal(out.length, 0);
});

test('team thread map: multi-chat routes each chat to its own thread', () => {
  const admins = ['-100', '-200'];
  const map = new Map([['-100', 7], ['-200', 9]]);
  const updates = [upd(6, { thread: 7, chatId: -100 }), upd(7, { thread: 9, chatId: -200 }), upd(8, { thread: 9, chatId: -100 })];
  const out = filterAdminMessages(updates, admins, null, 'convo', map);
  // msg6 (chat -100, thread 7) ✓; msg7 (chat -200, thread 9) ✓; msg8 (chat -100, thread 9 ✗ — that's -200's thread).
  assert.deepEqual(out.map((o) => o.msg.message_id).sort(), [6, 7]);
});

test('empty/null thread map: falls back to legacy reply-to matching', () => {
  const updates = [upd(9, { thread: 55, replyTo: 10 }), upd(10, { thread: 55, replyTo: 999 })];
  const out = filterAdminMessages(updates, ADMINS, new Set([10]), 'legacy', new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0].msg.message_id, 9);
});

// ── RFC 08: daemon-control prefix `/dm <cmd>` ─────────────────────────────────
import {
  isDmControlMessage, stripDmControlPrefix, collectMessagesToProcess, DM_CONTROL_PREFIX,
} from './tele-listen.mjs';

test('isDmControlMessage: matches /dm forms (case-insensitive, @botname, bare), rejects others', () => {
  assert.equal(DM_CONTROL_PREFIX, 'dm');
  assert.ok(isDmControlMessage('/dm setup -100'));
  assert.ok(isDmControlMessage('/DM spawn luni'));
  assert.ok(isDmControlMessage('  /dm@TeleBot ls  '));
  assert.ok(isDmControlMessage('/dm'));                 // bare → still hidden from agent
  assert.equal(isDmControlMessage('/dmesg now'), false); // not the dm command (no separator)
  assert.equal(isDmControlMessage('hello /dm'), false);  // not at start
  assert.equal(isDmControlMessage('/spawn luni'), false);
  assert.equal(isDmControlMessage(null), false);
});

test('stripDmControlPrefix: /dm <cmd> → /<cmd>; bare /dm → null; inner slash kept', () => {
  assert.equal(stripDmControlPrefix('/dm setup -100 --code x'), '/setup -100 --code x');
  assert.equal(stripDmControlPrefix('/DM spawn luni'), '/spawn luni');
  assert.equal(stripDmControlPrefix('/dm /ls'), '/ls');   // already-slashed inner kept as-is
  assert.equal(stripDmControlPrefix('/dm'), null);        // nothing to dispatch
  assert.equal(stripDmControlPrefix('/dm   '), null);
  assert.equal(stripDmControlPrefix('/spawn luni'), null); // not a /dm message
});

test('collectMessagesToProcess: drops /dm control messages from the agent prompt', () => {
  const updates = [
    upd(20, { thread: 55, text: 'normal question' }),
    upd(21, { thread: 55, text: '/dm setup -100' }),    // daemon-control → must be dropped
    upd(22, { thread: 55, text: '/dm' }),               // bare → dropped too
  ];
  const out = collectMessagesToProcess(updates, ADMINS, null, 'convo', TMAP);
  assert.equal(out.length, 1);
  assert.equal(out[0].msg.message_id, 20);
});
