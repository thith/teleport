import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Isolate the persona pin store so `--list` persona mapping DERIVES instead of
// reading machine-local pins (resolved at call-time from TELE_PERSONA_STORE).
process.env.TELE_PERSONA_STORE = path.join(os.tmpdir(), `teleport-persona-store-spawn-${process.pid}.jsonl`);
// No real systemd-run probe in unit tests (escapeServiceCgroup is tested with injected probes).
process.env.TELEPORT_NO_SCOPE = '1';
import { buildSpawnPlan, genSessionSeed, runSpawn, childLaunch, loginSeedEnv, wrapInLoginShell, scrubClaudeEnv, SEED_PATH, hasBinary, screenSessionExists, normalizeSessionName, parseScreenSessions, listSpawnSessions, resolveKillId, resolveAttachId, resolveAttachTarget, formatSessionList, resolveMode, SPAWN_PROMPT, PERMISSION_MODES, DEFAULT_PERMISSION_MODE, USAGE, personaByHashtag, gracefulKill, KILL_GRACE_MS, RESUME_PROMPT, resolveResumeSession, checkResumePreflight, findTranscriptDirs, checkPidKillAuth, resolveKillPid, normalizeAgentName, matchProcsByName, appendKillAudit, acquireResumeLock, acquireResumeFileLock, performResume, checkRestartTarget, checkRestartPreflight, RESUME_LOCK_STALE_MS, resumeLockSecret, inSystemdService, escapeServiceCgroup, SYSTEMD_SCOPE_PREFIX } from './spawn.mjs';
import fs from 'node:fs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { personaForConvo } from './persona.mjs';

// A fixed UUID for deterministic seed tests (not a real session — never executed).
const FIXED_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
const FIXED_CONVO = uuidToConvoInt(FIXED_UUID);
const FIXED_NAME = `tele-${shortConvoHash(FIXED_CONVO)}`;

test('SPAWN_PROMPT is the hard-coded greeting (no task passed)', () => {
  assert.equal(SPAWN_PROMPT, 'Find and read process.md and review-guide.md if present in this project, then Telegram me and wait for instructions');
});

test('runSpawn: passes cwd through to the spawn call (sibling-project targeting)', () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {}, pid: 4242 }; };
  // headless plan
  const planH = buildSpawnPlan();
  const rH = runSpawn(planH, { cwd: '/work/d_be', spawnFn: fakeSpawn });
  assert.equal(calls[0].opts.cwd, '/work/d_be');
  assert.equal(calls[0].opts.detached, true);
  assert.equal(rH.pid, 4242);
  // interactive plan
  const planI = buildSpawnPlan({ interactive: true, seed: genSessionSeed(() => FIXED_UUID) });
  runSpawn(planI, { cwd: '/work/acmebot', spawnFn: fakeSpawn });
  assert.equal(calls[1].opts.cwd, '/work/acmebot');
});

test('runSpawn: no cwd → no cwd option (inherit)', () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push(opts); return { unref() {} }; };
  runSpawn(buildSpawnPlan(), { spawnFn: fakeSpawn });
  assert.equal('cwd' in calls[0], false);
});

test('loginSeedEnv: bare seed only — nothing Claude injected can survive it', () => {
  const env = loginSeedEnv({
    HOME: '/home/alice', SHELL: '/bin/zsh', TERM: 'xterm', PATH: '/inherited/bin', LANG: '',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_EFFORT: 'medium',
    SOME_USER_VAR: 'x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'SHELL', 'TELEPORT_SPAWN', 'TERM'].sort());
  assert.equal(env.PATH, SEED_PATH);          // bootstrap only — the rc files rebuild the real PATH
  assert.equal(env.LANG, undefined);          // empty values are not seeded
});

test('wrapInLoginShell: login+interactive shell, argv passed POSITIONALLY (no re-parsing)', () => {
  const seed = 'line1\n"quoted" `backtick` $VAR\nline3';
  const cmd = wrapInLoginShell(['claude', '-p', seed], { SHELL: '/bin/zsh' });
  assert.deepEqual(cmd.slice(0, 4), ['/bin/zsh', '-lic', 'exec "$@"', 'teleport-spawn']);
  // The prompt stays ONE argv item, byte-identical — never interpolated into the -c string.
  assert.equal(cmd.at(-1), seed);
  assert.equal(cmd[2].includes(seed), false);
  // `-i` is required: zsh only sources ~/.zshrc for interactive shells.
  assert.match(cmd[1], /i/);
});

test('wrapInLoginShell: no usable $SHELL → null (caller falls back)', () => {
  assert.equal(wrapInLoginShell(['claude'], {}), null);
  assert.equal(wrapInLoginShell(['claude'], { SHELL: 'zsh' }), null);   // must be an absolute path
});

test('scrubClaudeEnv: fallback scrubs by PREFIX so a future rename cannot sneak through', () => {
  const env = scrubClaudeEnv({
    PATH: '/bin', CLAUDECODE: '1', CLAUDE_PID: '1', CLAUDE_EFFORT: 'medium',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SOME_FUTURE_MARKER: '1', CLAUDE_PLUGIN_DATA: '/x',
  });
  assert.deepEqual(Object.keys(env), ['PATH']);
});

test('childLaunch: wraps when $SHELL is usable, scrubs when it is not', () => {
  const poisoned = { SHELL: '/bin/zsh', HOME: '/h', CLAUDE_CODE_CHILD_SESSION: '1' };
  const wrapped = childLaunch(['claude', '-p', 'hi'], poisoned);
  assert.equal(wrapped.command[0], '/bin/zsh');
  assert.equal('CLAUDE_CODE_CHILD_SESSION' in wrapped.env, false);
  const bare = childLaunch(['claude', '-p', 'hi'], { HOME: '/h', CLAUDE_CODE_CHILD_SESSION: '1' });
  assert.deepEqual(bare.command, ['claude', '-p', 'hi']);
  assert.equal('CLAUDE_CODE_CHILD_SESSION' in bare.env, false);
});

test('runSpawn: both modes launch through the login shell with the seed env', () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {}, pid: 7 }; };
  runSpawn(buildSpawnPlan(), { spawnFn: fakeSpawn });                                              // headless
  runSpawn(buildSpawnPlan({ interactive: true, seed: genSessionSeed(() => FIXED_UUID) }), { cwd: '/work/acmebot', spawnFn: fakeSpawn }); // interactive
  for (const c of calls) {
    assert.equal(c.cmd, process.env.SHELL);
    assert.deepEqual(c.args.slice(0, 3), ['-lic', 'exec "$@"', 'teleport-spawn']);
    assert.equal('CLAUDE_CODE_CHILD_SESSION' in c.opts.env, false);
    assert.equal(c.opts.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, undefined); // clean env is enough
  }
  assert.equal(calls[0].args[3], 'claude');                        // headless: shell execs claude itself
  assert.ok(calls[0].args.includes('-p'));                         // …with its args intact
  assert.equal(calls[1].args[3], 'screen');                        // interactive still goes through screen
  assert.equal(calls[1].opts.cwd, '/work/acmebot');                   // cwd still wins
});

test('buildSpawnPlan headless (default): claude -p <prompt>, no session/teardown', () => {
  const p = buildSpawnPlan();
  assert.equal(p.mode, 'headless');
  assert.deepEqual(p.command, ['claude', '--permission-mode', 'auto', '-p', SPAWN_PROMPT]);
  assert.equal(p.sessionName, null);
  assert.equal(p.teardown, null);
});

test('buildSpawnPlan interactive: explicit name (no seed) → screen -dmS <name> claude <prompt>, no -p, no --session-id', () => {
  const p = buildSpawnPlan({ interactive: true, sessionName: 'tele-abc123' });
  assert.equal(p.mode, 'interactive');
  assert.deepEqual(p.command, ['screen', '-U', '-dmS', 'tele-abc123', 'claude', '--permission-mode', 'auto', SPAWN_PROMPT]);
  assert.equal(p.teardown, 'screen -S tele-abc123 -X quit');
  assert.equal(p.sessionId, null);
  // CRUCIAL: interactive must NOT use -p (that would bill as SDK pool, not subscription).
  assert.ok(!p.command.includes('-p'));
  assert.ok(!p.command.includes('--session-id'));
});

test('buildSpawnPlan interactive auto (seed): forces --session-id and names screen after the convo hashtag (RFC 03)', () => {
  const p = buildSpawnPlan({ interactive: true, seed: genSessionSeed(() => FIXED_UUID) });
  // Screen name == tele-<hashtag>, matching the #tag the agent shows on Telegram.
  assert.equal(p.sessionName, FIXED_NAME);
  assert.equal(p.sessionId, FIXED_UUID);
  assert.deepEqual(p.command, ['screen', '-U', '-dmS', FIXED_NAME, 'claude', '--permission-mode', 'auto', '--session-id', FIXED_UUID, SPAWN_PROMPT]);
  assert.equal(p.teardown, `screen -S ${FIXED_NAME} -X quit`);
  assert.ok(!p.command.includes('-p')); // still subscription billing
});

