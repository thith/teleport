import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseDaemonCommand, parseWhisperArgs, resolveSpawnCwd, buildWhisperPrompt,
  validateDaemonConfig, resolveSenderRole, acquireSingleton, releaseSingleton, daemonStatus,
} from './daemon.mjs';

test('parseDaemonCommand: extracts command + rest, strips @botname, lowercases', () => {
  assert.deepEqual(parseDaemonCommand('/spawn d_be'), { cmd: 'spawn', rest: 'd_be' });
  assert.deepEqual(parseDaemonCommand('/Whisper@my_bot topic:#e5424020 hi there'), { cmd: 'whisper', rest: 'topic:#e5424020 hi there' });
  assert.deepEqual(parseDaemonCommand('/pending'), { cmd: 'pending', rest: '' });
  assert.equal(parseDaemonCommand('not a command'), null);
  assert.equal(parseDaemonCommand('  '), null);
  assert.equal(parseDaemonCommand(undefined), null);
});

test('parseWhisperArgs: topic prefix optional, splits target + message', () => {
  assert.deepEqual(parseWhisperArgs('topic:#e5424020 confirm rõ với X'), { target: '#e5424020', message: 'confirm rõ với X' });
  assert.deepEqual(parseWhisperArgs('#e5424020 hello'), { target: '#e5424020', message: 'hello' });
  assert.deepEqual(parseWhisperArgs('Cú nhắc nhở nhẹ'), { target: 'Cú', message: 'nhắc nhở nhẹ' });
  assert.ok(parseWhisperArgs('#e5424020').error);   // no message
  assert.ok(parseWhisperArgs('').error);            // empty
});

test('resolveSpawnCwd: maps project → sibling dir, rejects traversal/missing', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-parent-'));
  fs.mkdirSync(path.join(parent, 'd_be'));
  assert.deepEqual(resolveSpawnCwd('d_be', { parentDir: parent }), { cwd: path.join(parent, 'd_be') });
  assert.ok(resolveSpawnCwd('../etc', { parentDir: parent }).error);   // traversal blocked by charset
  assert.ok(resolveSpawnCwd('nope', { parentDir: parent }).error);     // not found
  assert.ok(resolveSpawnCwd('', { parentDir: parent }).error);        // empty
  fs.rmSync(parent, { recursive: true, force: true });
});

test('buildWhisperPrompt: injected shape with whisper flag + real fromRole', () => {
  const p = buildWhisperPrompt({ targetConvoId: '2205483045424020', targetChatId: '-100', fromUserId: '144242180', fromName: 'Thi', fromRole: 'admin', text: 'hãy confirm' });
  assert.equal(p.whisper, true);
  assert.equal(p.messageId, null);       // injected, not a real message
  assert.equal(p.convoId, 2205483045424020);
  assert.equal(p.chatId, '-100');
  assert.equal(p.fromRole, 'admin');
  assert.equal(p.fromUserId, '144242180');
  assert.equal(p.text, 'hãy confirm');
  assert.deepEqual(p.attachments, []);
});

test('resolveSenderRole: highest privilege across projects, default member', () => {
  const cfg = {
    a: { roles: { '1': { role: 'member' }, '9': 'admin' } },
    b: { roles: { '1': { role: 'maintainer' } } },
  };
  assert.equal(resolveSenderRole(cfg, '1'), 'maintainer'); // member in a, maintainer in b → maintainer
  assert.equal(resolveSenderRole(cfg, '9'), 'admin');
  assert.equal(resolveSenderRole(cfg, '404'), 'member');   // unmapped → least privilege
});

test('validateDaemonConfig: enforces group/private split', () => {
  // ok: groups negative, daemon private positive
  assert.doesNotThrow(() => validateDaemonConfig({
    projectsConfig: { d_be: { chatId: '-1001' }, luni: { chatId: '-1002' } },
    catchAllIds: ['-100999'], daemonChatId: '144242180',
  }));
  // daemon chat must be private
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['-100'], daemonChatId: '-100' }), /DAEMON_CHAT_ID must be a PRIVATE/);
  // missing daemon chat
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['-100'], daemonChatId: '' }), /Missing DAEMON_CHAT_ID/);
  // a project chat that is private → error
  assert.throws(() => validateDaemonConfig({ projectsConfig: { bad: { chatId: '144242180' } }, catchAllIds: ['-100'], daemonChatId: '1' }), /project 'bad' chatId must be a GROUP/);
  // catch-all private → error
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['144242180'], daemonChatId: '1' }), /catch-all .* must be a GROUP/);
});

test('singleton: acquire writes pid, second acquire fails while alive, status reflects it, release clears', () => {
  const pidFile = path.join(os.tmpdir(), `tele-daemon-${process.pid}-${Date.now()}.pid`);
  const a = acquireSingleton(pidFile);
  assert.equal(a.ok, true);
  assert.equal(a.pid, process.pid);
  assert.deepEqual(daemonStatus(pidFile), { running: true, pid: process.pid });
  // simulate a different LIVE holder → refuse
  fs.writeFileSync(pidFile, String(process.pid)); // our own pid is alive
  const b = acquireSingleton(pidFile);
  assert.equal(b.ok, false);
  releaseSingleton(pidFile);
  assert.equal(daemonStatus(pidFile).running, false);
});

test('singleton: stale pid (dead) is reaped and acquired', () => {
  const pidFile = path.join(os.tmpdir(), `tele-daemon-stale-${process.pid}-${Date.now()}.pid`);
  fs.writeFileSync(pidFile, '999999999'); // almost certainly dead pid
  const a = acquireSingleton(pidFile);
  assert.equal(a.ok, true);
  assert.equal(a.pid, process.pid);
  releaseSingleton(pidFile);
});
