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
} from './send-telegram.mjs';
import { readTopicsStore, getThreadId } from './topics-store.mjs';

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
