import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PERSONA_POOL,
  convoPersonaIndex,
  personaForConvo,
  formatPersona,
} from './persona.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';

const PERSONA_SCRIPT = fileURLToPath(new URL('./persona.mjs', import.meta.url));

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

// RFC 04: `node persona.mjs` whoami — resolves THIS agent's persona from its
// native session env and prints "<emoji> <name>" to stdout.
test('CLI whoami prints persona from CLAUDE_CODE_SESSION_ID', () => {
  // d0f29b89… → uuidToConvoInt → known convoId → known persona; cross-check via
  // personaForConvo so the test tracks the registry instead of hard-coding it.
  const sessionId = 'd0f29b89-3400-4ecf-8d92-0e49f466db4f';
  const out = execFileSync(process.execPath, [PERSONA_SCRIPT], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, CODEX_THREAD_ID: '' },
    encoding: 'utf8',
  }).trim();
  // Cross-check against PRODUCTION derivation (uuidToConvoInt), not a re-impl,
  // so a change to the hex-head length can't pass against a stale local copy.
  const convoId = uuidToConvoInt(sessionId);
  assert.equal(out, formatPersona(personaForConvo(convoId)));
});

test('CLI whoami exits non-zero when no session env', () => {
  assert.throws(() => execFileSync(process.execPath, [PERSONA_SCRIPT], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' },
    encoding: 'utf8',
    stdio: 'pipe',
  }));
});