test('buildSpawnPlan interactive: auto-seeds when neither name nor seed given (real UUID → forced --session-id)', () => {
  const p = buildSpawnPlan({ interactive: true });
  assert.match(p.sessionName, /^tele-([a-j]\d{7}|t\d+)$/); // shortConvoHash form
  assert.match(p.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // The forced session-id is wired into the command and the name is the screen target.
  assert.ok(p.command.includes('--session-id'));
  assert.equal(p.command[p.command.indexOf('--session-id') + 1], p.sessionId);
  assert.equal(p.command[3], p.sessionName);
});

test('buildSpawnPlan interactive: explicit name + seed → name wins, seed id DROPPED (name⇄hashtag invariant)', () => {
  // A seed is an atomic name+UUID pair; if the name is overridden, forcing the
  // seed's UUID would make the screen name disagree with the child's hashtag.
  const p = buildSpawnPlan({ interactive: true, sessionName: 'tele-custom', seed: genSessionSeed(() => FIXED_UUID) });
  assert.equal(p.sessionName, 'tele-custom'); // explicit name wins
  assert.equal(p.sessionId, null);            // seed UUID dropped — NOT forced
  assert.ok(!p.command.includes('--session-id'));
  assert.deepEqual(p.command, ['screen', '-U', '-dmS', 'tele-custom', 'claude', '--permission-mode', 'auto', SPAWN_PROMPT]);
});

test('buildSpawnPlan interactive: explicit name + explicit valid sessionId → forced (deliberate advanced override)', () => {
  const p = buildSpawnPlan({ interactive: true, sessionName: 'tele-x', sessionId: FIXED_UUID });
  assert.equal(p.sessionName, 'tele-x');
  assert.equal(p.sessionId, FIXED_UUID);
  assert.ok(p.command.includes('--session-id'));
  assert.equal(p.command[p.command.indexOf('--session-id') + 1], FIXED_UUID);
});

test('buildSpawnPlan interactive: rejects a non-UUID forced session id', () => {
  assert.throws(() => buildSpawnPlan({ interactive: true, sessionName: 'tele-x', sessionId: 'not-a-uuid' }), /invalid session id/);
});

test('buildSpawnPlan interactive: rejects an unsafe session name (shell-safety)', () => {
  assert.throws(() => buildSpawnPlan({ interactive: true, sessionName: 'a; rm -rf /' }), /unsafe session name/);
  assert.throws(() => buildSpawnPlan({ interactive: true, sessionName: '$(whoami)' }), /unsafe session name/);
  // Safe names pass.
  assert.ok(buildSpawnPlan({ interactive: true, sessionName: 'tele-abc_1.2' }));
});

// --- permission mode (always set on spawn; default auto) ------------------

test('buildSpawnPlan: default permission mode is auto on BOTH headless and interactive', () => {
  assert.equal(DEFAULT_PERMISSION_MODE, 'auto');
  const h = buildSpawnPlan().command;
  assert.equal(h[h.indexOf('--permission-mode') + 1], 'auto');
  const i = buildSpawnPlan({ interactive: true, sessionName: 'tele-x' }).command;
  assert.equal(i[i.indexOf('--permission-mode') + 1], 'auto');
});

test('buildSpawnPlan: a custom permissionMode is threaded into the command', () => {
  const h = buildSpawnPlan({ permissionMode: 'plan' }).command;
  assert.deepEqual(h, ['claude', '--permission-mode', 'plan', '-p', SPAWN_PROMPT]);
  const i = buildSpawnPlan({ interactive: true, sessionName: 'tele-x', permissionMode: 'default' }).command;
  assert.deepEqual(i, ['screen', '-U', '-dmS', 'tele-x', 'claude', '--permission-mode', 'default', SPAWN_PROMPT]);
});

test('buildSpawnPlan: rejects an unknown permission mode', () => {
  assert.throws(() => buildSpawnPlan({ permissionMode: 'yolo' }), /invalid permission mode/);
});

test('resolveMode: absent → auto; valid value passes through; missing/flag value → null', () => {
  assert.equal(resolveMode([]), DEFAULT_PERMISSION_MODE);
  assert.equal(resolveMode(['-i', '--mode', 'plan']), 'plan');
  assert.equal(resolveMode(['--mode', 'bypassPermissions']), 'bypassPermissions');
  assert.equal(resolveMode(['--mode']), null);            // flag present, value missing
  assert.equal(resolveMode(['--mode', '--interactive']), null); // next token is a flag
  // Assignment form `--mode=<value>` is honored too (so it never silently falls
  // back to the auto default — that would over-grant autonomy).
  assert.equal(resolveMode(['--mode=plan']), 'plan');
  assert.equal(resolveMode(['-i', '--mode=bypassPermissions']), 'bypassPermissions');
  assert.equal(resolveMode(['--mode=']), null);           // assignment with empty value
  // Ambiguous: repeated/conflicting --mode → null (refuse to silently pick one,
  // which could over-grant autonomy). Caller turns null into a usage error.
  assert.equal(resolveMode(['--mode', 'plan', '--mode=auto']), null);
  assert.equal(resolveMode(['--mode=plan', '--mode=plan']), null); // even same value twice
  assert.equal(resolveMode(['--mode', '--mode=plan']), null);
  // Every CLI choice is recognized by buildSpawnPlan's validation.
  for (const m of PERMISSION_MODES) assert.ok(buildSpawnPlan({ permissionMode: m }));
  // resolveMode passes an unknown mode through VERBATIM (it doesn't validate) —
  // so the main() guard's `!PERMISSION_MODES.includes(...)` clause is load-bearing:
  // it's what turns `--mode yolo` into a clean usage error instead of an uncaught
  // buildSpawnPlan throw. This test documents that division of responsibility.
  assert.equal(resolveMode(['--mode', 'yolo']), 'yolo');
  assert.equal(PERMISSION_MODES.includes('yolo'), false);
});

test('genSessionSeed: name = tele-<hashtag of uuidToConvoInt(uuid)>, injectable uuid', () => {
  const seed = genSessionSeed(() => FIXED_UUID);
  assert.equal(seed.sessionId, FIXED_UUID);
  assert.equal(seed.convoId, FIXED_CONVO);
  assert.equal(seed.sessionName, FIXED_NAME);
  // Default (real UUID) still yields a well-formed name + convoId.
  const live = genSessionSeed();
  assert.match(live.sessionName, /^tele-([a-j]\d{7}|t\d+)$/);
  assert.ok(Number.isSafeInteger(live.convoId) && live.convoId > 0);
});

test('screenSessionExists: matches a session in `screen -ls` output, else false', () => {
  const lsOut = 'There is a screen on:\n\t12345.tele-abc123\t(Detached)\n1 Socket in /tmp.\n';
  assert.equal(screenSessionExists('tele-abc123', () => lsOut), true);
  assert.equal(screenSessionExists('tele-nope', () => lsOut), false);
  // Tolerates screen -ls exiting non-zero (reads stdout off the thrown error).
  const throwWithStdout = () => { const e = new Error('exit 1'); e.stdout = lsOut; throw e; };
  assert.equal(screenSessionExists('tele-abc123', throwWithStdout), true);
});

test('screenSessionExists: a "(Dead ???)" leftover socket counts as absent and is wiped', () => {
  const lsOut = 'There are screens on:\n\t3591893.tele-a7611284\t(10/07/2026 08:28:11 PM)\t(Dead ???)\n\t12.tele-live\t(Detached)\nRemove dead screens with \'screen -wipe\'.\n';
  const calls = [];
  const exec = (cmd, args) => { calls.push(args.join(' ')); return args[0] === '-ls' ? lsOut : ''; };
  assert.equal(screenSessionExists('tele-a7611284', exec), false);
  assert.deepEqual(calls, ['-ls', '-wipe tele-a7611284']);
  calls.length = 0;
  assert.equal(screenSessionExists('tele-live', exec), true);
  assert.deepEqual(calls, ['-ls'], 'a live session is never wiped');
});

test('screenSessionExists: no false-positive on a name that is a SUFFIX of another session (G-Major)', () => {
  const lsOut = 'There is a screen on:\n\t999.my.bot\t(Detached)\n';
  assert.equal(screenSessionExists('bot', () => lsOut), false); // "bot" must NOT match "my.bot"
  // The full PID-anchored name still matches.
  assert.equal(screenSessionExists('my.bot', () => lsOut), true);
});

test('hasBinary: probes via `sh -c command -v <bin>`; success → true, throw → false', () => {
  let calledWith = null;
  const okExec = (file, args) => { calledWith = { file, args }; return ''; };
  assert.equal(hasBinary('claude', okExec), true);
  // Portable invocation: through /bin/sh, passing bin as $1 (not invoking `command` directly).
  assert.equal(calledWith.file, '/bin/sh');
  assert.ok(calledWith.args.includes('claude'));
  assert.ok(calledWith.args.some((a) => a.includes('command -v')));

  const throwExec = () => { throw new Error('exit 1'); };
  assert.equal(hasBinary('nope', throwExec), false);
});

test('normalizeSessionName: strips leading #, prepends tele- when missing', () => {
  assert.equal(normalizeSessionName('d1331668'), 'tele-d1331668');     // bare hashtag
  assert.equal(normalizeSessionName('#d1331668'), 'tele-d1331668');    // Telegram hashtag
  assert.equal(normalizeSessionName('tele-d1331668'), 'tele-d1331668'); // already a name
  assert.equal(normalizeSessionName('#tele-d1331668'), 'tele-d1331668'); // both
  assert.equal(normalizeSessionName('  d1331668 '), 'tele-d1331668');   // trims
});

test('normalizeSessionName: rejects empty / unsafe (shell-safety)', () => {
  assert.throws(() => normalizeSessionName(''), /invalid session id/);
  assert.throws(() => normalizeSessionName('#'), /invalid session id/);
  assert.throws(() => normalizeSessionName('tele-'), /invalid session id/);  // empty after prefix
  assert.throws(() => normalizeSessionName('#tele-'), /invalid session id/); // empty after strip+prefix
  assert.throws(() => normalizeSessionName('a; rm -rf /'), /invalid session id/);
  assert.throws(() => normalizeSessionName('$(whoami)'), /invalid session id/);
});

test('parseScreenSessions: extracts tele-* sessions (pid+name), ignores others', () => {
  const out = 'There is a screen on:\n\t68287.tele-d1331668\t(Detached)\n\t60092.tele-9a4bcab622a9\t(Detached)\n\t999.my.bot\t(Attached)\n3 Sockets in /tmp.\n';
  assert.deepEqual(parseScreenSessions(out), [
    { pid: '68287', name: 'tele-d1331668' },
    { pid: '60092', name: 'tele-9a4bcab622a9' },
  ]);
  assert.deepEqual(parseScreenSessions('No Sockets found.\n'), []);
});

test('parseScreenSessions: row-shape anchored — no mid-string / pid-miscapture / stateless false matches (review B)', () => {
  // mid-line substring (e.g. a banner or prose), not a real row → ignored.
  assert.deepEqual(parseScreenSessions('note 123.tele-x is running\n'), []);
  // pid.OTHER.tele-x → the name is `other.tele-x`, not `tele-*`; must NOT capture `123`/`tele-x`.
  assert.deepEqual(parseScreenSessions('\t999.other.tele-x\t(Detached)\n'), []);
  // a `pid.tele-*` token with no trailing `(state)` is not a session row → ignored.
  assert.deepEqual(parseScreenSessions('\t111.tele-abc1234 no-state-here\n'), []);
  // a genuine row still parses.
  assert.deepEqual(parseScreenSessions('\t111.tele-abc1234\t(Detached)\n'), [{ pid: '111', name: 'tele-abc1234' }]);
});

test('resolveKillId: finds id, rejects missing / flag-looking next token (review E)', () => {
  assert.deepEqual(resolveKillId(['--kill', 'd1331668']), { found: true, raw: 'd1331668' });
  assert.deepEqual(resolveKillId(['--quit', '#d1331668']), { found: true, raw: '#d1331668' });
  assert.deepEqual(resolveKillId(['--kill']), { found: true, raw: null });          // missing id
  assert.deepEqual(resolveKillId(['--kill', '--list']), { found: true, raw: null }); // double-dash flag
  assert.deepEqual(resolveKillId(['--kill', '-i']), { found: true, raw: null });     // single-dash flag
  assert.deepEqual(resolveKillId(['--interactive']), { found: false, raw: null });   // no kill flag
});

test('resolveAttachId: finds id (--attach/--resume), rejects missing / flag-looking next token', () => {
  assert.deepEqual(resolveAttachId(['--attach', 'd1331668']), { found: true, raw: 'd1331668' });
  assert.deepEqual(resolveAttachId(['--resume', '#d1331668']), { found: true, raw: '#d1331668' });
  assert.deepEqual(resolveAttachId(['--attach']), { found: true, raw: null });          // missing id
  assert.deepEqual(resolveAttachId(['--attach', '--list']), { found: true, raw: null }); // double-dash flag
  assert.deepEqual(resolveAttachId(['--attach', '-i']), { found: true, raw: null });     // single-dash flag
  assert.deepEqual(resolveAttachId(['--kill', 'x']), { found: false, raw: null });       // no attach flag
});

test('listSpawnSessions: dead "(Dead ???)" sockets are wiped and not listed; live ones untouched', () => {
  const lsOut = 'There are screens on:\n\t3591893.tele-a7611284\t(10/07/2026 08:28:11 PM)\t(Dead ???)\n\t12.tele-live\t(Detached)\n\t13.other\t(Dead ???)\n';
  const calls = [];
  const exec = (cmd, args) => { calls.push(args.join(' ')); return args[0] === '-ls' ? lsOut : ''; };
  let wiped = null;
  assert.deepEqual(listSpawnSessions(exec, { onWiped: (n) => { wiped = n; } }), [{ pid: '12', name: 'tele-live' }]);
  assert.deepEqual(calls, ['-ls', '-wipe tele-a7611284'], 'only our dead tele-* socket; never a live one or a foreign screen');
  assert.deepEqual(wiped, ['tele-a7611284']);
  assert.deepEqual(parseScreenSessions(lsOut), [{ pid: '3591893', name: 'tele-a7611284', dead: true }, { pid: '12', name: 'tele-live' }]);
});

test('listSpawnSessions: tolerates screen -ls exiting non-zero (reads stdout off error)', () => {
  const lsOut = '\t111.tele-abc1234\t(Detached)\n';
  const throwWithStdout = () => { const e = new Error('exit 1'); e.stdout = lsOut; throw e; };
  assert.deepEqual(listSpawnSessions(throwWithStdout), [{ pid: '111', name: 'tele-abc1234' }]);
});

test('runSpawn: delegates to injected runner with the plan (no real process)', () => {
  const plan = buildSpawnPlan({ interactive: true, sessionName: 'tele-x' });
  let got = null;
  const out = runSpawn(plan, { runner: (p) => { got = p; return { ...p, ran: true }; } });
  assert.equal(got, plan);
  assert.equal(out.ran, true);
});

// personaByHashtag: maps each topic's hashtag → persona so --list can label
// sessions with the name a human uses ("kill Cú").
test('personaByHashtag: maps hashtag → persona, skips _meta, ignores topic-less', () => {
  const convo = '2205483045424020';            // → hashtag e5424020
  const hashtag = shortConvoHash(convo);
  const store = {
    '-100': { [convo]: 124, _is_forum: true, _ts: { [convo]: 1 } },
    '-200': { '1234': 7 },                       // short convo → hashtag t1234
  };
  const map = personaByHashtag(store);
  assert.deepEqual(map[hashtag], personaForConvo(convo));
  assert.deepEqual(map['t1234'], personaForConvo('1234'));
  assert.equal(map._is_forum, undefined);        // meta key never mapped
  assert.equal(map['tdeadbeef'], undefined);     // a session with no topic → absent
});

test('personaByHashtag: empty/garbage store → empty map (no throw)', () => {
  assert.deepEqual(personaByHashtag({}), {});
  assert.deepEqual(personaByHashtag(null), {});
  assert.deepEqual(personaByHashtag({ '-1': null }), {});
  assert.deepEqual(personaByHashtag({ '-1': ['a', 'b'] }), {}); // array entry skipped
});

// gracefulKill: /exit first, poll up to graceMs, force-quit if stubborn.
test('gracefulKill: session exits after /exit → method "exit", no quit sent', async () => {
  const calls = [];
  const exec = (bin, args) => { calls.push(args.slice(-2).join(' ')); };
  let polls = 0;
  // present for the first poll, gone on the second (claude /exit landed)
  const sessionExists = () => (++polls < 2);
  const r = await gracefulKill('tele-x', { exec, sleep: async () => {}, sessionExists, pollMs: 500, graceMs: 10000 });
  assert.deepEqual(r, { method: 'exit', killed: true });
  assert.ok(calls.some((c) => c.includes('stuff')));      // /exit was sent
  assert.ok(!calls.some((c) => c === 'X quit'));          // quit NOT needed
});

test('gracefulKill: stubborn session → force quit after grace, killed once gone', async () => {
  const sent = [];
  const exec = (bin, args) => { sent.push(args.join(' ')); };
  // Always present during polling; gone only AFTER quit is issued.
  let quit = false;
  const sessionExists = () => !quit;
  const exec2 = (bin, args) => { sent.push(args.join(' ')); if (args.includes('quit')) quit = true; };
  let sleeps = 0;
  const r = await gracefulKill('tele-y', { exec: exec2, sleep: async () => { sleeps++; }, sessionExists, pollMs: 500, graceMs: 1000 });
  assert.equal(r.method, 'quit');
  assert.equal(r.killed, true);
  assert.ok(sent.some((c) => c.includes('stuff /exit')));  // tried graceful first
  assert.ok(sent.some((c) => c.includes('-X quit')));      // then forced
  assert.ok(sleeps >= 2, 'poll loop must actually run (not skipped) before force-quit');
});

test('gracefulKill: force quit fails (still listed) → killed:false', async () => {
  const sessionExists = () => true; // never disappears, even after quit
  const r = await gracefulKill('tele-z', { exec: () => {}, sleep: async () => {}, sessionExists, pollMs: 500, graceMs: 1000 });
  assert.deepEqual(r, { method: 'quit', killed: false });
});

test('gracefulKill: stuff throwing (undeliverable) → SKIP 10s poll, go straight to quit', async () => {
  let quitCalled = false;
  let sleeps = 0;
  const exec = (bin, args) => {
    if (args.includes('stuff')) throw new Error('screen busy');
    if (args.includes('quit')) quitCalled = true;
  };
  const sessionExists = () => !quitCalled;
  const r = await gracefulKill('tele-w', { exec, sleep: async () => { sleeps++; }, sessionExists, pollMs: 500, graceMs: 10000 });
  assert.equal(quitCalled, true);
  assert.equal(r.method, 'quit');   // undeliverable /exit must NOT be reported as a graceful exit
  assert.equal(r.killed, true);
  // Undeliverable /exit must NOT poll the full grace — only the first post-quit
  // verify sleep should run (not the ~20 poll-loop sleeps).
  assert.equal(sleeps, 1);
});

test('gracefulKill: already-gone session returns instantly (no pre-check sleep)', async () => {
  let sleeps = 0;
  const r = await gracefulKill('tele-gone', { exec: () => {}, sleep: async () => { sleeps++; }, sessionExists: () => false, pollMs: 500, graceMs: 10000 });
  assert.deepEqual(r, { method: 'exit', killed: true });
  assert.equal(sleeps, 0); // checked before sleeping → zero delay
});

// ── resolveAttachTarget: 3-char suffix + single-session convenience ───────────
const S = (h) => ({ pid: '1', name: `tele-${h}` });

test('resolveAttachTarget: single live session, NO id → attach it', () => {
  assert.deepEqual(resolveAttachTarget(null, [S('c8630116')]), { ok: true, name: 'tele-c8630116' });
});

test('resolveAttachTarget: single session + a WRONG id → error (no silent attach to lone survivor)', () => {
  const sess = [S('c8630116')];
  assert.ok(resolveAttachTarget('999', sess).error);          // 3-char, no match → error, not attach
  assert.ok(resolveAttachTarget('deadbeef', sess).error);     // full form, no match → error
  // but a CORRECT id on the lone session still attaches
  assert.equal(resolveAttachTarget('116', sess).name, 'tele-c8630116');
  assert.equal(resolveAttachTarget('c8630116', sess).name, 'tele-c8630116');
});

test('resolveAttachTarget: 3-char EXACT hashtag wins over a tail match (Gemini t12)', () => {
  const sess = [S('t12'), S('foot12')];   // both end in "t12"; exact should pick tele-t12
  assert.deepEqual(resolveAttachTarget('t12', sess), { ok: true, name: 'tele-t12' });
});

test('resolveAttachTarget: case-insensitive (suffix + full form)', () => {
  const sess = [S('c8630116'), S('a1234999')];
  assert.equal(resolveAttachTarget('116', sess).name, 'tele-c8630116');
  assert.equal(resolveAttachTarget('A1234999', sess).name, 'tele-a1234999');  // upper full → matches lowercase session
});

test('resolveAttachTarget: 2-char id routes to full-form (not suffix) → not found', () => {
  const r = resolveAttachTarget('11', [S('c8630116'), S('a1234999')]);
  assert.ok(r.error); assert.match(r.error, /no live session "tele-11"/);
});

test('resolveAttachTarget: 3-char suffix matches the hashtag tail', () => {
  const sess = [S('c8630116'), S('a1234999')];
  const r = resolveAttachTarget('116', sess);
  assert.deepEqual(r, { ok: true, name: 'tele-c8630116' });
  assert.deepEqual(resolveAttachTarget('999', sess), { ok: true, name: 'tele-a1234999' });
});

test('resolveAttachTarget: ambiguous 3-char suffix → error listing matches', () => {
  const sess = [S('c8630116'), S('a1234116')];   // both end in 116
  const r = resolveAttachTarget('116', sess);
  assert.ok(r.error);
  assert.match(r.error, /matches 2 sessions/);
  assert.match(r.error, /#c8630116/);
});

test('resolveAttachTarget: 3-char suffix with no match → error', () => {
  const r = resolveAttachTarget('xyz', [S('c8630116'), S('a1234999')]);
  assert.ok(r.error); assert.match(r.error, /no session matching "xyz"/);
});

test('resolveAttachTarget: full hashtag/#/tele- still works among many', () => {
  const sess = [S('c8630116'), S('a1234999')];
  assert.equal(resolveAttachTarget('a1234999', sess).name, 'tele-a1234999');   // bare
  assert.equal(resolveAttachTarget('#a1234999', sess).name, 'tele-a1234999');  // #
  assert.equal(resolveAttachTarget('tele-a1234999', sess).name, 'tele-a1234999');
  assert.ok(resolveAttachTarget('deadbeef', sess).error);                      // not live
});

test('resolveAttachTarget: no live sessions / multi + no id → errors', () => {
  assert.ok(resolveAttachTarget('116', []).error);
  const r = resolveAttachTarget(null, [S('c8630116'), S('a1234999')]);
  assert.ok(r.error); assert.match(r.error, /give an id/);
});

test('formatSessionList: renders #hashtags', () => {
  assert.equal(formatSessionList([S('c8630116'), S('t1234')]), '#c8630116, #t1234');
});

// Match a flag as a STANDALONE token, not a substring — otherwise `-i` is
// trivially satisfied by `--interactive` and `-h` by `--help`, so deleting a
// short alias from USAGE wouldn't fail the guard (review: Codex + subagent Nit).
// A flag token is bounded left by a non-[A-Za-z-] char (or start) and right by a
// non-[A-Za-z] char (or end): the left rule rejects `-i` inside `--interactive`
// (its left neighbour is `-`), the right rule rejects a longer-flag prefix.
const hasFlagToken = (usage, flag) =>
  new RegExp(`(^|[^A-Za-z-])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`).test(usage);

test('USAGE documents every flag, mode, and the hard-coded prompt (drift guard)', () => {
  // Each user-facing flag / alias must appear in --help as a standalone token so
  // the text can't drift away from the direct-run dispatch.
  for (const flag of ['-i', '--interactive', '--mode', '--list', '--ls', '--attach', '--resume', '--kill', '--quit', '--help', '-h', '--resume-session', '--hashtag', 'pid:', 'name:', '--restart']) {
    assert.ok(hasFlagToken(USAGE, flag), `USAGE missing standalone flag ${flag}`);
  }
  // Sanity-check the guard itself distinguishes a short alias from its long form:
  // stripping the standalone `-i` token must make the check fail even though the
  // sequence "-i" still lives inside "--interactive".
  assert.ok(!hasFlagToken('only --interactive here', '-i'), 'hasFlagToken false-matches -i inside --interactive');
  // Every permission mode is enumerated (so `--mode` help stays in sync).
  for (const m of PERMISSION_MODES) assert.ok(USAGE.includes(m), `USAGE missing mode ${m}`);
  assert.ok(USAGE.includes(DEFAULT_PERMISSION_MODE), 'USAGE missing the default mode');
  // The grace window and hard-coded prompt are interpolated, not restated.
  assert.ok(USAGE.includes(String(KILL_GRACE_MS / 1000)), 'USAGE missing the kill grace seconds');
  assert.ok(USAGE.includes(SPAWN_PROMPT), 'USAGE missing the hard-coded spawn prompt');
});

// End-to-end: actually RUN the script so the direct-run help branch is exercised
// (exit code, stdout-only, and — crucially — that --help does NOT fall through to
// spawning a real agent). Unit-testing the exports alone never covers this path.
const SPAWN_SCRIPT = fileURLToPath(new URL('./spawn.mjs', import.meta.url));
for (const flag of ['--help', '-h']) {
  test(`\`spawn.mjs ${flag}\` prints USAGE to stdout, exits 0, writes nothing to stderr`, () => {
    const r = spawnSync(process.execPath, [SPAWN_SCRIPT, flag], { encoding: 'utf8' });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
    assert.equal(r.stderr, '', `expected empty stderr, got: ${r.stderr}`);
    assert.ok(r.stdout.includes('spawn a new agent instance'), 'stdout is not the help text');
    // Guard the whole point of the first-check placement: help must NOT spawn.
    assert.ok(!/agent launched/.test(r.stdout), '--help fell through to a real spawn');
  });
}

test('wrapInLoginShell: only POSIX shells are wrapped; others fall back (null)', () => {
  for (const sh of ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/ksh', '/usr/bin/dash']) {
    assert.ok(Array.isArray(wrapInLoginShell(['claude'], { SHELL: sh })), sh);
  }
  for (const sh of ['/opt/homebrew/bin/fish', '/bin/csh', '/bin/tcsh', '/usr/local/bin/nu', '/usr/local/bin/pwsh', '/usr/bin/xonsh']) {
    assert.equal(wrapInLoginShell(['claude'], { SHELL: sh }), null, sh);
  }
});

test('loginSeedEnv: keeps session sockets the login shell cannot rebuild (ssh-agent, bus, display)', () => {
  const env = loginSeedEnv({ HOME: '/h', SSH_AUTH_SOCK: '/tmp/agent.sock', DBUS_SESSION_BUS_ADDRESS: 'unix:x', DISPLAY: ':0', CLAUDECODE: '1' });
  assert.equal(env.SSH_AUTH_SOCK, '/tmp/agent.sock');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:x');
  assert.equal(env.DISPLAY, ':0');
  assert.equal(env.CLAUDECODE, undefined);
});

// ── --resume-session / --kill pid: ───────────────────────────────────────────
const GIUN = '971e709e-2629-4d22-9943-40a52ee04a6b'; // hashtag #a7611284 (verified live)

test('buildSpawnPlan resume: screen tele-<uuid hashtag>, claude --resume <uuid> + RESUME_PROMPT', () => {
  const plan = buildSpawnPlan({ interactive: true, resumeSessionId: GIUN, permissionMode: 'auto' });
  assert.equal(plan.mode, 'interactive');
  assert.equal(plan.resumed, true);
  assert.equal(plan.sessionName, 'tele-a7611284');
  assert.deepEqual(plan.command, ['screen', '-U', '-dmS', 'tele-a7611284', 'claude', '--permission-mode', 'auto', '--resume', GIUN, RESUME_PROMPT]);
  assert.ok(!plan.command.includes('--session-id'));
  assert.equal(plan.teardown, 'screen -S tele-a7611284 -X quit');
  assert.match(RESUME_PROMPT, /restarted/);
  assert.match(RESUME_PROMPT, /mailbox\.mjs check/);
  assert.match(RESUME_PROMPT, /Listening for replies/);
  assert.match(RESUME_PROMPT, /--first-run/);
  assert.match(RESUME_PROMPT, /greeting in your Telegram topic/);
});

test('buildSpawnPlan resume: implies interactive, validates uuid + mode', () => {
  assert.equal(buildSpawnPlan({ resumeSessionId: GIUN }).mode, 'interactive');
  assert.throws(() => buildSpawnPlan({ resumeSessionId: 'x; rm -rf ~' }), /must be a UUID/);
  assert.throws(() => buildSpawnPlan({ resumeSessionId: GIUN, permissionMode: 'yolo' }), /invalid permission mode/);
});

test('buildSpawnPlan: non-resume plans unchanged (default prompt)', () => {
  assert.equal(buildSpawnPlan().command.at(-1), SPAWN_PROMPT);
  assert.equal(buildSpawnPlan({ interactive: true, seed: genSessionSeed(() => FIXED_UUID) }).command.at(-1), SPAWN_PROMPT);
});

test('resolveResumeSession: parse, derive hashtag, cross-check --hashtag', () => {
  assert.deepEqual(resolveResumeSession(['-i']), { found: false });
  assert.deepEqual(resolveResumeSession(['--resume-session', GIUN]), { found: true, sessionId: GIUN, hashtag: 'a7611284' });
  assert.deepEqual(resolveResumeSession([`--resume-session=${GIUN}`]), { found: true, sessionId: GIUN, hashtag: 'a7611284' });
  for (const h of ['a7611284', '#a7611284', 'tele-a7611284', '#A7611284']) {
    assert.equal(resolveResumeSession(['--resume-session', GIUN, '--hashtag', h]).sessionId, GIUN, h);
  }
  assert.match(resolveResumeSession(['--resume-session', GIUN, '--hashtag', 'a7611280']).error, /does not match/);
  assert.match(resolveResumeSession(['--resume-session', GIUN, '--hashtag']).error, /--hashtag needs/);
  assert.match(resolveResumeSession(['--resume-session']).error, /needs exactly one/);
  assert.match(resolveResumeSession(['--resume-session', '--mode', 'auto']).error, /needs exactly one/);
  assert.match(resolveResumeSession(['--resume-session', GIUN, '--resume-session', GIUN]).error, /needs exactly one/);
  assert.match(resolveResumeSession(['--resume-session', 'abc']).error, /not a UUID/);
  // `--resume` (attach alias) is NOT `--resume-session`
  assert.deepEqual(resolveResumeSession(['--resume', GIUN]), { found: false });
  assert.deepEqual(resolveAttachId(['--resume-session', GIUN]), { found: false, raw: null });
});

test('checkResumePreflight: refuses a live holder, an existing screen, a foreign/missing transcript', () => {
  const base = { sessionId: GIUN, sessionName: 'tele-a7611284', cwd: '/home/u/Projects/umipay', screenExists: false, transcriptDirs: ['-home-u-Projects-umipay'] };
  assert.deepEqual(checkResumePreflight({ ...base, procs: [] }), { ok: true });
  const held = checkResumePreflight({ ...base, procs: [{ pid: 830318, sessionId: GIUN, cwd: '/home/u/Projects/umipay', guessed: false }] });
  assert.match(held.error, /still held by live claude PID 830318/);
  assert.match(held.error, /\/kill pid:830318/);
  assert.match(checkResumePreflight({ ...base, procs: [{ pid: 9, sessionId: GIUN, guessed: true }] }).error, /guessed/);
  assert.match(checkResumePreflight({ ...base, procs: [], screenExists: true }).error, /already exists/);
  assert.match(checkResumePreflight({ ...base, procs: [], cwd: '/home/u/Projects/teleport' }).error, /belongs to another folder \(-home-u-Projects-umipay\)/);
  assert.match(checkResumePreflight({ ...base, procs: [], transcriptDirs: [] }).error, /no transcript/);
});

test('findTranscriptDirs: lists project dirs holding <uuid>.jsonl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-proj-'));
  fs.mkdirSync(path.join(dir, '-w-a')); fs.mkdirSync(path.join(dir, '-w-b'));
  fs.writeFileSync(path.join(dir, '-w-b', `${GIUN}.jsonl`), '{}');
  assert.deepEqual(findTranscriptDirs(GIUN, dir), ['-w-b']);
  assert.deepEqual(findTranscriptDirs(GIUN, path.join(dir, 'missing')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkPidKillAuth: owner only, daemon only, needs a configured owner', () => {
  assert.deepEqual(checkPidKillAuth({ fromId: '144', daemonUserId: '144' }), { ok: true });
  assert.match(checkPidKillAuth({ fromId: '7', daemonUserId: '144' }).error, /owner-only/);
  assert.match(checkPidKillAuth({ fromId: '', daemonUserId: '144' }).error, /daemon-only/);
  assert.match(checkPidKillAuth({ fromId: '144', daemonUserId: null }).error, /no daemon owner/);
});

test('resolveKillPid: pid:<N>, split "pid: N", bad targets; hashtag kills untouched', () => {
  assert.deepEqual(resolveKillPid(['--kill', 'pid:830318']), { found: true, pid: 830318 });
  assert.deepEqual(resolveKillPid(['--kill', 'pid:', '830318']), { found: true, pid: 830318 });
  assert.deepEqual(resolveKillPid(['--quit', 'PID:42']), { found: true, pid: 42 });
  assert.match(resolveKillPid(['--kill', 'pid:abc']).error, /bad pid target/);
  assert.match(resolveKillPid(['--kill', 'pid:']).error, /bad pid target/);
  assert.deepEqual(resolveKillPid(['--kill', 'a7611284']), { found: false });
  assert.deepEqual(resolveKillPid(['--list']), { found: false });
});

test('appendKillAudit: one JSON line per call with a timestamp', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'sub', 'a.jsonl');
  appendKillAudit({ pid: 1, result: 'denied' }, f);
  appendKillAudit({ pid: 2, result: 'exited' }, f);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.pid, l.result]), [[1, 'denied'], [2, 'exited']]);
  assert.ok(lines.every((l) => !Number.isNaN(Date.parse(l.ts))));
});

