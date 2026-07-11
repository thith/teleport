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
  shouldSettleBatch, settleWindowFor, DEFAULT_SETTLE_MS, DEFAULT_SETTLE_FOLLOWUP_MS,
} from './tele-listen.mjs';

// Build a minimal batch entry ({ msg }) with a Telegram `date` (seconds).
const batchAt = (...dateSecs) => dateSecs.map((d) => ({ msg: { date: d } }));
const F = 12_000; // firstMs (lone message)
const U = 8_000;  // followupMs (burst confirmed)

test('settleWindowFor: lone message → firstMs; >=2 messages → followupMs', () => {
  assert.equal(settleWindowFor(1, F, U), F);
  assert.equal(settleWindowFor(2, F, U), U);
  assert.equal(settleWindowFor(4, F, U), U);
  assert.equal(DEFAULT_SETTLE_MS, 12_000);
  assert.equal(DEFAULT_SETTLE_FOLLOWUP_MS, 8_000);
});

test('shouldSettleBatch: lone message uses the 12s window', () => {
  // one message, age 10s < 12s → defer.
  assert.equal(shouldSettleBatch(batchAt(90), 100_000, F, U), true);
  // one message, age 13s >= 12s → release.
  assert.equal(shouldSettleBatch(batchAt(87), 100_000, F, U), false);
});

test('shouldSettleBatch: a burst (>=2) uses the tighter 8s window', () => {
  // two messages, newest age 7s < 8s → defer.
  assert.equal(shouldSettleBatch(batchAt(90, 93), 100_000, F, U), true);
  // two messages, newest age 9s >= 8s → release (would still be settling under the 12s tier).
  assert.equal(shouldSettleBatch(batchAt(80, 91), 100_000, F, U), false);
});

test('shouldSettleBatch: 4 msgs 5s apart — resets window, releases at ~8s after the last', () => {
  // msgs at t=0,5,10,15s. At t=20s the newest (15s) is only 5s old → defer (8s tier).
  assert.equal(shouldSettleBatch(batchAt(0, 5, 10, 15), 20_000, F, U), true);
  // At t=23s the newest is 8s old → release the whole batch (vs 27s under a flat 12s).
  assert.equal(shouldSettleBatch(batchAt(0, 5, 10, 15), 23_000, F, U), false);
});

test('shouldSettleBatch: pre-existing OLD backlog releases immediately (age-based, not count)', () => {
  // Listener resumes after a long turn: now=100s, 4 messages whose NEWEST was
  // sent at t=80s → age 20s, far past any window → NOT held, processed at once.
  assert.equal(shouldSettleBatch(batchAt(20, 40, 60, 80), 100_000, F, U), false);
});

test('shouldSettleBatch: future-dated message (clock skew) does not defer', () => {
  // newest dated 5s in the future vs now → age < 0 → release, never hang.
  assert.equal(shouldSettleBatch(batchAt(105), 100_000, F, U), false);
});

test('shouldSettleBatch: empty batch and disabled tiers never defer', () => {
  assert.equal(shouldSettleBatch([], 100_000, F, U), false);
  assert.equal(shouldSettleBatch(batchAt(99), 100_000, 0, U), false);      // lone tier disabled
  assert.equal(shouldSettleBatch(batchAt(99, 99), 100_000, F, 0), false);  // followup tier disabled
  assert.equal(shouldSettleBatch(batchAt(99), 100_000, NaN, U), false);
});

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
