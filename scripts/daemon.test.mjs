import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseDaemonCommand, resolveSpawnCwd, dispatchCommand, handleControlMessages,
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

test('resolveSpawnCwd: maps project → sibling dir, rejects traversal/missing', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-parent-'));
  fs.mkdirSync(path.join(parent, 'd_be'));
  assert.deepEqual(resolveSpawnCwd('d_be', { parentDir: parent }), { cwd: path.join(parent, 'd_be') });
  assert.ok(resolveSpawnCwd('../etc', { parentDir: parent }).error);   // traversal blocked by charset
  // `.` and `..` PASS the charset (dots are allowed) → they are caught ONLY by
  // the explicit `=== '.'/'..'` guard. `.` is especially load-bearing: it would
  // otherwise resolve to the workspace root itself and pass containment. Assert
  // the specific error so removing that guard fails this test.
  assert.match(resolveSpawnCwd('.', { parentDir: parent }).error, /invalid project name/);
  assert.match(resolveSpawnCwd('..', { parentDir: parent }).error, /invalid project name/);
  assert.ok(resolveSpawnCwd('nope', { parentDir: parent }).error);     // not found
  assert.ok(resolveSpawnCwd('', { parentDir: parent }).error);        // empty
  fs.rmSync(parent, { recursive: true, force: true });
});

test('resolveSpawnCwd: rejects a project dir that symlinks OUTSIDE the workspace', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.symlinkSync(outside, path.join(parent, 'evil'));
  const r = resolveSpawnCwd('evil', { parentDir: parent });
  assert.ok(r.error && /outside the workspace/.test(r.error));
  fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});

// ── dispatchCommand: the generic registry dispatcher ──────────────────────────

// A registry mirroring commands.json shape. resolveCommand normalises entries, so
// a bare entry without args/needsProject still dispatches.
const REG = {
  ls:      { run: 'spawn.mjs',   args: ['--list'], needsProject: false, minRole: 'member' },
  spawn:   { run: 'spawn.mjs',   args: ['--interactive'], needsProject: true, minRole: 'maintainer' },
  run:     { run: 'run.mjs',     args: [], needsProject: true, minRole: 'maintainer' },
  whisper: { run: 'whisper.mjs', args: [], needsProject: false, minRole: 'admin', wantsReplyText: true },
};

test('dispatchCommand: unknown command → stays silent (no send)', async () => {
  const sent = []; let ran = false;
  await dispatchCommand({ cmd: 'nope', rest: '' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG,
    sendText: async (_c, t) => sent.push(t), runner: async () => { ran = true; return { stdout: '', stderr: '' }; },
  });
  assert.equal(ran, false);
  assert.equal(sent.length, 0);
});

test('dispatchCommand: gates by minRole (member cannot run a maintainer command)', async () => {
  const sent = []; let ran = false;
  await dispatchCommand({ cmd: 'run', rest: 'proj dev' }, { id: '9' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '9': { role: 'member' } } } }, registry: REG,
    sendText: async (_c, t) => sent.push(t), runner: async () => { ran = true; return {}; },
  });
  assert.equal(ran, false);
  assert.match(sent[0], /cần quyền maintainer/);
});

test('dispatchCommand: needsProject → folder is the positional first token, dropped from argv; cwd=project; identity in env', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  fs.mkdirSync(path.join(parent, 'luni'));
  const calls = []; const sent = [];
  await dispatchCommand({ cmd: 'run', rest: 'luni dev --port 3000' }, { id: '7', first_name: 'Thi', username: 'thi' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG,
    parentDir: parent, scriptsDir: '/scripts',
    sendText: async (_c, t) => sent.push(t),
    runner: async (bin, argv, opts) => { calls.push({ bin, argv, cwd: opts.cwd, env: opts.env }); return { stdout: 'served', stderr: '' }; },
  });
  assert.equal(calls[0].bin, process.execPath);            // runs `node <script>`
  assert.deepEqual(calls[0].argv, ['/scripts/run.mjs', 'dev', '--port', '3000']); // folder dropped, args passed
  assert.equal(calls[0].cwd, path.join(parent, 'luni'));   // cwd = the project
  assert.equal(calls[0].env.TELE_FROM_ID, '7');
  assert.equal(calls[0].env.TELE_FROM_ROLE, 'admin');
  assert.equal(calls[0].env.TELE_FROM_NAME, 'Thi');
  assert.equal(sent[0], 'served');                         // stdout relayed verbatim
  fs.rmSync(parent, { recursive: true, force: true });
});

