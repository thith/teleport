import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatPendingList,
  listDueReminders,
  listPending,
  markReminded,
  PENDING_CAP,
  readPendingStore,
  recordAdminReply,
  recordBotSend,
  REMIND_AFTER_MS,
  updatePendingStore,
  writePendingStore,
} from './pending-store.mjs';
import { handlePendingCommand, runHeartbeatReminders, isQuietHour } from './tele-listen.mjs';

function tmp() {
  return path.join(os.tmpdir(), `pending-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('pending-store — recordBotSend creates entry with project + messageId', () => {
  const store = {};
  recordBotSend(store, { convoId: 100, project: 'tea_game', messageId: 555, now: Date.parse('2026-05-22T10:00:00Z') });
  assert.strictEqual(store['100'].project, 'tea_game');
  assert.strictEqual(store['100'].lastBotSendMessageId, 555);
  assert.strictEqual(store['100'].lastBotSend, '2026-05-22T10:00:00.000Z');
  assert.strictEqual(store['100'].remindedAt, null);
});

test('pending-store — recordBotSend clears remindedAt on fresh send (new wait window)', () => {
  const store = { '100': { project: 'p', lastBotSend: 'old', remindedAt: '2026-05-22T11:00:00Z' } };
  recordBotSend(store, { convoId: 100, project: 'p', messageId: 1, now: Date.parse('2026-05-22T12:00:00Z') });
  assert.strictEqual(store['100'].remindedAt, null);
});

test('pending-store — recordAdminReply bumps lastAdminReply + clears remindedAt', () => {
  const store = { '100': { project: 'p', lastBotSend: '2026-05-22T10:00:00Z', remindedAt: '2026-05-22T11:00:00Z' } };
  recordAdminReply(store, { convoId: 100, now: Date.parse('2026-05-22T12:00:00Z') });
  assert.strictEqual(store['100'].lastAdminReply, '2026-05-22T12:00:00.000Z');
  assert.strictEqual(store['100'].remindedAt, null);
});

test('pending-store — recordAdminReply on unknown convo upserts entry (race-safe)', () => {
  // If admin's reply arrives before recordBotSend lands (e.g. lock contention),
  // we still want lastAdminReply recorded so a delayed bot send resolves it.
  const store = {};
  recordAdminReply(store, { convoId: 999, now: Date.parse('2026-05-22T10:00:00Z') });
  assert.strictEqual(store['999'].lastAdminReply, '2026-05-22T10:00:00.000Z');
  assert.strictEqual(store['999'].remindedAt, null);
});

test('pending-store — listPending: only entries where bot > reply', () => {
  const store = {
    '100': { project: 'a', lastBotSend: '2026-05-22T10:00:00Z', lastBotSendMessageId: 1, lastAdminReply: null, remindedAt: null },
    '200': { project: 'b', lastBotSend: '2026-05-22T10:00:00Z', lastBotSendMessageId: 2, lastAdminReply: '2026-05-22T11:00:00Z', remindedAt: null },
    '300': { project: 'c', lastBotSend: '2026-05-22T10:00:00Z', lastBotSendMessageId: 3, lastAdminReply: '2026-05-22T09:00:00Z', remindedAt: null },
  };
  const pending = listPending(store, { now: Date.parse('2026-05-22T12:00:00Z') });
  // 100 (no reply) + 300 (reply older than send) are pending; 200 has reply after send.
  const ids = pending.map((p) => p.convoId).sort();
  assert.deepStrictEqual(ids, ['100', '300']);
});

test('pending-store — listPending honors minElapsedMs threshold', () => {
  const store = {
    '100': { project: 'a', lastBotSend: '2026-05-22T11:30:00Z', lastBotSendMessageId: 1, lastAdminReply: null, remindedAt: null },
  };
  // 30 min elapsed; threshold 1h → no result
  const pending = listPending(store, { now: Date.parse('2026-05-22T12:00:00Z'), minElapsedMs: 60 * 60_000 });
  assert.strictEqual(pending.length, 0);
});

test('pending-store — listDueReminders skips already-reminded entries', () => {
  const t0 = Date.parse('2026-05-22T10:00:00Z');
  const now = t0 + 3 * 60 * 60_000; // 3h later, past REMIND_AFTER_MS
  const store = {
    '100': { project: 'a', lastBotSend: new Date(t0).toISOString(), lastBotSendMessageId: 1, lastAdminReply: null, remindedAt: null },
    '200': { project: 'b', lastBotSend: new Date(t0).toISOString(), lastBotSendMessageId: 2, lastAdminReply: null, remindedAt: new Date(now - 1000).toISOString() },
  };
  const due = listDueReminders(store, { now });
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].convoId, '100');
});

test('pending-store — markReminded sets timestamp', () => {
  const store = { '100': { project: 'a', lastBotSend: '2026-05-22T10:00:00Z' } };
  markReminded(store, { convoId: 100, now: Date.parse('2026-05-22T12:00:00Z') });
  assert.strictEqual(store['100'].remindedAt, '2026-05-22T12:00:00.000Z');
});

test('pending-store — formatPendingList: empty list returns "no pending" message', () => {
  const out = formatPendingList([]);
  assert.match(out, /No pending convos/);
});

test('pending-store — formatPendingList: includes project + convo hash + elapsed', () => {
  const out = formatPendingList([
    { convoId: '2205483045424020', project: 'tea_game', lastBotSendMessageId: 2700, elapsedMs: 2 * 60 * 60_000 + 30 * 60_000, remindedAt: null },
  ]);
  assert.match(out, /tea_game/);
  // Encoded shortConvoHash for last 8 = "45424020", first digit 4 → 'e' → "e5424020"
  assert.match(out, /#e5424020/);
  assert.match(out, /2h 30m/);
  assert.match(out, /msg 2700/);
});

test('pending-store — formatPendingList: marks reminded entries', () => {
  const out = formatPendingList([
    { convoId: '100', project: 'p', lastBotSendMessageId: 1, elapsedMs: 60_000, remindedAt: '2026-05-22T12:00:00Z' },
  ]);
  assert.match(out, /\(reminded\)/);
});

test('pending-store — writePendingStore enforces PENDING_CAP', () => {
  const file = tmp();
  const big = {};
  // Insert PENDING_CAP + 50 entries; oldest by lastBotSend should be evicted.
  for (let i = 0; i < PENDING_CAP + 50; i++) {
    big[String(i)] = {
      project: 'p',
      lastBotSend: new Date(Date.parse('2026-05-22T00:00:00Z') + i * 1000).toISOString(),
      lastBotSendMessageId: i,
    };
  }
  writePendingStore(big, file);
  const after = readPendingStore(file);
  assert.strictEqual(Object.keys(after).length, PENDING_CAP);
  // Newest entries kept; entry i=PENDING_CAP+49 must survive.
  assert.ok(after[String(PENDING_CAP + 49)]);
  fs.unlinkSync(file);
});

test('pending-store — updatePendingStore round-trip', () => {
  const file = tmp();
  // Anchor to wall-clock so the 24h TTL sweep in writePendingStore never
  // strips this entry mid-test (older anchor dates went flaky as the test
  // suite aged past t0 + 24h).
  updatePendingStore((s) => recordBotSend(s, { convoId: 100, project: 'p', messageId: 1, now: Date.now() }), file);
  const after = readPendingStore(file);
  assert.strictEqual(after['100'].project, 'p');
  fs.unlinkSync(file);
});

test('handlePendingCommand — admin /pending message triggers response', async () => {
  const updates = [{
    update_id: 1,
    message: {
      message_id: 100,
      chat: { id: 144242180, type: 'private' },
      text: '/pending',
    },
  }];
  let sentBody = null;
  const sendText = async (chatId, text) => { sentBody = text; return true; };
  const handled = await handlePendingCommand('TOKEN', updates, ['144242180'], { sendText });
  assert.strictEqual(handled.size, 1);
  assert.ok(sentBody);
});

test('handlePendingCommand — ignores non-admin chat', async () => {
  const updates = [{
    update_id: 1,
    message: {
      message_id: 100,
      chat: { id: 999999, type: 'private' },
      text: '/pending',
    },
  }];
  let sentBody = null;
  const sendText = async (chatId, text) => { sentBody = text; return true; };
  const handled = await handlePendingCommand('TOKEN', updates, ['144242180'], { sendText });
  assert.strictEqual(handled.size, 0);
  assert.strictEqual(sentBody, null);
});

test('handlePendingCommand — ignores non-/pending text', async () => {
  const updates = [{
    update_id: 1,
    message: {
      message_id: 100,
      chat: { id: 144242180, type: 'private' },
      text: 'hello world',
    },
  }];
  const handled = await handlePendingCommand('TOKEN', updates, ['144242180'], { sendText: async () => true });
  assert.strictEqual(handled.size, 0);
});

function atHour(h) {
  const d = new Date(2026, 4, 23, h, 30, 0);
  return d;
}

test('isQuietHour — disabled when env vars unset or empty', () => {
  assert.strictEqual(isQuietHour(atHour(2), {}), false);
  assert.strictEqual(isQuietHour(atHour(2), { QUIET_HOURS_START: '', QUIET_HOURS_END: '' }), false);
});

test('isQuietHour — non-numeric or out-of-range silently disables (no partial-window surprises)', () => {
  const env = (s, e) => ({ QUIET_HOURS_START: s, QUIET_HOURS_END: e });
  assert.strictEqual(isQuietHour(atHour(2), env('8h', '22')), false);
  assert.strictEqual(isQuietHour(atHour(2), env('22', '8 am')), false);
  assert.strictEqual(isQuietHour(atHour(2), env('-1', '8')), false);
  assert.strictEqual(isQuietHour(atHour(2), env('22', '24')), false);
  assert.strictEqual(isQuietHour(atHour(2), env('5', '5')), false);
});

test('isQuietHour — wrap-around 22→8 covers night, excludes day', () => {
  const env = { QUIET_HOURS_START: '22', QUIET_HOURS_END: '8' };
  assert.strictEqual(isQuietHour(atHour(22), env), true);
  assert.strictEqual(isQuietHour(atHour(2), env), true);
  assert.strictEqual(isQuietHour(atHour(7), env), true);
  assert.strictEqual(isQuietHour(atHour(8), env), false, 'END is exclusive');
  assert.strictEqual(isQuietHour(atHour(12), env), false);
  assert.strictEqual(isQuietHour(atHour(21), env), false, 'START is inclusive — 21 is just before');
});

test('isQuietHour — non-wrapping 1→5 (sanity for start<end branch)', () => {
  const env = { QUIET_HOURS_START: '1', QUIET_HOURS_END: '5' };
  assert.strictEqual(isQuietHour(atHour(0), env), false);
  assert.strictEqual(isQuietHour(atHour(1), env), true);
  assert.strictEqual(isQuietHour(atHour(4), env), true);
  assert.strictEqual(isQuietHour(atHour(5), env), false);
});

test('runHeartbeatReminders — skips send when isQuietHour is true', async () => {
  const file = tmp();
  const t0 = Date.parse('2026-05-22T08:00:00Z');
  const store = readPendingStore(file);
  recordBotSend(store, { convoId: '123', project: 'p', messageId: 1, now: t0 });
  // Pass simulated `now` so the writer's 24h TTL sweep doesn't drop entries
  // when wall-clock time has moved past t0 + 24h since the test was written.
  writePendingStore(store, file, { now: t0 });
  // 3h elapsed — would normally be due. Set quiet window covering "now".
  const now = t0 + 3 * 60 * 60 * 1000;
  const hourLocal = new Date(now).getHours();
  const start = String(hourLocal);
  const end = String((hourLocal + 1) % 24);
  const prevStart = process.env.QUIET_HOURS_START;
  const prevEnd = process.env.QUIET_HOURS_END;
  process.env.QUIET_HOURS_START = start;
  process.env.QUIET_HOURS_END = end;
  try {
    let calls = 0;
    const sent = await runHeartbeatReminders('TOKEN', ['144242180'], {
      sendText: async () => { calls++; return true; },
      now,
      storeFile: file,
    });
    assert.strictEqual(calls, 0);
    assert.strictEqual(sent, 0);
    // Entry must remain unmarked so it fires after quiet ends.
    const after = readPendingStore(file);
    assert.strictEqual(after['123'].remindedAt, null);
  } finally {
    if (prevStart === undefined) delete process.env.QUIET_HOURS_START; else process.env.QUIET_HOURS_START = prevStart;
    if (prevEnd === undefined) delete process.env.QUIET_HOURS_END; else process.env.QUIET_HOURS_END = prevEnd;
  }
});

test('runHeartbeatReminders — no due → no send', async () => {
  let calls = 0;
  const sent = await runHeartbeatReminders('TOKEN', ['144242180'], { sendText: async () => { calls++; return true; }, now: Date.now() });
  assert.strictEqual(calls, 0);
  assert.strictEqual(sent, 0);
});

test('REMIND_AFTER_MS — exposed constant is 2 hours', () => {
  assert.strictEqual(REMIND_AFTER_MS, 2 * 60 * 60 * 1000);
});

test('formatPendingList — caps at PENDING_LIST_CAP entries + "…and N more"', () => {
  const big = [];
  for (let i = 0; i < 30; i++) {
    big.push({ convoId: String(i), project: 'p', lastBotSendMessageId: i, elapsedMs: 60_000, remindedAt: null });
  }
  const out = formatPendingList(big);
  assert.match(out, /…and 10 more/);
  // Header should still say total count, not the capped count.
  assert.match(out, /30 pending convos/);
});

test('handlePendingCommand — strict regex rejects /pendingabc', async () => {
  const updates = [{
    update_id: 1,
    message: { message_id: 100, chat: { id: 144242180, type: 'private' }, text: '/pendingabc' },
  }];
  const handled = await handlePendingCommand('TOKEN', updates, ['144242180'], { sendText: async () => true });
  assert.strictEqual(handled.size, 0);
});

test('handlePendingCommand — strict regex accepts /pending@bot_name', async () => {
  const updates = [{
    update_id: 1,
    message: { message_id: 100, chat: { id: 144242180, type: 'private' }, text: '/pending@my_bot' },
  }];
  let sent = false;
  const handled = await handlePendingCommand('TOKEN', updates, ['144242180'], { sendText: async () => { sent = true; return true; } });
  assert.strictEqual(handled.size, 1);
  assert.strictEqual(sent, true);
});

test('runHeartbeatReminders — fans out to ALL admins, throttled between sends', async () => {
  const file = tmp();
  // Use a recent t0 anchored to wall-clock so the 24h TTL sweep doesn't drop
  // the entry on the markReminded write (the test once used a fixed past date
  // and went flaky as wall-clock crossed t0 + 24h).
  const now = Date.now();
  const t0 = now - 3 * 60 * 60_000; // 3h before "now", past REMIND_AFTER_MS
  let store = {};
  recordBotSend(store, { convoId: 100, project: 'p', messageId: 1, now: t0 });
  writePendingStore(store, file, { now: t0 });
  const callsByChatId = [];
  const sendText = async (chatId, text) => { callsByChatId.push(chatId); return true; };
  // Inject `storeFile` so the test doesn't write to production pending.json.
  // Force alive=true so the new listener-alive gate doesn't drop our entry —
  // we're testing the fan-out behavior, not the alive filter.
  await runHeartbeatReminders('TOKEN', ['adminA', 'adminB', 'adminC'], { sendText, now, storeFile: file, getLastAliveMs: () => now - 1000 });
  assert.deepStrictEqual(callsByChatId, ['adminA', 'adminB', 'adminC']);
  // Verify markReminded persisted to OUR file, not production.
  const after = readPendingStore(file);
  assert.ok(after['100'].remindedAt);
  fs.unlinkSync(file);
});

// ---------------------------------------------------------------------------
// listener-alive integration
// ---------------------------------------------------------------------------

test('listPending — attaches alive flag from getLastAliveMs callback', () => {
  const store = {};
  const t0 = Date.parse('2026-05-22T08:00:00Z');
  recordBotSend(store, { convoId: 'a', project: 'p', messageId: 1, now: t0 });
  recordBotSend(store, { convoId: 'b', project: 'p', messageId: 2, now: t0 });
  const now = t0 + 10 * 60 * 1000;
  const out = listPending(store, {
    now,
    getLastAliveMs: (cid) => (cid === 'a' ? now - 10_000 : now - 5 * 60 * 1000),
    aliveFreshMs: 90_000,
  });
  const a = out.find((p) => p.convoId === 'a');
  const b = out.find((p) => p.convoId === 'b');
  assert.strictEqual(a.alive, true);
  assert.strictEqual(b.alive, false);
  assert.ok(a.lastAliveMs != null && b.lastAliveMs != null);
});

test('listDueReminders — drops entries whose listener is not alive', () => {
  const file = tmp();
  const t0 = Date.parse('2026-05-22T08:00:00Z');
  const store = readPendingStore(file);
  recordBotSend(store, { convoId: 'alive', project: 'p', messageId: 1, now: t0 });
  recordBotSend(store, { convoId: 'dead', project: 'p', messageId: 2, now: t0 });
  writePendingStore(store, file, { now: t0 });
  const now = t0 + 3 * 60 * 60 * 1000; // both well past 2h threshold
  const due = listDueReminders(readPendingStore(file), {
    now,
    getLastAliveMs: (cid) => (cid === 'alive' ? now - 10_000 : now - 10 * 60 * 1000),
    aliveFreshMs: 90_000,
  });
  assert.deepStrictEqual(due.map((d) => d.convoId), ['alive']);
  fs.unlinkSync(file);
});

test('listDueReminders — without getLastAliveMs callback keeps legacy behavior (all due fire)', () => {
  // Back-compat guard: existing tests / callers that never pass a callback
  // must still see every due entry.
  const t0 = Date.parse('2026-05-22T08:00:00Z');
  const store = {};
  recordBotSend(store, { convoId: 'x', project: 'p', messageId: 1, now: t0 });
  recordBotSend(store, { convoId: 'y', project: 'p', messageId: 2, now: t0 });
  const now = t0 + 3 * 60 * 60 * 1000;
  const due = listDueReminders(store, { now });
  assert.strictEqual(due.length, 2);
});

test('formatPendingList — renders 🟢/💀/⚪ markers + last-alive', () => {
  const now = Date.parse('2026-05-22T10:00:00Z');
  const pending = [
    { convoId: '1', project: 'p', lastBotSendMessageId: 1, elapsedMs: 60_000, remindedAt: null, alive: true, lastAliveMs: now - 10_000 },
    { convoId: '2', project: 'p', lastBotSendMessageId: 2, elapsedMs: 60_000, remindedAt: null, alive: false, lastAliveMs: now - 5 * 60_000 },
    { convoId: '3', project: 'p', lastBotSendMessageId: 3, elapsedMs: 60_000, remindedAt: null, alive: false, lastAliveMs: null },
  ];
  const out = formatPendingList(pending, { now });
  assert.match(out, /• 🟢/);
  assert.match(out, /• 💀/);
  assert.match(out, /• ⚪/);
  assert.match(out, /last alive 5m ago/);
});

