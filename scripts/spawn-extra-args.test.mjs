import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitForwarded, misplacedFlag, parseExtraArgs, stripOwnerOnly, saveExtraArgs, loadExtraArgs, clearExtraArgs, isOwnerCaller } from './spawn-extra-args.mjs';
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
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({ args: ['--remote-control', 'x'] }));
  assert.deepEqual(loadExtraArgs(SID, { dir }).args, [], 'no setBy = not the owner');
  clearExtraArgs(SID, { dir });
  assert.deepEqual(loadExtraArgs(SID, { dir }), { args: [], dropped: null });
  assert.throws(() => saveExtraArgs('../x', [], { dir }), /bad session id/);
});

test('buildSpawnPlan: forwarded flags come right after `claude` (next token is always a flag); prompt stays last', () => {
  for (const p of [buildSpawnPlan({ interactive: true, extraArgs: ['--remote-control'] }), buildSpawnPlan({ interactive: true, sessionName: 'tele-x', extraArgs: ['--remote-control'] })]) {
    const c = p.command, at = c.indexOf('--remote-control');
    assert.equal(c[at - 1], 'claude');
    assert.ok(c[at + 1].startsWith('--'), 'a bare optional-value flag is never followed by a value-looking token');
    assert.ok(c.at(-1).startsWith('Find and read'), 'prompt is the final element');
  }
  const r = buildSpawnPlan({ interactive: true, resumeSessionId: SID, extraArgs: ['--remote-control', 'cuuho'] });
  assert.deepEqual(r.command.slice(4, 11), ['claude', '--remote-control', 'cuuho', '--permission-mode', 'auto', '--resume', SID]);
  assert.deepEqual(r.extraArgs, ['--remote-control', 'cuuho']);
  assert.throws(() => buildSpawnPlan({ extraArgs: ['--model', 'opus'] }), /interactive/);
  assert.throws(() => buildSpawnPlan({ interactive: true, extraArgs: ['--dangerously-skip-permissions'] }), /not allowed/);
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

test('isOwnerCaller: daemon relaying the owner, or a real terminal — never from inside a Claude Code session', () => {
  assert.equal(isOwnerCaller({ env: { TELE_FROM_ID: '144' }, ownerId: '144' }), true);
  assert.equal(isOwnerCaller({ env: { TELE_FROM_ID: '999' }, ownerId: '144' }), false);
  assert.equal(isOwnerCaller({ env: { TELE_FROM_ID: '144' }, ownerId: null }), false, 'no owner configured → no owner');
  assert.equal(isOwnerCaller({ env: {}, ownerId: '144' }), false);
  assert.equal(isOwnerCaller({ isTTY: true, env: {}, ownerId: '144' }), true);
  assert.equal(isOwnerCaller({ isTTY: true, env: { CLAUDECODE: '1' }, ownerId: '144' }), false, 'an agent faking a TTY with script(1)');
  assert.equal(isOwnerCaller({ env: { CLAUDECODE: '1', TELE_FROM_ID: '144' }, ownerId: '144' }), false);
});

test('performResume: "--" alone forgets stored flags only after a VERIFIED launch (a refused resume keeps them)', async () => {
  let { d, log } = deps({ acquireLock: () => ({ error: 'another resume in progress' }) });
  await performResume({ sessionId: SID, cwd: '/w/x', extraArgs: [] }, d);
  assert.equal(log.cleared, 0);
  ({ d, log } = deps());
  await performResume({ sessionId: SID, cwd: '/w/x', extraArgs: [] }, d);
  assert.equal(log.cleared, 1);
  ({ d, log } = deps({ extras: { load: () => ({ args: [], dropped: 'stored --remote-control ignored (not set by the owner)' }), save() {}, clear() {} } }));
  const r = await performResume({ sessionId: SID, cwd: '/w/x' }, d);
  assert.match(r.plan.extraNote, /not set by the owner/, 'the success line can say what was dropped');
});

test('CLI: a fresh spawn really forwards the flags (dry-run seam); resume.mjs splits before joining', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bin = tmp();
  for (const b of ['claude', 'screen']) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TELEPORT_SPAWN_DRY_RUN: '1', TELE_FROM_ID: '' };
  delete env.CLAUDECODE;
  // --model is not owner-only, so this needs no owner config (projects.json is not in git).
  const r = spawnSync(process.execPath, [path.join(here, 'spawn.mjs'), '--interactive', '—', '--model', 'opus'], { env, encoding: 'utf8', input: '', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.command.slice(4, 7), ['claude', '--model', 'opus']);
  assert.equal(out.setBy, 'agent', 'no TTY, no owner TELE_FROM_ID');
  const r2 = spawnSync(process.execPath, [path.join(here, 'resume.mjs'), 'nobody', '--', '--dangerously-skip-permissions'], { env, encoding: 'utf8', input: '', timeout: 15000 });
  assert.match(r2.stdout, /not allowed/, 'resume.mjs validates the part after "--" instead of joining it into the name');
});
