import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMergeArgs, summarizeChecks, assessPr, DEFAULT_MERGE_METHOD, branchRefPath, branchDeletable, mergeOne, mergeMany } from './merge.mjs';

test('parseMergeArgs: pr number (#N ok), method, flags; errors on junk / two methods / missing pr', () => {
  assert.deepEqual(parseMergeArgs(['12']), { prs: [12], method: DEFAULT_MERGE_METHOD, keepBranch: false, force: false });
  assert.equal(DEFAULT_MERGE_METHOD, 'squash');
  assert.deepEqual(parseMergeArgs(['#7', '--rebase', '--keep-branch', '--force']), { prs: [7], method: 'rebase', keepBranch: true, force: true });
  assert.deepEqual(parseMergeArgs(['12', '13', '#15']).prs, [12, 13, 15]);
  assert.match(parseMergeArgs(['12', '12']).error, /twice/);
  assert.match(parseMergeArgs(['7', '--squash', '--merge']).error, /pick one/);
  assert.match(parseMergeArgs([]).error, /usage/);
  assert.match(parseMergeArgs(['0']).error, /usage/);
  assert.match(parseMergeArgs(['7', '--admin']).error, /unexpected/);
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
  assert.deepEqual(r, { failing: ['lint', 'ci/old'], pending: ['e2e', 'ci/legacy'], total: 6 });
  assert.deepEqual(summarizeChecks(undefined), { failing: [], pending: [], total: 0 });
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
    throw new Error('unexpected ' + args.join(' '));
  };
  return { gh, calls };
}
const PR = (n, extra = {}) => ({ number: n, title: `t${n}`, url: `u${n}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [], headRefName: `feat/${n}`, headRefOid: `sha${n}`, baseRefName: 'main', isCrossRepository: false, ...extra });
const ARGS = (prs, o = {}) => ({ prs, method: 'squash', keepBranch: false, force: false, ...o });

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
