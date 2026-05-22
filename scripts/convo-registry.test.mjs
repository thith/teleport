import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock, appendRowLocked, buildConvoFilter, CONVO_ID_RE,
  CONVO_SCHEMA_VERSION, hasAllocationRow, lookupConvoIdByMessageId,
  pruneLocked, readRows, releaseLock, REGISTRY_CAP, REGISTRY_KEEP_NON_ALLOC,
  resolveConvoIdFromEnv, uuidToConvoInt, validateConvoIdString,
} from './convo-registry.mjs';
import { appendToSentRegistry, parseArgs as parseSendArgs, readSentRegistry } from './send-telegram.mjs';
import { parseArgs as parseListenArgs, compareSameConvo, filterAdminMessages, resolveStartOffset } from './tele-listen.mjs';

function tmpFile() {
  return path.join(os.tmpdir(), `convo-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}
function tmpLock() {
  return path.join(os.tmpdir(), `convo-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
}

test('validateConvoIdString', () => {
  assert.strictEqual(validateConvoIdString('123'), 123);
  assert.throws(() => validateConvoIdString('0'));
  assert.throws(() => validateConvoIdString('abc'));
  assert.throws(() => validateConvoIdString('12/etc'));
  assert.throws(() => validateConvoIdString(''));
  assert.throws(() => validateConvoIdString('-1'));
  // Real Telegram messageIds are nowhere near 2^53; rejecting unsafe-integer
  // ranges keeps lookups exact.
  assert.throws(() => validateConvoIdString('9007199254740993'));
});

test('CONVO_ID_RE', () => {
  assert.ok(CONVO_ID_RE.test('1'));
  assert.ok(CONVO_ID_RE.test('9007199254740991')); // 2^53-1
  assert.ok(!CONVO_ID_RE.test('12345678901234567890')); // 20 digits = too big
  assert.ok(!CONVO_ID_RE.test('0'));
  assert.ok(!CONVO_ID_RE.test(''));
});

test('buildConvoFilter — happy path', () => {
  const rows = [
    { v: 1, convoId: 100, messageId: 100, chatId: 'A', botId: 1, ts: 1 },
    { v: 1, convoId: 100, messageId: 101, chatId: 'A', botId: 1, ts: 2 },
    { v: 1, convoId: 100, messageId: 102, chatId: 'B', botId: 1, ts: 3 }, // wrong chat
    { v: 1, convoId: 200, messageId: 103, chatId: 'A', botId: 1, ts: 4 }, // wrong convo
    { v: 1, convoId: 100, messageId: 104, chatId: 'A', botId: 2, ts: 5 }, // wrong bot
  ];
  const set = buildConvoFilter(rows, 100, 1, ['A']);
  assert.deepStrictEqual([...set].sort(), ['A:100', 'A:101']);
});

test('buildConvoFilter — skips rows with v > KNOWN_V (forward compat)', () => {
  const rows = [
    { v: 1, convoId: 100, messageId: 100, chatId: 'A', botId: 1 },
    { v: 2, convoId: 100, messageId: 101, chatId: 'A', botId: 1 }, // future schema
  ];
  const set = buildConvoFilter(rows, 100, 1, ['A']);
  assert.deepStrictEqual([...set], ['A:100']);
});

test('uuidToConvoInt — UUID → safe positive integer; rejects junk', () => {
  const n = uuidToConvoInt('d0f29b89-3400-4ecf-8d92-0e49f466db4f');
  assert.ok(Number.isSafeInteger(n) && n > 0);
  // Same input → same output (deterministic).
  assert.strictEqual(n, uuidToConvoInt('d0f29b89-3400-4ecf-8d92-0e49f466db4f'));
  assert.strictEqual(uuidToConvoInt(''), null);
  assert.strictEqual(uuidToConvoInt('not-hex-zzzzz'), null);
  assert.strictEqual(uuidToConvoInt('abc'), null); // too short
  assert.strictEqual(uuidToConvoInt(null), null);
});

test('resolveConvoIdFromEnv — env wins over --convo; --convo only effective without env', () => {
  // 1. Claude env wins over Codex AND --convo (env more reliable than asking
  // the agent to remember an integer).
  const r1 = resolveConvoIdFromEnv({ argConvo: 999, env: {
    CLAUDE_CODE_SESSION_ID: 'd0f29b89-3400-4ecf-8d92-0e49f466db4f',
    CODEX_THREAD_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  } });
  assert.strictEqual(r1.source, 'CLAUDE_CODE_SESSION_ID');
  assert.ok(Number.isSafeInteger(r1.convoId) && r1.convoId > 0);

  // 2. Codex env wins over --convo.
  const r2 = resolveConvoIdFromEnv({ argConvo: 999, env: {
    CODEX_THREAD_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  } });
  assert.strictEqual(r2.source, 'CODEX_THREAD_ID');

  // 3. No env → --convo effective (Gemini path).
  const r3 = resolveConvoIdFromEnv({ argConvo: 777, env: {} });
  assert.strictEqual(r3.source, '--convo');
  assert.strictEqual(r3.convoId, 777);

  // 4. Nothing set → null.
  const r4 = resolveConvoIdFromEnv({ argConvo: null, env: {} });
  assert.strictEqual(r4.convoId, null);
  assert.strictEqual(r4.source, null);

  // 5. Bad native env (unparseable) → warn + fall through (do NOT block send).
  const origErr = console.error;
  let warned = '';
  console.error = (msg) => { warned += String(msg); };
  try {
    // No arg, unparseable env → warn + null (caller may fall back).
    const r5 = resolveConvoIdFromEnv({ argConvo: null, env: { CLAUDE_CODE_SESSION_ID: 'short' } });
    assert.strictEqual(r5.convoId, null);
    assert.match(warned, /CLAUDE_CODE_SESSION_ID/);
  } finally { console.error = origErr; }
});

test('appendToSentRegistry — persists convoId when provided', () => {
  const file = tmpFile();
  appendToSentRegistry({ messageId: 5, chatId: 'X', botId: 9, convoId: 12345, registryFile: file });
  appendToSentRegistry({ messageId: 6, chatId: 'X', botId: 9, registryFile: file }); // no convoId
  const rows = readSentRegistry(file);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].convoId, 12345);
  assert.strictEqual(rows[0].messageId, 5);
  assert.strictEqual(rows[1].convoId, undefined);
  fs.unlinkSync(file);
});