test('checkResumePreflight: failed process scan or an unidentified claude in the same cwd → refuse', () => {
  const base = { sessionId: GIUN, sessionName: 'tele-a7611284', cwd: '/w/umipay', screenExists: false, transcriptDirs: ['-w-umipay'] };
  assert.match(checkResumePreflight({ ...base, procs: null, procsError: 'ps failed' }).error, /cannot verify.*ps failed/);
  assert.match(checkResumePreflight({ ...base, procs: undefined }).error, /cannot verify/);
  assert.match(checkResumePreflight({ ...base, procs: [{ pid: 7, sessionId: null, cwd: '/w/umipay' }] }).error, /PID 7.*no session file/);
  assert.deepEqual(checkResumePreflight({ ...base, procs: [{ pid: 7, sessionId: null, cwd: '/w/other' }] }), { ok: true });
});

test('acquireResumeFileLock: exclusive while the holder lives; release is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock-'));
  const a = acquireResumeFileLock(GIUN, { dir });
  assert.ok(a.release);
  assert.match(acquireResumeFileLock(GIUN, { dir }).error, /in progress/); // holder = us, alive
  a.release(); a.release();
  assert.ok(acquireResumeFileLock(GIUN, { dir }).release);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireResumeFileLock: stale = holder pid dead (and old); a live old lock is NOT evicted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock-'));
  const file = path.join(dir, `resume-${GIUN}.lock`);
  fs.writeFileSync(file, '424242 deadbeef\n');
  const old = new Date(Date.now() - 3600_000); fs.utimesSync(file, old, old);
  assert.match(acquireResumeFileLock(GIUN, { dir, isAlive: () => true }).error, /in progress/); // old but alive
  const b = acquireResumeFileLock(GIUN, { dir, isAlive: (p) => p !== 424242 });                 // holder dead
  assert.ok(b.release, 'dead holder → taken over');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireResumeFileLock: release never removes a successor\'s lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock-'));
  const file = path.join(dir, `resume-${GIUN}.lock`);
  const a = acquireResumeFileLock(GIUN, { dir, token: 'A' });
  fs.writeFileSync(file, '999 B\n'); // pretend A's lock was (wrongly) replaced by B
  a.release();
  assert.equal(fs.readFileSync(file, 'utf8'), '999 B\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireResumeFileLock: a dead holder younger than staleMs is NOT taken over (a launch may still be starting)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock-'));
  fs.writeFileSync(path.join(dir, `resume-${GIUN}.lock`), '424242 dead\n'); // fresh mtime
  assert.match(acquireResumeFileLock(GIUN, { dir, isAlive: () => false }).error, /in progress/);
  assert.ok(acquireResumeFileLock(GIUN, { dir, isAlive: () => false, now: () => Date.now() + RESUME_LOCK_STALE_MS + 1000 }).release);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireResumeFileLock: breaking is serialized by the guard; a live breaker blocks, a crashed one is cleared', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock-'));
  const file = path.join(dir, `resume-${GIUN}.lock`);
  const later = () => Date.now() + RESUME_LOCK_STALE_MS + 1000;
  fs.writeFileSync(file, '424242 dead\n');
  fs.writeFileSync(`${file}.breaking`, '777 breaker\n');
  // breaker 777 alive → busy, and the dead lock is left alone
  assert.match(acquireResumeFileLock(GIUN, { dir, now: later, isAlive: (p) => p === 777 }).error, /in progress/);
  assert.equal(fs.readFileSync(file, 'utf8'), '424242 dead\n');
  // breaker dead + old → guard cleared, dead lock broken, we own it
  const r = acquireResumeFileLock(GIUN, { dir, now: later, isAlive: () => false, token: 'ME' });
  assert.ok(r.release);
  assert.equal(fs.readFileSync(file, 'utf8'), `${process.pid} ME\n`);
  assert.equal(fs.existsSync(`${file}.breaking`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireResumeFileLock: a breaker never removes a lock that changed after it judged it stale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock-'));
  const file = path.join(dir, `resume-${GIUN}.lock`);
  fs.writeFileSync(file, '424242 dead\n');
  let swapped = false;
  // While B judges the dead lock, the dead lock is released and C acquires a fresh one.
  const b = acquireResumeFileLock(GIUN, {
    dir, token: 'B', now: () => Date.now() + RESUME_LOCK_STALE_MS + 1000,
    isAlive: (p) => {
      if (p === 424242 && !swapped) { swapped = true; fs.unlinkSync(file); fs.writeFileSync(file, '555 C\n'); }
      return p === 555;
    },
  });
  assert.match(b.error, /in progress/);
  assert.equal(fs.readFileSync(file, 'utf8'), '555 C\n', "C's live lock survives");
  fs.rmSync(dir, { recursive: true, force: true });
});

