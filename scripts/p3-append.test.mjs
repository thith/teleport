import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, mergePromptData, PROCESSING_TTL_MS, reclaimStaleProcessing, attributionLabelFromData, sweepOrphanSnapshots } from './tele-listen.mjs';
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

// RFC 02 P3 impersonation guard: two BARE singles from different senders must NOT
// be merged into one identity — each is labeled with its own sender at merge time.
test('mergePromptData: bare singles from different senders are each attributed (no impersonation)', () => {
  const a = { text: 'lời của A', textAttributed: false, fromName: 'An', fromRole: 'admin', fromUserId: '1', messageId: 10 };
  const b = { text: 'lời của B', textAttributed: false, fromName: 'Ba', fromRole: 'member', fromUserId: '2', messageId: 11 };
  const m = mergePromptData(a, b);
  assert.equal(m.text, 'An (admin): lời của A\n\nBa (member): lời của B');
  assert.equal(m.textAttributed, true);   // result is now labeled
  assert.equal(m.fromName, 'Ba');          // reply still goes to the NEWEST sender
  assert.equal(m.messageId, 11);
});

test('mergePromptData: an already-labeled batch is NOT double-labeled', () => {
  const batch = { text: 'An (admin): x\n\nBa (member): y', textAttributed: true, fromName: 'Ba', fromRole: 'member', fromUserId: '2' };
  const c = { text: 'z', textAttributed: false, fromName: 'Ce', fromRole: 'member', fromUserId: '3' };
  const m = mergePromptData(batch, c);
  assert.equal(m.text, 'An (admin): x\n\nBa (member): y\n\nCe (member): z'); // batch untouched, only new seg labeled
  assert.equal(m.textAttributed, true);
});

test('mergePromptData: legacy prompt (no textAttributed) is treated as attributed — old batch not mangled', () => {
  const legacyBatch = { text: 'An (admin): x\n\nBa (member): y', fromName: 'Ba' }; // no textAttributed field
  const c = { text: 'z', textAttributed: false, fromName: 'Ce', fromRole: 'member', fromUserId: '3' };
  const m = mergePromptData(legacyBatch, c);
  assert.equal(m.text, 'An (admin): x\n\nBa (member): y\n\nCe (member): z'); // legacy side left bare, not prefixed
});

test('attributionLabelFromData: builds label from stored fields; total on gaps', () => {
  assert.equal(attributionLabelFromData({ fromName: 'An', fromRole: 'admin' }), 'An (admin)');
  assert.equal(attributionLabelFromData({ fromName: 'An' }), 'An (member)');           // role default
  assert.equal(attributionLabelFromData({ fromUserId: '7' }), 'user 7 (member)');      // name fallback
  assert.equal(attributionLabelFromData({}), 'user ? (member)');
  assert.equal(attributionLabelFromData(null), 'user ? (member)');
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
  assert.match(merged.text, /khôi phục lô bị treo/);        // warning survives the merge branch too
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

// RFC 02 P3 follow-up #1: sweepOrphanSnapshots — adopt snapshots orphaned when a
// reclaim/append process died after its atomic rename but before writing back.
const DEAD_PID = 2147483646; // vanishingly unlikely to be a live process

test('sweepOrphanSnapshots: dead-owner .stale orphan, no open prompt → resurfaced as the open prompt', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const orphan = path.join(d, `prompt-convo-7.processing.json.stale.${DEAD_PID}`);
  fs.writeFileSync(orphan, JSON.stringify({ text: 'lô mồ côi', textAttributed: false, fromName: 'An', fromRole: 'admin', fromUserId: '1', messageId: 5 }));
  sweepOrphanSnapshots(7, d);
  assert.equal(fs.existsSync(orphan), false);                           // adopted
  const open = JSON.parse(fs.readFileSync(path.join(d, 'prompt-convo-7.json'), 'utf8'));
  assert.match(open.text, /lô mồ côi/);                                 // content preserved
  fs.rmSync(d, { recursive: true, force: true });
});

test('sweepOrphanSnapshots: dead-owner .appending orphan folds INTO the open prompt (orphan is the older side, no impersonation)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep2-'));
  const orphan = path.join(d, `prompt-convo-7.json.appending.${DEAD_PID}`);
  fs.writeFileSync(orphan, JSON.stringify({ text: 'lời của An', textAttributed: false, fromName: 'An', fromRole: 'admin', fromUserId: '1', messageId: 5 }));
  fs.writeFileSync(path.join(d, 'prompt-convo-7.json'), JSON.stringify({ text: 'lời của Ba', textAttributed: false, fromName: 'Ba', fromRole: 'member', fromUserId: '2', messageId: 9 }));
  sweepOrphanSnapshots(7, d);
  assert.equal(fs.existsSync(orphan), false);
  const open = JSON.parse(fs.readFileSync(path.join(d, 'prompt-convo-7.json'), 'utf8'));
  assert.equal(open.text, 'An (admin): lời của An\n\nBa (member): lời của Ba'); // each attributed → no impersonation
  assert.equal(open.messageId, 9);                                      // newest metadata kept
  fs.rmSync(d, { recursive: true, force: true });
});

