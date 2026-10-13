// cleanup-request.mjs — an AGENT asks the teleport daemon to remove a worktree
// it could not remove itself (blocked by a hook, or created by another agent and
// left abandoned).
//
//   node ../teleport/scripts/cleanup-request.mjs <worktree path | branch>
//
// A branch is resolved to its worktree via `git worktree list --porcelain` of the
// repo containing the cwd; a path is realpath'd to its worktree root. The request
// goes into the daemon's file inbox (scripts/tmp/cleanup-requests/). The daemon
// runs the same safety judge as the daily cleanup (cleanup.mjs) for that one
// worktree — minus the two "recently used" gates, since the requester IS the
// recent user — and the RESULT comes back to the requesting agent's topic as a
// prompt (field `cleanupResult`).
//
// Authority: this script grants nothing. The convo is used ONLY to route the
// result back; whether anything is removed is decided by the daemon's checks
// (merged PR at HEAD, clean tree, no process inside, …).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { resolveConvoIdFromEnv } from './convo-registry.mjs';
import { parseWorktreePorcelain } from './cleanup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLEANUP_REQUEST_DIR = path.join(__dirname, 'tmp', 'cleanup-requests');
export const USAGE = 'usage: node ../teleport/scripts/cleanup-request.mjs <worktree path | branch>   (run inside your agent session, from outside that worktree)';

const gitSync = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });

/**
 * <path | branch> → { path } (realpath of the worktree root) | { error }.
 * `/…`, `./…`, `../…`, `~/…` are paths. Anything else is looked up as a branch;
 * it is a path only if it contains `/` and exists, or names a linked worktree
 * ROOT. Both interpretations, pointing at different worktrees → error.
 */
export function resolveTarget(arg, { cwd = process.cwd(), git = gitSync, home = os.homedir() } = {}) {
  if (typeof arg !== 'string' || !arg) return { error: USAGE };
  const expanded = arg === '~' || arg.startsWith('~/') ? path.join(home, arg.slice(1)) : arg;
  // Explicit path syntax → a path, never a branch.
  if (/^[./~]/.test(arg)) return pathTarget(path.resolve(cwd, expanded), arg, git);
  // Otherwise the arg may be a path or a branch name (branch names contain `/`
  // too). A bare name counts as a path only when it IS a linked worktree root —
  // never "a subdir of the current worktree" or a stray file.
  const asPath = path.resolve(cwd, arg);
  let fromPath = null;
  if (arg.includes('/')) fromPath = pathTarget(asPath, arg, git);
  else if (isLinkedWorktreeRoot(asPath, git)) fromPath = { path: fs.realpathSync(asPath) };
  const fromBranch = branchTarget(arg, cwd, git);
  if (fromPath?.path && fromBranch.path && fromPath.path !== fromBranch.path) {
    return { error: `${arg} is ambiguous: path → ${fromPath.path}, branch → ${fromBranch.path}. Pass an explicit path (./${arg} or an absolute path).` };
  }
  if (fromBranch.path) return fromBranch;
  if (fromPath?.path) return fromPath;
  return { error: fromPath ? `${fromPath.error}; ${fromBranch.error}` : fromBranch.error };
}

/** A filesystem path → { path: realpath of its worktree root } | { error }. */
function pathTarget(asPath, arg, git) {
  let real;
  try { real = fs.realpathSync(asPath); } catch { return { error: `no such path: ${arg}` }; }
  if (!fs.statSync(real).isDirectory()) return { error: `not a directory: ${real}` };
  let top;
  try { top = git(['-C', real, 'rev-parse', '--show-toplevel']).trim(); } catch { return { error: `not inside a git worktree: ${real}` }; }
  try { return { path: fs.realpathSync(top) }; } catch (e) { return { error: `cannot resolve ${top}: ${e.message}` }; }
}

/** Is `p` exactly the root of a LINKED (non-main) worktree? */
function isLinkedWorktreeRoot(p, git) {
  try {
    const real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) return false;
    const list = parseWorktreePorcelain(git(['-C', real, 'worktree', 'list', '--porcelain']));
    const idx = list.findIndex((w) => { try { return fs.realpathSync(w.path) === real; } catch { return false; } });
    return idx > 0 && !list[idx].bare;
  } catch { return false; }
}

/** A branch checked out in a worktree of the repo containing `cwd` → { path } | { error }. */
function branchTarget(arg, cwd, git) {
  let list;
  try { list = parseWorktreePorcelain(git(['-C', cwd, 'worktree', 'list', '--porcelain'])); }
  catch { return { error: `${arg}: not a worktree path, and the cwd is not in a git repo to look the branch up in` }; }
  const ref = arg.startsWith('refs/heads/') ? arg : `refs/heads/${arg}`;
  const hit = list.find((w) => w.branch === ref);
  if (!hit) return { error: `${arg}: not a worktree path, and no worktree of this repo has that branch checked out` };
  try { return { path: fs.realpathSync(hit.path) }; } catch { return { error: `worktree of ${arg} is missing on disk: ${hit.path}` }; }
}

/** Atomically drop one request file (write temp 0600, then rename) → its path. */
export function writeRequest({ path: target, convoId, dir = CLEANUP_REQUEST_DIR, now = Date.now() }) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${now}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = path.join(dir, `.${name}.tmp`);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ path: target, convoId: String(convoId), createdAt: now }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) { console.error(`[cleanup-request] ${USAGE}`); process.exit(2); }
  const { convoId } = resolveConvoIdFromEnv({ argConvo: null });
  if (convoId == null) { console.error('[cleanup-request] no session convo (run inside your agent session) — the result could not be routed back.'); process.exit(2); }
  const t = resolveTarget(argv[0]);
  if (t.error) { console.error(`[cleanup-request] ${t.error}`); process.exit(2); }
  const cwd = (() => { try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); } })();
  writeRequest({ path: t.path, convoId });
  console.log(`[cleanup-request] queued ${t.path}. The daemon checks it (merged PR at HEAD, clean tree, no process inside) and the result comes back to your topic as a prompt (cleanupResult).`
    + (cwd === t.path || cwd.startsWith(t.path + '/') ? '\n⚠️ Your shell is inside that worktree — cd out of it, or the daemon will keep it.' : ''));
}
