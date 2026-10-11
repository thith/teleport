import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findResumeTarget, transcriptCwd, checkCwd, listCandidates } from './resume.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';

const C = [
  { sessionId: 's1', hashtag: 'j8436116', persona: '🧚 Tiên', mtimeMs: 100 },
  { sessionId: 's2', hashtag: 'b1111111', persona: '🧚 Tiên', mtimeMs: 50 },
  { sessionId: 's3', hashtag: 'c2383556', persona: '👻 Ma', mtimeMs: 70 },
  { sessionId: 's4', hashtag: 'd2222222', persona: '🐍 Rắn 3', mtimeMs: 60 },
  { sessionId: 's5', hashtag: 'e3333333', persona: '🐍 Rắn', mtimeMs: 90 },
];

test('findResumeTarget: by hashtag, by full persona name (newest wins, others listed), never a substring', () => {
  assert.equal(findResumeTarget('#c2383556', C).target.sessionId, 's3');
  assert.equal(findResumeTarget('c2383556', C).target.sessionId, 's3');
  const t = findResumeTarget('tiên', C);
  assert.equal(t.target.sessionId, 's1', 'newest');
  assert.deepEqual(t.others.map((o) => o.sessionId), ['s2']);
  assert.equal(findResumeTarget('Rắn', C).target.sessionId, 's5', '"Rắn" is not "Rắn 3"');
  assert.equal(findResumeTarget('rắn 3', C).target.sessionId, 's4');
  assert.match(findResumeTarget('Cú', C).error, /no agent "Cú"/);
  assert.match(findResumeTarget('', C).error, /usage/);
});

test('transcriptCwd / checkCwd: cwd from the transcript; must be inside the workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const ws = path.join(dir, 'ws'); fs.mkdirSync(path.join(ws, 'umipay'), { recursive: true });
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, '{"type":"mode"}\n{"type":"user","cwd":"' + path.join(ws, 'umipay') + '"}\n');
  assert.equal(transcriptCwd(f), path.join(ws, 'umipay'));
  assert.equal(transcriptCwd(path.join(dir, 'missing')), null);
  assert.equal(checkCwd(path.join(ws, 'umipay'), { parentDir: ws }).cwd, fs.realpathSync(path.join(ws, 'umipay')));
  assert.match(checkCwd(dir, { parentDir: ws }).error, /outside the workspace/);
  assert.match(checkCwd(ws, { parentDir: ws }).error, /outside the workspace/, 'the workspace root itself is not a project');
  assert.match(checkCwd(path.join(ws, 'gone'), { parentDir: ws }).error, /no longer exists/);
  assert.match(checkCwd(null).error, /no working directory/);
});

test('listCandidates: only recent transcripts whose convo has a Telegram topic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsc-'));
  const pdir = path.join(dir, '-w-umipay'); fs.mkdirSync(pdir);
  const withTopic = 'ac22f365-d351-4e54-82a5-303156081507', noTopic = '00000000-0000-4000-8000-000000000123', old = 'ae61d4f1-5ecc-46fe-9cea-75b4c9d9b751';
  for (const id of [withTopic, noTopic, old]) fs.writeFileSync(path.join(pdir, `${id}.jsonl`), '{}');
  const t = new Date(Date.now() - 90 * 86400_000); fs.utimesSync(path.join(pdir, `${old}.jsonl`), t, t);
  const store = { '-100': { [uuidToConvoInt(withTopic)]: 5, [uuidToConvoInt(old)]: 6, _ts: {} } };
  const c = listCandidates({ projectsDir: dir, store });
  assert.deepEqual(c.map((x) => x.sessionId), [withTopic]);
  assert.equal(c[0].hashtag, shortConvoHash(uuidToConvoInt(withTopic)));
});

test('findResumeTarget: skips sessions still alive (newest dead match wins); all alive → clear error', () => {
  assert.equal(findResumeTarget('tiên', C, { aliveSessions: new Set(['s1']) }).target.sessionId, 's2');
  assert.match(findResumeTarget('ma', C, { aliveSessions: new Set(['s3']) }).error, /still running/);
});
