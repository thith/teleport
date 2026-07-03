import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, isDmUnreachableError } from './send-telegram.mjs';

// --dm is the admin private-push flag (RFC 12). These tests pin the arg-parsing
// contract: the flag parses, combines with text/file/plain/raw, and is mutually
// exclusive with the group/topic-scoped operations. The destination resolution
// (daemonUserId + private-id guard) is composed of resolveDaemonUserId /
// assertChatIdKind, already covered in projects-config.test.mjs.

test('--dm: parses and defaults false', () => {
  assert.equal(parseArgs([]).dm, false);
  assert.equal(parseArgs(['hello']).dm, false);
  assert.equal(parseArgs(['--dm', 'hello']).dm, true);
});

test('--dm: text stays positional', () => {
  const a = parseArgs(['--dm', 'file', 'abc']);
  assert.equal(a.dm, true);
  assert.deepEqual(a.positional, ['file', 'abc']);
});

test('--dm: combines with --file (+ caption) and --plain', () => {
  const a = parseArgs(['--dm', '--file', 'report.pdf', '--plain', 'here you go']);
  assert.equal(a.dm, true);
  assert.equal(a.filePath, 'report.pdf');
  assert.equal(a.plain, true);
  assert.deepEqual(a.positional, ['here you go']);
});

test('--dm: combines with --raw', () => {
  assert.equal(parseArgs(['--dm', '--raw', 'x']).raw, true);
});

test('--dm: mutually exclusive with group/topic-scoped ops', () => {
  assert.throws(() => parseArgs(['--dm', '--close-topic']), /--dm cannot be combined/);
  assert.throws(() => parseArgs(['--dm', '--gc-topics']), /--dm cannot be combined/);
  assert.throws(() => parseArgs(['--dm', '--react', '5']), /--dm cannot be combined/);
  assert.throws(() => parseArgs(['--dm', '--convo', '123']), /--dm cannot be combined/);
  assert.throws(() => parseArgs(['--dm', '--reply-to', '7']), /--dm cannot be combined/);
});

test('--dm: order-independent mutual-exclusion (flag after the op)', () => {
  assert.throws(() => parseArgs(['--close-topic', '--dm']), /--dm cannot be combined/);
  assert.throws(() => parseArgs(['--convo', '123', '--dm']), /--dm cannot be combined/);
});

// isDmUnreachableError: maps the "admin hasn't /started the bot" family of
// Telegram errors so the DM branch prints an actionable hint (RFC 12 §3.4).
test('isDmUnreachableError: matches the real Telegram bot-can\'t-DM errors', () => {
  assert.equal(isDmUnreachableError("Forbidden: bot can't initiate conversation with a user"), true);
  assert.equal(isDmUnreachableError('Forbidden: bot was blocked by the user'), true);
  assert.equal(isDmUnreachableError('Bad Request: chat not found'), true);
  assert.equal(isDmUnreachableError('Forbidden: user is deactivated'), true); // generic Forbidden
});

test('isDmUnreachableError: does not match unrelated errors / empty', () => {
  assert.equal(isDmUnreachableError('Bad Request: message is too long'), false);
  assert.equal(isDmUnreachableError('HTTP 429 Too Many Requests'), false);
  assert.equal(isDmUnreachableError(''), false);
  assert.equal(isDmUnreachableError(null), false);
  assert.equal(isDmUnreachableError(undefined), false);
});
