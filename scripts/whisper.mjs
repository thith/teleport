// `/whisper #<hash> <text>` — a daemon command (no project). Injects a DISCREET
// steer into a live topic: nothing is posted in the group; the target agent
// picks it up as a prompt with `whisper:true` + the whisperer's real role (so its
// sensitive-action gate still applies). Identity comes from the daemon via env
// (TELE_FROM_*). Prints a confirmation to stdout for the daemon to relay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTopicsStore } from './topics-store.mjs';
import { listLiveTopics, normalizeTarget, matchTarget, writePromptExclusive } from './handover.mjs';
import { DEFAULT_TMP_DIR } from './tele-listen.mjs';
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
// NB: a hashtag is 1:1 with a convoId, so a reply hash can't be "shadowed"/ambiguous
// across topics the way a reused persona NAME can — only `status:'found'` matters.
export function targetFromReply(replyText, live) {
  if (!replyText) return null;
  const hashes = String(replyText).slice(0, REPLY_TEXT_MAX).match(/#[A-Za-z0-9]+/g) || [];
  for (const h of hashes) {
    const m = matchTarget(normalizeTarget(h), live);
    if (m.status === 'found') return m.match; // { convoId, chatId }
  }
  return null;
}

// Build the injected prompt. `whisper:true` marks it discreet; `messageId:null`
// marks it injected (not a real Telegram message).
export function buildWhisperPrompt({ targetConvoId, targetChatId, fromUserId, fromName, fromRole, text }) {
  return {
    text,
    messageId: null,
    chatId: targetChatId == null ? null : String(targetChatId),
    fromUserId: fromUserId == null || fromUserId === '' ? null : String(fromUserId),
    fromName: fromName || 'admin',
    fromRole: fromRole || 'member',
    fromMember: null,
    replyToMessageId: null,
    replyToText: null,
    quotedText: null,
    timestamp: Math.floor(Date.now() / 1000),
    attachments: [],
    convoId: Number(targetConvoId),
    whisper: true,
  };
}

// All group chat ids (catch-all + dedicated) to search for the live topic.
function groupChatIds(config) {
  const ids = new Set();
  const def = resolveDefaultChatId(config, { env: process.env, envFile: {} });
  if (def) ids.add(String(def));
  for (const [, p] of projectEntries(config)) if (p && p.chatId) ids.add(String(p.chatId));
  return [...ids];
}

const USAGE = 'usage: /whisper #<hash|persona|convoId> <text>  (hoặc reply tin whisper trước rồi gõ /whisper <text>)';

// Resolve the target + the message text from argv, with reply context. Precedence
// (RFC 07 §2.1, airtight): 1) argv[0] starts with `#` → explicit hash (fail =
// hard error); 2) reply mode (reply has a resolvable hash) → ALL argv is text,
// no convoId/persona detection on argv[0]; 3) non-reply convoId (all-digits);
// 4) non-reply persona-name. Returns { match, text } or { error }.
export function resolveWhisperTarget(argv, { live, replyText }) {
  const a0 = argv[0];
  const fail = (t, status) => ({ error: `target ${t} ${status === 'ambiguous' ? 'is ambiguous' : 'not found among live topics'}.` });

  if (a0 && a0.startsWith('#')) {
    const m = matchTarget(normalizeTarget(a0), live);
    if (m.status !== 'found') return fail(a0, m.status); // hard error — never fall to reply
    return { match: m.match, text: argv.slice(1).join(' ').trim() };
  }
  const replyMatch = targetFromReply(replyText, live);
  if (replyMatch) return { match: replyMatch, text: argv.join(' ').trim() }; // ALL argv = text
  if (a0) {
    const m = matchTarget(normalizeTarget(a0), live); // non-reply: convoId or persona-name
    if (m.status !== 'found') return fail(a0, m.status);
    return { match: m.match, text: argv.slice(1).join(' ').trim() };
  }
  return { error: USAGE };
}

// Returns { ok, message }. Pure-ish (deps injectable for tests). `replyText`
// defaults to TELE_REPLY_TEXT (the daemon injects the replied-to message text).
export function doWhisper(argv, { from = {}, config = readProjectsConfig(), store = readTopicsStore(), tmpDir = DEFAULT_TMP_DIR, writePrompt = writePromptExclusive, replyText = process.env.TELE_REPLY_TEXT } = {}) {
  const live = listLiveTopics(store, groupChatIds(config));
  const r = resolveWhisperTarget(argv, { live, replyText });
  if (r.error) return { ok: false, message: r.error };
  if (!r.text) return { ok: false, message: 'whisper needs a message after the target' };
  const { convoId, chatId } = r.match;
  const prompt = buildWhisperPrompt({
    targetConvoId: convoId, targetChatId: chatId,
    fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text: r.text,
  });
  const promptFile = path.join(tmpDir, `prompt-convo-${convoId}.json`);
  try {
    writePrompt(prompt, promptFile);
  } catch (e) {
    if (e && e.code === 'EEXIST') return { ok: false, message: `#${shortConvoHash(convoId)} đang bận (prompt trước chưa xử lý) — thử lại sau.` };
    throw e;
  }
  // Enriched ack: persona (primary identity) + project (best-effort, omit if unsure).
  const persona = personaForConvo(convoId);
  const project = projectLabelForChat(chatId, config);
  const who = persona ? `${persona.emoji} ${persona.name} #${shortConvoHash(convoId)}` : `#${shortConvoHash(convoId)}`;
  const label = `${who}${project ? ` · ${project}` : ''}`;
  return { ok: true, message: `🤫 whispered to ${label} (kín, không hiện trong group).` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const from = { id: process.env.TELE_FROM_ID, role: process.env.TELE_FROM_ROLE, name: process.env.TELE_FROM_NAME };
  const res = doWhisper(process.argv.slice(2), { from }); // replyText from TELE_REPLY_TEXT
  process.stdout.write((res.message || '') + '\n');
  process.exit(res.ok ? 0 : 1);
}
