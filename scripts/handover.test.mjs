import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'handover.mjs');
// Run the real CLI, return its exit code (stdio captured, not inherited).
function runCli(argv, stdin = '') {
  try {
    execFileSync(process.execPath, [SCRIPT, ...argv], { input: stdin, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : -1;
  }
}

import {
  EXIT,
  parseArgs,
  normalizeTarget,
  listLiveTopics,
  listSteerableTargets,
  matchTarget,
  formatTopicList,
  handoverHeader,
  buildHandoverPrompt,
  buildAckPrompt,
  resolveConvoChatId,
  writePromptExclusive,
  buildSeedPrompt,
  resolveChatIds,
  isPrivilegedRole,
} from './handover.mjs';
import { personaForConvo, formatPersona } from './persona.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { DEFAULT_TMP_DIR } from './tele-listen.mjs';

// Isolate the persona pin store so handover (and the CLI subprocesses it
// spawns, which inherit this env) DERIVE personas instead of reading the real
// machine-local pins. Resolved at call-time from TELE_PERSONA_STORE.
process.env.TELE_PERSONA_STORE = path.join(os.tmpdir(), `teleport-persona-store-handover-${process.pid}.jsonl`);

// Real convoId examples (long → letter-prefixed hashtag).
const TARGET_CONVO = '2205483045424020';            // → #e5424020
const TARGET_HASH = shortConvoHash(TARGET_CONVO);    // 'e5424020'
const SOURCE_CONVO = '1111111111111111';
const TARGET_PERSONA = personaForConvo(TARGET_CONVO);

// --- parseArgs -------------------------------------------------------------

test('parseArgs: --to with value', () => {
  const a = parseArgs(['--to', 'Cú']);
  assert.equal(a.error, null);
  assert.equal(a.to, 'Cú');
  assert.equal(a.isNew, false);
});

test('parseArgs: --new requires --by-role', () => {
  assert.match(parseArgs(['--new']).error, /--by-role/);
  assert.equal(parseArgs(['--new', '--by-role', 'admin']).error, null);
});

test('parseArgs: --to and --new are mutually exclusive', () => {
  assert.match(parseArgs(['--to', 'Cú', '--new', '--by-role', 'admin']).error, /mutually exclusive/);
});

test('parseArgs: neither --to nor --new nor --ack is a usage error', () => {
  assert.match(parseArgs([]).error, /--to, --new, or --ack/);
});

test('parseArgs: --ack with a convoId', () => {
  const a = parseArgs(['--ack', '2205483045424020']);
  assert.equal(a.error, null);
  assert.equal(a.ack, '2205483045424020');
});

test('parseArgs: --ack rejects a non-convoId value', () => {
  assert.match(parseArgs(['--ack', 'Cú']).error, /--ack must be a positive integer convoId/);
});

test('parseArgs: --ack is mutually exclusive with --to/--new', () => {
  assert.match(parseArgs(['--ack', '123', '--to', 'Cú']).error, /mutually exclusive/);
  assert.match(parseArgs(['--ack', '123', '--new', '--by-role', 'admin']).error, /mutually exclusive/);
});

test('parseArgs: missing value + unknown flag are errors', () => {
  assert.match(parseArgs(['--to']).error, /--to requires a value/);
  assert.match(parseArgs(['--bogus']).error, /unknown argument/);
});

test('parseArgs: full inject form', () => {
  const a = parseArgs(['--to', '#e5424020', '--from-convo', '999', '--chat-id', '-100999']);
  assert.deepEqual(
    { to: a.to, fromConvo: a.fromConvo, chatId: a.chatId, error: a.error },
    { to: '#e5424020', fromConvo: '999', chatId: '-100999', error: null },
  );
});

test('parseArgs: non-numeric --chat-id is a usage error', () => {
  assert.match(parseArgs(['--to', 'X', '--chat-id', '-100x']).error, /--chat-id must be a numeric/);
});

// --- normalizeTarget -------------------------------------------------------

test('normalizeTarget: # prefix → hashtag', () => {
  assert.deepEqual(normalizeTarget('#e5424020'), { kind: 'hashtag', value: 'e5424020' });
});

test('normalizeTarget: bare hashtag shapes', () => {
  assert.deepEqual(normalizeTarget('e5424020'), { kind: 'hashtag', value: 'e5424020' });
  assert.deepEqual(normalizeTarget('t1234'), { kind: 'hashtag', value: 't1234' });
});

test('normalizeTarget: all digits → convoId', () => {
  assert.deepEqual(normalizeTarget('2205483045424020'), { kind: 'convoId', value: '2205483045424020' });
});

test('normalizeTarget: persona name', () => {
  assert.deepEqual(normalizeTarget('Cú'), { kind: 'name', value: 'Cú' });
});

// --- listLiveTopics --------------------------------------------------------

test('listLiveTopics: skips _meta keys, non-positive threads, and other chats', () => {
  const store = {
    '-100123': {
      [TARGET_CONVO]: 124,
      '777': 0,            // threadId not > 0 → excluded
      _is_forum: true,     // underscore meta → excluded
      _ts: { [TARGET_CONVO]: 1 },
    },
    '-100999': { '555': 9 }, // different chat → excluded when not in chatIds
  };
  const live = listLiveTopics(store, ['-100123']);
  assert.equal(live.length, 1);
  assert.equal(live[0].convoId, TARGET_CONVO);
  assert.equal(live[0].threadId, 124);
  assert.equal(live[0].hashtag, TARGET_HASH);
  assert.deepEqual(live[0].persona, TARGET_PERSONA);
});

// --- matchTarget -----------------------------------------------------------

const heoA = { convoId: '111', hashtag: 't111', ts: 100, persona: { emoji: '🐷', name: 'Heo', index: 16 } };
const heoB = { convoId: '222', hashtag: 't222', ts: 200, persona: { emoji: '🐷', name: 'Heo', index: 16 } };
const cu = { convoId: '333', hashtag: 't333', ts: 50, persona: { emoji: '🦉', name: 'Cú', index: 1 } };

test('matchTarget: by name, case-insensitive', () => {
  assert.deepEqual(matchTarget(normalizeTarget('cú'), [heoA, cu]), { status: 'found', match: cu });
});

test('matchTarget: by hashtag and by convoId', () => {
  assert.equal(matchTarget(normalizeTarget('#t333'), [heoA, cu]).match, cu);
  assert.equal(matchTarget(normalizeTarget('333'), [heoA, cu]).match, cu);
});

test('matchTarget: name collision → prefer most recent, report shadowed', () => {
  const r = matchTarget(normalizeTarget('Heo'), [heoA, heoB, cu]);
  assert.equal(r.status, 'found');
  assert.equal(r.match, heoB);              // ts 200 > 100 → freshest wins
  assert.deepEqual(r.shadowed, [heoA]);     // older same-name topic reported
});

test('matchTarget: recency TIE (equal/zero ts) → ambiguous', () => {
  const t1 = { ...heoA, ts: 0 };
  const t2 = { ...heoB, ts: 0 };
  const r = matchTarget(normalizeTarget('Heo'), [t1, t2]);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2);
});

test('matchTarget: not found', () => {
  assert.deepEqual(matchTarget(normalizeTarget('Rồng'), [heoA, cu]), { status: 'not_found' });
});

test('listLiveTopics surfaces _ts as ts', () => {
  const store = { '-1': { '2205483045424020': 7, _ts: { '2205483045424020': 1700 } } };
  const live = listLiveTopics(store, ['-1']);
  assert.equal(live[0].ts, 1700);
});

test('listLiveTopics excludes non-convoId (legacy project-code) keys — not pickup-able', () => {
  const store = {
    '-1': {
      [TARGET_CONVO]: 5,   // valid numeric convoId → kept
      luni: 9,             // project-code key → excluded
      tea_game: 11,        // project-code key → excluded
      '007': 3,            // leading zero → not a valid convoId → excluded
    },
  };
  const live = listLiveTopics(store, ['-1']);
  assert.deepEqual(live.map((t) => t.convoId), [TARGET_CONVO]);
});

test('every listLiveTopics convoId is one a listener would watch (CONVO_ID_RE)', () => {
  const store = { '-1': { [TARGET_CONVO]: 5, '111': 6, luni: 9 } };
  for (const t of listLiveTopics(store, ['-1'])) {
    assert.match(String(t.convoId), /^[1-9]\d{0,18}$/);
  }
});

test('formatTopicList renders persona + hashtag', () => {
  assert.equal(formatTopicList([heoA, cu]), '🐷 Heo #t111, 🦉 Cú #t333');
});

// --- buildHandoverPrompt ---------------------------------------------------

test('buildHandoverPrompt: non-privileged shape + attribution + target persona', () => {
  const p = buildHandoverPrompt({
    targetConvoId: TARGET_CONVO,
    targetChatId: '-100123',
    sourceConvoId: SOURCE_CONVO,
    notes: 'Đã làm X.\nLàm tiếp Y.',
    nowSec: 1700000000,
  });
  // Authority: NEVER admin — non-privileged handover role.
  assert.equal(p.fromRole, 'handover');
  assert.notEqual(p.fromRole, 'admin');
  assert.equal(p.fromMember, null);
  assert.equal(p.fromUserId, null); // builder would leak targetChatId here; override must hold
  assert.equal(p.messageId, null);
  assert.deepEqual(p.attachments, []);
  // Routing identity = TARGET.
  assert.equal(p.convoId, TARGET_CONVO);
  assert.deepEqual(p.persona, TARGET_PERSONA);
  assert.equal(p.chatId, '-100123');
  // Attribution from SOURCE.
  assert.deepEqual(p.handover.from.persona, personaForConvo(SOURCE_CONVO));
  assert.equal(p.handover.from.convoId, SOURCE_CONVO);
  assert.equal(p.handover.from.hashtag, `#${shortConvoHash(SOURCE_CONVO)}`);
  // Text carries header + notes (plain-text fallback for the attribution).
  assert.ok(p.text.includes('Handover từ'));
  assert.ok(p.text.includes('Đã làm X.'));
  assert.ok(p.text.includes(formatPersona(personaForConvo(SOURCE_CONVO))));
});

test('handoverHeader names source, target, and source hashtag', () => {
  const h = handoverHeader(personaForConvo(SOURCE_CONVO), SOURCE_CONVO, TARGET_PERSONA);
  assert.ok(h.includes(`#${shortConvoHash(SOURCE_CONVO)}`));
  assert.ok(h.includes(formatPersona(TARGET_PERSONA)));
});

// --- resolveConvoChatId ------------------------------------------------------

test('resolveConvoChatId: finds the chat owning a convoId, across ALL chats', () => {
  const store = { '-100123': { [TARGET_CONVO]: 124 }, '-100999': { '555': 9 } };
  assert.equal(resolveConvoChatId(store, TARGET_CONVO), '-100123');
  assert.equal(resolveConvoChatId(store, '555'), '-100999');
});

test('resolveConvoChatId: unknown convoId → null (ack still proceeds without it)', () => {
  assert.equal(resolveConvoChatId({ '-100123': { [TARGET_CONVO]: 124 } }, '999999999'), null);
});

// --- buildAckPrompt (receipt confirmation, round-tripped to the sender) ----

test('buildAckPrompt: non-privileged, routes to the ORIGINAL sender, attributes to the acker', () => {
  const p = buildAckPrompt({
    targetConvoId: SOURCE_CONVO,       // the original handover sender
    targetChatId: '-100123',
    sourceConvoId: TARGET_CONVO,       // the acker (who just adopted the handover)
    note: 'Bắt đầu đọc HANDOVER.md.',
    nowSec: 1700000000,
  });
  assert.equal(p.fromRole, 'handover-ack');
  assert.notEqual(p.fromRole, 'admin');
  assert.equal(p.fromMember, null);
  assert.equal(p.messageId, null);
  assert.deepEqual(p.attachments, []);
  // Routes back to the SENDER's own convo.
  assert.equal(p.convoId, SOURCE_CONVO);
  // Attribution = the ACKER.
  assert.deepEqual(p.handoverAck.from.persona, TARGET_PERSONA);
  assert.equal(p.handoverAck.from.convoId, TARGET_CONVO);
  assert.equal(p.handoverAck.from.hashtag, `#${TARGET_HASH}`);
  assert.ok(p.text.includes('đã NHẬN handover'));
  assert.ok(p.text.includes('Bắt đầu đọc HANDOVER.md.'));
});

test('buildAckPrompt: empty note still produces a well-formed ack', () => {
  const p = buildAckPrompt({ targetConvoId: SOURCE_CONVO, targetChatId: null, sourceConvoId: TARGET_CONVO, note: '', nowSec: 1700000000 });
  assert.ok(p.text.includes('đã NHẬN handover'));
  assert.equal(p.chatId, 'null'); // buildCombinedPromptData stringifies chat.id verbatim
});

// --- writePromptExclusive (atomic, no-overwrite) ---------------------------

test('writePromptExclusive: writes once, refuses to overwrite (EEXIST → busy)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-test-'));
  const file = path.join(dir, 'prompt-convo-X.json');
  try {
    assert.equal(writePromptExclusive({ a: 1 }, file), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
    // Second write to the same (unconsumed) file MUST throw EEXIST, not clobber.
    let err = null;
    try { writePromptExclusive({ a: 2 }, file); } catch (e) { err = e; }
    assert.ok(err, 'expected an error on second write');
    assert.equal(err.code, 'EEXIST');
    // Original content preserved (no data loss).
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- inject path integration (build + exclusive write, isolated dir) --------

test('inject path: writes a well-formed prompt, then refuses overwrite (busy)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-inject-'));
  const file = path.join(dir, `prompt-convo-${TARGET_CONVO}.json`);
  try {
    const prompt = buildHandoverPrompt({
      targetConvoId: TARGET_CONVO,
      targetChatId: '-100123',
      sourceConvoId: SOURCE_CONVO,
      notes: 'State: branch wip. Làm tiếp: chạy test.',
      roles: null,
      nowSec: 1700000000,
    });
    // success injection
    assert.equal(writePromptExclusive(prompt, file), true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.fromRole, 'handover');
    assert.equal(onDisk.convoId, TARGET_CONVO);
    assert.deepEqual(onDisk.attachments, []);
    assert.equal(onDisk.handover.from.convoId, SOURCE_CONVO);
    // a second handover while the first is unconsumed → EEXIST (maps to BUSY/3),
    // original preserved (no lost instruction)
    let code = null;
    try { writePromptExclusive(buildHandoverPrompt({ targetConvoId: TARGET_CONVO, targetChatId: '-100123', sourceConvoId: SOURCE_CONVO, notes: 'second', nowSec: 1700000001 }), file); }
    catch (e) { code = e.code; }
    assert.equal(code, 'EEXIST');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).text, onDisk.text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- buildSeedPrompt (--new) ----------------------------------------------

test('buildSeedPrompt: instructs Telegram open + no sensitive action + carries notes', () => {
  const seed = buildSeedPrompt({ sourceConvoId: SOURCE_CONVO, notes: 'Tiếp quản phần Z.' });
  assert.ok(/Telegram/i.test(seed));
  assert.ok(seed.includes('Tiếp quản phần Z.'));
  assert.ok(/sensitive/i.test(seed));
  assert.ok(seed.includes(formatPersona(personaForConvo(SOURCE_CONVO))));
});

// --- role gate -------------------------------------------------------------

test('isPrivilegedRole: only admin/maintainer pass (fail-closed)', () => {
  assert.equal(isPrivilegedRole('admin'), true);
  assert.equal(isPrivilegedRole('maintainer'), true);
  assert.equal(isPrivilegedRole('dev'), false);
  assert.equal(isPrivilegedRole('member'), false);
  assert.equal(isPrivilegedRole('Admin'), false); // exact, no case widening
  assert.equal(isPrivilegedRole(undefined), false);
});

// --- resolveChatIds --------------------------------------------------------

test('resolveChatIds: --chat-id override wins', () => {
  const r = resolveChatIds({ chatIdOverride: '-100777' });
  assert.deepEqual(r.chatIds, ['-100777']);
});

// --- CLI exit-code contract (real subprocess) ------------------------------
// Config-independent branches only: --chat-id "-100none" scopes the topic scan
// to a chat with no topics, so resolution is deterministic regardless of the
// machine's topics.json / projects.json.

test('CLI: empty notes → USAGE(2)', () => {
  assert.equal(runCli(['--to', '#zz', '--from-convo', '123'], ''), EXIT.USAGE);
});

test('CLI: --to and --new together → USAGE(2)', () => {
  assert.equal(runCli(['--to', 'A', '--new', '--by-role', 'admin'], 'notes'), EXIT.USAGE);
});

test('CLI: unknown flag → USAGE(2)', () => {
  assert.equal(runCli(['--bogus'], 'notes'), EXIT.USAGE);
});

test('CLI: missing source convo → USAGE(2)', () => {
  // Strip native-session env so no source convo can be resolved.
  const SCRIPT2 = SCRIPT;
  try {
    execFileSync(process.execPath, [SCRIPT2, '--to', '#zz'], {
      input: 'notes', stdio: 'pipe',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' },
    });
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.status, EXIT.USAGE);
  }
});

