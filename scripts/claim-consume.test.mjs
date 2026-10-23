import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoConsumeClaimedPrompt, claimIsAnswered, answersAnotherClaim, sendAnswersClaim } from './send-telegram.mjs';

// The confirmed data-loss bug (3-reviewer debate): `autoConsumeClaimedPrompt` used
// to delete whatever `.processing.json` sat in the slot, on EVERY send. An agent
// that sends twice in one turn (progress note + final report) would delete a batch
// the listener claimed mid-turn — one the agent had only ever SEEN as an announce
// preview. The message was gone for good (the poll offset had already advanced),
// hence "I glimpsed a message but lost it, please resend".

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claim-consume-'));
const PROC = (d, c = 9) => path.join(d, `prompt-convo-${c}.processing.json`);
const OPEN = (d, c = 9) => path.join(d, `prompt-convo-${c}.json`);
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const parked = (d) => fs.readdirSync(d).filter((n) => n.includes('.processing.json.stale.'));

test('claimIsAnswered: --claim-id is the strongest proof', () => {
  const claim = { claimId: 'abc123', claimedAt: 5000, messageId: 42 };
  assert.equal(claimIsAnswered(claim, { claimId: 'abc123' }), true);
  assert.equal(claimIsAnswered(claim, { claimId: 'wrong' }), false);   // a different batch is in the slot
});

test('claimIsAnswered: --reply-to naming a message INSIDE the batch also proves it', () => {
  const claim = { claimId: 'x', claimedAt: 5000, messageId: 42, messages: [{ messageId: 40 }, { messageId: 42 }] };
  assert.equal(claimIsAnswered(claim, { replyToMessageId: 40 }), true);  // an EARLIER segment counts
  assert.equal(claimIsAnswered(claim, { replyToMessageId: 99 }), true);  // no match → falls through, not a veto
});

test('claimIsAnswered: a claim stamped AFTER this process started cannot have been read', () => {
  // The agent was already composing this send when the listener claimed the batch.
  assert.equal(claimIsAnswered({ claimedAt: 9000 }, { processStartMs: 8000 }), false);
  assert.equal(claimIsAnswered({ claimedAt: 7000 }, { processStartMs: 8000 }), true);
});

test('claimIsAnswered: with no proof at all it CONSUMES — the ordinary turn must not loop', () => {
  // A normal exchange: the bot reported earlier, the admin replied after that, so
  // the claim is always younger than the previous send. Treating that as "unread"
  // would park a batch the agent just answered and re-announce it forever.
  assert.equal(claimIsAnswered({ claimedAt: 5000 }, {}), true);
  assert.equal(claimIsAnswered({ text: 'legacy' }, {}), true);   // written by an older build
  assert.equal(claimIsAnswered(null, {}), true);                 // unreadable
});

