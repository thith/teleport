import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMergeArgs, summarizeChecks, assessPr, DEFAULT_MERGE_METHOD, branchRefPath, branchDeletable } from './merge.mjs';

test('parseMergeArgs: pr number (#N ok), method, flags; errors on junk / two methods / missing pr', () => {
  assert.deepEqual(parseMergeArgs(['12']), { pr: 12, method: DEFAULT_MERGE_METHOD, keepBranch: false, force: false });
  assert.equal(DEFAULT_MERGE_METHOD, 'squash');
  assert.deepEqual(parseMergeArgs(['#7', '--rebase', '--keep-branch', '--force']), { pr: 7, method: 'rebase', keepBranch: true, force: true });
  assert.match(parseMergeArgs(['7', '--squash', '--merge']).error, /pick one/);
  assert.match(parseMergeArgs([]).error, /usage/);
  assert.match(parseMergeArgs(['0']).error, /usage/);
  assert.match(parseMergeArgs(['7', '8']).error, /unexpected/);
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
});
