import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTarget, normalizeTarget } from './handover.mjs';
import { targetFromReply, resolveSteerTarget } from './steer.mjs';
import { shortConvoHash } from './convo-hash.mjs';

// `shortConvoHash` keeps only the LAST 8 digits of a convoId, so two different
// convos can render the SAME `#hashtag`. handover.mjs used to assert in a comment
// that hashtags "never collide", which is why nothing checked — and a colliding
// hashtag would then be recency-picked, silently steering a PRIVATE whisper at the
// wrong agent.
const A = '1205483045424020';
const B = '2205483045424020';

const topic = (convoId, ts, name) => ({
  convoId, chatId: '-100777', ts,
  hashtag: shortConvoHash(convoId),   // live topics store it WITHOUT the leading '#'
  persona: { emoji: '🐘', name },
  source: 'topic',
});

test('the collision is real, not hypothetical', () => {
  assert.equal(shortConvoHash(A), shortConvoHash(B));
  assert.equal(shortConvoHash(A), 'e5424020');
});

test('a COLLIDING hashtag is refused, never recency-picked', () => {
  const live = [topic(A, 1000, 'Voi'), topic(B, 9000, 'Rùa')];
  const m = matchTarget(normalizeTarget('#e5424020'), live);
  assert.equal(m.status, 'ambiguous', 'guessing here would silently misdeliver');
  assert.equal(m.candidates.length, 2);
  assert.equal(m.candidates[0].convoId, B, 'candidates are listed freshest-first for the human');
});

test('a UNIQUE hashtag still resolves exactly as before', () => {
  const live = [topic(A, 1000, 'Voi'), topic('999888777666555', 9000, 'Rùa')];
  const m = matchTarget(normalizeTarget('#e5424020'), live);
  assert.equal(m.status, 'found');
  assert.equal(m.match.convoId, A);
});

test('a persona NAME still prefers the most recently active (unchanged convention)', () => {
  const live = [topic(A, 1000, 'Voi'), topic('999888777666555', 9000, 'Voi')];
  const m = matchTarget(normalizeTarget('Voi'), live);
  assert.equal(m.status, 'found', 'names are nicknames — recency is the intent');
  assert.equal(m.match.convoId, '999888777666555');
  assert.equal(m.shadowed.length, 1);
});

test('a colliding hashtag in a reply is REPORTED as ambiguous, not silently skipped', () => {
  const live = [topic(A, 1000, 'Voi'), topic(B, 9000, 'Rùa')];
  const r = targetFromReply('trả lời #e5424020 nhé', live);
  assert.equal(r.ambiguous, '#e5424020', 'the caller must be able to say WHY');
  assert.equal(r.candidates.length, 2);
  // …while a unique hash in the same reply still resolves.
  assert.equal(targetFromReply('trả lời #e5424020 nhé', [topic(A, 1000, 'Voi')])?.convoId, A);
});

test('a colliding hash must not let a LATER hash in the same reply receive the steer', () => {
  // Skipping the ambiguous one and continuing would deliver a PRIVATE instruction
  // to a different agent entirely.
  const other = topic('777666555444333', 5000, 'Mèo');
  const live = [topic(A, 1000, 'Voi'), topic(B, 9000, 'Rùa'), other];
  const r = targetFromReply(`gửi #e5424020 và #${other.hashtag}`, live);
  assert.equal(r.ambiguous, '#e5424020');
  assert.equal(r.convoId, undefined, 'the later, unrelated hash must NOT be chosen');
});

test('the ambiguity reaches the user as an ambiguity, not as a nonsense target', () => {
  // resolveSteerTarget used to fall back to treating the first WORD of the command
  // as a target name, so `/whisper làm tiếp` answered "target làm not found".
  const live = [topic(A, 1000, 'Voi'), topic(B, 9000, 'Rùa')];
  const r = resolveSteerTarget(['làm', 'tiếp'], { live, replyText: 'trả lời #e5424020 nhé', usage: 'usage' });
  assert.match(r.error, /#e5424020/);
  assert.match(r.error, /ambiguous/);
  assert.doesNotMatch(r.error, /làm/);
});

test('an exact address matching the SAME convo twice is not a collision', () => {
  // listLiveTopics emits one row per (chatId, convoId), so a convo with topics in
  // two groups appears twice — refusing there would break exact targeting for a
  // case with no ambiguity at all.
  const twoGroups = [
    { ...topic(A, 1000, 'Voi'), chatId: '-100111' },
    { ...topic(A, 9000, 'Voi'), chatId: '-100222' },
  ];
  const m = matchTarget(normalizeTarget(`#${shortConvoHash(A)}`), twoGroups);
  assert.equal(m.status, 'found');
  assert.equal(m.match.chatId, '-100222', 'freshest topic of the SAME convo');
  assert.equal(matchTarget(normalizeTarget(A), twoGroups).status, 'found');
});
