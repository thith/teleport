// session-name.mjs — persona / #hashtag → the live Claude session's NAME, the address for Claude
// Code's cross-session messages (`SendMessage to="<name>"`, listed by ListAgents).
//
//   node ../teleport/scripts/session-name.mjs Ma          → 👻 Ma #c2383556 → 📨 umipay-ae · PID 644406 · busy
//   node ../teleport/scripts/session-name.mjs '#c2383556'
//   node ../teleport/scripts/session-name.mjs Ma --name   → umipay-ae   (just the name, for scripts)
//
// Chain: persona (topics store) → #hashtag → the live claude process whose session hashes to it →
// `name` in ~/.claude/sessions/<pid>.json. A session name typed directly also matches.
// Exit: 0 = exactly one · 1 = none · 3 = several (pick by #hashtag).

import { isMainModule } from './is-direct-run.mjs';
import { listClaudeProcs } from './claude-procs.mjs';
import { personaByHashtag, normalizeAgentName } from './spawn.mjs';
import { formatPersona } from './persona.mjs';
import { shortConvoHash } from './convo-hash.mjs';

/**
 * Live sessions matching `query` — a persona name (emoji/case ignored), `#hashtag`, bare hashtag,
 * convoId, or the session name itself. `personaOf(hash)` → "👻 Ma" | null. Pure.
 */
export function resolveSessionNames(query, rows, personaOf = () => null) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  // `#abcd1234` / a convoId = a hashtag only; a bare 8-char word may be a hashtag OR a name ("elephant").
  const exact = /^#[0-9a-z]{8}$/i.test(q) ? q.slice(1).toLowerCase() : /^\d{9,}$/.test(q) ? shortConvoHash(q) : null;
  const bare = !exact && /^[0-9a-z]{8}$/i.test(q) ? q.toLowerCase() : null;
  const nq = normalizeAgentName(q);
  const byName = (r) => (r.persona && normalizeAgentName(r.persona) === nq) || normalizeAgentName(r.name) === nq;
  return rows
    .filter((r) => r.name)
    .map((r) => ({ ...r, persona: r.hashtag ? personaOf(r.hashtag) : null }))
    .filter((r) => (exact ? r.hashtag === exact : (bare && r.hashtag === bare) || byName(r)));
}

/** "👻 Ma #c2383556 → 📨 umipay-ae · PID 644406 · busy". Pure. */
export function formatMatch(r) {
  return `${[r.persona, r.hashtag ? `#${r.hashtag}` : null].filter(Boolean).join(' ') || '?'} → 📨 ${r.name} · PID ${r.pid}${r.status ? ` · ${r.status}` : ''}`;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const nameOnly = args.includes('--name');
  const query = args.filter((a) => a !== '--name').join(' ');
  if (!query || args.includes('-h') || args.includes('--help')) {
    console.log('usage: session-name.mjs <persona | #hashtag | convoId | session name> [--name]');
    process.exit(query ? 0 : 1);
  }
  let pmap = {};
  try { pmap = personaByHashtag(); } catch {}
  const hits = resolveSessionNames(query, listClaudeProcs(), (h) => (pmap[h] ? formatPersona(pmap[h]) : null));
  if (!hits.length) { console.error(`không thấy phiên Claude đang chạy cho "${query}" (agent đã tắt, hoặc chạy bằng Codex/Gemini — không có cross-session message)`); process.exit(1); }
  if (hits.length > 1) {
    console.error(`"${query}" khớp ${hits.length} phiên — chọn bằng #hashtag:`);
    for (const r of hits) console.error(`  ${formatMatch(r)}`);
    process.exit(3);
  }
  console.log(nameOnly ? hits[0].name : formatMatch(hits[0]));
}
