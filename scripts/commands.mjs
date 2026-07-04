// Teleport command registry (RFC ext) — the daemon's commands are declared in
// `teleport/commands.json` (committed defaults, self-sufficient) and may be
// extended/overridden per-deployment via `projects.json._commands`. Each command
// maps a name → a teleport script the daemon runs:
//   { run: "<script>.mjs", args?: [...], needsProject?: bool, minRole?: role, desc?: str }
// A short alias for another command is `{ alias: "<name>" }` (e.g. `/w` → `/whisper`).
// The daemon is a thin, generic dispatcher: parse `/<cmd> [project] [args]`, gate
// by minRole, run `node scripts/<run> [...args]` (cwd = the project when
// needsProject), relay the script's stdout. Adding a command = a JSON entry + a
// script, never daemon code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const COMMANDS_FILE = path.join(__dirname, '..', 'commands.json');
export const COMMANDS_RESERVED_KEY = '_commands';

// Role ordering for minRole gates. `public` = no gate (anyone, even unmapped).
export const COMMAND_ROLE_RANK = { public: -1, member: 0, dev: 1, maintainer: 2, admin: 3 };

export function readCommandsFile(file = COMMANDS_FILE) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
  } catch { return {}; }
}

// Built-in commands.json merged with per-deployment `projects.json._commands`
// (custom entries win, so a deployment can override or add).
export function loadCommands({ commandsFile = COMMANDS_FILE, projectsConfig = {} } = {}) {
  const base = readCommandsFile(commandsFile);
  const custom = (projectsConfig && projectsConfig[COMMANDS_RESERVED_KEY] && typeof projectsConfig[COMMANDS_RESERVED_KEY] === 'object')
    ? projectsConfig[COMMANDS_RESERVED_KEY] : {};
  return { ...base, ...custom };
}

// A valid command entry must name a `.mjs` script with no path separators (it is
// resolved under teleport/scripts/) — guards a malicious `_commands` override
// from pointing `run` at an arbitrary path. Returns a NORMALISED spec (args/
// needsProject/minRole always present) so the dispatcher needn't re-default.
export function resolveCommand(name, registry) {
  // Own-property only: a command name colliding with an inherited member (e.g.
  // `/constructor`) must never resolve to a prototype value.
  const c = (registry && Object.prototype.hasOwnProperty.call(registry, name)) ? registry[name] : null;
  if (!c || typeof c !== 'object') return null;
  // Alias — `{ "w": { "alias": "whisper" } }` maps a short name onto another
  // command; the alias carries nothing of its own, everything comes from the
  // target. Resolve exactly ONE hop: the target must be a real command — a `run`
  // and NO `alias` of its own. Rejecting a target that itself carries an `alias`
  // (even alongside a `run`) is what makes this loop-proof: a cycle like
  // `{a:{alias:'a',run:'x.mjs'}}` or `a↔b` would otherwise re-enter this branch
  // every hop and blow the stack. The recursive call then can't re-enter here.
  if (typeof c.alias === 'string') {
    const target = Object.prototype.hasOwnProperty.call(registry, c.alias) ? registry[c.alias] : null;
    if (!target || typeof target !== 'object' || typeof target.run !== 'string' || typeof target.alias === 'string') return null;
    return resolveCommand(c.alias, registry);
  }
  if (typeof c.run !== 'string' || !/^[A-Za-z0-9._-]+\.mjs$/.test(c.run) || c.run.includes('..')) return null;
  return {
    run: c.run,
    args: Array.isArray(c.args) ? c.args.map(String) : [],
    needsProject: c.needsProject === true,
    minRole: typeof c.minRole === 'string' ? c.minRole : 'public',
    // Only commands that opt in receive the replied-to DM text (TELE_REPLY_TEXT).
    // Default false so arbitrary reply content never leaks to e.g. /run children.
    wantsReplyText: c.wantsReplyText === true,
    desc: typeof c.desc === 'string' ? c.desc : '',
  };
}

// Split a command's argument string into tokens, honouring single/double quotes
// (so `--grep "a b"` is ONE arg, not three). This is NOT a full shell parser:
// there is no backslash escaping and no nesting — a quote of one kind is literal
// inside the other (`'a "b" c'` → `a "b" c`), and a backslash is an ordinary
// char. That's enough for a control-DM command line (the daemon runs scripts via
// execFile, no shell). Unterminated quote → the rest becomes one token.
export function tokenizeArgs(str) {
  const tokens = [];
  let cur = '', quote = null, has = false;
  for (const c of String(str ?? '')) {
    if (quote) {
      if (c === quote) quote = null; else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; has = true;                 // a quote starts a token, even if empty ("")
    } else if (/\s/.test(c)) {
      if (has) { tokens.push(cur); cur = ''; has = false; }
    } else {
      cur += c; has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

// Does `role` meet `minRole`? `public`/unset → always true.
export function roleMeets(role, minRole) {
  if (minRole == null || minRole === 'public') return true;
  return (COMMAND_ROLE_RANK[role] ?? -1) >= (COMMAND_ROLE_RANK[minRole] ?? 99);
}
