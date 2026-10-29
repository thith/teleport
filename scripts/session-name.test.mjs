import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionNames, formatMatch, tailConflict } from './session-name.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';

const rows = [
  { pid: 644406, name: 'umipay-ae', hashtag: 'c2383556', status: 'busy', sessionId: 'ae61d4f1-5ecc-46fe-9cea-75b4c9d9b751' },
  { pid: 331131, name: '🤖 Robot', hashtag: 'd8133684', status: 'shell' },
  { pid: 5, name: 'elephant', hashtag: 'aaaa0000', status: 'idle' },
  { pid: 6, name: null, hashtag: 'bbbb1111' },          // no name → can't be messaged
  { pid: 7, name: 'x-1', hashtag: null, status: 'idle' }, // terminal session without a known session
];
const personaOf = (r) => ({ c2383556: '👻 Ma', d8133684: '🤖 Robot', bbbb1111: '🐘 Voi' })[r.hashtag] || null;
const names = (q) => resolveSessionNames(q, rows, personaOf).map((r) => r.name);

test('persona name (emoji / case ignored) → the live session name', () => {
  assert.deepEqual(names('Ma'), ['umipay-ae']);
  assert.deepEqual(names('👻 ma'), ['umipay-ae']);
  assert.deepEqual(names('ROBOT'), ['🤖 Robot']);
});

test('#hashtag, convoId, or the session name itself', () => {
  assert.deepEqual(names('#c2383556'), ['umipay-ae']);
  assert.deepEqual(names(String(uuidToConvoInt('ae61d4f1-5ecc-46fe-9cea-75b4c9d9b751'))), ['umipay-ae']); // full convoId
  assert.deepEqual(names('2067763322383556'), []); // same last digits, different convo → no match
  assert.deepEqual(names('umipay-ae'), ['umipay-ae']);
  assert.deepEqual(names('x-1'), ['x-1']);
});

test('a hashtag shape (bare or "#…") is a hashtag only; any other word is a name', () => {
  assert.deepEqual(names('c2383556'), ['umipay-ae']);
  assert.deepEqual(names('elephant'), ['elephant']);
  assert.deepEqual(names('#elephant'), []);
  assert.deepEqual(names('c9999999'), [], 'an unmatched hashtag never falls back to names');
});

test('no match / sessions without a name are never returned', () => {
  assert.deepEqual(names('Voi'), []);
  assert.deepEqual(names('nobody'), []);
  assert.deepEqual(names(''), []);
});

test('formatMatch', () => {
  const [r] = resolveSessionNames('Ma', rows, personaOf);
  assert.equal(formatMatch(r), '👻 Ma #c2383556 → 📨 umipay-ae · PID 644406 · busy');
});

test('3-digit tail (RFC 28): over ALL live rows (nameless too); two hashtags behind it → no match + tailConflict says why', () => {
  const rs = [{ pid: 1, name: 'a', hashtag: 'f4451780', sessionId: 's1' }, { pid: 2, name: 'b', hashtag: 'e5555555', sessionId: 's2' }];
  assert.deepEqual(resolveSessionNames('780', rs, personaOf).map((r) => r.name), ['a']);
  assert.deepEqual(resolveSessionNames('name:780', rs, personaOf).map((r) => r.name), ['a']);
  assert.deepEqual(resolveSessionNames('999', rs, personaOf), []);
  assert.equal(tailConflict('780', rs, personaOf), null);
  const twin = [...rs, { pid: 3, name: null, hashtag: 'c0000780', sessionId: 's3' }]; // no name → can't be messaged, still a twin
  assert.deepEqual(resolveSessionNames('780', twin, personaOf), []);
  assert.match(tailConflict('780', twin, personaOf), /khớp 2 agent.*#f4451780.*#c0000780/);
  assert.equal(tailConflict('Ma', twin, personaOf), null);
  assert.deepEqual(resolveSessionNames('convo:780', rs, personaOf), [], 'convo:<id> compares the full convoId');
});

test('persona is looked up per ROW (personaOf(row)), so two rows sharing a hashtag keep their own names', () => {
  const rs = [{ pid: 1, name: 'x', hashtag: 'a1111111', sessionId: 'sA' }, { pid: 2, name: 'y', hashtag: 'a1111111', sessionId: 'sB' }];
  const byRow = (r) => ({ sA: '🐺 Sói', sB: '🦊 Cáo' })[r.sessionId] || null;
  assert.deepEqual(resolveSessionNames('Sói', rs, byRow).map((r) => r.name), ['x']);
  assert.deepEqual(resolveSessionNames('Cáo', rs, byRow).map((r) => r.name), ['y']);
});
