import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONA_POOL,
  convoPersonaIndex,
  personaForConvo,
  formatPersona,
} from './persona.mjs';

test('pool has exactly 40 entries', () => {
  assert.equal(PERSONA_POOL.length, 40);
});

test('every emoji is unique', () => {
  const emojis = PERSONA_POOL.map((p) => p.emoji);
  assert.equal(new Set(emojis).size, emojis.length);
});

test('every name is unique', () => {
  const names = PERSONA_POOL.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
});

test('names are at most 2 words', () => {
  for (const { name } of PERSONA_POOL) {
    assert.ok(name.trim().split(/\s+/).length <= 2, `name too long: ${name}`);
  }
});

test('every entry has non-empty emoji and name', () => {
  for (const p of PERSONA_POOL) {
    assert.ok(p.emoji && p.emoji.length > 0);
    assert.ok(p.name && p.name.length > 0);
  }
});

test('convoPersonaIndex is deterministic', () => {
  const id = '3039138158370420';
  assert.equal(convoPersonaIndex(id), convoPersonaIndex(id));
});

test('convoPersonaIndex treats number and string convoId identically', () => {
  assert.equal(convoPersonaIndex(3039138158370420), convoPersonaIndex('3039138158370420'));
});

test('convoPersonaIndex stays within range', () => {
  for (let i = 0; i < 1000; i++) {
    const idx = convoPersonaIndex(`${i * 7919 + 13}`);
    assert.ok(idx >= 0 && idx < PERSONA_POOL.length);
  }
});

test('convoPersonaIndex returns null for null/empty convoId', () => {
  assert.equal(convoPersonaIndex(null), null);
  assert.equal(convoPersonaIndex(undefined), null);
  assert.equal(convoPersonaIndex(''), null);
});

test('personaForConvo returns a pool entry plus index', () => {
  const p = personaForConvo('3039138158370420');
  assert.ok(p);
  assert.equal(typeof p.index, 'number');
  assert.deepEqual({ emoji: p.emoji, name: p.name }, PERSONA_POOL[p.index]);
});

test('personaForConvo is null when no convoId', () => {
  assert.equal(personaForConvo(null), null);
});

test('assignment spreads across the pool (not all one persona)', () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i++) seen.add(convoPersonaIndex(`${i}`));
  // With 4000 distinct ids over 40 buckets, expect near-full coverage.
  assert.ok(seen.size >= 35, `poor spread: only ${seen.size}/40 buckets hit`);
});

test('formatPersona renders "emoji name"', () => {
  assert.equal(formatPersona({ emoji: '🦉', name: 'Cú' }), '🦉 Cú');
  assert.equal(formatPersona(null), '');
});
