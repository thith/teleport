#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireLock as acquireConvoLock,
  appendRowLocked as appendConvoRow,
  buildConvoFilter,
  CONVO_ID_RE,
  CONVO_SCHEMA_VERSION,
  DEFAULT_LOCK_FILE as CONVO_LOCK_FILE,
  DEFAULT_REGISTRY_FILE as CONVO_REGISTRY_FILE,
  hasAllocationRow,
  lookupConvoIdByMessageId,
  pruneLocked as pruneConvoRegistry,
  resolveConvoIdFromEnv,
  readRows as readConvoRows,
  REGISTRY_CAP as CONVO_REGISTRY_CAP,
  releaseLock as releaseConvoLock,
  validateConvoIdString,
} from './convo-registry.mjs';
import {
  clearThreadId,
  getThreadId,
  readTopicsStore,
  recordThreadId,
  updateTopicsStore,
  writeTopicsStore,
} from './topics-store.mjs';
import {
  recordBotSend,
  updatePendingStore,
} from './pending-store.mjs';
import { CONVO_HASH_LONG_LEN, shortConvoHash as _shortConvoHash } from './convo-hash.mjs';
import { formatPersona, personaForConvo } from './persona.mjs';
import { resolvePersonaInGroup, peekPersona } from './persona-store.mjs';
import { readProjectsConfig, resolveProjectConfig, adminIdsFrom, resolveDefaultChatId, resolveDaemonUserId, assertChatIdKind } from './projects-config.mjs';

// Re-export so existing imports of `shortConvoHash` from send-telegram keep
// working. Logic now lives in convo-hash.mjs (leaf, no circular deps).
export { CONVO_HASH_LONG_LEN } from './convo-hash.mjs';
export const shortConvoHash = _shortConvoHash;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const TELEGRAM_API = 'https://api.telegram.org/bot';
const SENT_REGISTRY_FILE = path.join(__dirname, 'tmp', 'tele-reply', 'sent-registry.jsonl');
const TELE_REPLY_DIR = path.join(__dirname, 'tmp', 'tele-reply');

// RFC 02 P1: auto-consume. After a successful send into a convo, delete that
// convo's CLAIMED prompt (`prompt-convo-N.processing.json`) so the agent never
// manually `rm`. Deletes ONLY the `.processing.json` (a claimed batch), NEVER
// the bare `prompt-convo-N.json` (the OPEN inbox — dropping it would lose
// unhandled messages). No-op when the convo was not claimed (Gemini/Codex, or a
// proactive/status send create no `.processing.json`) → those flows unchanged
// (the G4 firewall). Best-effort; returns true if it consumed something.
export function autoConsumeClaimedPrompt(convoId, tmpDir = TELE_REPLY_DIR) {
  if (convoId == null) return false;
  const processingFile = path.join(tmpDir, `prompt-convo-${convoId}.processing.json`);
  try {
    if (fs.existsSync(processingFile)) { fs.rmSync(processingFile, { force: true }); return true; }
  } catch { /* best-effort */ }
  return false;
}

export function extractBotId(token) {
  if (!token || typeof token !== 'string') return null;
  const head = token.split(':')[0];
  if (!/^\d+$/.test(head)) return null;
  return Number(head);
}

// Telegram limits: sendMessage 4096 chars, sendDocument caption 1024 chars.
// We chunk below the hard limits to leave headroom for escape-expansion.
const MESSAGE_CHUNK_LIMIT = 4000;
const CAPTION_LIMIT = 1024;

export function loadEnvFromFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;

  const fileContent = fs.readFileSync(filePath, 'utf8');
  fileContent.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!match) return;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  });

  return result;
}

