// `/cswap` (alias `/cs`) — wraps the `cswap` CLI (https://github.com/realiti4/claude-swap),
// the multi-account switcher for Claude Code, so it can be driven from Telegram:
//   /cswap          → cswap --list           (accounts + usage + running instances)
//   /cswap <n>      → cswap --switch-to <n>  (switch the active account; number or email)
//   /cswap add      → cswap add              (add the current login as an account)
//   /cswap rm <n>   → cswap remove <n>       (confirmation "y" is piped in; typing it is the consent)
//   /cswap auto     → cswap auto --once      (one check; switch if near the limit)
//   /cswap upgrade  → cswap upgrade          (download the latest cswap)
//   /cswap switch <x> → cswap --switch-to <x> (force a switch; add/rm/remove/auto/upgrade/update
//                       are reserved words, so an account with such a name needs `switch`)
// `cswap` must already be installed and on PATH (it is on this host). Switching
// accounts is host-wide — it affects every agent sharing this machine's Claude
// Code login — so the command is gated to maintainer in commands.json.
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CSWAP_TIMEOUT_MS = 30 * 1000;

export const CSWAP_UPGRADE_TIMEOUT_MS = 180 * 1000;

// Build the cswap invocation for `/cswap [sub|target] ...`. Pure (no I/O), so
// it's directly testable. Returns { argv, input?, timeoutMs? } or { error }.
// `input` is always fed to stdin ('' by default) so nothing can hang on a prompt.
export function planCswap(args) {
  const first = args[0];
  const blank = (x) => x == null || !String(x).trim();
  if (blank(first)) return { argv: ['--list'] };
  switch (String(first).trim().toLowerCase()) {
    case 'add': return { argv: ['add'] };
    case 'switch':
      if (blank(args[1])) return { error: 'cách dùng: /cs switch <số|email|alias>' };
      return { argv: ['--switch-to', args[1]] };
    case 'rm':
    case 'remove':
      if (blank(args[1])) return { error: 'cách dùng: /cs rm <số|email>' };
      return { argv: ['remove', args[1]], input: 'y\n' };
    case 'auto': return { argv: ['auto', '--once'] };
    case 'upgrade':
    case 'update': return { argv: ['upgrade'], timeoutMs: CSWAP_UPGRADE_TIMEOUT_MS };
    default: return { argv: ['--switch-to', first] };
  }
}

// Run `cmd` with the plan; resolves { stdout, stderr, status, signal, error }. The child is its own
// process group so on timeout the whole tree (e.g. `uv tool upgrade`) is killed: SIGTERM, then
// SIGKILL after killGraceMs.
export function runCswap(cmd, plan, { timeoutMs = CSWAP_TIMEOUT_MS, killGraceMs = 5000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, plan.argv, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { return resolve({ stdout: '', stderr: '', status: null, signal: null, error }); }
    let stdout = '', stderr = '', timedOut = false, done = false, hardKill = null;
    const grp = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const add = (cur, d) => (cur.length >= maxBytes ? cur : (cur + d.toString('utf8')).slice(0, maxBytes));
    child.stdout.on('data', (d) => { stdout = add(stdout, d); });
    child.stderr.on('data', (d) => { stderr = add(stderr, d); });
    child.stdin.on('error', () => {});
    child.stdin.end(plan.input ?? '');
    const timer = setTimeout(() => { timedOut = true; grp('SIGTERM'); hardKill = setTimeout(() => grp('SIGKILL'), killGraceMs); }, timeoutMs);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(hardKill); if (timedOut) grp('SIGKILL'); resolve({ stdout, stderr, ...r }); };
    child.on('error', (error) => finish({ status: null, signal: null, error }));
    child.on('close', (status, signal) => finish({ status, signal: timedOut ? 'timeout' : signal, error: null }));
  });
}

if (isMainModule(import.meta.url)) {
  const plan = planCswap(process.argv.slice(2));
  if (plan.error) { process.stdout.write(`${plan.error}\n`); process.exit(2); }
  const r = await runCswap('cswap', plan, { timeoutMs: plan.timeoutMs ?? CSWAP_TIMEOUT_MS });
  if (r.error) { process.stdout.write(`❌ ${r.error.code === 'ENOENT' ? 'cswap not found on PATH' : r.error.message}\n`); process.exit(1); }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(`\n[stderr]\n${r.stderr}`);
  if (r.signal) process.stdout.write(`\n[killed: ${r.signal}]\n`);
  process.exit(r.status == null ? 1 : r.status);
}
