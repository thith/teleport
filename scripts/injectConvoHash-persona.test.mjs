import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectConvoHash, shortConvoHash } from './send-telegram.mjs';

const ID = '3039138158370420';
const HASH = `#${shortConvoHash(ID)}`;
const P = { emoji: '🦉', name: 'Cú' };

test('persona: script owns identity, strips agent leading emoji', () => {
  const out = injectConvoHash('🦊 Claude on x', 'luni', ID, { persona: P });
  assert.equal(out, `[luni] [🦉 Cú ${HASH}] Claude on x`);
});

test('persona: no leading emoji in body still renders persona tag', () => {
  const out = injectConvoHash('hello', 'luni', ID, { persona: P });
  assert.equal(out, `[luni] [🦉 Cú ${HASH}] hello`);
});

test('persona: empty body emits tag with no trailing space', () => {
  const out = injectConvoHash('', 'luni', ID, { persona: P });
  assert.equal(out, `[luni] [🦉 Cú ${HASH}]`);
});

test('persona: multi-word name preserved', () => {
  const out = injectConvoHash('hi', 'luni', ID, { persona: { emoji: '🦝', name: 'Mèo Rừng' } });
  assert.equal(out, `[luni] [🦝 Mèo Rừng ${HASH}] hi`);
});

test('no persona: legacy behaviour unchanged (agent emoji pulled into tag)', () => {
  const out = injectConvoHash('🦊 Claude on x', 'luni', ID);
  assert.equal(out, `[luni] [🦊 ${HASH}] Claude on x`);
});

test('no persona: no leading emoji unchanged', () => {
  const out = injectConvoHash('hello', 'luni', ID);
  assert.equal(out, `[luni] [${HASH}] hello`);
});

test('persona path escapes correctly in raw mode', () => {
  // pretokensEscaped escapes [ ] # in the injected prefix; persona text has no
  // MdV2 specials so only the bracket/hash syntax is escaped.
  const out = injectConvoHash('body', 'luni', ID, { persona: P, pretokensEscaped: true });
  assert.ok(out.includes('🦉 Cú'));
  assert.ok(out.startsWith('\\[luni\\] '));
});
