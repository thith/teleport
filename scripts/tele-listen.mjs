#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { loadEnvFromFile, parseAdminChatIds, postReaction, scrubToken, sendTextChunk, extractBotId, readSentRegistry, shortConvoHash } from './send-telegram.mjs';
import {
  listDueReminders,
  markReminded,
  readPendingStore,
  recordAdminReply,
  updatePendingStore,
} from './pending-store.mjs';
import { recordAlive, getLastAliveMs, pruneStale as pruneAliveStale, DEFAULT_FRESH_MS as ALIVE_FRESH_MS } from './listener-alive.mjs';
import { readTopicsStore, getThreadId, DEFAULT_TOPICS_FILE } from './topics-store.mjs';
import { peekPersona } from './persona-store.mjs';
import { readProjectsConfig, resolveProjectConfig, resolveProjectRouting, roleFor, memberFor, adminIdsFrom, resolveDefaultChatId, resolveSendOnly, SEND_ONLY_LISTEN_REFUSAL } from './projects-config.mjs';
import { harvestMembers } from './roster-upsert.mjs';
import { recordFetchOk, listenerStaleWarning } from './listen-watch.mjs';
import {
  acquireLock as acquireConvoLock,
  appendRowLocked as appendConvoRow,
  argConvoFromArgv,
  buildConvoFilter,
  CONVO_SCHEMA_VERSION,
  DEFAULT_LOCK_FILE as CONVO_LOCK_FILE,
  DEFAULT_REGISTRY_FILE as CONVO_REGISTRY_FILE,
  hasAllocationRow,
  readRows as readConvoRows,
  releaseLock as releaseConvoLock,
  resolveConvoIdFromEnv,
  validateConvoIdString,
} from './convo-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const TELEGRAM_API = 'https://api.telegram.org/bot';

const ATTACHMENT_ERRORS = Object.freeze({
  OVERSIZE: 'exceeds_20mb',
  DOWNLOAD: 'download_failed',
});
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000;
const DOWNLOAD_OVERALL_TIMEOUT_MS = 60_000;
const ATTACHMENT_PRUNE_KEEP = 500; // match pruneCache window

class AttachmentError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const DEFAULT_TMP_DIR = path.join(__dirname, 'tmp', 'tele-reply');
export const DEFAULT_OFFSET_FILE = path.join(DEFAULT_TMP_DIR, 'last-update-id.txt');
export const SYSTEM_MSG_IDS_FILE = path.join(DEFAULT_TMP_DIR, 'system-msg-ids.jsonl');
export const SYSTEM_MSG_IDS_LOCK_FILE = path.join(DEFAULT_TMP_DIR, 'system-msg-ids.lock');
const SYSTEM_MSG_IDS_MAX = 500;
const SYSTEM_MSG_IDS_PRUNE_THRESHOLD = SYSTEM_MSG_IDS_MAX * 2;

// Compose the per-chat key used to look up a system message; Telegram message_id
// is unique only within a chat, so the key must include chat_id to avoid
// cross-chat collisions (chat A's system msg #42 vs chat B's agent msg #42).
function systemMsgKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

export async function appendSystemMsgId(chatId, messageId, file = SYSTEM_MSG_IDS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // `appendFileSync` of a short line (~70 bytes) is atomic on POSIX (< PIPE_BUF),
  // so concurrent appends from multiple listeners don't tear. The prune block
  // below (read + slice + rename), however, is NOT atomic vs. concurrent appends
  // — without a lock, another process's append between our read and rename gets
  // clobbered, losing a [SYSTEM] messageId and turning a future reply-to-system
  // into a silent drop. Serialize prune with a dedicated lock.
  fs.appendFileSync(file, JSON.stringify({ chatId: String(chatId), messageId, ts: Date.now() }) + '\n', 'utf8');
  try {
    const initialLines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (initialLines.length <= SYSTEM_MSG_IDS_PRUNE_THRESHOLD) return;
    const lockHeld = await acquireLockWithRetry(SYSTEM_MSG_IDS_LOCK_FILE);
    if (!lockHeld) return; // someone else is pruning; their write will cover us
    try {
      // Re-read inside the lock so we don't clobber appends that landed between
      // our threshold check and the lock acquisition.
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= SYSTEM_MSG_IDS_MAX) return; // another process already pruned
      const kept = lines.slice(-SYSTEM_MSG_IDS_MAX);
      const tmp = file + `.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } finally {
      releasePollLock(SYSTEM_MSG_IDS_LOCK_FILE);
    }
  } catch (e) {
    console.error(`[tele-listen] system-msg-ids prune failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function readSystemMsgIds(file = SYSTEM_MSG_IDS_FILE) {
  if (!fs.existsSync(file)) return new Set();
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const trimmed = lines.slice(-SYSTEM_MSG_IDS_MAX);
  return new Set(trimmed.map((l) => {
    try {
      const { chatId, messageId } = JSON.parse(l);
      if (chatId == null || messageId == null) return null;
      return systemMsgKey(chatId, messageId);
    } catch { return null; }
  }).filter((k) => k != null));
}
export const GLOBAL_OFFSET_FILE = path.join(DEFAULT_TMP_DIR, 'global-offset.txt');
export const DEFAULT_PROMPT_FILE = path.join(DEFAULT_TMP_DIR, 'prompt.json');
export const DEFAULT_PROMPT_PROCESSING_FILE = path.join(DEFAULT_TMP_DIR, 'prompt.processing.json');
export const UPDATES_CACHE_FILE = path.join(DEFAULT_TMP_DIR, 'updates-cache.jsonl');

/**
 * Per-bot update_id state file paths. `update_id` is a per-bot monotonic
 * sequence, so a single shared cache/global-offset mixes incomparable
 * sequences: a swapped/added bot's higher ids poison a lower bot's offsets and
 * the lower bot then drops every message (see resolveStartOffset self-heal).
 * Scoping by botId keeps each bot comparing only against its own ids. Returns
 * the shared defaults when botId is null (no-token / legacy paths) — that path
 * keeps the old single-bot behavior and is exercised by tests.
 */
export function botScopedFiles(botId, tmpDir = DEFAULT_TMP_DIR) {
  if (botId == null) {
    return { cacheFile: UPDATES_CACHE_FILE, globalOffsetFile: GLOBAL_OFFSET_FILE };
  }
  return {
    cacheFile: path.join(tmpDir, `updates-cache.${botId}.jsonl`),
    globalOffsetFile: path.join(tmpDir, `global-offset.${botId}.txt`),
  };
}

export const POLL_LOCK_FILE = path.join(DEFAULT_TMP_DIR, 'poll.lock');
export const REGISTRY_FILE = path.join(DEFAULT_TMP_DIR, 'listener-registry.jsonl');
export const REGISTRY_LOCK_FILE = path.join(DEFAULT_TMP_DIR, 'registry.lock');
export const REGISTRY_MAX_ENTRIES = 100;
const LOCK_STALE_MS = 30_000;

export function filterKey(filterReplyTo) {
  if (filterReplyTo == null) return null;
  const raw = Array.isArray(filterReplyTo) ? filterReplyTo.slice().sort((a, b) => a - b).join('-') : String(filterReplyTo);
  if (raw.length > 80) return crypto.createHash('md5').update(raw).digest('hex').slice(0, 16);
  return raw;
}

export function getPromptFile(filterReplyTo) {
  if (filterReplyTo == null) return DEFAULT_PROMPT_FILE;
  return path.join(DEFAULT_TMP_DIR, `prompt-${filterKey(filterReplyTo)}.json`);
}

export function getProcessingFile(filterReplyTo) {
  if (filterReplyTo == null) return DEFAULT_PROMPT_PROCESSING_FILE;
  return path.join(DEFAULT_TMP_DIR, `prompt-${filterKey(filterReplyTo)}.processing.json`);
}

export function readOffset(offsetFile = DEFAULT_OFFSET_FILE) {
  try {
    const raw = fs.readFileSync(offsetFile, 'utf8').trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

// Atomic write to `targetFile`: write to a process-unique temp path, then
// rename. A naked writeFileSync risks a torn/empty file if the process dies
// mid-write; subsequent readers would see 0 and (under the new-loop init path
// in resolveStartOffset) replay every still-cached update. On any failure the
// temp file is cleaned up so we don't leak `*.tmp` artifacts.
let atomicWriteCounter = 0;
function atomicWriteFileSync(targetFile, content) {
  const dir = path.dirname(targetFile);
  fs.mkdirSync(dir, { recursive: true });
  // Suffix uses pid + ms + monotonic counter to avoid collisions if two writes
  // land in the same millisecond inside one process (e.g. tests, batch runs).
  const tmp = `${targetFile}.${process.pid}.${Date.now()}.${atomicWriteCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, targetFile);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function writeOffset(updateId, offsetFile = DEFAULT_OFFSET_FILE) {
  atomicWriteFileSync(offsetFile, String(updateId + 1));
}

// Update types every harvester asks for EXPLICITLY: Telegram otherwise reuses
// whatever an earlier getUpdates/webhook set, which could silently drop the
// daemon's inline-button presses (callback_query).
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query'];

export const FETCH_UPDATES_TIMEOUT_MS = 20_000;

export async function fetchUpdates(token, offset) {
  const url = `${TELEGRAM_API}${token}/getUpdates?offset=${offset}&timeout=0&limit=100&allowed_updates=${encodeURIComponent(JSON.stringify(ALLOWED_UPDATES))}`;
  // RFC 18 B: bound the call. A hung connection otherwise holds poll.lock (and
  // the caller's whole poll) until undici gives up, around 300 s.
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_UPDATES_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(body?.description ?? `HTTP ${res.status}`);
  }
  return body.result;
}

export function parseArgs(argv) {
  let filterReplyTo = null;
  let offsetFile = DEFAULT_OFFSET_FILE;
  let offsetFileProvided = false;
  let convo = null;
  let legacyFilter = false;
  let waitOnce = false;
  let settle = false;
  let loop = false;
  let append = false;
  let announcePreexisting = false;
  let firstRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--wait-once') {
      waitOnce = true;
      continue;
    }
    if (argv[i] === '--settle') {
      settle = true;
      continue;
    }
    // --loop: the caller wraps this one-shot in a persistent shell `while`
    // (self-re-arm). OPT-IN ONLY. Its sole effect is changing the SUPERSEDE
    // exit from 0→3 so the wrapper can `break` (stand down) instead of
    // re-arming a superseded listener forever (which would re-supersede and
    // flood). The legacy `until …` command (no --loop) keeps supersede=0, so
    // its behavior — and every currently-running agent — is unchanged.
    if (argv[i] === '--loop') {
      loop = true;
      continue;
    }
    // --append (RFC 02 P3): OPT-IN. Instead of blocking (exit 2) when a prompt
    // is already pending/claimed, coalesce new messages into the OPEN prompt, or
    // spool a fresh one alongside a CLAIMED (.processing.json) batch. Default OFF
    // → single-slot behaviour, so Gemini/Codex (`--wait-once`) are unchanged.
    if (argv[i] === '--append') {
      append = true;
      continue;
    }
    // --announce-preexisting (RFC 03 §5.2): OPT-IN, requires --append. Makes the
    // listener CLAIM + announce a pre-existing UNCLAIMED prompt (a side-message
    // injected by ask/handover/steer, or one that survived the agent's death) that
    // it did not just write from Telegram — closing the Claude drainer gap (G3) and
    // survive-rebirth (G2). Default OFF → byte-identical, so production is untouched
    // until the canonical Monitor command opts in (staged flip after live smoke).
    if (argv[i] === '--announce-preexisting') {
      announcePreexisting = true;
      continue;
    }
    // --first-run (RFC 03 follow-up): OPT-IN, requires --append. Passed by the
    // canonical loop ONLY on its FIRST iteration (`${first:+--first-run}`), i.e.
    // the first poll since the agent (re)started its listener. On this poll an
    // orphan `.processing` left by a PRIOR life is RE-ANNOUNCED as-is (so the
    // reborn/resumed agent reads it now instead of waiting out PROCESSING_TTL_MS)
    // — no fold, no merge (see the poll-loop comment for why folding would risk
    // losing a spooled batch). Subsequent polls omit the flag → normal behaviour.
    if (argv[i] === '--first-run') {
      firstRun = true;
      continue;
    }
    if (argv[i] === '--legacy-filter') {
      legacyFilter = true;
      continue;
    }
    if (argv[i] === '--filter-reply-to') {
      const next = argv[i + 1];
      if (!next) throw new Error('--filter-reply-to requires a message ID argument');
      const segments = next.trim().split(',');
      const ids = segments.map((p) => {
        const s = p.trim();
        if (!/^[1-9]\d*$/.test(s)) throw new Error(`--filter-reply-to must be a positive integer message ID, got: ${s}`);
        return Number(s);
      });
      filterReplyTo = ids.length === 1 ? ids[0] : ids;
      i++;
    } else if (argv[i] === '--offset-file') {
      const next = argv[i + 1];
      if (!next) throw new Error('--offset-file requires a path argument');
      offsetFile = next;
      offsetFileProvided = true;
      i++;
    } else if (argv[i] === '--convo') {
      const next = argv[i + 1];
      if (!next) throw new Error('--convo requires a positive integer convoId');
      convo = validateConvoIdString(next.trim());
      i++;
    } else if (argv[i].startsWith('--')) {
      throw new Error(`Unknown flag: ${argv[i]}`);
    } else {
      throw new Error(`Unexpected positional argument: ${argv[i]}`);
    }
  }
  if (convo != null && filterReplyTo != null) {
    throw new Error('--convo and --filter-reply-to are mutually exclusive');
  }
  if (legacyFilter && filterReplyTo == null) {
    throw new Error('--legacy-filter requires --filter-reply-to (it suppresses the env check applied to legacy mode)');
  }
  if (waitOnce && filterReplyTo != null) {
    throw new Error('--wait-once is convo-mode only; --filter-reply-to not supported in wait-once mode');
  }
  if (announcePreexisting && !append) {
    throw new Error('--announce-preexisting requires --append (RFC 03 §5.2 — it claims+announces a pending prompt on the append/coalesce path)');
  }
  if (firstRun && !append) {
    throw new Error('--first-run requires --append (it force-reclaims an orphan .processing on the coalesce path)');
  }
  return { filterReplyTo, offsetFile, offsetFileProvided, convo, legacyFilter, waitOnce, settle, loop, append, announcePreexisting, firstRun };
}

// extractBotId is imported from send-telegram.mjs (single source of truth).

// Telegram splits media across distinct fields; a file the user "sent" can land
// in any of these. A message carries at most ONE media, but Telegram also mirrors
// an animation (GIF) into `document` for backward compatibility — so the specific
// fields must be probed BEFORE `document`, and only the first hit is taken.
// Keep this list and extractAttachments() in sync.
const MEDIA_FIELDS = ['animation', 'audio', 'voice', 'video', 'video_note', 'document'];

/**
 * Flatten Telegram's EXPANDED EDITOR payload into text.
 *
 * A message composed in the expanded (rich-text) editor arrives with NO `text`
 * and NO `caption` — the content sits in `rich_message.blocks[]`
 * (`{type: 'paragraph'|'heading'|…, text, size}`). Everything here used to read
 * `msg.text ?? msg.caption`, so such a message looked EMPTY: `hasUserContent`
 * rejected it, the listener never reacted 👍 and never delivered it — and since
 * the poll offset advances regardless, it was lost for good. (Confirmed on a real
 * update: message 1613, `rich_message` with 4 blocks, no `text` field.)
 *
 * Rendering is deliberately plain: headings keep their level as `#` markers,
 * list items become `- ` lines, everything else contributes its `text`. Empty
 * blocks are dropped so the spacer paragraphs the editor emits don't pile up.
 */
/**
 * Flatten one block's `text`, which is NOT always a string.
 *
 * Real payloads nest inline formatting arbitrarily deep: a block's `text` may be
 * a string, or an ARRAY mixing strings with `{type:'bold'|'underline'|…, text}`
 * nodes whose own `text` is again any of those forms. The first version of this
 * function assumed a plain string — true of the first captured message but NOT of
 * the very next one the owner sent, which was silently dropped again. Recurse.
 */
/**
 * The user message inside an update, whichever kind it is.
 *
 * Telegram delivers an EDIT as its own update type (`edited_message`, same
 * `message_id`, plus `edit_date`) and it arrives by default — but every intake
 * site read `u.message` only, so edits were silently ignored: the admin fixed a
 * typo or added a sentence and the agent never learned. The edited Message has
 * the identical shape, so accepting it here is enough for the whole pipeline.
 */
export function updateMessage(u) {
  return u?.message ?? u?.edited_message ?? null;
}

export function richInlineText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(richInlineText).join('');
  if (typeof node !== 'object') return '';
  // Bot API 10.1 RichText nodes: every formatting node nests its content under
  // `text` (bold/italic/underline/strikethrough/spoiler/code/mention/hashtag/…),
  // `url` nodes additionally carry the target, and a mathematical_expression
  // carries a bare string instead of nested text.
  if (typeof node.mathematical_expression === 'string') return node.mathematical_expression;
  const inner = richInlineText(node.text ?? node.content);
  if (node.type === 'url' && typeof node.url === 'string' && node.url && node.url !== inner) {
    return inner ? `${inner} (${node.url})` : node.url;
  }
  return inner;
}

/** A list block: `items[]` are OBJECTS (`{label, blocks[], has_checkbox, is_checked}`), not strings. */
function richListText(block, depth) {
  const items = Array.isArray(block.items) ? block.items : [];
  const lines = [];
  for (const it of items) {
    if (it == null) continue;
    // Be liberal: a real item is an OBJECT (`{label, blocks[], has_checkbox}`),
    // but the schema has surprised us twice already, so a bare string or an inline
    // array is accepted as the item's content rather than silently dropped.
    const isObj = typeof it === 'object' && !Array.isArray(it);
    const body = (isObj
      ? (richInlineText(it.text ?? it.content).trim() || richBlocksText(it.blocks, depth + 1))
      : richInlineText(it)).trim();
    if (!body) continue;
    const marker = isObj && it.has_checkbox
      ? (it.is_checked ? '- [x]' : '- [ ]')
      : (isObj && typeof it.label === 'string' && it.label.trim() ? it.label.trim() : '-');
    const pad = '  '.repeat(depth);
    const [first, ...rest] = body.split('\n');
    lines.push(`${pad}${marker} ${first}`);
    for (const r of rest) lines.push(`${pad}  ${r}`);
  }
  return lines.join('\n');
}

/** A table block: `cells[][]` of `{text, align}` → a markdown table. */
function richTableText(block) {
  const rows = (Array.isArray(block.cells) ? block.cells : [])
    .map((r) => (Array.isArray(r) ? r.map((c) => richInlineText(c && typeof c === 'object' ? (c.text ?? c.content) : c).replace(/\|/g, '\\|').trim()) : []));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const [head, ...body] = rows;
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

/** Media blocks carry their file under the same field names as a plain message. */
const RICH_MEDIA_LABEL = {
  photo: '[ảnh]', video: '[video]', animation: '[ảnh động]', audio: '[audio]',
  voice_note: '[voice]', collage: '[bộ ảnh]', slideshow: '[slideshow]', map: '[bản đồ]',
};

/**
 * One block → text.
 *
 * Field names differ between what a BOT SENDS (Bot API 10.1 `InputRichMessage`:
 * `content`, `header`) and what the expanded editor SENDS US (`text`, `summary`),
 * so both spellings are accepted everywhere. Block `type` values follow the
 * documented set — `section_heading`, `block_quotation`, `preformatted`,
 * `divider`, … — plus the shorter ones seen on real incoming payloads
 * (`heading`, `quote`).
 */
function richBlockText(b, depth) {
  const inline = () => richInlineText(b.text ?? b.content).trim();
  switch (b.type) {
    case 'heading':
    case 'section_heading': {
      const level = Number.isInteger(b.size) && b.size > 0 && b.size <= 6 ? b.size : 2;
      const t = inline();
      return t ? `${'#'.repeat(level)} ${t}` : '';
    }
    case 'code':
    case 'preformatted': {
      const t = inline();
      return t ? `\`\`\`\n${t}\n\`\`\`` : '';
    }
    case 'quote':
    case 'block_quotation':
    case 'pull_quotation': {
      // Documented as RichText, but a quotation may also arrive as nested blocks.
      const t = inline() || richBlocksText(b.blocks, depth);
      return t ? t.split('\n').map((l) => `> ${l}`).join('\n') : '';
    }
    case 'divider': return '---';
    case 'footer': {
      const t = inline();
      return t ? `— ${t}` : '';
    }
    case 'thinking': {
      const t = inline();
      return t ? `(suy nghĩ) ${t}` : '';
    }
    case 'mathematical_expression': {
      const t = typeof b.mathematical_expression === 'string' ? b.mathematical_expression.trim() : inline();
      return t ? `$${t}$` : '';
    }
    case 'anchor': return '';                       // a link target, no reader-visible content
    case 'list': return richListText(b, depth);
    case 'table': return richTableText(b);
    case 'details': {
      const summary = richInlineText(b.summary ?? b.header).trim();
      const body = richBlocksText(b.blocks, depth) || richInlineText(b.content).trim();
      return [summary ? `▸ ${summary}` : '', body].filter(Boolean).join('\n\n');
    }
    case 'map': {
      const loc = b.location;
      const at = loc && loc.latitude != null ? ` ${loc.latitude},${loc.longitude}` : '';
      return `${RICH_MEDIA_LABEL.map}${at}`;
    }
    case 'photo': case 'video': case 'animation': case 'audio':
    case 'voice_note': case 'collage': case 'slideshow': {
      // The bytes travel via `attachments[]` (see richMediaHolders); the text keeps
      // a marker + caption so the agent knows something was attached and where.
      const caption = richInlineText(b.caption ?? b.text ?? b.content).trim();
      const label = RICH_MEDIA_LABEL[b.type] ?? '[media]';
      return caption ? `${label} ${caption}` : label;
    }
    default: return inline() || richBlocksText(b.blocks, depth);
  }
}

/** Flatten a block list. Recursive: blocks nest inside list items and details. */
export function richBlocksText(blocks, depth = 0) {
  if (!Array.isArray(blocks)) return '';
  const out = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const t = richBlockText(b, depth);
    if (t.trim()) out.push(t);
  }
  return out.join('\n\n');
}

export function richMessageText(rich) {
  if (!Array.isArray(rich?.blocks)) return null;
  const text = richBlocksText(rich.blocks);
  return text.trim() ? text : null;
}

/** The human-readable text of a message, whichever field Telegram put it in. */
export function messageText(msg) {
  return msg?.text ?? msg?.caption ?? richMessageText(msg?.rich_message) ?? '';
}

function hasUserContent(msg) {
  if (!msg) return false;
  if (msg.text || msg.caption) return true;
  if (richMessageText(msg.rich_message)) return true;
  if (Array.isArray(msg.photo) && msg.photo.length) return true;
  return MEDIA_FIELDS.some((f) => msg[f]);
}

function sanitizeFileName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  // Strip control chars and BIDI overrides
  let name = rawName.replace(/[\x00-\x1F\u202A-\u202E\u2066-\u2069]/g, '');
  // Reduce non-[A-Za-z0-9._-] runs to _
  name = name.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Trim leading ._- and trailing dots/spaces
  name = name.replace(/^[._-]+/, '').replace(/[.\s]+$/, '');
  
  if (!name || name === '.' || name === '..' || name === '...') return null;
  
  // Windows reserved names
  const base = name.split('.')[0].toUpperCase();
  const reserved = ['CON', 'PRN', 'AUX', 'NUL'];
  if (reserved.includes(base) || /^COM[1-9]$/.test(base) || /^LPT[1-9]$/.test(base)) {
    return null;
  }
  
  // Cap at 100 chars (preserve extension when short)
  if (name.length > 100) {
    const extIdx = name.lastIndexOf('.');
    if (extIdx !== -1 && name.length - extIdx <= 10) { // e.g. .pdf, .docx
      const ext = name.slice(extIdx);
      const baseName = name.slice(0, extIdx);
      name = baseName.slice(0, 100 - ext.length) + ext;
    } else {
      name = name.slice(0, 100);
    }
  }
  return name;
}

/**
 * Media carried INSIDE a rich message's blocks.
 *
 * `extractAttachments` only ever probed top-level message fields, so a photo or
 * video composed in the expanded editor — which lands in a `photo`/`video`/…
 * BLOCK, or in a `collage`/`slideshow` block's `media[]` — produced no attachment
 * at all: the file was never downloaded and the agent never saw it. Media blocks
 * use the same field shapes as a plain message, so we return them as
 * message-shaped holders and reuse the same probe.
 */
export function richMediaHolders(rich) {
  const out = [];
  const seen = new Set();
  const walk = (blocks) => {
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (!b || typeof b !== 'object' || seen.has(b)) continue;
      seen.add(b);
      if (b.photo || MEDIA_FIELDS.some((f) => b[f])) out.push(b);
      for (const m of Array.isArray(b.media) ? b.media : []) {
        if (m && typeof m === 'object') out.push(m);
      }
      walk(b.blocks);
      for (const it of Array.isArray(b.items) ? b.items : []) {
        if (it && typeof it === 'object') walk(it.blocks);
      }
    }
  };
  walk(rich?.blocks);
  return out;
}

function extractAttachments(msg, updateId = null, botId = null) {
  const out = [];
  // All media fields share the same shape (file_id + optional
  // file_name/mime_type/file_size), so one probe covers them. `kind` keeps the
  // originating field name so callers can tell them apart. Stop at the first hit:
  // a message carries one media, and an animation also appears under `document`.
  const field = MEDIA_FIELDS.find((f) => msg[f]);
  if (field) {
    const m = msg[field];
    out.push({
      kind: field, botId, updateId,
      fileId: m.file_id,
      // voice/video_note never carry a name; audio may expose a title instead.
      fileName: m.file_name ?? m.title ?? null,
      mimeType: m.mime_type ?? null, fileSize: m.file_size ?? null,
      localPath: null, error: null,
    });
  }
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    out.push({
      kind: 'photo', botId, updateId,
      fileId: largest.file_id, fileName: null,
      mimeType: null, fileSize: largest.file_size ?? null,
      localPath: null, error: null,
    });
  }
  // Media composed in the expanded editor lives in blocks, not on the message —
  // same shapes, so the same probe applies to each holder.
  for (const holder of richMediaHolders(msg.rich_message)) {
    out.push(...extractAttachments(holder, updateId, botId));
  }
  return out;
}

async function tgGetFile(token, fileId) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), DOWNLOAD_CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/getFile?file_id=${fileId}`, { signal: ac.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body?.description ?? `HTTP ${res.status}`);
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

function guessExt(filePath) {
  if (!filePath) return '';
  const ext = path.extname(filePath);
  return ext;
}

function streamDownload(token, filePath, finalPath) {
  const partialPath = finalPath + '.partial';
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    let settled = false;
    let timeout, connectTimeout;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(connectTimeout);
      if (err) {
        ac.abort();
        try { fs.unlinkSync(partialPath); } catch {}
        reject(err instanceof AttachmentError ? err : new AttachmentError(ATTACHMENT_ERRORS.DOWNLOAD));
      } else {
        resolve();
      }
    };
    timeout = setTimeout(() => settle(new AttachmentError(ATTACHMENT_ERRORS.DOWNLOAD)), DOWNLOAD_OVERALL_TIMEOUT_MS);
    connectTimeout = setTimeout(() => settle(new AttachmentError(ATTACHMENT_ERRORS.DOWNLOAD)), DOWNLOAD_CONNECT_TIMEOUT_MS);

    const url = `https://api.telegram.org/file/bot${token}/${encodeURI(filePath)}`;
    const req = https.request(url, { signal: ac.signal }, (res) => {
      clearTimeout(connectTimeout);
      if (res.statusCode !== 200) {
        return settle(new AttachmentError(ATTACHMENT_ERRORS.DOWNLOAD));
      }
      const cl = res.headers['content-length'];
      if (!cl || isNaN(parseInt(cl, 10)) || parseInt(cl, 10) > ATTACHMENT_MAX_BYTES) {
        res.destroy();
        return settle(new AttachmentError(ATTACHMENT_ERRORS.OVERSIZE));
      }

      const ws = fs.createWriteStream(partialPath);
      let receivedBytes = 0;

      res.on('data', (chunk) => {
        if (settled) return;
        receivedBytes += chunk.length;
        if (receivedBytes > ATTACHMENT_MAX_BYTES) {
          res.destroy();
          ws.destroy();
          settle(new AttachmentError(ATTACHMENT_ERRORS.OVERSIZE));
        }
      });

      res.pipe(ws);

      ws.on('finish', () => {
        if (settled) return;
        try {
          const fd = fs.openSync(partialPath, 'r+');
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fs.renameSync(partialPath, finalPath);
          settle();
        } catch {
          settle(new AttachmentError(ATTACHMENT_ERRORS.DOWNLOAD));
        }
      });

      ws.on('error', () => settle(new AttachmentError(ATTACHMENT_ERRORS.DOWNLOAD)));
    });

    req.on('error', (err) => {
      if (err.name === 'AbortError') return; // already settled via timeout / oversize
      settle(new AttachmentError(ATTACHMENT_ERRORS.DOWNLOAD));
    });

    req.end();
  });
}

