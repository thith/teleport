import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordPrOwners, findPrOwner, extractPrUrls, recordPrOwnersFromText } from './pr-owner.mjs';
import { acquireHelperLock } from './machine-lock.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prowner-'));
const setup = () => { const d = tmp(); return { file: path.join(d, 'pr-owners.json'), lockDir: path.join(d, 'locks'), d }; };
const STORE = { '-100': { '42': 7, '43': 8, _is_forum: true } };
const U = 'https://github.com/o/r/pull/77';

test('extractPrUrls: stops at the PR number, lower-cases, de-dups', () => {
  assert.deepEqual(extractPrUrls('see (https://github.com/O/R/pull/77). and https://github.com/o/r/pull/77/files, http://github.com/a-b/c.d/pull/5x'),
    ['https://github.com/o/r/pull/77', 'http://github.com/a-b/c.d/pull/5']);
  assert.deepEqual(extractPrUrls('no links, https://github.com/o/r/issues/3'), []);
  assert.deepEqual(extractPrUrls(undefined), []);
});

test('record + find: written, found; lookup is case-insensitive', async () => {
  const { file, lockDir } = setup();
  assert.equal(await recordPrOwners([U], 42, 'topic', { file, lockDir, now: () => 5 }), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [U]: { convoId: '42', src: 'topic', ts: 5 } });
  assert.deepEqual(findPrOwner('https://github.com/O/R/pull/77', { store: STORE, file }), { convoId: '42', src: 'topic' });
});

test('first record wins: a second record (any source) never overwrites', async () => {
  const { file, lockDir } = setup();
  await recordPrOwners([U], 42, 'topic', { file, lockDir });
  assert.equal(await recordPrOwners([U], 43, 'request', { file, lockDir }), 0);
  assert.equal(await recordPrOwners([U, 'https://github.com/o/r/pull/78'], 43, 'topic', { file, lockDir }), 1);
  assert.equal(findPrOwner(U, { store: STORE, file }).convoId, '42');
  assert.equal(findPrOwner('https://github.com/o/r/pull/78', { store: STORE, file }).convoId, '43');
});

test('no eviction: many records all stay', async () => {
  const { file, lockDir } = setup();
  const urls = Array.from({ length: 700 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`);
  await recordPrOwners(urls, 42, 'topic', { file, lockDir });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length, 700);
  await recordPrOwners(['https://github.com/o/r/pull/9999'], 43, 'topic', { file, lockDir });
  assert.equal(findPrOwner(urls[0], { store: STORE, file }).convoId, '42');
});

test('busy lock → skipped (best-effort, nothing written)', async () => {
  const { file, lockDir } = setup();
  const rel = await acquireHelperLock('pr-owners', { dir: lockDir, waitMs: 0 });
  assert.equal(await recordPrOwners([U], 42, 'topic', { file, lockDir, waitMs: 100 }), 0);
  assert.equal(fs.existsSync(file), false);
  rel();
  assert.equal(await recordPrOwners([U], 42, 'topic', { file, lockDir }), 1);
});

test('convo not in the topics store → null; unreadable / corrupt file → null', async () => {
  const { file, lockDir, d } = setup();
  await recordPrOwners([U], 99, 'topic', { file, lockDir });
  assert.equal(findPrOwner(U, { store: STORE, file }), null);
  const bad = path.join(d, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(findPrOwner(U, { store: STORE, file: bad }), null);
  assert.equal(findPrOwner(U, { store: STORE, file: path.join(d, 'missing.json') }), null);
  // a corrupt ledger is replaced by a fresh one on the next record
  assert.equal(await recordPrOwners([U], 42, 'topic', { file: bad, lockDir }), 1);
  assert.equal(findPrOwner(U, { store: STORE, file: bad }).convoId, '42');
});

test('recordPrOwnersFromText: scans text/caption, ignores junk, never throws', async () => {
  const { file, lockDir } = setup();
  assert.equal(await recordPrOwnersFromText('PR mở rồi (https://github.com/o/r/pull/77).', 42, 'topic', { file, lockDir }), 1);
  assert.equal(findPrOwner(U, { store: STORE, file }).src, 'topic');
  assert.equal(await recordPrOwnersFromText('nothing here', 42, 'topic', { file, lockDir }), 0);
  assert.equal(await recordPrOwnersFromText('x', 42, 'topic', { file: '/dev/null/x/y', lockDir }), 0);
  assert.equal(await recordPrOwnersFromText(U, 'not-a-convo', 'topic', { file, lockDir }), 0);
});
