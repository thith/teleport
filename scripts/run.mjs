// `/run <project> <script> [args]` — a daemon command. The daemon runs it with
// cwd = the project, passing `<script> [args]`. It auto-detects the project's
// package manager, validates the script in package.json, then runs
// `<pm> run <script> -- <args>` (no shell), streaming output to stdout for the
// daemon to relay. Remote code execution — gated to maintainer by the registry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { spawnSync } from 'node:child_process';

export const RUN_TIMEOUT_MS = 5 * 60 * 1000;
export const RUN_MAX_BUFFER = 8 * 1024 * 1024;

// Detect the package manager: package.json `packageManager` field → lockfile
// (pnpm > yarn > npm) → npm default. Pure (deps injectable).
export function detectPackageManager(cwd, { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0].trim() : '';
    if (pm === 'pnpm' || pm === 'yarn' || pm === 'npm') return pm;
  } catch { /* fall through */ }
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
  return 'npm';
}

// Read package.json scripts. Returns {scripts} or {error}. An array `scripts` is
// treated as none (typeof [] === 'object'); pure (readFileSync injectable).
export function readPackageScripts(cwd, { readFileSync = fs.readFileSync } = {}) {
  let raw;
  try { raw = readFileSync(path.join(cwd, 'package.json'), 'utf8'); }
  catch { return { error: `no package.json in ${cwd}` }; }
  let pkg;
  try { pkg = JSON.parse(raw); } catch { return { error: 'package.json is not valid JSON' }; }
  const scripts = (pkg && pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) ? pkg.scripts : {};
  return { scripts };
}

// Build the package-manager argv. The `--` makes trailing args go to the SCRIPT,
// not the PM (so `--prefix`/`--dir`/`--cwd` can't redirect the PM out of cwd).
export function buildRunArgv(script, args) {
  return args.length ? ['run', script, '--', ...args] : ['run', script];
}

// Validate + return {pm, argv, cwd} or {error}. `script` must not start with '-'
// (else the PM parses it as a flag) and must be an OWN property of `scripts`.
export function planRun(cwd, script, args, { detect = detectPackageManager, read = readPackageScripts } = {}) {
  if (!script) return { error: 'usage: /run <project> <script> [args...]' };
  if (script.startsWith('-')) return { error: `invalid script name: ${JSON.stringify(script)}` };
  const pkg = read(cwd);
  if (pkg.error) return { error: pkg.error };
  if (!Object.prototype.hasOwnProperty.call(pkg.scripts, script)) {
    const avail = Object.keys(pkg.scripts);
    return { error: `script "${script}" không có trong package.json. Có: ${avail.length ? avail.join(', ') : '(không có script nào)'}` };
  }
  return { pm: detect(cwd), argv: buildRunArgv(script, args), cwd };
}

if (isMainModule(import.meta.url)) {
  const [script, ...args] = process.argv.slice(2);
  const cwd = process.cwd();
  const plan = planRun(cwd, script, args);
  if (plan.error) { process.stdout.write(`❌ ${plan.error}\n`); process.exit(1); }
  process.stdout.write(`▶️ ${plan.pm} ${plan.argv.join(' ')}\n`);
  const r = spawnSync(plan.pm, plan.argv, { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: RUN_MAX_BUFFER, encoding: 'utf8' });
  if (r.error) { process.stdout.write(`❌ ${r.error.code === 'ENOENT' ? `${plan.pm} not found on PATH` : r.error.message}\n`); process.exit(1); }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(`\n[stderr]\n${r.stderr}`);
  if (r.signal) process.stdout.write(`\n[killed: ${r.signal}]\n`);
  process.exit(r.status == null ? 1 : r.status);
}
