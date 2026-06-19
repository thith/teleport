import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test gets a throwaway store via TELE_PERSONA_STORE (resolved at call-time
// inside the resolvers), so nothing touches the real runtime state.
let storeFile;
function freshStore() {
  storeFile = path.join(os.tmpdir(), `teleport-persona-store-test-${process.pid}-${storeSeq++}.jsonl`);
  process.env.TELE_PERSONA_STORE = storeFile;
  try { fs.unlinkSync(storeFile); } catch {}
  try { fs.unlinkSync(`${storeFile}.lock`); } catch {}
  return storeFile;
}
let storeSeq = 0;

const {
  readPersonaPin, writePersonaPin, readPersonaIndex, writePersonaIndex,
  peekPersona, personaDisplayName, personaEntry, groupOccupancy, resolvePersonaInGroup,
  readAllPins, compactPersonaStore,
} = await import('./persona-store.mjs');
const { PERSONA_POOL, convoPersonaIndex } = await import('./persona.mjs');

const N = PERSONA_POOL.length;
// Fake topics-store group helper: each convoId → a positive thread id.
const group = (chatId, convoIds, extra = {}) => ({ [chatId]: { ...extra, ...Object.fromEntries(convoIds.map((c) => [String(c), 100])) } });

test('pin round-trip: write then read returns {index, ord}', () => {
  freshStore();
  writePersonaPin('123', 5, 1);
  assert.deepEqual(readPersonaPin('123'), { index: 5, ord: 1 });
  assert.equal(readPersonaIndex('123'), 5);
});

test('pin last-wins: later row overrides earlier', () => {
  freshStore();
  writePersonaPin('123', 5, 1);
  writePersonaPin('123', 9, 3);
  assert.deepEqual(readPersonaPin('123'), { index: 9, ord: 3 });
});

test('ordinal-less legacy row reads back as ord 1', () => {
  freshStore();
  writePersonaIndex('123', 7); // back-compat writer, no ord field
  assert.deepEqual(readPersonaPin('123'), { index: 7, ord: 1 });
});

test('readPersonaPin: null when unpinned / out-of-range index ignored', () => {
  freshStore();
  assert.equal(readPersonaPin('999'), null);
  fs.appendFileSync(storeFile, JSON.stringify({ v: 1, convoId: 999, index: N + 50, ord: 1 }) + '\n');
  assert.equal(readPersonaPin('999'), null); // out-of-range index skipped
});

test('personaDisplayName: ord 1 has no suffix, ord >= 2 appends', () => {
  assert.equal(personaDisplayName(0, 1), PERSONA_POOL[0].name);
  assert.equal(personaDisplayName(0), PERSONA_POOL[0].name);
  assert.equal(personaDisplayName(0, 2), `${PERSONA_POOL[0].name} 2`);
});

test('personaEntry: ord 1 is identical shape to a raw pool entry + index', () => {
  assert.deepEqual(personaEntry(3, 1), { ...PERSONA_POOL[3], index: 3 });
  const o = personaEntry(3, 2);
  assert.equal(o.name, `${PERSONA_POOL[3].name} 2`);
  assert.equal(o.ord, 2);
  assert.equal(o.index, 3);
});

test('peekPersona: derives (ord 1, no write) when unpinned', () => {
  freshStore();
  const p = peekPersona('2120524005926900');
  assert.deepEqual(p, personaEntry(convoPersonaIndex('2120524005926900'), 1));
  assert.equal(readPersonaPin('2120524005926900'), null); // peek never writes
});

test('peekPersona: returns the pin (with ordinal) when present', () => {
  freshStore();
  writePersonaPin('555', 10, 2);
  assert.equal(peekPersona('555').name, `${PERSONA_POOL[10].name} 2`);
});

test('resolvePersonaInGroup: pins on first touch, stable thereafter', () => {
  freshStore();
  const a = resolvePersonaInGroup('42', { chatId: '-100', topicsStore: group('-100', []) });
  const b = resolvePersonaInGroup('42', { chatId: '-100', topicsStore: group('-100', ['42']) });
  assert.deepEqual(a, b); // second call reads the pin, ignores occupancy
});

test('resolvePersonaInGroup: same-hash convos keep the index but get an ordinal (pure hash, no dodge)', () => {
  freshStore();
  const base = '1';
  const baseIdx = convoPersonaIndex(base);
  // find another id colliding on the same base index
  let other = null;
  for (let i = 2; i < 20000 && other == null; i++) if (convoPersonaIndex(`${i}`) === baseIdx) other = `${i}`;
  assert.ok(other, 'expected a hash collision to exist');
  const p1 = resolvePersonaInGroup(base, { chatId: '-100', topicsStore: group('-100', []) });
  const p2 = resolvePersonaInGroup(other, { chatId: '-100', topicsStore: group('-100', [base]) });
  assert.equal(p1.index, p2.index);       // pure hash: both keep the same base index
  assert.equal(p1.ord ?? 1, 1);           // ord 1 omits the field (matches personaForConvo shape)
  assert.equal(p2.ord, 2);                 // disambiguated by ordinal, not by a different persona
  assert.equal(p2.name, `${PERSONA_POOL[baseIdx].name} 2`);
});

test('resolvePersonaInGroup: a CLOSED topic frees its name (no ordinal needed)', () => {
  freshStore();
  const base = '1';
  const baseIdx = convoPersonaIndex(base);
  let other = null;
  for (let i = 2; i < 20000 && other == null; i++) if (convoPersonaIndex(`${i}`) === baseIdx) other = `${i}`;
  resolvePersonaInGroup(base, { chatId: '-100', topicsStore: group('-100', []) }); // base now occupies the name
  // base is CLOSED → its name is free again; `other` should get ord 1, not 2.
  const store = group('-100', [base], { _closed: { [base]: true } });
  const p = resolvePersonaInGroup(other, { chatId: '-100', topicsStore: store });
  assert.equal(p.ord ?? 1, 1);
  assert.equal(p.name, PERSONA_POOL[baseIdx].name);
});

test('resolvePersonaInGroup: cross-group collision is allowed', () => {
  freshStore();
  const base = '1';
  let other = null;
  const baseIdx = convoPersonaIndex(base);
  for (let i = 2; i < 20000 && other == null; i++) if (convoPersonaIndex(`${i}`) === baseIdx) other = `${i}`;
  const p1 = resolvePersonaInGroup(base, { chatId: '-100', topicsStore: group('-100', []) });
  // different chat → same base index is fine
  const p2 = resolvePersonaInGroup(other, { chatId: '-200', topicsStore: group('-200', []) });
  assert.equal(p1.index, p2.index); // both took their hash index, no probe needed
});

test('resolvePersonaInGroup: pool exhausted → ordinal suffix', () => {
  freshStore();
  const chat = '-100';
  // Occupy every base index with a distinct pinned convo.
  const liveIds = [];
  for (let idx = 0; idx < N; idx++) { const id = `9${String(idx).padStart(7, '0')}`; writePersonaPin(id, idx, 1); liveIds.push(id); }
  const newId = '7777777';
  const startIdx = convoPersonaIndex(newId);
  const p = resolvePersonaInGroup(newId, { chatId: chat, topicsStore: group(chat, liveIds) });
  assert.equal(p.index, startIdx);
  assert.equal(p.ord, 2);
  assert.equal(p.name, `${PERSONA_POOL[startIdx].name} 2`);
});

test('resolvePersonaInGroup: second overflow at same base index → ord 3', () => {
  freshStore();
  const chat = '-100';
  const liveIds = [];
  for (let idx = 0; idx < N; idx++) { const id = `9${String(idx).padStart(7, '0')}`; writePersonaPin(id, idx, 1); liveIds.push(id); }
  const startIdx = convoPersonaIndex('7777777');
  // An existing topic already holds "<name> 2" at the same base index.
  const occ2 = '8888888'; writePersonaPin(occ2, startIdx, 2); liveIds.push(occ2);
  const p = resolvePersonaInGroup('7777777', { chatId: chat, topicsStore: group(chat, liveIds) });
  assert.equal(p.ord, 3);
});

test('groupOccupancy: skips _meta keys, non-positive threads, and the excepted convo', () => {
  freshStore();
  writePersonaPin('111', 1, 1);
  writePersonaPin('222', 2, 1);
  const store = { '-100': { '111': 5, '222': 9, '333': 0, _is_forum: true, _ts: { '111': 1 } } };
  const occ = groupOccupancy(store, '-100', { exceptConvoId: '222' });
  assert.ok(occ.baseIndices.has(1));
  assert.ok(!occ.baseIndices.has(2)); // excepted
  assert.equal(occ.baseIndices.size, 1); // '333' thread 0 excluded; _meta excluded
});

test('resolvePersonaInGroup: without chatId/topicsStore → plain pin (no dedup)', () => {
  freshStore();
  const p = resolvePersonaInGroup('42', {});
  assert.deepEqual(p, personaEntry(convoPersonaIndex('42'), 1));
});

test('readAllPins: one read, last-wins per convo, skips junk/out-of-range', () => {
  freshStore();
  writePersonaPin('111', 5, 1);
  writePersonaPin('111', 9, 2); // later wins
  writePersonaPin('222', 3, 1);
  fs.appendFileSync(storeFile, 'not json\n');
  fs.appendFileSync(storeFile, JSON.stringify({ v: 1, convoId: 333, index: N + 9, ord: 1 }) + '\n'); // out of range
  const map = readAllPins();
  assert.deepEqual(map.get('111'), { index: 9, ord: 2 });
  assert.deepEqual(map.get('222'), { index: 3, ord: 1 });
  assert.equal(map.has('333'), false);
  assert.equal(map.size, 2);
});

test('compactPersonaStore: collapses a bloated log to one row per convo, preserving last-wins', () => {
  freshStore();
  // 3 convos, but 250 total rows (heavy re-pinning) → bloated past the gate.
  for (let i = 0; i < 250; i++) writePersonaPin(String(100 + (i % 3)), i % N, 1);
  const before = fs.readFileSync(storeFile, 'utf8').split('\n').filter(Boolean).length;
  const r = compactPersonaStore();
  assert.equal(r.compacted, true);
  assert.ok(r.after <= 3 && r.before === before);
  const after = fs.readFileSync(storeFile, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, 3);
  // last-wins value survives compaction
  const map = readAllPins();
  assert.equal(map.size, 3);
});

test('compactPersonaStore: no-op when not bloated', () => {
  freshStore();
  writePersonaPin('1', 1, 1);
  writePersonaPin('2', 2, 1);
  assert.equal(compactPersonaStore().compacted, false);
});