test('CLI: --new with non-privileged role → FORBIDDEN(6)', () => {
  assert.equal(runCli(['--new', '--by-role', 'member', '--from-convo', '123'], 'notes'), EXIT.FORBIDDEN);
});

test('CLI: --new role gate is fail-closed for case/typo variants', () => {
  // Capitalized "Admin" must NOT widen privilege; unknown role refused.
  assert.equal(runCli(['--new', '--by-role', 'Admin', '--from-convo', '123'], 'notes'), EXIT.FORBIDDEN);
  assert.equal(runCli(['--new', '--by-role', 'wheel', '--from-convo', '123'], 'notes'), EXIT.FORBIDDEN);
  // Empty role value → --new requires a role → USAGE(2), not FORBIDDEN.
  assert.equal(runCli(['--new', '--by-role', '', '--from-convo', '123'], 'notes'), EXIT.USAGE);
});

test('CLI: non-numeric --from-convo → USAGE(2)', () => {
  assert.equal(runCli(['--to', '#zz', '--from-convo', 'abc'], 'notes'), EXIT.USAGE);
});

test('CLI: --to no live topic in scoped chat → NOT_FOUND(4)', () => {
  assert.equal(runCli(['--to', '#zzzz9999', '--from-convo', '123', '--chat-id', '-100000000001'], 'notes'), EXIT.NOT_FOUND);
});

