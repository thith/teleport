// `/merge <project> <pr#> [--squash|--merge|--rebase] [--keep-branch] [--force]`
// — a daemon command (admin): merge a GitHub PR of the project's repo.
//
// It merges through the GitHub API (`gh api … /pulls/<n>/merge`), NOT
// `gh pr merge`: the latter also switches/deletes branches in the LOCAL checkout,
// and a project folder may be an agent's live working tree (teleport's own
// daemon even runs scripts from one). So the local repo is never touched. The
// merge pins `sha` = the head commit we checked, so a push that lands between
// the check and the merge makes GitHub refuse instead of merging unreviewed code.
//
// Refuses (unless --force, where noted) when the PR is not open, is a draft,
// has conflicts, or has failing (or, with no --force, pending) checks.
// After a merge the head branch is deleted on GitHub (same-repo PRs only)
// unless --keep-branch.

import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-direct-run.mjs';

export const MERGE_METHODS = ['squash', 'merge', 'rebase'];
export const DEFAULT_MERGE_METHOD = 'squash';

/** argv (after the project token) → { pr, method, keepBranch, force } | { error }. Pure. */
export function parseMergeArgs(argv) {
  let pr = null, method = null, keepBranch = false, force = false;
  for (const a of argv) {
    if (/^--(squash|merge|rebase)$/.test(a)) {
      const m = a.slice(2);
      if (method && method !== m) return { error: `pick one merge method (--${method} or --${m}).` };
      method = m;
    } else if (a === '--keep-branch') keepBranch = true;
    else if (a === '--force') force = true;
    else if (/^#?\d+$/.test(a) && pr == null) pr = Number(a.replace('#', ''));
    else return { error: `unexpected argument ${JSON.stringify(a)}. Usage: /merge <project> <pr#> [--squash|--merge|--rebase] [--keep-branch] [--force]` };
  }
  if (!pr || !Number.isSafeInteger(pr) || pr < 1) return { error: 'usage: /merge <project> <pr#> [--squash|--merge|--rebase] [--keep-branch] [--force]' };
  return { pr, method: method || DEFAULT_MERGE_METHOD, keepBranch, force };
}

const FAILING = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED']);

/** Summarize statusCheckRollup (check runs + commit statuses). Pure. */
export function summarizeChecks(rollup = []) {
  const failing = [], pending = [];
  for (const c of rollup || []) {
    const name = c.name || c.context || '?';
    const verdict = String(c.conclusion || c.state || '').toUpperCase();
    const status = String(c.status || '').toUpperCase();
    if (FAILING.has(verdict)) failing.push(name);
    else if ((status && status !== 'COMPLETED') || PENDING.has(verdict)) pending.push(name);
  }
  return { failing, pending, total: (rollup || []).length };
}

/** Decide whether `pr` (gh pr view JSON) may be merged. Pure → { ok } | { error }. */
export function assessPr(pr, { force = false } = {}) {
  if (!pr || typeof pr !== 'object') return { error: 'PR not found.' };
  if (pr.state !== 'OPEN') return { error: `PR is ${String(pr.state).toLowerCase()}, not open.` };
  if (pr.isDraft) return { error: 'PR is a draft.' };
  if (pr.mergeable === 'CONFLICTING') return { error: 'PR has merge conflicts.' };
  const { failing, pending } = summarizeChecks(pr.statusCheckRollup);
  if (failing.length) return { error: `failing checks: ${failing.join(', ')}.` };
  if (pending.length && !force) return { error: `checks still running: ${pending.join(', ')} (wait, or --force).` };
  if (pr.mergeStateStatus === 'BLOCKED' && !force) return { error: 'GitHub says the PR is blocked (required reviews/checks) — --force to try anyway.' };
  return { ok: true };
}

/** `refs/heads/<branch>` API path with every segment URL-encoded (`#`, `%`, `?`… can't redirect it). Pure. */
export function branchRefPath(branch) {
  return String(branch).split('/').map(encodeURIComponent).join('/');
}

/**
 * May the merged PR's head branch be deleted? Never the default branch, never a
 * branch another OPEN PR uses as its head or base. Unknown (lookups failed) →
 * keep it. Pure → { ok } | { keep: reason }.
 */
export function branchDeletable(branch, { defaultBranch, openPrs, selfNumber }) {
  if (!defaultBranch || !Array.isArray(openPrs)) return { keep: 'could not check whether other PRs use it' };
  if (branch === defaultBranch) return { keep: 'it is the default branch' };
  const users = openPrs.filter((p) => p.number !== selfNumber && (p.headRefName === branch || p.baseRefName === branch));
  if (users.length) return { keep: `still used by open PR ${users.map((p) => `#${p.number}`).join(', ')}` };
  return { ok: true };
}

const gh = (args, opts = {}) => String(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }));
const ghError = (e) => String(e?.stderr || e?.message || e).trim().split('\n').slice(-3).join(' ');

if (isMainModule(import.meta.url)) {
  const args = parseMergeArgs(process.argv.slice(2));
  if (args.error) { console.log(`❌ ${args.error}`); process.exit(1); }
  let pr;
  try {
    pr = JSON.parse(gh(['pr', 'view', String(args.pr), '--json',
      'number,title,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,headRefName,headRefOid,baseRefName,isCrossRepository']));
  } catch (e) { console.log(`❌ cannot read PR #${args.pr}: ${ghError(e)}`); process.exit(1); }
  const ok = assessPr(pr, { force: args.force });
  if (ok.error) { console.log(`❌ PR #${pr.number} "${pr.title}": ${ok.error}\n${pr.url}`); process.exit(1); }
  try {
    gh(['api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${pr.number}/merge`,
      '-f', `merge_method=${args.method}`, '-f', `sha=${pr.headRefOid}`]);
  } catch (e) { console.log(`❌ merge of PR #${pr.number} failed: ${ghError(e)}\n${pr.url}`); process.exit(1); }
  let branchNote = '';
  if (!args.keepBranch && !pr.isCrossRepository) {
    let defaultBranch = null, openPrs = null;
    try { defaultBranch = JSON.parse(gh(['repo', 'view', '--json', 'defaultBranchRef'])).defaultBranchRef?.name || null; } catch {}
    try { openPrs = JSON.parse(gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName,baseRefName'])); } catch {}
    const d = branchDeletable(pr.headRefName, { defaultBranch, openPrs, selfNumber: pr.number });
    if (d.keep) branchNote = `\nℹ️ kept branch ${pr.headRefName}: ${d.keep}.`;
    else {
      try {
        gh(['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${branchRefPath(pr.headRefName)}`]);
        branchNote = `\n🧹 deleted branch ${pr.headRefName} on GitHub (local checkout untouched).`;
      } catch (e) { branchNote = `\n⚠️ merged, but deleting branch ${pr.headRefName} failed: ${ghError(e)}`; }
    }
  }
  console.log(`✅ merged PR #${pr.number} "${pr.title}" into ${pr.baseRefName} (${args.method}).${branchNote}\n${pr.url}`);
}
