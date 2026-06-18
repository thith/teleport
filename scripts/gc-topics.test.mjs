import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectDeadConvoTopics, gcDeadTopics, closeConvoTopic } from './send-telegram.mjs';
import { readTopicsStore, writeTopicsStore } from './topics-store.mjs';

function tmpTopics() {
  return path.join(os.tmpdir(), `gc-topics-${process.pid}-${Math.floor(performance.now() * 1000)}.json`);
}

const NOW = 1_000_000_000_000;
const TTL = 48 * 60 * 60 * 1000;
const OLD = NOW - TTL - 1; // just past TTL
const FRESH = NOW - 1000;

// 111 idle past TTL → dead; 222 fresh → alive; 333 has NO _ts → never selected.
const STORE = {
  '-100': {
    '111': 10,
    '222': 20,
    '333': 30,
    _is_forum: true,
    _ts: { '111': OLD, '222': FRESH },
  },
};

test('selectDeadConvoTopics: only topics idle past TTL (with a _ts) are dead', () => {
  const dead = selectDeadConvoTopics(STORE, '-100', NOW, TTL);
  assert.deepEqual(dead, [{ convoKey: '111', threadId: 10 }]);
});

test('selectDeadConvoTopics: a topic with NO _ts is never selected (brand-new guard)', () => {
  const dead = selectDeadConvoTopics(STORE, '-100', NOW, TTL);
  assert.ok(!dead.some((d) => d.convoKey === '333'));
});

test('selectDeadConvoTopics: nothing dead when all fresh', () => {
  const s = { '-100': { '1': 5, _ts: { '1': FRESH } } };
  assert.deepEqual(selectDeadConvoTopics(s, '-100', NOW, TTL), []);
});

test('selectDeadConvoTopics: unknown chat → empty', () => {
  assert.deepEqual(selectDeadConvoTopics(STORE, '-999', NOW, TTL), []);
});

test('gcDeadTopics: closes idle topic, clears mapping AND its _ts', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '111': 10, '222': 20, _ts: { '111': OLD, '222': FRESH } } }, file);
  const closedThreads = [];
  const closer = async (_t, _c, threadId) => { closedThreads.push(threadId); return { ok: true }; };
  const res = await gcDeadTopics({ token: 't', chatId: '-100', now: NOW, ttlMs: TTL, closer, topicsFile: file });
  assert.deepEqual(res, { closed: 1, considered: 1 });
  assert.deepEqual(closedThreads, [10]);
  const store = readTopicsStore(file);
  assert.equal(store['-100']['111'], undefined);     // mapping cleared
  assert.equal(store['-100']._ts['111'], undefined);  // _ts cleared
  assert.equal(store['-100']['222'], 20);            // fresh kept
  fs.unlinkSync(file);
});

test('gcDeadTopics: failed close keeps mapping for next run', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '111': 10, _ts: { '111': OLD } } }, file);
  const closer = async () => ({ ok: false, description: 'rate limited' });
  const res = await gcDeadTopics({ token: 't', chatId: '-100', now: NOW, ttlMs: TTL, closer, topicsFile: file });
  assert.deepEqual(res, { closed: 0, considered: 1 });
  assert.equal(readTopicsStore(file)['-100']['111'], 10); // retained
  fs.unlinkSync(file);
});

test('gcDeadTopics: brand-new topic (no _ts) is NOT closed even if GC runs', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '111': 10 } }, file); // no _ts at all
  let calls = 0;
  const closer = async () => { calls++; return { ok: true }; };
  const res = await gcDeadTopics({ token: 't', chatId: '-100', now: NOW, ttlMs: TTL, closer, topicsFile: file });
  assert.deepEqual(res, { closed: 0, considered: 0 });
  assert.equal(calls, 0);
  assert.equal(readTopicsStore(file)['-100']['111'], 10);
  fs.unlinkSync(file);
});

test('closeConvoTopic: closes the convo topic, clears mapping AND its _ts', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '111': 10, '222': 20, _ts: { '111': FRESH, '222': FRESH } } }, file);
  const closedThreads = [];
  const closer = async (_t, _c, threadId) => { closedThreads.push(threadId); return { ok: true }; };
  const r = await closeConvoTopic({ token: 't', chatId: '-100', convoKey: '111', closer, topicsFile: file });
  assert.deepEqual(r, { status: 'closed' });
  assert.deepEqual(closedThreads, [10]);          // closed regardless of idle time (fresh _ts)
  const store = readTopicsStore(file);
  assert.equal(store['-100']['111'], undefined);    // mapping cleared
  assert.equal(store['-100']._ts['111'], undefined); // _ts cleared
  assert.equal(store['-100']['222'], 20);           // other convo untouched
  fs.unlinkSync(file);
});

test('closeConvoTopic: absent mapping → status absent, closer NOT called', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '111': 10, _ts: { '111': FRESH } } }, file);
  let calls = 0;
  const closer = async () => { calls++; return { ok: true }; };
  const r = await closeConvoTopic({ token: 't', chatId: '-100', convoKey: '999', closer, topicsFile: file });
  assert.deepEqual(r, { status: 'absent' });
  assert.equal(calls, 0);
  assert.equal(readTopicsStore(file)['-100']['111'], 10); // untouched
  fs.unlinkSync(file);
});

test('closeConvoTopic: failed close (ok:false) → status failed + description, mapping kept', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '111': 10, _ts: { '111': FRESH } } }, file);
  const closer = async () => ({ ok: false, description: 'not enough rights' });
  const r = await closeConvoTopic({ token: 't', chatId: '-100', convoKey: '111', closer, topicsFile: file });
  assert.deepEqual(r, { status: 'failed', description: 'not enough rights' });
  assert.equal(readTopicsStore(file)['-100']['111'], 10);     // preserved on failure
  assert.equal(readTopicsStore(file)['-100']._ts['111'], FRESH);
  fs.unlinkSync(file);
});

test('closeConvoTopic: closer throws → status failed (never throws), mapping kept', async () => {
  const file = tmpTopics();
  writeTopicsStore({ '-100': { '111': 10, _ts: { '111': FRESH } } }, file);
  const closer = async () => { throw new Error('socket hang up'); };
  const r = await closeConvoTopic({ token: 't', chatId: '-100', convoKey: '111', closer, topicsFile: file });
  assert.equal(r.status, 'failed');
  assert.match(r.description, /socket hang up/);
  assert.equal(readTopicsStore(file)['-100']['111'], 10);     // preserved
  fs.unlinkSync(file);
});
