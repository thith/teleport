import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectDeadConvoTopics, gcDeadTopics } from './send-telegram.mjs';
import { readTopicsStore, writeTopicsStore } from './topics-store.mjs';

function tmpTopics() {
  return path.join(os.tmpdir(), `gc-topics-${process.pid}-${Math.floor(performance.now() * 1000)}.json`);
}

const STORE = {
  '-100': {
    '111': 10,           // convo 111 → thread 10
    '222': 20,           // convo 222 → thread 20
    _no_topic_support: false,
    _checked_at: 'x',
  },
};

test('selectDeadConvoTopics: skips metadata keys, applies isStale', () => {
  const dead = selectDeadConvoTopics(STORE, '-100', (k) => k === '222');
  assert.deepEqual(dead, [{ convoKey: '222', threadId: 20 }]);
});

test('selectDeadConvoTopics: none stale → empty', () => {
  assert.deepEqual(selectDeadConvoTopics(STORE, '-100', () => false), []);
});

test('selectDeadConvoTopics: unknown chat → empty', () => {
  assert.deepEqual(selectDeadConvoTopics(STORE, '-999', () => true), []);
});

test('gcDeadTopics: closes stale topics and clears their mapping', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '111': 10, '222': 20 } }, file);
  const closedThreads = [];
  const closer = async (_t, _c, threadId) => { closedThreads.push(threadId); return { ok: true }; };
  const res = await gcDeadTopics({ token: 't', chatId: '-100', isStale: (k) => k === '222', closer, topicsFile: file });
  assert.deepEqual(res, { closed: 1, considered: 1 });
  assert.deepEqual(closedThreads, [20]);
  const store = readTopicsStore(file);
  assert.equal(store['-100']['222'], undefined); // cleared
  assert.equal(store['-100']['111'], 10);        // kept
  fs.unlinkSync(file);
});

test('gcDeadTopics: failed close keeps mapping for next run', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '222': 20 } }, file);
  const closer = async () => ({ ok: false, description: 'rate limited' });
  const res = await gcDeadTopics({ token: 't', chatId: '-100', isStale: () => true, closer, topicsFile: file });
  assert.deepEqual(res, { closed: 0, considered: 1 });
  const store = readTopicsStore(file);
  assert.equal(store['-100']['222'], 20); // mapping retained
  fs.unlinkSync(file);
});
