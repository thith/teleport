import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearThreadId,
  getThreadId,
  isNoTopicSupportFresh,
  NO_SUPPORT_TTL_MS,
  readTopicsStore,
  recordNoTopicSupport,
  recordThreadId,
  writeTopicsStore,
} from './topics-store.mjs';
import {
  injectConvoHash,
  isTopicGoneError,
  resolveThreadId,
} from './send-telegram.mjs';

function tmp() {
  return path.join(os.tmpdir(), `topics-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('topics-store — recordThreadId persists positive mapping', () => {
  const file = tmp();
  let store = {};
  recordThreadId(store, 1234, 'tea_game', 12);
  writeTopicsStore(store, file);
  store = readTopicsStore(file);
  assert.strictEqual(getThreadId(store, 1234, 'tea_game'), 12);
  fs.unlinkSync(file);
});

test('topics-store — getThreadId returns null for unknown project', () => {
  const store = { '1234': { tea_game: 12 } };
  assert.strictEqual(getThreadId(store, 1234, 'unknown'), null);
});

test('topics-store — getThreadId ignores reserved (underscore-prefixed) keys', () => {
  const store = { '1234': { _no_topic_support: true } };
  // Even if caller asks for `_no_topic_support` as projectCode, never return it.
  assert.strictEqual(getThreadId(store, 1234, '_no_topic_support'), null);
});

test('topics-store — recordNoTopicSupport sets flag + timestamp', () => {
  const store = {};
  recordNoTopicSupport(store, 1234, Date.parse('2026-05-22T10:00:00Z'));
  assert.strictEqual(store['1234']._no_topic_support, true);
  assert.strictEqual(store['1234']._checked_at, '2026-05-22T10:00:00.000Z');
});

test('topics-store — isNoTopicSupportFresh respects TTL', () => {
  const t0 = Date.parse('2026-05-22T10:00:00Z');
  const store = {};
  recordNoTopicSupport(store, 1234, t0);
  // 30 minutes later → still fresh
  assert.strictEqual(isNoTopicSupportFresh(store, 1234, t0 + 30 * 60_000), true);
  // 61 minutes later → expired
  assert.strictEqual(isNoTopicSupportFresh(store, 1234, t0 + 61 * 60_000), false);
});

test('topics-store — recordThreadId clears negative flag (self-heal)', () => {
  const store = { '1234': { _no_topic_support: true, _checked_at: '2026-05-22T09:00:00.000Z' } };
  recordThreadId(store, 1234, 'tea_game', 7);
  assert.strictEqual(store['1234']._no_topic_support, false);
  assert.strictEqual(store['1234']._checked_at, undefined);
  assert.strictEqual(store['1234'].tea_game, 7);
});

test('topics-store — clearThreadId removes only specified project, keeps others', () => {
  const store = { '1234': { tea_game: 12, teleport: 15, _no_topic_support: false } };
  clearThreadId(store, 1234, 'tea_game');
  assert.strictEqual(getThreadId(store, 1234, 'tea_game'), null);
  assert.strictEqual(getThreadId(store, 1234, 'teleport'), 15);
  assert.strictEqual(store['1234']._no_topic_support, false);
});

test('topics-store — readTopicsStore returns {} on missing file', () => {
  const out = readTopicsStore(path.join(os.tmpdir(), 'definitely-missing.json'));
  assert.deepStrictEqual(out, {});
});

test('topics-store — readTopicsStore returns {} on malformed JSON', () => {
  const file = tmp();
  fs.writeFileSync(file, 'not json', 'utf8');
  assert.deepStrictEqual(readTopicsStore(file), {});
  fs.unlinkSync(file);
});

test('topics-store — chatId as number or string yields same lookup', () => {
  const store = {};
  recordThreadId(store, 1234, 'tea_game', 12);
  // Caller may pass number or string; both should hit the same row.
  assert.strictEqual(getThreadId(store, '1234', 'tea_game'), 12);
  assert.strictEqual(getThreadId(store, 1234, 'tea_game'), 12);
});

test('isTopicGoneError — detects the three known errors', () => {
  assert.strictEqual(isTopicGoneError('Bad Request: MESSAGE_THREAD_NOT_FOUND'), true);
  assert.strictEqual(isTopicGoneError('TOPIC_DELETED'), true);
  assert.strictEqual(isTopicGoneError('Bad Request: TOPIC_CLOSED'), true);
  assert.strictEqual(isTopicGoneError('chat not found'), false);
  assert.strictEqual(isTopicGoneError(undefined), false);
});

test('NO_SUPPORT_TTL_MS — exposed constant is 1 hour', () => {
  assert.strictEqual(NO_SUPPORT_TTL_MS, 60 * 60 * 1000);
});

test('resolveThreadId — positive cache hit returns thread_id without API call', async () => {
  const file = tmp();
  let store = {};
  recordThreadId(store, 1234, 'tea_game', 42);
  writeTopicsStore(store, file);
  let fetcherCalls = 0;
  const fetcher = () => { fetcherCalls++; return { ok: true, messageThreadId: 999 }; };
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'tea_game', topicsFile: file, fetcher });
  assert.strictEqual(got, 42);
  assert.strictEqual(fetcherCalls, 0); // no API call
  fs.unlinkSync(file);
});

test('resolveThreadId — fresh negative cache skips API call', async () => {
  const file = tmp();
  const now = Date.parse('2026-05-22T10:00:00Z');
  let store = {};
  recordNoTopicSupport(store, 1234, now);
  writeTopicsStore(store, file);
  let fetcherCalls = 0;
  const fetcher = () => { fetcherCalls++; return { ok: true, messageThreadId: 99 }; };
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'p', topicsFile: file, nowFn: () => now + 30 * 60_000, fetcher });
  assert.strictEqual(got, null);
  assert.strictEqual(fetcherCalls, 0);
  fs.unlinkSync(file);
});

test('resolveThreadId — successful create persists mapping + clears negative flag', async () => {
  const file = tmp();
  // Pre-seed an expired negative cache to verify self-heal
  const old = Date.parse('2026-05-22T08:00:00Z');
  let store = {};
  recordNoTopicSupport(store, 1234, old);
  writeTopicsStore(store, file);
  const fetcher = async () => ({ ok: true, messageThreadId: 77, status: 200 });
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'tea_game', topicsFile: file, nowFn: () => Date.parse('2026-05-22T10:00:00Z'), fetcher });
  assert.strictEqual(got, 77);
  const after = readTopicsStore(file);
  assert.strictEqual(after['1234'].tea_game, 77);
  assert.strictEqual(after['1234']._no_topic_support, false);
  fs.unlinkSync(file);
});

test('resolveThreadId — permanent error (403) sets negative cache', async () => {
  const file = tmp();
  const fetcher = async () => ({ ok: false, status: 403, description: 'Forbidden: bot lacks permission' });
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'p', topicsFile: file, fetcher });
  assert.strictEqual(got, null);
  const after = readTopicsStore(file);
  assert.strictEqual(after['1234']._no_topic_support, true);
  fs.unlinkSync(file);
});

test('resolveThreadId — transient error (429) does NOT set negative cache', async () => {
  const file = tmp();
  const fetcher = async () => ({ ok: false, status: 429, description: 'Too Many Requests' });
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'p', topicsFile: file, fetcher });
  assert.strictEqual(got, null);
  const after = readTopicsStore(file);
  // No entry at all → next call will retry, not poisoned. File may not exist.
  assert.strictEqual(after['1234']?._no_topic_support, undefined);
  try { fs.unlinkSync(file); } catch {}
});

test('resolveThreadId — fetcher throws → silent fallback, negative cached', async () => {
  const file = tmp();
  const fetcher = async () => { throw new Error('network down'); };
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'p', topicsFile: file, fetcher });
  assert.strictEqual(got, null);
  // Network throw treated as permanent (defensive — we have no signal it's transient).
  const after = readTopicsStore(file);
  assert.strictEqual(after['1234']._no_topic_support, true);
  fs.unlinkSync(file);
});

test('resolveThreadId — projectCode starting with `_` returns null immediately (no API)', async () => {
  const file = tmp();
  let fetcherCalls = 0;
  const fetcher = () => { fetcherCalls++; return { ok: true, messageThreadId: 1 }; };
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: '_meta', topicsFile: file, fetcher });
  assert.strictEqual(got, null);
  assert.strictEqual(fetcherCalls, 0);
  // No store write — file shouldn't exist.
  assert.strictEqual(fs.existsSync(file), false);
});

test('isNoTopicSupportFresh — backward clock skew treated as stale', () => {
  const t0 = Date.parse('2026-05-22T10:00:00Z');
  const store = {};
  recordNoTopicSupport(store, 1234, t0);
  // Clock moved BACKWARD by 1 hour → age is negative → stale → re-check.
  assert.strictEqual(isNoTopicSupportFresh(store, 1234, t0 - 60 * 60_000), false);
});