async function downloadAttachments(token, attachments, baseDir) {
  const perMessage = new Map(); // updateId -> { dir, made, count }
  for (const att of attachments) {
    if (att.error || (att.kind !== 'photo' && !MEDIA_FIELDS.includes(att.kind))) continue;
    if (att.fileSize != null && att.fileSize > ATTACHMENT_MAX_BYTES) {
      att.error = ATTACHMENT_ERRORS.OVERSIZE; continue;
    }
    let meta;
    try { meta = await tgGetFile(token, att.fileId); }
    catch { att.error = ATTACHMENT_ERRORS.DOWNLOAD; continue; }
    
    const ext = guessExt(meta.file_path);
    const synthesized = att.kind + '-' + att.fileId.slice(-12) + ext;
    const candidate =
      sanitizeFileName(att.fileName) ??
      sanitizeFileName(path.basename(meta.file_path)) ??
      sanitizeFileName(synthesized) ??
      (att.kind + '.bin');
      
    // Namespace by bot id so multiple bots sharing the same teleport tree
    // (or a single tree across token swaps) cannot collide on update_id.
    const botSegment = String(att.botId ?? 'unknown-bot');
    const key = `${botSegment}/${att.updateId}`;
    let entry = perMessage.get(key);
    if (!entry) { entry = { dir: path.join(baseDir, botSegment, String(att.updateId)), made: false, count: 0 }; perMessage.set(key, entry); }
    const indexedName = entry.count + '-' + candidate;
    entry.count += 1;
    
    try {
      if (!entry.made) { fs.mkdirSync(entry.dir, { recursive: true }); entry.made = true; }
      const finalPath = path.join(entry.dir, indexedName);
      const safeRoot = path.resolve(entry.dir) + path.sep;
      if (!path.resolve(finalPath).startsWith(safeRoot)) throw new Error('path-escape');
      await streamDownload(token, meta.file_path, finalPath);
      att.localPath = finalPath;
    } catch (err) {
      att.error = (err instanceof AttachmentError) ? err.code : ATTACHMENT_ERRORS.DOWNLOAD;
    }
  }
}

function summarizeMediaReplyTarget(replyTo) {
  if (replyTo.document) return `[document: ${replyTo.document.file_name ?? 'unknown'}]`;
  if (replyTo.photo) return '[photo]';
  return null;
}

/**
 * The message a user GENUINELY replied to, for prompt context ("replying to
 * what?"). Routing is by topic (message_thread_id), but a real reply-to is
 * still useful context for the agent. Telegram, however, sets
 * `reply_to_message` to the topic-creation service message for EVERY message
 * posted in a forum topic — that phantom is not a real reply, so surface it as
 * "no reply" rather than feeding the agent a bogus "replying to <topic-creation>"
 * target. Returns null for the phantom (and when there's no reply at all).
 *
 * Shares ONLY the `forum_topic_created` phantom signal with findOrphanMessages;
 * it deliberately does NOT replicate that function's system-message /
 * external_reply handling — those are orphan-classification concerns, whereas a
 * genuine reply to a bot message is still valid context to show the agent here.
 */
function realReplyTo(msg) {
  const replyTo = msg?.reply_to_message;
  if (!replyTo || replyTo.forum_topic_created) return null;
  return replyTo;
}

export function filterAdminMessages(updates, adminIds, filterReplyTo = null, mode = 'legacy', threadByChat = null) {
  // mode = 'legacy' : filterReplyTo is null | number | number[] | Set<number>;
  //                   matches `reply_to_message.message_id` only.
  // mode = 'convo'  : filterReplyTo is a Set<string> of `${chatId}:${messageId}`;
  //                   match requires BOTH chat and reply-target.
  //
  // threadByChat (RFC 01 team mode): a non-empty Map<chatId, threadId>. When
  // present, routing is STRUCTURAL and STRICT — a message matches iff its
  // `message_thread_id` equals this convo's owned topic IN THAT chat (keyed per
  // chat, since thread ids collide across chats — review G-C1). Reply-to is NOT
  // consulted (review G-Minor); General (no thread_id) + foreign topics ignored.
  // An empty/null map means no topic resolved yet → fall back to reply-to.
  const useThread = threadByChat instanceof Map && threadByChat.size > 0;
  let replyToSet = null;
  if (filterReplyTo != null) {
    if (filterReplyTo instanceof Set) replyToSet = filterReplyTo;
    else if (Array.isArray(filterReplyTo)) replyToSet = new Set(filterReplyTo);
    else replyToSet = new Set([filterReplyTo]);
  }
  return updates
    .filter((u) => {
      const msg = updateMessage(u);
      if (!hasUserContent(msg)) return false;
      if (adminIds.length > 0 && !adminIds.includes(String(msg.chat.id))) return false;
      if (useThread) {
        const want = threadByChat.get(String(msg.chat.id));
        return want != null && (msg.message_thread_id ?? null) === want;
      }
      // Team/convo mode with NO resolved topic map → match nothing. Do NOT fall
      // back to reply-to: a reply to an old bot message (in General or a foreign
      // topic) must not be delivered to the convo (review C-Maj1). Legacy mode
      // (IDS-filter, no convo) keeps its reply-to matching below.
      if (mode === 'convo') return false;
      // Legacy (IDS-filter) reply-to matching only — convo mode returned above.
      if (replyToSet != null) {
        const replyId = msg.reply_to_message?.message_id;
        if (replyId == null) return false;
        if (!replyToSet.has(replyId)) return false;
      }
      return true;
    })
    .map((u) => ({ update: u, msg: updateMessage(u) }));
}

/**
 * Human-readable sender name for attribution (RFC 01 P2). Prefers full name
 * ("Alice" / "Alice Nguyen"), falls back to "@username", then null. Used so a team
 * group can see WHO issued an instruction, not just a numeric user id.
 */
export function formatFromName(from) {
  if (!from) return null;
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (from.username) return `@${from.username}`;
  return null;
}

// Roles now come from projects.json (RFC 02) as a plain {userId: role} object;
// resolution + 'member' default live in projects-config.roleFor. (The old
// TELE_ROLES env Map parser was removed.)

// Agent-facing member profile. `memberFor` returns the roles-config object by
// reference and verbatim; this normalizes the NEW descriptive field `note` (keep
// only a non-empty trimmed string) on a CLONE so the shared in-memory roles
// config is never mutated. Pre-existing fields pass through unchanged. Shared by
// both prompt builders so neither can leak a blank/typed `note` to the agent.
function agentMemberFrom(roles, userId) {
  const m = memberFor(roles, userId);
  if (!m || typeof m !== 'object' || !('note' in m)) return m;
  const note = typeof m.note === 'string' ? m.note.trim() : '';
  if (note) return { ...m, note };
  const { note: _drop, ...rest } = m;
  return rest;
}

/**
 * One message, WHOLE, as it appears inside a prompt's `messages[]`.
 *
 * A batch used to be flattened into a single labeled text blob, and
 * buildCombinedPromptData kept metadata from the LAST message only — its comment
 * said outright that "reply/quote metadata from earlier messages in the batch is
 * intentionally dropped". That is why a reply-to vanished whenever the admin
 * tapped reply and then typed one more bubble inside the settle window: the two
 * coalesced and the reply-to belonged to the older half.
 *
 * The owner's requirement is that every message keeps its ID even when merged —
 * because the message being replied to may itself sit inside a merged batch, and
 * there must be a way to point at it. So the batch is now a STRUCTURE: `text`
 * stays as the human-readable rendering, `messages[]` is the truth.
 */
/**
 * An edit must be UNMISSABLE in the text, not just a field: the agent may have
 * already acted on the previous wording, so "this replaces what I said" has to
 * survive into the prose it reads. `editedAt` keeps the machine-readable form.
 */
export function editMarker(msg) {
  return msg?.edit_date != null ? '✏️ (đã sửa) ' : '';
}

export function buildPromptSegment(msg, updateId = null, botId = null, roles = null) {
  const replyTo = realReplyTo(msg);
  return {
    messageId: msg.message_id,
    edited: msg.edit_date != null,
    editedAt: msg.edit_date ?? null,
    fromUserId: String(msg.from?.id ?? msg.chat?.id),
    fromName: formatFromName(msg.from),
    fromRole: roleFor(roles, msg.from?.id),
    text: `${editMarker(msg)}${messageText(msg)}`,
    replyToMessageId: replyTo?.message_id ?? null,
    replyToText: replyTo?.text ?? replyTo?.caption ?? (replyTo ? summarizeMediaReplyTarget(replyTo) : null),
    quotedText: msg.quote?.text ?? null,
    timestamp: msg.date,
    attachments: extractAttachments(msg, updateId, botId),
  };
}

/**
 * Re-sync a SYNTHETIC prompt's single segment with its top level.
 *
 * ask/handover build a prompt from a fake message and then deliberately neuter
 * the identity ("ASK never raises privilege"): messageId/fromUserId/fromMember →
 * null, fromRole → 'agent-ask'/'handover'. Those overrides land on the top level
 * only, so the segment would keep the pre-override identity (e.g. the chat id as
 * fromUserId) — and `messages[]` is documented as the truth. Routing reads the top
 * level, so this was never a privilege escalation; it was a contradiction, which
 * is worse than useless in a security-relevant field.
 */
export function resyncPromptSegments(data) {
  if (!data || !Array.isArray(data.messages) || data.messages.length !== 1) return data;
  data.messages = [{
    ...data.messages[0],
    messageId: data.messageId ?? null,
    fromUserId: data.fromUserId ?? null,
    fromName: data.fromName ?? null,
    fromRole: data.fromRole ?? null,
    text: data.text ?? data.messages[0].text ?? '',
    attachments: [...(data.attachments ?? [])],   // copy the array; the objects stay shared
  }];
  return data;
}

/**
 * Normalize any prompt to the `messages[]` shape. A prompt written by an OLDER
 * build has no `messages` — synthesize a 1-element segment from its top-level
 * fields so merges never lose it. A legacy MULTI-message blob can't be
 * un-flattened (its per-message identities are already gone); it becomes one
 * opaque segment, which is strictly better than dropping it.
 */
export function promptSegments(data) {
  if (!data) return [];
  if (Array.isArray(data.messages) && data.messages.length > 0) return data.messages;
  return [{
    messageId: data.messageId ?? null,
    fromUserId: data.fromUserId ?? null,
    fromName: data.fromName ?? null,
    fromRole: data.fromRole ?? null,
    text: data.text ?? '',
    replyToMessageId: data.replyToMessageId ?? null,
    replyToText: data.replyToText ?? null,
    quotedText: data.quotedText ?? null,
    timestamp: data.timestamp ?? null,
    attachments: data.attachments ?? [],
  }];
}

