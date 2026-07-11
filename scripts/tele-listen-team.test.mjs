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
  shouldSettleBatch, settleWindowFor, settleSignals,
  SETTLE_MS_A, SETTLE_MS_B, SETTLE_MS_C, DEFAULT_SETTLE_MS, DEFAULT_SETTLE_FOLLOWUP_MS,
} from './tele-listen.mjs';

// Build a batch entry with a Telegram `date` (seconds) + optional signal fields.
// Default text is long (>=20 chars) so a message is NOT a "fragment" unless told.
const LONG = 'a full and complete sentence here';
const mk = (dateSec, extra = {}) => ({ msg: { date: dateSec, text: LONG, ...extra } });

// Adaptive tiers (RFC 02 tuning): signals on the NEWEST message → window.
//   single (lone batch) + fragment (forwarded / photo / text<20) → 0,1,2.
test('settleSignals: single + fragment → 2, one → 1, neither → 0', () => {
  assert.equal(settleSignals({ text: 'hi' }, 1), 2);                       // single + short
  assert.equal(settleSignals({ text: LONG }, 1), 1);                       // single only
  assert.equal(settleSignals({ text: LONG }, 3), 0);                       // neither (batched + long)
  assert.equal(settleSignals({ text: 'hi' }, 3), 1);                       // fragment only (short)
  assert.equal(settleSignals({ text: LONG, forward_origin: {} }, 3), 1);   // forwarded
  assert.equal(settleSignals({ text: LONG, photo: [{}] }, 3), 1);          // photo
});

test('settleWindowFor: 2 signals→A(30s), 1→B(20s), 0→C(10s); back-compat consts', () => {
  assert.equal(settleWindowFor({ text: 'hi' }, 1), SETTLE_MS_A);           // single + short
  assert.equal(settleWindowFor({ text: LONG }, 1), SETTLE_MS_B);           // single only
  assert.equal(settleWindowFor({ text: LONG }, 3), SETTLE_MS_C);           // neither
  assert.equal(SETTLE_MS_A, 30_000);
  assert.equal(SETTLE_MS_B, 20_000);
  assert.equal(SETTLE_MS_C, 10_000);
  assert.equal(DEFAULT_SETTLE_MS, SETTLE_MS_A);
  assert.equal(DEFAULT_SETTLE_FOLLOWUP_MS, SETTLE_MS_C);
});

test('shouldSettleBatch: lone short msg uses the 30s (A) window', () => {
  assert.equal(shouldSettleBatch([mk(75, { text: 'hi' })], 100_000), true);   // age 25s < 30s → defer
  assert.equal(shouldSettleBatch([mk(69, { text: 'hi' })], 100_000), false);  // age 31s >= 30s → release
});

test('shouldSettleBatch: lone complete msg uses the 20s (B) window', () => {
  assert.equal(shouldSettleBatch([mk(85)], 100_000), true);   // age 15s < 20s → defer
  assert.equal(shouldSettleBatch([mk(79)], 100_000), false);  // age 21s >= 20s → release
});

test('shouldSettleBatch: batch of complete msgs uses the tighter 10s (C) window', () => {
  assert.equal(shouldSettleBatch([mk(85), mk(92)], 100_000), true);   // newest age 8s < 10s → defer
  assert.equal(shouldSettleBatch([mk(85), mk(89)], 100_000), false);  // newest age 11s >= 10s → release
});

test('shouldSettleBatch: OLD backlog releases immediately (age-based)', () => {
  // newest at t=80s, now=100s → age 20s ≥ any tier → not held.
  assert.equal(shouldSettleBatch([mk(20), mk(40), mk(60), mk(80)], 100_000), false);
});

test('shouldSettleBatch: empty / future-dated / disabled-tier never defer', () => {
  assert.equal(shouldSettleBatch([], 100_000), false);
  assert.equal(shouldSettleBatch([mk(105, { text: 'hi' })], 100_000), false);                 // future (age<0)
  assert.equal(shouldSettleBatch([mk(90, { text: 'hi' })], 100_000, { a: 0, b: 20_000, c: 10_000 }), false); // A disabled
  assert.equal(shouldSettleBatch([mk(90, { text: 'hi' })], 100_000, { a: NaN, b: 20_000, c: 10_000 }), false);
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
