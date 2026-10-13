import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRunIdFromUrl, markBillingNotStarted, parsePrUrl, parseMergeArgs, canonicalizeTargets, summarizeChecks, assessPr, DEFAULT_MERGE_METHOD, branchRefPath, branchDeletable, mergeOne, mergeMany } from './merge.mjs';

test('parseMergeArgs: pr number (#N ok), method, flags; errors on junk / two methods / missing pr', () => {
  assert.deepEqual(parseMergeArgs(['12']), { project: null, targets: [{ repo: null, number: 12 }], method: DEFAULT_MERGE_METHOD, keepBranch: false, force: false });
  assert.equal(DEFAULT_MERGE_METHOD, 'squash');
  assert.deepEqual(parseMergeArgs(['#7', '--rebase', '--keep-branch', '--force']), { project: null, targets: [{ repo: null, number: 7 }], method: 'rebase', keepBranch: true, force: true });
  assert.deepEqual(parseMergeArgs(['12', '13', '#15']).targets.map((t) => t.number), [12, 13, 15]);
  assert.match(parseMergeArgs(['12', '12']).error, /twice/);
  assert.match(parseMergeArgs(['7', '--squash', '--merge']).error, /pick one/);
  assert.match(parseMergeArgs([]).error, /usage/);
  assert.match(parseMergeArgs(['0']).error, /usage/);
  assert.match(parseMergeArgs(['7', '--admin']).error, /unexpected/);
  assert.match(parseMergeArgs(['7', 'umipay']).error, /unexpected/, 'project only as the first token');
});

test('summarizeChecks: check runs + commit statuses → failing / pending', () => {
  const r = summarizeChecks([
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
    { context: 'ci/legacy', state: 'PENDING' },
    { context: 'ci/old', state: 'ERROR' },
    { name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' },
  ]);
  assert.deepEqual(r, { failing: ['lint', 'ci/old'], pending: ['e2e', 'ci/legacy'], notRun: [], total: 6 });
  assert.deepEqual(summarizeChecks(undefined), { failing: [], pending: [], notRun: [], total: 0 });
});

test('assessPr: refuses closed/merged, draft, conflicts, failing checks; pending/blocked need --force', () => {
  const base = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] };
  assert.deepEqual(assessPr(base), { ok: true });
  assert.match(assessPr({ ...base, state: 'MERGED' }).error, /merged, not open/);
  assert.match(assessPr({ ...base, isDraft: true }).error, /draft/);
  assert.match(assessPr({ ...base, mergeable: 'CONFLICTING' }).error, /conflicts/);
  const failing = { ...base, statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] };
  assert.match(assessPr(failing).error, /failing checks: lint/);
  assert.match(assessPr(failing, { force: true }).error, /failing/, '--force never overrides a failing check');
  const pending = { ...base, statusCheckRollup: [{ name: 'e2e', status: 'QUEUED' }] };
  assert.match(assessPr(pending).error, /still running/);
  assert.deepEqual(assessPr(pending, { force: true }), { ok: true });
  assert.match(assessPr({ ...base, mergeStateStatus: 'BLOCKED' }).error, /blocked/);
  assert.deepEqual(assessPr({ ...base, mergeStateStatus: 'BLOCKED' }, { force: true }), { ok: true });
  assert.match(assessPr(null).error, /not found/);
  assert.match(assessPr({ ...base, mergeable: 'UNKNOWN' }).error, /not finished/);
  assert.deepEqual(assessPr({ ...base, mergeable: 'UNKNOWN' }, { force: true }), { ok: true });
});

test('branchRefPath: every segment encoded — # % ? { } cannot redirect the ref', () => {
  assert.equal(branchRefPath('feat/resume-ps-killpid'), 'feat/resume-ps-killpid');
  assert.equal(branchRefPath('release#fix'), 'release%23fix');
  assert.equal(branchRefPath('a/b?x=1/%zz/{owner}'), 'a/b%3Fx%3D1/%25zz/%7Bowner%7D');
});