export function buildPromptData(msg, updateId = null, botId = null, roles = null) {
  const replyTo = realReplyTo(msg);
  // One segment, and the top-level `attachments` is the SAME array object — see
  // buildCombinedPromptData for why sharing matters (in-place download hydration).
  const segment = buildPromptSegment(msg, updateId, botId, roles);
  return {
    text: segment.text,
    edited: segment.edited,
    editedAt: segment.editedAt,
    messageId: msg.message_id,
    chatId: String(msg.chat.id),
    fromUserId: String(msg.from?.id ?? msg.chat.id),
    fromName: formatFromName(msg.from),
    fromRole: roleFor(roles, msg.from?.id),
    fromMember: agentMemberFrom(roles, msg.from?.id),
    replyToMessageId: replyTo?.message_id ?? null,
    // Media-only messages have `.caption` instead of `.text`; fall back so the
    // agent still sees the human-readable context.
    replyToText: replyTo?.text ?? replyTo?.caption ?? (replyTo ? summarizeMediaReplyTarget(replyTo) : null),
    quotedText: msg.quote?.text ?? null,
    timestamp: msg.date,
    attachments: segment.attachments,
    // Always present, even for a lone message: one shape for every reader.
    messages: [segment],
  };
}

// Attribution for a coalesced multi-message batch (P2, RFC 02). Each message is
// labeled with its ACTUAL sender name + role — replaces the old hardcoded
// "Admin follow-up:" which wrongly assumed every follow-up came from the admin
// and hid WHO sent it (authority matters: admin = directive, member = context).
// Defensive: never throws; falls back to a numeric id / 'member' on any gap.
export function attributionLabel(from, roles) {
  const name = formatFromName(from) || `user ${from && from.id != null ? from.id : '?'}`;
  let role = 'member';
  try { const r = roleFor(roles, from?.id); if (r) role = r; } catch { /* keep 'member' */ }
  return `${name} (${role})`;
}

// Same "<name> (<role>)" label as attributionLabel, but built from an already-
// assembled prompt-data object (which stores fromName/fromRole/fromUserId) rather
// than a raw Telegram `from`. Used by mergePromptData to attribute a segment at
// coalesce time. Total: falls back to a numeric id / 'member' on any gap.
export function attributionLabelFromData(d) {
  const name = (d && d.fromName) || `user ${d && d.fromUserId != null ? d.fromUserId : '?'}`;
  const role = (d && d.fromRole) || 'member';
  return `${name} (${role})`;
}

/**
 * Combine multiple admin messages into one prompt entry.
 * Single message → bare text (unchanged). Multi-message batch → each line is
 * prefixed with its sender's "<name> (<role>):" attribution (P2 — replaces the
 * old blanket "Admin follow-up:" that mislabeled non-admin senders and hid who).
 * messageId/chatId/timestamp + reply & quote metadata at the TOP LEVEL are taken
 * from the LAST message (newest) so the AI replies to the right thread and every
 * existing reader keeps working unchanged. Nothing is dropped any more: each
 * message's own id/sender/reply/quote/attachments live on in `messages[]` (see
 * buildPromptSegment) — that is what lets an agent resolve a reply-to that points
 * at a message INSIDE a merged batch.
 */
export function buildCombinedPromptData(messages, botId = null, convoId = null, roles = null, projectDescription = null) {
  if (!messages.length) throw new Error('messages must not be empty');
  const [first, ...rest] = messages;
  const getText = (m) => `${editMarker(m)}${messageText(m)}`;
  const text =
    rest.length === 0
      ? getText(first.msg)
      : messages.map((m) => `${attributionLabel(m.msg.from, roles)}: ${getText(m.msg)}`).join('\n\n');
  const last = messages[messages.length - 1].msg;
  const replyTo = realReplyTo(last);

  // Build the segments FIRST and flatten them into the top-level array, so both
  // views share the SAME attachment objects: downloadAttachments mutates
  // `localPath`/`error` in place on the top-level array, and a segment holding a
  // separate copy would forever read `localPath: null` (an agent reading
  // `messages[]` would conclude the media was never downloaded).
  const segments = messages.map((m) => buildPromptSegment(m.msg, m.update?.update_id ?? null, botId, roles));
  const attachments = segments.flatMap((seg) => seg.attachments);
  
  const out = {
    text,
    // The batch as a STRUCTURE — the truth `text` is only a rendering of.
    messages: segments,
    // Batch-level: true when ANY message in it is an edit (segments keep the detail),
    // with `editedAt` = the MOST RECENT edit in the batch. Both are set here as well
    // as per-segment: the single-message path goes through this function too, and
    // leaving `editedAt` off the top level made a live edit arrive as
    // `edited: true, editedAt: null` — the flag without the timestamp.
    edited: segments.some((seg) => seg.edited),
    editedAt: segments.reduce((acc, seg) => (seg.editedAt != null && (acc == null || seg.editedAt > acc) ? seg.editedAt : acc), null),
    // RFC 02 P3: does `text` ALREADY carry per-segment `<name> (<role>):` labels?
    // A multi-message batch is pre-labeled here; a lone message stays bare. This
    // flag lets mergePromptData attribute an unlabeled segment at coalesce time
    // (so a later message from a DIFFERENT sender can't be merged in under this
    // one's identity) WITHOUT double-labeling an already-labeled batch.
    textAttributed: rest.length > 0,
    messageId: last.message_id,
    chatId: String(last.chat.id),
    fromUserId: String(last.from?.id ?? last.chat.id),
    fromName: formatFromName(last.from),
    fromRole: roleFor(roles, last.from?.id),
    fromMember: agentMemberFrom(roles, last.from?.id),
    replyToMessageId: replyTo?.message_id ?? null,
    replyToText: replyTo?.text ?? replyTo?.caption ?? (replyTo ? summarizeMediaReplyTarget(replyTo) : null),
    quotedText: last.quote?.text ?? null,
    timestamp: last.date,
    attachments,
  };
  if (convoId != null) {
    out.convoId = convoId;
    // RFC 04: tell the agent its OWN persona so it can self-identify ("Heo đây")
    // and recognize when a human addresses it by name ("Heo ơi…"). Without this
    // the persona lives only in the OUTBOUND message tag (injected by
    // send-telegram); the agent never learns the name it answers to. Read-only
    // peek: the send path is the authoritative writer (it pins with per-group
    // collision avoidance), so the listener just reports that pin and never
    // assigns one itself — avoiding a non-deduped pin if it ran first.
    const persona = peekPersona(convoId);
    if (persona != null) out.persona = persona;
  }
  // Project context (RFC 02 `description`): tell a fresh agent what this project
  // IS, so it doesn't have to infer it from the repo. Descriptive only — never a
  // directive or a privilege signal. Sanitize at this agent-facing boundary (not
  // just at the caller) so a whitespace-only / non-string value never reaches the
  // agent as a blank/typed field — the field is simply absent when there's no
  // meaningful description.
  const desc = typeof projectDescription === 'string' ? projectDescription.trim() : '';
  if (desc) out.projectDescription = desc;
  // (member `note` is normalized at source via agentMemberFrom above.)
  return out;
}

// A message that is ONLY GitHub PR link(s): in the owner's private chat the
// daemon turns it into a merge preview with buttons (daemon.mjs handlePrLinks).
export const PR_LINK_RE = /^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#]\S*)?$/;
/** The message's links if it is NOTHING but GitHub PR URLs (deduped), else null. Pure. */
export function prLinksOnly(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens.every((t) => PR_LINK_RE.test(t))) return null;
  return [...new Set(tokens)];
}

export function findOrphanMessages(updates, adminIds, systemMsgIds = new Set()) {
  return updates.filter((u) => {
    const msg = updateMessage(u);
    if (!hasUserContent(msg)) return false;
    if (msg.chat.type !== 'private') return false;
    // Link-only DMs are daemon input (merge preview), never orphans — they must
    // reach the shared cache.
    if (prLinksOnly(msg.text)) return false;
    if (adminIds.length > 0 && !adminIds.includes(String(msg.chat.id))) return false;
    // Replies to system messages (warnings the bot itself sent) are still orphans
    // from any agent's perspective — no Monitor filter will match. Treat them as
    // orphans so the user gets a fresh 💔 + warning rather than silent drop.
    //
    // Forum topic phantom-reply: Telegram automatically sets `reply_to_message`
    // to the topic-creation service message for EVERY message posted in a topic
    // (regardless of whether the user actually tapped "reply"). The reliable
    // signal that this is the phantom (not a real user reply) is the presence
    // of `reply_to_message.forum_topic_created`. Ignore phantom-reply so direct
    // typing inside a topic is correctly classified as orphan.
    if (msg.reply_to_message
        && !msg.reply_to_message.forum_topic_created
        && !systemMsgIds.has(`${msg.chat.id}:${msg.reply_to_message.message_id}`)) {
      return false;
    }
    // Bot API 7.0+: quote-replies may surface reply info in external_reply when the
    // user quoted a fragment, even if reply_to_message is absent. Treat as non-orphan.
    if (msg.external_reply) return false;
    if (msg.text && msg.text.trim().startsWith('/')) return false;
    return true;
  }).map((u) => ({ update: u, msg: updateMessage(u), orphan: true }));
}

// ── Daemon control from a group topic (RFC 08) ────────────────────────────────
// The daemon owner can drive the supervisor daemon from inside ANY topic by
// typing `/dm <cmd> <args>` (e.g. `/dm setup -100…`). Two consumers see the same
// shared cache: the per-convo AGENT and the daemon. To stop the agent from also
// answering ("giành khách"), the listener DROPS these messages from the convo
// prompt deterministically (in code, never relying on the agent's discretion);
// the daemon picks them up from the cache and dispatches them, rewriting
// `/dm <cmd>` → `/<cmd>`. ONE shared prefix so both sides agree.
//
// Name note: `dm` is overloaded (daemon vs direct-message). It is intentionally
// a single exported constant here so renaming to e.g. `sup` is a one-line change.
export const DM_CONTROL_PREFIX = 'dm';
const DM_CONTROL_RE = new RegExp(`^\\s*/${DM_CONTROL_PREFIX}(?:@[A-Za-z0-9_]+)?(?:\\s+([\\s\\S]*))?$`, 'i');

// True when `text` is a `/dm …` daemon-control message (case-insensitive,
// tolerates a `/dm@botname` suffix). A bare `/dm` still counts as control here so
// the agent never sees it; the daemon separately treats bare `/dm` as a no-op.
export function isDmControlMessage(text) {
  return typeof text === 'string' && DM_CONTROL_RE.test(text);
}

// Rewrite `/dm <cmd> <args>` → `/<cmd> <args>` for the daemon dispatcher. Returns
// null when `text` isn't a /dm-control message OR carries no inner command (bare
// `/dm`). Accepts the inner command with or without its own leading slash.
export function stripDmControlPrefix(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(DM_CONTROL_RE);
  if (!m) return null;
  const inner = (m[1] ?? '').trim();
  if (!inner) return null;
  return inner.startsWith('/') ? inner : `/${inner}`;
}

// Adaptive settle windows (per maintainer): the fixed 12s/8s was too short for
// phone typing — observed inter-bubble gaps were ~9–27s, so short windows split
// one thought into several prompts. Three tiers keyed to how likely MORE is
// still coming (more signals → wider quiet window before we deliver):
export const SETTLE_MS_A = 30_000; // both "more-coming" signals
export const SETTLE_MS_B = 20_000; // exactly one signal
export const SETTLE_MS_C = 10_000; // neither → looks like a complete thought
export const SETTLE_TIERS = { a: SETTLE_MS_A, b: SETTLE_MS_B, c: SETTLE_MS_C };

// Back-compat: some callers/tests imported these. Anchor them to the widest (A)
// and narrowest (C) so nothing references an undefined symbol.
export const DEFAULT_SETTLE_MS = SETTLE_MS_A;
export const DEFAULT_SETTLE_FOLLOWUP_MS = SETTLE_MS_C;

export const WAIT_SIGNAL_MS = 60_000; // explicit "wait for the next bubble" (ends with a comma)

// Explicit, user-typed OVERRIDE of the settle window, read from how the NEWEST
// message ENDS (maintainer request). Beats the adaptive heuristic:
//  - ends with EXACTLY ".." (two dots — NOT an ellipsis "...") → 0 = deliver NOW,
//    no debounce ("I'm done").
//  - ends with a comma (","/",,"/… any count) → WAIT_SIGNAL_MS grace for the next
//    bubble ("I'm still typing").
//  - otherwise → null → fall through to the adaptive tier.
// Trailing whitespace is ignored. Returns the override window (ms) or null.
export function settleOverride(newestMsg) {
  const t = messageText(newestMsg).trimEnd();
  if (t.endsWith('..') && !t.endsWith('...')) return 0;   // exactly two trailing dots
  if (t.endsWith(',')) return WAIT_SIGNAL_MS;             // any number of trailing commas
  return null;
}

/**
 * Count the "more is still coming" signals on the NEWEST message of a batch (0–2):
 *  - single: the batch is a lone message (nothing coalesced yet) — likely the
 *    START of a multi-bubble input, so wait longer for the rest.
 *  - fragment: the newest message is forwarded, carries a photo, or its text is
 *    shorter than 20 chars — an incomplete piece; the human is probably still
 *    adding context.
 */
export function settleSignals(newestMsg, count) {
  const single = count === 1 ? 1 : 0;  // exactly one message (a lone bubble = the "first", nothing coalesced yet)
  const text = messageText(newestMsg);
  const forwarded = !!(newestMsg?.forward_origin || newestMsg?.forward_from || newestMsg?.forward_date);
  const hasPhoto = Array.isArray(newestMsg?.photo) && newestMsg.photo.length > 0;
  const fragment = forwarded || hasPhoto || text.length < 20;
  return single + (fragment ? 1 : 0);
}

/**
 * Adaptive settle window for a batch, keyed to settleSignals: 2→A, 1→B, 0→C.
 * Tier values are env-overridable (TELE_SETTLE_A_MS/_B_MS/_C_MS at the call site).
 * Exported for tests.
 */
export function settleWindowFor(newestMsg, count, tiers = SETTLE_TIERS) {
  const override = settleOverride(newestMsg);
  if (override !== null) return override;  // ".." → 0 (now), "," → 60s; else adaptive
  const met = settleSignals(newestMsg, count);
  return met >= 2 ? tiers.a : met === 1 ? tiers.b : tiers.c;
}

/**
 * Burst-settle (debounce) decision. A user often types one task across several
 * Telegram bubbles; acting on the first bubble alone builds an incomplete
 * prompt and forces a wasteful second pass. Return true to DEFER the batch —
 * hold it until the newest message has been quiet for the adaptive window (see
 * settleWindowFor), so consecutive bubbles coalesce into one combined prompt.
 *
 * Pure + total so it is unit-testable in isolation from main()'s process.exit:
 * - Empty batch → never defer (nothing to hold).
 * - effective window <= 0 / non-finite → debounce disabled → never defer.
 * - A message dated in the FUTURE vs `now` (age < 0) is clock skew on a
 *   mis-synced host → do NOT defer (degrade to immediate release rather than
 *   risk deferring forever). Only a batch whose newest message is younger than
 *   the window (0 <= age < window) defers.
 */
export function shouldSettleBatch(toProcess, now = Date.now(), tiers = SETTLE_TIERS) {
  if (!Array.isArray(toProcess) || toProcess.length === 0) return false;
  // The newest message drives both the age check and the signal-based window.
  const newestEntry = toProcess.reduce((a, b) => ((b.msg?.date ?? 0) >= (a.msg?.date ?? 0) ? b : a));
  const windowMs = settleWindowFor(newestEntry.msg, toProcess.length, tiers);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return false;
  const newestMs = (newestEntry.msg?.date ?? 0) * 1000;
  const age = now - newestMs;
  return age >= 0 && age < windowMs;
}

export function collectMessagesToProcess(updates, adminIds, filterReplyTo, mode = 'legacy', threadByChat = null) {
  return filterAdminMessages(updates, adminIds, filterReplyTo, mode, threadByChat)
    // Drop `/dm …` daemon-control commands so this convo's AGENT never handles
    // them — they belong to the supervisor daemon, which reads the same shared
    // cache independently (RFC 08). Dropping here is the deterministic guard that
    // prevents the agent and the daemon from both acting on one message.
    .filter((m) => !isDmControlMessage(m.msg?.text));
}

/**
 * Resolve the start offset for a loop.
 *
 * - Existing loop (per-loop file > 0): use its own offset (it has been advancing
 *   itself; never roll back).
 * - New loop (per-loop file missing or 0): initialize from min(cache, global).
 *   We can't simply inherit globalOffset because another loop may have already
 *   advanced it past updates still sitting in our shared cache that the new
 *   loop needs to see (its filter may match them). Starting from the oldest
 *   cached update_id guarantees a new loop reads every update currently
 *   buffered locally, even ones already "consumed" by other loops' offset
 *   advances. Cache pruning keeps this bounded (last 500 updates).
 */
export function resolveStartOffset(
  offsetFile,
  globalOffsetFile = GLOBAL_OFFSET_FILE,
  cacheFile = UPDATES_CACHE_FILE,
) {
  const perLoop = readOffset(offsetFile);
  // Stable read: also tells us if the newest line is a torn (in-flight) append,
  // so the self-heal below doesn't act on a transiently-low maxCached.
  const { entries: cache, tornTail } = readCacheStable(cacheFile);
  // Highest update_id this bot has ever cached. Use reduce (not Math.max spread)
  // for the same call-stack reason as below.
  const maxCached = cache.reduce(
    (m, u) => (u.update_id > m ? u.update_id : m),
    0,
  );

  if (perLoop > 0) {
    // Self-heal contaminated offsets. `advanceLoopOffset` only ever sets the
    // per-loop offset to THIS bot's own cache-max + 1, so a stored offset can
    // never legitimately exceed `maxCached + 1`. If it does, the offset was
    // poisoned by another bot's update_id sequence that shared the cache before
    // per-bot cache files landed (a removed/swapped bot leaves higher ids
    // behind; `update_id` is per-bot and not comparable across bots). Reset and
    // re-initialize so the convo can read its own messages again instead of
    // filtering them all out forever. Only act once the bot's own cache is
    // populated (maxCached > 0); an empty cache can't tell us anything yet.
    // Skip on a torn tail (maxCached may be transiently low) — heal next poll.
    let poisoned = maxCached > 0 && !tornTail && perLoop > maxCached + 1;
    if (poisoned) {
      // Confirm against a fresh read before the (destructive) reset. The first
      // read happens outside the poll lock, so a concurrent appendToCache() can
      // be observed truncated. A mid-line tear is caught by `tornTail`, but a
      // tear on a newline boundary parses cleanly and only understates
      // maxCached — which would look like contamination and trigger a spurious
      // rollback (duplicate delivery). The write is a single appendFileSync
      // syscall, so a back-to-back re-read almost always sees the completed
      // file; only heal if the contamination still holds. Off the hot path —
      // a caught-up offset returns above without ever reaching here.
      const confirm = readCacheStable(cacheFile);
      const confirmMax = confirm.entries.reduce(
        (m, u) => (u.update_id > m ? u.update_id : m),
        0,
      );
      poisoned = !confirm.tornTail && confirmMax > 0 && perLoop > confirmMax + 1;
    }
    if (poisoned) {
      console.error(
        `[tele-listen] per-loop offset ${perLoop} exceeds bot cache max ${maxCached}+1 ` +
        `(cross-bot contamination) — resetting ${path.basename(offsetFile)}`,
      );
      // fall through to re-init below
    } else {
      return perLoop;
    }
  }

  const globalOffset = readOffset(globalOffsetFile);
  let startOffset = globalOffset;

  // If the cache has entries older than globalOffset, prefer the oldest cached
  // update_id so we don't miss updates that other loops have already pulled in.
  //
  // Known limitation: the cache is shared across all conversations on this bot.
  // If the caller's filter happens to match an old cached reply (e.g. resuming
  // an older conversation whose IDS list still contains messageIds replied to
  // long ago), that reply will be re-surfaced. The script does not maintain a
  // "processed update_id" ledger, so a prompt file may be written for an update
  // that an earlier session already handled — the Monitor will fire, and the
  // owning agent may re-reply unless it is defensive about the notification
  // (see telegram-guide.md §Notes — "Duplicate safety (partial)"). A future
  // fix can persist a per-loop highest-processed update_id set instead of
  // relying on a single offset.
  if (cache.length > 0) {
    // Use reduce instead of Math.min(...spread) to avoid call-stack limits if
    // the cache cap is ever raised above the JS argument limit.
    const minCached = cache.reduce(
      (m, u) => (u.update_id < m ? u.update_id : m),
      Infinity,
    );
    if (Number.isFinite(minCached) && minCached > 0 && (startOffset === 0 || minCached < startOffset)) {
      // A fresh convo listener deliberately replays everything still in the
      // shared cache that matches its filter. That lets a restarted convo pick
      // up replies fetched by another loop. Cache pruning bounds the replay
      // window to the retained cache (currently 500 updates).
      startOffset = minCached;
    }
  }

  if (startOffset > 0) atomicWriteFileSync(offsetFile, String(startOffset));
  return startOffset;
}


