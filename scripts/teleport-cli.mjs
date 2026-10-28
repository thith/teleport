// teleport-cli.mjs — pure logic behind the `teleport` terminal command (RFC 27).
//
// `bin/teleport.mjs` is the thin runner; everything testable lives here: argv
// parsing, the help text, and `install` (symlink into ~/.local/bin).
//
// WHY the wrapper builds spawn.mjs argv itself instead of forwarding argv:
// spawn.mjs picks its mode with `argv.includes(...)` in a fixed order (help →
// list → kill → attach → …), so forwarding blindly would make
// `teleport attach --kill tele-x` KILL, and `teleport spawn luni` silently spawn
// headless. Each subcommand therefore has its own tiny allowlist.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PERMISSION_MODES } from './spawn.mjs';
import { SEPARATORS } from './spawn-extra-args.mjs';

// Full topic hashtag (not the 3-char tail). Same shape as the HASHTAG_RE family.
export const KILL_ID_RE = /^[a-j]\d{7}$/i;

export const HELP = `teleport — list / attach / kill / spawn Telegram-connected agents from a terminal

Usage:
  teleport ls [full]                 list running agents ("full" = detailed blocks)
  teleport attach [<id>]             re-attach this terminal to an interactive agent (alias: a)
  teleport kill <hashtag>            gracefully stop an agent (alias: k)
  teleport spawn [--headless] [--mode <m>] [-- <claude flags>]
                                     start a new agent in the CURRENT folder (its Telegram group)
  teleport install                   symlink this command into ~/.local/bin
  teleport help | -h | --help        show this help

Notes:
  <id>        the last 3 chars of the hashtag, the full hashtag, or tele-<hashtag>;
              omit it when only one session is live. Write it WITHOUT "#"
              (bash treats "#" as a comment).
  kill        needs the FULL hashtag (e.g. d1331668). Killing by name or pid:<PID>
              is Telegram /kill only.
  spawn       interactive by default (subscription billing, runs in screen);
              --headless runs "claude -p" instead (Agent SDK pool).
              --mode <default|auto|acceptEdits|bypassPermissions|dontAsk|plan>
              (default auto). Everything after "--" goes to claude (spawn.mjs
              filters it against its own allowlist).
  detach      Ctrl-A then D leaves an attached agent running.
`;