// performResume with every side effect faked.
const fakeDeps = (over = {}) => {
  const log = { ran: [], released: 0 };
  let up = false;
  const deps = {
    acquireLock: () => ({ release: () => { log.released++; } }),
    listProcs: () => [],
    screenExists: () => up,
    transcriptDirs: () => ['-w-umipay'],
    run: (plan) => { log.ran.push(plan); up = true; },
    sleep: async () => {}, timeoutMs: 1000, pollMs: 250,
    ...over,
  };
  return { deps, log };
};

test('performResume: happy path launches the resume plan in cwd and releases the lock', async () => {
  const { deps, log } = fakeDeps();
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay', permissionMode: 'plan' }, deps);
  assert.equal(r.ok, true);
  assert.equal(log.ran.length, 1);
  assert.deepEqual(log.ran[0].command.slice(4, 9), ['claude', '--permission-mode', 'plan', '--resume', GIUN]);
  assert.equal(log.released, 1);
});

test('performResume: lock busy / preflight refusal / ps failure → never launches; lock always released', async () => {
  let { deps, log } = fakeDeps({ acquireLock: () => ({ error: 'another resume in progress' }) });
  assert.match((await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps)).error, /in progress/);
  assert.equal(log.ran.length, 0);

  ({ deps, log } = fakeDeps({ listProcs: () => [{ pid: 830318, sessionId: GIUN, cwd: '/w/umipay' }] }));
  assert.match((await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps)).error, /still held/);
  assert.equal(log.ran.length, 0);
  assert.equal(log.released, 1);

  ({ deps, log } = fakeDeps({ listProcs: () => { throw new Error('ps failed'); } }));
  assert.match((await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps)).error, /ps failed/);
  assert.equal(log.ran.length, 0);
  assert.equal(log.released, 1);
});

