#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  isNoTopicSupportFresh,
  readTopicsStore,
  recordNoTopicSupport,
  recordThreadId,
  updateTopicsStore,
  writeTopicsStore,
} from './topics-store.mjs';
import {
  recordBotSend,
  updatePendingStore,
} from './pending-store.mjs';
import { CONVO_HASH_LONG_LEN, shortConvoHash as _shortConvoHash } from './convo-hash.mjs';

// Re-export so existing imports of `shortConvoHash` from send-telegram keep
// working. Logic now lives in convo-hash.mjs (leaf, no circular deps).
export { CONVO_HASH_LONG_LEN } from './convo-hash.mjs';
export const shortConvoHash = _shortConvoHash;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const TELEGRAM_API = 'https://api.telegram.org/bot';
const SENT_REGISTRY_FILE = path.join(__dirname, 'tmp', 'tele-reply', 'sent-registry.jsonl');

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

export async function postReaction(token, chatId, messageId, emoji = '👍') {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  };
  const res = await fetch(`${TELEGRAM_API}${token}/setMessageReaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body?.ok !== false, description: body?.description };
}

export function parseArgs(argv) {
  const result = { filePath: null, positional: [], raw: false, plain: false, replyTo: null, react: null, convo: null };
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
    // (mutual exclusion validated after the loop so order doesn't matter)
    if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    result.positional.push(arg);
  }
  if (result.raw && result.plain) throw new Error('--raw and --plain are mutually exclusive');
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
 */
export function injectConvoHash(rawMessage, projectCode, convoId, { pretokensEscaped = false } = {}) {
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
    const head = projectPart ? projectPart.replace(/ $/, '') : '';
    return head ? `${head} ${esc(`[${hash}]`)}` : esc(`[${hash}]`);
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

async function postSendMessage(token, chatId, text, parseMode, replyToMessageId, messageThreadId = null) {
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  if (messageThreadId != null) payload.message_thread_id = messageThreadId;
  if (replyToMessageId != null) {
    payload.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  }
  const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.ok && body?.ok !== false,
    status: res.status,
    description: body?.description,
    messageId: body?.result?.message_id,
  };
}

async function postSendDocument(token, chatId, filePath, caption, parseMode, replyToMessageId, messageThreadId = null) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (messageThreadId != null) form.append('message_thread_id', String(messageThreadId));
  const data = fs.readFileSync(filePath);
  form.append('document', new Blob([data]), path.basename(filePath));
  if (caption) {
    form.append('caption', caption);
    if (parseMode) form.append('parse_mode', parseMode);
  }
  if (replyToMessageId != null) {
    form.append('reply_parameters', JSON.stringify({ message_id: replyToMessageId, allow_sending_without_reply: true }));
  }
  const res = await fetch(`${TELEGRAM_API}${token}/sendDocument`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body?.ok !== false, status: res.status, description: body?.description, messageId: body?.result?.message_id };
}

/**
 * Attempt to create a forum topic. Returns `{ ok, messageThreadId, description }`.
 * Failure modes we treat as "this chat doesn't support topics":
 * - HTTP 400 with descriptions like TOPIC_CREATE_DISABLED, FORUM_NOT_ENABLED,
 *   CHAT_FORUM_REQUIRED, BOT_DOMAIN_INVALID, or any 403 (permission).
 * Caller wraps the result; non-ok → negative cache + send without thread_id.
 */
async function createForumTopic(token, chatId, name) {
  const payload = { chat_id: chatId, name: String(name).slice(0, 128) };
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
 * Resolve the `message_thread_id` to use for a (chatId, projectCode) pair.
 *
 * Returns `null` if no topic should be used — either silently because the
 * chat doesn't support topics (negative cache active), or because the API
 * call to create one failed. All paths are silent: this function never
 * throws, never logs warnings to user-visible stdout. Topic discovery is
 * opportunistic; sends always proceed.
 *
 * `nowFn` and `topicsFile` are injectable for tests.
 */
// Telegram error descriptions / statuses that imply "this chat can never host
// topics from this bot" (vs. transient errors like 429 / network glitch).
// Only these set the negative cache; transient errors silently fall back
// without caching, so the next send retries.
function isPermanentNoTopicError(res) {
  if (!res) return true; // fetch itself threw
  if (res.status === 403) return true; // bot lacks permission
  const d = String(res.description ?? '');
  return /CHAT_FORUM_REQUIRED|TOPICS_FORBIDDEN|TOPIC_NOT_MODIFIED|FORUM_NOT_ENABLED|NOT_FORUM|TOPIC_CREATE_DISABLED|chat not found|user is deactivated|bot was kicked|not enough rights/i.test(d);
}

export async function resolveThreadId({ token, chatId, projectCode, nowFn = Date.now, topicsFile, fetcher = createForumTopic }) {
  if (!projectCode || projectCode.startsWith('_')) return null;
  // Best-effort: cache reads/writes must never block sending.
  let store;
  try { store = readTopicsStore(topicsFile); } catch { return null; }
  // 1. Positive cache hit — use immediately.
  const cached = getThreadId(store, chatId, projectCode);
  if (cached != null) return cached;
  // 2. Negative cache still fresh — skip API call.
  if (isNoTopicSupportFresh(store, chatId, nowFn())) return null;
  // 3. Try create.
  let res;
  try {
    res = await fetcher(token, chatId, projectCode);
  } catch {
    res = null; // fetch threw — treat as permanent
  }
  if (res && res.ok && res.messageThreadId != null) {
    // Locked RMW so we don't clobber a sibling process's positive entry.
    try { updateTopicsStore((s) => recordThreadId(s, chatId, projectCode, res.messageThreadId), topicsFile); } catch {}
    return res.messageThreadId;
  }
  // Transient errors (rate-limit / network) — don't poison the cache, just
  // skip topic this send. Permanent errors (no permission / forum disabled)
  // → negative-cache for 1h to avoid hammering Telegram.
  if (isPermanentNoTopicError(res)) {
    try { updateTopicsStore((s) => recordNoTopicSupport(s, chatId, nowFn()), topicsFile); } catch {}
  }
  return null;
}

/**
 * Detect responses that mean "the thread_id we sent no longer exists".
 * Triggers recovery: clear positive cache for that (chatId, projectCode)
 * and retry the send without thread_id.
 */
export function isTopicGoneError(description) {
  if (!description) return false;
  return /MESSAGE_THREAD_NOT_FOUND|TOPIC_DELETED|TOPIC_CLOSED/i.test(description);
}

export function dropTopicMapping(chatId, projectCode, topicsFile) {
  // Best-effort: a cache write failure must never block the send retry.
  try { updateTopicsStore((s) => clearThreadId(s, chatId, projectCode), topicsFile); } catch {}
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

async function sendTextToAdmin(token, chatId, text, opts) {
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

async function main() {
  const envFromFile = loadEnvFromFile(ENV_FILE);
  const token = process.env.REPORT_BOT_TOKEN || envFromFile.REPORT_BOT_TOKEN;
  // Project code: TELE_PROJECT_CODE env override > basename(cwd). No project-local .env reading.
  const projectCode =
    process.env.TELE_PROJECT_CODE ||
    process.env.REPORT_BOT_PROJECT_CODE ||
    path.basename(process.cwd()) ||
    '';
  const adminIds = parseAdminChatIds(
    process.env.TELEGRAM_ADMIN_CHAT_ID || envFromFile.TELEGRAM_ADMIN_CHAT_ID,
  );

  if (!token) {
    console.error('Missing REPORT_BOT_TOKEN in .env or process env.');
    process.exit(1);
  }
  if (adminIds.length === 0) {
    console.error('Missing TELEGRAM_ADMIN_CHAT_ID in .env or process env.');
    process.exit(1);
  }

  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[send-telegram] ${error.message}`);
    process.exit(1);
  }

  const botId = extractBotId(token);
  let effectiveAdminIds = adminIds;

  // Pre-resolve from env > --convo. Null = defer to --reply-to inference
  // (in maybeRecordConvo) which falls back to "new convo = this messageId".
  let preResolved = null;
  try {
    const r = resolveConvoIdFromEnv({ argConvo: typeof args.convo === 'number' ? args.convo : null });
    preResolved = r.convoId;
  } catch (e) {
    console.error(`[send-telegram] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // No pre-flight: passing `--convo <N>` auto-allocates on first use and
  // appends on subsequent uses. We address every admin chat; the chats that
  // already have an allocation row will get an append, the ones that don't
  // will get an allocation. Anti-hijack rule (the strict "must already exist"
  // check) was dropped per user request — agents are responsible for picking
  // collision-resistant convoIds (e.g. process pid + timestamp).

  const opts = { raw: args.raw, plain: args.plain, replyTo: args.replyTo };

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
        let convoIdForSend = resolveConvoIdPreSend({ preResolved, replyTo: args.replyTo, chatId, botId });
        const caption = injectConvoHash(rawCaption, projectCode, convoIdForSend, { pretokensEscaped: opts.raw });
        const threadId = await resolveThreadId({ token, chatId, projectCode });
        let sendOpts = { ...opts, messageThreadId: threadId };
        let result;
        try {
          result = await sendDocumentToAdmin(token, chatId, args.filePath, caption, sendOpts);
        } catch (e) {
          if (threadId != null && isTopicGoneError(e instanceof Error ? e.message : String(e))) {
            dropTopicMapping(chatId, projectCode);
            sendOpts = { ...opts, messageThreadId: null };
            result = await sendDocumentToAdmin(token, chatId, args.filePath, caption, sendOpts);
          } else { throw e; }
        }
        const { fallback, messageId } = result;
        if (convoIdForSend == null) convoIdForSend = messageId; // new convo
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
        '  (or pipe via stdin)',
    );
    process.exit(1);
  }

  let failures = 0;
  let lastConvoId = null;
  for (const chatId of effectiveAdminIds) {
    try {
      let convoIdForSend = resolveConvoIdPreSend({ preResolved, replyTo: args.replyTo, chatId, botId });
      const message = injectConvoHash(rawMessage, projectCode, convoIdForSend, { pretokensEscaped: opts.raw });
      const threadId = await resolveThreadId({ token, chatId, projectCode });
      let sendOpts = { ...opts, messageThreadId: threadId };
      let result;
      try {
        result = await sendTextToAdmin(token, chatId, message, sendOpts);
      } catch (e) {
        if (threadId != null && isTopicGoneError(e instanceof Error ? e.message : String(e))) {
          dropTopicMapping(chatId, projectCode);
          sendOpts = { ...opts, messageThreadId: null };
          result = await sendTextToAdmin(token, chatId, message, sendOpts);
        } else { throw e; }
      }
      const { fallback, messageId, allMessageIds } = result;
      if (convoIdForSend == null) convoIdForSend = messageId; // new convo
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
//   3. null → caller will use messageId as convoId (new convo, post-send).
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
 * `--wait-once` is the operational default for every non-Monitor runtime;
 * `--watch` remains available in source for manual use.
 */
export function listenerHintForCurrentAgent(convoId, env = process.env) {
  const convoArg = convoId != null ? ` --convo ${convoId}` : '';
  if (env.CLAUDE_CODE_SESSION_ID) {
    return `[send-telegram] ⚠️ Start a reply listener via Monitor: \`until node ../teleport/scripts/tele-listen.mjs${convoArg}; do sleep 12; done\``;
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
