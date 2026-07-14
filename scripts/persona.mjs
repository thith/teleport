// Persona registry for Teleport agents (RFC 01).
//
// Each convo (agent session) is assigned a stable {emoji, name} "persona" so a
// team can address agents like members ("Cú ơi…") instead of remembering a
// numeric convoId. Assignment is DETERMINISTIC from convoId — `index =
// hash(convoId) % POOL.length` — so the SCRIPT owns the choice and the agent
// never has to "remember" or pick one (which historically biased every agent
// to 🦊 because LLMs have no real RNG).
//
// Leaf module re: INTERNAL deps AT LOAD TIME — it imports no other teleport
// script eagerly, so any script (send/listen/registry) can pull it in without
// circular-dependency risk. The two node: built-ins below are stdlib. The ONE
// teleport import (persona-store, which imports back into us) is LAZY — done
// inside the direct-run CLI guard only — so the cycle materialises after both
// modules are fully initialised, never at load. Do NOT add an eager teleport
// import here or you reintroduce the cycle.
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
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
  // ── Mở rộng pool 40 → 110 (RFC 01, ext). Vẫn append-only, nhưng vì
  // `mod = PERSONA_POOL.length` nên việc đổi length cũng đổi persona của các
  // convo ĐANG sống (h%40 ≠ h%110) — chấp nhận theo quyết định của PO.
  // Thú
  { emoji: '🐨', name: 'Gấu Túi' },
  { emoji: '🐭', name: 'Chuột' },
  { emoji: '🐹', name: 'Chuột Lang' },
  { emoji: '🦘', name: 'Chuột Túi' },
  { emoji: '🦥', name: 'Lười' },
  { emoji: '🦡', name: 'Lửng' },
  { emoji: '🦫', name: 'Hải Ly' },
  { emoji: '🦓', name: 'Ngựa Vằn' },
  { emoji: '🐃', name: 'Trâu' },
  { emoji: '🐫', name: 'Lạc Đà' },
  { emoji: '🐆', name: 'Báo' },
  { emoji: '🦧', name: 'Đười Ươi' },
  { emoji: '🦔', name: 'Nhím' },
  { emoji: '🦨', name: 'Chồn' },
  // Chim
  { emoji: '🦆', name: 'Vịt' },
  { emoji: '🦢', name: 'Thiên Nga' },
  { emoji: '🦜', name: 'Vẹt' },
  { emoji: '🦚', name: 'Công' },
  { emoji: '🦩', name: 'Hồng Hạc' },
  { emoji: '🕊️', name: 'Bồ Câu' },
  { emoji: '🦇', name: 'Dơi' },
  { emoji: '🦃', name: 'Gà Tây' },
  { emoji: '🪿', name: 'Ngỗng' },
  // Biển & bò sát
  { emoji: '🐠', name: 'Cá Vàng' },
  { emoji: '🐡', name: 'Cá Nóc' },
  { emoji: '🐳', name: 'Cá Voi' },
  { emoji: '🦭', name: 'Hải Cẩu' },
  { emoji: '🦐', name: 'Tôm' },
  { emoji: '🦞', name: 'Tôm Hùm' },
  { emoji: '🦀', name: 'Cua' },
  { emoji: '🦑', name: 'Mực' },
  { emoji: '🐌', name: 'Ốc Sên' },
  { emoji: '🪼', name: 'Sứa' },
  { emoji: '🐊', name: 'Cá Sấu' },
  { emoji: '🦎', name: 'Thằn Lằn' },
  // Côn trùng
  { emoji: '🐜', name: 'Kiến' },
  { emoji: '🦗', name: 'Châu Chấu' },
  { emoji: '🕷️', name: 'Nhện' },
  { emoji: '🦂', name: 'Bọ Cạp' },
  { emoji: '🦟', name: 'Muỗi' },
  { emoji: '🪳', name: 'Gián' },
  { emoji: '🪱', name: 'Giun' },
  // Cây & hoa
  { emoji: '🌳', name: 'Cổ Thụ' },
  { emoji: '🌲', name: 'Thông' },
  { emoji: '🌴', name: 'Dừa' },
  { emoji: '🌵', name: 'Xương Rồng' },
  { emoji: '🎋', name: 'Tre' },
  { emoji: '🌷', name: 'Tulip' },
  { emoji: '🌹', name: 'Hồng' },
  { emoji: '🌻', name: 'Hướng Dương' },
  { emoji: '🌼', name: 'Cúc' },
  { emoji: '🪷', name: 'Sen' },
  { emoji: '🍄', name: 'Nấm' },
  { emoji: '🌾', name: 'Lúa' },
  // Nhân hoá & huyền thoại
  { emoji: '🦖', name: 'Khủng Long' },
  { emoji: '🦕', name: 'Cổ Dài' },
  { emoji: '🧜', name: 'Tiên Cá' },
  { emoji: '🧚', name: 'Tiên' },
  { emoji: '🧞', name: 'Thần Đèn' },
  { emoji: '🧙', name: 'Phù Thủy' },
  { emoji: '🤖', name: 'Robot' },
  { emoji: '👽', name: 'Alien' },
  { emoji: '🧟', name: 'Thây Ma' },
  { emoji: '🦸', name: 'Siêu Nhân' },
  { emoji: '🦹', name: 'Ác Nhân' },
  { emoji: '🧛', name: 'Cà Rồng' },
  { emoji: '🧌', name: 'Quỷ Lùn' },
  { emoji: '🗿', name: 'Tượng Đá' },
  { emoji: '☃️', name: 'Người Tuyết' },
  { emoji: '🎃', name: 'Bí Ngô' },
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
  // Lazy import keeps persona.mjs a leaf at LOAD time (persona-store imports us);
  // the cycle only resolves here, on direct CLI run. peekPersona is READ-ONLY —
  // whoami reports the pinned persona (or the derived one) WITHOUT creating a
  // pin, so a mere "who am I?" never mutates the store. The authoritative pin is
  // written by the send/listen paths.
  const { peekPersona } = await import('./persona-store.mjs');
  const { convoId, source } = resolveConvoIdFromEnv();
  if (convoId == null) {
    console.error('[persona] no native session env (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID) — cannot resolve a persona for this agent.');
    process.exit(1);
  }
  const persona = peekPersona(convoId);
  console.log(formatPersona(persona)); // stdout: just "🐷 Heo" — easy to capture
  console.error(`[persona] convoId ${convoId} (via ${source}) → ${formatPersona(persona)} (index ${persona.index})`);
}

// Direct-run guard: compare RESOLVED paths, not a hand-built `file://` string —
// the latter mismatches on paths with spaces/Unicode (URL-encoded in
// import.meta.url, raw in argv) and on Windows, silently no-op'ing the CLI.
// Same idiom as send-telegram.mjs.
if (isMainModule(import.meta.url)) {
  runCli().catch((err) => { console.error(err); process.exit(1); });
}
