// Shared core for the "steer" daemon commands — `/whisper` (discreet) and
// `/instruct` (official, reply-via-DM). Both inject a prompt into a LIVE topic
// (nothing posted in the group) and differ only in a prompt flag + ack wording;
// everything else — target resolution, reply-to-target (RFC 07), enriched ack —
// is identical, so it lives here (RFC 13 §4). `whisper.mjs`/`instruct.mjs` are
// thin wrappers that pass `{ flag, usage, ack }`.
import path from 'node:path';
import { readTopicsStore } from './topics-store.mjs';
import { listSteerableTargets, normalizeTarget, matchTarget } from './handover.mjs';
import { normalizeAgentName } from './agent-target.mjs';
import { DEFAULT_TMP_DIR, mergeOrSpoolPrompt } from './tele-listen.mjs';

// RFC 03 §5.1 — default durable write: coalesce/spool into the target's OPEN prompt
// under the per-convo write-lock (replaces O_EXCL writePromptExclusive). A busy
// target no longer bounces EEXIST — the steer message is queued durably. Keeps the
// (promptObj, promptFile) signature so injected test writers stay compatible.
export async function durableWrite(promptObj, promptFile) {
  const lock = path.join(path.dirname(promptFile), `prompt-write-${promptObj.convoId}.lock`);
  await mergeOrSpoolPrompt(promptFile, promptObj, lock);
}
import { shortConvoHash } from './send-telegram.mjs';
import { readProjectsConfig, resolveDefaultChatId, projectEntries } from './projects-config.mjs';
import { personaForConvo } from './persona.mjs';

// Cap on the replied-to text we accept (arbitrary user-controlled; we ONLY scan
// it for a target hash — RFC 07 §2.1 auth invariant). 256 UTF-16 code units; a
// split surrogate is harmless here since we only match the ASCII `#[A-Za-z0-9]+`.
export const REPLY_TEXT_MAX = 256;

// Reverse chatId → a project label for the ack: the unique `code` (or key) when
// exactly one project maps to this group; `group <chatId>` when several share it
// (don't imply one false project); null when none (omit from ack).
export function projectLabelForChat(chatId, config) {
  const codes = [];
  for (const [key, p] of projectEntries(config)) {
    if (p && p.chatId != null && String(p.chatId) === String(chatId)) {
      codes.push((typeof p.code === 'string' && p.code.trim()) ? p.code.trim() : key);
    }
  }
  if (codes.length === 1) return codes[0];
  if (codes.length > 1) return `group ${chatId}`;
  return null;
}

