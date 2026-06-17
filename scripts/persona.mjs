// Persona registry for Teleport agents (RFC 01).
//
// Each convo (agent session) is assigned a stable {emoji, name} "persona" so a
// team can address agents like members ("Cú ơi…") instead of remembering a
// numeric convoId. Assignment is DETERMINISTIC from convoId — `index =
// hash(convoId) % POOL.length` — so the SCRIPT owns the choice and the agent
// never has to "remember" or pick one (which historically biased every agent
// to 🦊 because LLMs have no real RNG).
//
// Leaf module re: INTERNAL deps — it imports no other teleport script, so any
// script (send/listen/registry) can pull it in without circular-dependency
// risk. The two node: built-ins below are stdlib (used only by the direct-run
// CLI guard at the bottom), not internal deps, so they don't break that.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 40 pairs. Names ≤ 2 words, all unique; emoji all unique. Curated so visually
// distinct personas don't collide in a busy group. Order is load-bearing:
// `index` maps positionally, so APPENDING is safe but reordering/removing
// reshuffles existing convo→persona assignments. Add new entries at the END.
export const PERSONA_POOL = [
  { emoji: '🦊', name: 'Cáo' },
  { emoji: '🦉', name: 'Cú' },
  { emoji: '🐼', name: 'Trúc' },
  { emoji: '🦝', name: 'Mèo Rừng' },
  { emoji: '🦦', name: 'Rái' },
  { emoji: '🐻', name: 'Gấu' },
  { emoji: '🐯', name: 'Hổ' },
  { emoji: '🦁', name: 'Sư Tử' },
  { emoji: '🐺', name: 'Sói' },
  { emoji: '🦅', name: 'Đại Bàng' },
  { emoji: '🐢', name: 'Rùa' },
  { emoji: '🦛', name: 'Hà Mã' },
  { emoji: '🦒', name: 'Hươu' },
  { emoji: '🐙', name: 'Tuộc' },
  { emoji: '🦈', name: 'Cá Mập' },
  { emoji: '🐬', name: 'Cá Heo' },
  { emoji: '🐷', name: 'Heo' },
  { emoji: '🐰', name: 'Thỏ' },
  { emoji: '🐱', name: 'Mèo' },
  { emoji: '🐶', name: 'Cún' },
  { emoji: '🐮', name: 'Bò' },
  { emoji: '🐴', name: 'Ngựa' },
  { emoji: '🐗', name: 'Lợn Lòi' },
  { emoji: '🐸', name: 'Ếch' },
  { emoji: '🐵', name: 'Khỉ' },
  { emoji: '🐔', name: 'Gà' },
  { emoji: '🐧', name: 'Cánh Cụt' },
  { emoji: '🦌', name: 'Nai' },
  { emoji: '🐘', name: 'Voi' },
  { emoji: '🦏', name: 'Tê Giác' },
  { emoji: '🐍', name: 'Rắn' },
  { emoji: '🐉', name: 'Rồng' },
  { emoji: '👻', name: 'Ma' },
  { emoji: '🤡', name: 'Hề' },
  { emoji: '🦋', name: 'Bướm' },
  { emoji: '🐛', name: 'Sâu' },
  { emoji: '🦠', name: 'Khuẩn' },
  { emoji: '🐝', name: 'Ong' },
  { emoji: '🐞', name: 'Bọ Rùa' },
  { emoji: '🦄', name: 'Kỳ Lân' },
];

/**
 * Deterministic index in [0, mod) from a convoId. FNV-1a over the decimal
 * string of convoId — stable across processes and Node versions (no reliance
 * on Math.random / Date.now, both of which are unavailable in some agent
 * runtimes). Returns null when convoId is null/empty (caller has no persona
 * yet — e.g. brand-new convo whose id isn't resolved).
 */
export function convoPersonaIndex(convoId, mod = PERSONA_POOL.length) {
  if (convoId == null || convoId === '') return null;
  const s = String(convoId);
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % mod;
}

/**
 * Resolve the persona for a convoId. Returns `{ emoji, name, index }` or null
 * when no convoId is available.
 */
export function personaForConvo(convoId) {
  const index = convoPersonaIndex(convoId);
  if (index == null) return null;
  return { ...PERSONA_POOL[index], index };
}

/** Render a persona as the display token used in message prefixes: "🦉 Cú". */
export function formatPersona(persona) {
  if (!persona) return '';
  return `${persona.emoji} ${persona.name}`;
}

// CLI "whoami" (RFC 04): `node persona.mjs` resolves THIS agent's persona from
// its native session env (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID) and prints
// it, so an agent can learn the name it answers to without hand-writing an
// inline import. convo-registry (NOT a leaf — pulls in fs etc.) is imported
// lazily only on direct run so the export surface stays free of INTERNAL
// imports (leaf-module invariant — avoids the send/listen ↔ persona cycle).
async function runCli() {
  const { resolveConvoIdFromEnv } = await import('./convo-registry.mjs');
  const { convoId, source } = resolveConvoIdFromEnv();
  if (convoId == null) {
    console.error('[persona] no native session env (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID) — cannot resolve a persona for this agent.');
    process.exit(1);
  }
  const persona = personaForConvo(convoId);
  console.log(formatPersona(persona)); // stdout: just "🐷 Heo" — easy to capture
  console.error(`[persona] convoId ${convoId} (via ${source}) → ${formatPersona(persona)} (index ${persona.index})`);
}

// Direct-run guard: compare RESOLVED paths, not a hand-built `file://` string —
// the latter mismatches on paths with spaces/Unicode (URL-encoded in
// import.meta.url, raw in argv) and on Windows, silently no-op'ing the CLI.
// Same idiom as send-telegram.mjs.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch((err) => { console.error(err); process.exit(1); });
}