test('CLI: --ack with no note → OK(0), no empty-notes error (note is optional for ack); writes real prompt file, then BUSY(3) on retry', () => {
  // A fresh convoId so this run can't collide with a leftover file from a
  // prior run; clean up afterward — DEFAULT_TMP_DIR is the REAL prompt queue
  // dir (scripts/tmp/tele-reply), not an isolated test tmpdir.
  const convo = String(9000000000000000n + BigInt(process.pid));
  const file = path.join(DEFAULT_TMP_DIR, `prompt-convo-${convo}.json`);
  try {
    assert.equal(runCli(['--ack', convo, '--from-convo', SOURCE_CONVO], ''), EXIT.OK);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.fromRole, 'handover-ack');
    assert.equal(onDisk.handoverAck.from.convoId, SOURCE_CONVO);
    // Same target still unconsumed → BUSY, not a silent overwrite.
    assert.equal(runCli(['--ack', convo, '--from-convo', SOURCE_CONVO], 'second'), EXIT.BUSY);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// --- EXIT enum -------------------------------------------------------------

test('EXIT enum is stable (agents parse these codes)', () => {
  assert.deepEqual(EXIT, {
    OK: 0, ERROR: 1, USAGE: 2, BUSY: 3, NOT_FOUND: 4, AMBIGUOUS: 5, FORBIDDEN: 6,
  });
});

// --- listSteerableTargets (RFC 14) -----------------------------------------

import { alivePath } from './listener-alive.mjs';

function aliveDirWith(convoIds, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-alive-'));
  for (const id of convoIds) {
    const p = alivePath(id, dir);
    fs.writeFileSync(p, '');
    const t = (now - 1000) / 1000; // 1s ago → fresh
    fs.utimesSync(p, t, t);
  }
  return dir;
}

test('listSteerableTargets: merges alive-only convos (chatId null, source alive)', () => {
  const now = 1_000_000_000_000;
  const aliveDir = aliveDirWith(['823261298239188'], now);
  const got = listSteerableTargets({}, ['-100'], { aliveDir, now });
  assert.equal(got.length, 1);
  const e = got[0];
  assert.equal(e.convoId, '823261298239188');
  assert.equal(e.chatId, null);
  assert.equal(e.threadId, null);
  assert.equal(e.source, 'alive');
  assert.equal(e.hashtag, shortConvoHash('823261298239188'));
  assert.deepEqual(e.persona, personaForConvo('823261298239188'));
});

test('listSteerableTargets: topic entry WINS over alive (dedup, keeps chatId)', () => {
  const now = 1_000_000_000_000;
  const convo = '2205483045424020';
  const store = { '-100123': { [convo]: 42, _ts: { [convo]: 500 } } };
  const aliveDir = aliveDirWith([convo], now);
  const got = listSteerableTargets(store, ['-100123'], { aliveDir, now });
  assert.equal(got.length, 1);
  assert.equal(got[0].chatId, '-100123');   // topic entry, not the alive null
  assert.equal(got[0].threadId, 42);
  assert.notEqual(got[0].source, 'alive');
});

test('listSteerableTargets: skips non-watchable alive filenames', () => {
  const now = 1_000_000_000_000;
  const aliveDir = aliveDirWith(['not-a-convo'], now);
  assert.deepEqual(listSteerableTargets({}, ['-100'], { aliveDir, now }), []);
});

test('matchTarget: resolves alive-only by hashtag/convoId', () => {
  const now = 1_000_000_000_000;
  const convo = '823261298239188';
  const aliveDir = aliveDirWith([convo], now);
  const live = listSteerableTargets({}, ['-100'], { aliveDir, now });
  assert.equal(matchTarget(normalizeTarget('#' + shortConvoHash(convo)), live).status, 'found');
  assert.equal(matchTarget(normalizeTarget(convo), live).status, 'found');
});

test('matchTarget: does NOT resolve alive-only by persona-name (reuse risk)', () => {
  const now = 1_000_000_000_000;
  const convo = '823261298239188';
  const aliveDir = aliveDirWith([convo], now);
  const live = listSteerableTargets({}, ['-100'], { aliveDir, now });
  const persona = personaForConvo(convo);
  assert.equal(matchTarget(normalizeTarget(persona.name), live).status, 'not_found');
});
