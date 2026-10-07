// Regression tests for cross-bot update_id contamination (per-bot cache/offset
// isolation + poisoned per-loop offset self-heal).
//
// Background: `update_id` is a per-bot monotonic sequence. A single shared
// updates-cache + global-offset mixes incomparable sequences, so when a bot is
// swapped/added in the same teleport tree the higher sequence poisons the
// lower bot's per-loop offset (advanceLoopOffset writes max(cache)+1) and the
// lower bot then filters out ALL its own messages forever (readCacheSinceOffset
// keeps only update_id >= offset). Real incident: convo offset stuck at
// 667901271 while the bot's own updates were 242503xxx → every message dropped.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveStartOffset,
  readCacheSinceOffset,
  appendToCache,
  readOffset,
  botScopedFiles,
  readCacheStable,
  UPDATES_CACHE_FILE,
  GLOBAL_OFFSET_FILE,
  parseArgs,
} from './tele-listen.mjs';

// RFC 02 P0: `--loop` is the opt-in flag that flips the SUPERSEDE exit 0→3 so a
// persistent `while` wrapper can `break` instead of re-arming. Default off so
// the legacy `until` command (and every running agent) is unchanged.
test('parseArgs: --loop opt-in, default false, orthogonal to other flags', () => {
  assert.equal(parseArgs(['--convo', '1']).loop, false);
  assert.equal(parseArgs(['--convo', '1', '--loop']).loop, true);
  const both = parseArgs(['--convo', '1', '--settle', '--loop']);
  assert.equal(both.settle, true);
  assert.equal(both.loop, true);
  assert.equal(both.convo, '1');
});

let counter = 0;
function tmp(suffix) {
  return path.join(
    os.tmpdir(),
    `offset-iso-${process.pid}-${counter++}-${suffix}`,
  );
}

// Build a fake Telegram update with just enough shape for the cache helpers.
function upd(update_id, threadId = null) {
  return {
    update_id,
    message: {
      message_id: update_id,
      chat: { id: -100123, type: 'supergroup' },
      message_thread_id: threadId,
      text: `m${update_id}`,
    },
  };
}

test('self-heal: poisoned per-loop offset (foreign bot range) resets to min cache', () => {
  const cacheFile = tmp('cache.jsonl');
  const offsetFile = tmp('offset.txt');
  const globalFile = tmp('global.txt');
  // This bot's own updates: 242503130..242503140 (the new bot's range).
  const ids = [];
  for (let i = 242503130; i <= 242503140; i++) ids.push(i);
  appendToCache(ids.map((id) => upd(id)), cacheFile);
  // Offset poisoned by the OLD bot's higher sequence (667901270 + 1).
  fs.writeFileSync(offsetFile, '667901271', 'utf8');

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile);

  // Re-initialized to the oldest cached id so the bot can read its own messages.
  assert.strictEqual(start, 242503130);
  // And the poisoned offset file was rewritten in place.
  assert.strictEqual(readOffset(offsetFile), 242503130);
});

test('self-heal: the original incident — msg 95 becomes deliverable again', () => {
  const cacheFile = tmp('cache.jsonl');
  const offsetFile = tmp('offset.txt');
  const globalFile = tmp('global.txt');
  // Cache holds the new bot's messages incl. msg 95 (update_id 242503139,
  // thread 93) which the live bug dropped.
  const updates = [
    upd(242503138, 93),
    upd(242503139, 93), // <- the lost message
    upd(242503140, null),
  ];
  appendToCache(updates, cacheFile);
  fs.writeFileSync(offsetFile, '667901271', 'utf8'); // poisoned

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile);
  const visible = readCacheSinceOffset(start, cacheFile).map((u) => u.update_id);

  assert.ok(visible.includes(242503139), 'msg 95 must be visible after self-heal');
});

test('no false heal: per-loop offset within the bot range is returned unchanged', () => {
  const cacheFile = tmp('cache.jsonl');
  const offsetFile = tmp('offset.txt');
  const globalFile = tmp('global.txt');
  appendToCache([upd(242503130), upd(242503140)], cacheFile);
  fs.writeFileSync(offsetFile, '242503135', 'utf8');

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile);
  assert.strictEqual(start, 242503135);
});

test('no false heal: caught-up boundary (maxCached + 1) is returned unchanged', () => {
  const cacheFile = tmp('cache.jsonl');
  const offsetFile = tmp('offset.txt');
  const globalFile = tmp('global.txt');
  appendToCache([upd(242503130), upd(242503140)], cacheFile);
  // advanceLoopOffset writes maxCached+1 when caught up — must NOT be treated
  // as poisoned.
  fs.writeFileSync(offsetFile, '242503141', 'utf8');

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile);
  assert.strictEqual(start, 242503141);
});

