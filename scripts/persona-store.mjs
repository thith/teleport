// Persona PIN store (RFC 01, ext) — persist each convo's persona so (a) growing
// PERSONA_POOL never reshuffles convos that already exist, and (b) a per-GROUP
// ordinal that disambiguates name collisions ("Bò 2") stays stable.
//
// Why pin the index: `convoPersonaIndex` is `hash(convoId) % POOL.length`.
// Appending to the pool changes `length`, hence `% length`, hence the persona of
// EVERY live convo (h%40 ≠ h%110). Pinning the index at first touch and reading
// it back keeps a running agent's identity stable across pool growth.
//
// Wire-format (one JSON line per row, last-wins on read):
//   { "v": 1, "convoId": <int>, "index": <int>, "ord": <int≥1>, "ts": <epoch-ms> }
// `ord` 1 (or absent on legacy rows) = bare name; ord ≥2 = "<name> <ord>". The
// log is append-only; `compactPersonaStore` reclaims it (last-wins per convoId).
//
// Concurrency model:
//   - The base INDEX is a pure deterministic hash, so two processes pinning the
//     same convo write the same index — racing double-appends are harmless.
//   - The ORDINAL is group state, computed under `acquireLockSync` so two NEW
//     convos in one group don't pick the same ordinal — for the common case
//     where the colliding topic is ALREADY in the topics-store snapshot. The one
//     gap the lock can't close (two simultaneous FIRST sends whose topics aren't
//     in any snapshot yet) is an ACCEPTED, documented limitation — see
//     resolvePersonaInGroup.
//
// NOT a leaf: it imports persona.mjs (the leaf) + fs. persona.mjs must therefore
// only import THIS module lazily (dynamic import in its CLI), never at load —
// else a cycle. send-telegram / tele-listen import this eagerly; that's fine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONA_POOL, convoPersonaIndex } from './persona.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_PERSONA_STORE = path.join(__dirname, 'tmp', 'tele-reply', 'persona-store.jsonl');
export const PERSONA_SCHEMA_VERSION = 1;

// Resolve the active store path at CALL TIME (not import time) so a test can set
// TELE_PERSONA_STORE to a throwaway tmp file AFTER the module is imported and
// have every resolver pick it up — isolating tests from the real runtime state.
// Production leaves TELE_PERSONA_STORE unset → STATIC_PERSONA_STORE.
export function personaStorePath() {
  return process.env.TELE_PERSONA_STORE || STATIC_PERSONA_STORE;
}
// Back-compat static export (e.g. the one-off backfill CLI references it). Note:
// this is the STATIC default; runtime resolvers use personaStorePath() so the
// env override applies. Don't use this constant where env isolation matters.
export const DEFAULT_PERSONA_STORE = STATIC_PERSONA_STORE;

// Separator for the disambiguating ordinal in a DISPLAY name: "Bò" → "Bò 2".
// ord 1 (or absent) renders with NO suffix; ord ≥ 2 appends `${SEP}${ord}`.
export const DISPLAY_ORD_SEP = ' ';

// Display name for a (base index, ordinal). The ordinal only ever appears when
// a group is so crowded the base name had to be reused (pool exhausted).
export function personaDisplayName(index, ord = 1) {
  const base = PERSONA_POOL[index].name;
  return (ord && ord >= 2) ? `${base}${DISPLAY_ORD_SEP}${ord}` : base;
}

// Build the public persona object. The COMMON case (ord 1) returns exactly
// `{ emoji, name, index }` — byte-identical to persona.mjs#personaForConvo, so
// every existing consumer/test is unaffected. Only the rare ordinal case (ord
// ≥ 2, pool exhausted) carries the suffixed `name` plus an explicit `ord` field.
// `name` always already includes any suffix, so downstream (topic title,
// in-message tag, addressing) needs zero extra logic.
export function personaEntry(index, ord = 1) {
  if (index == null || index < 0 || index >= PERSONA_POOL.length) return null;
  const base = PERSONA_POOL[index];
  if (!ord || ord <= 1) return { ...base, index };
  return { ...base, name: personaDisplayName(index, ord), index, ord };
}

// Last-wins read of a convo's PIN `{ index, ord }`. null = not pinned yet. Rows
// written before ordinals existed (no `ord` field) read back as ord 1.
export function readPersonaPin(convoId, file = personaStorePath()) {
  if (convoId == null || convoId === '') return null;
  const want = Number(convoId);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let found = null;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && Number(row.convoId) === want && Number.isInteger(row.index)
      && row.index >= 0 && row.index < PERSONA_POOL.length) {
      const ord = Number.isInteger(row.ord) && row.ord >= 1 ? row.ord : 1;
      found = { index: row.index, ord }; // keep scanning: last matching row wins
    }
  }
  return found;
}

// Back-compat: just the base index of a convo's pin (drops the ordinal).
export function readPersonaIndex(convoId, file = personaStorePath()) {
  const pin = readPersonaPin(convoId, file);
  return pin ? pin.index : null;
}

