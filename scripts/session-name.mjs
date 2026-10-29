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
import { makePersonaOf } from './spawn.mjs';
import { normalizeAgentName, parseAgentTarget, resolveTail } from './agent-target.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';

const tailLabel = (personaOf) => (x) => `${personaOf(x) || x.name || '?'} #${x.hashtag}`;
/** A tail query that matches several different hashtags → the refusal text, else null. Pure. */
export function tailConflict(query, rows, personaOf = () => null) {
  const t = parseAgentTarget(query);
  return t.kind === 'tail' ? (resolveTail(t.value, rows, tailLabel(personaOf)).error ?? null) : null;
}

/**
 * Live sessions matching `query` — a persona name (emoji/case ignored), `#hashtag`, bare hashtag, a
 * 3-digit tail (RFC 28: resolved over ALL live rows, named or not; several agents behind it → [], and
 * `tailConflict` says why), `convo:<id>`, a full convoId, or the session name itself.
 * `personaOf(row)` → "👻 Ma" | null (the row's own convo). Pure.
 */
export function resolveSessionNames(query, rows, personaOf = () => null) {
  let t = parseAgentTarget(query); // the shared reading (agent-target.mjs); a hashtag never falls back to names
  if (!t.value || t.kind === 'pid') return [];
  if (t.kind === 'tail') {
    const r = resolveTail(t.value, rows);
    if (r.error || r.none) return [];
    t = { kind: 'hashtag', value: r.hashtag };
  }
  const convo = t.kind === 'convoId' ? t.value : null; // a full convoId is compared in FULL (its hashtag is only the last digits)
  const exact = t.kind === 'hashtag' ? t.value : null;
  const nq = normalizeAgentName(t.value);
  const byName = (r) => (r.persona && normalizeAgentName(r.persona) === nq) || normalizeAgentName(r.name) === nq;
  return rows
    .filter((r) => r.name)
    .map((r) => ({ ...r, persona: r.hashtag ? personaOf(r) : null }))
    .filter((r) => (convo ? String(uuidToConvoInt(r.sessionId)) === convo
      : exact ? r.hashtag === exact : byName(r)));
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
    console.log('usage: session-name.mjs <persona | #hashtag | 3-digit tail | convoId | session name> [--name]');
    process.exit(query ? 0 : 1);
  }
  const procs = listClaudeProcs(), personaOf = makePersonaOf();
  const conflict = tailConflict(query, procs, personaOf);
  if (conflict) { console.error(conflict); process.exit(3); }
  const hits = resolveSessionNames(query, procs, personaOf);
  if (!hits.length) { console.error(`không thấy phiên Claude đang chạy cho "${query}" (agent đã tắt, hoặc chạy bằng Codex/Gemini — không có cross-session message)`); process.exit(1); }
  if (hits.length > 1) {
    console.error(`"${query}" khớp ${hits.length} phiên — chọn bằng #hashtag:`);
    for (const r of hits) console.error(`  ${formatMatch(r)}`);
    process.exit(3);
  }
  console.log(nameOnly ? hits[0].name : formatMatch(hits[0]));
}