test('empty bot cache cannot self-heal yet (avoids acting on no information)', () => {
  const cacheFile = tmp('cache.jsonl'); // never written
  const offsetFile = tmp('offset.txt');
  const globalFile = tmp('global.txt');
  fs.writeFileSync(offsetFile, '667901271', 'utf8');

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile);
  // No cache → maxCached is 0 → cannot distinguish poison from a fresh ahead
  // offset; return as-is. Heals on a later poll once the cache is populated.
  assert.strictEqual(start, 667901271);
});

test('per-bot cache isolation: a bot only ever sees its own update_id sequence', () => {
  const botACache = tmp('botA.jsonl');
  const botBCache = tmp('botB.jsonl');
  appendToCache([upd(242503139)], botACache); // new bot
  appendToCache([upd(667901270)], botBCache); // old/other bot

  const aIds = readCacheSinceOffset(0, botACache).map((u) => u.update_id);
  const bIds = readCacheSinceOffset(0, botBCache).map((u) => u.update_id);

  assert.deepStrictEqual(aIds, [242503139]);
  assert.deepStrictEqual(bIds, [667901270]);
  // The advance-offset computation for bot A maxes over ITS file only, so it
  // can never jump into bot B's higher (incomparable) range — the root cause.
  const aMax = aIds.reduce((m, id) => (id > m ? id : m), 0);
  assert.strictEqual(aMax, 242503139);
});

test('botScopedFiles: distinct bots get distinct, botId-suffixed cache+offset files', () => {
  const a = botScopedFiles(1234567890, '/x/tmp');
  const b = botScopedFiles(123456, '/x/tmp');
  assert.strictEqual(a.cacheFile, '/x/tmp/updates-cache.1234567890.jsonl');
  assert.strictEqual(a.globalOffsetFile, '/x/tmp/global-offset.1234567890.txt');
  // The two bots must NOT share any update_id-state file — the whole point of
  // the fix. If main() were reverted to the shared constants this contract
  // would be broken.
  assert.notStrictEqual(a.cacheFile, b.cacheFile);
  assert.notStrictEqual(a.globalOffsetFile, b.globalOffsetFile);
});

test('botScopedFiles: null botId falls back to the shared default files', () => {
  const f = botScopedFiles(null);
  assert.strictEqual(f.cacheFile, UPDATES_CACHE_FILE);
  assert.strictEqual(f.globalOffsetFile, GLOBAL_OFFSET_FILE);
});

test('readCacheStable: torn final line flags tornTail; interior corruption does not', () => {
  const f1 = tmp('torn.jsonl');
  fs.writeFileSync(
    f1,
    JSON.stringify(upd(242503130)) + '\n' + '{"update_id":24250', // truncated tail
    'utf8',
  );
  const r1 = readCacheStable(f1);
  assert.strictEqual(r1.tornTail, true);
  assert.strictEqual(r1.entries.length, 1);

  const f2 = tmp('interior.jsonl');
  fs.writeFileSync(
    f2,
    '{"update_id":BAD\n' + JSON.stringify(upd(242503140)) + '\n', // bad interior line
    'utf8',
  );
  const r2 = readCacheStable(f2);
  assert.strictEqual(r2.tornTail, false, 'interior corruption is not a torn tail');
  assert.strictEqual(r2.entries.length, 1);
});

test('self-heal is deferred on a torn cache tail (no spurious rollback)', () => {
  const cacheFile = tmp('cache.jsonl');
  const offsetFile = tmp('offset.txt');
  const globalFile = tmp('global.txt');
  // Valid entries up to 242503140, then a torn in-flight append as the last line.
  const valid = [upd(242503130), upd(242503140)].map((u) => JSON.stringify(u));
  fs.writeFileSync(cacheFile, valid.join('\n') + '\n' + '{"update_id":2425', 'utf8');
  fs.writeFileSync(offsetFile, '667901271', 'utf8'); // looks poisoned

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile);
  // Torn tail → do NOT heal this poll; preserve the offset and retry next poll.
  assert.strictEqual(start, 667901271);
});

test('readCacheSinceOffset dedups duplicate appends by update_id (co-op cache safety)', () => {
  const cacheFile = tmp('dedup-cache.jsonl');
  // Simulate several pollers re-appending the SAME batch (the bug that made a
  // prompt repeat an attributed line N times): update 100 appended 5×, 101 3×.
  appendToCache([upd(100), upd(101)], cacheFile);
  appendToCache([upd(100), upd(101)], cacheFile);
  appendToCache([upd(100)], cacheFile);
  appendToCache([upd(100)], cacheFile);
  appendToCache([upd(100), upd(101), upd(102)], cacheFile);
  const out = readCacheSinceOffset(0, cacheFile);
  assert.deepStrictEqual(out.map((u) => u.update_id), [100, 101, 102]); // unique, file order
});
