import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimPreexistingPrompt, promptSegments, isInfoOnlyPrompt, mergePromptData, dropPresentSegments, infoOnlyAnnounce, mergeOrSpoolPrompt, dropInfoOnlyProcessing,
} from './tele-listen.mjs';
import { buildCompactWarnPrompt } from './compact-warn.mjs';

// RFC 34 §2.3 — info-only daemon notices: claimed (consumed) under the lock, never a .processing.json.
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'info-'));
const P = (d) => path.join(d, 'prompt-convo-7.json');
const PROC = (d) => path.join(d, 'prompt-convo-7.processing.json');
const LOCK = (d) => path.join(d, 'prompt-write-7.lock');
const warn = () => buildCompactWarnPrompt({ convoId: 7, chatId: -5, x: 240000, y: 250000 });
const real = () => ({
  text: 'hello', messageId: 11, chatId: '-5', fromUserId: '42', fromName: 'Thi', fromRole: 'admin', fromMember: { id: 1 },
  replyToMessageId: 3, replyToText: 'r', quotedText: null, timestamp: 100, attachments: [], persona: 'Sứa', projectDescription: 'pd',
  messages: [{ messageId: 11, chatId: '-5', fromUserId: '42', fromName: 'Thi', fromRole: 'admin', text: 'hello', attachments: [] }],
});

test('promptSegments keeps infoOnly; isInfoOnlyPrompt', () => {
  assert.equal(promptSegments(warn())[0].infoOnly, true);
  assert.equal(isInfoOnlyPrompt(warn()), true);
  assert.equal(isInfoOnlyPrompt(real()), false);
  assert.equal(isInfoOnlyPrompt(null), false);
});

test('claim: all-infoOnly open prompt is unlinked under the lock, never a .processing.json; returns the text', () => {
  const d = mk();
  fs.writeFileSync(P(d), JSON.stringify(warn()));
  const c = claimPreexistingPrompt(P(d), PROC(d), LOCK(d));
  assert.equal(c.infoOnly, true);
  assert.match(c.text, /sắp auto compact/);
  assert.equal(fs.existsSync(P(d)), false);
  assert.equal(fs.existsSync(PROC(d)), false);
  assert.equal(fs.existsSync(LOCK(d)), false, 'lock released');
  const line = infoOnlyAnnounce(P(d), c);
  assert.match(line, /info-only/);
  assert.doesNotMatch(line, /\[claim:/);
  assert.match(line, /sắp auto compact/);
});

test('claim: info-only is consumed even while the agent holds a .processing; real batch still waits', () => {
  const d = mk();
  fs.writeFileSync(PROC(d), '{}');
  fs.writeFileSync(P(d), JSON.stringify(warn()));
  assert.equal(claimPreexistingPrompt(P(d), PROC(d), LOCK(d)).infoOnly, true);
  assert.equal(fs.readFileSync(PROC(d), 'utf8'), '{}', 'the claimed batch is untouched');
  fs.writeFileSync(P(d), JSON.stringify(real()));
  assert.equal(claimPreexistingPrompt(P(d), PROC(d), LOCK(d)), false);
  assert.equal(fs.existsSync(P(d)), true);
});

test('claim: mixed batch → normal claim (renamed to .processing, token)', () => {
  const d = mk();
  fs.writeFileSync(P(d), JSON.stringify(mergePromptData(real(), warn())));
  assert.match(String(claimPreexistingPrompt(P(d), PROC(d), LOCK(d))), /^[0-9a-f]{16}$/);
  assert.equal(fs.existsSync(PROC(d)), true);
});

test('claim: write lock held by a peer → false, info-only left intact', () => {
  const d = mk();
  fs.writeFileSync(P(d), JSON.stringify(warn()));
  fs.writeFileSync(LOCK(d), String(Date.now()));
  assert.equal(claimPreexistingPrompt(P(d), PROC(d), LOCK(d)), false);
  assert.equal(fs.existsSync(P(d)), true);
});

test('mergePromptData: real + info → routing and persona of the real side, flag cleared; either order', () => {
  for (const m of [mergePromptData(real(), warn()), mergePromptData(warn(), real())]) {
    assert.equal(m.infoOnly, undefined);
    assert.equal(m.messageId, 11);
    assert.equal(m.fromUserId, '42');
    assert.equal(m.fromRole, 'admin');
    assert.equal(m.persona, 'Sứa');
    assert.equal(m.projectDescription, 'pd');
    assert.equal(m.replyToMessageId, 3);
    assert.equal(m.messages.length, 2);
    assert.equal(m.messages.filter((s) => s.infoOnly).length, 1);
    assert.equal(isInfoOnlyPrompt(m), false);
  }
});

test('mergePromptData: info + info stays info-only', () => {
  const m = mergePromptData(warn(), { ...warn(), text: 'again' });
  assert.equal(m.infoOnly, true);
  assert.equal(isInfoOnlyPrompt(m), true);
});

test('dropPresentSegments: recomputes the flag and keeps real routing', () => {
  const m = mergePromptData(real(), warn());
  // drop the real segment → only info-only remains
  const onlyInfo = dropPresentSegments(m, new Set(['-5:11:']));
  assert.equal(isInfoOnlyPrompt(onlyInfo), true);
  assert.equal(onlyInfo.infoOnly, true);
  const m2 = { ...m, infoOnly: undefined, messages: [{ infoOnly: true, text: 'w', messageId: 'w1', chatId: '-5' }, ...m.messages, { infoOnly: true, text: 'w2', messageId: 'w2', chatId: '-5' }] };
  const dropped = dropPresentSegments(m2, new Set(['-5:w1:']));
  assert.equal(dropped.infoOnly, undefined);
  assert.equal(dropped.messageId, 11);
});

test('mergeOrSpoolPrompt: info-only notice spooled under a real batch keeps the real routing', async () => {
  const d = mk();
  fs.writeFileSync(P(d), JSON.stringify(real()));
  await mergeOrSpoolPrompt(P(d), warn(), LOCK(d));
  const got = JSON.parse(fs.readFileSync(P(d), 'utf8'));
  assert.equal(got.fromUserId, '42');
  assert.equal(got.persona, 'Sứa');
  assert.equal(isInfoOnlyPrompt(got), false);
});

test('dropInfoOnlyProcessing: deletes the old info-only .processing it read, never a real claim that replaced it (Codex)', () => {
  const d = mk();
  const seen = { ...warn(), claimId: 'aaa' };
  fs.writeFileSync(PROC(d), JSON.stringify(seen));
  assert.equal(dropInfoOnlyProcessing(PROC(d), seen, LOCK(d)), true);
  assert.equal(fs.existsSync(PROC(d)), false);
  // Read the info-only orphan, then (concurrently) it was consumed and a REAL batch was claimed at the same path.
  fs.writeFileSync(PROC(d), JSON.stringify({ ...real(), claimId: 'bbb' }));
  assert.equal(dropInfoOnlyProcessing(PROC(d), seen, LOCK(d)), false);
  assert.equal(JSON.parse(fs.readFileSync(PROC(d), 'utf8')).claimId, 'bbb');
  // A different info-only notice (other claim) is left too; gone → false.
  fs.writeFileSync(PROC(d), JSON.stringify({ ...warn(), claimId: 'ccc' }));
  assert.equal(dropInfoOnlyProcessing(PROC(d), seen, LOCK(d)), false);
  fs.unlinkSync(PROC(d));
  assert.equal(dropInfoOnlyProcessing(PROC(d), seen, LOCK(d)), false);
});