test('lookupConvoIdByMessageId — tie-break: positive-ts later wins, zero-ts first wins', () => {
  // Positive ts: later (higher) wins.
  const a = [
    { v: 1, convoId: 1, messageId: 50, chatId: 'A', botId: 1, ts: 100 },
    { v: 1, convoId: 2, messageId: 50, chatId: 'A', botId: 1, ts: 200 },
    { v: 1, convoId: 3, messageId: 50, chatId: 'A', botId: 1, ts: 200 }, // positive tie
  ];
  assert.strictEqual(lookupConvoIdByMessageId(a, 1, 'A', 50), 3); // later positive-tie wins

  // All-zero ts: first scanned wins (file order stable post-prune is not, so we want determinism).
  const b = [
    { v: 1, convoId: 10, messageId: 60, chatId: 'A', botId: 1, ts: 0 },
    { v: 1, convoId: 20, messageId: 60, chatId: 'A', botId: 1, ts: 0 },
  ];
  assert.strictEqual(lookupConvoIdByMessageId(b, 1, 'A', 60), 10);

  // Mixed: positive beats zero.
  const c = [
    { v: 1, convoId: 100, messageId: 70, chatId: 'A', botId: 1, ts: 0 },
    { v: 1, convoId: 200, messageId: 70, chatId: 'A', botId: 1, ts: 50 },
  ];
  assert.strictEqual(lookupConvoIdByMessageId(c, 1, 'A', 70), 200);
});

test('lookupConvoIdByMessageId — finds convo, ignores wrong bot/chat', () => {
  const rows = [
    { v: 1, convoId: 100, messageId: 100, chatId: 'A', botId: 1, ts: 1 },
    { v: 1, convoId: 100, messageId: 101, chatId: 'A', botId: 1, ts: 2 },
    { v: 1, convoId: 200, messageId: 200, chatId: 'A', botId: 1, ts: 3 },
    { v: 1, convoId: 300, messageId: 101, chatId: 'B', botId: 1, ts: 4 }, // diff chat, same msgId
  ];
  assert.strictEqual(lookupConvoIdByMessageId(rows, 1, 'A', 101), 100);
  assert.strictEqual(lookupConvoIdByMessageId(rows, 1, 'B', 101), 300);
  assert.strictEqual(lookupConvoIdByMessageId(rows, 1, 'A', 999), null);
  assert.strictEqual(lookupConvoIdByMessageId(rows, 2, 'A', 101), null); // diff bot
});

