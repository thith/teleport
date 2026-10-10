import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseDaemonCommand, resolveSpawnCwd, dispatchCommand, handleControlMessages,
  validateDaemonConfig, resolveSenderRole, acquireSingleton, releaseSingleton, daemonStatus,
  reloadDaemonState, readJsonStrict,
  prLinksOnly, takeMergeButton, handlePrLinks, handleMergeButton, startupGreeting, gitShortHead,
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
  instruct:{ run: 'instruct.mjs',args: [], needsProject: false, minRole: 'admin', wantsReplyText: true },
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
  fs.mkdirSync(path.join(parent, 'acmebot'));
  const calls = []; const sent = [];
  await dispatchCommand({ cmd: 'run', rest: 'acmebot dev --port 3000' }, { id: '7', first_name: 'Alice', username: 'alice' }, {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG,
    parentDir: parent, scriptsDir: '/scripts',
    sendText: async (_c, t) => sent.push(t),
    runner: async (bin, argv, opts) => { calls.push({ bin, argv, cwd: opts.cwd, env: opts.env }); return { stdout: 'served', stderr: '' }; },
  });
  assert.equal(calls[0].bin, process.execPath);            // runs `node <script>`
  assert.deepEqual(calls[0].argv, ['/scripts/run.mjs', 'dev', '--port', '3000']); // folder dropped, args passed
  assert.equal(calls[0].cwd, path.join(parent, 'acmebot'));   // cwd = the project
  assert.equal(calls[0].env.TELE_FROM_ID, '7');
  assert.equal(calls[0].env.TELE_FROM_ROLE, 'admin');
  assert.equal(calls[0].env.TELE_FROM_NAME, 'Alice');
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

// A long agent DM reply becomes a `.md` document whose text rides in `caption`
// (not `text`) — reply-to-continue must still find the #hash there (RFC 13 M1).
test('handleControlMessages: falls back to reply_to_message.caption when .text is absent', async () => {
  let env;
  handleControlMessages([{ message: { text: '/instruct go on', from: { id: '7' }, reply_to_message: { caption: '📩 báo cáo dài … #abc123' } } }], {
    daemonUserId: '1', projectsConfig: { _default: { roles: { '7': { role: 'admin' } } } }, registry: REG, scriptsDir: '/s',
    sendText: async () => {}, runner: async (_b, _a, o) => { env = o.env; return { stdout: '', stderr: '' }; },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(env.TELE_REPLY_TEXT, '📩 báo cáo dài … #abc123'); // caption bridged, not dropped
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
    projectsConfig: { d_be: { chatId: '-1001' }, acmebot: { chatId: '-1002' } },
    catchAllIds: ['-100999'], daemonUserId: '100000001',
  }));
  // daemon chat must be private
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['-100'], daemonUserId: '-100' }), /daemonUserId.* must be a PRIVATE/);
  // missing daemon chat
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['-100'], daemonUserId: '' }), /Missing daemonUserId/);
  // a project chat that is private → error
  assert.throws(() => validateDaemonConfig({ projectsConfig: { bad: { chatId: '100000001' } }, catchAllIds: ['-100'], daemonUserId: '1' }), /project 'bad' chatId must be a GROUP/);
  // catch-all private → error
  assert.throws(() => validateDaemonConfig({ projectsConfig: {}, catchAllIds: ['100000001'], daemonUserId: '1' }), /_default.chatId.* must be a GROUP/);
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

// ── /reload (in-process built-in) ─────────────────────────────────────────────
const ADMIN_CFG = { _default: { roles: { '7': { role: 'admin' }, '9': { role: 'maintainer' } } } };

test('dispatchCommand /reload: admin → calls reload, reports count; never runs a child', async () => {
  const sent = []; let ran = false; let reloaded = 0;
  await dispatchCommand({ cmd: 'reload', rest: '' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: ADMIN_CFG, registry: REG,
    sendText: async (_c, t) => sent.push(t), runner: async () => { ran = true; return {}; },
    reload: () => { reloaded++; return { registry: { a: {}, b: {}, c: {} }, projectsConfig: ADMIN_CFG, ownerChanged: false }; },
  });
  assert.equal(reloaded, 1);
  assert.equal(ran, false);
  assert.match(sent[0], /3 lệnh/);
  assert.doesNotMatch(sent[0], /daemonUserId/);
});

