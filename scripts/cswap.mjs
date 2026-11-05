// `/cswap` (alias `/cs`) — wraps the `cswap` CLI (https://github.com/realiti4/claude-swap),
// the multi-account switcher for Claude Code, so it can be driven from Telegram:
//   /cswap          → cswap --list           (accounts + usage + running instances)
//   /cswap <n>      → cswap --switch-to <n>  (switch the active account; number or email)
//   /cswap add      → cswap add              (add the current login as an account)
//   /cswap rm <n>   → cswap remove <n>       (confirmation "y" is piped in; typing it is the consent)
//   /cswap auto     → cswap auto --once      (one check; switch if near the limit)
//   /cswap upgrade  → cswap upgrade          (download the latest cswap)
// `cswap` must already be installed and on PATH (it is on this host). Switching
// accounts is host-wide — it affects every agent sharing this machine's Claude
// Code login — so the command is gated to maintainer in commands.json.
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CSWAP_TIMEOUT_MS = 30 * 1000;

export const CSWAP_UPGRADE_TIMEOUT_MS = 180 * 1000;

// Build the cswap invocation for `/cswap [sub|target] ...`. Pure (no I/O), so
// it's directly testable. Returns { argv, input?, timeoutMs? } or { error }.
// `input` is always fed to stdin ('' by default) so nothing can hang on a prompt.
export function planCswap(args) {
  const first = args[0];
  if (first === undefined) return { argv: ['--list'] };
  switch (String(first).toLowerCase()) {
    case 'add': return { argv: ['add'] };
    case 'rm':
    case 'remove':
      if (args[1] === undefined) return { error: 'cách dùng: /cs rm <số|email>' };
      return { argv: ['remove', args[1]], input: 'y\n' };
    case 'auto': return { argv: ['auto', '--once'] };
    case 'upgrade':
    case 'update': return { argv: ['upgrade'], timeoutMs: CSWAP_UPGRADE_TIMEOUT_MS };
    default: return { argv: ['--switch-to', first] };
  }
}

if (isMainModule(import.meta.url)) {
  const plan = planCswap(process.argv.slice(2));
  if (plan.error) { process.stdout.write(`${plan.error}\n`); process.exit(2); }
  const r = spawnSync('cswap', plan.argv, { input: plan.input ?? '', timeout: plan.timeoutMs ?? CSWAP_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  if (r.error) { process.stdout.write(`❌ ${r.error.code === 'ENOENT' ? 'cswap not found on PATH' : r.error.message}\n`); process.exit(1); }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(`\n[stderr]\n${r.stderr}`);
  if (r.signal) process.stdout.write(`\n[killed: ${r.signal}]\n`);
  process.exit(r.status == null ? 1 : r.status);
}