test('hasAllocationRow', () => {
  const rows = [
    { v: 1, convoId: 100, messageId: 100, chatId: 'A', botId: 1 }, // allocation
    { v: 1, convoId: 100, messageId: 101, chatId: 'A', botId: 1 },
  ];
  assert.ok(hasAllocationRow(rows, 100, 1, 'A'));
  assert.ok(!hasAllocationRow(rows, 100, 1, 'B'));
  assert.ok(!hasAllocationRow(rows, 100, 2, 'A'));
  assert.ok(!hasAllocationRow(rows, 999, 1, 'A'));
});

test('append + read round-trip', async () => {
  const file = tmpFile();
  const lock = tmpLock();
  const acquired = await acquireLock(lock);
  assert.ok(acquired);
  try {
    appendRowLocked({ v: 1, convoId: 5, messageId: 5, chatId: 'X', botId: 9, ts: 1 }, file);
    appendRowLocked({ v: 1, convoId: 5, messageId: 6, chatId: 'X', botId: 9, ts: 2 }, file);
  } finally {
    releaseLock(lock);
  }
  const { rows, malformed } = readRows(file);
  assert.strictEqual(malformed, 0);
  assert.strictEqual(rows.length, 2);
  fs.unlinkSync(file);
});

test('readRows — malformed line counted, partial trailing line tolerated', () => {
  const file = tmpFile();
  // valid + garbage + valid + partial (no newline)
  fs.writeFileSync(file,
    JSON.stringify({ v: 1, convoId: 1, messageId: 1, chatId: 'A', botId: 1 }) + '\n' +
    '{not json' + '\n' +
    JSON.stringify({ v: 1, convoId: 1, messageId: 2, chatId: 'A', botId: 1 }) + '\n' +
    '{"v":1,"convoId":1,"message', // partial, no \n
  );
  const { rows, malformed } = readRows(file);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(malformed, 1); // garbage line; partial tail NOT counted
  fs.unlinkSync(file);
});

test('compareSameConvo — newer startedAt wins, lower pid tiebreak', () => {
  const a = { pid: 100, startedAt: 1000 };
  const b = { pid: 200, startedAt: 2000 };
  assert.ok(compareSameConvo(b, a) > 0); // b wins by startedAt
  const c = { pid: 100, startedAt: 1000 };
  const d = { pid: 200, startedAt: 1000 };
  assert.ok(compareSameConvo(c, d) > 0); // c wins by lower pid
});

test('parseArgs (tele-listen) — --convo + --filter-reply-to mutually exclusive', () => {
  assert.throws(() => parseListenArgs(['--convo', '100', '--filter-reply-to', '5']));
});

test('parseArgs (tele-listen) — --convo validation', () => {
  assert.throws(() => parseListenArgs(['--convo', '0']));
  assert.throws(() => parseListenArgs(['--convo', 'abc']));
  assert.throws(() => parseListenArgs(['--convo', '12/etc']));
  const ok = parseListenArgs(['--convo', '100']);
  assert.strictEqual(ok.convo, 100);
});

test('parseArgs (send-telegram) — --convo accepts a positive integer', () => {
  const a = parseSendArgs(['--convo', '5', 'hi']);
  assert.strictEqual(a.convo, 5);
  assert.throws(() => parseSendArgs(['--convo', 'new', 'hi']));
});

test('filterAdminMessages — convo mode uses (chatId, messageId) pair', () => {
  const updates = [
    // reply target msg 100 in chat A: should match
    { message: { text: 'a', chat: { id: 'A', type: 'private' }, reply_to_message: { message_id: 100 } } },
    // reply target msg 100 in chat B: should NOT match (cross-chat collision)
    { message: { text: 'b', chat: { id: 'B', type: 'private' }, reply_to_message: { message_id: 100 } } },
  ];
  const filter = new Set(['A:100']);
  const matched = filterAdminMessages(updates, [], filter, 'convo');
  assert.strictEqual(matched.length, 1);
  assert.strictEqual(matched[0].msg.chat.id, 'A');
});