test('branchDeletable: never the default branch or a branch another open PR uses; unknown → keep', () => {
  const openPrs = [{ number: 5, headRefName: 'feat/x', baseRefName: 'main' }, { number: 6, headRefName: 'feat/y', baseRefName: 'release' }];
  assert.deepEqual(branchDeletable('feat/x', { defaultBranch: 'main', openPrs, selfNumber: 5 }), { ok: true });
  assert.match(branchDeletable('main', { defaultBranch: 'main', openPrs, selfNumber: 9 }).keep, /default branch/);
  assert.match(branchDeletable('release', { defaultBranch: 'main', openPrs, selfNumber: 9 }).keep, /open PR #6/);
  assert.match(branchDeletable('feat/x', { defaultBranch: 'main', openPrs, selfNumber: 9 }).keep, /open PR #5/);
  assert.match(branchDeletable('feat/x', { defaultBranch: null, openPrs, selfNumber: 5 }).keep, /could not check/);
  assert.match(branchDeletable('feat/x', { defaultBranch: 'main', openPrs: null, selfNumber: 5 }).keep, /could not check/);
  assert.match(branchDeletable('feat/x', { defaultBranch: 'main', openPrs, selfNumber: 5, limit: 2 }).keep, /too many open PRs/, 'a full page may be truncated → keep');
});

// Fake gh: a tiny in-memory GitHub.
function fakeGh(prs, { defaultBranch = 'main', unknownFor = {}, tips = {} } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      const p = prs[args[2]];
      if (!p) throw Object.assign(new Error('x'), { stderr: 'no such PR' });
      if (unknownFor[args[2]] > 0) { unknownFor[args[2]]--; return JSON.stringify({ ...p, mergeable: 'UNKNOWN' }); }
      return JSON.stringify(p);
    }
    if (args[0] === 'api' && args[2] === 'PUT') { const n = args[3].match(/pulls\/(\d+)/)[1]; prs[n].state = 'MERGED'; tips[prs[n].headRefName] = prs[n].headRefOid; return '{}'; }
    if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: defaultBranch } });
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
      const head = args[args.indexOf('--head') + 1];
      return JSON.stringify(Object.values(prs).filter((p) => p.state === 'MERGED' && p.headRefName === head).map((p) => ({ number: p.number, headRefOid: p.headRefOid, isCrossRepository: p.isCrossRepository })));
    }
    if (args[0] === 'api' && /\/branches\//.test(args[1] || '')) {
      const name = decodeURIComponent(args[1].split('/branches/')[1]);
      if (name in tips) return JSON.stringify({ commit: { sha: tips[name] } });
      throw Object.assign(new Error('x'), { stderr: 'Branch not found' });
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(Object.values(prs).filter((p) => p.state === 'OPEN'));
    if (args[0] === 'api' && args[2] === 'DELETE') return '';
    if (args[0] === 'api' && args[2] === 'PATCH') { const n = args[3].match(/pulls\/(\d+)$/)[1]; prs[n].state = 'CLOSED'; return '{}'; }
    throw new Error('unexpected ' + args.join(' '));
  };
  return { gh, calls };
}
const PR = (n, extra = {}) => ({ number: n, title: `t${n}`, url: `u${n}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [], headRefName: `feat/${n}`, headRefOid: `sha${n}`, baseRefName: 'main', isCrossRepository: false, ...extra });
const ARGS = (prs, o = {}) => ({ targets: prs.map((number) => ({ repo: null, number })), method: 'squash', keepBranch: false, force: false, ...o });

test('mergeOne: pins sha, encodes the branch, deletes it; waits out UNKNOWN', async () => {
  const { gh, calls } = fakeGh({ 3: PR(3, { headRefName: 'release#fix' }) }, { unknownFor: { 3: 2 } });
  let slept = 0;
  const r = await mergeOne(3, ARGS([3]), { gh, sleep: async () => { slept++; } });
  assert.equal(r.ok, true, r.text);
  assert.equal(slept, 2);
  assert.deepEqual(calls.find((c) => c[2] === 'PUT'), ['api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/3/merge', '-f', 'merge_method=squash', '-f', 'sha=sha3']);
  assert.deepEqual(calls.find((c) => c[2] === 'DELETE'), ['api', '-X', 'DELETE', 'repos/{owner}/{repo}/git/refs/heads/release%23fix']);
});

test('mergeOne: keep-branch / cross-repo → no delete; refused PR → nothing merged', async () => {
  let f = fakeGh({ 3: PR(3) });
  await mergeOne(3, ARGS([3], { keepBranch: true }), { gh: f.gh });
  assert.equal(f.calls.some((c) => c[2] === 'DELETE'), false);
  f = fakeGh({ 3: PR(3, { isCrossRepository: true }) });
  await mergeOne(3, ARGS([3]), { gh: f.gh });
  assert.equal(f.calls.some((c) => c[2] === 'DELETE'), false);
  f = fakeGh({ 3: PR(3, { isDraft: true }) });
  const r = await mergeOne(3, ARGS([3]), { gh: f.gh });
  assert.equal(r.error, true);
  assert.equal(f.calls.some((c) => c[2] === 'PUT'), false);
});

test('mergeMany: in order, stops at the first failure, reports merged / not attempted', async () => {
  const { gh, calls } = fakeGh({ 1: PR(1), 2: PR(2, { mergeable: 'CONFLICTING' }), 3: PR(3) });
  const r = await mergeMany(ARGS([1, 2, 3]), { gh, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.text, /merged PR #1/);
  assert.match(r.text, /PR #2 "t2": PR has merge conflicts/);
  assert.match(r.text, /stopped\. merged: #1 · not attempted: #3/);
  assert.equal(calls.filter((c) => c[2] === 'PUT').length, 1);
  const ok = await mergeMany(ARGS([1]), { gh: fakeGh({ 1: PR(1) }).gh });
  assert.equal(ok.ok, true);
  assert.doesNotMatch(ok.text, /stopped/);
});

test('mergeOne: refuses when GitHub returns a different PR than asked', async () => {
  const { gh, calls } = fakeGh({ 3: PR(4) });
  const r = await mergeOne(3, ARGS([3]), { gh });
  assert.match(r.text, /asked for PR #3 but GitHub returned #4/);
  assert.equal(calls.some((c) => c[2] === 'PUT'), false);
});

test('mergeMany: stacked PR (base = head of a PR merged earlier in the batch) is refused, not merged into the dead branch', async () => {
  const { gh, calls } = fakeGh({ 10: PR(10), 11: PR(11, { baseRefName: 'feat/10' }) });
  const r = await mergeMany(ARGS([10, 11]), { gh, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.text, /merged PR #10/);
  assert.match(r.text, /PR #11 .*stacked PR.*gh pr edit 11 --base/);
  assert.equal(calls.filter((c) => c[2] === 'PUT').length, 1);
  assert.match(r.text, /kept branch feat\/10: still used by open PR #11/);
});

test('mergeOne: stacked on a PR merged BEFORE this command → refused; --force overrides (historical evidence only)', async () => {
  const { gh } = fakeGh({ 10: PR(10, { state: 'MERGED' }), 11: PR(11, { baseRefName: 'feat/10' }) }, { tips: { 'feat/10': 'sha10' } });
  assert.match((await mergeOne(11, ARGS([11]), { gh })).text, /stacked PR/);
  assert.equal((await mergeOne(11, ARGS([11], { force: true }), { gh })).ok, true);
});

test('mergeMany: in-batch stacked refusal is NOT overridable by --force; a fork PR\'s head never poisons the batch', async () => {
  let f = fakeGh({ 10: PR(10), 11: PR(11, { baseRefName: 'feat/10' }) });
  assert.match((await mergeMany(ARGS([10, 11], { force: true }), { gh: f.gh, sleep: async () => {} })).text, /stacked PR/);
  // contributor:main → upstream main, then an unrelated PR into main
  f = fakeGh({ 1: PR(1, { headRefName: 'main', isCrossRepository: true }), 2: PR(2) });
  const r = await mergeMany(ARGS([1, 2]), { gh: f.gh, sleep: async () => {} });
  assert.equal(r.ok, true, r.text);
});

test('baseIsMergedHead: no false positives — default branch, fork PRs, re-created branch, deleted branch', async () => {
  // a fork once merged a PR from ITS `main`: must not block PRs into our main
  // tip == that fork PR's head sha, so ONLY the cross-repo filter saves us here…
  let f = fakeGh({ 1: PR(1, { state: 'MERGED', headRefName: 'main', isCrossRepository: true }), 2: PR(2) }, { tips: { main: 'sha1' } });
  assert.equal((await mergeOne(2, ARGS([2]), { gh: f.gh })).ok, true);
  // …and here ONLY the default-branch skip (same-repo main→release backport, main unmoved)
  f = fakeGh({ 1: PR(1, { state: 'MERGED', headRefName: 'main', baseRefName: 'release' }), 2: PR(2) }, { tips: { main: 'sha1' } });
  assert.equal((await mergeOne(2, ARGS([2]), { gh: f.gh })).ok, true);
  // a release branch that once was a merged PR's head but has moved on (re-created / new commits)
  f = fakeGh({ 5: PR(5, { state: 'MERGED', headRefName: 'release' }), 6: PR(6, { baseRefName: 'release' }) }, { tips: { release: 'newer' } });
  assert.equal((await mergeOne(6, ARGS([6]), { gh: f.gh })).ok, true);
  // base branch already deleted → not "stacked" here (GitHub will refuse the merge on its own)
  f = fakeGh({ 5: PR(5, { state: 'MERGED', headRefName: 'gone' }), 6: PR(6, { baseRefName: 'gone' }) });
  assert.equal((await mergeOne(6, ARGS([6]), { gh: f.gh })).ok, true);
});

test('mergeOne: UNKNOWN wait is bounded; merge_method passes through; open-PR list uses the 1000 limit; gh failure in the stacked check refuses', async () => {
  let f = fakeGh({ 3: PR(3) }, { unknownFor: { 3: 99 } });
  let views = 0;
  const gh = (a) => { if (a[1] === 'view') views++; return f.gh(a); };
  const r = await mergeOne(3, ARGS([3]), { gh, sleep: async () => {}, unknownTries: 2 });
  assert.equal(views, 3);
  assert.match(r.text, /not finished computing/);
  f = fakeGh({ 3: PR(3) });
  await mergeOne(3, ARGS([3], { method: 'rebase' }), { gh: f.gh });
  assert.ok(f.calls.find((c) => c[2] === 'PUT').includes('merge_method=rebase'));
  const list = f.calls.find((c) => c[0] === 'pr' && c[1] === 'list' && c.includes('open'));
  assert.equal(list[list.indexOf('--limit') + 1], '1000');
  f = fakeGh({ 3: PR(3, { baseRefName: 'release' }) });
  const failing = (a) => { if (a.includes('merged')) throw Object.assign(new Error('x'), { stderr: 'rate limited' }); return f.gh(a); };
  const r2 = await mergeOne(3, ARGS([3]), { gh: failing });
  assert.match(r2.text, /cannot check its base branch release: rate limited/);
  assert.equal(f.calls.some((c) => c[2] === 'PUT'), false);
});

test('baseIsMergedHead: a transient error reading the base tip refuses (not treated as a deleted branch)', async () => {
  const f = fakeGh({ 5: PR(5, { state: 'MERGED', headRefName: 'feat/5' }), 6: PR(6, { baseRefName: 'feat/5' }) }, { tips: { 'feat/5': 'sha5' } });
  const gh = (a) => { if (/\/branches\//.test(a[1] || '')) throw Object.assign(new Error('x'), { stderr: 'HTTP 502: Bad Gateway' }); return f.gh(a); };
  const r = await mergeOne(6, ARGS([6]), { gh });
  assert.match(r.text, /cannot check its base branch feat\/5: HTTP 502/);
  assert.equal(f.calls.some((c) => c[2] === 'PUT'), false);
});

test('parsePrUrl / parseMergeArgs: PR URLs carry their repo; project form still works', () => {
  assert.deepEqual(parsePrUrl('https://github.com/thith/teleport/pull/3'), { repo: 'thith/teleport', number: 3 });
  assert.deepEqual(parsePrUrl('https://github.com/icetea-labs/dpay/pull/12/files'), { repo: 'icetea-labs/dpay', number: 12 });
  assert.equal(parsePrUrl('https://github.com/a/b/issues/3'), null);
  assert.equal(parsePrUrl('https://evil.com/a/b/pull/3'), null);
  assert.equal(parsePrUrl('https://github.com/../b/pull/3'), null);
  const p = parseMergeArgs(['https://github.com/thith/teleport/pull/3', 'https://github.com/icetea-labs/dpay/pull/12', '--rebase']);
  assert.deepEqual(p.targets, [{ repo: 'thith/teleport', number: 3 }, { repo: 'icetea-labs/dpay', number: 12 }]);
  assert.equal(p.project, null);
  assert.deepEqual(parseMergeArgs(['umipay-be', '12', '13']).project, 'umipay-be');
  assert.match(parseMergeArgs(['https://github.com/a/b/pull/3', 'https://github.com/a/b/pull/3']).error, /twice/);
  assert.equal(parseMergeArgs(['https://github.com/a/b/pull/3', 'https://github.com/a/c/pull/3']).targets.length, 2, 'same number, different repos');
});

test('mergeOne with a URL target: every gh call is pinned to that repo (-R / repos/<owner>/<name>)', async () => {
  const { gh, calls } = fakeGh({ 3: PR(3) });
  const r = await mergeOne({ repo: 'thith/teleport', number: 3 }, ARGS([3]), { gh });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /merged PR thith\/teleport#3/);
  for (const c of calls) {
    if (c[0] === 'pr') assert.ok(c.includes('-R') && c[c.indexOf('-R') + 1] === 'thith/teleport', c.join(' '));
    if (c[0] === 'repo') assert.equal(c[2], 'thith/teleport');
    if (c[0] === 'api') assert.ok(c.some((x) => x.startsWith('repos/thith/teleport/')), c.join(' '));
  }
  assert.equal(calls.some((c) => c.some((x) => String(x).includes('{owner}'))), false);
});

test('canonicalizeTargets: numbers get the project repo, everything lower-cased; cross-form / case duplicates caught', () => {
  const r = canonicalizeTargets([{ repo: null, number: 1 }, { repo: 'Thith/Teleport', number: 2 }], () => 'thith/teleport');
  assert.deepEqual(r.targets, [{ repo: 'thith/teleport', number: 1 }, { repo: 'thith/teleport', number: 2 }]);
  assert.match(canonicalizeTargets([{ repo: null, number: 1 }, { repo: 'THITH/teleport', number: 1 }], () => 'thith/teleport').error, /listed twice/);
  let called = 0;
  canonicalizeTargets([{ repo: 'a/b', number: 1 }], () => { called++; return 'x/y'; });
  assert.equal(called, 0, 'no lookup when every target has a repo');
  assert.match(canonicalizeTargets([{ repo: null, number: 1 }], () => { throw new Error('no remote'); }).error, /cannot resolve/);
});

test('mergeMany after canonicalization: mixing a number and a URL of the same repo keeps the in-batch stacked guard', async () => {
  const { gh, calls } = fakeGh({ 1: PR(1, { headRefName: 'stack' }), 2: PR(2, { baseRefName: 'stack' }) });
  const { targets } = canonicalizeTargets([{ repo: null, number: 1 }, { repo: 'Thith/Teleport', number: 2 }], () => 'thith/teleport');
  const r = await mergeMany({ targets, method: 'squash', keepBranch: true, force: true }, { gh, sleep: async () => {} });
  assert.match(r.text, /stacked PR/);
  assert.equal(calls.filter((c) => c[2] === 'PUT').length, 1);
});

test('preview: checks everything, never PUTs/DELETEs; batch preview still flags an in-batch stack', async () => {
  let f = fakeGh({ 3: PR(3) });
  const r = await mergeMany({ ...ARGS([3]), preview: true }, { gh: f.gh, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.match(r.text, /🔎 PR #3 "t3"\nfeat\/3 → main · checks: none · ready to squash/);
  assert.equal(f.calls.some((c) => c[0] === 'api' && (c[2] === 'PUT' || c[2] === 'DELETE')), false);
  f = fakeGh({ 10: PR(10), 11: PR(11, { baseRefName: 'feat/10' }) });
  const s2 = await mergeMany({ ...ARGS([10, 11]), preview: true }, { gh: f.gh, sleep: async () => {} });
  assert.equal(s2.ok, false);
  assert.match(s2.text, /stacked PR/);
  assert.match(s2.text, /⏹ #11 can't be merged/);
  assert.equal(f.calls.some((c) => c[2] === 'PUT'), false);
  assert.equal(parseMergeArgs(['https://github.com/a/b/pull/1', '--preview']).preview, true);
});

test('--close: closes open PRs without merging (branch kept); refuses merged/closed; preview changes nothing; batch stops at first failure', async () => {
  let f = fakeGh({ 5: PR(5) });
  const r = await mergeMany({ ...ARGS([5]), close: true }, { gh: f.gh });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /🚫 closed PR #5 "t5" without merging \(branch kept\)/);
  assert.deepEqual(f.calls.find((c) => c[2] === 'PATCH'), ['api', '-X', 'PATCH', 'repos/{owner}/{repo}/pulls/5', '-f', 'state=closed']);
  assert.equal(f.calls.some((c) => c[2] === 'PUT' || c[2] === 'DELETE'), false);
  f = fakeGh({ 5: PR(5, { state: 'MERGED' }), 6: PR(6) });
  const r2 = await mergeMany({ ...ARGS([5, 6]), close: true }, { gh: f.gh });
  assert.match(r2.text, /merged, not open[\s\S]*stopped\. closed: none · not attempted: #6/);
  assert.equal(f.calls.some((c) => c[2] === 'PATCH'), false);
  f = fakeGh({ 5: PR(5, { mergeable: 'CONFLICTING' }) });
  const p = await mergeMany({ ...ARGS([5]), close: true, preview: true }, { gh: f.gh });
  assert.match(p.text, /is open — can be closed/, 'a conflicting PR can still be closed');
  assert.equal(f.calls.some((c) => c[0] === 'api'), false);
  assert.equal(parseMergeArgs(['https://github.com/a/b/pull/1', '--close']).close, true);
  assert.equal(parseMergeArgs(['https://github.com/a/b/pull/1', '--squash', '--rebase', '--close']).close, true, 'conflicting merge methods are irrelevant to --close');
  assert.match(parseMergeArgs(['https://github.com/a/b/pull/1', '--squash', '--rebase']).error, /pick one/);
});

test('--skip-merged: an already-merged PR is skipped, the batch continues (crash-retry of a request)', async () => {
  const f = fakeGh({ 1: PR(1, { state: 'MERGED' }), 2: PR(2) });
  const r = await mergeMany({ ...ARGS([1, 2]), skipMerged: true }, { gh: f.gh, sleep: async () => {} });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /already merged — skipped[\s\S]*merged PR #2/);
  assert.equal(parseMergeArgs(['https://github.com/a/b/pull/1', '--skip-merged']).skipMerged, true);
});

test('merge.mjs runs as a CLI (no import deadlock): a usage error exits quickly with code 1', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./merge.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--squash', '--rebase', '1'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.signal, null, 'did not hang');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /pick one merge method/);
  assert.doesNotMatch(r.stderr, /unsettled top-level await/);
});

test('billing: checks GitHub never STARTED are "not run" (allowed, noted); a real failure still refuses', async () => {
  assert.equal(checkRunIdFromUrl('https://github.com/o/r/actions/runs/38137305121/job/114471781656'), '114471781656');
  assert.equal(checkRunIdFromUrl('https://ci.example/x'), null);
  assert.equal(checkRunIdFromUrl('https://evil.example/o/r/actions/runs/1/job/999'), null, 'github.com only');
  const BILL = 'The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the \'Billing & plans\' section in your settings';
  const rollup = [
    { name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/11' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/12' },
    { name: 'android', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/13' },
  ];
  const ann = { 11: [BILL], 12: ['Process completed with exit code 1.'] };
  const NEVER = { runner_id: 0, runner_name: '', steps: [] };
  const marked = markBillingNotStarted(rollup, (id) => ann[id], () => NEVER);
  assert.deepEqual(summarizeChecks(marked), { failing: ['lint'], pending: [], notRun: ['gate'], total: 3 });
  assert.equal(markBillingNotStarted(rollup, () => { throw new Error('api'); }, () => NEVER)[0].notStarted, undefined, 'unknown → still a failure');
  assert.equal(markBillingNotStarted(rollup, (id) => ann[id], () => { throw new Error('api'); })[0].notStarted, undefined, 'job unknown → still a failure');
  // spoof: a job that RAN and printed the billing text via ::error:: stays a failure
  const ran = { runner_id: 7, runner_name: 'GitHub Actions 7', steps: [{ name: 'x' }] };
  assert.equal(markBillingNotStarted(rollup, (id) => ann[id], () => ran)[0].notStarted, undefined, 'spoofed annotation → still a failure');
  assert.equal(markBillingNotStarted(rollup, (id) => ann[id], () => ({ ...NEVER, steps: [{ name: 'x' }] }))[0].notStarted, undefined, 'has steps → ran');
  // end to end through mergeOne with a fake gh
  const f = fakeGh({ 5: PR(5, { statusCheckRollup: [rollup[0]], mergeStateStatus: 'UNSTABLE' }) });
  const gh = (a) => (a[0] === 'api' && /check-runs\/11\/annotations/.test(a[1] || '') ? JSON.stringify([{ message: BILL }])
    : a[0] === 'api' && /actions\/jobs\/11$/.test(a[1] || '') ? JSON.stringify(NEVER) : f.gh(a));
  const r = await mergeOne(5, ARGS([5]), { gh });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /✅ merged PR #5[\s\S]*⚠️ CI không chạy \(GitHub Actions billing\): gate/);
  const f2 = fakeGh({ 6: PR(6, { statusCheckRollup: [rollup[1]] }) });
  const gh2 = (a) => (a[0] === 'api' && /annotations/.test(a[1] || '') ? JSON.stringify([{ message: 'exit code 1' }]) : f2.gh(a));
  assert.match((await mergeOne(6, ARGS([6]), { gh: gh2 })).text, /failing checks: lint/);
});

test('--expect-head: parsed per PR (lower-cased key); bad form is an error', () => {
  const sha = 'a'.repeat(40);
  const a = parseMergeArgs(['https://github.com/Acme/Repo/pull/5', `--expect-head=Acme/Repo#5=${sha}`]);
  assert.deepEqual(a.expectHeads, { 'acme/repo#5': sha });
  assert.match(parseMergeArgs(['https://github.com/a/b/pull/5', '--expect-head=a/b#5=xyz']).error, /expect-head/);
  assert.match(parseMergeArgs(['https://github.com/a/b/pull/5', '--expect-head']).error, /expect-head/);
  assert.equal(parseMergeArgs(['https://github.com/a/b/pull/5']).expectHeads, undefined);
});

