// Shared core for the "steer" daemon commands — `/whisper` (discreet) and
// `/instruct` (official, reply-via-DM). Both inject a prompt into a LIVE topic
// (nothing posted in the group) and differ only in a prompt flag + ack wording;
// everything else — target resolution, reply-to-target (RFC 07), enriched ack —
// is identical, so it lives here (RFC 13 §4). `whisper.mjs`/`instruct.mjs` are
// thin wrappers that pass `{ flag, usage, ack }`.
import path from 'node:path';
import { readTopicsStore } from './topics-store.mjs';
import { listSteerableTargets, normalizeTarget, matchTarget } from './handover.mjs';
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

// Build the injected prompt. `flag` ('whisper' | 'instruct') is set true to mark
// the mode; `messageId:null` marks it injected (not a real Telegram message).
export function buildSteerPrompt({ targetConvoId, targetChatId, fromUserId, fromName, fromRole, text, flag }) {
  const prompt = {
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
  return { error: usage };
}

// Core: resolve target, inject the prompt, return an ack. Deps injectable for
// tests. `mode` = { flag, usage, ack } where `ack({ label, hash, convoId })`
// returns the success string. `replyText` defaults to TELE_REPLY_TEXT (the
// daemon injects the replied-to message text for `wantsReplyText` commands).
export async function doSteer(argv, { flag, usage, ack }, {
  from = {}, config = readProjectsConfig(), store = readTopicsStore(),
  tmpDir = DEFAULT_TMP_DIR, writePrompt = durableWrite, replyText = process.env.TELE_REPLY_TEXT,
} = {}) {
  // RFC 14: steerable = live topics ∪ live-but-topic-less convos (DM-only
  // sessions), so `/instruct #hash` reaches a session that only DM'd the owner.
  const live = listSteerableTargets(store, groupChatIds(config));
  const r = resolveSteerTarget(argv, { live, replyText, usage });
  if (r.error) return { ok: false, message: r.error };
  if (!r.text) return { ok: false, message: `${flag} cần nội dung sau target.` };
  const { convoId, chatId } = r.match;
  const prompt = buildSteerPrompt({
    targetConvoId: convoId, targetChatId: chatId,
    fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text: r.text, flag,
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