// First `#hash` in `replyText` that RESOLVES to a live topic (skip dead ones —
// RFC 07 §2.1/D2). Used ONLY to pick a target; never read for role/sender/command.
// NB: only `status:'found'` is honoured. A hashtag is NOT 1:1 with a convoId
// (`shortConvoHash` keeps the last 8 digits only), so two live convos CAN share
// one — matchTarget reports that as `ambiguous` and we skip it rather than steer a
// PRIVATE whisper/instruct at a coin-flip target.
export function targetFromReply(replyText, live) {
  if (!replyText) return null;
  const hashes = String(replyText).slice(0, REPLY_TEXT_MAX).match(/#[A-Za-z0-9]+/g) || [];
  for (const h of hashes) {
    const m = matchTarget(normalizeTarget(h), live);
    if (m.status === 'found') return m.match; // { convoId, chatId }
    // A COLLIDING hash must stop the scan, not be skipped: continuing would let a
    // later hash in the same text receive a steer meant for the ambiguous one —
    // i.e. a private instruction delivered to a different agent (Codex review).
    // Return the ambiguity rather than null, so the CALLER can say so: a bare null
    // reads as "the reply named nobody" and makes resolveSteerTarget fall back to
    // treating the first WORD of the command as a target name — the owner would
    // get `target làm not found among live topics` for `/whisper làm tiếp`
    // (Gemini review).
    if (m.status === 'ambiguous') return { ambiguous: h, candidates: m.candidates };
  }
  return null;
}

// Build the injected prompt. `flag` ('whisper' | 'instruct') is set true to mark
// the mode; `messageId:null` marks it injected (not a real Telegram message).
export function buildSteerPrompt({ targetConvoId, targetChatId, fromUserId, fromName, fromRole, text, flag, replyToMessageId = null }) {
  // `replyToMessageId` = the sender's original command message (their DM where
  // they typed /instruct|/whisper). Lets kind-aware reply routing thread the
  // agent's reply under it in the sender's DM. `messageId:null` still marks the
  // prompt as injected (not itself a real inbound Telegram message).
  const rtmid = replyToMessageId == null || replyToMessageId === '' ? null : Number(replyToMessageId);
  const prompt = {
    text,
    messageId: null,
    chatId: targetChatId == null ? null : String(targetChatId),
    fromUserId: fromUserId == null || fromUserId === '' ? null : String(fromUserId),
    fromName: fromName || 'admin',
    fromRole: fromRole || 'member',
    fromMember: null,
    replyToMessageId: Number.isFinite(rtmid) ? rtmid : null,
    replyToText: null,
    quotedText: null,
    timestamp: Math.floor(Date.now() / 1000),
    attachments: [],
    convoId: Number(targetConvoId),
  };
  if (flag) prompt[flag] = true;
  return prompt;
}

// All group chat ids (catch-all + dedicated) to search for the live topic.
export function groupChatIds(config) {
  const ids = new Set();
  const def = resolveDefaultChatId(config, { env: process.env, envFile: {} });
  if (def) ids.add(String(def));
  for (const [, p] of projectEntries(config)) if (p && p.chatId) ids.add(String(p.chatId));
  return [...ids];
}

// Resolve the target + the message text from argv, with reply context. Precedence
// (RFC 07 §2.1, airtight): 1) argv[0] starts with `#` → explicit hash (fail =
// hard error); 2) reply mode (reply has a resolvable hash) → ALL argv is text,
// no convoId/persona detection on argv[0]; 3) non-reply convoId (all-digits);
// 4) non-reply persona-name. Returns { match, text } or { error }.
export function resolveSteerTarget(argv, { live, replyText, usage }) {
  const a0 = argv[0];
  const fail = (t, status) => ({ error: `target ${t} ${status === 'ambiguous' ? 'is ambiguous' : 'not found among live topics'}.` });
  // Names go through matchSteerName (two persona topics with one name → refuse); # / convoId stay exact.
  const find = (t) => (t.kind === 'name' ? matchSteerName(t.value, live) : matchTarget(t, live));

  if (a0 && a0.startsWith('#')) {
    const m = find(normalizeTarget(a0));
    if (m.status !== 'found') return fail(a0, m.status); // hard error — never fall to reply
    return { match: m.match, text: argv.slice(1).join(' ').trim() };
  }
  const replyMatch = targetFromReply(replyText, live);
  if (replyMatch?.ambiguous) return fail(replyMatch.ambiguous, 'ambiguous');   // say WHY, don't guess
  if (replyMatch) return { match: replyMatch, text: argv.join(' ').trim() };   // ALL argv = text
  if (a0) {
    const m = find(normalizeTarget(a0)); // non-reply: convoId or persona-name
    if (m.status !== 'found') return fail(a0, m.status);
    return { match: m.match, text: argv.slice(1).join(' ').trim() };
  }
  return { error: usage };
}

// Quotes that may wrap a multi-word target (RFC 26 §3.8): ASCII and the phone's curly ones.
const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '‘': '’' };

/**
 * The raw command text (TELE_RAW_ARGS) → its first token and the rest VERBATIM (quotes, newlines,
 * inner spaces kept). A token opening with a quote runs to the matching close quote — none → error,
 * never a guess. → { token, quoted, text } | { error }. Pure.
 */
export function splitRawTarget(raw) {
  const s = String(raw ?? '').replace(/^\s+/, '');
  if (!s) return { token: '', quoted: false, text: '' };
  const close = QUOTE_PAIRS[s[0]];
  if (close) {
    const end = s.indexOf(close, 1);
    if (end === -1) return { error: `thiếu dấu đóng ${close} cho tên đích.` };
    return { token: s.slice(1, end).trim(), quoted: true, text: s.slice(end + 1).trim() };
  }
  const m = s.match(/^(\S+)([\s\S]*)$/);
  return { token: m[1], quoted: false, text: m[2].trim() };
}

/**
 * A persona name → one live topic (RFC 26 §3.8): tier 1 literal (case-insensitive, leading emoji
 * off), tier 2 normalized (`_` = space); the first tier with a hit decides. Two DIFFERENT convos →
 * ambiguous (a private /w, /i must never pick the newest). Alive-only rows never match by name. Pure.
 */