test('dispatchCommand /reload: maintainer refused; config error keeps old + reports; owner change warned', async () => {
  const sent = []; let reloaded = 0;
  const ctx = (reload) => ({ daemonUserId: '1', projectsConfig: ADMIN_CFG, registry: REG, sendText: async (_c, t) => sent.push(t), reload });
  await dispatchCommand({ cmd: 'reload', rest: '' }, { id: '9' }, ctx(() => { reloaded++; return {}; }));
  assert.equal(reloaded, 0);
  assert.match(sent[0], /cần quyền admin/);
  await dispatchCommand({ cmd: 'reload', rest: '' }, { id: '7' }, ctx(() => ({ error: 'bad json' })));
  assert.match(sent[1], /giữ cấu hình cũ — bad json/);
  await dispatchCommand({ cmd: 'reload', rest: '' }, { id: '7' }, ctx(() => ({ registry: {}, ownerChanged: true })));
  assert.match(sent[2], /restart daemon/);
});

test('dispatchCommand /reload: a registry entry named reload cannot shadow the built-in', async () => {
  let ran = false; let reloaded = 0;
  await dispatchCommand({ cmd: 'reload', rest: '' }, { id: '7' }, {
    daemonUserId: '1', projectsConfig: ADMIN_CFG, registry: { ...REG, reload: { run: 'evil.mjs', minRole: 'public' } },
    sendText: async () => {}, runner: async () => { ran = true; return {}; },
    reload: () => { reloaded++; return { registry: {} }; },
  });
  assert.equal(ran, false);
  assert.equal(reloaded, 1);
});

test('reloadDaemonState: returns fresh state; invalid config → { error } (old state kept by caller); owner change flagged', () => {
  const good = { _default: { chatId: '-100' } };
  const base = { daemonUserId: '5', loadRegistry: () => ({ x: {} }), resolveOwner: () => '5', resolveCatchAll: () => ['-100'] };
  const r = reloadDaemonState({ ...base, readConfig: () => good });
  assert.deepEqual(r, { projectsConfig: good, registry: { x: {} }, ownerChanged: false });
  let seenCfg;
  reloadDaemonState({ ...base, readConfig: () => good, loadRegistry: (cfg) => { seenCfg = cfg; return { x: {} }; } });
  assert.equal(seenCfg, good, 'registry must be built from the NEW projects.json (_commands overrides)');
  assert.match(reloadDaemonState({ ...base, readConfig: () => { throw new Error('Unexpected token'); } }).error, /Unexpected token/);
  assert.ok(reloadDaemonState({ ...base, readConfig: () => good, resolveCatchAll: () => ['123'] }).error); // catch-all must be a group
  assert.equal(reloadDaemonState({ ...base, readConfig: () => good, resolveOwner: () => '6' }).ownerChanged, true);
});