// Read the ENTIRE pin file ONCE into a last-wins Map<convoId(string), {index,ord}>.
// Used by group occupancy so it scans the file a single time instead of once per
// topic (avoids O(topics × filesize) re-reads on the send hot path).
export function readAllPins(file = personaStorePath()) {
  const map = new Map();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return map; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && row.convoId != null && Number.isInteger(row.index)
      && row.index >= 0 && row.index < PERSONA_POOL.length) {
      const ord = Number.isInteger(row.ord) && row.ord >= 1 ? row.ord : 1;
      map.set(String(row.convoId), { index: row.index, ord }); // last-wins
    }
  }
  return map;
}

// Append one pin row (atomic small-line write + fsync).
export function writePersonaPin(convoId, index, ord = 1, file = personaStorePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { v: PERSONA_SCHEMA_VERSION, convoId: Number(convoId), index, ord: ord || 1, ts: Date.now() };
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Back-compat thin wrapper (e.g. the one-off backfill pins ordinal-less rows).
export function writePersonaIndex(convoId, index, file = personaStorePath()) {
  writePersonaPin(convoId, index, 1, file);
}

// Compact the append-only pin log: keep only the LAST raw line per convoId
// (last-wins, so identity/ordinal/closed state are preserved) and atomically
// replace the file. Schema-agnostic (operates on raw lines). Bloat-gated by the
// caller so re-pins (backfill --force, closed markers) don't grow the file
// without bound while a hot read path re-parses it. Caller should hold the lock.
export function compactPersonaStore(file = personaStorePath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { compacted: false, before: 0, after: 0 }; }
  const lines = raw.split('\n').filter(Boolean);
  const lastByConvo = new Map();
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row && row.convoId != null) lastByConvo.set(String(row.convoId), line);
  }
  const before = lines.length;
  const after = lastByConvo.size;
  if (before <= after * 2 + 100) return { compacted: false, before, after }; // not bloated yet
  const body = [...lastByConvo.values()].join('\n') + '\n';
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return { compacted: true, before, after };
}

// READ-ONLY resolve: return the pinned persona if one exists, else the derived
// one (ord 1) — but NEVER write a pin. Use on display/inspection paths (handover
// lists, spawn --list, the persona.mjs whoami CLI) that must agree with the
// identity a convo already has (or will get) without mutating the store.
export function peekPersona(convoId, file = personaStorePath()) {
  if (convoId == null || convoId === '') return null;
  const pin = readPersonaPin(convoId, file);
  if (pin) return personaEntry(pin.index, pin.ord);
  const index = convoPersonaIndex(convoId);
  return index == null ? null : personaEntry(index, 1);
}

// ── Per-group name disambiguation (RFC 01, ext) ───────────────────────────────
// Goal: within ONE Telegram group, never show two OPEN topics with the SAME
// display name. Design (deliberately simple): the persona index is the PURE HASH
// — we never "dodge" to another persona — and collisions are resolved by a
// trailing ordinal only. When a new convo's hashed name is already shown by an
// OPEN topic in the group, it becomes "Bò 2", "Bò 3", … Topics in DIFFERENT
// groups (different chatId) may share a persona — never seen side by side, fine.
//
// What counts as occupying a name = an OPEN, live topic: present in topics-store
// under chatId with a positive thread id AND not in the chat's `_closed` set.
//   - CLOSED (via "Chào và đóng topic"): excluded — its topic is retitled with a
//     closed marker, so reusing its bare name is unambiguous.
//   - DELETED on Telegram: not detectable (no list API; sending into a deleted
//     topic is vanishingly rare) — we simply don't handle it. Worst case is one
//     stale name reserved until GC; never a wrong-looking duplicate.

// Whether a convo's topic in `entry` is marked CLOSED via a `_closed` set
// (`{ "<convoId>": true }`). Closed topics don't reserve their persona name.
//
// NOTE: no production path writes `_closed` TODAY. The wind-down/GC close paths
// (closeConvoTopic/gcDeadTopics) retitle the topic with the 🔒 marker and then
// DELETE its topics-store mapping — so a closed topic vanishes from the store
// and is excluded from occupancy because it's gone, not because of `_closed`.
// This hook is kept as forward-compat for a future "soft close that keeps the
// mapping"; it's exercised by unit tests but currently dead in production.
function isClosedInEntry(entry, convoId) {
  const c = entry && entry._closed;
  return !!(c && typeof c === 'object' && c[String(convoId)]);
}

