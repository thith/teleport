// Forwarding a few `claude` flags through spawn (RFC 18 §A/§9): `spawn.mjs -i … -- --remote-control cuuho`.
//
// Security (spawn is reachable from Telegram via the daemon, and — the real
// path for anyone but the owner — via an agent running spawn.mjs for them):
// - argv is split at the FIRST separator BEFORE any spawn flag is read, so
//   `-- --restart` / `-- --mode auto` can never steer spawn itself;
// - only an exact-token allowlist is forwarded; values are plain identifiers;
// - `--remote-control*` (drive the session from a phone) is OWNER-only, and a
//   stored copy set by anyone else is dropped when it is re-applied on resume.
// Order matters: claude's `--remote-control [name]` takes an OPTIONAL value, so
// it must sit before `--session-id|--resume <uuid>` or it swallows the next token
// (measured: placed last, it ate the prompt). buildSpawnPlan keeps that order.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXTRA_ARGS_DIR = path.join(__dirname, 'tmp', 'spawn-extra-args');

// `--` plus what phone keyboards turn it into (iOS smart punctuation: em/en dash).
export const SEPARATORS = new Set(['--', '—', '–']);

// canonical flag → { value: 'optional' | 'required', owner: boolean }
export const ALLOWED = {
  '--remote-control': { value: 'optional', owner: true },
  '--remote-control-session-name-prefix': { value: 'required', owner: true },
  '--model': { value: 'required', owner: false },
  '--name': { value: 'required', owner: false },
};
const ALIASES = { '-n': '--name' };
export const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** argv → { own, fwd } — fwd = null (no separator) | [] (separator, nothing after) | tokens. Pure. */
export function splitForwarded(argv) {
  const i = argv.findIndex((a) => SEPARATORS.has(a));
  return i === -1 ? { own: argv, fwd: null } : { own: argv.slice(0, i), fwd: argv.slice(i + 1) };
}

const flagOf = (tok) => {
  const name = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
  return ALIASES[name] || name;
};

/** A spawn-side token that is really one of our claude flags → hint, else null. Pure. */
export function misplacedFlag(own) {
  const t = own.find((a) => Object.prototype.hasOwnProperty.call(ALLOWED, flagOf(a)));
  return t ? `"${t}" is a claude flag — put it after "--" (e.g. /spawn <project> -- ${t} …).` : null;
}

/**
 * Validate + normalise forwarded tokens → { args } | { error }. `owner` = the
 * caller may set owner-only flags. Exact tokens only; `--flag=value` accepted
 * and split; `-nvalue` refused; each flag (aliases included) at most once. Pure.
 */
export function parseExtraArgs(tokens, { owner = false } = {}) {
  const out = [], seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const eq = tok.startsWith('--') && tok.includes('=');
    const flag = flagOf(tok);
    const spec = Object.prototype.hasOwnProperty.call(ALLOWED, flag) ? ALLOWED[flag] : null;
    if (!spec || (!eq && tok !== flag && !ALIASES[tok])) {
      return { error: `claude flag "${tok}" is not allowed through spawn (allowed: ${Object.keys(ALLOWED).join(', ')}, -n).` };
    }
    if (spec.owner && !owner) return { error: `"${flag}" is owner-only (send it to the daemon yourself, or run spawn in your own terminal).` };
    if (seen.has(flag)) return { error: `"${flag}" given twice.` };
    seen.add(flag);
    let value = null;
    if (eq) value = tok.slice(tok.indexOf('=') + 1);
    else if (spec.value === 'required' || (i + 1 < tokens.length && !tokens[i + 1].startsWith('-'))) {
      value = tokens[i + 1] ?? '';
      if (spec.value === 'required' || value) i++;
    }
    if (value !== null && !VALUE_RE.test(value)) return { error: `"${flag}" needs a plain value (letters, digits, . _ : -), got ${JSON.stringify(value)}.` };
    if (spec.value === 'required' && value === null) return { error: `"${flag}" needs a value.` };
    out.push(flag, ...(value !== null ? [value] : []));
  }
  return { args: out };
}

/**
 * May this caller set owner-only flags? The daemon relaying the OWNER's command
 * (TELE_FROM_ID = projects.json owner), or a human at a real terminal — but never
 * from inside a Claude Code session (CLAUDECODE=1 on every Bash-tool child):
 * an agent can fake a TTY with script(1). Pure.
 */
export function isOwnerCaller({ isTTY = false, env = {}, ownerId = null } = {}) {
  if (env.CLAUDECODE) return false;
  if (ownerId && env.TELE_FROM_ID && String(env.TELE_FROM_ID) === String(ownerId)) return true;
  return Boolean(isTTY);
}

export const hasRemoteControl = (args) => (args || []).some((a) => a === '--remote-control' || a === '--remote-control-session-name-prefix');

/** Drop owner-only flags (and their values) from normalised args. Pure. */
export function stripOwnerOnly(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const spec = ALLOWED[args[i]];
    const hasValue = spec && i + 1 < args.length && !Object.prototype.hasOwnProperty.call(ALLOWED, args[i + 1]);
    if (spec?.owner) { if (hasValue) i++; continue; }
    out.push(args[i]);
  }
  return out;
}

const fileFor = (sessionId, dir) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId))) throw new Error(`bad session id ${sessionId}`);
  return path.join(dir, `${sessionId}.json`);
};

/** Remember a session's forwarded flags (one file per session, atomic, 0600). */
export function saveExtraArgs(sessionId, args, { setBy, dir = EXTRA_ARGS_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = fileFor(sessionId, dir), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ args, setBy, savedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
}

export function clearExtraArgs(sessionId, { dir = EXTRA_ARGS_DIR } = {}) {
  try { fs.unlinkSync(fileFor(sessionId, dir)); } catch {}
}

/**
 * Stored flags to re-apply on resume → { args, dropped }. Re-validated (the file
 * may have been edited); owner-only flags survive only if the owner set them.
 * Missing/garbled/invalid → { args: [] } (+ a note in `dropped`).
 */
export function loadExtraArgs(sessionId, { dir = EXTRA_ARGS_DIR } = {}) {
  let j;
  try { j = JSON.parse(fs.readFileSync(fileFor(sessionId, dir), 'utf8')); } catch { return { args: [], dropped: null }; }
  const p = parseExtraArgs(Array.isArray(j.args) ? j.args.map(String) : [], { owner: true });
  if (p.error) return { args: [], dropped: `stored flags ignored (${p.error})` };
  if (j.setBy === 'owner') return { args: p.args, dropped: null };
  const kept = stripOwnerOnly(p.args);
  return { args: kept, dropped: kept.length !== p.args.length ? 'stored --remote-control ignored (not set by the owner)' : null };
}
