// `/cswap` — wraps the `cswap` CLI (https://github.com/realiti4/claude-swap),
// the multi-account switcher for Claude Code, so it can be driven from Telegram:
//   /cswap        → cswap --list        (accounts + usage + running instances)
//   /cswap <n>    → cswap --switch-to <n>  (switch the active account)
// `cswap` must already be installed and on PATH (it is on this host). Switching
// accounts is host-wide — it affects every agent sharing this machine's Claude
// Code login — so the command is gated to maintainer in commands.json.
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CSWAP_TIMEOUT_MS = 30 * 1000;

// Build the cswap argv for a given `/cswap [target]` invocation. Pure (no I/O),
// so it's directly testable without shelling out.
export function planCswap(args) {
  const target = args[0];
  if (target === undefined) return { argv: ['--list'] };
  return { argv: ['--switch-to', target] };
}

if (isMainModule(import.meta.url)) {
  const plan = planCswap(process.argv.slice(2));
  const r = spawnSync('cswap', plan.argv, { timeout: CSWAP_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  if (r.error) { process.stdout.write(`❌ ${r.error.code === 'ENOENT' ? 'cswap not found on PATH' : r.error.message}\n`); process.exit(1); }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(`\n[stderr]\n${r.stderr}`);
  if (r.signal) process.stdout.write(`\n[killed: ${r.signal}]\n`);
  process.exit(r.status == null ? 1 : r.status);
}
