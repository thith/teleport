// One-time backfill (RFC 01, ext) — pin every PRE-EXISTING convo to the persona
// it had under the OLD 40-pair pool, so growing the pool to 110 doesn't change
// the identity of agents that are already running.
//
// Without this, a live convo with no pin row would MISS on its next send and be
// (re)assigned against the NEW pool length (h%110) — exactly the reshuffle we're
// trying to avoid. We seed its pin = h%40 = its last-seen persona.
//
// Source of "which convos exist" = convo-registry allocation rows (one per
// convo that ever sent). Idempotent: skips any convo already pinned, so re-runs
// are safe. Dead convos are harmless to pin (they never send again).
//
// --force overwrites an EXISTING pin when it points into the NEW pool region
// (index ≥ old-len) — i.e. a convo that already existed but got (re)pinned to a
// new-pool persona in the brief window between growing the pool and this
// backfill (the "race victim"). Pins already inside [0, old-len) are left as-is
// even with --force (they're already the old identity). This never touches a
// genuinely-new convo since those aren't in the OLD registry snapshot.
//
// CAVEAT: do NOT --force a race victim that has ALREADY self-identified under
// its new-pool persona to humans (e.g. "Nai" announced itself as "Tượng Đá").
// Reverting it would re-confuse the very people it just introduced itself to —
// the stability we want is broken either way, so keep the persona they already
// announced. --force is for victims caught before they spoke.
//
//   node backfill-persona.mjs [--dry] [--force] [--old-len 40]

import { readRows, DEFAULT_REGISTRY_FILE } from './convo-registry.mjs';
import { convoPersonaIndex, PERSONA_POOL } from './persona.mjs';
import { readPersonaIndex, writePersonaIndex, DEFAULT_PERSONA_STORE } from './persona-store.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const force = argv.includes('--force');
const oldLenIdx = argv.indexOf('--old-len');
const OLD_POOL_LEN = oldLenIdx >= 0 ? Number(argv[oldLenIdx + 1]) : 40;

if (!Number.isInteger(OLD_POOL_LEN) || OLD_POOL_LEN <= 0 || OLD_POOL_LEN > PERSONA_POOL.length) {
  console.error(`[backfill] bad --old-len ${OLD_POOL_LEN} (must be 1..${PERSONA_POOL.length})`);
  process.exit(2);
}

const { rows } = readRows(DEFAULT_REGISTRY_FILE);

// Unique convoIds from allocation rows (messageId === convoId).
const convoIds = new Set();
for (const row of rows) {
  if (typeof row.v === 'number' && row.v > 1) continue;
  if (Number.isInteger(row.convoId) && row.messageId === row.convoId) convoIds.add(row.convoId);
}

let pinned = 0, skipped = 0, forced = 0;
for (const convoId of convoIds) {
  const existing = readPersonaIndex(convoId, DEFAULT_PERSONA_STORE);
  const idx = convoPersonaIndex(convoId, OLD_POOL_LEN); // OLD modulus = last-seen persona
  const p = PERSONA_POOL[idx];
  if (existing != null) {
    // Already old-pool identity, or --force not set → leave it.
    if (!force || existing < OLD_POOL_LEN) { skipped++; continue; }
    // Race victim: existing pin is in the NEW pool region → revert to old.
    console.log(`[backfill] convo ${convoId} FORCE ${existing} → ${idx} (${p.emoji} ${p.name})${dry ? ' [dry]' : ''}`);
    if (!dry) writePersonaIndex(convoId, idx, DEFAULT_PERSONA_STORE);
    forced++;
    continue;
  }
  console.log(`[backfill] convo ${convoId} → index ${idx} (${p.emoji} ${p.name})${dry ? ' [dry]' : ''}`);
  if (!dry) writePersonaIndex(convoId, idx, DEFAULT_PERSONA_STORE);
  pinned++;
}

console.log(`[backfill] done: ${pinned} pinned, ${forced} forced-revert, ${skipped} skipped, ${convoIds.size} convos seen (old-len ${OLD_POOL_LEN})${dry ? ' [DRY RUN — nothing written]' : ''}`);
