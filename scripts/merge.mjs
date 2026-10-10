// `/merge <project> <pr#> [<pr#> …] [--squash|--merge|--rebase] [--keep-branch] [--force]`
// — a daemon command (admin): merge GitHub PRs of the project's repo, in the
// order given, stopping at the first one that can't be merged.
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

const USAGE_LINE = 'usage: /merge <project> <pr#> [<pr#> …] [--squash|--merge|--rebase] [--keep-branch] [--force]';

/** argv (after the project token) → { prs, method, keepBranch, force } | { error }. Pure. */
export function parseMergeArgs(argv) {
  const prs = [];
  let method = null, keepBranch = false, force = false;
  for (const a of argv) {
    if (/^--(squash|merge|rebase)$/.test(a)) {
      const m = a.slice(2);
      if (method && method !== m) return { error: `pick one merge method (--${method} or --${m}).` };
      method = m;
    } else if (a === '--keep-branch') keepBranch = true;
    else if (a === '--force') force = true;
    else if (/^#?\d+$/.test(a)) {
      const n = Number(a.replace('#', ''));
      if (!Number.isSafeInteger(n) || n < 1) return { error: USAGE_LINE };
      if (prs.includes(n)) return { error: `PR #${n} listed twice.` };
      prs.push(n);
    } else return { error: `unexpected argument ${JSON.stringify(a)}. ${USAGE_LINE}` };
  }
  if (!prs.length) return { error: USAGE_LINE };
  return { prs, method: method || DEFAULT_MERGE_METHOD, keepBranch, force };
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
  if (pr.mergeable === 'UNKNOWN' && !force) return { error: 'GitHub has not finished computing mergeability — retry in a moment, or --force.' };
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

const PR_FIELDS = 'number,title,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,headRefName,headRefOid,baseRefName,isCrossRepository';
const ghError = (e) => String(e?.stderr || e?.message || e).trim().split('\n').slice(-3).join(' ');

/**
 * Merge one PR. `gh(args)` returns stdout or throws (injectable for tests).
 * Waits (up to `unknownTries` × `unknownWaitMs`) while GitHub still reports
 * mergeable=UNKNOWN — normal right after a previous merge in the same batch.
 * Returns { ok, text } | { error, text }.
 */
export async function mergeOne(number, { method, keepBranch, force }, {
  gh, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), unknownTries = 5, unknownWaitMs = 2000,
}) {
  let pr;
  for (let i = 0; ; i++) {
    try { pr = JSON.parse(gh(['pr', 'view', String(number), '--json', PR_FIELDS])); }
    catch (e) { return { error: true, text: `❌ cannot read PR #${number}: ${ghError(e)}` }; }
    if (pr.mergeable !== 'UNKNOWN' || i >= unknownTries) break;
    await sleep(unknownWaitMs);
  }
  const ok = assessPr(pr, { force });
  if (ok.error) return { error: true, text: `❌ PR #${pr.number} "${pr.title}": ${ok.error}\n${pr.url}` };
  try {
    gh(['api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${pr.number}/merge`,
      '-f', `merge_method=${method}`, '-f', `sha=${pr.headRefOid}`]);
  } catch (e) { return { error: true, text: `❌ merge of PR #${pr.number} failed: ${ghError(e)}\n${pr.url}` }; }
  let branchNote = '';
  if (!keepBranch && !pr.isCrossRepository) {
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
  return { ok: true, text: `✅ merged PR #${pr.number} "${pr.title}" into ${pr.baseRefName} (${method}).${branchNote}\n${pr.url}` };
}

/** Merge PRs in order; stop at the first failure and say what was / wasn't merged. */
export async function mergeMany(args, deps) {
  const lines = [], merged = [];
  for (const n of args.prs) {
    const r = await mergeOne(n, args, deps);
    lines.push(r.text);
    if (r.error) {
      const rest = args.prs.slice(args.prs.indexOf(n) + 1);
      if (args.prs.length > 1) lines.push(`⏹ stopped. merged: ${merged.length ? merged.map((x) => `#${x}`).join(', ') : 'none'}${rest.length ? ` · not attempted: ${rest.map((x) => `#${x}`).join(', ')}` : ''}`);
      return { ok: false, text: lines.join('\n\n') };
    }
    merged.push(n);
  }
  return { ok: true, text: lines.join('\n\n') };
}

const ghCli = (args) => String(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

if (isMainModule(import.meta.url)) {
  const args = parseMergeArgs(process.argv.slice(2));
  if (args.error) { console.log(`❌ ${args.error}`); process.exit(1); }
  const r = await mergeMany(args, { gh: ghCli });
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}