test('performResume: timeout with the launcher still running → launcher killed, cooldown set', async () => {
  const order = [];
  const child = { exitCode: null, signalCode: null, kill: (sig) => { order.push(`kill:${sig}`); } };
  const { deps } = fakeDeps({
    run: () => ({ child }),
    acquireLock: () => ({ release: () => order.push('release'), markFailed: () => order.push('markFailed') }),
  });
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps);
  assert.match(r.error, /not found after/);
  assert.equal(r.launchFailed, true);
  // launcher killed, cooldown set (it might still be starting a writer), then released
  assert.deepEqual(order, ['kill:SIGKILL', 'markFailed', 'release']);
});

test('performResume: heldLock is used as-is and NOT released (the caller owns it)', async () => {
  let acquired = 0, released = 0;
  const { deps } = fakeDeps({ acquireLock: () => { acquired++; return { release() {} }; } });
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, { ...deps, heldLock: { release: () => { released++; } } });
  assert.equal(r.ok, true);
  assert.equal(acquired, 0);
  assert.equal(released, 0);
});

test('performResume: screen never appears → error after timeout, cooldown marked (blocks a premature retry)', async () => {
  let marked = 0;
  const { deps, log } = fakeDeps({ run: (plan) => { log.ran.push(plan); } });
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, { ...deps, acquireLock: () => ({ release: () => { log.released++; }, markFailed: () => { marked++; } }) });
  assert.match(r.error, /not found after/);
  assert.equal(r.launchFailed, true);
  assert.equal(log.ran.length, 1);
  assert.equal(marked, 1);
  assert.equal(log.released, 1);
});

