import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectForum,
  teamModeForumError,
  topicTarget,
  resolveThreadId,
  isForumCached,
  cacheForum,
} from './send-telegram.mjs';
import { readTopicsStore, getThreadId, writeTopicsStore, isNoTopicSupportFresh } from './topics-store.mjs';

const noSleep = async () => {};

function tmpTopics() {
  return path.join(os.tmpdir(), `topics-test-${process.pid}-${Math.floor(performance.now() * 1000)}.json`);
}

// ---- topicTarget ---------------------------------------------------------

test('topicTarget: keys by convoId, titles by persona', () => {
  const t = topicTarget({
    convoId: '3039138158370420',
    persona: { emoji: '🐷', name: 'Heo' },
    projectCode: 'luni',
  });
  assert.deepEqual(t, { topicKey: '3039138158370420', topicName: '🐷 Heo · luni' });
});

test('topicTarget: no convoId falls back to projectCode', () => {
  assert.deepEqual(
    topicTarget({ convoId: null, persona: { emoji: '🐷', name: 'Heo' }, projectCode: 'luni' }),
    { topicKey: 'luni', topicName: 'luni' },
  );
});

test('topicTarget: no persona falls back to projectCode', () => {
  assert.deepEqual(
    topicTarget({ convoId: '1', persona: null, projectCode: 'luni' }),
    { topicKey: 'luni', topicName: 'luni' },
  );
});

test('topicTarget: dedicated group → persona-only title (no project suffix, RFC 02)', () => {
  const t = topicTarget({ convoId: '99', persona: { emoji: '🐷', name: 'Heo' }, projectCode: 'luni', dedicated: true });
  assert.deepEqual(t, { topicKey: '99', topicName: '🐷 Heo' });
});

test('topicTarget: shared group → persona + project suffix', () => {
  const t = topicTarget({ convoId: '99', persona: { emoji: '🐷', name: 'Heo' }, projectCode: 'luni', dedicated: false });
  assert.deepEqual(t, { topicKey: '99', topicName: '🐷 Heo · luni' });
});

// ---- detectForum ---------------------------------------------------------

test('detectForum: is_forum true', async () => {
  const f = await detectForum('tok', '-100', async () => ({ ok: true, result: { is_forum: true, type: 'supergroup' } }));
  assert.equal(f.ok, true);
  assert.equal(f.isForum, true);
  assert.equal(f.type, 'supergroup');
});

test('detectForum: private chat is not a forum', async () => {
  const f = await detectForum('tok', '123', async () => ({ ok: true, result: { is_forum: false, type: 'private' } }));
  assert.equal(f.isForum, false);
});

test('detectForum: fetcher throws → ok:false, isForum:false', async () => {
  const f = await detectForum('tok', '123', async () => { throw new Error('network'); });
  assert.equal(f.ok, false);
  assert.equal(f.isForum, false);
});

test('detectForum: transient (ok:false) is distinguishable from definitive not-forum', async () => {
  // Transient: getChat itself failed → ok:false (caller must NOT treat as misconfig).
  const transient = await detectForum('tok', '1', async () => ({ ok: false, description: 'Too Many Requests' }));
  assert.equal(transient.ok, false);
  assert.equal(transient.isForum, false);
  // Definitive: getChat succeeded but chat is not a forum → ok:true, isForum:false.
  const definitive = await detectForum('tok', '1', async () => ({ ok: true, result: { is_forum: false, type: 'private' } }));
  assert.equal(definitive.ok, true);
  assert.equal(definitive.isForum, false);
});

// ---- forum cache ---------------------------------------------------------

test('isForumCached / cacheForum round-trip (positive-only)', () => {
  const file = tmpTopics();
  assert.equal(isForumCached('-100', file), false);
  cacheForum('-100', file);
  assert.equal(isForumCached('-100', file), true);
  // Unrelated chat stays uncached.
  assert.equal(isForumCached('-200', file), false);
  fs.unlinkSync(file);
});

test('cacheForum preserves existing topic mappings', () => {
  const file = tmpTopics();
  cacheForum('-100', file);
  // Caching forum status must not clobber a convo→thread entry written later.
  const s = readTopicsStore(file);
  s['-100']['999'] = 42;
  writeTopicsStore(s, file);
  cacheForum('-100', file);
  const after = readTopicsStore(file);
  assert.equal(after['-100']._is_forum, true);
  assert.equal(after['-100']['999'], 42);
  fs.unlinkSync(file);
});

// ---- teamModeForumError --------------------------------------------------

test('teamModeForumError mentions chatId and setup steps', () => {
  const msg = teamModeForumError('123');
  assert.match(msg, /123/);
  assert.match(msg, /Topics/);
  assert.match(msg, /Group Privacy/);
});

// ---- resolveThreadId with topicKey/topicName -----------------------------

test('resolveThreadId: team keys cache by topicKey, creates with topicName', async () => {
  const file = tmpTopics();
  let createdName = null;
  const fetcher = async (_t, _c, name) => { createdName = name; return { ok: true, messageThreadId: 777 }; };
  const tid = await resolveThreadId({
    token: 'tok', chatId: '-100', projectCode: 'luni',
    topicKey: '3039138158370420', topicName: '🐷 Heo · luni',
    topicsFile: file, fetcher,
  });
  assert.equal(tid, 777);
  assert.equal(createdName, '🐷 Heo · luni');
  // Cached under the convoId key, not the project name.
  const store = readTopicsStore(file);
  assert.equal(getThreadId(store, '-100', '3039138158370420'), 777);
  assert.equal(getThreadId(store, '-100', 'luni'), null);
  fs.unlinkSync(file);
});