export function acquirePollLock(lockFile = POLL_LOCK_FILE) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      // An EMPTY/garbled lock (we died, or the disk was full, between create and
      // write) used to read as NaN = "never stale" and wedged every listener for
      // good. Fall back to the file's mtime for its age.
      const lockTime = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
      const age = Date.now() - (isNaN(lockTime) ? fs.statSync(lockFile).mtimeMs : lockTime);
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(lockFile);
        return acquirePollLock(lockFile);
      }
    } catch {}
    return false;
  }
  // Body = "<ms>:<pid>:<random>": unique per acquisition (release checks it) and
  // parseInt still reads the timestamp, so the stale check above is unchanged.
  const token = `${Date.now()}:${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeSync(fd, token);
  } catch (e) {
    // e.g. ENOSPC: don't leave an empty lock behind.
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
    throw e;
  }
  fs.closeSync(fd);
  heldLockTokens.set(path.resolve(lockFile), token);
  return true;
}

// lock path → the token THIS process wrote when it acquired it. A process holds
// a given lock at most once at a time (acquire is O_EXCL), so a path key is enough.
const heldLockTokens = new Map();

/** The token this process holds for `lockFile`, or null. (Tests / diagnostics.) */
export function heldPollLockToken(lockFile = POLL_LOCK_FILE) {
  return heldLockTokens.get(path.resolve(lockFile)) ?? null;
}

// RFC 18 B: unlink only if the file still carries OUR token. If we overran
// LOCK_STALE_MS (e.g. a hung fetch) a peer may have reclaimed the lock and
// written its own token; deleting it would let a third poller in alongside it.
// Not holding a token (never acquired / already released) → no-op.
export function releasePollLock(lockFile = POLL_LOCK_FILE) {
  const key = path.resolve(lockFile);
  const mine = heldLockTokens.get(key);
  if (mine == null) return;
  heldLockTokens.delete(key);
  let body;
  try { body = fs.readFileSync(lockFile, 'utf8'); } catch { return; }
  // Residual read→unlink window is microseconds, vs the 30 s LOCK_STALE_MS a peer must wait to reclaim.
  if (body.trim() !== mine) return;
  try { fs.unlinkSync(lockFile); } catch {}
}

export function appendToCache(updates, cacheFile = UPDATES_CACHE_FILE) {
  if (!updates.length) return;
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const lines = updates.map((u) => JSON.stringify(u)).join('\n') + '\n';
  fs.appendFileSync(cacheFile, lines, 'utf8');
}

export function readCache(cacheFile = UPDATES_CACHE_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(cacheFile, 'utf8');
  } catch {
    return [];
  }
  // Telegram update_ids are globally unique, so any repeat is a DUPLICATE APPEND
  // — the cache is a shared "co-op" file that several listeners (and the daemon)
  // append to, with no per-write dedup, so the same update can land more than
  // once (e.g. two pollers fetch the same batch before either advances the
  // offset). Dedup by update_id on read (keep first seen, preserve order) so a
  // consumer never sees an update twice — otherwise buildCombinedPromptData
  // would aggregate the repeats into a prompt that says the same thing N times.
  const seen = new Set();
  const results = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    let u;
    try { u = JSON.parse(line); } catch { continue; }
    const id = u && u.update_id;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    results.push(u);
  }
  return results;
}

export function readCacheSinceOffset(offset, cacheFile = UPDATES_CACHE_FILE) {
  return readCache(cacheFile).filter((u) => u.update_id >= offset);
}

/**
 * Like readCache, but also reports whether the file's final non-empty line
 * failed to parse — a torn tail, i.e. a concurrent appendToCache() write seen
 * mid-flight (appendFileSync of a large batch is not guaranteed atomic, and
 * resolveStartOffset reads the cache OUTSIDE the poll lock). The offset
 * self-heal skips a torn read so dropping the newest line can't understate the
 * observed max and make a legitimate caught-up offset look poisoned.
 *
 * Caveat: this only catches a MID-LINE tear. A concurrent write observed on a
 * newline boundary parses cleanly (just understates max), so resolveStartOffset
 * additionally CONFIRMS a suspected contamination with a second read before
 * resetting — see the heal branch there.
 */
export function readCacheStable(cacheFile = UPDATES_CACHE_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(cacheFile, 'utf8');
  } catch {
    return { entries: [], tornTail: false };
  }
  const lines = raw.trim().split('\n').filter((l) => l);
  const entries = [];
  let tornTail = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      // Only the LAST line being unparseable indicates an in-flight append;
      // a malformed interior line is pre-existing corruption (readCache skips
      // it) and should not block the self-heal.
      if (i === lines.length - 1) tornTail = true;
    }
  }
  return { entries, tornTail };
}

export function pruneCache(maxEntries = 500, cacheFile = UPDATES_CACHE_FILE) {
  const all = readCache(cacheFile);
  if (all.length <= maxEntries) return;
  const kept = all.slice(-maxEntries);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = cacheFile + `.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, kept.map((u) => JSON.stringify(u)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, cacheFile);
}

export function partitionOrphans(fetched, adminIds, systemMsgIds = new Set()) {
  const orphanEntries = findOrphanMessages(fetched, adminIds, systemMsgIds);
  const orphanIds = new Set(orphanEntries.map((e) => e.update.update_id));
  return {
    orphans: orphanEntries,
    nonOrphan: fetched.filter((u) => !orphanIds.has(u.update_id)),
  };
}

/**
 * Heartbeat auto-reminder: scan pending-store for entries past REMIND_AFTER_MS
 * with no remind yet, send one nudge each, mark `remindedAt`. Sent as plain
 * text to first admin (no convo context — system-level notification).
 * Best-effort; failures logged but not propagated.
 */
// Inter-admin send throttle for fan-out reminders. Telegram global limit is
// 30 msg/sec; we space at 50ms (= 20 msg/sec headroom) to be safe.
const ADMIN_FANOUT_DELAY_MS = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Quiet hours: when `QUIET_HOURS_START` and `QUIET_HOURS_END` (0–23) are set,
 * the heartbeat skips auto-reminders during that window. END is exclusive
 * (start=22, end=8 ⇒ 22:00–07:59). Wraps across midnight.
 *
 * Timezone is whatever `Date.getHours()` resolves to in the listener
 * process — set `TZ=...` in the service env if the host TZ differs from
 * the user's local time.
 *
 * Pending entries are NOT marked reminded while quiet, so they fire on the
 * next heartbeat after the window ends. Note `PENDING_MAX_AGE_MS` (24h) still
 * applies — a very long quiet window can leave little headroom before TTL.
 */
function parseHour(raw) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  // Reject empty or non-numeric (e.g. "8h", "8 am") — parseInt would silently
  // accept these and quietly mis-configure the window.
  if (!/^\d{1,2}$/.test(s)) return NaN;
  return parseInt(s, 10);
}
export function isQuietHour(now = new Date(), env = process.env) {
  const start = parseHour(env.QUIET_HOURS_START);
  const end = parseHour(env.QUIET_HOURS_END);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || start > 23 || end < 0 || end > 23) return false;
  if (start === end) return false;
  const h = (now instanceof Date ? now : new Date(now)).getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

// Per-process throttle for `pruneAliveStale`. Run at most once per hour —
// files only age out at 24h, so finer cadence wastes syscalls.
const PRUNE_ALIVE_INTERVAL_MS = 60 * 60 * 1000;
let lastAlivePruneMs = 0;
function maybePruneAlive(now) {
  if (now - lastAlivePruneMs < PRUNE_ALIVE_INTERVAL_MS) return;
  lastAlivePruneMs = now;
  try { pruneAliveStale({ now }); } catch {}
}

