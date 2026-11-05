import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCswap, runCswap } from './cswap.mjs';

test('planCswap: no args → --list', () => {
  assert.deepEqual(planCswap([]), { argv: ['--list'] });
});

test('planCswap: numeric target → --switch-to <n>', () => {
  assert.deepEqual(planCswap(['2']), { argv: ['--switch-to', '2'] });
});

test('planCswap: email target passes through verbatim (cswap itself validates NUM|EMAIL)', () => {
  assert.deepEqual(planCswap(['a@b.com']), { argv: ['--switch-to', 'a@b.com'] });
});

test('planCswap: only the first token is used as target', () => {
  assert.deepEqual(planCswap(['2', 'extra']), { argv: ['--switch-to', '2'] });
});

test('planCswap: add', () => {
  assert.deepEqual(planCswap(['add']), { argv: ['add'] });
});

test('planCswap: rm/remove <target> → remove with "y" on stdin', () => {
  assert.deepEqual(planCswap(['rm', '2']), { argv: ['remove', '2'], input: 'y\n' });
  assert.deepEqual(planCswap(['remove', 'a@b.com']), { argv: ['remove', 'a@b.com'], input: 'y\n' });
});

test('planCswap: rm without target → usage error, no argv', () => {
  assert.deepEqual(planCswap(['rm']), { error: 'cách dùng: /cs rm <số|email>' });
  assert.equal(planCswap(['remove']).argv, undefined);
});

test('planCswap: auto → auto --once', () => {
  assert.deepEqual(planCswap(['auto']), { argv: ['auto', '--once'] });
});

test('planCswap: upgrade/update → upgrade with a long timeout', () => {
  assert.deepEqual(planCswap(['upgrade']), { argv: ['upgrade'], timeoutMs: 180000 });
  assert.deepEqual(planCswap(['update']), { argv: ['upgrade'], timeoutMs: 180000 });
});

test('planCswap: keywords are case-insensitive; target keeps its case', () => {
  assert.deepEqual(planCswap(['ADD']), { argv: ['add'] });
  assert.deepEqual(planCswap(['Rm', 'A@B.com']), { argv: ['remove', 'A@B.com'], input: 'y\n' });
  assert.deepEqual(planCswap(['Auto']), { argv: ['auto', '--once'] });
});

test('/cs is an alias of /cswap in commands.json', async () => {
  const fs = await import('node:fs');
  const { resolveCommand } = await import('./commands.mjs');
  const reg = JSON.parse(fs.readFileSync(new URL('../commands.json', import.meta.url), 'utf8'));
  assert.equal(resolveCommand('cs', reg).run, 'cswap.mjs');
  assert.deepEqual(resolveCommand('cs', reg), resolveCommand('cswap', reg));
});

test('planCswap: switch <x> forces a switch, even for reserved words', () => {
  assert.deepEqual(planCswap(['switch', 'auto']), { argv: ['--switch-to', 'auto'] });
  assert.deepEqual(planCswap(['SWITCH', '2']), { argv: ['--switch-to', '2'] });
  assert.deepEqual(planCswap(['switch']), { error: 'cách dùng: /cs switch <số|email|alias>' });
});

test('planCswap: blank targets count as missing', () => {
  assert.deepEqual(planCswap(['']), { argv: ['--list'] });
  assert.deepEqual(planCswap(['  ']), { argv: ['--list'] });
  assert.deepEqual(planCswap(['rm', '']), { error: 'cách dùng: /cs rm <số|email>' });
  assert.deepEqual(planCswap(['rm', ' ']), { error: 'cách dùng: /cs rm <số|email>' });
  assert.deepEqual(planCswap(['switch', '']), { error: 'cách dùng: /cs switch <số|email|alias>' });
});

test('runCswap: feeds stdin, collects stdout/stderr, returns exit status', async () => {
  const r = await runCswap(process.execPath, { argv: ['-e', 'process.stdin.on("data",d=>{process.stdout.write("got:"+d);console.error("e");process.exit(3)})'], input: 'y\n' });
  assert.equal(r.stdout, 'got:y\n'); assert.equal(r.stderr, 'e\n'); assert.equal(r.status, 3); assert.equal(r.signal, null);
});

test('runCswap: timeout kills the whole process group (grandchild too)', async () => {
  const code = 'const {spawn}=require("child_process");const c=spawn("sleep",["60"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)';
  const r = await runCswap(process.execPath, { argv: ['-e', code] }, { timeoutMs: 700, killGraceMs: 300 });
  assert.equal(r.signal, 'timeout');
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0);
  await new Promise((res) => setTimeout(res, 200));
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'grandchild must be gone');
});
