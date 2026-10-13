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
 * An existing path wins over a branch of the same name.
 */
export function resolveTarget(arg, { cwd = process.cwd(), git = gitSync } = {}) {
  if (typeof arg !== 'string' || !arg) return { error: USAGE };
  const asPath = path.resolve(cwd, arg);
  if (fs.existsSync(asPath)) {
    let real;
    try { real = fs.realpathSync(asPath); } catch (e) { return { error: `cannot resolve ${arg}: ${e.message}` }; }
    if (!fs.statSync(real).isDirectory()) return { error: `not a directory: ${real}` };
    let top;
    try { top = git(['-C', real, 'rev-parse', '--show-toplevel']).trim(); } catch { return { error: `not inside a git worktree: ${real}` }; }
    try { return { path: fs.realpathSync(top) }; } catch (e) { return { error: `cannot resolve ${top}: ${e.message}` }; }
  }
  let list;
  try { list = parseWorktreePorcelain(git(['-C', cwd, 'worktree', 'list', '--porcelain'])); }
  catch { return { error: `${arg}: no such path, and the cwd is not in a git repo to look the branch up in` }; }
  const ref = arg.startsWith('refs/heads/') ? arg : `refs/heads/${arg}`;
  const hit = list.find((w) => w.branch === ref);
  if (!hit) return { error: `${arg}: no such path, and no worktree of this repo has that branch checked out` };
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
