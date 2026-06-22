import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearThreadId,
  getThreadId,
  readTopicsStore,
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

// resolveThreadId now retries transient create failures via sendWithRetry; inject
// a no-op sleep so transient/throw tests don't incur the real backoff delay.
const noSleep = async () => {};

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

test('topics-store — recordThreadId persists mapping over a legacy negative entry', () => {
  // No negative cache exists anymore; a stale `_no_topic_support` left by an
  // older build is just inert metadata — recordThreadId neither reads nor
  // clears it, and the positive mapping lands as normal.
  const store = { '1234': { _no_topic_support: true, _checked_at: '2026-05-22T09:00:00.000Z' } };
  recordThreadId(store, 1234, 'tea_game', 7);
  assert.strictEqual(store['1234'].tea_game, 7);
});

test('topics-store — clearThreadId removes only specified project, keeps others', () => {
  const store = { '1234': { tea_game: 12, teleport: 15 } };
  clearThreadId(store, 1234, 'tea_game');
  assert.strictEqual(getThreadId(store, 1234, 'tea_game'), null);
  assert.strictEqual(getThreadId(store, 1234, 'teleport'), 15);
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

test('resolveThreadId — legacy negative entry is ignored, create is re-attempted', async () => {
  // A stale `_no_topic_support` from an older build must NOT suppress creation:
  // the negative cache is gone, so every send re-attempts and self-heals.
  const file = tmp();
  const now = Date.parse('2026-05-22T10:00:00Z');
  writeTopicsStore({ '1234': { _no_topic_support: true, _checked_at: new Date(now).toISOString() } }, file);
  let fetcherCalls = 0;
  const fetcher = async () => { fetcherCalls++; return { ok: true, messageThreadId: 99, status: 200 }; };
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'p', topicsFile: file, nowFn: () => now + 30 * 60_000, fetcher });
  assert.strictEqual(got, 99);
  assert.strictEqual(fetcherCalls, 1); // create WAS attempted despite the legacy flag
  fs.unlinkSync(file);
});

test('resolveThreadId — successful create persists mapping', async () => {
  const file = tmp();
  const fetcher = async () => ({ ok: true, messageThreadId: 77, status: 200 });
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'tea_game', topicsFile: file, nowFn: () => Date.parse('2026-05-22T10:00:00Z'), fetcher });
  assert.strictEqual(got, 77);
  const after = readTopicsStore(file);
  assert.strictEqual(after['1234'].tea_game, 77);
  fs.unlinkSync(file);
});

test('resolveThreadId — permanent error (403) returns null, writes no negative cache', async () => {
  const file = tmp();
  const fetcher = async () => ({ ok: false, status: 403, description: 'Forbidden: bot lacks permission' });
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'p', topicsFile: file, fetcher });
  assert.strictEqual(got, null);
  // No negative cache anymore → the next send re-attempts, so a fixed mis-config
  // self-heals immediately instead of staying dropped for an hour.
  const after = readTopicsStore(file);
  assert.strictEqual(after['1234']?._no_topic_support, undefined);
  try { fs.unlinkSync(file); } catch {}
});

test('resolveThreadId — transient error (429) returns null, no store poisoning', async () => {
  const file = tmp();
  const fetcher = async () => ({ ok: false, status: 429, description: 'Too Many Requests' });
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'p', topicsFile: file, fetcher, sleepFn: noSleep });
  assert.strictEqual(got, null);
  const after = readTopicsStore(file);
  assert.strictEqual(after['1234']?._no_topic_support, undefined);
  try { fs.unlinkSync(file); } catch {}
});

test('resolveThreadId — fetcher throws → null, no store poisoning', async () => {
  const file = tmp();
  const fetcher = async () => { throw new Error('network down'); };
  const got = await resolveThreadId({ token: 'X', chatId: 1234, projectCode: 'p', topicsFile: file, fetcher, sleepFn: noSleep });
  assert.strictEqual(got, null);
  const after = readTopicsStore(file);
  assert.strictEqual(after['1234']?._no_topic_support, undefined);
  fs.rmSync(file, { force: true });
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
