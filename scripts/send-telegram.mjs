#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const TELEGRAM_API = 'https://api.telegram.org/bot';
const SENT_REGISTRY_FILE = path.join(__dirname, 'tmp', 'tele-reply', 'sent-registry.jsonl');

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

export function appendToSentRegistry(messageId, chatId, registryFile = SENT_REGISTRY_FILE) {
  if (!messageId) return;
  const dir = path.dirname(registryFile);
  fs.mkdirSync(dir, { recursive: true });
  const entry = JSON.stringify({ messageId, chatId, ts: Math.floor(Date.now() / 1000) }) + '\n';
  fs.appendFileSync(registryFile, entry, 'utf8');
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
  const result = { filePath: null, positional: [], raw: false, plain: false, replyTo: null, react: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
    if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    result.positional.push(arg);
  }
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

async function postSendMessage(token, chatId, text, parseMode, replyToMessageId) {
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
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

async function postSendDocument(token, chatId, filePath, caption, parseMode, replyToMessageId) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
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
 * Returns { ok, fallback } — `fallback: true` means Telegram rejected our
 * MarkdownV2 parse and we re-sent the chunk as a temporary `.md` document so
 * the admin still receives the content with its markdown source intact
 * (readable in Telegram's file preview), instead of collapsing to plain text.
 */
export async function sendTextChunk(token, chatId, rawChunk, { raw, plain, replyTo = null }) {
  // Helper: refuse to claim success if Telegram returned ok with no message_id.
  // The agent relies on the printed messageId to start its reply listener; a
  // silent miss would log a successful send but leave the agent unable to
  // track replies.
  const assertMessageId = (res, label) => {
    if (!res.messageId) throw new Error(`${label}: Telegram returned ok but no message_id \u2014 refusing to claim success`);
    return res.messageId;
  };

  if (plain) {
    const res = await postSendMessage(token, chatId, rawChunk, null, replyTo);
    if (res.ok) return { ok: true, fallback: false, messageId: assertMessageId(res, 'plain send') };
    throw new Error(res.description ?? `HTTP ${res.status}`);
  }
  const payload = raw ? rawChunk : escapeMarkdownV2(rawChunk);
  const first = await postSendMessage(token, chatId, payload, 'MarkdownV2', replyTo);
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
      const firstLine = rawChunk.split('\n')[0].slice(0, 100);
      const retry = await postSendDocument(token, chatId, tmpPath, firstLine, null, replyTo);
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
      const firstLine = text.split('\n')[0].slice(0, 100);
      const res = await postSendDocument(token, chatId, tmpPath, firstLine, null, opts.replyTo ?? null);
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
  const first = await postSendDocument(token, chatId, filePath, finalCaption, parseMode, opts.replyTo);
  if (first.ok) return { fallback: false, messageId: first.messageId };

  const desc = first.description ?? `HTTP ${first.status}`;
  if (parseMode && /can't parse entities|can\u2019t parse entities/i.test(desc)) {
    const retry = await postSendDocument(token, chatId, filePath, caption.slice(0, CAPTION_LIMIT), null, opts.replyTo);
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

  const opts = { raw: args.raw, plain: args.plain, replyTo: args.replyTo };

  if (args.react != null) {
    let failures = 0;
    for (const chatId of adminIds) {
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
    if (failures === adminIds.length) process.exit(1);
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
    const caption = projectCode && rawCaption ? `[${projectCode}] ${rawCaption}` : rawCaption;

    let failures = 0;
    for (const chatId of adminIds) {
      try {
        const { fallback, messageId } = await sendDocumentToAdmin(token, chatId, args.filePath, caption, opts);
        appendToSentRegistry(messageId, chatId);
        const parts = [];
        if (fallback) parts.push('caption sent as plain text');
        if (messageId) parts.push(`messageId: ${messageId}`);
        const note = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        console.log(`[send-telegram] document sent to ${chatId}${note}`);
      } catch (error) {
        failures++;
        const raw = error instanceof Error ? error.message : String(error);
        console.error(`[send-telegram] failed for ${chatId}: ${scrubToken(raw, token)}`);
      }
    }
    if (failures === adminIds.length) process.exit(1);
    if (failures < adminIds.length) console.log('[send-telegram] ⚠️ You MUST now start a reply listener (Monitor tool or foreground loop). See telegram-guide.md §Listening for Replies.');
    return;
  }

  const argText = args.positional.join(' ').trim();
  const rawMessage = (argText || readStdinIfPiped()).trim();
  const message = projectCode && rawMessage ? `[${projectCode}] ${rawMessage}` : rawMessage;
  if (!message) {
    console.error(
      'Usage:\n' +
        '  npm run tele -- "<markdown>"\n' +
        '  npm run tele -- --raw "pre-escaped MdV2"\n' +
        '  npm run tele -- --plain "no markdown"\n' +
        '  npm run tele -- --file <path> ["caption"]\n' +
        '  cat msg.md | npm run tele',
    );
    process.exit(1);
  }

  let failures = 0;
  for (const chatId of adminIds) {
    try {
      const { fallback, messageId, allMessageIds } = await sendTextToAdmin(token, chatId, message, opts);
      for (const mid of allMessageIds) appendToSentRegistry(mid, chatId);
      const parts = [];
      if (fallback === 'auto-file') parts.push('long-message → .md file');
      else if (fallback === 'parse-error-file') parts.push('markdown-parse-error → .md file');
      if (messageId) parts.push(`messageId: ${messageId}`);
      const note = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      console.log(`[send-telegram] sent to ${chatId}${note}`);
    } catch (error) {
      failures++;
      const raw = error instanceof Error ? error.message : String(error);
      console.error(`[send-telegram] failed for ${chatId}: ${scrubToken(raw, token)}`);
    }
  }

  if (failures === adminIds.length) process.exit(1);
  if (failures < adminIds.length) console.log('[send-telegram] ⚠️ You MUST now start a reply listener (Monitor tool or foreground loop). See telegram-guide.md §Listening for Replies.');
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