test('mergeOne --expect-head: a head that moved since the preview is refused, nothing merged; same head merges', async () => {
  const t = { repo: 'acme/repo', number: 3 };
  const moved = fakeGh({ 3: PR(3, { headRefOid: 'b'.repeat(40) }) });
  const r = await mergeOne(t, ARGS([3], { expectHeads: { 'acme/repo#3': 'a'.repeat(40) } }), { gh: moved.gh });
  assert.equal(r.error, true);
  assert.match(r.text, /commit mới sau khi preview \(aaaaaaa → bbbbbbb\)/);
  assert.equal(moved.calls.some((c) => c[2] === 'PUT'), false);
  const same = fakeGh({ 3: PR(3, { headRefOid: 'a'.repeat(40) }) });
  const ok = await mergeOne(t, ARGS([3], { expectHeads: { 'acme/repo#3': 'a'.repeat(40) } }), { gh: same.gh });
  assert.equal(ok.ok, true, ok.text);
  assert.ok(same.calls.some((c) => c[2] === 'PUT' && c.includes(`sha=${'a'.repeat(40)}`)));
});

test('--expect-head survives the daemon path: expectHeadArgs → tokenizeArgs → parseMergeArgs', async () => {
  const { expectHeadArgs } = await import('./daemon.mjs');
  const { tokenizeArgs } = await import('./commands.mjs');
  const sha = 'd'.repeat(40), link = 'https://github.com/Thith/Teleport/pull/36';
  const a = parseMergeArgs(tokenizeArgs(`${link}${expectHeadArgs({ [link]: sha })}`));
  assert.deepEqual(a.expectHeads, { 'thith/teleport#36': sha });
});