test('filterAdminMessages — legacy mode matches by messageId only', () => {
  const updates = [
    { message: { text: 'a', chat: { id: 'A', type: 'private' }, reply_to_message: { message_id: 100 } } },
    { message: { text: 'b', chat: { id: 'B', type: 'private' }, reply_to_message: { message_id: 100 } } },
  ];
  const matched = filterAdminMessages(updates, [], 100, 'legacy');
  assert.strictEqual(matched.length, 2); // both match in legacy mode
});

test('resolveStartOffset — convo listener can replay cached replies fetched by another loop', () => {
  const offsetFile = tmpFile();
  const globalFile = tmpFile();
  const cacheFile = tmpFile();
  fs.writeFileSync(globalFile, '200', 'utf8');
  fs.writeFileSync(cacheFile, [
    JSON.stringify({ update_id: 100, message: { text: 'late cached reply' } }),
    JSON.stringify({ update_id: 220, message: { text: 'newer reply' } }),
  ].join('\n') + '\n', 'utf8');

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile, 0);

  assert.strictEqual(start, 100);
  assert.strictEqual(fs.readFileSync(offsetFile, 'utf8'), '100');
  fs.unlinkSync(offsetFile);
  fs.unlinkSync(globalFile);
  fs.unlinkSync(cacheFile);
});

test('resolveStartOffset — explicit seedFloor still prevents pre-allocation replay', () => {
  const offsetFile = tmpFile();
  const globalFile = tmpFile();
  const cacheFile = tmpFile();
  fs.writeFileSync(globalFile, '200', 'utf8');
  fs.writeFileSync(cacheFile, [
    JSON.stringify({ update_id: 100, message: { text: 'old cached reply' } }),
    JSON.stringify({ update_id: 220, message: { text: 'newer reply' } }),
  ].join('\n') + '\n', 'utf8');

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile, 200);

  assert.strictEqual(start, 200);
  assert.strictEqual(fs.readFileSync(offsetFile, 'utf8'), '200');
  fs.unlinkSync(offsetFile);
  fs.unlinkSync(globalFile);
  fs.unlinkSync(cacheFile);
});

test('pruneLocked — preserves allocation rows + newest non-allocation rows', async () => {
  const file = tmpFile();
  const lock = tmpLock();
  const acquired = await acquireLock(lock);
  try {
    // Allocation row for convo 1 (very old)
    appendRowLocked({ v: 1, convoId: 1, messageId: 1, chatId: 'A', botId: 9, ts: 0 }, file);
    // Many non-allocation rows
    for (let i = 2; i < REGISTRY_CAP + 100; i++) {
      appendRowLocked({ v: 1, convoId: 1, messageId: i, chatId: 'A', botId: 9, ts: i }, file);
    }
  } finally {
    releaseLock(lock);
  }
  const acquired2 = await acquireLock(lock);
  try { pruneLocked(file); } finally { releaseLock(lock); }
  const { rows } = readRows(file);
  // Allocation row must survive
  assert.ok(hasAllocationRow(rows, 1, 9, 'A'), 'allocation row preserved');
  // Total ~= 1 (alloc) + REGISTRY_KEEP_NON_ALLOC (newest)
  assert.ok(rows.length <= 1 + REGISTRY_KEEP_NON_ALLOC + 1, `expected <=${1+REGISTRY_KEEP_NON_ALLOC+1}, got ${rows.length}`);
  fs.unlinkSync(file);
});

test('pruneLocked — preserves unknown-v rows byte-for-byte', async () => {
  const file = tmpFile();
  const lock = tmpLock();
  const acquired = await acquireLock(lock);
  try {
    // Allocation row
    appendRowLocked({ v: 1, convoId: 7, messageId: 7, chatId: 'A', botId: 1, ts: 0 }, file);
    // Unknown future-schema row (should be preserved)
    appendRowLocked({ v: 99, convoId: 7, messageId: 8, chatId: 'A', botId: 1, ts: 1, futureField: 'preserved' }, file);
    // Many non-allocation rows to trigger prune
    for (let i = 9; i < REGISTRY_CAP + 200; i++) {
      appendRowLocked({ v: 1, convoId: 7, messageId: i, chatId: 'A', botId: 1, ts: i }, file);
    }
  } finally {
    releaseLock(lock);
  }
  const acquired2 = await acquireLock(lock);
  try { pruneLocked(file); } finally { releaseLock(lock); }
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('"futureField":"preserved"'), 'unknown-v row preserved through prune');
  fs.unlinkSync(file);
});
