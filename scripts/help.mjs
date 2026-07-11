// `/help` — list available Telegram commands with their sample syntax. A daemon
// command: prints the formatted list to stdout; the daemon relays it to the
// chat. Public (no role gate) so anyone can discover what exists. Data-driven
// from `commands.json` (each command's `desc` carries its usage), so /help can
// never drift from the real command table. Aliases are shown as `/x = /full`.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const COMMANDS_FILE = path.join(__dirname, '..', 'commands.json');

// Pure + total so it is unit-testable without shelling out. `commands` is the
// parsed commands.json object; injectable for tests.
export function renderHelp(commands) {
  const real = [];
  const aliases = [];
  for (const [name, spec] of Object.entries(commands)) {
    if (spec && spec.alias) aliases.push(`/${name} = /${spec.alias}`);
    else real.push({ name, desc: (spec && spec.desc) || '', role: (spec && spec.minRole) || 'public' });
  }
  const lines = ['📖 Teleport commands — usage', ''];
  for (const c of real) {
    // desc already embeds the sample syntax for commands that take args
    // (e.g. "/whisper #<hash> <text> …"). Tag non-public commands with the
    // role needed so users know what they can actually run.
    const roleTag = c.role !== 'public' ? `  [${c.role}]` : '';
    lines.push(`• /${c.name} — ${c.desc}${roleTag}`);
  }
  if (aliases.length) { lines.push('', `Aliases: ${aliases.join('  ·  ')}`); }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const commands = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8'));
  process.stdout.write(renderHelp(commands) + '\n');
}