test('autoConsumeClaimedPrompt: an ANSWERED claim is deleted', () => {
  const d = mk();
  write(PROC(d), { claimId: 'tok', claimedAt: 5000, text: 'handled' });
  assert.equal(autoConsumeClaimedPrompt(9, d, { claimId: 'tok' }), true);
  assert.equal(fs.existsSync(PROC(d)), false);
  assert.deepEqual(parked(d), []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('autoConsumeClaimedPrompt: a batch deleted WITHOUT proof is echoed in full; with proof it is not', (t) => {
  // The announce is the agent's only other copy and a host UI may truncate it, so
  // a batch consumed on no proof must reach the agent through this send's output.
  const logs = [];
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  const d = mk();
  const long = 'Ma báo: ' + 'x'.repeat(2000) + ' — đuôi tin';
  write(PROC(d), { claimId: 'tok', claimedAt: 5000, text: long });
  assert.equal(autoConsumeClaimedPrompt(9, d, {}), true);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('without --claim-id') && logs[0].endsWith(long));
  write(PROC(d), { claimId: 'tok2', claimedAt: 5000, text: 'handled' });
  assert.equal(autoConsumeClaimedPrompt(9, d, { claimId: 'tok2' }), true);
  assert.equal(logs.length, 1);                                  // proven → silent
  fs.rmSync(d, { recursive: true, force: true });
});

test('autoConsumeClaimedPrompt: an UNREAD mid-turn claim is PARKED, never deleted', () => {
  const d = mk();
  write(PROC(d), { claimId: 'B-token', claimedAt: 5000, text: 'B — arrived while the agent was working' });
  // The agent is answering batch A; B is a different claim that landed meanwhile.
  assert.equal(autoConsumeClaimedPrompt(9, d, { claimId: 'A-token' }), false);
  assert.equal(fs.existsSync(PROC(d)), false, 'moved out of the claim slot');
  const snaps = parked(d);
  assert.equal(snaps.length, 1, 'parked as a .stale.<pid> snapshot for the listener to re-deliver');
  // The message survives intact — sweepOrphanSnapshots folds this back into the open prompt.
  assert.match(JSON.parse(fs.readFileSync(path.join(d, snaps[0]), 'utf8')).text, /arrived while the agent/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('autoConsumeClaimedPrompt: never touches the OPEN inbox (G4 firewall)', () => {
  const d = mk();
  write(OPEN(d), { text: 'unclaimed — not ours to delete' });
  assert.equal(autoConsumeClaimedPrompt(9, d, {}), false);
  assert.equal(fs.existsSync(OPEN(d)), true);
  assert.deepEqual(parked(d), []);
  assert.equal(autoConsumeClaimedPrompt(null, d, {}), false);   // null convo → no-op
  fs.rmSync(d, { recursive: true, force: true });
});

test('autoConsumeClaimedPrompt: TAKES the claim before judging it (no read-then-delete-by-path)', () => {
  const d = mk();
  write(PROC(d), { claimId: 'B-token', claimedAt: 5000, text: 'B' });
  // Judged NOT ours → the slot is already empty, so a listener publishing a new
  // batch at that path cannot be destroyed by this process afterwards.
  autoConsumeClaimedPrompt(9, d, { claimId: 'A-token' });
  assert.equal(fs.existsSync(PROC(d)), false);
  assert.equal(parked(d).length, 1);
  // A second park in the SAME process must not overwrite the first.
  write(PROC(d), { claimId: 'C-token', claimedAt: 6000, text: 'C' });
  autoConsumeClaimedPrompt(9, d, { claimId: 'A-token' });
  assert.equal(parked(d).length, 2, 'both parked batches survive');
  fs.rmSync(d, { recursive: true, force: true });
});

test('claimIsAnswered: holding a token but finding an UNSTAMPED claim → not ours', () => {
  // A token only ever comes from a stamped announce, so an unstamped claim in the
  // slot must be a different batch (the stamp-failure edge).
  assert.equal(claimIsAnswered({ text: 'unstamped' }, { claimId: 'tok' }), false);
  assert.equal(claimIsAnswered({ text: 'unstamped' }, {}), true);   // no token → old behaviour
});

test('answersAnotherClaim: a public report answering batch A is NOT diverted by a mid-turn steer', () => {
  const whisper = { claimId: 'B-whisper', whisper: true, messageId: 900, messages: [{ messageId: 900 }] };
  // Exact proof: this send answers A, so the steer in the slot must not capture it.
  assert.equal(answersAnotherClaim({ claimId: 'A-token' }, whisper), true);
  // Same send, only --reply-to: naming a message that is NOT in the steer is
  // evidence too — without this arm the report was DM'd and the steer was then
  // consumed as if answered (worse than parking it).
  assert.equal(answersAnotherClaim({ replyTo: 42 }, whisper), true);
  // A genuine answer to the steer keeps the redirect.
  assert.equal(answersAnotherClaim({ claimId: 'B-whisper' }, whisper), false);
  assert.equal(answersAnotherClaim({ replyTo: 900 }, whisper), false);
  // Proof-less → fail-closed: answer privately rather than risk leaking a steer.
  assert.equal(answersAnotherClaim({}, whisper), false);
  assert.equal(answersAnotherClaim({ claimId: 'A-token' }, null), false);
});

// A REAL steer (steer.mjs buildSteerPrompt) has `messageId: null` and no
// `messages[]` — only `replyToMessageId`, the sender's command message. Fixtures
// that invent `messageId: 900` for a steer pin a shape production can never emit,
// which is how two earlier "fixes" passed their tests while being dead code.
const realSteer = (over = {}) => ({
  text: 'private steer', messageId: null, whisper: true, claimId: 'B', claimedAt: 5000,
  fromUserId: '144', replyToMessageId: 555, ...over,
});

test('a STEER is never consumed by a reply that went somewhere else (real steer shape)', () => {
  const steer = realSteer();
  // Answering batch A with --reply-to only: the routing half sends this to the
  // topic, so the consume half must not mark the steer answered — even though the
  // steer's own id set is empty apart from the command message.
  assert.equal(claimIsAnswered(steer, { replyToMessageId: 42, processStartMs: 9000 }), false);
  // …while an agent genuinely answering the steer replies to the command message.
  assert.equal(claimIsAnswered(steer, { replyToMessageId: 555, processStartMs: 9000 }), true);
  // A PLAIN claim keeps the non-veto fall-through (vetoing would re-announce forever).
  assert.equal(claimIsAnswered({ claimId: 'C', claimedAt: 5000, messageId: 901 }, { replyToMessageId: 42, processStartMs: 9000 }), true);
});

test('answersAnotherClaim: the routing gate agrees with the consume gate on the SAME evidence', () => {
  const steer = realSteer();
  for (const [proof, verdict] of [
    [{ replyTo: 42 }, true],        // answering another batch → topic path
    [{ replyTo: 555 }, false],      // answering the steer → DM path
    [{ claimId: 'A' }, true],       // exact token for another batch
    [{ claimId: 'B' }, false],      // exact token for this steer
    [{}, false],                    // no proof → fail-closed
  ]) {
    assert.equal(answersAnotherClaim(proof, steer, { processStartMs: null }), verdict, JSON.stringify(proof));
    // The two gates are two policies over ONE verdict — they can never diverge,
    // including on the processStartMs evidence (claim stamped after the send began).
    for (const processStartMs of [null, steer.claimedAt - 1, steer.claimedAt + 1]) {
      const full = { claimId: proof.claimId ?? null, replyToMessageId: proof.replyTo ?? null, processStartMs };
      const v = sendAnswersClaim(steer, full);
      assert.equal(answersAnotherClaim(proof, steer, { processStartMs }), v === 'no', JSON.stringify(full));
      assert.equal(claimIsAnswered(steer, full), v !== 'no', JSON.stringify(full));
    }
  }
  // the concrete bug: no proof, steer claimed after the send started → NOT the steer's answer
  assert.equal(answersAnotherClaim({}, steer, { processStartMs: steer.claimedAt - 1 }), true);
});

test('sendAnswersClaim: unstamped claim + token → no; no proof at all → unknown', () => {
  assert.equal(sendAnswersClaim({ text: 'unstamped' }, { claimId: 'tok' }), 'no');
  assert.equal(sendAnswersClaim({ claimId: 'X', claimedAt: 5000 }, {}), 'unknown');
  assert.equal(sendAnswersClaim({ claimId: 'X', claimedAt: 9000 }, { processStartMs: 8000 }), 'no');
  assert.equal(sendAnswersClaim(null, { claimId: 'tok' }), 'unknown');
});

test('a PLAIN claim\'s parent message is NOT proof of having read the claim', () => {
  // The admin taps reply on the bot's own report X; batch B (replyToMessageId: X)
  // is claimed mid-send while the agent threads its second message off that same
  // report. The agent learned X by SENDING it, not by reading B — so this must not
  // count as proof, and the processStartMs park must still win.
  const B = { claimId: 'B', claimedAt: 9000, messageId: 200, replyToMessageId: 100 };
  assert.equal(sendAnswersClaim(B, { replyToMessageId: 100, processStartMs: 8000 }), 'no');
  assert.equal(claimIsAnswered(B, { replyToMessageId: 100, processStartMs: 8000 }), false);
  // Even naming a message IN the batch is not proof for a batch claimed after the
  // send began: an EDIT keeps the original message_id, so this could be a fresh
  // correction to an already-answered message → park (re-deliver), never delete.
  assert.equal(sendAnswersClaim(B, { replyToMessageId: 200, processStartMs: 8000 }), 'no');
  // …claimed before the send began, it is proof as before.
  assert.equal(sendAnswersClaim({ ...B, claimedAt: 7000 }, { replyToMessageId: 200, processStartMs: 8000 }), 'yes');
  // …while for a STEER the command message stays proof (it lives in the sender's DM).
  assert.equal(sendAnswersClaim(realSteer({ claimedAt: 9000 }), { replyToMessageId: 555, processStartMs: 8000 }), 'yes');
});

test('an EDIT claimed before a later send began is not answered by a reply-to its message_id', () => {
  // B1 (message 300) was answered by an earlier send; the admin then edited 300 and
  // the listener claimed the edit (B2) BEFORE this second send's process started.
  const B2 = { claimId: 'B2', claimedAt: 7000, messageId: 300, edited: true, editedAt: 1 };
  assert.equal(sendAnswersClaim(B2, { replyToMessageId: 300, processStartMs: 8000 }), 'no');
  assert.equal(claimIsAnswered(B2, { replyToMessageId: 300, processStartMs: 8000 }), false); // parked, not deleted
  // multi-message batch: only the edited segment loses its proof value
  const B3 = { claimId: 'B3', claimedAt: 7000, messageId: 302, messages: [{ messageId: 301, edited: true }, { messageId: 302, edited: false }] };
  assert.equal(sendAnswersClaim(B3, { replyToMessageId: 301, processStartMs: 8000 }), 'no');
  assert.equal(sendAnswersClaim(B3, { replyToMessageId: 302, processStartMs: 8000 }), 'yes');
  // the claim token still proves it
  assert.equal(sendAnswersClaim(B2, { claimId: 'B2', replyToMessageId: 300, processStartMs: 8000 }), 'yes');
});

