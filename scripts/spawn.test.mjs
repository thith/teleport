import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnPlan, genSessionSeed, runSpawn, hasBinary, screenSessionExists, SPAWN_PROMPT } from './spawn.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';

// A fixed UUID for deterministic seed tests (not a real session — never executed).
const FIXED_UUID = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
const FIXED_CONVO = uuidToConvoInt(FIXED_UUID);
const FIXED_NAME = `tele-${shortConvoHash(FIXED_CONVO)}`;

test('SPAWN_PROMPT is the hard-coded greeting (no task passed)', () => {
  assert.equal(SPAWN_PROMPT, 'Telegram me and wait for instructions');
});

test('buildSpawnPlan headless (default): claude -p <prompt>, no session/teardown', () => {
  const p = buildSpawnPlan();
  assert.equal(p.mode, 'headless');
  assert.deepEqual(p.command, ['claude', '-p', SPAWN_PROMPT]);
  assert.equal(p.sessionName, null);
  assert.equal(p.teardown, null);
});

test('buildSpawnPlan interactive: explicit name (no seed) → screen -dmS <name> claude <prompt>, no -p, no --session-id', () => {
  const p = buildSpawnPlan({ interactive: true, sessionName: 'tele-abc123' });
  assert.equal(p.mode, 'interactive');
  assert.deepEqual(p.command, ['screen', '-dmS', 'tele-abc123', 'claude', SPAWN_PROMPT]);
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
  assert.deepEqual(p.command, ['screen', '-dmS', FIXED_NAME, 'claude', '--session-id', FIXED_UUID, SPAWN_PROMPT]);
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
  assert.equal(p.command[2], p.sessionName);
});

test('buildSpawnPlan interactive: explicit name + seed → name overrides but seed session-id still forced (G-Major)', () => {
  const p = buildSpawnPlan({ interactive: true, sessionName: 'tele-custom', seed: genSessionSeed(() => FIXED_UUID) });
  assert.equal(p.sessionName, 'tele-custom'); // explicit name wins
  assert.equal(p.sessionId, FIXED_UUID); // but the forced id is NOT lost
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

test('runSpawn: delegates to injected runner with the plan (no real process)', () => {
  const plan = buildSpawnPlan({ interactive: true, sessionName: 'tele-x' });
  let got = null;
  const out = runSpawn(plan, { runner: (p) => { got = p; return { ...p, ran: true }; } });
  assert.equal(got, plan);
  assert.equal(out.ran, true);
});
