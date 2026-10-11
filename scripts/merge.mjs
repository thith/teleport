// `/merge <project> <pr#> [<pr#> …]` or `/merge <PR URL> [<PR URL> …]`  (`--close`: close without merging)
//   [--squash|--merge|--rebase] [--keep-branch] [--force]
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

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PARENT_DIR, resolveSpawnCwd } from './workspace.mjs';
import { isMainModule } from './is-direct-run.mjs';
import { acquireLock, describeHolder } from './machine-lock.mjs';

export const MERGE_METHODS = ['squash', 'merge', 'rebase'];
export const DEFAULT_MERGE_METHOD = 'squash';
export const MERGE_LOCK_WAIT_SEC = 180; // < the daemon's 5-minute COMMAND_TIMEOUT_MS, leaving time to merge

const USAGE_LINE = 'usage: /merge <project> <pr#> [<pr#> …] | /merge <PR URL> [<PR URL> …]  [--squash|--merge|--rebase] [--keep-branch] [--force] | … --close';

/** The canonical form `https://github.com/owner/name/pull/N` of a PR URL, or null. Pure. */
export function canonicalPrUrl(s) {
  const p = parsePrUrl(s);
  return p ? `https://github.com/${p.repo}/pull/${p.number}` : null;
}

/** A GitHub PR URL → { repo: 'owner/name', number } | null. Pure. */
export function parsePrUrl(s) {
  const m = String(s).match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#]\S*)?$/); // no whitespace: a link can't smuggle extra args
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  const number = Number(m[3]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: `${m[1]}/${m[2]}`, number } : null;
}

/**
 * argv → { project, targets: [{ repo, number }], method, keepBranch, force } | { error }. Pure.
 *  - a PR URL carries its own repo (`repo: 'owner/name'`);
 *  - a bare number belongs to the project's repo (`repo: null`); the project is
 *    the first token when it is neither a number, a URL nor a flag — or, when the
 *    daemon already dropped it (older registry: needsProject), the cwd.
 */
export function parseMergeArgs(argv) {
  const targets = [];
  let project = null, method = null, keepBranch = false, force = false, preview = false, close = false, methodConflict = null, skipMerged = false;
  argv.forEach((a, idx) => {
    if (targets.error) return;
    if (a === '--preview') { preview = true; return; }
    if (a === '--close') { close = true; return; }
    if (a === '--skip-merged') { skipMerged = true; return; }
    if (/^--(squash|merge|rebase)$/.test(a)) {
      const m = a.slice(2);
      if (method && method !== m) { methodConflict = `pick one merge method (--${method} or --${m}).`; return; }
      method = m;
    } else if (a === '--keep-branch') keepBranch = true;
    else if (a === '--force') force = true;
    else if (/^#?\d+$/.test(a)) {
      const n = Number(a.replace('#', ''));
      if (!Number.isSafeInteger(n) || n < 1) { targets.error = USAGE_LINE; return; }
      targets.push({ repo: null, number: n });
    } else if (parsePrUrl(a)) targets.push(parsePrUrl(a));
    else if (idx === 0 && /^[A-Za-z0-9._-]+$/.test(a)) project = a;
    else targets.error = `unexpected argument ${JSON.stringify(a)}. ${USAGE_LINE}`;
  });
  if (targets.error) return { error: targets.error };
  if (methodConflict && !close) return { error: methodConflict }; // merge options are irrelevant to --close
  if (!targets.length) return { error: USAGE_LINE };
  const seen = new Set();
  for (const t of targets) {
    const k = `${t.repo || ''}#${t.number}`;
    if (seen.has(k)) return { error: `PR ${t.repo ? `${t.repo}` : ''}#${t.number} listed twice.` };
    seen.add(k);
  }
  return { project, targets, method: method || DEFAULT_MERGE_METHOD, keepBranch, force, ...(preview ? { preview } : {}), ...(close ? { close } : {}), ...(skipMerged ? { skipMerged } : {}) };
}

const FAILING = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED']);

/** Summarize statusCheckRollup (check runs + commit statuses). Pure. */
export function summarizeChecks(rollup = []) {
  const failing = [], pending = [], notRun = [];
  for (const c of rollup || []) {
    const name = c.name || c.context || '?';
    const verdict = String(c.conclusion || c.state || '').toUpperCase();
    const status = String(c.status || '').toUpperCase();
    if (c.notStarted) notRun.push(name); // never ran (e.g. GitHub Actions billing) — not a failure
    else if (FAILING.has(verdict)) failing.push(name);
    else if ((status && status !== 'COMPLETED') || PENDING.has(verdict)) pending.push(name);
  }
  return { failing, pending, notRun, total: (rollup || []).length };
}