// Group occupancy snapshot: the display names in use by OPEN (not-closed) live
// topics in `chatId`, excluding `exceptConvoId`. Used to decide whether a new
// convo's hashed persona name needs a disambiguating ordinal.
export function groupOccupancy(topicsStore, chatId, { exceptConvoId = null, file = personaStorePath(), pins = null } = {}) {
  const baseIndices = new Set();
  const names = new Set();
  const entry = topicsStore && topicsStore[String(chatId)];
  if (!entry || typeof entry !== 'object') return { baseIndices, names };
  const pinMap = pins || readAllPins(file);                  // single file read
  for (const [key, threadId] of Object.entries(entry)) {
    if (key.startsWith('_')) continue;                       // store metadata
    if (!(typeof threadId === 'number' && threadId > 0)) continue; // not a live topic
    if (exceptConvoId != null && String(key) === String(exceptConvoId)) continue;
    if (isClosedInEntry(entry, key)) continue;               // closed → frees its name
    const pin = pinMap.get(String(key));
    const index = pin ? pin.index : convoPersonaIndex(key);
    if (index == null) continue;
    const ord = pin ? pin.ord : 1;
    baseIndices.add(index);
    names.add(personaDisplayName(index, ord));
  }
  return { baseIndices, names };
}

// Coarse sync lock serialising the ordinal read-compute-write so two new convos
// in one group can't pick the same ordinal. Stronger than topics-store's
// age-only reap: we write `${ts}:${pid}` and only reap a stale lock when it is
// BOTH old AND owned by a dead pid (matches convo-registry.mjs), so a slow-but-
// alive holder is never stolen. Budget ~3s (like convo-registry) since this is
// a low-frequency first-touch write — blocking briefly beats failing open.
const LOCK_MAX_WAIT_MS = 3000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10_000;
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireLockSync(file) {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, `${Date.now()}:${process.pid}`);
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      // Reap only if BOTH stale by age AND the owning pid is dead.
      try {
        const [tsStr, pidStr] = fs.readFileSync(lockPath, 'utf8').trim().split(':');
        const ts = parseInt(tsStr, 10);
        const stale = !Number.isFinite(ts) || Date.now() - ts > LOCK_STALE_MS;
        if (stale && !pidAlive(parseInt(pidStr, 10))) { fs.unlinkSync(lockPath); continue; }
      } catch {}
      const until = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < until) { /* cheap busy wait */ }
    }
  }
  return null;
}
function releaseLockSync(lockPath) { if (lockPath) { try { fs.unlinkSync(lockPath); } catch {} } }

// Authoritative assignment: persona index is the PURE HASH (never "dodged"), so
// a convo's base identity is always derivable from its id alone. The ONLY group
// state is a disambiguating ordinal: on first touch, if the hashed name already
// belongs to an OPEN topic in this group, take the smallest free ordinal
// ("Bò 2", "Bò 3", …); otherwise ord 1 (bare name). Closed/deleted topics don't
// reserve a name (see groupOccupancy), so their persona is freely reused — the
// closed marker on their retitled topic keeps them visually distinct. Pins
// {index, ord} on first touch; stable forever after (fast path, no lock). This
// is THE writer — use it on the send path; readers use peekPersona. Without
// chatId/topicsStore it degrades to a plain hash pin (ord 1).
//
// ACCEPTED LIMITATION (product decision — keep it simple): occupancy is read
// from the topics-store snapshot, and a brand-new convo's topic isn't written
// there until AFTER its persona is resolved. So two NEW convos that hash to the
// SAME persona in the SAME group and first-touch at the very same moment can
// both land on the bare name (no ordinal) — a rare duplicate. We do NOT guard
// against this (it needs same group + same 1-in-110 hash + simultaneous first
// send). The base identity is always correct; at worst two topics briefly share
// a name and a human can rename one by hand. The lock below still serialises the
// far more common rapid-SEQUENTIAL case (an already-established topic IS in the
// snapshot), so that path dedups correctly.
export function resolvePersonaInGroup(convoId, { chatId = null, topicsStore = null, file = personaStorePath() } = {}) {
  if (convoId == null || convoId === '') return null;
  const pre = readPersonaPin(convoId, file);       // fast path: already pinned
  if (pre) return personaEntry(pre.index, pre.ord);
  const index = convoPersonaIndex(convoId);        // pure hash — no probe
  if (index == null) return null;

  const lock = acquireLockSync(file);
  try {
    const pinned = readPersonaPin(convoId, file);  // re-check under lock
    if (pinned) return personaEntry(pinned.index, pinned.ord);

    let ord = 1;
    if (chatId != null && topicsStore) {
      const { names } = groupOccupancy(topicsStore, chatId, { exceptConvoId: convoId, file });
      if (names.has(personaDisplayName(index, 1))) {
        ord = 2;
        while (names.has(personaDisplayName(index, ord))) ord++;
      }
    }
    try {
      writePersonaPin(convoId, index, ord, file);
    } catch (e) {
      // Best-effort: a failed pin means the next touch recomputes. The base
      // index is deterministic so identity holds, but an UNPERSISTED ordinal ≥2
      // could flicker — surface it (the rest of teleport logs best-effort fails).
      console.error(`[persona-store] WARNING: failed to persist pin for convo ${convoId} (index ${index}, ord ${ord}): ${e instanceof Error ? e.message : e}`);
    }
    try { compactPersonaStore(file); } catch { /* compaction is opportunistic */ }
    return personaEntry(index, ord);
  } finally {
    releaseLockSync(lock);
  }
}