test('performResume: the lock is held while preflight + launch run (concurrent resume blocked)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock2-'));
  let second;
  const { deps } = fakeDeps({
    acquireLock: (id) => acquireResumeFileLock(id, { dir }),
    run: () => { second = acquireResumeFileLock(GIUN, { dir }); },
    screenExists: () => second !== undefined,
  });
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps);
  assert.equal(r.ok, true);
  assert.match(second.error, /in progress/);
  assert.ok(acquireResumeFileLock(GIUN, { dir }).release, 'released after');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkRestartTarget: needs a real (non-guessed) session id, a cwd and its transcript there', () => {
  const t = { pid: 1, sessionId: GIUN, guessed: false, cwd: '/w/umipay' };
  assert.deepEqual(checkRestartTarget(t, { transcriptDirs: ['-w-umipay'] }), { ok: true });
  assert.match(checkRestartTarget(null, { transcriptDirs: [] }).error, /no session id/);
  assert.match(checkRestartTarget({ ...t, sessionId: null }, { transcriptDirs: [] }).error, /no session id/);
  assert.match(checkRestartTarget({ ...t, guessed: true }, { transcriptDirs: ['-w-umipay'] }).error, /only a guess/);
  assert.match(checkRestartTarget({ ...t, cwd: null }, { transcriptDirs: ['-w-umipay'] }).error, /working directory/);
  assert.match(checkRestartTarget(t, { transcriptDirs: ['-w-other'] }).error, /no transcript/);
});

test('checkRestartPreflight: pre-kill catches every knowable post-kill refusal; ignores the target itself', () => {
  const t = { pid: 830318, sessionId: GIUN, guessed: false, cwd: '/w/umipay' };
  const base = { screenExists: false, transcriptDirs: ['-w-umipay'] };
  // the target holds its own session — that must NOT block (it is about to be killed)
  assert.deepEqual(checkRestartPreflight(t, { ...base, procs: [t] }), { ok: true });
  // another unidentified claude in the same cwd → refuse before killing
  assert.match(checkRestartPreflight(t, { ...base, procs: [t, { pid: 9, sessionId: null, cwd: '/w/umipay' }] }).error, /PID 9/);
  // a second live holder of the same session → refuse
  assert.match(checkRestartPreflight(t, { ...base, procs: [t, { pid: 10, sessionId: GIUN, cwd: '/w/umipay' }] }).error, /still held by live claude PID 10/);
  assert.match(checkRestartPreflight(t, { ...base, procs: [t], screenExists: true }).error, /already exists/);
  assert.match(checkRestartPreflight(t, { ...base, procs: null, procsError: 'ps failed' }).error, /ps failed/);
  assert.match(checkRestartPreflight({ ...t, guessed: true }, { ...base, procs: [t] }).error, /only a guess/);
});