// The annotation GitHub puts on a job it refused to start for billing reasons.
export const BILLING_NOT_STARTED_RE = /job was not started because .*(payments? have failed|spending limit|billing)/i;

/** Check-run id from a GitHub Actions job details URL (…/actions/runs/<run>/job/<id>), else null. Pure. */
export function checkRunIdFromUrl(url) {
  const m = String(url || '').match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Mark failing checks that GitHub never STARTED for billing reasons (`notStarted`),
 * by reading their annotations. A real failure (the job ran and failed) is left
 * as is. The annotation text alone is spoofable (a job can print `::error::…`),
 * so the job must also never have run: no runner, no steps.
 * `fetchAnnotations(id)` → array of messages; `fetchJob(id)` → Actions job JSON
 * (either throws → treated as real failure).
 */
export function markBillingNotStarted(rollup = [], fetchAnnotations, fetchJob) {
  return (rollup || []).map((c) => {
    const verdict = String(c.conclusion || c.state || '').toUpperCase();
    const id = FAILING.has(verdict) ? checkRunIdFromUrl(c.detailsUrl) : null;
    if (!id) return c;
    let msgs = [];
    try { msgs = fetchAnnotations(id) || []; } catch { return c; }
    if (!msgs.some((m) => BILLING_NOT_STARTED_RE.test(String(m)))) return c;
    let job;
    try { job = fetchJob(id); } catch { return c; }
    const neverRan = job && !job.runner_id && !job.runner_name && !(job.steps || []).length;
    return neverRan ? { ...c, notStarted: true } : c;
  });
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
  // (UNSTABLE = some checks not green — already judged above: real failures refused, not-run allowed.)
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
export const OPEN_PR_LIST_LIMIT = 1000;
export function branchDeletable(branch, { defaultBranch, openPrs, selfNumber, limit = OPEN_PR_LIST_LIMIT }) {
  if (!defaultBranch || !Array.isArray(openPrs)) return { keep: 'could not check whether other PRs use it' };
  // A full page may be truncated: an unseen PR could still use the branch.
  if (openPrs.length >= limit) return { keep: `too many open PRs (≥${limit}) to be sure no other PR uses it` };
  if (branch === defaultBranch) return { keep: 'it is the default branch' };
  const users = openPrs.filter((p) => p.number !== selfNumber && (p.headRefName === branch || p.baseRefName === branch));
  if (users.length) return { keep: `still used by open PR ${users.map((p) => `#${p.number}`).join(', ')}` };
  return { ok: true };
}

/**
 * Is `base` still sitting exactly on the head commit of an already-merged
 * SAME-REPO PR (i.e. a stacked PR's dead base)? `gh pr list --head` matches by
 * name only — fork PRs from their own `main`, or a branch deleted and re-created
 * under the same name, must not count — so we require: not the default branch,
 * the merged PR is not cross-repo, and the base branch tip == that PR's head sha.
 */
/** gh argv/paths for one repo: `repo` = 'owner/name', or null for the cwd's repo. */
export function repoCtx(repo) {
  return {
    api: repo ? `repos/${repo}` : 'repos/{owner}/{repo}',
    R: repo ? ['-R', repo] : [],
    view: repo ? ['repo', 'view', repo] : ['repo', 'view'],
    label: repo ? `${repo}#` : '#',
  };
}

export function baseIsMergedHead(base, gh, repo = null) {
  const c = repoCtx(repo);
  const defaultBranch = JSON.parse(gh([...c.view, '--json', 'defaultBranchRef'])).defaultBranchRef?.name;
  if (base === defaultBranch) return false;
  const merged = JSON.parse(gh(['pr', 'list', ...c.R, '--state', 'merged', '--head', base, '--limit', '50', '--json', 'number,headRefOid,isCrossRepository']));
  const sameRepo = merged.filter((p) => !p.isCrossRepository);
  if (!sameRepo.length) return false;
  let tip;
  try { tip = JSON.parse(gh(['api', `${c.api}/branches/${branchRefPath(base)}`])).commit?.sha; }
  catch (e) {
    // Only a confirmed "no such branch" means it's gone (GitHub will refuse the
    // merge itself); any other failure is unknown → let the caller refuse.
    if (/not found|HTTP 404/i.test(String(e?.stderr || e?.message || ''))) return false;
    throw e;
  }
  return sameRepo.some((p) => p.headRefOid === tip);
}

const PR_FIELDS = 'number,title,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,headRefName,headRefOid,baseRefName,isCrossRepository';
const ghError = (e) => String(e?.stderr || e?.message || e).trim().split('\n').slice(-3).join(' ');

/**
 * Merge one PR. `gh(args)` returns stdout or throws (injectable for tests).
 * Waits (up to `unknownTries` × `unknownWaitMs`) while GitHub still reports
 * mergeable=UNKNOWN — normal right after a previous merge in the same batch.
 * Returns { ok, text } | { error, text }.
 */
export async function mergeOne(target, { method, keepBranch, force, preview = false, skipMerged = false }, {
  gh, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), unknownTries = 5, unknownWaitMs = 2000,
  mergedHeads = [],
}) {
  const { number, repo = null } = typeof target === 'number' ? { number: target } : target;
  const c = repoCtx(repo);
  let pr;
  for (let i = 0; ; i++) {
    try { pr = JSON.parse(gh(['pr', 'view', String(number), ...c.R, '--json', PR_FIELDS])); }
    catch (e) { return { error: true, text: `❌ cannot read PR ${c.label}${number}: ${ghError(e)}` }; }
    if (pr.mergeable !== 'UNKNOWN' || i >= unknownTries) break;
    await sleep(unknownWaitMs);
  }
  // Never act on a different PR than the one asked for (e.g. a CLI fallback).
  if (pr.number !== number) return { error: true, text: `❌ asked for PR ${c.label}${number} but GitHub returned #${pr.number} — refusing.` };
  // --skip-merged (daemon retries of an interrupted request): a PR that is
  // already merged counts as done instead of stopping the batch.
  if (skipMerged && pr.state === 'MERGED') return { ok: true, head: null, text: `ℹ️ PR ${c.label}${pr.number} "${pr.title}" was already merged — skipped.\n${pr.url}` };
  // Checks GitHub refused to START (Actions billing) are "not run", like a repo
  // without CI (which the owner allows) — only real failures block.
  pr.statusCheckRollup = markBillingNotStarted(pr.statusCheckRollup, (id) =>
    JSON.parse(gh(['api', `${c.api}/check-runs/${id}/annotations`])).map((a) => a.message),
  (id) => JSON.parse(gh(['api', `${c.api}/actions/jobs/${id}`])));
  const { notRun } = summarizeChecks(pr.statusCheckRollup);
  const ciNote = notRun.length ? `\n⚠️ CI không chạy (GitHub Actions billing): ${notRun.join(', ')} — xử lý như repo chưa có CI.` : '';
  const ok = assessPr(pr, { force });
  if (ok.error) return { error: true, text: `❌ PR ${c.label}${pr.number} "${pr.title}": ${ok.error}\n${pr.url}` };
  // Stacked PR: its base is the head of a PR that is already merged. Merging now
  // lands it on that dead branch, not on the real target — retarget it first.
  // Merged earlier in THIS batch = certain (no override); merged before and the
  // branch hasn't moved since = strong evidence, overridable with --force (a
  // maintained branch merged moments ago, e.g. release → main).
  let baseMerged = mergedHeads.includes(`${repo || ''}:${pr.baseRefName}`);
  if (!baseMerged && !force) {
    try { baseMerged = baseIsMergedHead(pr.baseRefName, gh, repo); }
    catch (e) { return { error: true, text: `❌ PR ${c.label}${pr.number}: cannot check its base branch ${pr.baseRefName}: ${ghError(e)}` }; }
  }
  if (baseMerged) return { error: true, text: `❌ PR ${c.label}${pr.number} "${pr.title}": its base ${pr.baseRefName} is the branch of an already-merged PR (stacked PR) — retarget it (gh pr edit ${pr.number} --base <target>) first.\n${pr.url}` };
  // --preview: everything checked, nothing changed (the daemon shows this with
  // Merge / Cancel buttons when a PR link is pasted).
  if (preview) {
    const { total } = summarizeChecks(pr.statusCheckRollup);
    return { ok: true, head: pr.isCrossRepository ? null : `${repo || ''}:${pr.headRefName}`, text: `🔎 PR ${c.label}${pr.number} "${pr.title}"\n${pr.headRefName} → ${pr.baseRefName} · checks: ${total ? (notRun.length ? 'not run' : 'all passed') : 'none'} · ready to ${method}${ciNote}\n${pr.url}` };
  }
  try {
    gh(['api', '-X', 'PUT', `${c.api}/pulls/${pr.number}/merge`,
      '-f', `merge_method=${method}`, '-f', `sha=${pr.headRefOid}`]);
  } catch (e) { return { error: true, text: `❌ merge of PR ${c.label}${pr.number} failed: ${ghError(e)}\n${pr.url}` }; }
  let branchNote = '';
  if (!keepBranch && !pr.isCrossRepository) {
    let defaultBranch = null, openPrs = null;
    try { defaultBranch = JSON.parse(gh([...c.view, '--json', 'defaultBranchRef'])).defaultBranchRef?.name || null; } catch {}
    try { openPrs = JSON.parse(gh(['pr', 'list', ...c.R, '--state', 'open', '--limit', String(OPEN_PR_LIST_LIMIT), '--json', 'number,headRefName,baseRefName'])); } catch {}
    const d = branchDeletable(pr.headRefName, { defaultBranch, openPrs, selfNumber: pr.number });
    if (d.keep) branchNote = `\nℹ️ kept branch ${pr.headRefName}: ${d.keep}.`;
    else {
      try {
        gh(['api', '-X', 'DELETE', `${c.api}/git/refs/heads/${branchRefPath(pr.headRefName)}`]);
        branchNote = `\n🧹 deleted branch ${pr.headRefName} on GitHub (local checkout untouched).`;
      } catch (e) { branchNote = `\n⚠️ merged, but deleting branch ${pr.headRefName} failed: ${ghError(e)}`; }
    }
  }
  // Only same-repo heads can be the base of another PR here (a fork's `main` is not ours).
  return { ok: true, head: pr.isCrossRepository ? null : `${repo || ''}:${pr.headRefName}`, text: `✅ merged PR ${c.label}${pr.number} "${pr.title}" into ${pr.baseRefName} (${method}).${ciNote}${branchNote}\n${pr.url}` };
}

/**
 * Give every target a canonical `owner/name` (bare numbers → the project repo,
 * resolved once via `resolveRepo()`), lower-cased for identity, then reject
 * duplicates. After this all gh calls are pinned with -R and the in-batch
 * stacked tracking can't be split by mixing forms or letter case.
 * Returns { targets } | { error }.
 */
export function canonicalizeTargets(targets, resolveRepo) {
  let projectRepo = null;
  if (targets.some((t) => !t.repo)) {
    try { projectRepo = resolveRepo(); } catch (e) { return { error: `cannot resolve the project's GitHub repo: ${ghError(e)}` }; }
    if (!projectRepo) return { error: "cannot resolve the project's GitHub repo." };
  }
  const out = [], seen = new Set();
  for (const t of targets) {
    const repo = String(t.repo || projectRepo).toLowerCase();
    const key = `${repo}#${t.number}`;
    if (seen.has(key)) return { error: `PR ${key} listed twice.` };
    seen.add(key);
    out.push({ repo, number: t.number });
  }
  return { targets: out };
}

/**
 * Close one PR WITHOUT merging (`--close`): it must be open; its branch is kept
 * so it can be reopened. `preview` checks only. Returns { ok, text } | { error, text }.
 */
export async function closeOne(target, { preview = false }, { gh }) {
  const { number, repo = null } = typeof target === 'number' ? { number: target } : target;
  const c = repoCtx(repo);
  let pr;
  try { pr = JSON.parse(gh(['pr', 'view', String(number), ...c.R, '--json', 'number,title,url,state'])); }
  catch (e) { return { error: true, text: `❌ cannot read PR ${c.label}${number}: ${ghError(e)}` }; }
  if (pr.number !== number) return { error: true, text: `❌ asked for PR ${c.label}${number} but GitHub returned #${pr.number} — refusing.` };
  if (pr.state !== 'OPEN') return { error: true, text: `❌ PR ${c.label}${pr.number} "${pr.title}": PR is ${String(pr.state).toLowerCase()}, not open.\n${pr.url}` };
  if (preview) return { ok: true, text: `🔎 PR ${c.label}${pr.number} "${pr.title}" is open — can be closed.\n${pr.url}` };
  try { gh(['api', '-X', 'PATCH', `${c.api}/pulls/${pr.number}`, '-f', 'state=closed']); }
  catch (e) { return { error: true, text: `❌ closing PR ${c.label}${pr.number} failed: ${ghError(e)}\n${pr.url}` }; }
  return { ok: true, text: `🚫 closed PR ${c.label}${pr.number} "${pr.title}" without merging (branch kept).\n${pr.url}` };
}

/** Merge (or --close) PRs in order; stop at the first failure and say what was / wasn't done. */
export async function mergeMany(args, deps) {
  const lines = [], merged = [], mergedHeads = [];
  const targets = args.targets || args.prs.map((number) => ({ repo: null, number }));
  const name = (t) => `${repoCtx(t.repo).label}${t.number}`;
  for (const [i, t] of targets.entries()) {
    const r = args.close ? await closeOne(t, args, deps) : await mergeOne(t, args, { ...deps, mergedHeads });
    if (r.head) mergedHeads.push(r.head);
    lines.push(r.text);
    if (r.error) {
      const rest = targets.slice(i + 1);
      if (targets.length > 1) lines.push(args.preview
        ? `⏹ ${name(t)} can't be merged${rest.length ? ` (not checked: ${rest.map(name).join(', ')})` : ''}.`
        : `⏹ stopped. ${args.close ? 'closed' : 'merged'}: ${merged.length ? merged.map(name).join(', ') : 'none'}${rest.length ? ` · not attempted: ${rest.map(name).join(', ')}` : ''}`);
      return { ok: false, text: lines.join('\n\n') };
    }
    merged.push(t);
  }
  return { ok: true, text: lines.join('\n\n') };
}

const ghCli = (cwd) => (args) => String(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd }));

