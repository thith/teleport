#!/usr/bin/env node
// teleport — terminal command for listing / attaching / killing / spawning
// agents (RFC 27). Thin runner over scripts/spawn.mjs; parsing, help and
// install live in scripts/teleport-cli.mjs so they can be unit-tested.
//
// Exit codes: bad args 2; spawn.mjs's own status; killed by a signal →
// 128 + signal number; couldn't even start it → 127.

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../scripts/is-direct-run.mjs';
import { HELP, parse, install } from '../scripts/teleport-cli.mjs';

function main() {
  // import.meta.url is the symlink-resolved real path, so this works via ~/.local/bin/teleport.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const parsed = parse(process.argv.slice(2));

  if (parsed.help) { process.stdout.write(HELP); return 0; }
  if (parsed.error) {
    process.stderr.write(`teleport: ${parsed.error}\n\n${HELP}`);
    return 2;
  }
  if (parsed.install) {
    const r = install({ root, home: process.env.HOME || os.homedir() });
    for (const l of r.out) console.log(l);
    for (const l of r.err) console.error(l);
    return r.code;
  }

  // TELEPORT_CLI_SPAWN: tests only — substitute a fake spawn script.
  const script = process.env.TELEPORT_CLI_SPAWN || path.join(root, 'scripts', 'spawn.mjs');
  // Keep cwd (spawn.mjs picks the Telegram group from it) and the TTY (attach).
  const res = spawnSync(process.execPath, [script, ...parsed.spawnArgs], { stdio: 'inherit' });
  if (res.error) {
    console.error(`teleport: cannot run spawn.mjs: ${res.error.message}`);
    return 127;
  }
  if (typeof res.status === 'number') return res.status;
  return 128 + (os.constants.signals[res.signal] ?? 0);
}

if (isMainModule(import.meta.url)) process.exit(main());
