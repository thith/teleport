import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseDaemonCommand, parseWhisperArgs, resolveSpawnCwd, buildWhisperPrompt,
  validateDaemonConfig, resolveSenderRole, acquireSingleton, releaseSingleton, daemonStatus,
  parseRunArgs, tailOutput, cmdRun, detectPackageManager, readPackageScripts,
} from './daemon.mjs';

// Build a fake project dir with a package.json (scripts) + optional lockfile.
function fakeProject(scripts = {}, { lock, packageManager } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'run-parent-'));
  const proj = path.join(parent, 'proj');
  fs.mkdirSync(proj);
  const pkg = { name: 'proj', scripts };
  if (packageManager) pkg.packageManager = packageManager;
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify(pkg));
  if (lock) fs.writeFileSync(path.join(proj, lock), '');
  return { parent, proj, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

test('parseRunArgs: project + script + args (no package manager)', () => {
  assert.deepEqual(parseRunArgs('luni dev'), { project: 'luni', script: 'dev', args: [] });
  assert.deepEqual(parseRunArgs('d_be build --prod'), { project: 'd_be', script: 'build', args: ['--prod'] });
  assert.ok(parseRunArgs('luni').error); // no script
  assert.ok(parseRunArgs('').error);
});

test('detectPackageManager: packageManager field > lockfile > npm default', () => {
  const { proj, cleanup } = fakeProject({}, { packageManager: 'pnpm@9.0.0' });
  assert.equal(detectPackageManager(proj), 'pnpm'); cleanup();
  const a = fakeProject({}, { lock: 'yarn.lock' }); assert.equal(detectPackageManager(a.proj), 'yarn'); a.cleanup();
  const b = fakeProject({}, { lock: 'pnpm-lock.yaml' }); assert.equal(detectPackageManager(b.proj), 'pnpm'); b.cleanup();
  const c = fakeProject({}, { lock: 'package-lock.json' }); assert.equal(detectPackageManager(c.proj), 'npm'); c.cleanup();
  const d = fakeProject({}); assert.equal(detectPackageManager(d.proj), 'npm'); d.cleanup(); // default
});

test('readPackageScripts: returns scripts, or error when missing/invalid', () => {
  const { proj, cleanup } = fakeProject({ dev: 'vite', test: 'vitest' });
  assert.deepEqual(readPackageScripts(proj).scripts, { dev: 'vite', test: 'vitest' });
  cleanup();
  assert.ok(readPackageScripts('/no/such/dir').error); // missing package.json
});

test('tailOutput: keeps tail with marker when over limit', () => {
  assert.equal(tailOutput('short', 100), 'short');
  const t = tailOutput('x'.repeat(50), 10);
  assert.ok(t.startsWith('…(truncated'));
  assert.ok(t.endsWith('xxxxxxxxxx'));
});

test('cmdRun: refuses non-admin/maintainer (remote exec gate)', async () => {
  const sent = []; let ran = false;
  await cmdRun('proj dev', {
    daemonChatId: '1', from: { id: '999' }, projectsConfig: { _default: { roles: { '999': { role: 'member' } } } },
    sendText: async (_c, t) => sent.push(t), runner: async () => { ran = true; return { stdout: '', stderr: '' }; },
  });
  assert.equal(ran, false);
  assert.match(sent[0], /admin\/maintainer/);
});

test('cmdRun: missing script → error listing available, never runs', async () => {
  const { parent, cleanup } = fakeProject({ dev: 'vite', build: 'vite build' });
  const sent = []; let ran = false;
  await cmdRun('proj nope', {
    daemonChatId: '1', from: { id: '7' }, projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } },
    parentDir: parent, sendText: async (_c, t) => sent.push(t), runner: async () => { ran = true; return {}; },
  });
  assert.equal(ran, false);
  assert.match(sent[0], /script "nope" không có/);
  assert.match(sent[0], /dev, build/);
  cleanup();
});

test('cmdRun: admin runs <pm> run <script> in the project cwd + reports output', async () => {
  const { parent, proj, cleanup } = fakeProject({ dev: 'vite' }, { lock: 'pnpm-lock.yaml' });
  const calls = []; const sent = [];
  await cmdRun('proj dev --port 3000', {
    daemonChatId: '1', from: { id: '7' }, projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } },
    parentDir: parent, sendText: async (_c, t) => sent.push(t),
    runner: async (bin, args, opts) => { calls.push({ bin, args, cwd: opts.cwd }); return { stdout: 'served', stderr: '' }; },
  });
  assert.equal(calls[0].bin, 'pnpm'); // detected from lockfile
  // `--` delimits: the `--port 3000` go to the SCRIPT, not the package manager,
  // so a hostile `--prefix /elsewhere` can't redirect the PM out of cwd.
  assert.deepEqual(calls[0].args, ['run', 'dev', '--', '--port', '3000']);
  assert.equal(calls[0].cwd, proj);
  assert.ok(sent.some((t) => /exit 0/.test(t) && /served/.test(t)));
  cleanup();
});

test('parseRunArgs: rejects a script name starting with "-" (PM-flag injection)', () => {
  assert.ok(parseRunArgs('luni --prefix').error);
  assert.ok(parseRunArgs('luni -x build').error);
});