// Register a successfully-sent system message (a command/reminder output the bot
// itself produced) so that a later admin reply to it is classified as an orphan
// (💔 + "reply to a regular message" hint) rather than routed to an agent as a
// prompt. Skips: a .md-fallback send (not a [SYSTEM]-class message), and any
// non-object / no-messageId return (e.g. an injected sendText returning `true`).
// Exported so the registration decision is unit-tested directly.
export async function maybeRecordSystemMsg(res, chatId, recordSystemMsgId) {
  if (res && res.messageId && !res.fallback) {
    try { await recordSystemMsgId(chatId, res.messageId); }
    catch (e) { console.error(`[tele-listen] system-msg-id register failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

export async function runHeartbeatReminders(token, adminIds, { sendText, now = Date.now(), storeFile, quietHours, getLastAliveMs: getLastAliveMsArg = getLastAliveMs, aliveFreshMs = ALIVE_FRESH_MS, recordSystemMsgId = appendSystemMsgId } = {}) {
  // Quiet-hours: the caller (daemon) passes the resolved `{start,end}` window
  // (from projects.json `_config.quietHours`). When omitted, fall back to the
  // process.env QUIET_HOURS_* (legacy / direct-test path). Either way the pure
  // isQuietHour does the wrap-midnight + range validation.
  const qhEnv = quietHours
    ? { QUIET_HOURS_START: quietHours.start == null ? '' : String(quietHours.start), QUIET_HOURS_END: quietHours.end == null ? '' : String(quietHours.end) }
    : process.env;
  if (isQuietHour(new Date(now), qhEnv)) return 0;
  const sendImpl = sendText ?? (async (chatId, text, convoId) => {
    try {
      // Team mode: a reminder belongs in the convo's OWN topic, never General
      // (review G2-Critical). If the convo has no topic in this chat, SKIP the
      // reminder rather than leak it to General (it self-heals on next bot send).
      const threadId = getThreadId(readTopicsStore(), chatId, String(convoId));
      if (threadId == null) {
        console.error(`[tele-listen] reminder skipped for convo ${convoId} in ${chatId}: no forum topic (won't post to General)`);
        return false;
      }
      const res = await sendTextChunk(token, chatId, text, { raw: false, plain: true, messageThreadId: threadId });
      // Register the reminder message as a system message: replying to a
      // "⏰ Pending reminder" is a natural admin action, and that reply has no
      // agent thread to belong to — the orphan path is the correct routing.
      await maybeRecordSystemMsg(res, chatId, recordSystemMsgId);
      return true;
    } catch (e) {
      console.error(`[tele-listen] reminder send failed to ${chatId}: ${scrubToken(e instanceof Error ? e.message : String(e), token)}`);
      return false;
    }
  });
  if (!adminIds || adminIds.length === 0) return 0;
  let sent = 0;
  try {
    const store = readPendingStore(storeFile);
    const due = listDueReminders(store, { now, getLastAliveMs: getLastAliveMsArg, aliveFreshMs });
    // Throttled prune of stale alive files. readdir+stat per file is cheap,
    // but the heartbeat runs every 5–15s and there's no signal value in
    // pruning more than once an hour (files only age out at 24h).
    maybePruneAlive(now);
    for (const entry of due) {
      // Claim-before-send: mark reminded atomically BEFORE dispatching, so a
      // second concurrent listener observing the same `due` set sees the mark
      // and skips (listDueReminders excludes entries with remindedAt set).
      // Trade-off: a send failure here loses the reminder until the next bot
      // send resets `remindedAt`. We prefer "missed reminder" over "duplicate
      // reminder spam" — duplicates are user-facing noise; misses are silent
      // and self-heal on next send.
      let claimed = false;
      try {
        updatePendingStore((s) => {
          // Re-read the entry inside the lock; if a peer already marked it,
          // skip this iteration (proceed === false aborts the write).
          const e = s[String(entry.convoId)];
          if (e && e.remindedAt) return false;
          markReminded(s, { convoId: entry.convoId, now });
          claimed = true;
        }, storeFile);
      } catch (e) {
        console.error(`[tele-listen] reminder claim failed for convo ${entry.convoId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!claimed) continue;
      const elapsedH = Math.floor(entry.elapsedMs / 3_600_000);
      const text = `⏰ Pending reminder: ${entry.project ?? '?'} convo #${shortConvoHash(entry.convoId)} has been waiting ${elapsedH}h+ for your reply (msg ${entry.lastBotSendMessageId}).`;
      // Fan-out to ALL admins so multi-admin setups don't lose reminders.
      // Throttle inter-admin sends (50ms) to stay under Telegram's 30 msg/sec
      // global rate limit even when many reminders come due at once.
      for (let i = 0; i < adminIds.length; i++) {
        const chatId = adminIds[i];
        try {
          await sendImpl(chatId, text, entry.convoId);
        } catch (e) {
          console.error(`[tele-listen] reminder send failed for convo ${entry.convoId} to ${chatId}: ${scrubToken(e instanceof Error ? e.message : String(e), token)}`);
        }
        if (i < adminIds.length - 1) await sleep(ADMIN_FANOUT_DELAY_MS);
      }
      sent++;
    }
  } catch (e) {
    console.error(`[tele-listen] heartbeat reminder scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return sent;
}

export async function reactToOrphans(token, orphanEntries, systemMsgIds = new Set()) {
  const reacted = [];
  for (const entry of orphanEntries) {
    const chatId = String(entry.msg.chat.id);
    const msgId = entry.msg.message_id;
    try {
      const { ok, description } = await postReaction(token, chatId, msgId, '💔');
      if (ok) reacted.push(entry);
      else console.error(`[tele-listen] orphan react rejected for ${msgId}: ${description}`);
    } catch (e) {
      console.error(`[tele-listen] orphan react failed for ${msgId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Orphans are private-chat messages (findOrphanMessages is private-only).
    // Teleport now runs ONLY in forum groups, so a private DM to the bot is the
    // wrong place — guide the user to the group instead of leaving them confused.
    // Once per orphan (orphans are partitioned out of the cache by the
    // centralized fetch, so this never duplicates across loops).
    const text =
      '[SYSTEM] Teleport chạy trong GROUP bật Topics, không qua chat riêng với bot. '
      + 'Hãy nhắn trong group (đúng topic của agent). Xem README để setup group.';
    try {
      const res = await sendTextChunk(token, chatId, text, { plain: true, replyTo: msgId });
      // Track the system message's own messageId so a user replying to *it*
      // (instead of an agent message) is also detected as orphan on the next
      // fetch — otherwise it would silently drop (no Monitor filter knows it).
      // Skip recording if sendTextChunk fell back to .md document (long text or
      // markdown parse error) — that .md is not a [SYSTEM] message.
      if (res?.messageId && !res.fallback) await appendSystemMsgId(chatId, res.messageId);
    } catch (e) {
      console.error(`[tele-listen] orphan reply-hint failed for ${msgId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return reacted;
}

export async function reactToMessages(token, messages) {
  for (const entry of messages) {
    const chatId = String(entry.msg.chat.id);
    const msgId = entry.msg.message_id;
    let success = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { ok, description } = await postReaction(token, chatId, msgId);
        if (ok) { success = true; break; }
        console.error(`[tele-listen] react rejected for ${msgId} (attempt ${attempt + 1}): ${description}`);
      } catch (e) {
        console.error(`[tele-listen] react failed for ${msgId} (attempt ${attempt + 1}): ${e instanceof Error ? e.message : String(e)}`);
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 5000));
    }
    if (!success) console.error(`[tele-listen] react gave up for ${msgId} after 2 attempts`);
  }
}

// Listener registry: lets a listener detect that another listener with a strictly
// broader filter (= the same conversation's newer Monitor) is alive, and self-exit.
// Cross-conversation safety is by *convention*, not construction: each agent must
// only put its own bot-sent messageIds in `--filter-reply-to`. So two different
// conversations' filter sets are disjoint, and strict-superset can only match
// intra-conversation. See telegram-guide.md §Auto-supersede.

/**
 * Liveness probe. Returns true iff the OS still has a process at `pid`.
 * `process.kill(pid, 0)` performs the existence check without sending a signal.
 * EPERM = exists but we can't signal it (still alive). ESRCH = no such process.
 * Anything else is logged so a future macOS/kernel quirk is visible, not silent.
 */
export function isProcessAlive(pid) {
  // Reject PID 1 (init/launchd) explicitly — a listener reparented to init
  // would otherwise look "alive forever" because kill(1,0) returns EPERM and
  // we treat that as alive. There is no legitimate scenario for the Monitor
  // wrapper to be PID 1, so refuse it.
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (!e || typeof e !== 'object') return false;
    if (e.code === 'EPERM') return true;
    if (e.code === 'ESRCH') return false;
    console.error(`[tele-listen] unexpected kill(${pid}, 0) error: ${e.code ?? e.message}`);
    return false;
  }
}

/**
 * Capture a process's start time so we can detect PID reuse later.
 * Returns a string identifier (lstart from `ps`) or null on failure.
 * The exact format doesn't matter — we only compare for equality.
 * Important: pass pid as an arg with `execFileSync` to avoid shell injection.
 */
export function getProcessStartTime(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;

  // Linux fast path: /proc/<pid>/stat field 22 is starttime in clock ticks
  // since boot. Stable per process, equality-comparable, no subprocess. Works
  // on every Linux (incl. Alpine/BusyBox where `ps -o lstart=` is missing).
  // The `comm` field (parenthesized) may contain spaces/parens, so we slice
  // after the LAST ')' to avoid mis-splitting.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    // After ')<sp>', fields begin at index 0 = state (field 3 in 1-indexed).
    // We want field 22 = index 22 - 3 = 19.
    const starttime = afterComm.split(' ')[19];
    if (starttime && /^\d+$/.test(starttime)) return `proc:${starttime}`;
  } catch {
    // /proc not available (macOS, restricted env) — fall through to ps.
  }

  // macOS + most GNU/Linux: `ps -o lstart=` is the portable identifier.
  // LC_ALL=C pins month/day names so writer-vs-reader locale skew can't
  // make a live process look like a different one. Tag the return value so
  // a proc-flavored startTime never accidentally compares equal to a
  // ps-flavored one (different format, same machine — paranoia, since one
  // host normally produces one flavor).
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    return out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

/**
 * Liveness with PID-reuse protection. A registry entry is "live" only if the
 * process at entry.pid is still alive AND its current start time matches what
 * we recorded when the entry was written. If the recorded `startTime` is
 * absent (legacy or capture failed), we fall back to plain isProcessAlive —
 * the entry will eventually be refreshed with a startTime by its owner.
 */
export function isLiveEntry(entry) {
  if (!entry || !Number.isFinite(entry.pid) || entry.pid <= 0) return false;
  if (!isProcessAlive(entry.pid)) return false;
  if (!entry.startTime) return true;
  const current = getProcessStartTime(entry.pid);
  if (!current) return false;
  return current === entry.startTime;
}

export function readRegistry(file = REGISTRY_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  let parseFailures = 0;
  let totalLines = 0;
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    totalLines++;
    try { out.push(JSON.parse(line)); }
    catch { parseFailures++; }
  }
  if (parseFailures > 0) {
    console.error(`[tele-listen] registry: dropped ${parseFailures}/${totalLines} malformed line(s)`);
  }
  return out;
}

function writeRegistry(entries, file = REGISTRY_FILE) {
  // Always rewrite via atomic rename — even an empty registry uses an empty
  // file rather than unlink, so we don't race a peer's read against an
  // intermediate "file gone" state and silently lose entries.
  const content = entries.length === 0 ? '' : entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  atomicWriteFileSync(file, content);
}

/**
 * Acquire `lockFile` via O_EXCL with bounded async retries. Returns true on success.
 * Pattern mirrors acquirePollLock (sync), wrapped in a polling retry loop so
 * callers can `await` instead of busy-spinning. Stale locks are inherited from
 * acquirePollLock's existing LOCK_STALE_MS reclaim.
 */
async function acquireLockWithRetry(lockFile, { maxAttempts = 50, retryMs = 20 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (acquirePollLock(lockFile)) return true;
    // Jitter: two listeners launched at the same instant otherwise retry in
    // lockstep and keep colliding on the same windows.
    const jitter = Math.floor(Math.random() * retryMs);
    await new Promise((r) => setTimeout(r, retryMs + jitter));
  }
  return false;
}

/**
 * Refresh registry: drop dead entries + dedupe by pid + add/update mine.
 * Guarantees at most one entry per `pid` (load-bearing for findSuperseder's
 * self-exclusion: when iterating, we skip my own pid; with only one entry per
 * pid that's sufficient).
 *
 * Lock-protected: two listeners refreshing concurrently must not lose entries.
 * If lock can't be acquired (very rare), we fall back to a best-effort
 * read-only path: we still return the most recent on-disk registry so the
 * caller's supersede check works, but we don't write our own entry this round.
 * The next invocation 12s later will retry — eventual consistency.
 */
export async function refreshRegistry({
  pid,
  filter,
  offsetFile,
  convoId = null,
  // true = a persistent --loop listener; false = a one-shot run (the bare
  // pre-critical-action drain, a --wait-once child, the legacy `until` loop).
  // null = unknown (legacy caller) — treated like a --loop row by peers.
  loop = null,
  file = REGISTRY_FILE,
  lockFile = REGISTRY_LOCK_FILE,
  now = Date.now(),
  startTime = getProcessStartTime(pid),
  maxEntries = REGISTRY_MAX_ENTRIES,
}) {
  const locked = await acquireLockWithRetry(lockFile);
  if (!locked) {
    // Read-only fallback: peers still see whatever was on disk last write,
    // so we can detect *being* superseded. We do NOT write our own entry
    // this cycle, which means *being detected as a superseder* by older
    // peers is delayed by one poll. Acceptable: the next 12s poll retries.
    console.error('[tele-listen] could not acquire registry lock; will retry next poll');
    // Same liveness filter as the locked path: a dead peer's row (e.g. a
    // finished drain) must never make us stand down. My own row is kept so
    // findSuperseder can locate it.
    return readRegistry(file).filter((e) => e.pid === pid || isLiveEntry(e));
  }
  try {
    const all = readRegistry(file);
    const live = all.filter((e) => e.pid !== pid && isLiveEntry(e));
    const existing = all.find((e) => e.pid === pid);
    const mine = {
      pid,
      filter: filter instanceof Set ? Array.from(filter) : filter,
      offsetFile,
      convoId,
      loop: loop == null ? null : Boolean(loop),
      startedAt: existing && Number.isFinite(existing.startedAt) ? existing.startedAt : now,
      // If a transient `ps` failure returned null, keep the prior valid startTime
      // rather than downgrade liveness checks to fallback mode next round.
      startTime: startTime ?? existing?.startTime ?? null,
    };
    // Cap registry size as defense in depth — keep newest entries.
    let next = [...live, mine];
    if (next.length > maxEntries) next = next.slice(-maxEntries);
    writeRegistry(next, file);
    return next;
  } finally {
    releasePollLock(lockFile);
  }
}

/**
 * Strict-superset check, used to decide whether some other listener's filter
 * (`otherFilter`) covers ours (`myFilter`) and therefore makes us obsolete.
 *
 * Null filter means "catch-all" — listening for any reply, no IDS constraint.
 * We treat catch-all as **neither superseding nor superseded by** any filter:
 * - If `myFilter == null`, we're catch-all and shouldn't be killed by some
 *   narrower filtered listener.
 * - If `otherFilter == null`, treating it as catch-all that supersedes everyone
 *   would let any unintended catch-all run (debug invocation, future code path)
 *   wipe out every legitimate filtered listener across all conversations,
 *   breaking the cross-conversation safety property.
 * Returning false in both cases keeps the mechanism conservative.
 */
export function isStrictSuperset(otherFilter, myFilter) {
  if (myFilter == null || otherFilter == null) return false;
  const toSet = (v) =>
    v instanceof Set ? v
    : Array.isArray(v) ? new Set(v)
    : new Set([v]);
  const mineSet = toSet(myFilter);
  const otherSet = toSet(otherFilter);
  if (otherSet.size <= mineSet.size) return false; // must be strictly larger
  for (const m of mineSet) if (!otherSet.has(m)) return false;
  return true;
}

// Same-convo winner: newer `startedAt` wins; tie-break by lower `pid`. Returns
// positive if A wins, negative if B wins, 0 only if pid and startedAt match
// (same physical entry).
export function compareSameConvo(a, b) {
  const aT = Number.isFinite(a.startedAt) ? a.startedAt : 0;
  const bT = Number.isFinite(b.startedAt) ? b.startedAt : 0;
  if (aT !== bT) return aT - bT; // higher startedAt wins
  return b.pid - a.pid; // lower pid wins on tie
}

// A one-shot run (row `loop === false`: the bare pre-critical-action drain, a
// --wait-once child, the legacy `until` loop) must NEVER make a persistent
// --loop listener stand down. The drain's parent bash is brand-new, so its row
// always carries the NEWEST startedAt; without this rule a drain racing a
// --loop poll would win newer-wins, the --loop listener would exit 3 and its
// `while` wrapper would break — the agent goes deaf. Rows with no `loop` field
// (written by older code) are treated as --loop rows, i.e. today's behaviour.
// --loop vs --loop and one-shot vs anything are unchanged (newer wins).
export function ignoredAsSuperseder(peer, myLoop) {
  return myLoop === true && peer?.loop === false;
}

export function findSuperseder({ myPid, myFilter, myConvoId = null, myLoop = null, registry }) {
  // Locate my own registry row up front. If it's missing (read-only-fallback
  // path or eviction), treat the supersede check as inconclusive — return a
  // sentinel that the caller interprets as "retry next poll".
  const mineEntry = registry.find((x) => x.pid === myPid);
  for (const e of registry) {
    if (e.pid === myPid) continue;
    // Cross-mode never supersedes (convo vs legacy).
    const eConvo = e.convoId ?? null;
    if ((myConvoId == null) !== (eConvo == null)) continue;
    if (ignoredAsSuperseder(e, myLoop)) continue;
    if (myConvoId != null) {
      // Same-mode convo: peer with same convoId wins by (startedAt, pid).
      if (eConvo !== myConvoId) continue;
      if (!mineEntry) return { __inconclusive: true, reason: 'my-entry-missing' };
      if (compareSameConvo(e, mineEntry) > 0) return e;
      continue;
    }
    if (isStrictSuperset(e.filter, myFilter)) return e;
  }
  return null;
}

// Pre-write race guard (see main): re-read the registry right before writing
// the prompt and return the same-convo peer that beats us, or
// `{ __inconclusive }` if my row is gone, or null. Dead rows are ignored (same
// isLiveEntry filter refreshRegistry applies) — a finished drain's row must not
// make a live --loop listener stand down — and one-shot rows never beat a
// --loop listener (ignoredAsSuperseder).
export function findPreWriteWinner({ myPid, myConvoId, myLoop = null, registry, isLive = isLiveEntry }) {
  const mineEntry = registry.find((e) => e.pid === myPid);
  if (!mineEntry) return { __inconclusive: true, reason: 'my-entry-missing' };
  for (const e of registry) {
    if (e.pid === myPid) continue;
    if ((e.convoId ?? null) !== myConvoId) continue;
    if (ignoredAsSuperseder(e, myLoop)) continue;
    if (compareSameConvo(e, mineEntry) <= 0) continue;
    if (!isLive(e)) continue;
    return e;
  }
  return null;
}

export function writePromptAtomic(data, promptFile = DEFAULT_PROMPT_FILE) {
  const dir = path.dirname(promptFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = promptFile + `.${Date.now()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, promptFile);
}

// RFC 02 P3: stale-claim reclaim window. Raised 5→30 min (RFC 03 follow-up):
// with `--first-run` re-announcing an orphan claim IMMEDIATELY on the listener's
// restart, this TTL reclaim only ever fires while the AGENT IS ALIVE (the
// listener polls only as the agent's child) — so its dominant effect became
// CHURN on long turns (a live agent working >TTL got its own claim folded back +
// re-announced every window, stacking the ⚠️ recovery prefix). 30 min lets most
// long tasks finish inside one window; it stays a backstop for the rare
// dropped-Monitor-event case. Restart recovery is `--first-run`'s job, not this.
export const PROCESSING_TTL_MS = 30 * 60 * 1000;

// RFC 02 P3: merge an INCOMING coalesced batch into an OPEN (unclaimed) prompt —
// so a message arriving while a prompt is pending is APPENDED, not blocked/lost.
// Metadata (messageId/chat/reply/quote/sender/timestamp + persona/projectDescription)
// comes from the INCOMING/newest side so the agent still replies to the right
// thread; attachments are unioned. Pure + total.
//
// Attribution (impersonation guard): each side whose text is NOT already labeled
// (`textAttributed === false`, i.e. a lone bare message) is prefixed with its own
// `<name> (<role>):` here — otherwise a message from sender B, coalesced onto
// sender A's bare prompt, would inherit B's `...incoming` identity and A's words
// would read as B's. Already-labeled batches (`textAttributed === true`) are left
// as-is (no double-labeling). A legacy prompt written before this flag existed
// has `textAttributed === undefined` → treated as already-attributed (leave bare)
// so we never mangle an old multi-message batch during the upgrade window.
// Kind-flags that mark WHAT a prompt is (a daemon whisper/instruct, a broadcast, an
// agent ask/reply, a handover/ack). They drive the receiver's handling — critically,
// `whisper`/`instruct` mean "handle DISCREETLY". A merge must NOT silently drop them:
// `{ ...incoming }` alone loses any flag the OLDER (`existing`) side carried, so a
// whisper coalesced under a later plain message would look like a plain message and
// the agent could reply to it PUBLICLY → leak. We union the flags from both sides
// (incoming wins on conflict) so every kind present in the batch stays visible.
const KIND_FLAGS = ['whisper', 'instruct', 'broadcast', 'ask', 'askReply', 'handover', 'handoverAck'];

export function mergePromptData(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const seg = (d) => (d.textAttributed === false
    ? `${attributionLabelFromData(d)}: ${d.text ?? ''}`
    : (d.text ?? ''));
  const merged = {
    ...incoming,
    text: `${seg(existing)}\n\n${seg(incoming)}`,
    attachments: [...(existing.attachments ?? []), ...(incoming.attachments ?? [])],
    // Per-message truth survives the merge: concatenated in arrival order, each
    // segment keeping its own id/sender/reply/quote. Top-level scalars stay
    // "newest wins" (routing is unchanged); `text` stays the rendering.
    messages: [...promptSegments(existing), ...promptSegments(incoming)],
    // The merged text now carries per-segment labels wherever a sender was known.
    textAttributed: true,
  };
  // Preserve any kind-flag the older side had that the newer side doesn't (union).
  for (const k of KIND_FLAGS) {
    if (existing[k] !== undefined && merged[k] === undefined) merged[k] = existing[k];
  }
  // A preserved STEER (whisper/instruct) must keep its ROUTING IDENTITY too, not
  // just its flag. `{ ...incoming }` takes fromUserId/replyToMessageId from the
  // NEWER side; if a whisper/instruct (older) coalesces under a later PLAIN group
  // message, the batch would keep `instruct:true` but adopt the group sender's
  // fromUserId — so kind-aware reply routing (send-telegram) would DM the private
  // steer to the WRONG person (a group member) or fail. When the steer flag is
  // carried from `existing` and `incoming` is NOT itself a steer, restore the
  // steer side's DM target so the reply routes to the real instructor.
  const incomingIsSteer = incoming.instruct || incoming.whisper;
  const existingIsSteer = existing.instruct || existing.whisper;
  if (existingIsSteer && !incomingIsSteer) {
    merged.fromUserId = existing.fromUserId ?? null;
    merged.replyToMessageId = existing.replyToMessageId ?? null;
  }
  return merged;
}

// RFC 02 P3: an agent that CLAIMED a batch (rename prompt→.processing.json) but
// died before consuming leaves an orphan. After PROCESSING_TTL_MS, fold it back
// into the OPEN prompt (merging any batch spooled meanwhile) with a warning, so
// the next agent re-handles it instead of the convo wedging. Best-effort.
export function reclaimStaleProcessing(processingFile, promptFile, writeLockFile = null) {
  try {
    // Snapshot the stale claim FIRST via atomic rename. If an agent concurrently
    // claims the open prompt (atomic rename promptFile → processingFile, which on
    // POSIX would OVERWRITE the stale file), that claim now lands on a FRESH
    // processingFile we never touch — so this reclaim can't delete the agent's
    // just-claimed batch (that was a data-loss race, per 3-reviewer). We only
    // ever operate on our private `.stale` snapshot.
    const staleFile = `${processingFile}.stale.${process.pid}`;
    try { fs.renameSync(processingFile, staleFile); }
    catch { return; } // already consumed/reclaimed by a peer → nothing to do
    let claimed;
    try { claimed = JSON.parse(fs.readFileSync(staleFile, 'utf8')); }
    catch (e) {
      // Corrupt/torn snapshot: do NOT delete it (that silently LOSES the batch).
      // QUARANTINE it — same non-overwriting `.corrupt[.<n>]` scheme sweepOrphan-
      // Snapshots uses — for manual inspection/recovery, and surface loudly.
      // sweepOrphanSnapshots only adopts `.stale`/`.appending`, so a `.corrupt.*`
      // is left untouched (it can't be parsed to re-fold anyway).
      let dest = `${processingFile}.corrupt`;
      for (let n = 1; fs.existsSync(dest); n++) dest = `${processingFile}.corrupt.${n}`;
      try { fs.renameSync(staleFile, dest); }
      catch { try { fs.rmSync(staleFile, { force: true }); } catch {} }
      console.error(`[tele-listen] reclaim: ${path.basename(processingFile)} is CORRUPT (${e instanceof Error ? e.message : String(e)}) — quarantined as ${path.basename(dest)} (NOT deleted); inspect/recover manually`);
      return;
    }
    const warning = '⚠️ (khôi phục lô bị treo — agent trước đã claim rồi dừng giữa chừng)';
    claimed.text = `${warning}\n\n${claimed.text ?? ''}`;
    // `messages[]` is documented as the truth `text` only renders, so the recovery
    // marker has to live there too — otherwise an agent rendering from segments
    // can't tell it is re-handling a stalled batch.
    if (Array.isArray(claimed.messages) && claimed.messages.length > 0) {
      claimed.messages = claimed.messages.map((m, i) => (i === 0 ? { ...m, text: `${warning}\n\n${m?.text ?? ''}` } : m));
    }
    // Same serialization as the orphan sweep: the open prompt has other writers
    // (mergeOrSpoolPrompt, claimPreexistingPrompt) that hold the per-convo
    // prompt-write lock, and an unlocked read-modify-write here can clobber a
    // batch spooled in the window (Codex review). Contended → leave the `.stale`
    // snapshot for the orphan sweep to adopt on a later poll (never lost).
    const locked = writeLockFile ? acquirePollLock(writeLockFile) : true;
    if (!locked) return;
    try {
      if (fs.existsSync(promptFile)) {
        let open = null;
        try { open = JSON.parse(fs.readFileSync(promptFile, 'utf8')); } catch {}
        writePromptAtomic(open ? mergePromptData(claimed, open) : claimed, promptFile);
        fs.rmSync(staleFile, { force: true });
      } else {
        // Write the warning-annotated `claimed` (renaming the raw snapshot would
        // drop the warning we injected in memory).
        writePromptAtomic(claimed, promptFile);
        fs.rmSync(staleFile, { force: true });
      }
    } finally {
      if (writeLockFile) releasePollLock(writeLockFile);
    }
  } catch (e) {
    // Honest failure mode (subagent review): after the rename-to-.stale, a
    // write failure (e.g. ENOSPC) leaves the batch parked in `.stale.<pid>`.
    // sweepOrphanSnapshots (below) adopts such orphans on a later poll, but we
    // still surface it loudly. We do NOT rename it back to processingFile: a
    // concurrent agent claim may have created a fresh one there.
    console.error(`[tele-listen] reclaim of ${path.basename(processingFile)} failed: ${e instanceof Error ? e.message : String(e)} — batch parked in a .stale snapshot (orphan-sweep will adopt it)`);
  }
}

// RFC 02 P3 follow-up #1: adopt ORPHANED snapshot files. reclaimStaleProcessing
// (`<prompt>.processing.json.stale.<pid>`) and the append atomic-take
// (`<prompt>.json.appending.<pid>`) both atomic-rename a batch to a private
// snapshot BEFORE writing the result back. If the process dies (or a write fails,
// e.g. ENOSPC) in that window, the snapshot holds the ONLY copy of those messages
// and nothing else scans it → parked forever. This poll-time sweep folds such an
// orphan back into the OPEN prompt so no message is lost.
//
// Adopt ONLY when the owner pid is PROVABLY DEAD. A live owner is either mid-op or
// about to clean up — never race it. This is safe because every poll runs in a
// FRESH short-lived process: a batch's owner (the poll that created it) is dead by
// the very next poll. We deliberately do NOT add an age/mtime fallback for a live
// owner — that could steal a snapshot from a paused-but-alive op which then
// resumes and clobbers (reviewer BLOCKER). Residual: if a dead owner's pid is
// REUSED by an unrelated live process, its orphan stays PARKED (not lost) until
// that process exits — rare and self-healing.
//
// Adoption reads a snapshot → merges into the open prompt → writes → deletes the
// snapshot LAST (a crash between write and delete re-adopts as a harmless dup next
// sweep, never a loss). The read-modify-write of the shared open prompt is
// serialized ACROSS processes by a per-convo sweep lock: two listeners overlapping
// during a supersede can't both adopt DIFFERENT orphans against the same stale
// `open` snapshot and clobber each other (reviewer BLOCKER) — the loser simply
// skips this poll and sweeps on the next. Best-effort + total: never throws into
// the poll loop.
export function sweepOrphanSnapshots(convo, tmpDir = DEFAULT_TMP_DIR) {
  const promptFile = path.join(tmpDir, `prompt-convo-${convo}.json`);
  const staleBase = `prompt-convo-${convo}.processing.json.stale.`;
  const appendBase = `prompt-convo-${convo}.json.appending.`;
  const sweepLock = path.join(tmpDir, `sweep-convo-${convo}.lock`);
  let entries;
  try { entries = fs.readdirSync(tmpDir); } catch { return; }
  // Cheap pre-filter: only pay for the lock if there's actually a candidate.
  if (!entries.some((n) => n.startsWith(staleBase) || n.startsWith(appendBase))) return;
  if (!acquirePollLock(sweepLock)) return;            // another sweeper is adopting → skip this poll
  try {
    for (const name of entries) {
      let kindBase = null;
      if (name.startsWith(staleBase)) kindBase = staleBase;
      else if (name.startsWith(appendBase)) kindBase = appendBase;
      else continue;
      const pidStr = name.slice(kindBase.length);
      // `.<pid>` or `.<pid>-<n>` — the consumer parks with a `-<n>` suffix when it
      // has to snapshot twice in one process (never overwrite a parked batch).
      const owner = /^(\d+)(?:-\d+)?$/.exec(pidStr);
      if (!owner) continue;                           // only our own snapshots
      const pid = Number(owner[1]);
      if (pid > 1 && isProcessAlive(pid)) continue;   // live owner (incl. ourself) → leave it
      const full = path.join(tmpDir, name);
      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); }
      catch { continue; }                             // vanished mid-scan → skip
      let data;
      try { data = JSON.parse(raw); }
      catch {
        // Unparseable dead-owner snapshot: do NOT delete (that would destroy the
        // only copy). Quarantine to a non-overwriting `<name>.corrupt[.<n>]` —
        // still prefix-matched but the non-numeric suffix makes later sweeps skip
        // it — and log ONCE (the rename guarantees no re-log every poll).
        try {
          let dest = `${full}.corrupt`;
          for (let n = 1; fs.existsSync(dest); n++) dest = `${full}.corrupt.${n}`;
          fs.renameSync(full, dest);
          console.error(`[tele-listen] orphan-sweep: ${name} is unreadable — quarantined to ${path.basename(dest)} for manual recovery`);
        } catch { /* raced away or rename failed → leave it */ }
        continue;
      }
      // Serialize against the OTHER writers of the open prompt. The sweep lock only
      // keeps sweepers apart; mergeOrSpoolPrompt and claimPreexistingPrompt use the
      // per-convo `prompt-write` lock, so without taking it too this read-modify-
      // write can clobber a batch spooled in the window (Codex review) — and the
      // new parking path makes that race routine, not theoretical. Contended →
      // leave the snapshot parked and adopt it on the next poll (never lost).
      // Lock order is always sweep → write; nothing takes them the other way, so
      // there is no deadlock.
      const writeLock = path.join(tmpDir, `prompt-write-${convo}.lock`);
      if (!acquirePollLock(writeLock)) continue;
      try {
        let open = null;
        if (fs.existsSync(promptFile)) {
          try { open = JSON.parse(fs.readFileSync(promptFile, 'utf8')); } catch {}
        }
        // Orphan is the OLDER content; a present open prompt is newer → orphan is
        // the `existing` (earlier) side so mergePromptData keeps newest metadata +
        // per-segment attribution (no impersonation on adopt).
        writePromptAtomic(open ? mergePromptData(data, open) : data, promptFile);
        fs.rmSync(full, { force: true });             // delete LAST (crash → dup, not loss)
        fs.rmSync(`${full}.warned`, { force: true }); // clear any prior write-fail marker
      } catch (e) {
        // A persistent write failure (e.g. ENOSPC) recurs every poll — but each
        // poll is a fresh process, so guard the log with a `.warned` marker to
        // surface it ONCE, not on every ~2s poll (this codebase regressed once on
        // per-poll logging → Monitor auto-stop). The batch stays parked and is
        // retried when the write can succeed.
        const warned = `${full}.warned`;
        if (!fs.existsSync(warned)) {
          console.error(`[tele-listen] orphan-sweep: failed to adopt ${name} → ${path.basename(promptFile)}: ${e instanceof Error ? e.message : String(e)} (left parked, retried next sweep)`);
          try { fs.writeFileSync(warned, String(Date.now())); } catch {}
        }
      } finally {
        releasePollLock(writeLock);
      }
    }
  } finally {
    releasePollLock(sweepLock);
  }
}

// RFC 03 §5.2 — claim a pre-existing UNCLAIMED prompt so the caller can announce it
// without re-announcing every poll (the RFC 02 flood). Atomic rename (prompt →
// .processing) is the linearization point: after it, the open prompt is gone, so
// subsequent polls find nothing to claim and stay silent until the agent consumes
// it (or reclaimStaleProcessing folds it back on death). Returns true if WE claimed
// it (caller should announce + exit 0), false if there is nothing to claim.
//
// No-clobber (reviewer BLOCKER, RFC 03 §5.5): `renameSync` OVERWRITES its target, so
// a bare check-then-rename could clobber a `.processing` that appears in the TOCTOU
// window. We close this by holding the per-convo prompt-write lock and RE-CHECKING
// under it before the rename. Combined with the source invariant (`.processing` is
// only ever created by MOVING `prompt` away — agent `mv`, another listener's claim,
// or this fn — which removes the rename source → ENOENT, never a clobber), the claim
// cannot destroy an in-flight batch. `writeLockFile` may be null in tests/callers
// that don't need cross-process serialization. `touch` makes the stale-reclaim TTL
// count from the claim, matching the agent-side claim protocol.
/** Render the `claim: <id>` tail of an announce (empty when the claim couldn't be stamped). */
export function claimSuffix(claim) {
  return typeof claim === 'string' ? ` [claim: ${claim}]` : '';
}

/** Announce bodies are capped — one Telegram message can't exceed this anyway. */
export const ANNOUNCE_TEXT_CAP = 4096;

/**
 * The announce carries the batch's FULL text, not a 60-char teaser.
 *
 * Delivery used to be "here is a path" — so a batch that was consumed before the
 * agent read the file was gone, and all the agent had ever seen was the teaser
 * ("I glimpsed a message but lost it, please resend"). With the text inline, the
 * message has already reached the agent's context by the time anything can delete
 * the file: the worst case degrades to "read the file for the metadata", never to
 * a lost message. Reads the claimed file so the two announce sites (the
 * claim-branch, which had NO preview at all, and the write-path) say the same
 * thing.
 */
export function announceBody(file, fallbackText = null) {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fall through */ }
  const text = data?.text ?? fallbackText ?? '';
  const body = text.length > ANNOUNCE_TEXT_CAP
    ? `${text.slice(0, ANNOUNCE_TEXT_CAP)}… (cắt bớt — đọc file để xem đủ)`
    : text;
  const id = data?.messageId ?? null;
  // JSON.stringify, not `"${body}"`: admin messages routinely contain newlines,
  // and the announce is consumed LINE BY LINE (Claude's Monitor turns each stdout
  // line into its own event). A raw multi-line body would split the announce, wrap
  // the trailing `[claim: <id>]` onto a line of its own where a line-oriented
  // reader never sees it — and the agent would then reply without --claim-id,
  // defeating the whole mechanism (Gemini review). Escaping keeps it one line.
  return `${JSON.stringify(body)}${id != null ? ` (messageId: ${id})` : ''}`;
}

export function claimPreexistingPrompt(promptFile, processingFile, writeLockFile = null) {
  if (fs.existsSync(processingFile)) return false;   // agent handling a batch → don't pre-empt
  if (!fs.existsSync(promptFile)) return false;      // nothing pending
  const locked = writeLockFile ? acquirePollLock(writeLockFile) : true;
  if (!locked) return false;                         // another writer active → announce next poll
  try {
    // Re-check under the lock: a peer may have claimed/consumed in the window.
    if (fs.existsSync(processingFile)) return false;
    if (!fs.existsSync(promptFile)) return false;
    // Stamp the claim's IDENTITY *BEFORE* publishing it. `claimId` is what lets the
    // consumer (send-telegram) prove it is deleting the batch it actually handled
    // rather than whatever happens to sit in the slot — the confirmed data-loss
    // bug: a SECOND send in the same turn used to delete a batch claimed mid-turn
    // that the agent had never read. Stamping AFTER the rename would leave a
    // window where `.processing.json` is readable but unstamped: a concurrent
    // consumer would find no claimId to compare, conclude "answered", and delete a
    // batch nobody had read (Codex review). So we stamp the OPEN file first and
    // only then rename — the rename is atomic, so the claim is never visible
    // unstamped. Best-effort: if stamping fails we still publish (the old
    // positional behaviour), never lose the batch.
    const now = new Date();
    const claimId = crypto.randomBytes(8).toString('hex');
    let stamped = false;
    try {
      const claimed = JSON.parse(fs.readFileSync(promptFile, 'utf8'));
      claimed.claimId = claimId;
      claimed.claimedAt = now.getTime();
      writePromptAtomic(claimed, promptFile);
      stamped = true;
    } catch { /* unparseable/unwritable → publish as-is */ }
    fs.renameSync(promptFile, processingFile);       // source consumed → no clobber (see above)
    try { fs.utimesSync(processingFile, now, now); } catch { /* best-effort touch */ }
    return stamped ? claimId : true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;           // source vanished in the race → no-op
    throw e;
  } finally {
    if (writeLockFile) releasePollLock(writeLockFile);
  }
}

// RFC 03 §5.5 / RFC 02 P3 — write `data` into the OPEN prompt slot WITHOUT clobbering
// a batch already there. Atomically TAKE the open prompt (rename → private
// `.appending.<pid>`), merge `data` into it via mergePromptData, write the result
// back, and delete the snapshot LAST (a write failure parks it in `.appending.<pid>`
// for sweepOrphanSnapshots to adopt — never a loss). If there is no open prompt
// (the agent claimed it, or the slot is empty), `data` becomes a FRESH prompt
// (spool). This is the exact take/merge/rm-last the listener's --append has always
// used, now shared so SENDERS (ask/handover/steer/broadcast, RFC 03 §5.1) can write
// the same way instead of `writePromptExclusive` (which bounces EEXIST when busy).
//
// Serialized across writers by the per-convo `prompt-write-<N>.lock` (§5.5): the
// listener-append, the pre-existing claim (§5.2), and every sender take it, so two
// writers can't interleave their rename+read+write and clobber each other. On lock
// exhaustion we THROW (the durable write must complete before a sender reports
// "queued"); the hold is microseconds (no network) so exhaustion is effectively
// impossible. `writeLockFile` may be null for callers that don't need cross-process
// serialization (e.g. unit tests). Returns 'merged' | 'spooled'.
export async function mergeOrSpoolPrompt(promptFile, data, writeLockFile = null) {
  const acquired = writeLockFile ? await acquireLockWithRetry(writeLockFile) : true;
  if (!acquired) {
    throw new Error(`mergeOrSpoolPrompt: could not acquire ${path.basename(writeLockFile)} — prompt NOT written (do not report queued)`);
  }
  let takenFile = null;
  try {
    const t = `${promptFile}.appending.${process.pid}`;
    let existing = null;
    try { fs.renameSync(promptFile, t); takenFile = t; } catch { /* no open prompt → spool fresh */ }
    if (takenFile) { try { existing = JSON.parse(fs.readFileSync(takenFile, 'utf8')); } catch { /* torn/corrupt → treat as none */ } }
    const toWrite = existing ? mergePromptData(existing, data) : data;
    writePromptAtomic(toWrite, promptFile);          // if this throws, takenFile stays parked (rm-last)
    if (takenFile) { try { fs.rmSync(takenFile, { force: true }); } catch {} }
    return existing ? 'merged' : 'spooled';
  } finally {
    if (writeLockFile) releasePollLock(writeLockFile);
  }
}

// Read every prompt*.json sibling and collect a Set of `${botId}:${updateId}`
// pairs so the prune sweep below skips any dir still pointed at by an
// unconsumed prompt — even one that has sat idle for hours. The set is keyed
// by both botId and updateId because multiple bots in the same teleport tree
// have independent update_id sequences.
function collectReferencedAttachments(promptDir) {
  const referenced = new Set();
  try {
    for (const entry of fs.readdirSync(promptDir)) {
      if (!entry.startsWith('prompt') || !entry.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(promptDir, entry), 'utf8'));
        for (const att of data.attachments ?? []) {
          if (att && Number.isFinite(att.updateId)) {
            referenced.add(`${att.botId ?? 'unknown-bot'}:${att.updateId}`);
          }
        }
      } catch {}
    }
  } catch {}
  return referenced;
}

// Prune `attachments/<bot_id>/<update_id>/` dirs an agent has clearly
// abandoned. A dir is eligible for prune only when ALL of the following hold:
//   - numeric `<update_id>` name well below the listener's globalOffset view
//   - mtime older than 1 hour (avoids racing an in-progress agent read)
//   - no live prompt JSON in the prompt dir still references that
//     (botId, updateId) pair
// Walks one level under each bot directory; non-numeric entries (e.g.
// "unknown-bot" or stray scratch dirs) are walked the same way.
function pruneAttachmentDirs(baseDir, globalOffset, promptDir, botId = null) {
  try {
    if (!fs.existsSync(baseDir)) return;
    const idThreshold = globalOffset - ATTACHMENT_PRUNE_KEEP;
    const mtimeCutoff = Date.now() - 60 * 60 * 1000;
    const referenced = collectReferencedAttachments(promptDir);
    for (const botEntry of fs.readdirSync(baseDir)) {
      // `globalOffset` (and thus idThreshold) is a per-bot update_id sequence;
      // applying it to another bot's attachment dir would compare incomparable
      // ids and could mis-prune. Only prune the current bot's own subdir. Each
      // bot prunes its own on its own polls, so overall coverage is unchanged.
      if (botId != null && botEntry !== String(botId)) continue;
      const botDir = path.join(baseDir, botEntry);
      let botStat;
      try { botStat = fs.statSync(botDir); } catch { continue; }
      if (!botStat.isDirectory()) continue;
      for (const idEntry of fs.readdirSync(botDir)) {
        if (!/^\d+$/.test(idEntry)) continue;
        const id = parseInt(idEntry, 10);
        if (id >= idThreshold) continue;
        if (referenced.has(`${botEntry}:${id}`)) continue;
        const dirPath = path.join(botDir, idEntry);
        let mtime = 0;
        try { mtime = fs.statSync(dirPath).mtimeMs; } catch { continue; }
        if (mtime > mtimeCutoff) continue;
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    }
  } catch (e) {
    console.error(`[tele-listen] pruneAttachmentDirs failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Append admin reply rows into the convo tree under convoId. Skips messageIds
// already present (any convo). De-dupes within the batch. On lock-timeout
// returns {ok:false} — caller MUST skip the subsequent prompt write so the
// agent doesn't process replies whose reply-to chain we can't route later.
async function recordAdminMessagesInConvo({ messages, convoId, botId, registryFile = CONVO_REGISTRY_FILE, lockFile = CONVO_LOCK_FILE }) {
  if (!messages.length || convoId == null) return { ok: true };
  const acquired = await acquireConvoLock(lockFile);
  if (!acquired) {
    console.error('[tele-listen] convo-registry lock-timeout — admin messageId recording skipped');
    return { ok: false, reason: 'lock-timeout' };
  }
  try {
    const { rows } = readConvoRows(registryFile);
    const existing = new Set();
    for (const r of rows) {
      if (typeof r.v === 'number' && r.v > CONVO_SCHEMA_VERSION) continue;
      if (r.botId !== botId) continue;
      existing.add(`${r.chatId}:${r.messageId}`);
    }
    const seenInBatch = new Set();
    for (const { msg } of messages) {
      const chatId = String(msg.chat.id);
      const messageId = msg.message_id;
      const key = `${chatId}:${messageId}`;
      if (existing.has(key) || seenInBatch.has(key)) continue;
      seenInBatch.add(key);
      appendConvoRow(
        { v: CONVO_SCHEMA_VERSION, convoId, messageId, chatId, botId, ts: Date.now(), sender: 'admin' },
        registryFile,
      );
    }
  } finally {
    releaseConvoLock(lockFile);
  }
  return { ok: true };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[tele-listen] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  let { filterReplyTo, offsetFile, offsetFileProvided, convo, legacyFilter, settle, loop, append, announcePreexisting, firstRun } = args;

  // Env resolution.
  // - No --convo / --filter-reply-to → consult env.
  // - --filter-reply-to + env set → mode mismatch. Pass `--legacy-filter` to
  //   intentionally bypass the env (operator debugging an old IDS loop on a
  //   machine where CLAUDE_CODE_SESSION_ID is always set).
  if (filterReplyTo != null && convo == null && !legacyFilter) {
    // Check raw env presence, not parseability. A future runtime change to a
    // non-UUID id would yield convoId=null but the agent IS in a session;
    // legacy mode would silently mis-route admin replies.
    const envName = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']
      .find((n) => process.env[n] != null && process.env[n] !== '');
    if (envName) {
      console.error(
        `[tele-listen] --filter-reply-to is incompatible with ${envName} env (send-side is in convo mode). ` +
        `Drop --filter-reply-to OR pass --legacy-filter to override.`,
      );
      process.exit(1);
    }
  }
  if (convo == null && filterReplyTo == null) {
    const r = resolveConvoIdFromEnv({ argConvo: null });
    if (r.convoId != null) convo = r.convoId;
  }
  // Note: `--convo` overrides env (explicit > implicit). No disagreement
  // check — the operator's explicit value is authoritative for the listener.

  // Ensure the shared tmp dir exists before any writer touches it. Several
  // codepaths (audit log, atomicWriteFileSync, lock files) recreate it on
  // demand, but the audit-log appendFileSync at fetch time would silently
  // drop the first line of the first-ever run if we don't ensure it here.
  fs.mkdirSync(DEFAULT_TMP_DIR, { recursive: true });

  const envFromFile = loadEnvFromFile(ENV_FILE);
  // Bubble optional config from .env into process.env so consumers that read
  // process.env directly (e.g. isQuietHour) pick up values without having to
  // thread envFromFile through every call site.
  for (const k of ['QUIET_HOURS_START', 'QUIET_HOURS_END']) {
    if ((process.env[k] == null || process.env[k] === '') && envFromFile[k]) {
      process.env[k] = envFromFile[k];
    }
  }
  const token = process.env.REPORT_BOT_TOKEN || envFromFile.REPORT_BOT_TOKEN;
  // RFC 02: resolve this project's group + roles from teleport/projects.json
  // (keyed by basename(cwd) = the projects.json key — also the roster-harvest
  // target), falling back to TELEGRAM_ADMIN_CHAT_ID env (shared catch-all).
  // RFC 15: convo-anchored routing (shared resolver — MUST agree with the send
  // side, else the listener watches a different group than sends land in, G4).
  // `convo` is already resolved above (--convo → env). botId from the token.
  const projectsConfig = readProjectsConfig();
  const fallbackChatId = resolveDefaultChatId(projectsConfig, { env: process.env, envFile: envFromFile });
  const routingBotId = token ? extractBotId(token) : null;
  const routingRows = readConvoRows(CONVO_REGISTRY_FILE).rows;
  const { lookupKey, projCfg } = resolveProjectRouting({
    cwd: process.cwd(),
    convoId: convo,
    botId: routingBotId,
    env: process.env,
    registryRows: routingRows,
    projectsConfig,
    fallbackChatId,
  });
  const adminIds = adminIdsFrom(projCfg, fallbackChatId, parseAdminChatIds);
  // Roles (RFC 02): from projects.json[key].roles ONLY (advisory; agent-side
  // enforcement). Unmapped sender → 'member' (see roleFor).
  const roles = projCfg.roles;

  if (!token) {
    console.error('[tele-listen] Missing REPORT_BOT_TOKEN');
    process.exit(1);
  }
  // Empty adminIds is a SECURITY hole, not just a misconfig: filterAdminMessages
  // skips the chat-whitelist when adminIds is empty (`adminIds.length > 0`), so
  // the listener would accept messages from ANY chat. Fail-fast like the send
  // side (review G-Critical RFC 02).
  if (adminIds.length === 0) {
    const kd = lookupKey || path.basename(process.cwd()) || '(unknown)';
    console.error(`[tele-listen] project "${kd}" chưa cấu hình group: thêm "${kd}".chatId vào teleport/projects.json, hoặc đặt _default.chatId trong projects.json (shared catch-all).`);
    process.exit(1);
  }

  const botId = extractBotId(token);
  // A non-empty token that doesn't parse to a numeric bot id is malformed.
  // Fail fast: botScopedFiles(null) would fall back to the SHARED cache/offset
  // files, re-introducing the exact cross-bot poisoning this isolation fixes
  // (the null fallback is only meant for genuinely token-less/legacy callers).
  // A malformed token can't authenticate getUpdates anyway, so exiting is no
  // loss of function — just a clearer failure than silently sharing state.
  if (botId == null) {
    console.error('[tele-listen] REPORT_BOT_TOKEN malformed (no numeric bot id prefix) — cannot scope per-bot state');
    process.exit(1);
  }
  // Per-bot update_id state (cache + Telegram getUpdates offset). See
  // botScopedFiles() for why this must be keyed by botId. Per-convo offset
  // files are already unique per convo; they read these bot-scoped files via
  // resolveStartOffset.
  const { cacheFile: botCacheFile, globalOffsetFile: botGlobalOffsetFile } =
    botScopedFiles(botId);
  let mode = 'legacy';

  if (convo != null) {
    mode = 'convo';
    // Heartbeat: each Monitor restart spawns a fresh `main()` process. Touch
    // the alive file before any I/O so a slow fetchUpdates can't make us look
    // dead. The wait-once supervisor touches from its own loop body.
    recordAlive(convo);
    // Synthesize a stable per-convo offset file when the operator didn't
    // pass one. Must NOT be scoped by ppid: the recommended `until node …;
    // do sleep …; done` pattern (and any Monitor restart) creates a fresh
    // wrapper ppid, and a per-ppid offset would start at 0 → resolveStartOffset
    // replays cached updates the previous wrapper already handled, re-emitting
    // messages whose prompts have been consumed. Same reasoning as the
    // `--wait-once` supervisor uses for its own stable offset path.
    // Concurrent same-convo listeners are prevented by listener-registry
    // supersede + atomicWriteFileSync, so a single shared file is safe.
    if (!offsetFileProvided) {
      offsetFile = path.join(DEFAULT_TMP_DIR, `convo-${convo}-offset.txt`);
    }
    const { rows, malformed } = readConvoRows();
    const set = buildConvoFilter(rows, convo, botId, adminIds);
    if (set.size === 0) {
      // Crash-window hint: if sent-registry has a matching allocation row, the
      // operator can repair via import-convo before the next poll.
      const sent = readSentRegistry();
      // Match either the convoId field (modern; env-derived convos) OR
      // messageId === convo (legacy / new-convo case).
      const allocCandidate = sent.find((r) =>
        (r.convoId === convo || r.messageId === convo)
        && (r.botId == null || r.botId === botId),
      );
      if (allocCandidate) {
        console.error(
          `[tele-listen] convo ${convo} has no registered messages for bot ${botId} / chats ${adminIds.join(',')}, ` +
          `but sent-registry has a matching allocation send. Run: node ${__dirname}/import-convo.mjs --convo ${convo} --bot ${botId}`,
        );
      } else {
        console.error(`[tele-listen] convo ${convo} has no registered messages for bot ${botId} / chats ${adminIds.join(',')}`);
      }
      // Exit WITHOUT advancing the offset; offset stays put so a successful
      // repair resumes routing on the next poll.
      process.exit(1);
    }
    filterReplyTo = set;
    if (malformed > 0) {
      console.error(`[tele-listen] convo-registry: ${malformed} malformed line(s) skipped this poll`);
    }
  }

  // Resolve this convo's owned forum topic PER admin chat (local file read).
  // Routing is by thread membership: a message in the convo's topic addresses
  // the agent. Must be keyed by chat — thread ids are small per-chat integers
  // that collide across chats, so a single value would mis-route a foreign
  // chat's same-numbered thread to this convo (review G-C1). The send side
  // creates the topic, so an empty map (brand-new convo that hasn't sent yet)
  // just means no thread routing until the first send lands.
  const teamThreadByChat = new Map();
  // Flag genuine corruption (non-ENOENT read/parse error) for a loud log; a
  // missing file is just "no topics yet". topics.json is written atomically so
  // there are no torn reads — see the corruption handling in the empty branch.
  let topicsUnavailable = false;
  if (convo != null) {
    let topics = {};
    try {
      topics = JSON.parse(fs.readFileSync(DEFAULT_TOPICS_FILE, 'utf8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') topicsUnavailable = true; // missing file = legitimately empty
    }
    if (!topicsUnavailable) {
      for (const chatId of adminIds) {
        const tid = getThreadId(topics, chatId, String(convo));
        if (tid != null) teamThreadByChat.set(String(chatId), tid);
      }
    }
  }

  // Registry-based supersede.
  const myMonitorPid = process.ppid;
  if (myMonitorPid <= 1) {
    console.error('[tele-listen] refusing to run with reparented PPID ≤ 1 (init/launchd) — Monitor wrapper appears dead');
    process.exit(1);
  }
  const registry = await refreshRegistry({ pid: myMonitorPid, filter: filterReplyTo, offsetFile, convoId: convo, loop });
  const superseder = findSuperseder({ myPid: myMonitorPid, myFilter: filterReplyTo, myConvoId: convo, myLoop: loop, registry });
  if (superseder && superseder.__inconclusive) {
    process.exit(2); // supersede check inconclusive — retry next poll (silent; exit code is the signal)
  }
  if (superseder) {
    console.log(
      `[tele-listen] superseded by listener pid=${superseder.pid} — exiting`,
    );
    // Under --loop, exit 3 so the persistent `while` wrapper breaks (stands
    // down) instead of re-arming. Legacy (no --loop) keeps exit 0 = ends the
    // `until` loop the same way it always has.
    process.exit(loop ? 3 : 0);
  }

  // RFC 18 B: nobody (no listener, no daemon) has completed a getUpdates for
  // > 5 min → tell the agent through its Monitor (stdout). Throttled per convo;
  // a system warning only — exit codes and the prompt protocol are unchanged.
  if (convo != null) {
    const warning = listenerStaleWarning({ convo });
    if (warning) console.log(warning);
  }

  // Prompt file path: stable per-convo for `--convo`, filter-keyed for legacy.
  const promptFile = convo != null
    ? path.join(DEFAULT_TMP_DIR, `prompt-convo-${convo}.json`)
    : getPromptFile(filterReplyTo);
  const processingFile = convo != null
    ? path.join(DEFAULT_TMP_DIR, `prompt-convo-${convo}.processing.json`)
    : getProcessingFile(filterReplyTo);

  if (append) {
    // --first-run (RFC 03 follow-up): the loop's FIRST poll since the agent
    // (re)started/resumed its listener. An orphan `.processing` left by a PRIOR
    // life must be re-surfaced NOW, not after the 5-min TTL. We simply
    // RE-ANNOUNCE the existing claim AS-IS — deliberately NOT folding it back
    // into the open prompt: a fold would MERGE it with any batch spooled in the
    // open prompt into one `.processing`, which the agent's next consume deletes
    // wholesale → the spooled batch would be LOST (Codex review). Instead the
    // agent reads the existing `.processing`; anything spooled in the open prompt
    // stays separate and is claimed on a later poll. At-least-once: a still-alive
    // agent may re-read a batch (a harmless dup), but nothing is ever lost. No
    // fold, no re-claim, no lock — just one announce.
    if (firstRun && convo != null && fs.existsSync(processingFile)) {
      // Carry the SAME two guarantees as a fresh announce: the full text (so a
      // re-surfaced batch is delivered even if the file is later consumed unread)
      // and the claim token already stored in the file (so the agent can prove
      // which batch it answered). Without them a restart reopened the exact
      // "glimpsed but lost" hole this change closes (Codex review).
      let stored = null;
      try { stored = JSON.parse(fs.readFileSync(processingFile, 'utf8'))?.claimId ?? null; } catch { /* best-effort */ }
      console.log(`[tele-listen] prompt ready: ${promptFile} (re-surfaced on first-run — read the .processing) ${announceBody(processingFile)}${claimSuffix(stored)}`);
      process.exit(0);
    }
    // P3: do NOT block. Reclaim a stale claim (agent died mid-processing), then
    // fall through to fetch + append-to-open / spool-fresh below.
    if (fs.existsSync(processingFile)) {
      // NOTE (subagent review): mtime here is the prompt's WRITE time (rename
      // preserves it), not the CLAIM time — so a batch that sat unclaimed a
      // while can be reclaimed sooner than PROCESSING_TTL_MS after the actual
      // claim. Harmless pre-activation; the agent-side claim (ships with
      // activation) MUST `touch` the file so TTL measures from claim.
      let stale = false;
      try { stale = Date.now() - fs.statSync(processingFile).mtimeMs > PROCESSING_TTL_MS; } catch {}
      // convo-scoped lock only when there IS a convo (legacy filter-mode has none).
      if (stale) reclaimStaleProcessing(processingFile, promptFile, convo != null ? path.join(DEFAULT_TMP_DIR, `prompt-write-${convo}.lock`) : null);
    }
    // Follow-up #1: adopt any orphaned .stale.*/.appending.* snapshots left by a
    // reclaim/append that died after its atomic rename but before writing back.
    if (convo != null) sweepOrphanSnapshots(convo, DEFAULT_TMP_DIR);
    // RFC 03 §5.2 — CLAIM-before-ANNOUNCE: surface a pre-existing UNCLAIMED prompt
    // that this poll did NOT just write from Telegram — a side-message injected by
    // ask/handover/steer/broadcast, a batch resurfaced by reclaim/sweep above, or a
    // prompt that survived the agent's death and is being picked up by a reborn
    // listener. Without this, Claude's Monitor only ever emits "prompt written" from
    // the Telegram-fetch path below, so such a prompt sits unannounced (the G3 gap).
    //
    // We CLAIM (atomic rename → .processing) BEFORE announcing. This is what stops
    // the RFC 02 announce-flood: after the rename the open prompt is GONE, so every
    // later poll sees no open prompt (and a fresh .processing) and stays silent
    // until the agent consumes it — or, if the agent dies mid-handling, until
    // reclaimStaleProcessing folds it back after PROCESSING_TTL_MS and a later poll
    // re-claims + re-announces. A marker file was rejected (it introduces a
    // permanent-deaf failure mode); the claim reuses the durable .processing
    // lifecycle RFC 02 already built. Guarded on NO .processing existing — an
    // existing claim means the agent is handling a batch; never pre-empt it.
    //
    // v1 scope (RFC 03 §5.2): the Telegram write-path below is left as-is, so a
    // just-written prompt the agent is slow (>~2s) to claim may get ONE extra
    // announce here before we claim it for the agent (its own `mv` then ENOENTs and
    // it reads the .processing we made). One dup, at-least-once — acceptable.
    if (announcePreexisting && convo != null) {
      const writeLock = path.join(DEFAULT_TMP_DIR, `prompt-write-${convo}.lock`);
      const claim = claimPreexistingPrompt(promptFile, processingFile, writeLock);
      if (claim) {
        // Echo the claim token: the agent passes it back as `--claim-id` when it
        // replies, which is what lets send-telegram delete THIS batch and only
        // this one (forgetting it costs a duplicate, never a loss).
        console.log(`[tele-listen] prompt ready: ${promptFile} (pre-existing — claimed by listener) ${announceBody(processingFile)}${claimSuffix(claim)}`);
        process.exit(0);
      }
    }
  } else {
    // Legacy single-slot: block while a batch is pending or being processed.
    if (fs.existsSync(processingFile)) {
      process.exit(2); // still processing — skip silently (exit code is the signal)
    }
    if (fs.existsSync(promptFile)) {
      process.exit(2); // prompt not yet consumed — skip silently (exit code is the signal)
    }
  }

  // Centralized fetch: acquire lock, fetch updates, cache locally.
  // Orphans are detected and excluded from cache under lock; reaction happens after.
  // The systemMsgIds snapshot is read ONCE per loop and reused for both the
  // in-lock classification and the out-of-lock reply text selection, so a
  // concurrent process appending a new id mid-loop can't flip an orphan's
  // variant between detection and response.
  let fetchFailed = false;
  let pendingOrphans = [];
  let systemMsgIdsSnapshot = new Set();
  // Captured before fetch so this poll uses one stable Telegram getUpdates
  // offset even if another listener advances the global offset concurrently.
  let preFetchGlobalOffset = readOffset(botGlobalOffsetFile);
  const lockAcquired = acquirePollLock();
  if (lockAcquired) {
    try {
      const globalOffset = preFetchGlobalOffset;
      const fetched = await fetchUpdates(token, globalOffset);
      recordFetchOk();
      // NOTE: cross-cutting, non-AI control handling (/pending, /start, and the
      // heartbeat auto-reminder) was MOVED to the supervisor daemon (daemon.mjs).
      // Agent listeners no longer answer those — they only route replies to their
      // own topic. The handler functions remain exported here for the daemon to
      // import. (No daemon running ⇒ no reminders/pending; accepted trade-off.)
      if (fetched.length > 0) {
        systemMsgIdsSnapshot = readSystemMsgIds();
        const { orphans, nonOrphan } = partitionOrphans(fetched, adminIds, systemMsgIdsSnapshot);
        pendingOrphans = orphans;
        if (nonOrphan.length > 0) appendToCache(nonOrphan, botCacheFile);
        // Audit log: every fetched update with classification + reason. Lets us debug
        // cache-miss issues (e.g. user-reply ended up orphan'd because Telegram stripped
        // reply_to_message). Append-only JSONL; rotation handled by external tooling.
        try {
          const auditFile = path.join(DEFAULT_TMP_DIR, 'fetch-audit.jsonl');
          const orphanSet = new Set(orphans.map((o) => o.update.update_id));
          const cachedSet = new Set(nonOrphan.map((u) => u.update_id));
          const lines = fetched.map((u) => {
            const m = updateMessage(u);
            const kind = orphanSet.has(u.update_id)
              ? 'orphan'
              : cachedSet.has(u.update_id)
                ? 'cached'
                : 'other';
            return JSON.stringify({
              ts: Math.floor(Date.now() / 1000),
              update_id: u.update_id,
              message_id: m?.message_id ?? null,
              from: m?.from?.id ?? null,
              reply_to: m?.reply_to_message?.message_id ?? null,
              has_text: Boolean(m && messageText(m)),
              text_preview: m && messageText(m) ? messageText(m).slice(0, 60) : null,
              update_type: u.message
                ? 'message'
                : u.edited_message
                  ? 'edited_message'
                  : u.message_reaction
                    ? 'message_reaction'
                    : Object.keys(u).filter((k) => k !== 'update_id')[0] ?? 'unknown',
              classification: kind,
            });
          });
          fs.appendFileSync(auditFile, lines.join('\n') + '\n', 'utf8');
        } catch (e) {
          console.error(`[tele-listen] audit log write failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Advance the global offset past the whole fetched batch.
        const maxUpdateId = Math.max(...fetched.map((u) => u.update_id));
        writeOffset(maxUpdateId, botGlobalOffsetFile);
      }
      pruneCache(undefined, botCacheFile);
      pruneAttachmentDirs(path.join(DEFAULT_TMP_DIR, 'attachments'), globalOffset, DEFAULT_TMP_DIR, botId);
    } catch (e) {
      fetchFailed = true;
      console.error(`[tele-listen] getUpdates failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      releasePollLock();
    }
  }

  // React 💔 to orphans outside lock (best-effort, does not block polling).
  // Use the same systemMsgIds snapshot captured under the lock for the variant
  // text decision — keeps classification and response consistent.
  if (pendingOrphans.length > 0) {
    await reactToOrphans(token, pendingOrphans, systemMsgIdsSnapshot);
  }

  // (/pending dispatch moved to daemon.mjs — see note in the fetch block above.)

  // Resolve per-loop offset AFTER fetch+prune so a new loop's min(cache)
  // initialization reflects what is actually still buffered. Calling it before
  // pruning races: pruneCache may remove the oldest cached entries that the
  // new loop's offset would have pointed at, and the subsequent cache read
  // would then yield only newer entries while `advanceLoopOffset` jumped past
  // the now-deleted ones, permanently skipping any matching updates.
  const loopOffset = resolveStartOffset(
    offsetFile,
    botGlobalOffsetFile,
    botCacheFile,
  );

  // Read from local cache using per-loop offset.
  let updates = readCacheSinceOffset(loopOffset, botCacheFile);

  if (fetchFailed && updates.length === 0) {
    process.exit(1);
  }

  const toProcess = collectMessagesToProcess(updates, adminIds, filterReplyTo, mode, teamThreadByChat);

  const advanceLoopOffset = () => {
    if (updates.length > 0) {
      const maxUpdateId = Math.max(...updates.map((u) => u.update_id));
      writeOffset(maxUpdateId, offsetFile);
    }
  };

  if (toProcess.length === 0) {
    // topics.json is written atomically (tmp + rename), so a reader never sees a
    // torn/partial file — a parse failure means GENUINE corruption (persistent),
    // not a transient blip. Holding the offset would wedge the loop forever
    // (S2-M3), so we advance regardless and log loudly for the operator. (A
    // legitimately-empty/missing store has no topic → no convo replies to lose.)
    if (topicsUnavailable) {
      console.error('[tele-listen] topics.json unreadable/corrupt — convo routing disabled until fixed; advancing offset');
    }
    advanceLoopOffset();
    // (Heartbeat auto-reminders moved to daemon.mjs.)
    process.exit(2);
  }

  // ── Burst settle (debounce) — OPT-IN via --settle ─────────────────────────
  // A user often sends ONE task across several Telegram bubbles. Acting on the
  // first bubble builds an incomplete prompt; the trailing bubbles then force a
  // wasteful second pass. Hold the batch until the NEWEST message has been quiet
  // for TELE_SETTLE_MS, so consecutive bubbles coalesce into one combined prompt
  // (buildCombinedPromptData already merges them). Stateless: "defer" = exit(2)
  // WITHOUT advancing the per-loop offset, so the messages stay in cache and
  // replay on the next poll; every new bubble resets the window by lifting
  // `newest`. exit(2) is the supervisors' "no match" code — it resets their
  // failure budget (never trips the give-up breaker) and re-polls after ~5s.
  //
  // OPT-IN (not default): only the LISTEN loops pass --settle (the Monitor
  // `until` command and `--wait-once`). The bare `--convo` DRAIN before a
  // critical action (telegram-guide §"re-poll before critical actions") must
  // NOT settle — it needs to see any pending message NOW and map exit 0/2 to
  // "pending / none". Settling there would let a fresh bubble defer the whole
  // batch (see batch-caveat below), report "none", and let the destructive
  // action proceed past a just-sent correction. Making settle opt-in keeps the
  // drain's safety contract intact by default; the failure mode of forgetting
  // the flag is "no debounce" (safe), not "drain swallows corrections".
  //
  // A message dated in the FUTURE vs the local clock (age < 0) is clock skew —
  // release rather than risk deferring forever on a mis-synced host. See
  // shouldSettleBatch for the full decision rules.
  //
  // Batch caveat (why the drain must not settle): the gate is a SINGLE
  // Math.max(date) over the whole `toProcess` array, deferred all-or-nothing.
  // So one fresh bubble lifts `newest` for the ENTIRE batch — an old backlog
  // riding alongside a just-arrived bubble is held too, not released. A backlog
  // with NO fresh bubble (newest already older than the window) does release
  // immediately; a backlog WITH one does not.
  //
  // Known bound (accepted): deferring holds a MATCHED message unprocessed in the
  // shared cache for up to ~window (~2-3 polls) instead of consuming it on first
  // sight. The cache is shared per BOT TOKEN (not per project — projects on
  // different bot tokens have separate caches). If >500 updates land on that bot
  // within the window, pruneCache (keep-last-500) can evict the deferred message;
  // the same flood keeps the cache read non-empty, so advanceLoopOffset then
  // jumps past it (permanent loss — the global getUpdates offset already advanced
  // at fetch, and eviction removes the only cached copy). That needs ~40+ msg/s
  // sustained on one bot — implausible for human-driven teleport traffic — and
  // only widens the pre-existing cache-bounded-replay window (see
  // resolveStartOffset) from ~0 to ~window. Raise the pruneCache cap if a bot
  // ever carries machine-rate volume.
  // Adaptive settle tiers (see settleWindowFor). Each is env-overridable;
  // set a tier to 0 to disable debounce when that tier applies.
  const tiers = {
    a: process.env.TELE_SETTLE_A_MS != null ? Number(process.env.TELE_SETTLE_A_MS) : SETTLE_MS_A,
    b: process.env.TELE_SETTLE_B_MS != null ? Number(process.env.TELE_SETTLE_B_MS) : SETTLE_MS_B,
    c: process.env.TELE_SETTLE_C_MS != null ? Number(process.env.TELE_SETTLE_C_MS) : SETTLE_MS_C,
  };
  if (settle && shouldSettleBatch(toProcess, Date.now(), tiers)) {
    // Acknowledge NOW so the burst never feels like a hang: 👍 every bubble
    // currently in the batch. setMessageReaction is idempotent, so re-reacting
    // an already-👍'd bubble on a later deferred poll is a harmless no-op;
    // newly arrived bubbles get their 👍 on the poll they first appear.
    // Best-effort — reaction failure must not block the eventual prompt.
    await reactToMessages(token, toProcess);
    process.exit(2); // burst not settled — defer silently; offset NOT advanced → replays next poll
  }

  // Passive roster harvest (best-effort): record each human sender's id/username
  // into projects.json so the PO can fill title/name/position by hand. Never
  // elevates privilege (new rows default to `member`). See roster-upsert.mjs.
  try {
    // Dedicated project → harvest into its own entry; shared (catch-all) → into
    // the `_default` group's roster (all shared projects share that group).
    harvestMembers(
      toProcess.map((m) => m.msg.from),
      { projectCode: projCfg.dedicated ? lookupKey : '_default' },
    );
  } catch {}

  const data = buildCombinedPromptData(toProcess, extractBotId(token), convo, roles, projCfg.description);
  if (data.attachments.length) {
    const baseDir = path.join(path.dirname(promptFile), 'attachments');
    await downloadAttachments(token, data.attachments, baseDir);
  }
  // Record each matched admin reply into the convo tree BEFORE writing the
  // prompt. If the listener is SIGKILL'd between admin-record and prompt-write,
  // the prompt is absent → agent doesn't process → next poll replays the admin
  // messages (still in cache, per-loop offset unchanged). Recording-first means
  // a future bot `--reply-to <X>` routes back via lookupConvoIdByMessageId
  // even if the agent never got the prompt. Skip if convoId unknown.
  if (convo != null) {
    // Pending tracker: admin replied in this convo → bump lastAdminReply,
    // clear remindedAt. Best-effort; failure must not block prompt write.
    try { updatePendingStore((s) => recordAdminReply(s, { convoId: convo })); } catch {}
    const rec = await recordAdminMessagesInConvo({ messages: toProcess, convoId: convo, botId });
    if (!rec.ok) {
      // Lock timed out → admin msgIds NOT in registry. Skip the prompt write
      // so the agent doesn't process replies whose reply-to chain we can't
      // route later. Per-loop offset stays put (no advance below) → next poll
      // replays from cache.
      console.error('[tele-listen] skipping prompt write due to admin-record lock-timeout; will retry next poll');
      process.exit(2);
    }
  }
  // Same-convo prompt-write race guard: re-check listener-registry immediately
  // before writing the prompt so a peer that registered after our last check
  // can still take precedence (otherwise both peers would write the same
  // prompt-convo-<N>.json path, and the second writer's rename clobbers the
  // first — one prompt silently lost).
  if (convo != null) {
    const winner = findPreWriteWinner({ myPid: myMonitorPid, myConvoId: convo, myLoop: loop, registry: readRegistry() });
    if (winner && winner.__inconclusive) {
      process.exit(2); // registry row missing pre-write — defer to next poll (silent)
    }
    if (winner) {
      console.log(`[tele-listen] same-convo peer pid=${winner.pid} won pre-write race — exiting`);
      process.exit(loop ? 3 : 0); // --loop: stand down (3); legacy: end until-loop (0)
    }
  }
  // P3 (--append): coalesce into the OPEN (unclaimed) prompt rather than clobber
  // it; if only a CLAIMED (.processing.json) batch exists, promptFile is absent so
  // this writes a FRESH prompt (spool alongside the claimed one). The take/merge/
  // rm-last + per-convo write-lock now live in the shared mergeOrSpoolPrompt (§5.5)
  // so senders (RFC 03 §5.1) write the OPEN slot the exact same way — serialized
  // against this listener-append and against the pre-existing claim (§5.2).
  if (append) {
    const writeLock = convo != null ? path.join(DEFAULT_TMP_DIR, `prompt-write-${convo}.lock`) : null;
    await mergeOrSpoolPrompt(promptFile, data, writeLock);
  } else if (convo != null) {
    // Non-append single-slot (--wait-once child): the exit-2 guard earlier blocked
    // when a prompt existed, but a SENDER (ask/…, RFC 03 §5.1) may have spooled one
    // into the slot SINCE. Take the SAME per-convo write-lock and re-check under it:
    // if a prompt/claim now exists, DEFER (exit 2) rather than clobber the sender's
    // batch (wait-once announces the existing prompt); else write. Non-append never
    // coalesces — single-slot semantics preserved. (Guards the sender-vs-writer race
    // Codex flagged; without the lock writePromptAtomic could overwrite ask's prompt.)
    const writeLock = path.join(DEFAULT_TMP_DIR, `prompt-write-${convo}.lock`);
    const acquired = await acquireLockWithRetry(writeLock);
    let defer = false;
    try {
      if (!acquired) defer = true;                 // couldn't lock → skip, don't risk an unlocked write
      else if (fs.existsSync(promptFile) || fs.existsSync(processingFile)) defer = true; // sender wrote → don't clobber
      else writePromptAtomic(data, promptFile);
    } finally {
      if (acquired) releasePollLock(writeLock);
    }
    if (defer) process.exit(2);                    // messages stay in cache → retried next poll
  } else {
    // Legacy filter-mode (no convo): no sender writes this path → direct write.
    writePromptAtomic(data, promptFile);
  }
  // React 👍 AFTER successful prompt write to avoid false ack on failure.
  await reactToMessages(token, toProcess);
  advanceLoopOffset();
  const preview = data.text.slice(0, 60);
  const previewMsg = `"${preview}${data.text.length > 60 ? '…' : ''}" (messageId: ${data.messageId})`;
  // RFC 03 unify (announcePreexisting only): the write-path also CLAIMS-before-
  // ANNOUNCES, so it never leaves an OPEN prompt for the top-of-poll claim-branch to
  // RE-announce next poll (the double-announce). Result: exactly one announce/message.
  //
  // claimPreexistingPrompt is the single decider (keyed on `.processing`, not on the
  // write's merged/spooled outcome — which conflates empty-slot with busy-claimed):
  //  - no `.processing` (idle agent, empty slot OR coalesced open prompt) → CLAIM the
  //    just-written open prompt + announce ONCE;
  //  - `.processing` in flight (agent busy) → returns false → we DON'T announce; the
  //    prompt we just spooled waits, and the claim-branch surfaces it once the agent
  //    frees up. Either way: exactly one announce, no dup.
  if (append && announcePreexisting && convo != null) {
    const writeLock = path.join(DEFAULT_TMP_DIR, `prompt-write-${convo}.lock`);
    const claim = claimPreexistingPrompt(promptFile, processingFile, writeLock);
    if (claim) {
      // Same "claimed by listener" marker as the top-of-poll claim-branch (§5.2) so
      // the agent's CLAIM protocol treats both identically: read `.processing`, do
      // NOT re-`mv` (a re-`mv` could clobber `.processing` if a fresh prompt spooled
      // in the race window — subagent FINDING 1).
      console.log(`[tele-listen] prompt ready: ${promptFile} (claimed by listener) ${announceBody(processingFile, data.text)}${claimSuffix(claim)}`);
    }
    process.exit(0);
  }
  console.log(`[tele-listen] prompt written to ${promptFile}: ${previewMsg}`);
  // (Heartbeat auto-reminders moved to daemon.mjs.)
  process.exit(0);
}

// Backoff table + failure cap shared by the --wait-once supervisor below.
const BACKOFF_MS = { success: 0, noMatch: 5000, error: 12000, promptExists: 2000 };
const WAIT_ONCE_MAX_FAILURES = 20;
// Singleton lock for a convo supervisor (--wait-once). Agents may invoke the
// listener after every send; without this guard each invocation
// would spawn a redundant supervisor → many parallel pollers on the
// same convo. Listener-registry supersede catches the dup at the CHILD level
// (newer wins) but causes the loser-supervisor to spin in a spawn-die loop.
//
// Body schema (v2): `v2\n<pid>\n<startTime>`. v2 requires startTime; if our
// own ps capture fails we WARN and reject (don't write a degraded lock).
// Liveness uses (PID alive AND startTime matches) so a recycled PID can't
// masquerade as the original. Legacy single-line PID bodies (v1) fall back
// to liveness-only (back-compat for locks from older builds).
//
// mtime fallback: lock older than WATCHER_LOCK_MAX_AGE_MS is treated as stale
// (covers SIGKILL / segfault). A wait-once poll re-acquires per invocation, so
// it never outlives the max age within a single held lock.
//
// Race protection: after the reap + reopen succeeds, we re-read the body to
// verify it's OURS. If not, a peer raced us and won; we exit cleanly.
const WATCHER_LOCK_MAX_AGE_MS = 30 * 60 * 1000;
const WATCHER_LOCK_BODY_VERSION = 'v2';

function parseLockBody(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const lines = raw.split('\n');
  if (lines[0] === WATCHER_LOCK_BODY_VERSION) {
    return { version: 'v2', pid: Number(lines[1]), startTime: lines[2] ?? '' };
  }
  // Legacy v1: either bare PID or PID\nstartTime.
  return { version: 'v1', pid: Number(lines[0]), startTime: lines[1] ?? '' };
}
function isWatcherLockHolderAlive(body) {
  const parsed = parseLockBody(body);
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 1) return false;
  if (!isProcessAlive(parsed.pid)) return false;
  // v2: startTime REQUIRED. Absent → schema violation → treat as stale.
  if (parsed.version === 'v2') {
    if (!parsed.startTime) return false;
    const current = getProcessStartTime(parsed.pid);
    return current != null && current === parsed.startTime;
  }
  // v1: when startTime present, require match; otherwise liveness-only.
  if (parsed.startTime) {
    const current = getProcessStartTime(parsed.pid);
    return current != null && current === parsed.startTime;
  }
  return true; // legacy v1 bare-PID: best-effort
}
async function acquireConvoSingletonLock(convo, { kind, logPrefix }) {
  fs.mkdirSync(DEFAULT_TMP_DIR, { recursive: true });
  const lockFile = path.join(DEFAULT_TMP_DIR, `${kind}-convo-${convo}.lock`);
  const myStartTime = getProcessStartTime(process.pid);
  if (!myStartTime) {
    console.error(`[${logPrefix}] WARNING: could not capture own startTime; falling back to PID-only v1 lock body`);
  }
  const body = myStartTime
    ? `${WATCHER_LOCK_BODY_VERSION}\n${process.pid}\n${myStartTime}`
    : `${process.pid}`;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, body);
      fs.closeSync(fd);
      // Race-verify: re-read and confirm OUR body landed. A peer that
      // unlink+reopened concurrently could overwrite us between writeSync
      // and now if we both went through reap-and-retry. (Theoretically the
      // O_EXCL guarantees only one succeeds per file-version; but defense in
      // depth.)
      const verify = fs.readFileSync(lockFile, 'utf8').trim();
      if (verify !== body) {
        const pidStr = (verify.split('\n')[0] || '?');
        console.log(`[${logPrefix}] lost race after reap; another ${kind} process (pid ${pidStr}) won for convo ${convo}; exiting`);
        return null;
      }
      return lockFile;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let existing = '';
      try { existing = fs.readFileSync(lockFile, 'utf8').trim(); } catch {}
      let mtimeStale = false;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > WATCHER_LOCK_MAX_AGE_MS) mtimeStale = true;
      } catch {}
      if (!mtimeStale && isWatcherLockHolderAlive(existing)) {
        const pidStr = (existing.split('\n').find((l) => /^\d+$/.test(l)) || '?');
        console.log(`[${logPrefix}] another ${kind} process (pid ${pidStr}) is already running for convo ${convo}; exiting`);
        return null;
      }
      // Reap the stale lock atomically: re-read immediately before unlinking.
      // If the body changed between our liveness check and now, a peer already
      // replaced the file — we'd delete THEIR fresh lock. Skip the unlink in
      // that case and let the next loop iteration's EEXIST re-evaluate.
      try {
        const recheck = fs.readFileSync(lockFile, 'utf8').trim();
        if (recheck === existing) fs.unlinkSync(lockFile);
      } catch {}
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));
    }
  }
  console.log(`[${logPrefix}] could not acquire singleton lock for convo ${convo} after ${MAX_ATTEMPTS} attempts; exiting`);
  return null;
}

