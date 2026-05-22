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
import { handlePendingCommand, runHeartbeatReminders } from './tele-listen.mjs';

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
  updatePendingStore((s) => recordBotSend(s, { convoId: 100, project: 'p', messageId: 1, now: Date.parse('2026-05-22T10:00:00Z') }), file);
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
  const t0 = Date.parse('2026-05-22T08:00:00Z');
  const now = t0 + 3 * 60 * 60_000; // 3h later, past REMIND_AFTER_MS
  let store = {};
  recordBotSend(store, { convoId: 100, project: 'p', messageId: 1, now: t0 });
  writePendingStore(store, file);
  const callsByChatId = [];
  const sendText = async (chatId, text) => { callsByChatId.push(chatId); return true; };
  // Inject `storeFile` so the test doesn't write to production pending.json.
  await runHeartbeatReminders('TOKEN', ['adminA', 'adminB', 'adminC'], { sendText, now, storeFile: file });
  assert.deepStrictEqual(callsByChatId, ['adminA', 'adminB', 'adminC']);
  // Verify markReminded persisted to OUR file, not production.
  const after = readPendingStore(file);
  assert.ok(after['100'].remindedAt);
  fs.unlinkSync(file);
});
