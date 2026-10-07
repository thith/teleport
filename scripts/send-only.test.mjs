import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSendOnly, SEND_ONLY_LISTEN_REFUSAL } from './projects-config.mjs';
import { sendOnlyExitCode } from './tele-listen.mjs';
import { listenerHintForCurrentAgent } from './send-telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('resolveSendOnly: JSON flag; non-boolean fails closed with a warning', () => {
  const warns = [];
  const warn = (m) => warns.push(m);
  assert.equal(resolveSendOnly({ _config: { sendOnly: true } }, { env: {}, warn }), true);
  assert.equal(resolveSendOnly({ _config: { sendOnly: false } }, { env: {}, warn }), false);
  assert.equal(resolveSendOnly({ _config: {} }, { env: {}, warn }), false);
  assert.equal(resolveSendOnly({}, { env: {}, warn }), false);
  assert.equal(warns.length, 0);
  assert.equal(resolveSendOnly({ _config: { sendOnly: 'true' } }, { env: {}, warn }), true);
  assert.equal(resolveSendOnly({ _config: { sendOnly: 1 } }, { env: {}, warn }), true);
  assert.equal(resolveSendOnly({ _config: { sendOnly: null } }, { env: {}, warn }), true);
  assert.equal(warns.length, 3);
});

test('resolveSendOnly: env TELE_SEND_ONLY overrides the JSON flag both ways; junk falls through', () => {
  for (const v of ['1', 'true', 'YES', ' on ']) {
    assert.equal(resolveSendOnly({}, { env: { TELE_SEND_ONLY: v } }), true, v);
  }
  for (const v of ['0', 'false', 'No', 'off']) {
    assert.equal(resolveSendOnly({ _config: { sendOnly: true } }, { env: { TELE_SEND_ONLY: v } }), false, v);
  }
  const warns = [];
  assert.equal(resolveSendOnly({ _config: { sendOnly: true } }, { env: { TELE_SEND_ONLY: 'maybe' }, warn: (m) => warns.push(m) }), true);
  assert.equal(resolveSendOnly({}, { env: { TELE_SEND_ONLY: 'maybe' }, warn: (m) => warns.push(m) }), false);
  assert.equal(warns.length, 2);
  assert.equal(resolveSendOnly({}, { env: { TELE_SEND_ONLY: '' } }), false);
});

test('sendOnlyExitCode: loop/wait-once stand down (3); bare drain reports "none" (2)', () => {
  assert.equal(sendOnlyExitCode(['--convo', '1', '--settle', '--loop', '--append']), 3);
  assert.equal(sendOnlyExitCode(['--wait-once', '--convo', '1']), 3);
  assert.equal(sendOnlyExitCode(['--convo', '1']), 2);
});

test('listenerHintForCurrentAgent: send-only replaces the start-a-listener hint', () => {
  const hint = listenerHintForCurrentAgent(123, { CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, { sendOnly: true });
  assert.match(hint, /Send-only machine/);
  assert.match(hint, /will NOT reach you/);
  assert.doesNotMatch(hint, /tele-listen|Monitor|wait-once/);
  assert.match(listenerHintForCurrentAgent(123, {}), /wait-once/);
});

// End-to-end: the real entry points refuse before any token/config/network work —
// a run that got past the guard would exit 1 (malformed token), not 3/2/0.
// (The projects.json path is covered by the resolveSendOnly unit tests; the
// entry reads the fixed default file, so it is not exercised here.)
const run = (script, args) => spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
  env: { ...process.env, TELE_SEND_ONLY: '1', REPORT_BOT_TOKEN: 'bogus', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' },
  encoding: 'utf8',
  timeout: 15000,
});

test('tele-listen entry refuses on a send-only machine with the documented exit codes', () => {
  const loop = run('tele-listen.mjs', ['--convo', '1', '--settle', '--loop', '--append']);
  assert.equal(loop.status, 3);
  assert.ok(loop.stderr.includes(SEND_ONLY_LISTEN_REFUSAL));
  assert.equal(run('tele-listen.mjs', ['--wait-once', '--convo', '1', '--settle']).status, 3);
  assert.equal(run('tele-listen.mjs', ['--convo', '1']).status, 2);
});

test('daemon entry refuses on a send-only machine (exit 0, no singleton lock)', () => {
  const r = run('daemon.mjs', []);
  assert.equal(r.status, 0);
  assert.ok(r.stderr.includes(SEND_ONLY_LISTEN_REFUSAL));
});