export function matchSteerName(value, live) {
  const pool = live.filter((t) => t.source !== 'alive' && t.persona && t.persona.name);
  const strip = (s) => String(s).trim().replace(/^[^\p{L}\p{N}]+\s*/u, '').toLowerCase();
  const lit = strip(value), norm = normalizeAgentName(value);
  let hits = pool.filter((t) => strip(t.persona.name) === lit);
  if (!hits.length) hits = pool.filter((t) => normalizeAgentName(t.persona.name) === norm);
  if (!hits.length) return { status: 'not_found' };
  const sorted = [...hits].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (new Set(hits.map((h) => String(h.convoId))).size > 1) return { status: 'ambiguous', candidates: sorted };
  return { status: 'found', match: sorted[0] };
}

/**
 * resolveSteerTarget over the RAW text (the daemon's TELE_RAW_ARGS): same precedence — an unquoted
 * `#…` first token is explicit; else a reply with a hashtag → ALL of it is text (quotes, `_` mean
 * nothing); else the first token (quoted or not) is the target. The text keeps its quotes/newlines.
 */
export function resolveSteerTargetRaw(raw, { live, replyText, usage }) {
  const sp = splitRawTarget(raw);
  const fail = (t, status, cands) => ({ error: `target ${t} ${status === 'ambiguous' ? `is ambiguous${cands?.length ? ` (${cands.map((c) => `#${c.hashtag}`).join(', ')}) — dùng #hashtag` : ''}` : 'not found among live topics'}.` });
  const find = (tok) => {
    const t = normalizeTarget(tok);
    return t.kind === 'name' ? matchSteerName(t.value, live) : matchTarget(t, live);
  };
  if (!sp.error && !sp.quoted && sp.token.startsWith('#')) {
    const m = find(sp.token);
    return m.status === 'found' ? { match: m.match, text: sp.text } : fail(sp.token, m.status, m.candidates);
  }
  const replyMatch = targetFromReply(replyText, live);
  if (replyMatch?.ambiguous) return fail(replyMatch.ambiguous, 'ambiguous');
  if (replyMatch) return { match: replyMatch, text: String(raw).trim() };
  if (sp.error) return { error: sp.error }; // an unclosed quote only matters when it names the target
  if (sp.token) {
    const m = find(sp.token);
    return m.status === 'found' ? { match: m.match, text: sp.text } : fail(sp.quoted ? `"${sp.token}"` : sp.token, m.status, m.candidates);
  }
  return { error: usage };
}

// Core: resolve target, inject the prompt, return an ack. Deps injectable for
// tests. `mode` = { flag, usage, ack } where `ack({ label, hash, convoId })`
// returns the success string. `replyText` defaults to TELE_REPLY_TEXT (the
// daemon injects the replied-to message text for `wantsReplyText` commands).
export async function doSteer(argv, { flag, usage, ack }, {
  from = {}, config = readProjectsConfig(), store = readTopicsStore(),
  tmpDir = DEFAULT_TMP_DIR, writePrompt = durableWrite, replyText = process.env.TELE_REPLY_TEXT,
  raw = process.env.TELE_RAW_ARGS, // the daemon's untokenized text (rawText commands); unset/'' → argv
} = {}) {
  // RFC 14: steerable = live topics ∪ live-but-topic-less convos (DM-only
  // sessions), so `/instruct #hash` reaches a session that only DM'd the owner.
  const live = listSteerableTargets(store, groupChatIds(config));
  const r = raw ? resolveSteerTargetRaw(raw, { live, replyText, usage }) : resolveSteerTarget(argv, { live, replyText, usage });
  if (r.error) return { ok: false, message: r.error };
  if (!r.text) return { ok: false, message: `${flag} cần nội dung sau target.` };
  const { convoId, chatId } = r.match;
  const prompt = buildSteerPrompt({
    targetConvoId: convoId, targetChatId: chatId,
    fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text: r.text, flag,
    replyToMessageId: from.messageId,
  });
  const promptFile = path.join(tmpDir, `prompt-convo-${convoId}.json`);
  // RFC 03 §5.1: durable coalesce/spool — a busy target no longer bounces (no EEXIST).
  await writePrompt(prompt, promptFile);
  // Enriched ack: persona (primary identity) + project (best-effort, omit if unsure).
  const persona = personaForConvo(convoId);
  const project = projectLabelForChat(chatId, config);
  const hash = shortConvoHash(convoId);
  const who = persona ? `${persona.emoji} ${persona.name} #${hash}` : `#${hash}`;
  const label = `${who}${project ? ` · ${project}` : ''}`;
  return { ok: true, message: ack({ label, hash, convoId }) };
}