test('readJsonStrict: throws on missing / corrupt / non-object (no silent {} like readProjectsConfig)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rjs-'));
  const f = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  assert.deepEqual(readJsonStrict(f('ok.json', '{"a":1}')), { a: 1 });
  assert.throws(() => readJsonStrict(f('bad.json', '{"a":'), 'projects.json'), /projects\.json:/);
  assert.throws(() => readJsonStrict(f('arr.json', '[1]')), /not a JSON object/);
  assert.throws(() => readJsonStrict(path.join(dir, 'missing.json')), /ENOENT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reloadDaemonState: a corrupt projects.json (strict reader) or an empty registry keeps the old state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rld-'));
  const bad = path.join(dir, 'projects.json'); fs.writeFileSync(bad, '{ broken');
  const base = { daemonUserId: '5', loadRegistry: () => ({ x: {} }), resolveOwner: () => '5', resolveCatchAll: () => [] };
  assert.match(reloadDaemonState({ ...base, readConfig: () => readJsonStrict(bad, 'projects.json') }).error, /projects\.json/);
  assert.match(reloadDaemonState({ ...base, readConfig: () => ({}), loadRegistry: () => ({}) }).error, /registry is empty/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Paste a PR link → preview + buttons ───────────────────────────────────────
const MREG = { merge: { run: 'merge.mjs', args: [], needsProject: false, minRole: 'admin' } };
const OWNER_CFG = { _default: { roles: { '1': { role: 'admin' }, '9': { role: 'member' } } } };
const L1 = 'https://github.com/thith/teleport/pull/3';

test('prLinksOnly: only messages made of PR links (deduped); anything else → null', () => {
  assert.deepEqual(prLinksOnly(` ${L1} `), [L1]);
  assert.deepEqual(prLinksOnly(`${L1}\n${L1} https://github.com/a/b/pull/9/files`), [L1, 'https://github.com/a/b/pull/9/files']);
  assert.equal(prLinksOnly(`xem giúp ${L1}`), null, 'text around the link → not a merge request');
  assert.equal(prLinksOnly('https://github.com/a/b/issues/3'), null);
  assert.equal(prLinksOnly('https://evil.com/a/b/pull/3'), null);
  assert.equal(prLinksOnly(''), null);
  assert.equal(prLinksOnly(undefined), null);
});

test('takeMergeButton: one-shot (a double tap cannot merge twice) and expires', () => {
  const store = new Map([['t1', { links: [L1], createdAt: 1000 }], ['old', { links: [], createdAt: 0 }]]);
  assert.deepEqual(takeMergeButton('t1', { now: 2000, store, ttlMs: 5000 }).links, [L1]);
  assert.equal(takeMergeButton('t1', { now: 2000, store, ttlMs: 5000 }), null);
  store.set('t2', { links: [L1], createdAt: 0 });
  assert.equal(takeMergeButton('t2', { now: 10_000, store, ttlMs: 5000 }), null, 'expired');
  assert.equal(store.size, 0, 'expired entries swept');
});

test('handlePrLinks: runs merge.mjs --preview (no merge) and offers buttons only when ready', async () => {
  const calls = [], buttons = [], texts = [], store = new Map();
  const ctx = (runner) => ({ daemonUserId: '1', projectsConfig: OWNER_CFG, registry: MREG, store, scriptsDir: '/s', parentDir: '/w',
    sendText: async (c, t) => texts.push(t), sendButtons: async (c, t, b) => buttons.push({ c, t, b }), runner });
  await handlePrLinks([L1], { chat: { id: 1 }, from: { id: 1 } }, ctx(async (bin, argv, opts) => { calls.push({ argv, opts }); return { stdout: '🔎 PR #3 ready' }; }));
  assert.deepEqual(calls[0].argv, ['/s/merge.mjs', L1, '--preview']);
  // configured spec.args (e.g. a deployment that forces --rebase) are previewed too
  const c2 = [];
  await handlePrLinks([L1], { chat: { id: 1 }, from: { id: 1 } }, { ...ctx(async (b, argv) => { c2.push(argv); return { stdout: 'ok' }; }), registry: { merge: { ...MREG.merge, args: ['--rebase'] } }, store: new Map(), sendButtons: async () => {} });
  assert.deepEqual(c2[0], ['/s/merge.mjs', '--rebase', L1, '--preview']);
  assert.equal(calls[0].opts.cwd, '/w');
  assert.equal(buttons.length, 1);
  assert.match(buttons[0].t, /🔎 PR #3 ready[\s\S]*Merge or close this PR\?/);
  assert.deepEqual(buttons[0].b.map((x) => x.text), ['✅ Merge', '🚫 Close', '✖ Huỷ']);
  assert.match(buttons[0].b[0].callback_data, /^mg:[0-9a-f]{16}$/);
  assert.equal(store.size, 1);
  // not mergeable AND not closable → plain text, no buttons, nothing stored
  await handlePrLinks([L1], { chat: { id: 1 }, from: { id: 1 } }, ctx(async () => { throw Object.assign(new Error('x'), { stdout: '❌ PR #3: draft' }); }));
  assert.equal(buttons.length, 1);
  assert.match(texts.at(-1), /draft/);
  assert.equal(store.size, 1);
  // non-admin → refused, preview never runs
  let ran = false;
  await handlePrLinks([L1], { chat: { id: 9 }, from: { id: 9 } }, ctx(async () => { ran = true; return { stdout: '' }; }));
  assert.equal(ran, false);
  assert.match(texts.at(-1), /cần quyền admin/);
});

test('handleMergeButton: Merge dispatches /merge <links> once; Cancel and expired never merge', async () => {
  const store = new Map([['aaaaaaaaaaaaaaaa', { links: [L1], createdAt: Date.now() }], ['bbbbbbbbbbbbbbbb', { links: [L1], createdAt: Date.now() }]]);
  const take = (t) => takeMergeButton(t, { store });
  const ev = [], dispatched = [];
  const ctx = { answerButton: async (id, t) => ev.push(`answer:${t || ''}`), editButtonsMessage: async (c, m, t) => ev.push(`edit:${t.split('\n').pop()}`) };
  const cq = (data) => ({ id: 'q', data, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 5, text: 'preview' } });
  const dispatch = async (parsed) => dispatched.push(parsed);
  await handleMergeButton(cq('mg:aaaaaaaaaaaaaaaa'), ctx, { take, dispatch });
  assert.deepEqual(dispatched, [{ cmd: 'merge', rest: L1 }]);
  await handleMergeButton(cq('mg:aaaaaaaaaaaaaaaa'), ctx, { take, dispatch }); // double tap
  assert.equal(dispatched.length, 1);
  assert.ok(ev.some((e) => /Hết hạn/.test(e)));
  await handleMergeButton(cq('mc:bbbbbbbbbbbbbbbb'), ctx, { take, dispatch });
  assert.equal(dispatched.length, 1);
  assert.ok(ev.includes('edit:✖ Đã huỷ.'));
  await handleMergeButton(cq('evil'), ctx, { take, dispatch });
  assert.equal(dispatched.length, 1);
});

test('handleControlMessages: a private link-only message → preview with buttons; in a group or with extra text → nothing', async () => {
  const buttons = [];
  const ctx = { daemonUserId: '1', projectsConfig: OWNER_CFG, registry: MREG, sendText: async () => {}, store: new Map(),
    sendButtons: async (c, t, b) => buttons.push(t), runner: async () => ({ stdout: 'ok' }) };
  handleControlMessages([{ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: L1 } }], ctx);
  handleControlMessages([{ message: { chat: { id: -5, type: 'supergroup' }, from: { id: 1 }, text: L1 } }], ctx);
  handleControlMessages([{ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: `see ${L1}` } }], ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(buttons.length, 1);
});

test('handlePrLinks: a long batch preview is sent separately; the button message stays short', async () => {
  const texts = [], buttons = [];
  const long = '🔎 PR\n'.repeat(800);
  await handlePrLinks([L1], { chat: { id: 1 }, from: { id: 1 } }, { daemonUserId: '1', projectsConfig: OWNER_CFG, registry: MREG, store: new Map(),
    sendText: async (c, t) => texts.push(t), sendButtons: async (c, t) => buttons.push(t), runner: async () => ({ stdout: long }) });
  assert.equal(texts[0], long.trim());
  assert.ok(buttons[0].length < 200);
  assert.match(buttons[0], /details above/);
});

test('partitionOrphans: a link-only private DM is never an orphan (reaches the cache even with no group ids)', async () => {
  const { partitionOrphans } = await import('./tele-listen.mjs');
  const u = { update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: L1 } };
  const plain = { update_id: 2, message: { message_id: 2, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'hello' } };
  const r = partitionOrphans([u, plain], []);
  assert.deepEqual(r.nonOrphan.map((x) => x.update_id), [1]);
  assert.deepEqual(r.orphans.map((o) => o.update.update_id), [2]);
});