async function acquireWaitOnceSingletonLock(convo) {
  return acquireConvoSingletonLock(convo, { kind: 'wait-once', logPrefix: 'tele-wait-once' });
}

// Read what's currently in the lock file — used to capture "our body" so the
// release path can verify we still own the lock before unlinking.
async function readOurLockBody(lockFile) {
  try { return fs.readFileSync(lockFile, 'utf8').trim(); }
  catch { return ''; }
}

// Resolve this project's admin chat ids (RFC 02) and fail-fast if empty —
// shared by main() and the --wait-once supervisor so a misconfigured
// project stops cleanly UP FRONT instead of looping child failures or
// short-circuiting on a stale prompt (review C-Major). Self-contained (loads
// env) so supervisors can call it before any lock/prompt handling.
function requireProjectAdminIdsOrExit(logPrefix = '[tele-listen]') {
  const envFromFile = loadEnvFromFile(ENV_FILE);
  const token = process.env.REPORT_BOT_TOKEN || envFromFile.REPORT_BOT_TOKEN;
  const projectsConfig = readProjectsConfig();
  const fallbackChatId = resolveDefaultChatId(projectsConfig, { env: process.env, envFile: envFromFile });
  // RFC 15: same convo-anchored resolver as main() so a supervisor fail-fast can
  // never compute a different group than the child listener/sender. convoId +
  // botId from env/token (self-contained; no args threaded here). Precedence
  // matches main(): an explicit --convo wins over the session env.
  const argConvo = argConvoFromArgv();
  const routingConvoId = argConvo != null ? argConvo : resolveConvoIdFromEnv({}).convoId;
  const routingBotId = token ? extractBotId(token) : null;
  const routingRows = readConvoRows(CONVO_REGISTRY_FILE).rows;
  const { lookupKey, projCfg } = resolveProjectRouting({
    cwd: process.cwd(), convoId: routingConvoId, botId: routingBotId,
    env: process.env, registryRows: routingRows, projectsConfig, fallbackChatId,
  });
  const adminIds = adminIdsFrom(projCfg, fallbackChatId, parseAdminChatIds);
  if (adminIds.length === 0) {
    const kd = lookupKey || path.basename(process.cwd()) || '(unknown)';
    console.error(`${logPrefix} project "${kd}" chưa cấu hình group: thêm "${kd}".chatId vào teleport/projects.json, hoặc đặt _default.chatId trong projects.json (shared catch-all).`);
    process.exit(1);
  }
  return { envFromFile, lookupKey, projCfg, adminIds, roles: projCfg.roles };
}

