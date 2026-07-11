import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  acquireLock, appendRowLocked, buildConvoFilter, CONVO_ID_RE,
  CONVO_SCHEMA_VERSION, hasAllocationRow, lookupConvoIdByMessageId,
  pruneLocked, readRows, releaseLock, REGISTRY_CAP, REGISTRY_KEEP_NON_ALLOC,
  resolveConvoIdFromEnv, uuidToConvoInt, validateConvoIdString,
} from './convo-registry.mjs';
import { appendToSentRegistry, escapeMarkdownV2, injectConvoHash, listenerHintForCurrentAgent, parseArgs as parseSendArgs, previewLineWithHashtag, readSentRegistry, shortConvoHash } from './send-telegram.mjs';
import { parseArgs as parseListenArgs, compareSameConvo, filterAdminMessages, findOrphanMessages, resolveStartOffset, waitOnceSupervisor } from './tele-listen.mjs';

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

test('parseArgs (tele-listen) — --wait-once is convo-mode only', () => {
  const ok = parseListenArgs(['--wait-once', '--convo', '100']);
  assert.strictEqual(ok.waitOnce, true);
  assert.strictEqual(ok.watch, false);
  assert.strictEqual(ok.convo, 100);
  assert.strictEqual(ok.filterReplyTo, null);
  assert.strictEqual(ok.offsetFileProvided, false);
  assert.throws(() => parseListenArgs(['--wait-once', '--filter-reply-to', '5']));
  assert.throws(() => parseListenArgs(['--wait-once', '--watch', '--convo', '100']));
});

test('parseArgs (tele-listen) — legacy --watch remains parseable', () => {
  const ok = parseListenArgs(['--watch', '--convo', '100']);
  assert.strictEqual(ok.watch, true);
  assert.strictEqual(ok.waitOnce, false);
  assert.strictEqual(ok.convo, 100);
});

test('parseArgs (tele-listen) — --settle opt-in (default off; combines with listen modes + bare drain)', () => {
  assert.strictEqual(parseListenArgs(['--convo', '100']).settle, false);            // bare drain: no settle
  assert.strictEqual(parseListenArgs(['--convo', '100', '--settle']).settle, true); // child of a listen loop
  assert.strictEqual(parseListenArgs(['--wait-once', '--convo', '100', '--settle']).settle, true);
  const watch = parseListenArgs(['--watch', '--convo', '100', '--settle']);
  assert.strictEqual(watch.settle, true);
  assert.strictEqual(watch.watch, true);
});

test('parseArgs (send-telegram) — --convo accepts a positive integer', () => {
  const a = parseSendArgs(['--convo', '5', 'hi']);
  assert.strictEqual(a.convo, 5);
  assert.throws(() => parseSendArgs(['--convo', 'new', 'hi']));
});

test('injectConvoHash — emoji prefix + convoId produces clickable hashtag', () => {
  const out = injectConvoHash('🦊 *Claude on topic:*\n\n✅ done', 'tea_game', 12345);
  assert.strictEqual(out, '[tea_game] [🦊 #t12345] *Claude on topic:*\n\n✅ done');
});

test('injectConvoHash — no emoji prefix falls back to [#c<id>] prefix', () => {
  const out = injectConvoHash('Plain text update', 'tea_game', 999);
  assert.strictEqual(out, '[tea_game] [#t999] Plain text update');
});

test('injectConvoHash — null convoId keeps legacy [Project] prefix (no hashtag)', () => {
  const out = injectConvoHash('🦊 *Claude on topic:*', 'tea_game', null);
  assert.strictEqual(out, '[tea_game] 🦊 *Claude on topic:*');
});

test('injectConvoHash — missing projectCode emits bare [<emoji> #c<id>] tag', () => {
  const out = injectConvoHash('🦊 *topic*', '', 42);
  assert.strictEqual(out, '[🦊 #t42] *topic*');
});

test('injectConvoHash — null message returns null', () => {
  assert.strictEqual(injectConvoHash(null, 'tea_game', 1), null);
});

test('injectConvoHash — empty message + no convoId stays empty (legacy)', () => {
  assert.strictEqual(injectConvoHash('', 'tea_game', null), '');
});

