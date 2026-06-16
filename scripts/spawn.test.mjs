import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnPlan, genSessionName, runSpawn, hasBinary, screenSessionExists, SPAWN_PROMPT } from './spawn.mjs';

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

test('buildSpawnPlan interactive: screen -dmS <name> claude <prompt> (positional seed, no -p)', () => {
  const p = buildSpawnPlan({ interactive: true, sessionName: 'tele-abc123' });
  assert.equal(p.mode, 'interactive');
  assert.deepEqual(p.command, ['screen', '-dmS', 'tele-abc123', 'claude', SPAWN_PROMPT]);
  assert.equal(p.teardown, 'screen -S tele-abc123 -X quit');
  // CRUCIAL: interactive must NOT use -p (that would bill as SDK pool, not subscription).
  assert.ok(!p.command.includes('-p'));
});

test('buildSpawnPlan interactive: auto-generates a session name when none given', () => {
  const p = buildSpawnPlan({ interactive: true });
  assert.match(p.sessionName, /^tele-[0-9a-f]{12}$/);
  assert.equal(p.command[2], p.sessionName);
});

test('buildSpawnPlan interactive: rejects an unsafe session name (shell-safety)', () => {
  assert.throws(() => buildSpawnPlan({ interactive: true, sessionName: 'a; rm -rf /' }), /unsafe session name/);
  assert.throws(() => buildSpawnPlan({ interactive: true, sessionName: '$(whoami)' }), /unsafe session name/);
  // Safe names pass.
  assert.ok(buildSpawnPlan({ interactive: true, sessionName: 'tele-abc_1.2' }));
});

test('genSessionName: tele-<hex>, injectable rand, 48-bit default', () => {
  assert.equal(genSessionName(() => 'deadbeef0011'), 'tele-deadbeef0011');
  assert.match(genSessionName(), /^tele-[0-9a-f]{12}$/);
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