test('performResume (default deps): a failing ps is a refusal, launched cwd is the target cwd', async () => {
  const { deps } = fakeDeps();
  delete deps.listProcs; delete deps.run;
  // ps throws → listClaudeProcs({ strict: true }) throws → refused, nothing spawned
  let spawned = 0;
  const r1 = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, {
    ...deps, exec: () => { throw new Error('ps missing'); }, spawnFn: () => { spawned++; return { unref() {} }; },
  });
  assert.match(r1.error, /ps failed/);
  assert.equal(spawned, 0);
  // working ps, no holder → runSpawn is called with cwd = the target cwd
  const calls = [];
  let up = false;
  const r2 = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, {
    ...deps, screenExists: () => up,
    exec: () => ' 1 0 1000 ? 00:01 init /sbin/init\n',
    spawnFn: (cmd, args, opts) => { calls.push(opts); up = true; return { unref() {} }; },
  });
  assert.equal(r2.ok, true);
  assert.equal(calls[0].cwd, '/w/umipay');
});

test('inSystemdService: a service leaf (not user@N.service, not a scope)', () => {
  assert.equal(inSystemdService('0::/user.slice/user-1000.slice/user@1000.service/app.slice/teleport-daemon.service\n'), true);
  assert.equal(inSystemdService('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-x.scope'), false);
  assert.equal(inSystemdService('0::/user.slice/user-1000.slice/user@1000.service'), false);
  assert.equal(inSystemdService(''), false);
});

test('escapeServiceCgroup: wraps with systemd-run --scope whenever the probe works (service or terminal)', () => {
  delete process.env.TELEPORT_NO_SCOPE;
  try {
  const cmd = ['/bin/zsh', '-lic', 'exec "$@"', 'teleport-spawn', 'screen'];
  const svc = '0::/a/teleport-daemon.service';
  assert.deepEqual(SYSTEMD_SCOPE_PREFIX, ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--'], 'literal argv: --scope keeps the pid, --user the user manager, -- ends options');
  assert.deepEqual(escapeServiceCgroup(cmd, {}, { probe: () => true }), [...SYSTEMD_SCOPE_PREFIX, ...cmd]);
  assert.deepEqual(escapeServiceCgroup(cmd, {}, { probe: () => false }), cmd);
  // a terminal scope gets its own scope too (closing the terminal must not kill the agent)
  assert.deepEqual(escapeServiceCgroup(cmd, {}, { probe: () => true }), [...SYSTEMD_SCOPE_PREFIX, ...cmd]);
  } finally { process.env.TELEPORT_NO_SCOPE = '1'; }
  // the opt-out wins over a working probe
  assert.deepEqual(escapeServiceCgroup(['x'], {}, { probe: () => true }), ['x']);
});

test('runSpawn: the escape wrapper is applied to the (login-shell) launch command', () => {
  const calls = [];
  runSpawn(buildSpawnPlan({ interactive: true, seed: genSessionSeed(() => FIXED_UUID) }), {
    spawnFn: (c, a) => { calls.push([c, ...a]); return { unref() {} }; },
    escape: (command) => ['WRAP', ...command],
  });
  assert.equal(calls[0][0], 'WRAP');
  assert.ok(calls[0].includes('screen'));
});

test('acquireResumeFileLock: an empty / garbage lock (creator between O_EXCL and write) is NOT stale while fresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock-'));
  const file = path.join(dir, `resume-${GIUN}.lock`);
  for (const body of ['', 'garbage\n']) {
    fs.writeFileSync(file, body);
    let asked = 0;
    assert.match(acquireResumeFileLock(GIUN, { dir, isAlive: () => { asked++; return false; } }).error, /in progress/, JSON.stringify(body));
    assert.equal(fs.readFileSync(file, 'utf8'), body, 'left untouched');
    assert.equal(asked, 0, 'no pid to ask about');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runSpawn (interactive): returns the launcher child so performResume can stop a stuck launch', () => {
  const child = { unref() {} };
  const r = runSpawn(buildSpawnPlan({ interactive: true, seed: genSessionSeed(() => FIXED_UUID) }), { spawnFn: () => child, escape: (c) => c });
  assert.equal(r.child, child);
});

test('escapeServiceCgroup: the DEFAULT probe runs `systemd-run --user --scope … -- true` (not systemd-run twice)', () => {
  delete process.env.TELEPORT_NO_SCOPE;
  try {
  const calls = [];
  const out = escapeServiceCgroup(['x'], { E: 1 }, { run: (bin, args, opts) => { calls.push([bin, ...args]); assert.deepEqual(opts.env, { E: 1 }); } });
  assert.deepEqual(calls, [['systemd-run', '--user', '--scope', '--quiet', '--collect', '--', 'true']]);
  assert.deepEqual(out, [...SYSTEMD_SCOPE_PREFIX, 'x']);
  assert.deepEqual(escapeServiceCgroup(['x'], {}, { run: () => { throw new Error('no bus'); } }), ['x']);
  } finally { process.env.TELEPORT_NO_SCOPE = '1'; }
});

test('acquireResumeLock (linux, kernel-backed): exclusive, freed on release, unique per session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klock-'));
  const name = `\0teleport-test-${process.pid}-${Math.random()}`;
  const a = await acquireResumeLock(GIUN, { dir, platform: 'linux', name });
  assert.ok(a.release);
  assert.match((await acquireResumeLock(GIUN, { dir, platform: 'linux', name })).error, /in progress/);
  a.release(); a.release();
  await new Promise((r) => setTimeout(r, 20));
  const b = await acquireResumeLock(GIUN, { dir, platform: 'linux', name });
  assert.ok(b.release, 'free again after release');
  b.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireResumeLock: failed-launch cooldown refuses until it expires, and frees the lock it took', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klock-'));
  const name = `\0teleport-test-${process.pid}-${Math.random()}`;
  const a = await acquireResumeLock(GIUN, { dir, platform: 'linux', name });
  a.beginLaunch(); a.markFailed(); a.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.match((await acquireResumeLock(GIUN, { dir, platform: 'linux', name })).error, /failed .*ago/);
  const later = await acquireResumeLock(GIUN, { dir, platform: 'linux', name, now: () => Date.now() + 200_000 });
  assert.ok(later.release, 'cooldown over; and the refused attempt did not leave the lock held');
  later.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireResumeLock: non-linux falls back to the file lock', async () => {
  let used = 0;
  const r = await acquireResumeLock(GIUN, { dir: os.tmpdir(), platform: 'darwin', fileLock: () => { used++; return { release() {} }; } });
  assert.equal(used, 1);
  assert.ok(r.release && r.markFailed);
});

test('acquireResumeFileLock: an OLD lock with no parseable holder is still not evicted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlock-'));
  const file = path.join(dir, `resume-${GIUN}.lock`);
  fs.writeFileSync(file, '');
  assert.match(acquireResumeFileLock(GIUN, { dir, isAlive: () => false, now: () => Date.now() + RESUME_LOCK_STALE_MS + 1000 }).error, /in progress/);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquireResumeLock: launch marker — written before launch (fail closed), removed on success, kept on failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klock-'));
  const name = () => `\0teleport-test-${process.pid}-${Math.random()}`;
  const marker = path.join(dir, `resume-${GIUN}.failed`);
  const a = await acquireResumeLock(GIUN, { dir, platform: 'linux', name: name() });
  assert.deepEqual(a.beginLaunch(), { ok: true });
  assert.ok(fs.existsSync(marker));
  a.launchSucceeded(); a.release();
  assert.equal(fs.existsSync(marker), false, 'success clears the guard');
  const b = await acquireResumeLock(GIUN, { dir, platform: 'linux', name: name() });
  assert.ok(b.release, 'no cooldown after a success');
  b.beginLaunch(); b.markFailed(); b.release();
  assert.match((await acquireResumeLock(GIUN, { dir, platform: 'linux', name: name() })).error, /failed .*ago/);
  // unwritable dir → beginLaunch refuses
  const ro = path.join(dir, 'ro'); fs.mkdirSync(ro); fs.chmodSync(ro, 0o500);
  const c = await acquireResumeLock(GIUN, { dir: ro, platform: 'linux', name: name() });
  if (process.getuid?.() !== 0) assert.match(c.beginLaunch().error, /refusing to launch/);
  c.release(); fs.chmodSync(ro, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('performResume: no launch when beginLaunch fails; launchSucceeded on a verified screen', async () => {
  const events = [];
  let { deps, log } = fakeDeps({ acquireLock: () => ({ release: () => events.push('release'), beginLaunch: () => ({ error: 'disk full' }) }) });
  const r1 = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps);
  assert.match(r1.error, /disk full/);
  assert.equal(log.ran.length, 0);
  ({ deps, log } = fakeDeps({ acquireLock: () => ({ release: () => events.push('release'), beginLaunch: () => { events.push('begin'); return { ok: true }; }, launchSucceeded: () => events.push('succeeded') }) }));
  const r2 = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps);
  assert.equal(r2.ok, true);
  assert.deepEqual(events.slice(-3), ['begin', 'succeeded', 'release']);
});