// RFC 07: the replied-to DM text reaches /whisper (capped) but NOT other commands.
test('dispatchCommand: TELE_REPLY_TEXT goes to /whisper (capped), absent for /run, /ls', async () => {
  const cap = 'x'.repeat(400); // > 256 → must be truncated
  const grab = async () => { let env; await dispatchCommand({ cmd: 'whisper', rest: 'hi' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG, scriptsDir: '/s',
    sendText: async () => {}, runner: async (_b, _a, o) => { env = o.env; return { stdout: '', stderr: '' }; },
  }, cap); return env; };
  const wenv = await grab();
  assert.equal(wenv.TELE_REPLY_TEXT.length, 256);          // capped
  assert.equal(wenv.TELE_REPLY_TEXT, 'x'.repeat(256));

  // /ls (no wantsReplyText) → reply text must NOT leak into its child env.
  let lenv;
  await dispatchCommand({ cmd: 'ls', rest: '' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG, scriptsDir: '/s',
    sendText: async () => {}, runner: async (_b, _a, o) => { lenv = o.env; return { stdout: '', stderr: '' }; },
  }, cap);
  assert.equal(lenv.TELE_REPLY_TEXT, '');                  // gated off — no leak to non-whisper children

  // Strongest guard: a STALE/inherited process.env.TELE_REPLY_TEXT must be OVERWRITTEN
  // to '' for a gated command (the ternary always writes the key), never passed through.
  const prev = process.env.TELE_REPLY_TEXT;
  process.env.TELE_REPLY_TEXT = 'inherited-leak #abc';
  try {
    let renv;
    await dispatchCommand({ cmd: 'ls', rest: '' }, { id: '7' }, {
      daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG, scriptsDir: '/s',
      sendText: async () => {}, runner: async (_b, _a, o) => { renv = o.env; return { stdout: '', stderr: '' }; },
    }, null);
    assert.equal(renv.TELE_REPLY_TEXT, ''); // inherited value did NOT pass through
  } finally {
    if (prev === undefined) delete process.env.TELE_REPLY_TEXT; else process.env.TELE_REPLY_TEXT = prev;
  }
});

// handleControlMessages forwards reply_to_message.text down to the dispatcher.
test('handleControlMessages: bridges msg.reply_to_message.text into the whisper child env', async () => {
  let env;
  handleControlMessages([{ message: { text: '/whisper hi', from: { id: '7' }, reply_to_message: { text: 'ack #abc123' } } }], {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG, scriptsDir: '/s',
    sendText: async () => {}, runner: async (_b, _a, o) => { env = o.env; return { stdout: '', stderr: '' }; },
  });
  await new Promise((r) => setTimeout(r, 10)); // dispatch is fire-and-forget
  assert.equal(env.TELE_REPLY_TEXT, 'ack #abc123');
});

test('dispatchCommand: strips teleport secrets from the child env, keeps identity', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  fs.mkdirSync(path.join(parent, 'app'));
  process.env.SNEAKY_SECRET = 'topsecret'; // a stand-in teleport .env key
  let childEnv;
  try {
    await dispatchCommand({ cmd: 'run', rest: 'app build' }, { id: '7' }, {
      daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG,
      parentDir: parent, scriptsDir: '/scripts', secretEnvKeys: ['SNEAKY_SECRET', 'REPORT_BOT_TOKEN'],
      sendText: async () => {},
      runner: async (bin, argv, opts) => { childEnv = opts.env; return { stdout: 'ok', stderr: '' }; },
    });
    assert.equal(childEnv.SNEAKY_SECRET, undefined);     // secret stripped — can't leak to a project's npm script
    assert.equal(childEnv.REPORT_BOT_TOKEN, undefined);  // always stripped
    assert.equal(childEnv.TELE_FROM_ID, '7');            // identity still injected
    assert.equal(childEnv.TELE_FROM_ROLE, 'admin');
  } finally {
    delete process.env.SNEAKY_SECRET;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('dispatchCommand: quoted args survive as one token (not split on inner spaces)', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  fs.mkdirSync(path.join(parent, 'app'));
  const calls = [];
  await dispatchCommand({ cmd: 'run', rest: 'app test --grep "a b c"' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG,
    parentDir: parent, scriptsDir: '/scripts',
    sendText: async () => {},
    runner: async (bin, argv) => { calls.push(argv); return { stdout: 'ok', stderr: '' }; },
  });
  assert.deepEqual(calls[0], ['/scripts/run.mjs', 'test', '--grep', 'a b c']); // 'a b c' is ONE arg
  fs.rmSync(parent, { recursive: true, force: true });
});

test('dispatchCommand: !needsProject → cwd=workspace root, no token dropped', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const calls = [];
  await dispatchCommand({ cmd: 'whisper', rest: '#abc12345 nhắc nhẹ' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG,
    parentDir: parent, scriptsDir: '/scripts',
    sendText: async () => {},
    runner: async (bin, argv, opts) => { calls.push({ argv, cwd: opts.cwd }); return { stdout: 'ok', stderr: '' }; },
  });
  assert.deepEqual(calls[0].argv, ['/scripts/whisper.mjs', '#abc12345', 'nhắc', 'nhẹ']); // nothing dropped
  assert.equal(calls[0].cwd, parent);                      // workspace root
  fs.rmSync(parent, { recursive: true, force: true });
});