test('fetchUpdates asks for message, edited_message and callback_query explicitly', async () => {
  const { fetchUpdates, ALLOWED_UPDATES } = await import('./tele-listen.mjs');
  assert.deepEqual(ALLOWED_UPDATES, ['message', 'edited_message', 'callback_query']);
  const orig = globalThis.fetch; let url;
  globalThis.fetch = async (u) => { url = u; return { ok: true, json: async () => ({ ok: true, result: [] }) }; };
  try { await fetchUpdates('T', 5); } finally { globalThis.fetch = orig; }
  assert.match(decodeURIComponent(url), /allowed_updates=\["message","edited_message","callback_query"\]/);
});

test('startupGreeting / gitShortHead: the owner hears about every (re)start, with the code version', () => {
  assert.equal(startupGreeting({ pid: 42, commit: 'abc1234', commands: 17 }), '🟢 Teleport daemon đã chạy · pid 42 · code abc1234 · 17 lệnh. Gõ /help để xem lệnh.');
  assert.doesNotMatch(startupGreeting({ pid: 42, commit: null, commands: 3 }), /code/);
  assert.equal(gitShortHead(() => 'deadbee\n'), 'deadbee');
  assert.equal(gitShortHead(() => { throw new Error('not a repo'); }), null);
});

test('handlePrLinks: not mergeable but still open → only [Close] [Huỷ]; Merge press on it is refused; Close dispatches --close', async () => {
  const buttons = [], store = new Map();
  const runner = async (bin, argv) => { if (argv.includes('--close')) return { stdout: 'open' }; throw Object.assign(new Error('x'), { stdout: '❌ conflicts' }); };
  await handlePrLinks([L1], { chat: { id: 1 }, from: { id: 1 } }, { daemonUserId: '1', projectsConfig: OWNER_CFG, registry: MREG, store,
    sendText: async () => {}, sendButtons: async (c, t, b) => buttons.push({ t, b }), runner, scriptsDir: '/s', parentDir: '/w' });
  assert.deepEqual(buttons[0].b.map((x) => x.text), ['🚫 Close', '✖ Huỷ']);
  assert.match(buttons[0].t, /❌ conflicts[\s\S]*Can't merge — close this PR without merging\?/);
  const tok = buttons[0].b[0].callback_data.slice(3);
  const dispatched = [];
  const ctx = { answerButton: async () => {}, editButtonsMessage: async () => {} };
  const take = (t) => takeMergeButton(t, { store });
  const cq = (data) => ({ id: 'q', data, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 5, text: 'p' } });
  await handleMergeButton(cq(`mg:${tok}`), ctx, { take: (t) => ({ ...store.get(t), _: take }), dispatch: async (p) => dispatched.push(p) });
  assert.equal(dispatched.length, 0, 'forged Merge on a close-only preview is refused');
  await handleMergeButton(cq(`cl:${tok}`), ctx, { take, dispatch: async (p) => dispatched.push(p) });
  assert.deepEqual(dispatched, [{ cmd: 'merge', rest: `${L1} --close` }]);
});