const stripId = (s) => s.replace(/^#/, '').replace(/^tele-/i, '');

/**
 * Turn argv (without node + script) into one of
 *   { spawnArgs } | { help: true } | { install: true } | { error }.
 */
export function parse(argv) {
  const [sub, ...rest] = argv;
  const helpRequested = (a) => a.slice(0, a.indexOf('--') === -1 ? a.length : a.indexOf('--')).some((x) => x === '--help' || x === '-h' || x === '-help');
  if (!sub || ['help', '-h', '-help', '--help'].includes(sub)) return { help: true };
  if (helpRequested(rest)) return { help: true };

  switch (sub) {
    case 'ls': {
      if (rest.length === 0) return { spawnArgs: ['--list'] };
      if (rest.length === 1 && rest[0] === 'full') return { spawnArgs: ['--list', 'full'] };
      return { error: `ls: unexpected argument "${rest.find((a) => a !== 'full') ?? rest[1]}" (only "full" is accepted)` };
    }
    case 'attach':
    case 'a': {
      if (rest.length > 1) return { error: `${sub}: takes at most one <id>` };
      if (rest.length === 0) return { spawnArgs: ['--attach'] };
      const id = rest[0].replace(/^#/, '');
      if (!id) return { error: `${sub}: empty <id>` };
      // Check AFTER stripping "#": a quoted '#--help' must not reach spawn.mjs as a flag.
      // spawn.mjs also reads '—' / '–' (phone dashes) as the "--" separator and would drop the id.
      if (id.startsWith('-') || SEPARATORS.has(id)) return { error: `${sub}: unknown option "${rest[0]}"` };
      return { spawnArgs: ['--attach', id] };
    }
    case 'kill':
    case 'k': {
      if (rest.length !== 1) return { error: `${sub}: needs exactly one <hashtag>` };
      if (rest[0].startsWith('-')) return { error: `${sub}: unknown option "${rest[0]}"` };
      const id = stripId(rest[0]);
      if (!KILL_ID_RE.test(id)) {
        return { error: `${sub}: "${rest[0]}" is not a full hashtag (e.g. d1331668). Killing by 3-char tail, name or pid: is only possible via Telegram /kill.` };
      }
      return { spawnArgs: ['--kill', `tele-${id}`] };
    }
    case 'spawn': {
      let headless = false;
      let mode = null;
      let passthrough = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--') { passthrough = rest.slice(i); break; }
        if (a === '--headless') { headless = true; continue; }
        if (a === '--mode' || a.startsWith('--mode=')) {
          const v = a === '--mode' ? rest[++i] : a.slice('--mode='.length);
          if (mode !== null) return { error: 'spawn: --mode given twice' };
          if (!v || v.startsWith('-')) return { error: 'spawn: --mode needs a value (e.g. --mode plan)' };
          if (!PERMISSION_MODES.includes(v)) return { error: `spawn: unknown --mode "${v}" (one of: ${PERMISSION_MODES.join(', ')})` };
          mode = v;
          continue;
        }
        return { error: `spawn: unknown argument "${a}"` };
      }
      const spawnArgs = [];
      if (!headless) spawnArgs.push('--interactive');
      if (mode) spawnArgs.push('--mode', mode);
      spawnArgs.push(...passthrough);
      return { spawnArgs };
    }
    case 'install':
      if (rest.length) return { error: `install: unexpected argument "${rest[0]}"` };
      return { install: true };
    default:
      return { error: `unknown command "${sub}"` };
  }
}

// Worktree = `.git` is a file, or git-dir differs from git-common-dir.
function detectWorktree(root, fsImpl) {
  try {
    if (fsImpl.lstatSync(path.join(root, '.git')).isFile()) return true;
  } catch { /* no .git here */ }
  try {
    const run = (flag) => execFileSync('git', ['-C', root, 'rev-parse', flag], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.resolve(root, run('--git-dir')) !== path.resolve(root, run('--git-common-dir'));
  } catch {
    return false;
  }
}

/**
 * Symlink <home>/.local/bin/teleport → <root>/bin/teleport.mjs. Never
 * overwrites. Returns { code, out: string[], err: string[] } (caller prints).
 * Injectable: fs, env, home, isWorktree (for tests).
 */
export function install({ root, home, env = process.env, fs: fsImpl = fs, isWorktree } = {}) {
  const out = [];
  const err = [];
  const target = path.join(root, 'bin', 'teleport.mjs');
  const binDir = path.join(home, '.local', 'bin');
  const link = path.join(binDir, 'teleport');

  let st = null;
  try { st = fsImpl.lstatSync(link); } catch { /* absent */ }

  if (st) {
    let same = false;
    try { same = st.isSymbolicLink() && fsImpl.realpathSync(link) === fsImpl.realpathSync(target); } catch { /* dangling */ }
    if (same) return diagnose({ root, binDir, env, fsImpl, isWorktree, out: [`already installed: ${link} -> ${target}`], err });
    let what = 'a file or directory';
    if (st.isSymbolicLink()) {
      let dest = '?';
      try { dest = fsImpl.readlinkSync(link); } catch { /* ignore */ }
      what = `a symlink to ${dest}`;
    }
    err.push(`refusing to overwrite ${link}: it is ${what}. Remove it yourself if you want teleport there.`);
    return { code: 1, out, err };
  }

  try {
    fsImpl.mkdirSync(binDir, { recursive: true });
    fsImpl.symlinkSync(target, link);
  } catch (e) {
    err.push(`install failed: ${e.message}`);
    return { code: 1, out, err };
  }
  out.push(`installed: ${link} -> ${target}`);
  return diagnose({ root, binDir, env, fsImpl, isWorktree, out, err });
}

// Worktree / PATH / shadowing checks — run on a fresh install AND on "already
// installed", so a re-run explains why `teleport` still isn't found.
function diagnose({ root, binDir, env, fsImpl, isWorktree, out, err }) {
  if ((isWorktree ?? detectWorktree)(root, fsImpl)) {
    err.push(`warning: ${root} is a git worktree; the symlink breaks when the worktree is removed. Install from the main checkout for a permanent command.`);
  }

  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  const idx = dirs.indexOf(path.resolve(binDir));
  if (idx === -1) {
    out.push(`${binDir} is not in your PATH. Add this to ~/.bashrc or ~/.zshrc:`);
    out.push('  export PATH="$HOME/.local/bin:$PATH"');
  }
  for (const d of idx === -1 ? dirs : dirs.slice(0, idx)) {
    const other = path.join(d, 'teleport');
    let exists = false;
    try { exists = !!fsImpl.lstatSync(other); } catch { /* none */ }
    if (exists) err.push(`warning: another "teleport" comes earlier on PATH (${other}) and will shadow this one.`);
  }
  return { code: 0, out, err };
}