test('dispatchCommand: needsProject with a bad folder → error, never runs', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const sent = []; let ran = false;
  await dispatchCommand({ cmd: 'spawn', rest: '../etc' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'maintainer' } } } }, registry: REG,
    parentDir: parent, sendText: async (_c, t) => sent.push(t), runner: async () => { ran = true; return {}; },
  });
  assert.equal(ran, false);
  assert.ok(sent[0].startsWith('❌'));
  fs.rmSync(parent, { recursive: true, force: true });
});

test('dispatchCommand: a failing child relays its own stdout/stderr', async () => {
  const sent = [];
  await dispatchCommand({ cmd: 'ls', rest: '' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG,
    sendText: async (_c, t) => sent.push(t),
    runner: async () => { const e = new Error('exit 1'); e.stdout = 'partial'; e.stderr = 'boom'; throw e; },
  });
  assert.match(sent[0], /partial/);
  assert.match(sent[0], /boom/);
});

test('handleControlMessages: fire-and-forget — returns synchronously, relays only after the child settles', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const sent = [];
  const ctx = {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG,
    parentDir: '/tmp', scriptsDir: '/scripts',
    sendText: async (_c, t) => sent.push(t),
    runner: () => gate.then(() => ({ stdout: 'late', stderr: '' })), // pending until released
  };
  const ret = handleControlMessages([{ message: { text: '/ls', from: { id: '7' } } }], ctx);
  // Sync, non-blocking: a reverted `async … await dispatchCommand` would return a
  // Promise here (and would not have relayed yet anyway) — `undefined` proves the
  // loop is not awaiting the child.
  assert.equal(ret, undefined);
  assert.equal(sent.length, 0);            // child still in flight → nothing relayed
  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['late']);        // relayed once the child finished
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
    catchAllIds: ['-100999'], daemonUserId: '144242180',
  }));
  // daemon chat must be private
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['-100'], daemonUserId: '-100' }), /daemonUserId.* must be a PRIVATE/);
  // missing daemon chat
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['-100'], daemonUserId: '' }), /Missing daemonUserId/);
  // a project chat that is private → error
  assert.throws(() => validateDaemonConfig({ projectsConfig: { bad: { chatId: '144242180' } }, catchAllIds: ['-100'], daemonUserId: '1' }), /project 'bad' chatId must be a GROUP/);
  // catch-all private → error
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['144242180'], daemonUserId: '1' }), /_default.chatId.* must be a GROUP/);
  // reserved _config / _default keys are skipped during project iteration
  assert.doesNotThrow(() => validateDaemonConfig({ projectsConfig: { _config: { daemonUserId: '1' }, _default: { chatId: '-100' }, ok: { chatId: '-101' } }, catchAllIds: ['-100'], daemonUserId: '1' }));
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

// ── RFC 08: handleControlMessages rewrites a group `/dm <cmd>` to `/<cmd>` ─────
test('handleControlMessages: /dm ls from a group dispatches the stripped /ls', async () => {
  const calls = [];
  handleControlMessages(
    [{ update_id: 1, message: { text: '/dm ls', from: { id: 7 }, chat: { id: -100, type: 'supergroup' } } }],
    {
      daemonUserId: '7', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } },
      registry: REG, scriptsDir: '/s', sendText: async () => {},
      runner: async (_bin, argv) => { calls.push(argv); return { stdout: '', stderr: '' }; },
    },
  );
  await new Promise((r) => setTimeout(r, 30)); // dispatch is fire-and-forget
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['/s/spawn.mjs', '--list']); // /dm ls → /ls → spawn.mjs --list
});

test('handleControlMessages: bare /dm from a group is a no-op (nothing dispatched)', async () => {
  let ran = false;
  handleControlMessages(
    [{ update_id: 2, message: { text: '/dm', from: { id: 7 }, chat: { id: -100, type: 'supergroup' } } }],
    {
      daemonUserId: '7', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } },
      registry: REG, scriptsDir: '/s', sendText: async () => {},
      runner: async () => { ran = true; return { stdout: '', stderr: '' }; },
    },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, false);
});