export function parseAdminChatIds(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Append a convo-registry row for one successful send. Caller MUST hold (or
 * obtain) the lock around its own append+prune block; this helper does both
 * acquire+release for one append because callers don't otherwise interact
 * with the registry inside the loop. If the lock can't be acquired within
 * the retry budget the caller is told (return value `false`) and decides
 * whether to surface a repair hint.
 */
// Record one send into the convo-registry. `convoId` is REQUIRED (resolved
// from the env chain or --convo by the caller). First use on a given
// (botId, chatId, convoId) auto-writes the allocation row.
// Returns the resolved convoId (so the caller can echo it on stdout).
export async function recordConvoSend({ convoId, messageId, chatId, botId }, registryFile = CONVO_REGISTRY_FILE, lockFile = CONVO_LOCK_FILE) {
  if (convoId == null) throw new Error('recordConvoSend: convoId is required');
  const acquired = await acquireConvoLock(lockFile);
  if (!acquired) return { ok: false, reason: 'lock-timeout' };
  try {
    const { rows } = readConvoRows(registryFile);
    const resolved = convoId;
    if (!hasAllocationRow(rows, resolved, botId, String(chatId))) {
      // First send for this convo on this chat — write the allocation row.
      appendConvoRow(
        { v: CONVO_SCHEMA_VERSION, convoId: resolved, messageId: resolved, chatId: String(chatId), botId, ts: Date.now() },
        registryFile,
      );
    }
    if (messageId !== resolved) {
      // Dedupe against an existing (botId, chatId, messageId) row to avoid
      // bloating the registry on retried/replayed sends (e.g. after
      // `import-convo --all` re-runs the recovery sweep).
      const chatStr = String(chatId);
      const dup = rows.some((r) =>
        (typeof r.v !== 'number' || r.v <= CONVO_SCHEMA_VERSION)
        && r.botId === botId && String(r.chatId) === chatStr && r.messageId === messageId,
      );
      if (!dup) {
        appendConvoRow(
          { v: CONVO_SCHEMA_VERSION, convoId: resolved, messageId, chatId: String(chatId), botId, ts: Date.now() },
          registryFile,
        );
      }
    }
    return { ok: true, convoId: resolved, shouldPrune: rows.length >= CONVO_REGISTRY_CAP };
  } finally {
    releaseConvoLock(lockFile);
  }
}

// Run prune out-of-band: caller drops the recordConvoSend lock first, then we
// reacquire briefly to do the read+rewrite. Bounds lock-hold time per send to
// "one append" instead of "one append + full prune".
async function pruneAfterSend(registryFile = CONVO_REGISTRY_FILE, lockFile = CONVO_LOCK_FILE) {
  const acquired = await acquireConvoLock(lockFile);
  if (!acquired) return; // skip silently; next send will retry
  try { pruneConvoRegistry(registryFile); }
  catch (e) {
    console.error(`[send-telegram] convo-registry prune failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    releaseConvoLock(lockFile);
  }
}

export function appendToSentRegistry({ messageId, chatId, botId = null, convoId = null, registryFile = SENT_REGISTRY_FILE }) {
  if (!messageId) return;
  const dir = path.dirname(registryFile);
  fs.mkdirSync(dir, { recursive: true });
  const row = { v: 1, messageId, chatId, ts: Math.floor(Date.now() / 1000) };
  if (botId != null) row.botId = botId;
  // Persist convoId when known so import-convo can repair env-derived convos
  // (whose convoId is a UUID-hash and never equals any Telegram messageId).
  if (convoId != null) row.convoId = convoId;
  const entry = JSON.stringify(row) + '\n';
  // Durable append — sent-registry is the recovery source for `import-convo`
  // when the convo-registry append crashed mid-flight.
  const fd = fs.openSync(registryFile, 'a');
  try {
    fs.writeSync(fd, entry);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readSentRegistry(registryFile = SENT_REGISTRY_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(registryFile, 'utf8');
  } catch {
    return [];
  }
  const results = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try { results.push(JSON.parse(line)); } catch {}
  }
  return results;
}

// Bound the reaction call: a bare fetch has no default connect-stall timeout
// (undici only caps headers/body at ~300s), so a hung setMessageReaction could
// otherwise wedge a caller for minutes — most acutely the listener's burst-settle
// path, which awaits this before deferring a batch. Abort at 10s so a stall
// surfaces as a normal rejection the caller can retry, matching the
// AbortController pattern already used for attachment downloads. Best-effort:
// callers treat a failed reaction as non-fatal.
const REACTION_TIMEOUT_MS = 10_000;
export async function postReaction(token, chatId, messageId, emoji = '👍') {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REACTION_TIMEOUT_MS);
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body?.ok !== false, description: body?.description };
  } finally {
    clearTimeout(t);
  }
}

export function parseArgs(argv) {
  const result = { filePath: null, positional: [], raw: false, plain: false, replyTo: null, react: null, convo: null, gcTopics: false, closeTopic: false, dm: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--convo') {
      const next = argv[i + 1];
      if (!next) throw new Error('--convo requires a positive-integer convoId');
      result.convo = validateConvoIdString(next.trim());
      i++;
      continue;
    }
    if (arg === '--react') {
      const next = argv[i + 1];
      if (!next) throw new Error('--react requires a message ID argument');
      const n = parseInt(next, 10);
      if (isNaN(n) || String(n) !== next.trim() || n <= 0) throw new Error(`--react must be a positive integer message ID, got: ${next}`);
      result.react = n;
      i++;
      continue;
    }
    if (arg === '--file' || arg === '-file') {
      const next = argv[i + 1];
      if (!next) throw new Error('--file requires a path argument');
      result.filePath = next;
      i++;
      continue;
    }
    if (arg === '--reply-to') {
      const next = argv[i + 1];
      if (!next) throw new Error('--reply-to requires a message ID argument');
      const n = parseInt(next, 10);
      if (isNaN(n) || String(n) !== next.trim() || n <= 0) throw new Error(`--reply-to must be a positive integer message ID, got: ${next}`);
      result.replyTo = n;
      i++;
      continue;
    }
    if (arg === '--raw' || arg === '--md-raw') { result.raw = true; continue; }
    if (arg === '--plain') { result.plain = true; continue; }
    if (arg === '--gc-topics') { result.gcTopics = true; continue; }
    if (arg === '--close-topic') { result.closeTopic = true; continue; }
    if (arg === '--dm') { result.dm = true; continue; }
    // (mutual exclusion validated after the loop so order doesn't matter)
    if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    result.positional.push(arg);
  }
  if (result.raw && result.plain) throw new Error('--raw and --plain are mutually exclusive');
  // --dm is a private push to the admin (no convo/topic), so it can't combine
  // with the group/topic-scoped operations. Text/file/plain/raw are fine.
  if (result.dm && (result.gcTopics || result.closeTopic || result.react != null || result.convo != null || result.replyTo != null))
    throw new Error('--dm cannot be combined with --gc-topics / --close-topic / --react / --convo / --reply-to (a DM has no topic/convo to reply into)');
  return result;
}

export function readStdinIfPiped(opts = {}) {
  const { stdinReader = () => fs.readFileSync(0, 'utf8'), stdinIsTTY = process.stdin.isTTY } = opts;
  if (stdinIsTTY) return '';
  return stdinReader();
}

/**
 * Tokenises into code spans, links, and plain text. MarkdownV2 treats code
 * content literally so we must not inject escapes there — same for the URL
 * side of `[text](url)`. Unterminated markers degrade to plain text.
 */
export function tokenizeForEscape(text) {
  const out = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) out.push({ type: 'text', value: text.slice(textStart, end) });
  };
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      if (end === -1) {
        // Unterminated fence: treat the rest as code so we don't silently drop
        // content and don't leave stray backticks in text (which would either
        // re-open Telegram's parser mid-message or get escaped weirdly).
        flushText(i);
        out.push({ type: 'code', value: text.slice(i) });
        i = text.length;
        textStart = i;
        break;
      }
      flushText(i);
      out.push({ type: 'code', value: text.slice(i, end + 3) });
      i = end + 3;
      textStart = i;
      continue;
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) { i++; continue; }
      flushText(i);
      out.push({ type: 'code', value: text.slice(i, end + 1) });
      i = end + 1;
      textStart = i;
      continue;
    }
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flushText(i);
          out.push({
            type: 'link',
            label: text.slice(i + 1, closeBracket),
            url: text.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          textStart = i;
          continue;
        }
      }
    }
    i++;
  }
  flushText(text.length);
  return out;
}

// Non-formatting MdV2 specials. We deliberately leave `*`, `_`, `~` alone so
// that `*bold*` / `_italic_` still render; unbalanced markers are caught by
// the preprocessing pass below (or fall through to file fallback at send time).
const MDV2_TEXT_ESCAPE = /[.!\-()#+=|{}>\\\[\]]/g;
const MDV2_URL_ESCAPE = /[)\\]/g;

/**
 * Best-effort CommonMark-to-MarkdownV2 normalization for plain text content.
 * Trades exact source fidelity for a higher chance of inline Telegram render.
 * MUST be applied per text token (never to code spans or link URLs) — caller
 * is responsible for tokenizing first.
 *   1. `**bold**`  -> `*bold*`         (CommonMark double-asterisk)
 *   2. `__bold__`  -> `_bold_`         (only when NOT touching word chars on
 *                                       both sides, so `__init__` stays literal)
 *   3. `# Heading` -> `*Heading*`      (CommonMark heading -> bold line)
 */
function applyCommonMarkFixupsToText(value) {
  value = value.replace(/\*\*([^\n*]+?)\*\*/g, '*$1*');
  // Note: NOT rewriting `__X__` -> `_X_`. CommonMark double-underscore is
  // ambiguous with Python dunders (`__init__`, `__main__`) and other technical
  // identifiers. Agents almost always emit `**bold**` for bold; the few cases
  // of `__bold__` will get the underscores escaped by the unbalanced-count
  // pass downstream (if the count is odd) or rendered as italic-around-content
  // (if even) — neither is catastrophic.
  value = value.replace(/^(#{1,6})\s+(.+?)\s*$/gm, (_, _h, title) => `*${title}*`);
  return value;
}

/**
 * Count occurrences of `ch` across only the text tokens, skipping characters
 * the user already escaped with `\`. An odd total means the marker is
 * unbalanced, which causes Telegram to reject the whole message — so we'll
 * dynamically add `ch` to the escape set.
 */
function countUnescapedMarkerInTextTokens(tokens, ch) {
  let n = 0;
  for (const t of tokens) {
    if (t.type !== 'text') continue;
    const s = t.value;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === ch) n++;
    }
  }
  return n;
}

// Module-scope to avoid recompilation per call. Matches leading emoji glyphs:
// - Extended_Pictographic base (covers most "picture" emojis)
// - Optional Emoji_Modifier (skin tones)
// - Optional VS-16 (️) on either side of ZWJ sequences
// - ZWJ-joined continuations (‍ + next pictographic)
// - Pairs of Regional_Indicator (country flags like 🇻🇳)
// - Keycap sequences (digit/# + ️ + ⃣, e.g. 1️⃣, #️⃣)
// - Repeated, separated by optional spaces — so "🦊🚀 " all get pulled into the tag
const LEADING_EMOJI_RE = /^(?:(?:(?:\p{Regional_Indicator}\p{Regional_Indicator})|(?:[\d#*]️?⃣)|(?:\p{Extended_Pictographic}️?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*))\s*)+/u;
// Telegram MarkdownV2 specials per https://core.telegram.org/bots/api#markdownv2-style
// (18 chars). Hoisted to module scope to avoid recompile per call.
const MDV2_ALL_SPECIALS_RE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

// RFC 14 — prepend the sending session's identity tag `[<emoji> <name> #hash]`
// to a `--dm` body so the owner can reply-to it and steer the session back via
// `/instruct` (the daemon scans the first 256 chars of the reply for `#hash`).
// `convoId == null` (no env session to sign with) → body unchanged. In raw mode
// the caller pre-escaped its body, so escape the tag too; non-raw callers escape
// the whole message downstream (Telegram strips the backslashes → daemon reads a
// clean `#hash`). Empty body → just the tag (document-caption case).
export function buildDmSignedBody(body, convoId, { raw = false } = {}) {
  if (convoId == null) return body;
  const persona = personaForConvo(convoId);
  const hash = `#${shortConvoHash(convoId)}`;
  const rawTag = persona ? `[${persona.emoji} ${persona.name} ${hash}]` : `[${hash}]`;
  const tag = raw ? rawTag.replace(MDV2_ALL_SPECIALS_RE, (m) => '\\' + m) : rawTag;
  return body ? `${tag} ${body}` : tag;
}

// `shortConvoHash` and `CONVO_HASH_LONG_LEN` now live in `./convo-hash.mjs`
// (leaf module — no circular dep with `pending-store.mjs`). Re-exported at
// the top of this file for backward compat with existing callers.

// Long-message and Markdown-parse fallback captions previously used
// `text.split('\n')[0].slice(0, 100)` — which silently dropped the injected
// `#c<id>` hashtag when the project code + emoji prefix pushed the hashtag
// past the 100-char cut. Re-extract the hashtag and guarantee it appears in
// the caption so document fallbacks remain filterable.
export function previewLineWithHashtag(text, maxLen = 100) {
  const firstLine = text.split('\n')[0];
  if (firstLine.length <= maxLen) return firstLine;
  // Our hashtags are `#<letter><digits>` per shortConvoHash. The leading
  // letter is a-j (digit-encoded) or `t` (literal short-id prefix).
  const m = firstLine.match(/#[a-jt]\d+/);
  if (!m) return firstLine.slice(0, maxLen);
  const tail = ` …${m[0]}`;
  const headBudget = Math.max(0, maxLen - tail.length);
  return firstLine.slice(0, headBudget) + tail;
}

/**
 * Build the outgoing message prefix with project code + clickable convo hashtag.
 *
 * Returns the message body to hand to the send pipeline. The hashtag form
 * `#c<convoId>` carries a leading `c` because Telegram does NOT render purely
 * numeric `#1234` as a clickable hashtag — at least one letter is required.
 *
 * Format:
 *   With leading emoji + convoId: `[<projectCode>] [<emoji> #c<convoId>] <rest>`
 *   No leading emoji + convoId:   `[<projectCode>] [#c<convoId>] <message>`
 *   No convoId:                   `[<projectCode>] <message>`  (legacy fallback)
 *
 * When convoId is unknown (first send of a brand-new convo without env-derived
 * id), we fall back to the legacy no-hash format. Subsequent sends in the same
 * convo will carry the hashtag once the convoId is registered.
 *
 * `pretokensEscaped = true` means the caller is in `--raw` mode and has
 * pre-escaped its `rawMessage` for MarkdownV2; in that case we also escape the
 * MdV2-special characters (`[`, `]`, `#`) in the injected prefix so Telegram's
 * parser doesn't reject the message. The leading `c` of `#c<id>` is plain text
 * and needs no escape; only the `#` character itself is special.
 *
 * `persona` (RFC 01): normally a `{emoji, name}` derived from convoId — the
 * SCRIPT owns the identity token, so the tag becomes `[<emoji> <name> #hash]`
 * and any leading emoji the agent typed is stripped (no duplication). `persona`
 * is null only at the edge where no convoId/persona resolves; then the tag is
 * `[#hash]` and the agent's own leading emoji (if any) is pulled in.
 */
export function injectConvoHash(rawMessage, projectCode, convoId, { pretokensEscaped = false, persona = null } = {}) {
  // Empty message stays empty UNLESS we have a convoId to surface — document
  // sends with no caption still need a clickable hashtag so admins can filter.
  if (rawMessage == null) return rawMessage;
  if (rawMessage === '' && convoId == null) return rawMessage;
  // Strip line separators from projectCode: POSIX allows newlines in directory
  // names, and our `[Project]` prefix MUST be a single line so the hashtag
  // stays on line 1 (where Telegram entity-detects it). Covers CR, LF, NEL,
  // and Unicode line/paragraph separators.
  if (projectCode) projectCode = String(projectCode).replace(/[\r\n\u0085\u2028\u2029]/g, '');
  // In raw mode the caller has pre-escaped its message for MarkdownV2; we must
  // escape EVERY MdV2-special char in OUR injected prefix or Telegram rejects
  // the message with a parse error. Telegram lists 18 special chars; we apply
  // them to projectCode (which may include `.`, `-`, `_` via cwd basename) and
  // to our `[`, `]`, `#` syntax.
  const esc = (s) => (pretokensEscaped ? s.replace(MDV2_ALL_SPECIALS_RE, (m) => '\\' + m) : s);
  const projectPart = projectCode ? esc(`[${projectCode}] `) : '';
  if (convoId == null) return projectPart + rawMessage;
  const hash = `#${shortConvoHash(convoId)}`;
  // Empty body: emit tag with no trailing space (document caption fallback).
  if (rawMessage === '') {
    const inner = persona ? `[${persona.emoji} ${persona.name} ${hash}]` : `[${hash}]`;
    const head = projectPart ? projectPart.replace(/ $/, '') : '';
    return head ? `${head} ${esc(inner)}` : esc(inner);
  }
  if (persona) {
    // Script owns the identity: strip a leading emoji the agent may still type
    // so it isn't duplicated, then render `[<emoji> <name> #hash]`.
    const lead = rawMessage.match(LEADING_EMOJI_RE);
    const rest = lead ? rawMessage.slice(lead[0].length) : rawMessage;
    return `${projectPart}${esc(`[${persona.emoji} ${persona.name} ${hash}] `)}${rest}`;
  }
  const m = rawMessage.match(LEADING_EMOJI_RE);
  if (m) {
    const emoji = m[0].trim();
    const rest = rawMessage.slice(m[0].length);
    return `${projectPart}${esc(`[${emoji} ${hash}] `)}${rest}`;
  }
  return `${projectPart}${esc(`[${hash}] `)}${rawMessage}`;
}

export function escapeMarkdownV2(text) {
  // Tokenize first, then apply CommonMark fixups only to text tokens (and link
  // labels). This prevents fenced code blocks / inline code / URLs from being
  // mangled by the heading or double-marker rewrites.
  const tokens = tokenizeForEscape(text).map((t) => {
    if (t.type === 'text') return { ...t, value: applyCommonMarkFixupsToText(t.value) };
    if (t.type === 'link') return { ...t, label: applyCommonMarkFixupsToText(t.label) };
    return t;
  });

  // Promote unbalanced markers to escaped characters in a single pass so we
  // never end up with `\\*` (which Telegram renders as literal backslash plus
  // literal asterisk). Each marker is independent: e.g. balanced `*` survives
  // even if `_` is unbalanced and gets escaped.
  const extraEscape = [];
  for (const ch of ['*', '_', '~', '`']) {
    if (countUnescapedMarkerInTextTokens(tokens, ch) % 2 === 1) extraEscape.push(ch);
  }
  const charClass = '.!\\-()#+=|{}>\\\\\\[\\]' + extraEscape.map((c) => '\\' + c).join('');
  const textEscapeRe = new RegExp(`[${charClass}]`, 'g');

  return tokens
    .map((t) => {
      if (t.type === 'code') return t.value;
      if (t.type === 'link') {
        const safeLabel = t.label.replace(textEscapeRe, (m) => '\\' + m);
        const safeUrl = t.url.replace(MDV2_URL_ESCAPE, (m) => '\\' + m);
        return `[${safeLabel}](${safeUrl})`;
      }
      return t.value.replace(textEscapeRe, (m) => '\\' + m);
    })
    .join('');
}

/**
 * Read the git context of `cwd` for the per-convo header footer: current
 * branch and a clean/dirty count of the working tree. Returns null when `cwd`
 * is not inside a git work tree or `git` is unavailable — the caller then omits
 * the footer. MUST never throw and never block a send (short, local git calls).
 */
export function readGitContext(cwd = process.cwd()) {
  try {
    const run = (a) =>
      execFileSync('git', a, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // Bound the call so a hung git (stale index.lock, fs stall) can NEVER
        // block a send: timeout → ETIMEDOUT → caught below → footer omitted.
        // GIT_OPTIONAL_LOCKS=0 keeps `status` from waiting on the index lock.
        timeout: 1000,
        killSignal: 'SIGKILL',
        maxBuffer: 1 << 20,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      }).trim();
    // Bail if not a work tree (rev-parse exits non-zero → caught below).
    run(['rev-parse', '--is-inside-work-tree']);
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = run(['status', '--porcelain']);
    const dirty = status ? status.split('\n').filter((l) => l.length > 0).length : 0;
    // Folder NAME only — never the full path (would leak local layout into a
    // multi-member Telegram group). basename of cwd, not the repo toplevel.
    return { folder: path.basename(cwd), branch, dirty };
  } catch {
    return null;
  }
}

/**
 * Format the one-time per-convo context footer (folder · branch · clean/dirty).
 * Appended only to the FIRST message of a convo (see isFirstConvoMessage).
 * `raw` escapes MdV2 specials because the --raw path sends pre-escaped text;
 * default mode leaves it literal (escapeMarkdownV2 escapes downstream) and
 * plain mode also sends it verbatim — so `plain` needs no branch here (literal
 * == default-unescaped). Returns '' when ctx is null (not a git repo).
 */
export function formatGitFooter(ctx, { raw = false } = {}) {
  if (!ctx) return '';
  const state = ctx.dirty > 0 ? `dirty (${ctx.dirty})` : 'clean';
  let footer = `📁 ${ctx.folder} · 🌿 ${ctx.branch} · ${state}`;
  if (raw) footer = footer.replace(MDV2_ALL_SPECIALS_RE, (m) => '\\' + m);
  return '\n\n' + footer;
}

/**
 * True when no allocation row exists yet for (convoId, botId, chatId) — i.e.
 * this send is the FIRST message of the convo in this chat. Reads the convo
 * registry that recordConvoSend writes after each send. On any read error we
 * return false (skip the footer) rather than risk repeating it on later sends.
 */
export function isFirstConvoMessage({ convoId, botId, chatId }, registryFile = CONVO_REGISTRY_FILE) {
  try {
    const { rows } = readConvoRows(registryFile);
    // Coerce convoId to Number to mirror the stored row type (hasAllocationRow
    // compares with ===); String(chatId) already normalizes the chat side.
    return !hasAllocationRow(rows, Number(convoId), botId, String(chatId));
  } catch {
    return false;
  }
}

/**
 * Splits text so no chunk exceeds `maxLen`. Prefers `\n\n` boundaries, then
 * `\n`, then whitespace, and only hard-cuts as a last resort. Split happens
 * on pre-escape content to keep escape sequences intact within a chunk.
 */
export function chunkMessage(text, maxLen = MESSAGE_CHUNK_LIMIT) {
  if (text.length <= maxLen) return text.length === 0 ? [] : [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    let splitAt = window.lastIndexOf('\n\n');
    if (splitAt < maxLen / 2) splitAt = window.lastIndexOf('\n');
    if (splitAt < maxLen / 2) splitAt = window.lastIndexOf(' ');
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).replace(/\s+$/, ''));
    remaining = remaining.slice(splitAt).replace(/^\s+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function scrubToken(text, token) {
  if (!token || typeof text !== 'string') return text;
  return text.split(token).join('***');
}

export function buildTempMarkdownFileName(now = new Date(), pid = process.pid) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `telegram-report-${stamp}-${pid}.md`;
}

/**
 * Writes `content` to a tmp `.md` file and returns the absolute path. Used as a
 * fallback when Telegram rejects our MarkdownV2 parse — sending the chunk as a
 * document preserves the markdown source so the admin can read it properly,
 * instead of collapsing formatting to plain text.
 */
export function createTempMarkdownFile(content, tmpDir = os.tmpdir()) {
  const filePath = path.join(tmpDir, buildTempMarkdownFileName());
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// Transient Telegram send failures — gateway timeouts (502/503/504), internal
// errors (500), and rate limits (429) — are common and self-clearing. Retry the
// POST a few times with backoff so a single hiccup doesn't surface to the agent
// as a hard send failure. 429 honors Telegram's `retry_after` (capped).
// Tradeoff: a 504 can mean "delivered but the gateway timed out replying", so a
// retry may double-send. For an outbound report bot a rare duplicate message is
// strictly less harmful than a lost report, so we accept at-least-once here.
// Topic CREATION shares this retry too (resolveThreadId) but capped at ONE extra
// attempt: the Bot API can't list topics, so a 504-that-actually-created can't
// be de-duped. That's no worse than the status quo, which ALREADY orphans such a
// topic on the next send's recreate — the retry just delivers the report as
// well. Capping at one attempt keeps the duplicate window minimal; a transient
// failure is NOT negative-cached, so the next send recreates automatically.
export const TRANSIENT_SEND_STATUSES = new Set([429, 500, 502, 503, 504]);
const SEND_RETRY_BACKOFF_MS = [500, 1500];
const MAX_RETRY_AFTER_MS = 8000;
// Topic create: 2 attempts (one retry), fixed 1s backoff. createForumTopic does
// NOT surface `retryAfter`, so even a create-path 429 uses this fixed wait (never
// Telegram's retry_after) — fine, since a 429 on a brand-new convo's first topic
// create is rare and the retry is capped at one. See note above.
const TOPIC_CREATE_BACKOFF_MS = [1000];

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize a Telegram API `fetch` Response into our result shape.
async function parseTgResult(res) {
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.ok && body?.ok !== false,
    status: res.status,
    description: body?.description,
    messageId: body?.result?.message_id,
    messageThreadId: body?.result?.message_thread_id ?? null,
    retryAfter: body?.parameters?.retry_after,
  };
}

/**
 * Run `attempt` (an async thunk returning a parsed result, or throwing on a
 * network error) with retry on transient failures. Returns the final result;
 * rethrows the last error if every attempt threw. `sleepFn`/`backoff` injectable
 * for tests (so retries don't actually wait).
 */
export async function sendWithRetry(attempt, {
  attempts = SEND_RETRY_BACKOFF_MS.length + 1,
  sleepFn = defaultSleep,
  backoff = SEND_RETRY_BACKOFF_MS,
} = {}) {
  const maxAttempts = Math.max(1, attempts); // never 0/negative → never return undefined
  let lastError = null;
  for (let i = 0; i < maxAttempts; i++) {
    const isLast = i === maxAttempts - 1;
    const backoffMs = backoff[Math.min(i, backoff.length - 1)];
    let result;
    try {
      result = await attempt();
    } catch (e) {
      lastError = e;
      if (isLast) throw e;
      await sleepFn(backoffMs);
      continue;
    }
    if (result.ok || !TRANSIENT_SEND_STATUSES.has(result.status) || isLast) {
      return result;
    }
    // Honor a positive 429 retry_after (capped); ignore 0/negative/NaN → backoff.
    const retryAfterValid = result.status === 429 && Number.isFinite(result.retryAfter) && result.retryAfter > 0;
    const waitMs = retryAfterValid
      ? Math.min(result.retryAfter * 1000, MAX_RETRY_AFTER_MS)
      : backoffMs;
    await sleepFn(waitMs);
  }
  if (lastError) throw lastError; // unreachable: loop returns/throws on last iter
}

async function postSendMessage(token, chatId, text, parseMode, replyToMessageId, messageThreadId = null) {
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  if (messageThreadId != null) payload.message_thread_id = messageThreadId;
  if (replyToMessageId != null) {
    payload.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  }
  return sendWithRetry(async () => parseTgResult(await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })));
}

async function postSendDocument(token, chatId, filePath, caption, parseMode, replyToMessageId, messageThreadId = null) {
  // Read the file once; rebuild the FormData per attempt (a consumed body stream
  // can't be re-sent across fetch calls).
  const data = fs.readFileSync(filePath);
  const buildForm = () => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (messageThreadId != null) form.append('message_thread_id', String(messageThreadId));
    form.append('document', new Blob([data]), path.basename(filePath));
    if (caption) {
      form.append('caption', caption);
      if (parseMode) form.append('parse_mode', parseMode);
    }
    if (replyToMessageId != null) {
      form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId, allow_sending_without_reply: true }));
    }
    return form;
  };
  return sendWithRetry(async () => parseTgResult(await fetch(`${TELEGRAM_API}${token}/sendDocument`, { method: 'POST', body: buildForm() })));
}

/**
 * Attempt to create a forum topic. Returns `{ ok, messageThreadId, description }`.
 * Failure modes we treat as "this chat doesn't support topics":
 * - HTTP 400 with descriptions like TOPIC_CREATE_DISABLED, FORUM_NOT_ENABLED,
 *   CHAT_FORUM_REQUIRED, BOT_DOMAIN_INVALID, or any 403 (permission).
 * Caller wraps the result; non-ok → negative cache + send without thread_id.
 */
export async function createForumTopic(token, chatId, name, icon = {}) {
  const payload = { chat_id: chatId, name: String(name).slice(0, 128) };
  // Optional per-project topic icon (projects.json `topicIcon`). `icon_color` and
  // `icon_custom_emoji_id` are independent Telegram fields — pass either or both;
  // absent → Telegram's default icon. A custom emoji id MUST come from
  // getForumTopicIconStickers (that set is free for non-premium accounts too).
  if (icon && typeof icon.iconEmojiId === 'string' && icon.iconEmojiId.trim()) {
    payload.icon_custom_emoji_id = icon.iconEmojiId.trim();
  }
  if (icon && Number.isInteger(icon.iconColor)) {
    payload.icon_color = icon.iconColor;
  }
  const res = await fetch(`${TELEGRAM_API}${token}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.ok && body?.ok === true,
    status: res.status,
    description: body?.description,
    messageThreadId: body?.result?.message_thread_id ?? null,
  };
}

/**
 * Fetch chat metadata. Returns `{ ok, isForum, type, description }`. Never
 * throws — network/parse errors collapse to `{ ok: false, isForum: false }`.
 * The caller MUST distinguish `ok === false` (couldn't determine — transient;
 * do NOT treat as misconfig) from `ok === true && !isForum` (definitively not a
 * forum → fail-fast). `fetcher` (test seam) must return the getChat shape
 * `{ ok, result, description }` (NOT the flattened return shape).
 */
export async function detectForum(token, chatId, fetcher) {
  const call = fetcher ?? (async () => {
    const res = await fetch(`${TELEGRAM_API}${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body?.ok === true, result: body?.result, description: body?.description };
  });
  let r;
  try { r = await call(token, chatId); } catch (e) { return { ok: false, isForum: false, description: String(e?.message ?? e) }; }
  return {
    ok: r?.ok === true,
    isForum: r?.result?.is_forum === true,
    type: r?.result?.type ?? null,
    description: r?.description ?? null,
  };
}

// Positive-only forum cache in topics-store (`<chatId>._is_forum`). Once a chat
// is confirmed a forum we never re-probe (a supergroup can't silently stop
// being a forum mid-session). No negative cache: a not-yet-forum chat must keep
// being re-checked so enabling Topics self-heals on the next send.
export function isForumCached(chatId, topicsFile) {
  try { return readTopicsStore(topicsFile)[String(chatId)]?._is_forum === true; } catch { return false; }
}
export function cacheForum(chatId, topicsFile) {
  try {
    updateTopicsStore((s) => {
      const k = String(chatId);
      s[k] = s[k] ?? {};
      s[k]._is_forum = true;
    }, topicsFile);
  } catch { /* best-effort cache; never block a send */ }
}

// Durable last-use timestamp per (chat, topic). Stamped on every send that
// resolves a topic. GC uses THIS (not the listener heartbeat, which is ephemeral
// — pruned at 24h and absent for brand-new topics — review G-C2) so TTL is
// meaningful and a topic is never closed before it's genuinely idle.
export function touchTopicUse(chatId, topicKey, now, topicsFile) {
  try {
    updateTopicsStore((s) => {
      const k = String(chatId);
      s[k] = s[k] ?? {};
      s[k]._ts = s[k]._ts ?? {};
      s[k]._ts[String(topicKey)] = now;
    }, topicsFile);
  } catch { /* best-effort; never block a send */ }
}

/**
 * Build the fail-fast guidance shown when the target chat is not a forum
 * supergroup. Exported so the message can be unit-tested.
 */
export function teamModeForumError(chatId) {
  return [
    `[send-telegram] chat ${chatId} KHÔNG phải supergroup bật Topics.`,
    'Teleport chỉ chạy trong group forum. Cách bật:',
    '  1. Tạo group, bật Topics (Group → Edit → Topics).',
    '  2. Add bot vào group, đặt làm admin + bật quyền "Manage Topics".',
    '  3. BotFather → Bot Settings → Group Privacy → Turn OFF (để bot nhận mọi message trong topic).',
    '  4. Lấy group id (negative) và đặt _default.chatId = id đó trong projects.json.',
  ].join('\n');
}

/**
 * Compute `{ topicKey, topicName }` for resolveThreadId — one forum topic per
 * convo, keyed by convoId. Title format depends on `dedicated` (RFC 02):
 * - `dedicated: true` (project HAS a `projects.json` entry): persona-only,
 *   name-first ("Heo 🐷"). Projects sharing such a group are told apart by their
 *   per-project `topicIcon` (Telegram renders it before the title), so the emoji
 *   trails the name and never sits adjacent to that leading icon; messages carry
 *   no `[<code>]` body prefix either.
 * - `dedicated: false` (catch-all — project NOT in `projects.json`): code-first
 *   ("md · 🐉 Rồng", format `<code> · <emoji> <name>`) so the shared catch-all
 *   group is scannable by project in the topic list; messages also carry the
 *   `[<code>]` body prefix (added at the call site).
 * Catch-all with an empty projectCode degrades to the persona-only form (no
 * orphan " · "). Falls back to projectCode only at the edge where convoId/persona
 * can't be resolved.
 */
export function topicTarget({ convoId, persona, projectCode, dedicated = false }) {
  if (convoId != null && persona) {
    const title = !dedicated && projectCode
      ? `${projectCode} · ${persona.emoji} ${persona.name}`
      : `${persona.name} ${persona.emoji}`;
    return { topicKey: String(convoId), topicName: title };
  }
  return { topicKey: projectCode, topicName: projectCode };
}

/**
 * Resolve the `message_thread_id` to use for a (chatId, topicKey) pair.
 *
 * Returns `null` if no topic should be used because the API call to create
 * one failed. All paths are silent: this function never throws, never logs
 * warnings to user-visible stdout. Topic discovery is opportunistic; sends
 * always proceed. There is no negative cache — every send re-attempts creation
 * so a fixed mis-config self-heals immediately.
 *
 * `nowFn` and `topicsFile` are injectable for tests.
 */
// Telegram error descriptions / statuses that imply "this chat can never host
// topics from this bot" (vs. transient errors like 429 / network glitch). Used
// to gate the icon-less create retry: a permanent error won't be fixed by
// dropping the icon, so don't bother retrying.
function isPermanentNoTopicError(res) {
  if (!res) return true; // fetch itself threw
  if (res.status === 403) return true; // bot lacks permission
  const d = String(res.description ?? '');
  // NB: TOPIC_NOT_MODIFIED is an edit/close no-op signal, NOT a "can't host
  // topics" signal — excluded from the create-path permanent set (S2-Minor).
  return /CHAT_FORUM_REQUIRED|TOPICS_FORBIDDEN|FORUM_NOT_ENABLED|NOT_FORUM|TOPIC_CREATE_DISABLED|chat not found|user is deactivated|bot was kicked|not enough rights/i.test(d);
}

export async function resolveThreadId({ token, chatId, projectCode, topicKey = projectCode, topicName = projectCode, icon = {}, nowFn = Date.now, topicsFile, fetcher = createForumTopic, forceCreate = false, sleepFn = defaultSleep }) {
  // `topicKey` is the topics-store cache key, `topicName` the forum-topic
  // title. Normally topicKey = convoId and topicName = the title from
  // topicTarget ("Heo 🐷" dedicated, "md · 🐉 Rồng" catch-all), giving each
  // convo its own topic (RFC 01). The
  // projectCode default only applies at the edge where convo/persona can't be
  // resolved (see topicTarget) so a send never crashes.
  if (topicKey == null || String(topicKey).startsWith('_')) return null;
  topicKey = String(topicKey);
  // Best-effort: cache reads/writes must never block sending.
  let store;
  try { store = readTopicsStore(topicsFile); } catch { return null; }
  // 1. Positive cache hit — use immediately (stamp last-use for GC). Skipped on
  // `forceCreate` (topic-gone recovery): we must create a FRESH topic, never
  // reuse a possibly-dead cached thread a sibling may have re-recorded (S2-M2).
  // NOTE: the topic icon is applied only at CREATION — a cache hit reuses the
  // existing topic as-is, so changing a project's `topicIcon` does NOT retro-edit
  // already-created topics (icon is cosmetic; per-convo topics are short-lived).
  if (!forceCreate) {
    const cached = getThreadId(store, chatId, topicKey);
    if (cached != null) { touchTopicUse(chatId, topicKey, nowFn(), topicsFile); return cached; }
  }
  // 2. Try create — retry once on transient (504/502/503/429 + network throw).
  // A brand-new convo MUST create a topic on its first send, so an un-retried
  // gateway blip here drops the whole report (existing-topic sends already
  // survive via sendWithRetry). Permanent errors (403 / forum-disabled) are NOT
  // in TRANSIENT_SEND_STATUSES, so sendWithRetry returns them on the FIRST call
  // — no wasted retry, and the negative-cache path below still fires.
  let res;
  let threw = false;
  try {
    res = await sendWithRetry(() => fetcher(token, chatId, topicName, icon), {
      attempts: TOPIC_CREATE_BACKOFF_MS.length + 1,
      backoff: TOPIC_CREATE_BACKOFF_MS,
      sleepFn,
    });
  } catch {
    threw = true; // every attempt threw (network) — TRANSIENT, not "forum disabled"
    res = null;
  }
  // The per-project topic icon is COSMETIC and best-effort. A bad/stale icon (a
  // custom-emoji id not in getForumTopicIconStickers, or a color outside
  // Telegram's allowed set) makes the create 400 — and because topic creation is
  // mandatory (requireTopic), that would drop the whole report on EVERY send (a
  // 400 isn't permanent → never negative-cached → retried forever). So if a
  // create with an icon 400s, retry ONCE without the icon and let Telegram use
  // its default. Defensive predicate: non-ok 400 + an icon was actually sent (we
  // don't rely on exact Telegram error strings, which aren't stable/documented).
  const iconWasSent = !!icon && (
    (typeof icon.iconEmojiId === 'string' && icon.iconEmojiId.trim() !== '') ||
    Number.isInteger(icon.iconColor)
  );
  if (!threw && res && !res.ok && res.status === 400 && iconWasSent && !isPermanentNoTopicError(res)) {
    try {
      res = await sendWithRetry(() => fetcher(token, chatId, topicName, {}), {
        attempts: TOPIC_CREATE_BACKOFF_MS.length + 1,
        backoff: TOPIC_CREATE_BACKOFF_MS,
        sleepFn,
      });
    } catch {
      threw = true;
      res = null;
    }
  }
  if (res && res.ok && res.messageThreadId != null) {
    // Locked RMW so we don't clobber a sibling process's positive entry.
    try { updateTopicsStore((s) => recordThreadId(s, chatId, topicKey, res.messageThreadId), topicsFile); } catch {}
    touchTopicUse(chatId, topicKey, nowFn(), topicsFile);
    return res.messageThreadId;
  }
  // Create failed (transient OR permanent). We do NOT negative-cache: every
  // send re-attempts creation so a fixed mis-config (admin enables Topics /
  // grants the right) self-heals on the very next send instead of staying
  // dropped for up to an hour. Cost is one extra createForumTopic call per send
  // while genuinely misconfigured — an acceptable trade for instant recovery.
  return null;
}

/**
 * Team-mode invariant: a report MUST land in the convo's forum topic, never in
 * General. If no thread could be resolved/created, throw so the caller's
 * per-chat catch logs + counts a failure — instead of silently posting to
 * General (review C-Crit1/C-Crit2/C-Maj2).
 */
export function requireTopic(threadId, chatId, convoId) {
  if (threadId == null) {
    throw new Error(`team mode: no forum topic for convo ${convoId} in chat ${chatId} (refusing to post into General)`);
  }
  return threadId;
}

/**
 * Detect responses that mean "the thread_id we sent no longer exists".
 * Triggers recovery: clear cache for that (chatId, topicKey), RE-CREATE the
 * topic, and retry into the new thread (never General).
 */
export function isTopicGoneError(description) {
  if (!description) return false;
  return /MESSAGE_THREAD_NOT_FOUND|TOPIC_DELETED|TOPIC_CLOSED/i.test(description);
}

export function dropTopicMapping(chatId, topicKey, topicsFile) {
  // Best-effort: a cache write failure must never block the send retry.
  try { updateTopicsStore((s) => clearThreadId(s, chatId, topicKey), topicsFile); } catch {}
}

/**
 * Close a forum topic (RFC 01 P3). Reversible — closing hides it from active
 * use but Telegram keeps history and it can be reopened. Returns `{ ok }`.
 */
export async function closeForumTopic(token, chatId, messageThreadId) {
  const res = await fetch(`${TELEGRAM_API}${token}/closeForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body?.ok === true, description: body?.description };
}

// Marker prefixed/suffixed onto a topic's title when it is wound down, so a
// CLOSED topic stays visually distinct from a fresh OPEN one that may reuse the
// same persona name (RFC 01, ext). 🔒 = "đã đóng".
export const CLOSED_TOPIC_MARK = '🔒';
export function closedTopicTitle(persona) {
  const name = persona?.name ?? 'topic';
  return `${CLOSED_TOPIC_MARK} ${name} (đã đóng)`;
}

/**
 * Rename a forum topic (Telegram editForumTopic). Used by the wind-down to add
 * the closed marker. `name` ≤ 128 chars (Telegram limit). Returns `{ ok }`;
 * never throws (caller treats a rename failure as non-fatal — the close still
 * proceeds). Passing only the name keeps the topic's existing icon.
 */
export async function editForumTopic(token, chatId, messageThreadId, name) {
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/editForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId, name: String(name).slice(0, 128) }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body?.ok === true, description: body?.description };
  } catch (e) {
    return { ok: false, description: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Select convo→topic mappings considered dead for GC, using the DURABLE
 * last-use timestamp (`entry._ts[convoKey]`). A topic is dead iff it HAS a
 * recorded last-use and that use is older than `ttlMs`. A topic with NO `_ts`
 * (brand-new, or never stamped) is NEVER selected — we don't close on absence
 * of a signal (review G-C2). Skips underscore metadata keys + non-numeric
 * values. Pure — no I/O.
 */
export function selectDeadConvoTopics(store, chatId, now, ttlMs) {
  const entry = store?.[String(chatId)];
  if (!entry) return [];
  const ts = entry._ts ?? {};
  const out = [];
  for (const [key, val] of Object.entries(entry)) {
    if (key.startsWith('_')) continue;
    if (typeof val !== 'number') continue;
    const last = ts[key];
    if (typeof last === 'number' && now - last > ttlMs) out.push({ convoKey: key, threadId: val });
  }
  return out;
}

/**
 * GC dead topics for one chat: close each stale topic and clear its mapping +
 * timestamp. Explicit/opt-in (invoked via `--gc-topics`, never auto-on-send) so
 * an idle convo's topic is never closed mid-task. `closer`/`topicsFile`
 * injectable. Staleness is by durable last-use (`_ts`) vs `now`/`ttlMs`.
 */
export async function gcDeadTopics({ token, chatId, now = Date.now(), ttlMs, closer = closeForumTopic, renamer = editForumTopic, topicsFile }) {
  const store = readTopicsStore(topicsFile);
  const dead = selectDeadConvoTopics(store, chatId, now, ttlMs);
  let closed = 0;
  for (const { convoKey, threadId } of dead) {
    try {
      // Re-check immediately before the (network) close: a concurrent send may
      // have refreshed `_ts` (convo woke up) or re-created the topic since the
      // snapshot. Skip if it's no longer stale or the threadId changed (review
      // C-Maj3). Narrows the TOCTOU window; close is reversible regardless.
      const cur = readTopicsStore(topicsFile)[String(chatId)];
      const curTs = cur?._ts?.[convoKey];
      if (cur?.[convoKey] !== threadId || typeof curTs !== 'number' || now - curTs <= ttlMs) continue;
      // Mark with the closed marker before closing (same rationale as the on-
      // demand wind-down) so a GC'd topic stays distinct from a future reuse of
      // its freed persona name. Best-effort — rename failure doesn't block GC.
      try {
        const persona = peekPersona(convoKey, undefined);
        if (persona) await renamer(token, chatId, threadId, closedTopicTitle(persona));
      } catch { /* non-fatal */ }
      const r = await closer(token, chatId, threadId);
      if (r && r.ok) {
        closed++;
        // Re-validate under the lock: only clear if the mapping STILL points at
        // the topic we just closed. A concurrent send could have re-created a
        // fresh topic for this convo between our snapshot and now (review M3).
        try {
          updateTopicsStore((s) => {
            const k = String(chatId);
            if (s[k] && s[k][convoKey] === threadId) {
              delete s[k][convoKey];
              if (s[k]._ts) delete s[k]._ts[convoKey];
            }
          }, topicsFile);
        } catch {}
      }
    } catch { /* best-effort; leave mapping for next GC */ }
  }
  return { closed, considered: dead.length };
}

/**
 * Close ONE convo's topic on demand for a single chat (the `--close-topic` flag).
 * Mirrors the per-item body of gcDeadTopics — re-validate under the lock, then
 * clear the mapping AND its `_ts` stamp on success — but targets a specific
 * convoId regardless of idle time. **Never throws** (a network/API failure is
 * reported via the return value, not an exception, so the caller can keep going
 * across chats and still set a non-zero exit). Returns `{ status, description? }`:
 *   - `'closed'` — a topic existed and was closed (mapping + `_ts` cleared)
 *   - `'absent'` — no topic mapping for this convo in this chat (idempotent no-op)
 *   - `'failed'` — a topic existed but the close call errored/threw (`description`
 *     carries the Telegram reason / thrown message for the operator)
 * `closer`/`topicsFile` injectable for tests.
 */
export async function closeConvoTopic({ token, chatId, convoKey, closer = closeForumTopic, renamer = editForumTopic, topicsFile }) {
  let threadId;
  try {
    threadId = getThreadId(readTopicsStore(topicsFile), chatId, convoKey);
  } catch {
    threadId = null;
  }
  if (threadId == null) return { status: 'absent' };
  try {
    // Retitle with the closed marker FIRST (while the topic is still open), so a
    // closed "Bò" reads as "🔒 Bò (đã đóng)" and never collides visually with a
    // future open "Bò" that reuses the freed name. Best-effort: a rename failure
    // (e.g. missing admin right) must NOT block the close — we still proceed.
    try {
      const persona = peekPersona(convoKey, undefined);
      if (persona) await renamer(token, chatId, threadId, closedTopicTitle(persona));
    } catch { /* non-fatal: continue to close */ }
    const r = await closer(token, chatId, threadId);
    if (!r || !r.ok) return { status: 'failed', description: r?.description };
    // Re-validate under the lock: only clear if the mapping STILL points at the
    // topic we just closed (a concurrent send could have re-created one). Drop
    // the `_ts` stamp too so no orphan timestamp lingers (mirror gcDeadTopics).
    try {
      updateTopicsStore((s) => {
        const k = String(chatId);
        if (s[k] && s[k][convoKey] === threadId) {
          delete s[k][convoKey];
          if (s[k]._ts) delete s[k]._ts[convoKey];
        }
      }, topicsFile);
    } catch {}
    return { status: 'closed' };
  } catch (e) {
    return { status: 'failed', description: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Returns { ok, fallback } — `fallback: true` means Telegram rejected our
 * MarkdownV2 parse and we re-sent the chunk as a temporary `.md` document so
 * the admin still receives the content with its markdown source intact
 * (readable in Telegram's file preview), instead of collapsing to plain text.
 */
export async function sendTextChunk(token, chatId, rawChunk, { raw, plain, replyTo = null, messageThreadId = null }) {
  // Helper: refuse to claim success if Telegram returned ok with no message_id.
  // The agent relies on the printed messageId to start its reply listener; a
  // silent miss would log a successful send but leave the agent unable to
  // track replies.
  const assertMessageId = (res, label) => {
    if (!res.messageId) throw new Error(`${label}: Telegram returned ok but no message_id \u2014 refusing to claim success`);
    return res.messageId;
  };

  if (plain) {
    const res = await postSendMessage(token, chatId, rawChunk, null, replyTo, messageThreadId);
    if (res.ok) return { ok: true, fallback: false, messageId: assertMessageId(res, 'plain send') };
    throw new Error(res.description ?? `HTTP ${res.status}`);
  }
  const payload = raw ? rawChunk : escapeMarkdownV2(rawChunk);
  const first = await postSendMessage(token, chatId, payload, 'MarkdownV2', replyTo, messageThreadId);
  if (first.ok) return { ok: true, fallback: false, messageId: assertMessageId(first, 'markdown send') };

  const desc = first.description ?? `HTTP ${first.status}`;
  if (/can't parse entities|can\u2019t parse entities/i.test(desc)) {
    let tmpPath;
    try {
      tmpPath = createTempMarkdownFile(rawChunk);
    } catch (e) {
      throw new Error(`markdown-file fallback failed to write tmp file: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const firstLine = previewLineWithHashtag(rawChunk);
      const retry = await postSendDocument(token, chatId, tmpPath, firstLine, null, replyTo, messageThreadId);
      if (retry.ok) return { ok: true, fallback: true, messageId: assertMessageId(retry, 'markdown-file fallback') };
      throw new Error(`markdown-file fallback upload failed: ${retry.description ?? `HTTP ${retry.status}`}`);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
  throw new Error(desc);
}

export async function sendTextToAdmin(token, chatId, text, opts) {
  // Long-message policy: if text exceeds the single-message limit, send as a
  // single .md file attachment instead of splitting into multiple Telegram
  // messages. Rationale: chunked sends give each chunk its own messageId, so
  // a user reply to any chunk other than the first won't match the agent's
  // filter (one bug we hit in practice). One file = one messageId = simple.
  //
  // Note: opts.plain and opts.raw are intentionally ignored in this branch.
  // The body of a sent .md file is displayed verbatim by Telegram (no Markdown
  // parsing), so plain-vs-markdown distinction is moot. For opts.raw, callers
  // who pre-escaped MarkdownV2 will see literal backslashes in the file body;
  // that's an acceptable trade-off because (a) --raw is rare, (b) the agent
  // can choose not to combine --raw with very long content.
  if (text.length > MESSAGE_CHUNK_LIMIT) {
    let tmpPath;
    try {
      tmpPath = createTempMarkdownFile(text);
    } catch (e) {
      throw new Error(`long-message file fallback failed to write tmp file: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const firstLine = previewLineWithHashtag(text);
      const res = await postSendDocument(token, chatId, tmpPath, firstLine, null, opts.replyTo ?? null, opts.messageThreadId ?? null);
      if (!res.ok) throw new Error(`long-message file fallback upload failed: ${res.description ?? `HTTP ${res.status}`}`);
      if (!res.messageId) throw new Error(`long-message file fallback: Telegram returned ok but no message_id — refusing to claim success`);
      return {
        chunks: 1,
        fallback: 'auto-file',
        messageId: res.messageId,
        allMessageIds: [res.messageId],
      };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  // Short message: single sendMessage with markdown parsing (and per-chunk
  // fallback to .md file if Telegram rejects the parse).
  const { fallback, messageId } = await sendTextChunk(token, chatId, text, opts);
  return {
    chunks: 1,
    fallback: fallback ? 'parse-error-file' : false,
    messageId,
    allMessageIds: messageId ? [messageId] : [],
  };
}

async function sendDocumentToAdmin(token, chatId, filePath, caption, opts) {
  let finalCaption = null;
  let parseMode = null;
  if (caption) {
    const trimmed = caption.slice(0, CAPTION_LIMIT);
    if (opts.plain) {
      finalCaption = trimmed;
    } else {
      finalCaption = opts.raw ? trimmed : escapeMarkdownV2(trimmed);
      parseMode = 'MarkdownV2';
    }
  }
  const thread = opts.messageThreadId ?? null;
  const first = await postSendDocument(token, chatId, filePath, finalCaption, parseMode, opts.replyTo, thread);
  if (first.ok) return { fallback: false, messageId: first.messageId };

  const desc = first.description ?? `HTTP ${first.status}`;
  if (parseMode && /can't parse entities|can\u2019t parse entities/i.test(desc)) {
    const retry = await postSendDocument(token, chatId, filePath, caption.slice(0, CAPTION_LIMIT), null, opts.replyTo, thread);
    if (retry.ok) return { fallback: true, messageId: retry.messageId };
    throw new Error(retry.description ?? `HTTP ${retry.status}`);
  }
  throw new Error(desc);
}

// A bot cannot open a DM first: Telegram returns a 403 (or "chat not found")
// when the target user hasn't pressed /start (or has blocked the bot). Detect
// those so the --dm branch can surface an actionable hint instead of a raw API
// error. Exported for unit testing (the strings are English + Telegram-specific).
export function isDmUnreachableError(desc) {
  return /can't initiate conversation|can’t initiate conversation|bot was blocked|chat not found|Forbidden/i.test(String(desc ?? ''));
}

async function main() {
  const envFromFile = loadEnvFromFile(ENV_FILE);
  const token = process.env.REPORT_BOT_TOKEN || envFromFile.REPORT_BOT_TOKEN;
  // Lookup key = basename(cwd) (= the projects.json key). No env override, no
  // project-local .env reading. The DISPLAY code is projCfg.code (entry.code
  // short alias, e.g. "d_be", else the lookup key).
  const lookupKey = path.basename(process.cwd()) || '';
  // RFC 02: per-project group via projects.json[key].chatId (DEDICATED) →
  // fallback to the catch-all default group (projects.json `_default.chatId`,
  // or the deprecated TELEGRAM_ADMIN_CHAT_ID env). `dedicated` drives the
  // topic-title form (dedicated persona-only vs catch-all code-first) and the
  // `[code]` message prefix (catch-all only).
  const projectsConfig = readProjectsConfig();
  const fallbackChatId = resolveDefaultChatId(projectsConfig, { env: process.env, envFile: envFromFile });
  const projCfg = resolveProjectConfig(lookupKey, { config: projectsConfig, fallbackChatId });
  const projectCode = projCfg.code;
  const dedicatedGroup = projCfg.dedicated;
  // Per-project forum-topic icon (projects.json `topicIcon: { emoji?, color? }`).
  // Mapped to createForumTopic's field names; absent fields are dropped downstream.
  const topicIcon = projCfg.topicIcon
    ? { iconEmojiId: projCfg.topicIcon.emoji, iconColor: projCfg.topicIcon.color }
    : {};
  const adminIds = adminIdsFrom(projCfg, fallbackChatId, parseAdminChatIds);
  // RFC 01: teleport runs ONE mode — team. Every target chat MUST be a forum
  // supergroup; each convo gets its OWN forum topic titled with its persona,
  // and the persona is always rendered. No flags, no DM/legacy path.

  if (!token) {
    console.error('Missing REPORT_BOT_TOKEN in .env or process env.');
    process.exit(1);
  }

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[send-telegram] ${error.message}`);
    process.exit(1);
  }

  // A group target is required for every path EXCEPT --dm (which pushes to the
  // owner's private chat and never touches the group). Gate the group-config
  // fail-fast on !args.dm so a DM works even in a project with no group mapped.
  if (!args.dm && adminIds.length === 0) {
    console.error(`[send-telegram] project "${lookupKey}" chưa cấu hình group: thêm "${lookupKey}".chatId vào teleport/projects.json, hoặc đặt _default.chatId trong projects.json (shared catch-all).`);
    process.exit(1);
  }

  const botId = extractBotId(token);
  let effectiveAdminIds = adminIds;

  // Pre-resolve from env > --convo. Null = defer to --reply-to inference;
  // if that also misses, the pid+time fallback below supplies a stable id.
  let preResolved = null;
  try {
    const r = resolveConvoIdFromEnv({ argConvo: typeof args.convo === 'number' ? args.convo : null });
    preResolved = r.convoId;
  } catch (e) {
    console.error(`[send-telegram] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // RFC 01: in team mode a convo needs a STABLE id BEFORE the send — it keys the
  // persona + per-convo topic. When neither env nor --convo nor a --reply-to
  // lookup resolves one (env-less agent, brand-new convo), synthesize a
  // collision-resistant id UP FRONT, instead of the old post-send "= messageId"
  // (which mis-keyed/collided the topic — review C1). 56 random bits mod 9e15
  // → positive integer that round-trips through Number safely (the agent
  // captures it from stdout and passes it back via `--convo <id>`, which parses
  // as a Number). Computed once per process; only used when nothing resolves.
  const fallbackConvoId = Number(BigInt('0x' + crypto.randomBytes(7).toString('hex')) % 9_000_000_000_000_000n) + 1;
  // No pre-flight: passing `--convo <N>` auto-allocates on first use and
  // appends on subsequent uses. We address every admin chat; the chats that
  // already have an allocation row will get an append, the ones that don't
  // will get an allocation. Anti-hijack rule (the strict "must already exist"
  // check) was dropped per user request — agents are responsible for picking
  // collision-resistant convoIds (e.g. process pid + timestamp).

  const opts = { raw: args.raw, plain: args.plain, replyTo: args.replyTo };

  // Per-convo context footer (folder · branch · clean/dirty): computed LAZILY —
  // git only runs when a send is actually the FIRST message of its convo (gated
  // per-chat below), so --react / --close-topic / follow-up sends never shell
  // out to git. Memoized so the multi-admin fan-out reads git at most once.
  let _gitFooter;
  const gitFooterFor = () => {
    if (_gitFooter === undefined) _gitFooter = formatGitFooter(readGitContext(), opts);
    return _gitFooter;
  };

  // GC dead topics (RFC 01 P3): explicit/opt-in. Close topics whose convo has
  // not sent for TELE_TOPIC_TTL_H hours (default 48), then clear their mapping.
  // Reversible (closeForumTopic). Intended for cron.
  //
  // Staleness uses the DURABLE per-topic last-use stamp (`_ts`, written on every
  // send), NOT the ephemeral listener heartbeat — so a topic is only closed once
  // genuinely idle for the full TTL, and a brand-new / never-idle topic is never
  // closed (review G-C2/M2).
  if (args.gcTopics) {
    const ttlH = Number(process.env.TELE_TOPIC_TTL_H ?? envFromFile.TELE_TOPIC_TTL_H);
    const ttlMs = (Number.isFinite(ttlH) && ttlH > 0 ? ttlH : 48) * 60 * 60 * 1000;
    const now = Date.now();
    let totalClosed = 0;
    for (const chatId of effectiveAdminIds) {
      const { closed, considered } = await gcDeadTopics({ token, chatId, now, ttlMs });
      totalClosed += closed;
      console.log(`[send-telegram] gc-topics ${chatId}: closed ${closed}/${considered}`);
    }
    console.log(`[send-telegram] gc-topics done: ${totalClosed} closed`);
    return;
  }

  // Close ONE specific topic on demand (the topic of `--convo <N>`). Used by the
  // "Chào và đóng topic" wind-down: after the agent posts its closing summary and
  // stops its listeners, it closes its own topic. Reversible (closeForumTopic) —
  // Telegram keeps history and the topic can be reopened. Requires --convo since
  // the topic is keyed per convoId (topicKey = convoId, RFC 01).
  if (args.closeTopic) {
    if (typeof args.convo !== 'number') {
      console.error('[send-telegram] --close-topic requires --convo <convoId> (topic is keyed per convo)');
      process.exit(1);
    }
    const convoKey = String(args.convo);
    let closed = 0;
    let failed = 0;
    for (const chatId of effectiveAdminIds) {
      const r = await closeConvoTopic({ token, chatId, convoKey });
      if (r.status === 'closed') {
        closed++;
        console.log(`[send-telegram] close-topic ${chatId}: closed topic for convo ${convoKey}`);
      } else if (r.status === 'failed') {
        failed++;
        console.error(`[send-telegram] close-topic ${chatId}: FAILED for convo ${convoKey}: ${r.description ?? 'unknown error (bot needs "Manage Topics" admin right?)'}`);
      } else {
        console.log(`[send-telegram] close-topic ${chatId}: no topic for convo ${convoKey} (skip)`);
      }
    }
    console.log(`[send-telegram] close-topic done: ${closed} closed, ${failed} failed`);
    // Fail loud: a caller/agent scripting the wind-down must be able to detect a
    // close that didn't happen (vs the "absent" idempotent no-op, which is ok).
    if (failed > 0) process.exit(1);
    return;
  }

  // DM the admin directly (RFC 12) — a PRIVATE push to the owner instead of the
  // group topic. Used when the user says "DM cho admin …" / "DM me file abc".
  // Deliberately bypasses ALL topic machinery: no convo id, no persona, no
  // hashtag, no git footer, no sent-registry — a DM is not a convo, and NOT
  // registering it keeps the agent's topic listener from mis-associating a DM
  // reply (DM replies belong to the daemon lane, not this agent). One-way push.
  if (args.dm) {
    // Target = the owner's private chat id. In a private DM chat.id === user id,
    // so `_config.daemonUserId` (the daemon owner = "admin who can run the
    // daemon") doubles as the DM chat id. v1 targets this single owner only.
    const dmChatId = resolveDaemonUserId(projectsConfig, { env: process.env, envFile: envFromFile });
    if (!dmChatId) {
      console.error('[send-telegram] --dm needs an admin DM target: set `_config.daemonUserId` in teleport/projects.json (the owner\'s Telegram user id = their private chat id).');
      process.exit(1);
    }
    try {
      assertChatIdKind(dmChatId, 'private', '_config.daemonUserId');
    } catch (e) {
      console.error(`[send-telegram] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    // messageThreadId: null → lands in the private chat root, never a topic.
    const dmOpts = { raw: args.raw, plain: args.plain, replyTo: null, messageThreadId: null };
    // RFC 14 — sign the DM with the sending session's identity tag so the owner
    // can reply-to it and steer the session back via `/instruct` (the daemon
    // scans the first 256 chars of the reply for `#hash`). ONLY when a REAL env
    // convoId exists (`preResolved`): a synthesized fallback would sign a hash no
    // live listener / alive-file matches, making the round-trip inert. In raw
    // mode the caller pre-escaped its body, so we MdV2-escape the tag too; in
    // non-raw mode sendText/DocumentToAdmin escapes the whole message (Telegram
    // strips the backslashes, so the daemon still reads a clean `#hash`).
    const signDm = (body) => buildDmSignedBody(body, preResolved, { raw: args.raw });
    try {
      let messageId;
      if (args.filePath) {
        if (!fs.existsSync(args.filePath)) {
          console.error(`[send-telegram] file not found: ${args.filePath}`);
          process.exit(1);
        }
        const caption = args.positional.join('\n').trim() || readStdinIfPiped().trim() || '';
        ({ messageId } = await sendDocumentToAdmin(token, dmChatId, args.filePath, signDm(caption), dmOpts));
        console.log(`[send-telegram] DM document sent to admin ${dmChatId}${messageId ? ` (messageId: ${messageId})` : ''}`);
      } else {
        const text = (args.positional.join(' ').trim() || readStdinIfPiped()).trim();
        if (!text) {
          console.error('[send-telegram] --dm requires message text (positional or stdin) or --file <path>');
          process.exit(1);
        }
        ({ messageId } = await sendTextToAdmin(token, dmChatId, signDm(text), dmOpts));
        console.log(`[send-telegram] DM sent to admin ${dmChatId}${messageId ? ` (messageId: ${messageId})` : ''}`);
      }
    } catch (error) {
      const scrubbed = scrubToken(error instanceof Error ? error.message : String(error), token);
      // A bot cannot open a DM first: the admin must have /started the bot (or
      // not blocked it). Surface that actionable hint instead of a raw 403.
      if (isDmUnreachableError(scrubbed)) {
        console.error(`[send-telegram] DM to admin ${dmChatId} failed: ${scrubbed}\n  → The admin must open a private chat with the bot and press /start first (a bot cannot initiate a DM), and must not have blocked it.`);
      } else {
        console.error(`[send-telegram] DM to admin ${dmChatId} failed: ${scrubbed}`);
      }
      process.exit(1);
    }
    return;
  }

  // Fail-fast: every target chat MUST be a forum supergroup. Bail BEFORE any
  // send so the operator fixes setup instead of silently sending into a
  // non-forum chat (which would break topic-per-convo routing).
  //
  // Two guards from review:
  // - Only hard-exit when getChat DEFINITIVELY says not-a-forum (`forum.ok &&
  //   !forum.isForum`). A transient getChat failure (`!forum.ok`: 429/5xx/
  //   network) is NOT proof of a misconfig — proceeding is safer than dropping
  //   every report during a Telegram blip.
  // - Cache the positive result in topics-store (`_is_forum`) so steady-state
  //   sends skip the extra getChat round-trip.
  for (const chatId of effectiveAdminIds) {
    if (isForumCached(chatId)) continue;
    const forum = await detectForum(token, chatId);
    if (forum.ok && !forum.isForum) {
      console.error(teamModeForumError(chatId));
      process.exit(1);
    }
    if (forum.ok && forum.isForum) cacheForum(chatId);
    // !forum.ok → couldn't determine; proceed this send, re-check next time.
  }

  if (args.react != null) {
    let failures = 0;
    for (const chatId of effectiveAdminIds) {
      try {
        const { ok, description } = await postReaction(token, chatId, args.react);
        if (ok) console.log(`[send-telegram] reacted 👍 to ${args.react} in ${chatId}`);
        else { failures++; console.error(`[send-telegram] react failed for ${chatId}: ${description}`); }
      } catch (error) {
        failures++;
        const raw = error instanceof Error ? error.message : String(error);
        console.error(`[send-telegram] react failed for ${chatId}: ${scrubToken(raw, token)}`);
      }
    }
    if (failures === effectiveAdminIds.length) process.exit(1);
    return;
  }

  if (args.filePath) {
    if (!fs.existsSync(args.filePath)) {
      console.error(`[send-telegram] file not found: ${args.filePath}`);
      process.exit(1);
    }
    const captionFromArgs = args.positional.join('\n').trim();
    const captionFromStdin = captionFromArgs ? '' : readStdinIfPiped().trim();
    const rawCaption = captionFromArgs || captionFromStdin || '';
    // Caption is built per-chat below because convoId (used in hashtag) is
    // resolved per-chat in the multi-admin fan-out.

    let failures = 0;
    let lastConvoId = null;
    for (const chatId of effectiveAdminIds) {
      try {
        const convoIdForSend = resolveConvoIdPreSend({ preResolved, replyTo: args.replyTo, chatId, botId }) ?? fallbackConvoId;
        // Group-aware: on first touch, pick a persona NOT used by another live
        // topic in THIS chat (collision avoidance within the group); once pinned
        // it's stable. `chatId` scopes the group; the topics-store snapshot lists
        // its live topics.
        const persona = resolvePersonaInGroup(convoIdForSend, { chatId, topicsStore: readTopicsStore() });
        // In a DEDICATED group the whole group IS this project, so the `[project]`
        // message prefix is redundant (RFC 02) — drop it (the persona tag still
        // identifies the agent). Shared group keeps `[project]` to disambiguate.
        const captionBody = isFirstConvoMessage({ convoId: convoIdForSend, botId, chatId })
          ? rawCaption + gitFooterFor()
          : rawCaption;
        const caption = injectConvoHash(captionBody, dedicatedGroup ? '' : projectCode, convoIdForSend, { pretokensEscaped: opts.raw, persona });
        const { topicKey, topicName } = topicTarget({ convoId: convoIdForSend, persona, projectCode, dedicated: dedicatedGroup });
        let threadId = requireTopic(await resolveThreadId({ token, chatId, projectCode, topicKey, topicName, icon: topicIcon }), chatId, convoIdForSend);
        let sendOpts = { ...opts, messageThreadId: threadId };
        let result;
        try {
          result = await sendDocumentToAdmin(token, chatId, args.filePath, caption, sendOpts);
        } catch (e) {
          if (isTopicGoneError(e instanceof Error ? e.message : String(e))) {
            // Topic vanished → clear cache, RE-CREATE a topic, retry into it.
            dropTopicMapping(chatId, topicKey);
            threadId = requireTopic(await resolveThreadId({ token, chatId, projectCode, topicKey, topicName, icon: topicIcon, forceCreate: true }), chatId, convoIdForSend);
            sendOpts = { ...opts, messageThreadId: threadId };
            result = await sendDocumentToAdmin(token, chatId, args.filePath, caption, sendOpts);
          } else { throw e; }
        }
        const { fallback, messageId } = result;
        // convoIdForSend is always set now (env/--convo/--reply-to or the
        // pid+time fallback), so the topic was keyed by the SAME id the agent
        // will listen on — no post-send "= messageId" re-keying needed.
        // Sent-registry is durable + load-bearing (lookupConvoIdByMessageId
        // depends on it). Pending-store is opportunistic. Always durable
        // first; a phantom pending entry (sent succeeded, pending update
        // failed) is far less harmful than the inverse (pending listed but
        // sent-registry has no row → admin reply can't be routed).
        appendToSentRegistry({ messageId, chatId, botId, convoId: convoIdForSend });
        try { updatePendingStore((s) => recordBotSend(s, { convoId: convoIdForSend, project: projectCode, messageId })); } catch {}
        const recordedConvoId = await maybeRecordConvo({ convoId: convoIdForSend, messageId, chatId, botId });
        if (recordedConvoId != null) lastConvoId = recordedConvoId;
        const parts = [];
        if (fallback) parts.push('caption sent as plain text');
        if (messageId) parts.push(`messageId: ${messageId}`);
        const note = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        console.log(`[send-telegram] document sent to ${chatId}${note}`);
        emitConvoLine({ convoId: recordedConvoId, messageId });
      } catch (error) {
        failures++;
        const raw = error instanceof Error ? error.message : String(error);
        console.error(`[send-telegram] failed for ${chatId}: ${scrubToken(raw, token)}`);
      }
    }
    if (failures === effectiveAdminIds.length) process.exit(1);
    if (failures < effectiveAdminIds.length) {
      console.log(listenerHintForCurrentAgent(lastConvoId));
    }
    return;
  }

  const argText = args.positional.join(' ').trim();
  const rawMessage = (argText || readStdinIfPiped()).trim();
  if (!rawMessage) {
    console.error(
      'Usage: node ../teleport/scripts/send-telegram.mjs [args]\n\n' +
        'args:\n' +
        '  "<markdown>"            MarkdownV2 message (default)\n' +
        '  --raw "<text>"          pre-escaped MdV2, no extra escaping\n' +
        '  --plain "<text>"        plain text, no markdown parsing\n' +
        '  --file <path> [caption] send file as document\n' +
        '  --dm "<text>"           private-DM the admin (owner) instead of the group topic\n' +
        '  --dm --file <path>      DM a file to the admin\n' +
        '  (or pipe via stdin)',
    );
    process.exit(1);
  }

  let failures = 0;
  let lastConvoId = null;
  for (const chatId of effectiveAdminIds) {
    try {
      const convoIdForSend = resolveConvoIdPreSend({ preResolved, replyTo: args.replyTo, chatId, botId }) ?? fallbackConvoId;
      // Group-aware first-touch assignment (see the document-send path above).
      const persona = resolvePersonaInGroup(convoIdForSend, { chatId, topicsStore: readTopicsStore() });
      // Dedicated group → drop the redundant `[project]` prefix (see above).
      const messageBody = isFirstConvoMessage({ convoId: convoIdForSend, botId, chatId })
        ? rawMessage + gitFooterFor()
        : rawMessage;
      const message = injectConvoHash(messageBody, dedicatedGroup ? '' : projectCode, convoIdForSend, { pretokensEscaped: opts.raw, persona });
      const { topicKey, topicName } = topicTarget({ convoId: convoIdForSend, persona, projectCode, dedicated: dedicatedGroup });
      let threadId = requireTopic(await resolveThreadId({ token, chatId, projectCode, topicKey, topicName, icon: topicIcon }), chatId, convoIdForSend);
      let sendOpts = { ...opts, messageThreadId: threadId };
      let result;
      try {
        result = await sendTextToAdmin(token, chatId, message, sendOpts);
      } catch (e) {
        if (isTopicGoneError(e instanceof Error ? e.message : String(e))) {
          // Topic vanished → clear cache, RE-CREATE a topic, retry into it.
          dropTopicMapping(chatId, topicKey);
          threadId = requireTopic(await resolveThreadId({ token, chatId, projectCode, topicKey, topicName, icon: topicIcon, forceCreate: true }), chatId, convoIdForSend);
          sendOpts = { ...opts, messageThreadId: threadId };
          result = await sendTextToAdmin(token, chatId, message, sendOpts);
        } else { throw e; }
      }
      const { fallback, messageId, allMessageIds } = result;
      // convoIdForSend always set (env/--convo/--reply-to or pid+time fallback).
      for (const mid of allMessageIds) appendToSentRegistry({ messageId: mid, chatId, botId, convoId: convoIdForSend });
      // Pending-store after — opportunistic, doesn't block on failure.
      try { updatePendingStore((s) => recordBotSend(s, { convoId: convoIdForSend, project: projectCode, messageId })); } catch {}
      const recordedConvoId = await maybeRecordConvo({ convoId: convoIdForSend, messageId, chatId, botId });
      if (recordedConvoId != null) lastConvoId = recordedConvoId;
      const parts = [];
      if (fallback === 'auto-file') parts.push('long-message → .md file');
      else if (fallback === 'parse-error-file') parts.push('markdown-parse-error → .md file');
      if (messageId) parts.push(`messageId: ${messageId}`);
      const note = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      console.log(`[send-telegram] sent to ${chatId}${note}`);
      emitConvoLine({ convoId: recordedConvoId, messageId });
    } catch (error) {
      failures++;
      const raw = error instanceof Error ? error.message : String(error);
      console.error(`[send-telegram] failed for ${chatId}: ${scrubToken(raw, token)}`);
    }
  }

  if (failures === effectiveAdminIds.length) process.exit(1);
  if (failures < effectiveAdminIds.length) {
    console.log(listenerHintForCurrentAgent(lastConvoId));
  }
}

// Convo book-keeping helpers used by both the document and text send paths.

// Resolve convoId BEFORE the send so sent-registry can persist it (needed for
// import-convo to recover env-derived convos whose convoId is a UUID-hash, not
// a real messageId). Order:
//   1. preResolved (env or --convo).
//   2. --reply-to inference: lookup replyTo in registry for this (botId, chatId).
//   3. null → caller substitutes the pid+time `fallbackConvoId` (synthesized
//      pre-send), so persona + topic are keyed by the SAME id the agent listens
//      on. (No post-send "= messageId" re-keying anymore — review C1.)
export function resolveConvoIdPreSend({ preResolved, replyTo, chatId, botId }) {
  if (preResolved != null) return preResolved;
  if (replyTo != null) {
    const { rows } = readConvoRows();
    const found = lookupConvoIdByMessageId(rows, botId, String(chatId), replyTo);
    if (found != null) return found;
  }
  return null;
}

// Record the send into convo-registry. `convoId` is the final value (caller
// substitutes messageId for new-convo case).
async function maybeRecordConvo({ convoId, messageId, chatId, botId }) {
  if (!messageId || convoId == null) return null;
  const result = await recordConvoSend({ convoId, messageId, chatId, botId });
  if (result.ok && result.shouldPrune) await pruneAfterSend();
  if (!result.ok) {
    // Surface convoId so the operator can repair via import-convo without
    // having to grep stdout for the env-derived integer.
    const botSuffix = botId != null ? ` --bot ${botId}` : '';
    console.error(
      `[send-telegram] convo-registry lock-timeout (convoId=${convoId}) — registry append SKIPPED for messageId=${messageId}. Run: node import-convo.mjs --convo ${convoId}${botSuffix}`,
    );
    return convoId; // still echo so the agent can log + start its listener
  }
  return result.convoId;
}

/**
 * @internal
 * Tailor the "now start a listener" reminder by detected agent:
 * - Claude (`CLAUDE_CODE_SESSION_ID` set) → Monitor tool.
 * - Other → synchronous `--wait-once` loop.
 *
 * `--wait-once` is the operational default for every non-Monitor runtime.
 */
export function listenerHintForCurrentAgent(convoId, env = process.env) {
  const convoArg = convoId != null ? ` --convo ${convoId}` : '';
  if (env.CLAUDE_CODE_SESSION_ID) {
    return `[send-telegram] ⚠️ Keep ONE self-re-arming reply listener alive via Monitor (start once per convo, don't re-arm per send): \`while :; do node ../teleport/scripts/tele-listen.mjs${convoArg} --settle --loop --append; case $? in 3) break;; 1) sleep 30;; esac; sleep 2; done\``;
  }
  const lines = [
    `[send-telegram] ⚠️ Start a one-reply listener: \`node ../teleport/scripts/tele-listen.mjs --wait-once${convoArg}\``,
    `[send-telegram] ⚠️ Do NOT end your turn / send a "final" or similar response while waiting for replies.`,
  ];
  if (convoId != null) {
    lines.push(
      `[send-telegram]    --wait-once exits after \`prompt ready: .../prompt-convo-${convoId}.json\`.`,
      `[send-telegram]    When the prompt appears: read JSON → reply via send-telegram → delete the JSON → loop.`,
    );
  } else {
    lines.push(
      `[send-telegram]    (convoId unknown — every send failed; cannot describe the poll path)`,
    );
  }
  return lines.join('\n');
}

function emitConvoLine({ convoId, messageId }) {
  if (!messageId || convoId == null) return;
  console.log(`[send-telegram] convo: ${convoId} messageId: ${messageId} pid: ${process.pid}`);
  // RFC 04: echo this convo's persona so the agent reading stdout learns the
  // name it answers to (e.g. "🐷 Heo") and can self-identify in its prose —
  // fulfilling the RFC 01 §5 intent. Read-only peek: the send path above already
  // pinned this convo, so this just echoes that pin (no second assignment).
  const persona = peekPersona(convoId);
  if (persona != null) console.log(`[send-telegram] persona: ${formatPersona(persona)}`);
  // RFC 02 P1: consume the claimed prompt for this convo (no-op if unclaimed).
  if (autoConsumeClaimedPrompt(convoId)) {
    console.log(`[send-telegram] consumed prompt-convo-${convoId}.processing.json`);
  }
}

const isDirectRun = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isDirectRun) {
  const tokenForScrub =
    process.env.REPORT_BOT_TOKEN || loadEnvFromFile(ENV_FILE).REPORT_BOT_TOKEN || '';
  main().catch((error) => {
    const raw = error instanceof Error ? error.message : String(error);
    console.error(`[send-telegram] ${scrubToken(raw, tokenForScrub)}`);
    process.exit(1);
  });
}
