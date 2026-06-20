import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPackageManager, readPackageScripts, buildRunArgv, planRun } from './run.mjs';

// A fake project dir with package.json (scripts) + optional lockfile.
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

test('readPackageScripts: an array "scripts" is treated as no scripts', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'run-parent-'));
  const proj = path.join(parent, 'p'); fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: ['a', 'b'] }));
  assert.deepEqual(readPackageScripts(proj).scripts, {}); // array → {}
  fs.rmSync(parent, { recursive: true, force: true });
});

test('buildRunArgv: `--` delimits trailing args so they reach the SCRIPT not the PM', () => {
  assert.deepEqual(buildRunArgv('dev', []), ['run', 'dev']);
  assert.deepEqual(buildRunArgv('dev', ['--port', '3000']), ['run', 'dev', '--', '--port', '3000']);
  // a hostile --prefix lands after the delimiter → it cannot redirect the PM cwd.
  assert.deepEqual(buildRunArgv('dev', ['--prefix', '/etc']), ['run', 'dev', '--', '--prefix', '/etc']);
});

test('planRun: detects pm + builds argv for a valid script', () => {
  const { proj, cleanup } = fakeProject({ dev: 'vite' }, { lock: 'pnpm-lock.yaml' });
  const p = planRun(proj, 'dev', ['--port', '3000']);
  assert.equal(p.pm, 'pnpm');
  assert.deepEqual(p.argv, ['run', 'dev', '--', '--port', '3000']);
  assert.equal(p.cwd, proj);
  cleanup();
});

test('planRun: missing script → error listing available, never plans', () => {
  const { proj, cleanup } = fakeProject({ dev: 'vite', build: 'vite build' });
  const p = planRun(proj, 'nope', []);
  assert.ok(p.error && /script "nope" không có/.test(p.error));
  assert.match(p.error, /dev, build/);
  cleanup();
});

test('planRun: rejects a script name starting with "-" (PM-flag injection)', () => {
  // Define a script literally NAMED "--prefix" so the hasOwnProperty check would
  // PASS — isolating the `startsWith('-')` guard: assert the specific error, so
  // this test fails if that guard is reverted (it would then fall through to a
  // valid plan instead of erroring).
  const { proj, cleanup } = fakeProject({ '--prefix': 'evil', dev: 'vite' });
  assert.match(planRun(proj, '--prefix', []).error, /invalid script name/);
  assert.match(planRun(proj, '-x', ['build']).error, /invalid script name/);
  assert.ok(planRun(proj, '', []).error); // empty → usage error
  cleanup();
});

test('planRun: prototype-chain "scripts" (toString/constructor) are NOT runnable', () => {
  const { proj, cleanup } = fakeProject({ dev: 'vite' });
  const p = planRun(proj, 'toString', []);
  assert.ok(p.error && /script "toString" không có/.test(p.error)); // hasOwnProperty guard
  cleanup();
});

test('planRun: no package.json → error', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'run-parent-'));
  const proj = path.join(parent, 'proj'); fs.mkdirSync(proj); // dir but no package.json
  assert.ok(planRun(proj, 'dev', []).error);
  fs.rmSync(parent, { recursive: true, force: true });
});