test('sweepOrphanSnapshots: a snapshot owned by a LIVE process (incl. ourself) is left alone — never stolen mid-op', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep3-'));
  // Our own pid is alive → the liveness guard must skip it.
  const mine = path.join(d, `prompt-convo-7.processing.json.stale.${process.pid}`);
  fs.writeFileSync(mine, JSON.stringify({ text: 'đang xử' }));
  sweepOrphanSnapshots(7, d);
  assert.equal(fs.existsSync(mine), true);                              // untouched
  assert.equal(fs.existsSync(path.join(d, 'prompt-convo-7.json')), false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('sweepOrphanSnapshots: ignores unrelated files + other convos + non-pid suffixes', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep4-'));
  const keep = [
    'prompt-convo-7.json',                                   // the real open prompt (not a snapshot)
    'prompt-convo-8.processing.json.stale.' + DEAD_PID,      // different convo
    'prompt-convo-7.processing.json.stale.notapid',          // non-numeric suffix
    'random.txt',
  ];
  for (const f of keep) fs.writeFileSync(path.join(d, f), '{}');
  sweepOrphanSnapshots(7, d);
  for (const f of keep) assert.equal(fs.existsSync(path.join(d, f)), true, `${f} must be untouched`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('sweepOrphanSnapshots: corrupt orphan (bad JSON) with dead owner → QUARANTINED, not deleted (zero-loss)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep5-'));
  const orphan = path.join(d, `prompt-convo-7.processing.json.stale.${DEAD_PID}`);
  fs.writeFileSync(orphan, '{ this is not json');
  sweepOrphanSnapshots(7, d);
  assert.equal(fs.existsSync(orphan), false);                           // moved aside
  assert.equal(fs.existsSync(orphan + '.corrupt'), true);               // preserved for manual recovery
  assert.equal(fs.readFileSync(orphan + '.corrupt', 'utf8'), '{ this is not json'); // content intact
  assert.equal(fs.existsSync(path.join(d, 'prompt-convo-7.json')), false); // nothing bogus resurfaced
  // Idempotent: a second sweep must NOT re-process the quarantined file.
  sweepOrphanSnapshots(7, d);
  assert.equal(fs.readdirSync(d).filter((f) => f.endsWith('.corrupt')).length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('sweepOrphanSnapshots: a LIVE owner is NEVER adopted, even for an old snapshot (no live-steal race)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep6-'));
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const orphan = path.join(d, `prompt-convo-7.processing.json.stale.${child.pid}`);
    fs.writeFileSync(orphan, JSON.stringify({ text: 'held by a live op' }));
    // Even an OLD mtime must not adopt while the owner is alive — a paused-but-
    // alive op could resume and clobber. Ownership is the only signal.
    const old = (Date.now() - 60 * 60 * 1000) / 1000; // 1h old
    fs.utimesSync(orphan, old, old);
    sweepOrphanSnapshots(7, d);
    assert.equal(fs.existsSync(orphan), true, 'live-owner snapshot must never be stolen');
    assert.equal(fs.existsSync(path.join(d, 'prompt-convo-7.json')), false);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// The collision the reviewer flagged: this process's own reclaim left a parked
// `.stale.<ourpid>` (write-failed), AND a separate dead-owner orphan exists. The
// dead orphan must be adopted WITHOUT clobbering our own parked snapshot.
test('sweepOrphanSnapshots: adopting a dead orphan never clobbers our own parked snapshot', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep7-'));
  const mineParked = path.join(d, `prompt-convo-7.processing.json.stale.${process.pid}`);
  const deadOrphan = path.join(d, `prompt-convo-7.processing.json.stale.${DEAD_PID}`);
  fs.writeFileSync(mineParked, JSON.stringify({ text: 'MY parked batch' }));
  fs.writeFileSync(deadOrphan, JSON.stringify({ text: 'dead orphan batch', textAttributed: false, fromName: 'An', fromRole: 'admin', fromUserId: '1' }));
  sweepOrphanSnapshots(7, d);
  assert.equal(fs.existsSync(mineParked), true, 'our own parked snapshot must survive');
  assert.equal(JSON.parse(fs.readFileSync(mineParked, 'utf8')).text, 'MY parked batch'); // uncorrupted
  assert.equal(fs.existsSync(deadOrphan), false);                        // dead orphan adopted
  assert.match(JSON.parse(fs.readFileSync(path.join(d, 'prompt-convo-7.json'), 'utf8')).text, /dead orphan batch/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('sweepOrphanSnapshots: persistent write failure parks the batch + warns ONCE (no per-poll log flood)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep8-'));
  // Force writePromptAtomic to fail deterministically: the prompt path is a
  // NON-EMPTY directory, so the temp→prompt rename can't succeed.
  const promptDir = path.join(d, 'prompt-convo-7.json');
  fs.mkdirSync(promptDir);
  fs.writeFileSync(path.join(promptDir, 'x'), '1');
  const orphan = path.join(d, `prompt-convo-7.processing.json.stale.${DEAD_PID}`);
  fs.writeFileSync(orphan, JSON.stringify({ text: 'batch that cannot land' }));

  sweepOrphanSnapshots(7, d);
  assert.equal(fs.existsSync(orphan), true, 'orphan stays PARKED on write failure — never lost');
  assert.equal(fs.existsSync(orphan + '.warned'), true, 'a one-shot warn marker is dropped');

  // A second poll (fresh process in prod) must NOT re-warn — the marker suppresses it.
  sweepOrphanSnapshots(7, d);
  assert.equal(fs.existsSync(orphan), true);
  assert.equal(fs.readdirSync(d).filter((f) => f.endsWith('.warned')).length, 1, 'warned once, not per poll');
  fs.rmSync(d, { recursive: true, force: true });
});

// RFC 03 §5.5 — mergeOrSpoolPrompt: the shared, write-locked take/merge/rm-last that
// the listener-append AND senders use to write the OPEN prompt slot without clobber.
import { mergeOrSpoolPrompt } from './tele-listen.mjs';

test('mergeOrSpoolPrompt: empty slot → spools data as a fresh prompt', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-'));
  const pf = path.join(d, 'prompt-convo-5.json');
  const r = await mergeOrSpoolPrompt(pf, { text: 'hi', textAttributed: false, fromName: 'An', fromRole: 'admin', fromUserId: '1' });
  assert.equal(r, 'spooled');
  assert.equal(JSON.parse(fs.readFileSync(pf, 'utf8')).text, 'hi');
  fs.rmSync(d, { recursive: true, force: true });
});

test('mergeOrSpoolPrompt: existing open prompt → merges (attribution preserved, no stray .appending)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mos2-'));
  const pf = path.join(d, 'prompt-convo-5.json');
  fs.writeFileSync(pf, JSON.stringify({ text: 'lời của An', textAttributed: false, fromName: 'An', fromRole: 'admin', fromUserId: '1', messageId: 5 }));
  const r = await mergeOrSpoolPrompt(pf, { text: 'lời của Ba', textAttributed: false, fromName: 'Ba', fromRole: 'member', fromUserId: '2', messageId: 9 });
  assert.equal(r, 'merged');
  const out = JSON.parse(fs.readFileSync(pf, 'utf8'));
  assert.equal(out.text, 'An (admin): lời của An\n\nBa (member): lời của Ba'); // no impersonation
  assert.equal(out.messageId, 9);                                              // newest metadata
  assert.equal(fs.readdirSync(d).filter((f) => f.includes('.appending.')).length, 0); // snapshot cleaned
  fs.rmSync(d, { recursive: true, force: true });
});

test('mergeOrSpoolPrompt: with write-lock → releases it after', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mos3-'));
  const pf = path.join(d, 'prompt-convo-5.json');
  const lock = path.join(d, 'prompt-write-5.lock');
  await mergeOrSpoolPrompt(pf, { text: 'x' }, lock);
  assert.equal(fs.existsSync(lock), false, 'write-lock released after write');
  fs.rmSync(d, { recursive: true, force: true });
});

test('mergeOrSpoolPrompt: on lock exhaustion it THROWS (durable write must precede a "queued" report)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mos4-'));
  const pf = path.join(d, 'prompt-convo-5.json');
  const lock = path.join(d, 'prompt-write-5.lock');
  fs.writeFileSync(lock, String(Date.now())); // a fresh peer lock (not stale) → never acquirable
  await assert.rejects(mergeOrSpoolPrompt(pf, { text: 'x' }, lock), /could not acquire/);
  assert.equal(fs.existsSync(pf), false, 'nothing written when the write-lock could not be taken');
  assert.equal(fs.existsSync(lock), true, "peer's lock left intact");
  fs.rmSync(d, { recursive: true, force: true });
});