test('a deployment arg --close never turns Merge into close (preview and dispatch)', async () => {
  const argvs = [], buttons = [], store = new Map();
  const reg = { merge: { run: 'merge.mjs', args: ['--close'], needsProject: false, minRole: 'admin' } };
  await handlePrLinks([L1], { chat: { id: 1 }, from: { id: 1 } }, { daemonUserId: '1', projectsConfig: OWNER_CFG, registry: reg, store,
    sendText: async () => {}, sendButtons: async (c, t, b) => buttons.push(b), runner: async (bin, argv) => { argvs.push(argv); return { stdout: 'ok' }; }, scriptsDir: '/s', parentDir: '/w' });
  assert.deepEqual(argvs[0], ['/s/merge.mjs', L1, '--preview'], 'merge preview without the deployment --close');
  const tok = buttons[0][0].callback_data.slice(3);
  let seen;
  await handleMergeButton({ id: 'q', data: `mg:${tok}`, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 1, text: 'p' } },
    { registry: reg, answerButton: async () => {}, editButtonsMessage: async () => {} },
    { take: (t) => takeMergeButton(t, { store }), dispatch: async (p, f, c) => { seen = { p, args: c.registry.merge.args }; } });
  assert.deepEqual(seen, { p: { cmd: 'merge', rest: L1 }, args: [] });
});

test('the --close strip also holds when merge is an alias to a command with --close', async () => {
  const store = new Map([['cccccccccccccccc', { links: [L1], createdAt: Date.now(), canMerge: true }]]);
  const reg = { merge: { alias: 'closer' }, closer: { run: 'merge.mjs', args: ['--close', '--rebase'], minRole: 'admin' } };
  let seen;
  await handleMergeButton({ id: 'q', data: 'mg:cccccccccccccccc', from: { id: 1 }, message: { chat: { id: 1 }, message_id: 1, text: 'p' } },
    { registry: reg, answerButton: async () => {}, editButtonsMessage: async () => {} },
    { take: (t) => takeMergeButton(t, { store }), dispatch: async (p, f, c) => { seen = c.registry.merge; } });
  assert.deepEqual(seen.args, ['--rebase']);
  assert.equal(seen.run, 'merge.mjs');
  assert.equal(seen.alias, undefined);
});