test('resumeLockSecret: created once with mode 0600, stable; the lock name depends on it (unguessable by other users)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksec-'));
  const a = resumeLockSecret(dir);
  assert.equal(resumeLockSecret(dir), a);
  assert.equal(fs.statSync(path.join(dir, '.resume-lock-secret')).mode & 0o777, 0o600);
  assert.ok(a.length >= 32);
  // default name derives from the secret: two dirs (secrets) never collide, same dir does
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ksec-'));
  const l1 = await acquireResumeLock(GIUN, { dir, platform: 'linux' });
  assert.ok(l1.release);
  assert.match((await acquireResumeLock(GIUN, { dir, platform: 'linux' })).error, /in progress/);
  const l2 = await acquireResumeLock(GIUN, { dir: d2, platform: 'linux' });
  assert.ok(l2.release, 'different secret → different name');
  l1.release(); l2.release();
  fs.writeFileSync(path.join(d2, '.resume-lock-secret'), 'short', { mode: 0o600 });
  fs.chmodSync(path.join(d2, '.resume-lock-secret'), 0o600);
  assert.match((await acquireResumeLock(GIUN, { dir: d2, platform: 'linux' })).error, /malformed/);
  fs.chmodSync(path.join(d2, '.resume-lock-secret'), 0o644);
  assert.match((await acquireResumeLock(GIUN, { dir: d2, platform: 'linux' })).error, /readable by others/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('.resume-lock-secret.')).length, 0, 'no temp files left');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
});

test('resolveKillPid: name: — quoted (one token) or unquoted (words up to the next flag)', () => {
  assert.deepEqual(resolveKillPid(['--kill', 'name:Rắn 3', '--restart']), { found: true, name: 'Rắn 3' });
  assert.deepEqual(resolveKillPid(['--kill', 'name:Rắn', '3', '--restart']), { found: true, name: 'Rắn 3' });
  assert.deepEqual(resolveKillPid(['--kill', 'name:', 'Giun']), { found: true, name: 'Giun' });
  assert.match(resolveKillPid(['--kill', 'name:']).error, /needs a name/);
});

test('matchProcsByName: full name via session name or persona; emoji/case ignored; ambiguity refused', () => {
  const rows = [
    { pid: 1, name: '🐍 Rắn 3', hashtag: 'a', procStart: '111' }, { pid: 2, name: '🐍 Rắn', hashtag: 'b' },
    { pid: 3, name: '🧚 UmiApp', hashtag: 'c' }, { pid: 4, name: 'digesty-a7', hashtag: 'd' }, { pid: 5, name: null, hashtag: 'e' },
  ];
  const persona = (r) => ({ c: '🧚 Tiên', d: '🦛 Hà Mã', e: '🦛 Hà Mã' })[r.hashtag] || null;
  assert.deepEqual(matchProcsByName('Rắn 3', rows, persona), { pid: 1, start: '111' }, 'carries the start fingerprint');
  assert.equal(matchProcsByName('rắn', rows, persona).pid, 2, 'full name, not substring of "Rắn 3"');
  assert.equal(matchProcsByName('🧚 tiên', rows, persona).pid, 3, 'persona works too');
  assert.equal(matchProcsByName('UmiApp', rows, persona).pid, 3);
  assert.equal(matchProcsByName('UmiApp', rows, persona).start, null);
  assert.match(matchProcsByName('Hà Mã', rows, persona).error, /matches 2 processes: PID 4 \(digesty-a7\), PID 5/);
  assert.match(matchProcsByName('Cú', rows, persona).error, /no claude process named/);
  assert.equal(normalizeAgentName(' 🐍  Rắn   3 '), 'rắn 3');
});

test('acquireResumeLock: one lock per session (different uuids don\'t block each other); cooldown counts from the failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kps-'));
  const OTHER = '00000000-0000-4000-8000-0000000000bb';
  const a = await acquireResumeLock(GIUN, { dir, platform: 'linux' });
  const b = await acquireResumeLock(OTHER, { dir, platform: 'linux' });
  assert.ok(a.release && b.release, 'per-session names');
  b.release();
  // begin at t0, fail at t0+100s → still refused at t0+150s (cooldown from failure)
  const t0 = Date.now();
  a.beginLaunch();
  const marker = path.join(dir, `resume-${GIUN}.failed`);
  fs.utimesSync(marker, new Date(t0), new Date(t0));
  fs.utimesSync(marker, new Date(t0 + 100_000), new Date(t0 + 100_000)); // what markFailed does at t0+100s
  a.release();
  assert.match((await acquireResumeLock(GIUN, { dir, platform: 'linux', now: () => t0 + 150_000 })).error, /failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resumeLockSecret: rejects a symlink, a dangling symlink, and a group-readable secret', () => {
  for (const setup of [
    (d) => { fs.writeFileSync(path.join(d, 'real'), 'x'.repeat(64), { mode: 0o600 }); fs.symlinkSync(path.join(d, 'real'), path.join(d, '.resume-lock-secret')); },
    (d) => fs.symlinkSync(path.join(d, 'nowhere'), path.join(d, '.resume-lock-secret')),
    (d) => { fs.writeFileSync(path.join(d, '.resume-lock-secret'), 'x'.repeat(64)); fs.chmodSync(path.join(d, '.resume-lock-secret'), 0o640); },
  ]) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ksec2-'));
    setup(d);
    assert.throws(() => resumeLockSecret(d), /not a regular file|readable by others/);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('performResume: screen appearing while the stuck launcher is killed → ok, guard cleared', async () => {
  let up = false; const ev = [];
  const child = { exitCode: null, signalCode: null, kill: () => { up = true; ev.push('kill'); } };
  const { deps } = fakeDeps({
    run: () => ({ child }), screenExists: () => up,
    acquireLock: () => ({ release: () => ev.push('release'), beginLaunch: () => ({ ok: true }), launchSucceeded: () => ev.push('succeeded'), markFailed: () => ev.push('failed') }),
  });
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(ev, ['kill', 'succeeded', 'release']);
});

test('matchProcsByName: a hashtag (with or without #) picks the process by session hashtag', () => {
  const rows = [{ pid: 7, name: '🪱 Giun', hashtag: 'a7611284', procStart: '9' }, { pid: 8, name: 'x', hashtag: 'b1234567' }];
  assert.deepEqual(matchProcsByName('#a7611284', rows), { pid: 7, start: '9' });
  assert.deepEqual(matchProcsByName('a7611284', rows), { pid: 7, start: '9' });
  assert.match(matchProcsByName('#c0000000', rows).error, /no claude process named/);
  assert.match(matchProcsByName('#a7611284', [...rows, { pid: 9, hashtag: 'a7611284' }]).error, /matches 2 processes/);
});

test('performResume: waits for a just-started claude (young, no session file yet) instead of refusing; old blockers still refuse', async () => {
  let calls = 0; const slept = [];
  const young = { pid: 5, sessionId: null, cwd: '/w/umipay', etime: '00:05' };
  let { deps, log } = fakeDeps({
    listProcs: () => (++calls < 3 ? [young] : [{ ...young, sessionId: 'other' }]),
    sleep: async (ms) => { slept.push(ms); },
  });
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, { ...deps, youngPollMs: 3000, youngWaitMs: 60000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls, 3);
  assert.ok(slept.filter((m) => m === 3000).length >= 2);
  ({ deps, log } = fakeDeps({ listProcs: () => [{ ...young, etime: '05:00' }] }));
  const r2 = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps);
  assert.match(r2.error, /no session file/);
  assert.equal(log.ran.length, 0);
  ({ deps, log } = fakeDeps({ listProcs: () => [young], sleep: async () => {} }));
  const r3 = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, { ...deps, youngPollMs: 1000, youngWaitMs: 3000 });
  assert.match(r3.error, /no session file/, 'gives up after the wait window');
});

test('performResume wait: a young proc that turns out to BE this session → refused, never launched; a definite holder → no wait', async () => {
  let calls = 0; const slept = [];
  const young = { pid: 5, sessionId: null, cwd: '/w/umipay', etime: '00:05' };
  let { deps, log } = fakeDeps({ listProcs: () => (++calls < 3 ? [young] : [{ ...young, sessionId: GIUN }]), sleep: async (ms) => slept.push(ms) });
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, { ...deps, youngPollMs: 3000, youngWaitMs: 60000 });
  assert.match(r.error, /still held by live claude PID 5/);
  assert.match(r.error, /waited \d+s/);
  assert.equal(log.ran.length, 0);
  slept.length = 0;
  ({ deps, log } = fakeDeps({ listProcs: () => [{ pid: 9, sessionId: GIUN, cwd: '/w/umipay', etime: '2-00:00:00' }, young], sleep: async (ms) => slept.push(ms) }));
  const r2 = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps);
  assert.match(r2.error, /still held by live claude PID 9/);
  assert.equal(slept.length, 0, 'no wait when a definite holder is known');
});

test('performResume wait: another refusal (screen exists) is reported at once, not after the wait', async () => {
  const slept = [];
  const young = { pid: 5, sessionId: null, cwd: '/w/umipay', etime: '00:05' };
  const { deps } = fakeDeps({ listProcs: () => [young], screenExists: () => true, sleep: async (ms) => slept.push(ms) });
  const r = await performResume({ sessionId: GIUN, cwd: '/w/umipay' }, deps);
  assert.match(r.error, /already exists/);
  assert.equal(slept.length, 0);
});