export async function waitOnceSupervisor(argv, deps = {}) {
  const spawnFn = deps.spawn ?? spawn;
  const sleepFn = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const exitFn = deps.exit ?? ((code) => process.exit(code));
  const logFn = deps.log ?? ((msg) => console.log(msg));
  const errorFn = deps.error ?? ((msg) => console.error(msg));
  const existsFn = deps.exists ?? ((file) => fs.existsSync(file));
  const acquireLockFn = deps.acquireLock ?? acquireWaitOnceSingletonLock;
  const args = parseArgs(argv);
  if (args.convo == null) {
    const r = resolveConvoIdFromEnv({ argConvo: null });
    if (r.convoId == null) {
      errorFn('[tele-listen] --wait-once requires --convo <N> or a native session env var');
      exitFn(1);
      return;
    }
    args.convo = r.convoId;
  }
  const promptFile = path.join(DEFAULT_TMP_DIR, `prompt-convo-${args.convo}.json`);
  let singletonLock = null;
  let failureCount = 0;
  // Note (review S2-Minor): this path does NOT fail-fast
  // on an unconfigured project up front — a pre-existing prompt short-circuits
  // below before any config check. Residual risk is narrow + low impact: such a
  // prompt was produced by a previously-valid run and no Telegram fetch happens
  // on this path. When no prompt pre-exists, the spawned child (main(), --convo)
  // runs the empty-adminIds fail-fast and exits 1, counted toward the failure
  // cap. Not calling requireProjectAdminIdsOrExit here is deliberate: this
  // function takes injected deps (incl. exit) for tests that don't configure a
  // project, and a hard process-level check would break them.
  while (singletonLock == null) {
    if (existsFn(promptFile)) {
      logFn(`[tele-wait-once] prompt ready: ${promptFile}`);
      exitFn(0);
      return;
    }
    singletonLock = await acquireLockFn(args.convo);
    if (singletonLock == null) {
      failureCount += 1;
      if (failureCount >= WAIT_ONCE_MAX_FAILURES) {
        errorFn(`[tele-wait-once] could not acquire singleton lock for convo ${args.convo} after ${failureCount} attempts`);
        exitFn(1);
        return;
      }
      await sleepFn(BACKOFF_MS.noMatch);
    }
  }
  const ourBody = await readOurLockBody(singletonLock);
  let currentChild = null;
  let stopping = false;
  let released = false;
  const releaseSingleton = () => {
    if (released) return;
    released = true;
    try {
      const current = fs.readFileSync(singletonLock, 'utf8').trim();
      if (current !== ourBody) return;
      fs.unlinkSync(singletonLock);
    } catch {}
  };
  const finish = (code) => {
    releaseSingleton();
    exitFn(code);
  };
  process.on('exit', releaseSingleton);
  const SIGNAL_GRACE_MS = 5000;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      logFn(`[tele-wait-once] received ${sig}; forwarding to child + exiting (grace ${SIGNAL_GRACE_MS}ms)`);
      const childStillRunning = currentChild != null
        && currentChild.exitCode == null && currentChild.signalCode == null;
      if (childStillRunning) {
        try { currentChild.kill(sig); } catch {}
        setTimeout(() => {
          const stillRunning = currentChild != null
            && currentChild.exitCode == null && currentChild.signalCode == null;
          if (stillRunning) {
            errorFn('[tele-wait-once] child did not exit within grace period; SIGKILL + force exit');
            try { currentChild.kill('SIGKILL'); } catch {}
          }
          finish(1);
        }, SIGNAL_GRACE_MS);
      } else {
        finish(0);
      }
    });
  }
  const childArgs = [process.argv[1], '--convo', String(args.convo)];
  const childOffsetFile = args.offsetFileProvided
    ? args.offsetFile
    // --wait-once keeps a stable offset file of its own. Repeated synchronous
    // invocations must not replay a prompt they already consumed.
    : path.join(DEFAULT_TMP_DIR, `convo-${args.convo}-wait-once-offset.txt`);
  childArgs.push('--offset-file', childOffsetFile);
  // Propagate --settle to the child (bare `--convo` main()) so the LISTEN loop
  // debounces bursts. --wait-once rebuilds childArgs, so thread it explicitly here.
  if (args.settle) childArgs.push('--settle');

  logFn(`[tele-wait-once] waiting for one reply in convo ${args.convo}`);
  while (true) {
    if (stopping) return;
    // Defensive heartbeat from the supervisor itself: if a child stalls or
    // the spawn-die loop is in promptExists backoff (no child spawning), we
    // still want admins to see this convo as alive while the supervisor is
    // active. recordAlive's 30s in-process throttle keeps this cheap.
    recordAlive(args.convo);
    if (existsFn(promptFile)) {
      logFn(`[tele-wait-once] prompt ready: ${promptFile}`);
      finish(0);
      return;
    }
    const exitCode = await new Promise((resolve) => {
      const child = spawnFn(process.execPath, childArgs, {
        stdio: 'inherit',
        env: process.env,
      });
      currentChild = child;
      child.on('exit', (code) => { currentChild = null; resolve(code ?? 1); });
      child.on('error', (e) => {
        currentChild = null;
        errorFn(`[tele-wait-once] child spawn failed: ${e instanceof Error ? e.message : String(e)}`);
        resolve(1);
      });
    });
    if (stopping) return;
    if (exitCode === 0) {
      if (existsFn(promptFile)) {
        logFn(`[tele-wait-once] prompt ready: ${promptFile}`);
        finish(0);
        return;
      }
      errorFn(`[tele-wait-once] child exited 0 but prompt was missing: ${promptFile}; continuing`);
      failureCount += 1;
    } else if (exitCode === 1) {
      failureCount += 1;
    } else {
      failureCount = 0;
    }
    if (failureCount >= WAIT_ONCE_MAX_FAILURES) {
      errorFn(`[tele-wait-once] giving up after ${failureCount} consecutive infrastructure failures`);
      finish(1);
      return;
    }
    const sleepMs = exitCode === 2 ? BACKOFF_MS.noMatch : BACKOFF_MS.error;
    await sleepFn(sleepMs);
  }
}

// Exit code for a listener refused on a send-only machine, chosen so every
// documented caller stops cleanly: --loop / --wait-once → 3 (the Monitor wrapper
// `break`s instead of re-arming), bare one-shot (the pre-critical-action drain)
// → 2 "no new admin messages" — this machine owns no inbound stream, so there is
// nothing to drain and the critical action must not be blocked by an "error".
export function sendOnlyExitCode(argv) {
  return argv.includes('--loop') || argv.includes('--wait-once') ? 3 : 2;
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  const argv = process.argv.slice(2);
  // Checked before ANY state is touched (tmp dir, locks, offsets, getUpdates).
  if (resolveSendOnly(readProjectsConfig())) {
    console.error(`[tele-listen] ${SEND_ONLY_LISTEN_REFUSAL}`);
    process.exit(sendOnlyExitCode(argv));
  }
  if (argv.includes('--wait-once')) {
    waitOnceSupervisor(argv).catch((e) => {
      console.error(`[tele-wait-once] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
  } else {
    main().catch((e) => {
      console.error(`[tele-listen] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
  }
}