test('resolveThreadId: default mode still keys by projectCode', async () => {
  const file = tmpTopics();
  const fetcher = async () => ({ ok: true, messageThreadId: 5 });
  const tid = await resolveThreadId({ token: 'tok', chatId: '-100', projectCode: 'luni', topicsFile: file, fetcher });
  assert.equal(tid, 5);
  const store = readTopicsStore(file);
  assert.equal(getThreadId(store, '-100', 'luni'), 5);
  fs.unlinkSync(file);
});

test('resolveThreadId: positive cache hit returns without calling fetcher', async () => {
  const file = tmpTopics();
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: true, messageThreadId: 9 }; };
  await resolveThreadId({ token: 't', chatId: '-100', projectCode: 'luni', topicKey: 'k', topicName: 'n', topicsFile: file, fetcher });
  await resolveThreadId({ token: 't', chatId: '-100', projectCode: 'luni', topicKey: 'k', topicName: 'n', topicsFile: file, fetcher });
  assert.equal(calls, 1);
  fs.unlinkSync(file);
});

test('resolveThreadId: forceCreate bypasses the positive cache (topic-gone recovery, S2-M2)', async () => {
  const file = tmpTopics();
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: true, messageThreadId: 100 + calls }; };
  // First resolve caches thread 101.
  const a = await resolveThreadId({ token: 't', chatId: '-100', projectCode: 'luni', topicKey: 'k', topicName: 'n', topicsFile: file, fetcher });
  assert.equal(a, 101);
  // forceCreate must IGNORE the cache and create a fresh topic (102), never reuse 101.
  const b = await resolveThreadId({ token: 't', chatId: '-100', projectCode: 'luni', topicKey: 'k', topicName: 'n', topicsFile: file, fetcher, forceCreate: true });
  assert.equal(b, 102);
  assert.equal(calls, 2);
  fs.unlinkSync(file);
});

// ---- resolveThreadId: transient retry on topic creation ------------------

test('resolveThreadId: transient 504 on create retries once then succeeds + caches', async () => {
  const file = tmpTopics();
  const seq = [
    { ok: false, status: 504, description: 'Gateway Timeout' },
    { ok: true, status: 200, messageThreadId: 555 },
  ];
  let calls = 0;
  const sleeps = [];
  const fetcher = async () => seq[calls++];
  const tid = await resolveThreadId({
    token: 't', chatId: '-100', projectCode: 'luni', topicKey: 'k', topicName: 'n',
    topicsFile: file, fetcher, sleepFn: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(tid, 555);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]); // capped at exactly one retry, fixed 1s backoff
  assert.equal(getThreadId(readTopicsStore(file), '-100', 'k'), 555);
  fs.unlinkSync(file);
});

test('resolveThreadId: network throw on create retries then succeeds', async () => {
  const file = tmpTopics();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNRESET');
    return { ok: true, status: 200, messageThreadId: 42 };
  };
  const tid = await resolveThreadId({
    token: 't', chatId: '-100', projectCode: 'luni', topicKey: 'k', topicName: 'n',
    topicsFile: file, fetcher, sleepFn: noSleep,
  });
  assert.equal(tid, 42);
  assert.equal(calls, 2);
  fs.unlinkSync(file);
});

test('resolveThreadId: persistent 504 → null, no negative cache (next send retries)', async () => {
  const file = tmpTopics();
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: false, status: 504, description: 'Gateway Timeout' }; };
  const tid = await resolveThreadId({
    token: 't', chatId: '-100', projectCode: 'luni', topicKey: 'k', topicName: 'n',
    topicsFile: file, fetcher, sleepFn: noSleep,
  });
  assert.equal(tid, null);
  assert.equal(calls, 2); // 2 attempts (one retry), then give up
  // Transient must NOT poison the cache — a later send re-attempts creation.
  // (Nothing was written at all: no positive thread, no negative marker — so the
  // store file may not even exist. force:true tolerates that.)
  assert.equal(isNoTopicSupportFresh(readTopicsStore(file), '-100'), false);
  fs.rmSync(file, { force: true });
});

test('resolveThreadId: permanent 403 → null + negative cache, single call (no retry)', async () => {
  const file = tmpTopics();
  let calls = 0;
  const sleeps = [];
  const fetcher = async () => { calls++; return { ok: false, status: 403, description: 'not enough rights' }; };
  const tid = await resolveThreadId({
    token: 't', chatId: '-100', projectCode: 'luni', topicKey: 'k', topicName: 'n',
    topicsFile: file, fetcher, sleepFn: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(tid, null);
  assert.equal(calls, 1); // permanent error is NOT transient → no wasted retry
  assert.deepEqual(sleeps, []); // and no wasted backoff sleep on the permanent path
  assert.equal(isNoTopicSupportFresh(readTopicsStore(file), '-100'), true);
  fs.unlinkSync(file);
});
