import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitForwarded, misplacedFlag, parseExtraArgs, stripOwnerOnly, saveExtraArgs, loadExtraArgs, clearExtraArgs } from './spawn-extra-args.mjs';
import { buildSpawnPlan, performResume } from './spawn.mjs';

const SID = 'ac22f365-d351-4e54-82a5-303156081507';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-extra-'));

test('splitForwarded: first "--" (or the em/en dash a phone keyboard makes); spawn never sees what follows', () => {
  assert.deepEqual(splitForwarded(['--interactive', '--', '--remote-control', 'x']), { own: ['--interactive'], fwd: ['--remote-control', 'x'] });
  assert.deepEqual(splitForwarded(['-i', '—', '--model', 'opus']).fwd, ['--model', 'opus']);
  assert.deepEqual(splitForwarded(['-i', '–']).fwd, []);
  assert.deepEqual(splitForwarded(['-i', '--mode', 'plan']), { own: ['-i', '--mode', 'plan'], fwd: null });
  // spawn flags after the separator are NOT spawn flags
  const { own } = splitForwarded(['--kill', 'pid:1', '--', '--restart', '--mode', 'auto']);
  assert.deepEqual(own, ['--kill', 'pid:1']);
});

test('misplacedFlag: a claude flag before "--" is a clear error, not a silent plain spawn', () => {
  assert.match(misplacedFlag(['--interactive', '--remote-control', 'cuuho']), /put it after "--"/);
  assert.match(misplacedFlag(['-n', 'x']), /claude flag/);
  assert.equal(misplacedFlag(['--interactive', '--mode', 'plan']), null);
});

test('parseExtraArgs: exact allowlist, plain values, owner-only remote control, no duplicates', () => {
  assert.deepEqual(parseExtraArgs(['--remote-control', 'cuuho'], { owner: true }).args, ['--remote-control', 'cuuho']);
  assert.deepEqual(parseExtraArgs(['--remote-control'], { owner: true }).args, ['--remote-control']);
  assert.deepEqual(parseExtraArgs(['--remote-control', '--model', 'opus'], { owner: true }).args, ['--remote-control', '--model', 'opus'], 'optional value not swallowed from a flag');
  assert.deepEqual(parseExtraArgs(['--remote-control=cuuho', '-n', 'cuu-ho'], { owner: true }).args, ['--remote-control', 'cuuho', '--name', 'cuu-ho']);
  assert.deepEqual(parseExtraArgs(['--model', 'claude-opus-5-5']).args, ['--model', 'claude-opus-5-5']);
  assert.match(parseExtraArgs(['--remote-control', 'x']).error, /owner-only/);
  assert.match(parseExtraArgs(['--remote-control-session-name-prefix', 'p']).error, /owner-only/);
  for (const bad of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--mcp-config', 'x.json'], ['--settings', 'x'], ['--add-dir', '/'], ['--remote-controlx'], ['-nfoo'], ['--model']]) {
    assert.ok(parseExtraArgs(bad, { owner: true }).error, `refused: ${bad.join(' ')}`);
  }
  for (const v of ['a b', 'x;rm', '-x', '$(id)', '', 'a/b']) assert.ok(parseExtraArgs(['--model', v], { owner: true }).error, `bad value ${JSON.stringify(v)}`);
  assert.match(parseExtraArgs(['--remote-control=x;y'], { owner: true }).error, /plain value/);
  assert.match(parseExtraArgs(['-n', 'a', '--name', 'b']).error, /twice/);
  assert.deepEqual(parseExtraArgs([]).args, []);
  assert.deepEqual(stripOwnerOnly(['--remote-control', 'cuuho', '--model', 'opus', '--remote-control-session-name-prefix', 'p']), ['--model', 'opus']);
  assert.deepEqual(stripOwnerOnly(['--remote-control', '--name', 'n']), ['--name', 'n']);
});

test('stored flags: one file per session; owner-set remote control survives, anyone else\'s is dropped; tampering refused', () => {
  const dir = tmp();
  saveExtraArgs(SID, ['--remote-control', 'cuuho', '--model', 'opus'], { setBy: 'owner', dir });
  assert.equal(fs.statSync(path.join(dir, `${SID}.json`)).mode & 0o777, 0o600);
  assert.deepEqual(loadExtraArgs(SID, { dir }), { args: ['--remote-control', 'cuuho', '--model', 'opus'], dropped: null });
  saveExtraArgs(SID, ['--remote-control', 'cuuho', '--model', 'opus'], { setBy: 'agent', dir });
  const l = loadExtraArgs(SID, { dir });
  assert.deepEqual(l.args, ['--model', 'opus']);
  assert.match(l.dropped, /not set by the owner/);
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ args: ['--dangerously-skip-permissions'], setBy: 'owner' }));
  assert.equal(loadExtraArgs(SID, { dir }).args.length, 0);
  assert.match(loadExtraArgs(SID, { dir }).dropped, /ignored/);
  clearExtraArgs(SID, { dir });
  assert.deepEqual(loadExtraArgs(SID, { dir }), { args: [], dropped: null });
  assert.throws(() => saveExtraArgs('../x', [], { dir }), /bad session id/);
});