test('injectConvoHash — empty message + convoId emits hashtag prefix only (no trailing space)', () => {
  // Document send with no caption still needs the hashtag so admins can filter.
  // No trailing space so the caption is clean.
  const out = injectConvoHash('', 'tea_game', 42);
  assert.strictEqual(out, '[tea_game] [#t42]');
});

test('injectConvoHash — empty message + convoId + no projectCode emits bare hashtag', () => {
  const out = injectConvoHash('', '', 42);
  assert.strictEqual(out, '[#t42]');
});

test('parseArgs (send-telegram) — --raw and --plain are mutually exclusive', () => {
  assert.throws(() => parseSendArgs(['--raw', '--plain', 'hi']));
});

test('parseArgs (send-telegram) — --close-topic flag parses (default false)', () => {
  assert.strictEqual(parseSendArgs(['hi']).closeTopic, false);
  const a = parseSendArgs(['--close-topic', '--convo', '7']);
  assert.strictEqual(a.closeTopic, true);
  assert.strictEqual(a.convo, 7);
});

test('injectConvoHash + escapeMarkdownV2 — hashtag survives escape pipeline', () => {
  // Non-raw mode: injectConvoHash returns unescaped prefix, then upstream
  // escapeMarkdownV2 escapes everything including `#`. Telegram's entity scanner
  // runs on RENDERED text (after backslash unescape), so `\#t42` source still
  // renders as `#c42` and is detected as a clickable hashtag.
  // This test locks in the expected escape format so a future regression in
  // escapeMarkdownV2 logic gets caught.
  const injected = injectConvoHash('🦊 *topic*', 'tea_game', 42);
  const escaped = escapeMarkdownV2(injected);
  // tea_game is treated as text token; `_` only escapes when unbalanced (it
  // appears once = unbalanced, gets escaped). brackets and `#` always escape.
  assert.match(escaped, /\\\[tea[_\\_]+game\\\]/); // [tea_game] form
  assert.match(escaped, /\\\[🦊 \\#t42\\\]/);     // [🦊 #t42] form with escaped # and brackets
  // The `*topic*` markdown bold survives (balanced *).
  assert.match(escaped, /\*topic\*/);
});

test('shortConvoHash — long id (≥8) takes last 8, encodes first digit as letter (0→a..9→j)', () => {
  // last 8 of '2205483045424020' = '45424020', first '4' → 'e'
  assert.strictEqual(shortConvoHash('2205483045424020'), 'e5424020');
  // boundary: exactly 8 chars, first '1' → 'b'
  assert.strictEqual(shortConvoHash('12345678'), 'b2345678');
  // digit 0 → 'a'
  assert.strictEqual(shortConvoHash('01234567'), 'a1234567');
  // digit 9 → 'j'
  assert.strictEqual(shortConvoHash('91234567'), 'j1234567');
});

test('shortConvoHash — short id (<8) prepends literal t', () => {
  assert.strictEqual(shortConvoHash(1234), 't1234'); // 4 chars (Gemini case)
  assert.strictEqual(shortConvoHash('1234567'), 't1234567'); // 7 chars (boundary)
  assert.strictEqual(shortConvoHash('1'), 't1');
});

test('previewLineWithHashtag — short line returned as-is', () => {
  assert.strictEqual(previewLineWithHashtag('[p] [🦊 #t123] short'), '[p] [🦊 #t123] short');
});

test('previewLineWithHashtag — long line keeps hashtag at tail', () => {
  // Construct a first line where hashtag would normally be cut by slice(0, 100)
  const longProject = 'a'.repeat(80);
  const line = `[${longProject}] [🦊 #t1234567] message body text follows here lots of words to push past limit`;
  const out = previewLineWithHashtag(line);
  assert.ok(out.length <= 100);
  assert.match(out, /#t1234567$/);
});

test('previewLineWithHashtag — long line with NO hashtag falls back to plain truncation', () => {
  const longLine = 'a'.repeat(200);
  const out = previewLineWithHashtag(longLine);
  assert.strictEqual(out.length, 100);
  assert.strictEqual(out, 'a'.repeat(100));
});

test('injectConvoHash — projectCode with newline is stripped to single line', () => {
  // POSIX allows newlines in directory names; basename(cwd) could in principle
  // contain \n. Our `[Project]` prefix must stay on line 1.
  const out = injectConvoHash('text', 'bad\nname', 1);
  assert.strictEqual(out, '[badname] [#t1] text');
});

test('injectConvoHash — multiple leading emojis pulled into tag together', () => {
  const out = injectConvoHash('🦊🚀 *update*', 'p', 7);
  assert.strictEqual(out, '[p] [🦊🚀 #t7] *update*');
});

test('injectConvoHash — long convoId is truncated to last 7 chars (Claude/Codex env hash case)', () => {
  // Claude/Codex env-derived convoIds are 16-digit ints (uuidToConvoInt).
  // Hashtag display truncates to last 7 digits so message stays readable.
  const out = injectConvoHash('🦊 *topic*', 'p', '2205483045424020');
  assert.strictEqual(out, '[p] [🦊 #e5424020] *topic*');
});

test('injectConvoHash — short convoId (≤ 7 chars) keeps full id (Gemini case)', () => {
  // Gemini's convoId is 4 chars — no truncation needed.
  const out = injectConvoHash('🦊 *topic*', 'p', 1234);
  assert.strictEqual(out, '[p] [🦊 #t1234] *topic*');
});

test('injectConvoHash — exactly 7-char convoId keeps full id (boundary)', () => {
  const out = injectConvoHash('🦊 *topic*', 'p', '1234567');
  assert.strictEqual(out, '[p] [🦊 #t1234567] *topic*');
});

test('injectConvoHash — skin-tone modifier on emoji', () => {
  // 👨🏽‍💻 = man + skin tone + ZWJ + laptop
  const out = injectConvoHash('👨🏽‍💻 *topic*', 'p', 1);
  assert.strictEqual(out, '[p] [👨🏽‍💻 #t1] *topic*');
});

test('injectConvoHash — country flag (regional indicator pair)', () => {
  // 🇻🇳 = two regional indicators (V + N)
  const out = injectConvoHash('🇻🇳 *topic*', 'p', 1);
  assert.strictEqual(out, '[p] [🇻🇳 #t1] *topic*');
});

test('injectConvoHash — keycap sequence', () => {
  // 1️⃣ = digit 1 + VS-16 + COMBINING ENCLOSING KEYCAP
  const out = injectConvoHash('1️⃣ *topic*', 'p', 1);
  assert.strictEqual(out, '[p] [1️⃣ #t1] *topic*');
});

test('injectConvoHash — raw mode escapes injected [, ], # for MarkdownV2', () => {
  const out = injectConvoHash('🦊 \\*pre\\-escaped\\*', 'tea_game', 42, { pretokensEscaped: true });
  // Brackets and # in our injected prefix must be MdV2-escaped so Telegram parser accepts.
  // tea_game has no special chars; pure underscore "_" is not special in MdV2 strictly
  // but our escape regex includes it for safety because MdV2 spec mandates escape.
  assert.strictEqual(out, '\\[tea\\_game\\] \\[🦊 \\#t42\\] \\*pre\\-escaped\\*');
});

test('injectConvoHash — raw mode escapes ALL 18 MdV2 special chars in projectCode', () => {
  // projectCode contains chars that MdV2 considers special: `.`, `-`
  const out = injectConvoHash('text', 'my.app-v2', 1, { pretokensEscaped: true });
  assert.strictEqual(out, '\\[my\\.app\\-v2\\] \\[\\#t1\\] text');
});

test('injectConvoHash — raw mode + emoji combination', () => {
  const out = injectConvoHash('🦊🚀 \\*topic\\*', 'p', 5, { pretokensEscaped: true });
  assert.strictEqual(out, '\\[p\\] \\[🦊🚀 \\#t5\\] \\*topic\\*');
});

test('injectConvoHash — emoji directly followed by markdown asterisk (no space)', () => {
  // User types `🦊*bold*` with no space — regex should still extract emoji.
  const out = injectConvoHash('🦊*bold*', 'p', 1);
  assert.strictEqual(out, '[p] [🦊 #t1] *bold*');
});

test('injectConvoHash — non-raw mode keeps injected prefix unescaped (escaped later by escapeMarkdownV2)', () => {
  const out = injectConvoHash('🦊 *topic*', 'tea_game', 42);
  assert.strictEqual(out, '[tea_game] [🦊 #t42] *topic*');
});

test('listenerHintForCurrentAgent — non-Claude agents use wait-once', () => {
  const codex = listenerHintForCurrentAgent(123, { CODEX_THREAD_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.match(codex, /--wait-once --convo 123/);
  assert.doesNotMatch(codex, /--watch/);

  const other = listenerHintForCurrentAgent(123, {});
  assert.match(other, /--wait-once --convo 123/);
  assert.doesNotMatch(other, /--watch/);
});

test('listenerHintForCurrentAgent — Claude uses Monitor', () => {
  const hint = listenerHintForCurrentAgent(123, { CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.match(hint, /Monitor/);
  assert.match(hint, /tele-listen\.mjs --convo 123/);
  assert.doesNotMatch(hint, /--wait-once/);
});

test('findOrphanMessages — phantom topic-creation reply is treated as orphan (not user reply)', () => {
  // Telegram sets reply_to_message → topic creation event for EVERY message in
  // a topic. We must not let that phantom suppress orphan classification.
  const updates = [{
    update_id: 1,
    message: {
      message_id: 100,
      chat: { id: 144242180, type: 'private' },
      text: 'Tôi gõ trong topic không reply',
      message_thread_id: 1915267,
      is_topic_message: true,
      reply_to_message: {
        message_id: 99,
        chat: { id: 144242180, type: 'private' },
        forum_topic_created: { name: 'tea_game', icon_color: 7322096 },
        is_topic_message: true,
      },
    },
  }];
  const orphans = findOrphanMessages(updates, ['144242180'], new Set());
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].msg.message_id, 100);
});

test('findOrphanMessages — real user reply (non-phantom) is NOT orphan', () => {
  // Sanity check: regular reply still suppresses orphan classification.
  const updates = [{
    update_id: 2,
    message: {
      message_id: 200,
      chat: { id: 144242180, type: 'private' },
      text: 'reply text',
      reply_to_message: {
        message_id: 150,
        // no forum_topic_created — this is a real user reply target
      },
    },
  }];
  const orphans = findOrphanMessages(updates, ['144242180'], new Set());
  assert.strictEqual(orphans.length, 0);
});

test('filterAdminMessages — convo mode without a thread map matches nothing (no reply-to leak)', () => {
  // RFC 01 single-mode: convo routing is by forum thread (threadByChat), NOT
  // reply-to. With no thread map, convo mode must match NOTHING rather than fall
  // back to reply-to — else a reply to an old bot message in General/a foreign
  // topic would leak into the convo (review C-Maj1).
  const updates = [
    { message: { text: 'a', chat: { id: 'A', type: 'private' }, reply_to_message: { message_id: 100 } } },
  ];
  const filter = new Set(['A:100']);
  const matched = filterAdminMessages(updates, [], filter, 'convo');
  assert.strictEqual(matched.length, 0);
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

  const start = resolveStartOffset(offsetFile, globalFile, cacheFile);

  assert.strictEqual(start, 100);
  assert.strictEqual(fs.readFileSync(offsetFile, 'utf8'), '100');
  fs.unlinkSync(offsetFile);
  fs.unlinkSync(globalFile);
  fs.unlinkSync(cacheFile);
});

test('waitOnceSupervisor — child exit 0 without prompt continues polling', async () => {
  const exits = [];
  const errors = [];
  let spawnCount = 0;
  let promptExists = false;
  const spawn = () => {
    spawnCount += 1;
    const child = new EventEmitter();
    // Defer until waitOnceSupervisor registers the child's exit handler.
    queueMicrotask(() => {
      if (spawnCount === 2) promptExists = true;
      child.emit('exit', 0);
    });
    return child;
  };

  await waitOnceSupervisor(['--wait-once', '--convo', '100'], {
    spawn,
    acquireLock: async () => '/tmp/nonexistent-wait-once.lock',
    exists: () => promptExists,
    sleep: async () => {},
    log: () => {},
    error: (msg) => errors.push(String(msg)),
    exit: (code) => { exits.push(code); },
  });

  assert.strictEqual(spawnCount, 2);
  assert.deepStrictEqual(exits, [0]);
  assert.match(errors.join('\n'), /child exited 0 but prompt was missing/);
});

test('waitOnceSupervisor — child uses stable offset file across invocations', async () => {
  const seenArgs = [];
  const spawn = (_node, args) => {
    seenArgs.push(args);
    const child = new EventEmitter();
    // Defer until waitOnceSupervisor registers the child's exit handler.
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };

  await waitOnceSupervisor(['--wait-once', '--convo', '100'], {
    spawn,
    acquireLock: async () => '/tmp/nonexistent-wait-once.lock',
    exists: () => seenArgs.length > 0,
    sleep: async () => {},
    log: () => {},
    error: () => {},
    exit: () => {},
  });
  await waitOnceSupervisor(['--wait-once', '--convo', '100'], {
    spawn,
    acquireLock: async () => '/tmp/nonexistent-wait-once.lock',
    exists: () => seenArgs.length > 1,
    sleep: async () => {},
    log: () => {},
    error: () => {},
    exit: () => {},
  });

  const offsetA = seenArgs[0][seenArgs[0].indexOf('--offset-file') + 1];
  const offsetB = seenArgs[1][seenArgs[1].indexOf('--offset-file') + 1];
  assert.ok(offsetA.endsWith('convo-100-wait-once-offset.txt'));
  assert.strictEqual(offsetA, offsetB);
});

test('waitOnceSupervisor — preserves explicit offset file', async () => {
  let seenArgs = null;
  await waitOnceSupervisor(['--wait-once', '--convo', '100', '--offset-file', '/tmp/custom-offset.txt'], {
    acquireLock: async () => '/tmp/nonexistent-wait-once.lock',
    spawn: (_node, args) => {
      seenArgs = args;
      const child = new EventEmitter();
      // Defer until waitOnceSupervisor registers the child's exit handler.
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
    exists: () => seenArgs != null,
    sleep: async () => {},
    log: () => {},
    error: () => {},
    exit: () => {},
  });

  assert.strictEqual(seenArgs[seenArgs.indexOf('--offset-file') + 1], '/tmp/custom-offset.txt');
});

test('waitOnceSupervisor — waits for singleton lock before spawning child', async () => {
  let lockAttempts = 0;
  let spawnCount = 0;
  await waitOnceSupervisor(['--wait-once', '--convo', '100'], {
    acquireLock: async () => {
      lockAttempts += 1;
      return lockAttempts === 1 ? null : '/tmp/nonexistent-wait-once.lock';
    },
    spawn: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      // Defer until waitOnceSupervisor registers the child's exit handler.
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
    exists: () => spawnCount > 0,
    sleep: async () => {},
    log: () => {},
    error: () => {},
    exit: () => {},
  });

  assert.strictEqual(lockAttempts, 2);
  assert.strictEqual(spawnCount, 1);
});

test('waitOnceSupervisor — exits after repeated singleton lock failures', async () => {
  const exits = [];
  let lockAttempts = 0;
  let sleepCount = 0;
  await waitOnceSupervisor(['--wait-once', '--convo', '100'], {
    acquireLock: async () => {
      lockAttempts += 1;
      return null;
    },
    exists: () => false,
    sleep: async () => { sleepCount += 1; },
    log: () => {},
    error: () => {},
    exit: (code) => { exits.push(code); },
  });

  assert.strictEqual(lockAttempts, 20);
  assert.strictEqual(sleepCount, 19);
  assert.deepStrictEqual(exits, [1]);
});

test('waitOnceSupervisor — exits after repeated child infrastructure failures', async () => {
  const exits = [];
  let spawnCount = 0;
  let sleepCount = 0;
  await waitOnceSupervisor(['--wait-once', '--convo', '100'], {
    acquireLock: async () => '/tmp/nonexistent-wait-once.lock',
    spawn: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      // Defer until waitOnceSupervisor registers the child's exit handler.
      queueMicrotask(() => child.emit('exit', 1));
      return child;
    },
    exists: () => false,
    sleep: async () => { sleepCount += 1; },
    log: () => {},
    error: () => {},
    exit: (code) => { exits.push(code); },
  });

  assert.strictEqual(spawnCount, 20);
  assert.strictEqual(sleepCount, 19);
  assert.deepStrictEqual(exits, [1]);
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
