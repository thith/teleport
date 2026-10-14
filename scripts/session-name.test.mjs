import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionNames, formatMatch } from './session-name.mjs';

const rows = [
  { pid: 644406, name: 'umipay-ae', hashtag: 'c2383556', status: 'busy' },
  { pid: 331131, name: '🤖 Robot', hashtag: 'd8133684', status: 'shell' },
  { pid: 5, name: 'elephant', hashtag: 'aaaa0000', status: 'idle' },
  { pid: 6, name: null, hashtag: 'bbbb1111' },          // no name → can't be messaged
  { pid: 7, name: 'x-1', hashtag: null, status: 'idle' }, // terminal session without a known session
];
const personaOf = (h) => ({ c2383556: '👻 Ma', d8133684: '🤖 Robot', bbbb1111: '🐘 Voi' })[h] || null;
const names = (q) => resolveSessionNames(q, rows, personaOf).map((r) => r.name);

test('persona name (emoji / case ignored) → the live session name', () => {
  assert.deepEqual(names('Ma'), ['umipay-ae']);
  assert.deepEqual(names('👻 ma'), ['umipay-ae']);
  assert.deepEqual(names('ROBOT'), ['🤖 Robot']);
});

test('#hashtag, convoId, or the session name itself', () => {
  assert.deepEqual(names('#c2383556'), ['umipay-ae']);
  assert.deepEqual(names('3067763322383556'), ['umipay-ae']); // convoId → its hashtag
  assert.deepEqual(names('umipay-ae'), ['umipay-ae']);
  assert.deepEqual(names('x-1'), ['x-1']);
});

test('a bare 8-char word may be a hashtag OR a name; "#…" is a hashtag only', () => {
  assert.deepEqual(names('c2383556'), ['umipay-ae']);
  assert.deepEqual(names('elephant'), ['elephant']);
  assert.deepEqual(names('#elephant'), []);
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