if (isMainModule(import.meta.url)) {
  const args = parseMergeArgs(process.argv.slice(2));
  if (args.error) { console.log(`❌ ${args.error}`); process.exit(1); }
  // Bare numbers need a repo: the named project folder (resolved + contained like
  // /spawn), else — only with the older registry, where the daemon already cd'ed
  // into the project — the cwd. Never the workspace root itself.

  let cwd = process.cwd();
  if (args.project) {
    const r = resolveSpawnCwd(args.project);
    if (r.error) { console.log(`❌ ${r.error}`); process.exit(1); }
    cwd = r.cwd;
  } else if (args.targets.some((t) => !t.repo)) {
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const parent = real(PARENT_DIR), here = real(cwd);
    const inProject = here !== parent && here.startsWith(parent + path.sep) && fs.existsSync(path.join(here, '.git'));
    if (!inProject) { console.log('❌ PR numbers need a project: /merge <project> <pr#> — or give PR URLs.'); process.exit(1); }
  }
  const gh = ghCli(cwd);
  const canon = canonicalizeTargets(args.targets, () => JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner);
  if (canon.error) { console.log(`❌ ${canon.error}`); process.exit(1); }
  // One merge at a time machine-wide (RFC 17): /merge, the [Merge] button and the
  // agent inbox otherwise race on retargets / branch deletes. Held by THIS process
  // (no re-exec), so the daemon's timeout SIGTERM still stops the real merge. The
  // wait stays well under the daemon's 5-minute COMMAND_TIMEOUT_MS. Previews only read.
  let lock = null;
  if (!args.preview) {
    const waitSec = Number(process.env.TELEPORT_MERGE_LOCK_WAIT_SEC) || MERGE_LOCK_WAIT_SEC;
    try {
      lock = await acquireLock('merge', { waitSec, cmd: `merge ${canon.targets.map((t) => `${t.repo}#${t.number}`).join(' ')}`,
        onWait: (h) => console.error(`⏳ đang có merge khác chạy: ${describeHolder(h)} — chờ…`) });
    } catch (e) { console.log(`❌ cannot take the merge lock (${e.message}) — not merging.`); process.exit(1); }
    if (lock.timeout) { console.log(`❌ đang có merge khác chạy quá ${waitSec}s: ${describeHolder(lock.holder)} — thử lại sau.`); process.exit(1); }
  }
  const r = await mergeMany({ ...args, targets: canon.targets }, { gh });
  lock?.release();
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}