test('buildSpawnPlan: forwarded flags sit right after --permission-mode, before --session-id/--resume; prompt stays last', () => {
  const p = buildSpawnPlan({ interactive: true, extraArgs: ['--remote-control'] });
  const c = p.command;
  assert.equal(c[c.indexOf('--permission-mode') + 2], '--remote-control');
  assert.ok(c.indexOf('--session-id') > c.indexOf('--remote-control'), 'bare --remote-control must not swallow the session id');
  assert.ok(c.at(-1).startsWith('Find and read'), 'prompt is the final element');
  const r = buildSpawnPlan({ interactive: true, resumeSessionId: SID, extraArgs: ['--remote-control', 'cuuho'] });
  assert.deepEqual(r.command.slice(4, 11), ['claude', '--permission-mode', 'auto', '--remote-control', 'cuuho', '--resume', SID]);
  assert.deepEqual(r.extraArgs, ['--remote-control', 'cuuho']);
  assert.throws(() => buildSpawnPlan({ extraArgs: ['--model', 'opus'] }), /interactive/);
  assert.throws(() => buildSpawnPlan({ interactive: true, extraArgs: ['--dangerously-skip-permissions'] }), /not allowed/);
  assert.equal(buildSpawnPlan({ interactive: true }).command.includes('--remote-control'), false);
});

const deps = (over = {}) => {
  const log = { ran: [], saved: [], cleared: 0 };
  let up = false, dieAfter = false;
  const d = {
    acquireLock: () => ({ release() {}, markFailed() { log.failed = true; } }),
    listProcs: () => [], transcriptDirs: () => ['-w-x'],
    screenExists: () => up && !(dieAfter && log.slept),
    run: (plan) => { log.ran.push(plan); up = true; },
    sleep: async (ms) => { if (ms === 1) log.slept = true; }, timeoutMs: 1000, pollMs: 250, settleMs: 1,
    extras: { load: () => ({ args: ['--remote-control', 'cuuho'], dropped: null }), save: (id, a, o) => log.saved.push([a, o.setBy]), clear: () => { log.cleared++; } },
    ...over,
  };
  return { d, log, die: () => { dieAfter = true; } };
};

test('performResume: not given → re-applies stored; given → used + saved with setBy; "--" alone → cleared; stored ones never re-saved', async () => {
  let { d, log } = deps();
  let r = await performResume({ sessionId: SID, cwd: '/w/x' }, d);
  assert.equal(r.ok, true);
  assert.ok(log.ran[0].command.includes('--remote-control'));
  assert.deepEqual(log.saved, [], 'a re-applied set is not re-saved (would rewrite setBy)');
  ({ d, log } = deps());
  r = await performResume({ sessionId: SID, cwd: '/w/x', extraArgs: ['--model', 'opus'], setBy: 'owner' }, d);
  assert.deepEqual(log.saved, [[['--model', 'opus'], 'owner']]);
  assert.equal(log.ran[0].command.includes('--remote-control'), false, 'given flags replace the stored ones');
  ({ d, log } = deps());
  r = await performResume({ sessionId: SID, cwd: '/w/x', extraArgs: [] }, d);
  assert.equal(log.cleared, 1);
  assert.equal(log.ran[0].command.includes('--remote-control'), false);
});

test('performResume: claude exiting right after launch (rejected flag) is FAILED, flags not saved', async () => {
  const { d, log, die } = deps();
  die();
  const r = await performResume({ sessionId: SID, cwd: '/w/x', extraArgs: ['--model', 'opus'], setBy: 'owner' }, d);
  assert.match(r.error, /exited right after launch/);
  assert.equal(log.failed, true);
  assert.deepEqual(log.saved, []);
});

test('CLI: refusals happen before anything launches (misplaced flag, forbidden flag, owner-only from a non-owner)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const spawnJs = fileURLToPath(new URL('./spawn.mjs', import.meta.url));
  const env = { ...process.env, TELE_FROM_ID: '', PATH: '/nonexistent' }; // no claude/screen on PATH: nothing could launch anyway
  const run = (...a) => spawnSync(process.execPath, [spawnJs, ...a], { env, encoding: 'utf8', input: '', timeout: 15000 });
  let r = run('--interactive', '--remote-control', 'cuuho');
  assert.equal(r.status, 1); assert.match(r.stderr, /put it after "--"/);
  r = run('--interactive', '--', '--dangerously-skip-permissions');
  assert.equal(r.status, 1); assert.match(r.stderr, /not allowed/);
  r = run('--interactive', '--', '--remote-control', 'cuuho');
  assert.equal(r.status, 1); assert.match(r.stderr, /owner-only/, 'no TTY + no owner TELE_FROM_ID = refused');
  r = run('--interactive', '—', '--remote-control', 'cuuho');
  assert.match(r.stderr, /owner-only/, 'em dash works as the separator too');
});
