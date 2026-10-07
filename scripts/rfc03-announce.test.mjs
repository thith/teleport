import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimPreexistingPrompt, parseArgs } from './tele-listen.mjs';

// RFC 03 §5.2 — claim-before-announce. The listener claims a pre-existing UNCLAIMED
// prompt (an injected side-message, or one that survived the agent's death) before
// announcing it, so the announce can't repeat every poll (the RFC 02 flood).

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rfc03-'));
const P = (d) => path.join(d, 'prompt-convo-7.json');
const PROC = (d) => path.join(d, 'prompt-convo-7.processing.json');

test('claimPreexistingPrompt: unclaimed open prompt → claimed (renamed to .processing), returns the claim token', () => {
  const d = mk();
  fs.writeFileSync(P(d), JSON.stringify({ text: 'injected ask' }));
  assert.match(String(claimPreexistingPrompt(P(d), PROC(d))), /^[0-9a-f]{16}$/);  // returns the claim token
  assert.equal(fs.existsSync(P(d)), false);                 // open prompt consumed
  assert.equal(fs.existsSync(PROC(d)), true);               // now a claim
  assert.equal(JSON.parse(fs.readFileSync(PROC(d), 'utf8')).text, 'injected ask'); // content intact
  fs.rmSync(d, { recursive: true, force: true });
});

test('claimPreexistingPrompt: no open prompt → false (nothing pending)', () => {
  const d = mk();
  assert.equal(claimPreexistingPrompt(P(d), PROC(d)), false);
  assert.equal(fs.existsSync(PROC(d)), false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('claimPreexistingPrompt: a .processing claim already in flight → false (never pre-empt the agent)', () => {
  const d = mk();
  fs.writeFileSync(PROC(d), JSON.stringify({ text: 'agent is handling this' }));
  fs.writeFileSync(P(d), JSON.stringify({ text: 'a newer open prompt spooled alongside' }));
  assert.equal(claimPreexistingPrompt(P(d), PROC(d)), false); // busy → don't announce
  assert.equal(fs.existsSync(P(d)), true);                    // open prompt untouched
  assert.equal(JSON.parse(fs.readFileSync(PROC(d), 'utf8')).text, 'agent is handling this'); // claim untouched
  fs.rmSync(d, { recursive: true, force: true });
});

test('claimPreexistingPrompt: idempotent — a second call after claiming finds nothing (no flood, no double-claim)', () => {
  const d = mk();
  fs.writeFileSync(P(d), '{}');
  assert.match(String(claimPreexistingPrompt(P(d), PROC(d))), /^[0-9a-f]{16}$/);  // returns the claim token  // first poll claims + announces
  assert.equal(claimPreexistingPrompt(P(d), PROC(d)), false); // next poll: .processing exists → silent
  assert.equal(claimPreexistingPrompt(P(d), PROC(d)), false); // and again → still silent (bounded)
  fs.rmSync(d, { recursive: true, force: true });
});

test('claimPreexistingPrompt: touch makes the claim mtime recent (TTL counts from claim)', () => {
  const d = mk();
  fs.writeFileSync(P(d), '{}');
  // Backdate the open prompt far into the past.
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  fs.utimesSync(P(d), old, old);
  const before = Date.now();
  assert.match(String(claimPreexistingPrompt(P(d), PROC(d))), /^[0-9a-f]{16}$/);  // returns the claim token
  const mtimeMs = fs.statSync(PROC(d)).mtimeMs;
  assert.ok(mtimeMs >= before - 2000, `claim mtime should be ~now, got ${mtimeMs} vs ${before}`);
  fs.rmSync(d, { recursive: true, force: true });
});

test('parseArgs: --announce-preexisting opt-in, default false, requires --append', () => {
  assert.equal(parseArgs(['--convo', '1', '--append']).announcePreexisting, false);
  assert.equal(parseArgs(['--convo', '1', '--append', '--announce-preexisting']).announcePreexisting, true);
  // default path (no flags) unchanged
  assert.equal(parseArgs(['--convo', '1']).announcePreexisting, false);
  // requires --append
  assert.throws(() => parseArgs(['--convo', '1', '--announce-preexisting']), /requires --append/);
  // combines with the rest
  const all = parseArgs(['--convo', '1', '--settle', '--loop', '--append', '--announce-preexisting']);
  assert.equal(all.announcePreexisting, true);
  assert.equal(all.append, true);
});

const LOCK = (d) => path.join(d, 'prompt-write-7.lock');

test('claimPreexistingPrompt: with a write-lock file → claims and RELEASES the lock', () => {
  const d = mk();
  fs.writeFileSync(P(d), '{}');
  assert.match(String(claimPreexistingPrompt(P(d), PROC(d), LOCK(d))), /^[0-9a-f]{16}$/);  // returns the claim token
  assert.equal(fs.existsSync(PROC(d)), true);
  assert.equal(fs.existsSync(LOCK(d)), false, 'write-lock must be released after claim');
  fs.rmSync(d, { recursive: true, force: true });
});

test('claimPreexistingPrompt: write-lock already held by a peer → false, prompt left intact (announce next poll)', () => {
  const d = mk();
  fs.writeFileSync(P(d), '{}');
  // Simulate a peer holding the lock (fresh timestamp → not stale-reclaimed).
  fs.writeFileSync(LOCK(d), String(Date.now()));
  assert.equal(claimPreexistingPrompt(P(d), PROC(d), LOCK(d)), false);
  assert.equal(fs.existsSync(P(d)), true, 'prompt not claimed while lock is contended');
  assert.equal(fs.existsSync(PROC(d)), false);
  assert.equal(fs.existsSync(LOCK(d)), true, "peer's lock not stolen/released");
  fs.rmSync(d, { recursive: true, force: true });
});
