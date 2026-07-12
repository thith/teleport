import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, mergePromptData, PROCESSING_TTL_MS, reclaimStaleProcessing } from './tele-listen.mjs';
import { autoConsumeClaimedPrompt } from './send-telegram.mjs';

// RFC 02 P3 — append-until-claimed + P1 auto-consume. Pure helpers here; the
// flow wiring (append/spool/TTL-reclaim in main(), gated by --append) is
// exercised by the tri-runtime smoke test before activation.

test('parseArgs: --append opt-in, default false, orthogonal to --loop/--settle', () => {
  assert.equal(parseArgs(['--convo', '1']).append, false);
  assert.equal(parseArgs(['--convo', '1', '--append']).append, true);
  const all = parseArgs(['--convo', '1', '--settle', '--loop', '--append']);
  assert.equal(all.append, true);
  assert.equal(all.loop, true);
  assert.equal(all.settle, true);
});

test('mergePromptData: concatenates text, unions attachments, takes NEWEST metadata', () => {
  const existing = { text: 'first', attachments: [{ a: 1 }], messageId: 10, fromName: 'Thi', persona: { name: 'X' } };
  const incoming = { text: 'second', attachments: [{ b: 2 }], messageId: 11, fromName: 'Nam', chatId: '-100' };
  const m = mergePromptData(existing, incoming);
  assert.equal(m.text, 'first\n\nsecond');
  assert.deepEqual(m.attachments, [{ a: 1 }, { b: 2 }]);
  assert.equal(m.messageId, 11);    // reply to the newest thread
  assert.equal(m.fromName, 'Nam');  // newest sender's metadata wins
  assert.equal(m.chatId, '-100');
});

test('mergePromptData: null-safe (missing side / missing attachment fields)', () => {
  assert.deepEqual(mergePromptData(null, { text: 'x' }), { text: 'x' });
  assert.deepEqual(mergePromptData({ text: 'y' }, null), { text: 'y' });
  const m = mergePromptData({ text: 'a' }, { text: 'b' });
  assert.equal(m.text, 'a\n\nb');
  assert.deepEqual(m.attachments, []);
});

test('PROCESSING_TTL_MS is a sane 5 minutes', () => {
  assert.equal(PROCESSING_TTL_MS, 5 * 60 * 1000);
});

test('reclaimStaleProcessing: no open prompt → stale becomes the open prompt (with warning)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-'));
  const proc = path.join(d, 'p.processing.json');
  const open = path.join(d, 'p.json');
  fs.writeFileSync(proc, JSON.stringify({ text: 'orphaned batch', messageId: 5 }));
  reclaimStaleProcessing(proc, open);
  assert.equal(fs.existsSync(proc), false);                 // stale consumed
  assert.equal(fs.existsSync(open), true);                  // resurfaced as open
  const back = JSON.parse(fs.readFileSync(open, 'utf8'));
  assert.match(back.text, /khôi phục lô bị treo/);          // warning injected
  assert.match(back.text, /orphaned batch/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('reclaimStaleProcessing: open prompt exists → stale folded IN, both preserved, no data loss', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim2-'));
  const proc = path.join(d, 'p.processing.json');
  const open = path.join(d, 'p.json');
  fs.writeFileSync(proc, JSON.stringify({ text: 'orphan', messageId: 5 }));
  fs.writeFileSync(open, JSON.stringify({ text: 'newer spooled', messageId: 9 }));
  reclaimStaleProcessing(proc, open);
  assert.equal(fs.existsSync(proc), false);
  const merged = JSON.parse(fs.readFileSync(open, 'utf8'));
  assert.match(merged.text, /orphan/);                      // stale preserved
  assert.match(merged.text, /newer spooled/);               // spooled preserved
  assert.equal(merged.messageId, 9);                        // newest metadata
  fs.rmSync(d, { recursive: true, force: true });
});

test('reclaimStaleProcessing: no stale file → no-op (idempotent, never throws)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim3-'));
  reclaimStaleProcessing(path.join(d, 'nope.processing.json'), path.join(d, 'nope.json'));
  assert.equal(fs.existsSync(path.join(d, 'nope.json')), false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('autoConsumeClaimedPrompt: deletes ONLY .processing.json — OPEN inbox untouched (G4)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
  const proc = path.join(d, 'prompt-convo-9.processing.json');
  const open = path.join(d, 'prompt-convo-9.json');
  fs.writeFileSync(proc, '{}');
  fs.writeFileSync(open, '{}');
  assert.equal(autoConsumeClaimedPrompt(9, d), true);      // consumed the CLAIMED batch
  assert.equal(fs.existsSync(proc), false);                // .processing gone
  assert.equal(fs.existsSync(open), true);                 // OPEN prompt untouched (never dropped)
  assert.equal(autoConsumeClaimedPrompt(9, d), false);     // no-op the second time
  assert.equal(autoConsumeClaimedPrompt(null, d), false);  // null convo → no-op
  fs.rmSync(d, { recursive: true, force: true });
});