test('cmdRun: a --prefix arg is delimited after -- (cannot redirect the PM cwd)', async () => {
  const { parent, proj, cleanup } = fakeProject({ dev: 'vite' });
  const calls = [];
  await cmdRun('proj dev --prefix /etc', {
    daemonChatId: '1', from: { id: '7' }, projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } },
    parentDir: parent, sendText: async () => {}, runner: async (bin, args, opts) => { calls.push({ args, cwd: opts.cwd }); return { stdout: '', stderr: '' }; },
  });
  assert.deepEqual(calls[0].args, ['run', 'dev', '--', '--prefix', '/etc']); // after the delimiter
  assert.equal(calls[0].cwd, proj);
  cleanup();
});

test('resolveSpawnCwd: rejects a project dir that symlinks OUTSIDE the workspace', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.symlinkSync(outside, path.join(parent, 'evil'));
  const r = resolveSpawnCwd('evil', { parentDir: parent });
  assert.ok(r.error && /outside the workspace/.test(r.error));
  fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});

test('cmdRun: prototype-chain "scripts" (toString/constructor) are NOT runnable', async () => {
  const { parent, cleanup } = fakeProject({ dev: 'vite' });
  const sent = []; let ran = false;
  await cmdRun('proj toString', {
    daemonChatId: '1', from: { id: '7' }, projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } },
    parentDir: parent, sendText: async (_c, t) => sent.push(t), runner: async () => { ran = true; return {}; },
  });
  assert.equal(ran, false); // hasOwnProperty guard → not treated as an existing script
  assert.match(sent[0], /script "toString" không có/);
  cleanup();
});

test('readPackageScripts: an array "scripts" is treated as no scripts', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'run-parent-'));
  const proj = path.join(parent, 'p'); fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: ['a', 'b'] }));
  assert.deepEqual(readPackageScripts(proj).scripts, {}); // array → {}
  fs.rmSync(parent, { recursive: true, force: true });
});

test('cmdRun: no package.json → error', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'run-parent-'));
  fs.mkdirSync(path.join(parent, 'proj')); // dir but no package.json
  const sent = []; let ran = false;
  await cmdRun('proj dev', {
    daemonChatId: '1', from: { id: '7' }, projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } },
    parentDir: parent, sendText: async (_c, t) => sent.push(t), runner: async () => { ran = true; return {}; },
  });
  assert.equal(ran, false);
  assert.match(sent[0], /no package.json/);
  fs.rmSync(parent, { recursive: true, force: true });
});

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

test('resolveSenderRole: highest privilege across DEDICATED projects, default member', () => {
  const cfg = {
    a: { chatId: '-1', roles: { '1': { role: 'member' }, '9': 'admin' } },
    b: { chatId: '-2', roles: { '1': { role: 'maintainer' } } },
  };
  assert.equal(resolveSenderRole(cfg, '1'), 'maintainer'); // member in a, maintainer in b → maintainer
  assert.equal(resolveSenderRole(cfg, '9'), 'admin');
  assert.equal(resolveSenderRole(cfg, '404'), 'member');   // unmapped → least privilege
});

test('resolveSenderRole: ignores a SHARED project\'s dead roles block (no chatId)', () => {
  // A shared project's own roles are ignored by resolveProjectConfig, so they
  // must NOT grant privilege here either — only `_default.roles` + dedicated.
  const cfg = { shared: { roles: { '5': { role: 'admin' } } }, ded: { chatId: '-9', roles: { '6': { role: 'maintainer' } } } };
  assert.equal(resolveSenderRole(cfg, '5'), 'member'); // dead config → not honored
  assert.equal(resolveSenderRole(cfg, '6'), 'maintainer');
});

test('resolveSenderRole: consults _default.roles (catch-all owner not in any project)', () => {
  // The control-DM owner is typically admin ONLY in the catch-all roster
  // (_default.roles). projectEntries skips _default, so this would regress to
  // member unless _default.roles is explicitly consulted.
  const cfg = { _default: { roles: { '7': { role: 'admin' } } }, proj: { chatId: '-1', roles: { '8': { role: 'dev' } } } };
  assert.equal(resolveSenderRole(cfg, '7'), 'admin'); // only in _default → still admin
  assert.equal(resolveSenderRole(cfg, '8'), 'dev');
  assert.equal(resolveSenderRole(cfg, '404'), 'member');
});

test('validateDaemonConfig: enforces group/private split', () => {
  // ok: groups negative, daemon private positive
  assert.doesNotThrow(() => validateDaemonConfig({
    projectsConfig: { d_be: { chatId: '-1001' }, luni: { chatId: '-1002' } },
    catchAllIds: ['-100999'], daemonChatId: '144242180',
  }));
  // daemon chat must be private
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['-100'], daemonChatId: '-100' }), /daemonChatId.* must be a PRIVATE/);
  // missing daemon chat
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['-100'], daemonChatId: '' }), /Missing daemonChatId/);
  // a project chat that is private → error
  assert.throws(() => validateDaemonConfig({ projectsConfig: { bad: { chatId: '144242180' } }, catchAllIds: ['-100'], daemonChatId: '1' }), /project 'bad' chatId must be a GROUP/);
  // catch-all private → error
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['144242180'], daemonChatId: '1' }), /_default.chatId.* must be a GROUP/);
  // reserved _config / _default keys are skipped during project iteration
  assert.doesNotThrow(() => validateDaemonConfig({ projectsConfig: { _config: { daemonChatId: '1' }, _default: { chatId: '-100' }, ok: { chatId: '-101' } }, catchAllIds: ['-100'], daemonChatId: '1' }));
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
