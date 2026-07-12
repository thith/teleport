#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import { readProjectsConfig, resolveProjectConfig, roleFor, memberFor, adminIdsFrom, resolveDefaultChatId } from './projects-config.mjs';
import { harvestMembers } from './roster-upsert.mjs';
import {
  acquireLock as acquireConvoLock,
  appendRowLocked as appendConvoRow,
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

export async function fetchUpdates(token, offset) {
  const url = `${TELEGRAM_API}${token}/getUpdates?offset=${offset}&timeout=0&limit=100`;
  const res = await fetch(url);
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
  let watch = false;
  let waitOnce = false;
  let settle = false;
  let loop = false;
  let append = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--watch') {
      watch = true;
      continue;
    }
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
  if (watch && filterReplyTo != null) {
    throw new Error('--watch is convo-mode only; --filter-reply-to not supported in watch mode');
  }
  if (waitOnce && filterReplyTo != null) {
    throw new Error('--wait-once is convo-mode only; --filter-reply-to not supported in wait-once mode');
  }
  if (watch && waitOnce) {
    throw new Error('--watch and --wait-once are mutually exclusive');
  }
  return { filterReplyTo, offsetFile, offsetFileProvided, convo, legacyFilter, watch, waitOnce, settle, loop, append };
}

// extractBotId is imported from send-telegram.mjs (single source of truth).

function hasUserContent(msg) {
  return Boolean(
    msg && (msg.text || msg.caption || msg.document || (Array.isArray(msg.photo) && msg.photo.length))
  );
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

function extractAttachments(msg, updateId = null, botId = null) {
  const out = [];
  if (msg.document) {
    const d = msg.document;
    out.push({
      kind: 'document', botId, updateId,
      fileId: d.file_id, fileName: d.file_name ?? null,
      mimeType: d.mime_type ?? null, fileSize: d.file_size ?? null,
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
    if (att.error || (att.kind !== 'document' && att.kind !== 'photo')) continue;
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
      const msg = u.message;
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
    .map((u) => ({ update: u, msg: u.message }));
}

/**
 * Human-readable sender name for attribution (RFC 01 P2). Prefers full name
 * ("Thi" / "Thi Truong"), falls back to "@username", then null. Used so a team
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

export function buildPromptData(msg, updateId = null, botId = null, roles = null) {
  const replyTo = realReplyTo(msg);
  return {
    text: msg.text ?? msg.caption ?? '',
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
    attachments: extractAttachments(msg, updateId, botId),
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

/**
 * Combine multiple admin messages into one prompt entry.
 * Single message → bare text (unchanged). Multi-message batch → each line is
 * prefixed with its sender's "<name> (<role>):" attribution (P2 — replaces the
 * old blanket "Admin follow-up:" that mislabeled non-admin senders and hid who).
 * messageId/chatId/timestamp + reply & quote metadata are taken from the
 * LAST message (newest) so the AI replies to the right thread. Reply/quote
 * metadata from earlier messages in the batch is intentionally dropped.
 */
export function buildCombinedPromptData(messages, botId = null, convoId = null, roles = null, projectDescription = null) {
  if (!messages.length) throw new Error('messages must not be empty');
  const [first, ...rest] = messages;
  const getText = (m) => m.text ?? m.caption ?? '';
  const text =
    rest.length === 0
      ? getText(first.msg)
      : messages.map((m) => `${attributionLabel(m.msg.from, roles)}: ${getText(m.msg)}`).join('\n\n');
  const last = messages[messages.length - 1].msg;
  const replyTo = realReplyTo(last);

  const attachments = [];
  for (const m of messages) {
    attachments.push(...extractAttachments(m.msg, m.update?.update_id ?? null, botId));
  }
  
  const out = {
    text,
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

export function findOrphanMessages(updates, adminIds, systemMsgIds = new Set()) {
  return updates.filter((u) => {
    const msg = u.message;
    if (!hasUserContent(msg)) return false;
    if (msg.chat.type !== 'private') return false;
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
  }).map((u) => ({ update: u, msg: u.message, orphan: true }));
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
  const t = (newestMsg?.text ?? newestMsg?.caption ?? '').trimEnd();
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
  const text = (newestMsg?.text ?? newestMsg?.caption ?? '');
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
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, String(Date.now()));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const content = fs.readFileSync(lockFile, 'utf8').trim();
      const lockTime = parseInt(content, 10);
      if (!isNaN(lockTime) && Date.now() - lockTime > LOCK_STALE_MS) {
        fs.unlinkSync(lockFile);
        return acquirePollLock(lockFile);
      }
    } catch {}
    return false;
  }
}

export function releasePollLock(lockFile = POLL_LOCK_FILE) {
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
    return readRegistry(file);
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

export function findSuperseder({ myPid, myFilter, myConvoId = null, registry }) {
  // Locate my own registry row up front. If it's missing (read-only-fallback
  // path or eviction), treat the supersede check as inconclusive — return a
  // sentinel that the caller interprets as "retry next poll".
  const mineEntry = registry.find((x) => x.pid === myPid);
  for (const e of registry) {
    if (e.pid === myPid) continue;
    // Cross-mode never supersedes (convo vs legacy).
    const eConvo = e.convoId ?? null;
    if ((myConvoId == null) !== (eConvo == null)) continue;
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

export function writePromptAtomic(data, promptFile = DEFAULT_PROMPT_FILE) {
  const dir = path.dirname(promptFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = promptFile + `.${Date.now()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, promptFile);
}

// RFC 02 P3: stale-claim reclaim window.
export const PROCESSING_TTL_MS = 5 * 60 * 1000;

// RFC 02 P3: merge an INCOMING coalesced batch into an OPEN (unclaimed) prompt —
// so a message arriving while a prompt is pending is APPENDED, not blocked/lost.
// Text is concatenated (each side already carries per-sender attribution for
// multi-message batches); metadata (messageId/chat/reply/quote/sender/timestamp
// + persona/projectDescription) comes from the INCOMING/newest side so the agent
// still replies to the right thread; attachments are unioned. Pure + total.
export function mergePromptData(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return {
    ...incoming,
    text: `${existing.text ?? ''}\n\n${incoming.text ?? ''}`,
    attachments: [...(existing.attachments ?? []), ...(incoming.attachments ?? [])],
  };
}

// RFC 02 P3: an agent that CLAIMED a batch (rename prompt→.processing.json) but
// died before consuming leaves an orphan. After PROCESSING_TTL_MS, fold it back
// into the OPEN prompt (merging any batch spooled meanwhile) with a warning, so
// the next agent re-handles it instead of the convo wedging. Best-effort.
function reclaimStaleProcessing(processingFile, promptFile) {
  try {
    let claimed;
    try { claimed = JSON.parse(fs.readFileSync(processingFile, 'utf8')); }
    catch { fs.rmSync(processingFile, { force: true }); return; }
    claimed.text = `⚠️ (khôi phục lô bị treo — agent trước đã claim rồi dừng giữa chừng)\n\n${claimed.text ?? ''}`;
    if (fs.existsSync(promptFile)) {
      let open = null;
      try { open = JSON.parse(fs.readFileSync(promptFile, 'utf8')); } catch {}
      writePromptAtomic(open ? mergePromptData(claimed, open) : claimed, promptFile);
      fs.rmSync(processingFile, { force: true });
    } else {
      fs.renameSync(processingFile, promptFile);
    }
  } catch { /* best-effort; a later poll retries */ }
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
  let { filterReplyTo, offsetFile, offsetFileProvided, convo, legacyFilter, settle, loop, append } = args;

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
  const lookupKey = path.basename(process.cwd()) || '';
  const projectsConfig = readProjectsConfig();
  const fallbackChatId = resolveDefaultChatId(projectsConfig, { env: process.env, envFile: envFromFile });
  const projCfg = resolveProjectConfig(lookupKey, { config: projectsConfig, fallbackChatId });
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
    console.error(`[tele-listen] project "${lookupKey}" chưa cấu hình group: thêm "${lookupKey}".chatId vào teleport/projects.json, hoặc đặt _default.chatId trong projects.json (shared catch-all).`);
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
    // dead. waitOnce/watch supervisors touch from their own loop bodies.
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
  const registry = await refreshRegistry({ pid: myMonitorPid, filter: filterReplyTo, offsetFile, convoId: convo });
  const superseder = findSuperseder({ myPid: myMonitorPid, myFilter: filterReplyTo, myConvoId: convo, registry });
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

  // Prompt file path: stable per-convo for `--convo`, filter-keyed for legacy.
  const promptFile = convo != null
    ? path.join(DEFAULT_TMP_DIR, `prompt-convo-${convo}.json`)
    : getPromptFile(filterReplyTo);
  const processingFile = convo != null
    ? path.join(DEFAULT_TMP_DIR, `prompt-convo-${convo}.processing.json`)
    : getProcessingFile(filterReplyTo);

  if (append) {
    // P3: do NOT block. Reclaim a stale claim (agent died mid-processing), then
    // fall through to fetch + append-to-open / spool-fresh below.
    if (fs.existsSync(processingFile)) {
      let stale = false;
      try { stale = Date.now() - fs.statSync(processingFile).mtimeMs > PROCESSING_TTL_MS; } catch {}
      if (stale) reclaimStaleProcessing(processingFile, promptFile);
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
            const m = u.message;
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
              has_text: Boolean(m?.text),
              text_preview: m?.text ? m.text.slice(0, 60) : null,
              update_type: m
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
    const fresh = readRegistry();
    const mineEntry = fresh.find((e) => e.pid === myMonitorPid);
    if (!mineEntry) {
      process.exit(2); // registry row missing pre-write — defer to next poll (silent)
    }
    for (const e of fresh) {
      if (e.pid === myMonitorPid) continue;
      if ((e.convoId ?? null) !== convo) continue;
      if (compareSameConvo(e, mineEntry) > 0) {
        console.log(`[tele-listen] same-convo peer pid=${e.pid} won pre-write race — exiting`);
        process.exit(loop ? 3 : 0); // --loop: stand down (3); legacy: end until-loop (0)
      }
    }
  }
  // P3 (--append): coalesce into the OPEN (unclaimed) prompt rather than clobber
  // it; if only a CLAIMED (.processing.json) batch exists, promptFile is absent
  // here so this writes a FRESH prompt (spool alongside the claimed one).
  let toWrite = data;
  if (append && fs.existsSync(promptFile)) {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(promptFile, 'utf8')); } catch {}
    if (existing) toWrite = mergePromptData(existing, data);
  }
  writePromptAtomic(toWrite, promptFile);
  // React 👍 AFTER successful prompt write to avoid false ack on failure.
  await reactToMessages(token, toProcess);
  advanceLoopOffset();
  const preview = data.text.slice(0, 60);
  console.log(
    `[tele-listen] prompt written to ${promptFile}: "${preview}${data.text.length > 60 ? '…' : ''}" (messageId: ${data.messageId})`,
  );
  // (Heartbeat auto-reminders moved to daemon.mjs.)
  process.exit(0);
}

// Supervisor for --watch: spawns child invocations of itself (without --watch)
// in an internal loop so a single tele-listen process survives an agent turn
// ending. Behavior per loop iteration:
//   - If prompt-convo-<N>.json exists (unconsumed) → sleep 2s, retry.
//   - Else spawn child. On child exit, sleep based on exit code:
//       0 (wrote prompt) → no sleep; next iteration's exists-check serves as
//                          the "wait until agent consumed" gate.
//       1 (error)         → sleep 12s.
//       2 (no match / superseded / processing) → sleep 5s.
//   - SIGTERM/SIGINT forwarded to the current child and supervisor exits.
const BACKOFF_MS = { success: 0, noMatch: 5000, error: 12000, promptExists: 2000 };
const WAIT_ONCE_MAX_FAILURES = 20;
// Singleton lock for the watcher supervisor. Agents may invoke `--watch`
// after every send; without this guard each invocation
// would spawn a redundant supervisor → many parallel watchers polling the
// same convo. Listener-registry supersede catches the dup at the CHILD level
// (newer wins) but causes the loser-supervisor to spin in a spawn-die loop.
//
// Body schema (v2): `v2\n<pid>\n<startTime>`. v2 requires startTime; if our
// own ps capture fails we WARN and reject (don't write a degraded lock).
// Liveness uses (PID alive AND startTime matches) so a recycled PID can't
// masquerade as the original. Legacy single-line PID bodies (v1) fall back
// to liveness-only (back-compat for in-flight watchers from older builds).
//
// mtime fallback: lock older than WATCHER_LOCK_MAX_AGE_MS without periodic
// refresh is treated as stale (covers SIGKILL / segfault). A healthy
// supervisor refreshes mtime every WATCHER_LOCK_REFRESH_MS so it's never
// reaped while alive.
//
// Race protection: after the reap + reopen succeeds, we re-read the body to
// verify it's OURS. If not, a peer raced us and won; we exit cleanly.
const WATCHER_LOCK_MAX_AGE_MS = 30 * 60 * 1000;
const WATCHER_LOCK_REFRESH_MS = 5 * 60 * 1000;
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

async function acquireWatcherSingletonLock(convo) {
  return acquireConvoSingletonLock(convo, { kind: 'watcher', logPrefix: 'tele-watch' });
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
// shared by main() and the --watch/--wait-once supervisors so a misconfigured
// project stops cleanly UP FRONT instead of looping child failures or
// short-circuiting on a stale prompt (review C-Major). Self-contained (loads
// env) so supervisors can call it before any lock/prompt handling.
function requireProjectAdminIdsOrExit(logPrefix = '[tele-listen]') {
  const envFromFile = loadEnvFromFile(ENV_FILE);
  const lookupKey = path.basename(process.cwd()) || '';
  const projectsConfig = readProjectsConfig();
  const fallbackChatId = resolveDefaultChatId(projectsConfig, { env: process.env, envFile: envFromFile });
  const projCfg = resolveProjectConfig(lookupKey, { config: projectsConfig, fallbackChatId });
  const adminIds = adminIdsFrom(projCfg, fallbackChatId, parseAdminChatIds);
  if (adminIds.length === 0) {
    console.error(`${logPrefix} project "${lookupKey}" chưa cấu hình group: thêm "${lookupKey}".chatId vào teleport/projects.json, hoặc đặt _default.chatId trong projects.json (shared catch-all).`);
    process.exit(1);
  }
  return { envFromFile, lookupKey, projCfg, adminIds, roles: projCfg.roles };
}

async function watchSupervisor(argv) {
  const args = parseArgs(argv);
  requireProjectAdminIdsOrExit('[tele-listen]'); // fail-fast before supervising

  if (args.convo == null) {
    // Fall through to env resolution to find the convo.
    const r = resolveConvoIdFromEnv({ argConvo: null });
    if (r.convoId == null) {
      console.error('[tele-listen] --watch requires --convo <N> or a native session env var');
      process.exit(1);
    }
    args.convo = r.convoId;
  }
  const singletonLock = await acquireWatcherSingletonLock(args.convo);
  if (singletonLock == null) {
    // acquireWatcherSingletonLock already logged the reason.
    process.exit(0);
  }
  // State shared across signal handler, refresh timer, and the main loop.
  // `stopping` doubles as a wake-up signal for interruptible sleeps.
  const ourBody = await readOurLockBody(singletonLock);
  let lostRace = false;
  let stopping = false;
  let currentChild = null;
  let stopResolve = null;
  const stopPromise = new Promise((r) => { stopResolve = r; });
  // Interruptible sleep that resolves early on shutdown signal.
  const sleepMaybe = (ms) => {
    if (ms <= 0 || stopping) return Promise.resolve();
    return Promise.race([
      new Promise((r) => setTimeout(r, ms)),
      stopPromise,
    ]);
  };
  // Release lock on every exit path. `process.on('exit')` only allows sync ops.
  // CRITICAL: if we lost a race after writing (winner replaced our file), we
  // MUST NOT unlink — otherwise we delete the winner's lock and a third
  // supervisor sneaks in.
  const releaseSingleton = () => {
    if (lostRace) return;
    try {
      const current = fs.readFileSync(singletonLock, 'utf8').trim();
      if (current !== ourBody) return; // someone else owns it now
      fs.unlinkSync(singletonLock);
    } catch {}
  };
  process.on('exit', releaseSingleton);
  // Periodic mtime touch + missing-file re-acquire.
  const refreshTimer = setInterval(() => {
    if (lostRace || stopping) return;
    try {
      fs.utimesSync(singletonLock, new Date(), new Date());
    } catch (e) {
      if (e.code !== 'ENOENT') return;
      try {
        const fd = fs.openSync(singletonLock, 'wx');
        fs.writeSync(fd, ourBody);
        fs.closeSync(fd);
      } catch {
        lostRace = true;
        console.log('[tele-watch] lock file taken over by another supervisor; exiting');
        stopping = true;
        stopResolve?.();
        clearInterval(refreshTimer);
        process.exit(0);
      }
    }
  }, WATCHER_LOCK_REFRESH_MS);
  const promptFile = path.join(DEFAULT_TMP_DIR, `prompt-convo-${args.convo}.json`);
  // Strip --watch from the child argv; pass --convo explicitly.
  const childArgs = [process.argv[1], '--convo', String(args.convo)];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--watch') continue;
    if (argv[i] === '--convo') { i++; continue; }
    childArgs.push(argv[i]);
  }

  console.log(`[tele-watch] supervisor started for convo ${args.convo} (pid ${process.pid})`);

  // Graceful shutdown so a ctrl-C/SIGTERM doesn't leave a stale lock.
  // SIGNAL_GRACE_MS: wait this long for the child to exit cleanly after the
  // forwarded signal; then SIGKILL + force-exit so a stuck child can never
  // strand the supervisor (and its singleton lock).
  const SIGNAL_GRACE_MS = 5000;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      stopResolve?.(); // wake any sleepMaybe / stopPromise awaiter
      clearInterval(refreshTimer);
      console.log(`[tele-watch] received ${sig}; forwarding to child + exiting (grace ${SIGNAL_GRACE_MS}ms)`);
      const childStillRunning = (c) => c != null
        && c.exitCode == null && c.signalCode == null;
      if (childStillRunning(currentChild)) {
        try { currentChild.kill(sig); } catch {}
        // Ref'd timer (no unref) so it reliably fires across the grace window.
        setTimeout(() => {
          if (childStillRunning(currentChild)) {
            console.error('[tele-watch] child did not exit within grace period; SIGKILL + force exit');
            try { currentChild.kill('SIGKILL'); } catch {}
          }
          process.exit(1);
        }, SIGNAL_GRACE_MS);
      } else {
        process.exit(0);
      }
    });
  }

  // Pending/resume logging state — log transition edges only, not every poll,
  // so the operator sees clear markers in the log stream:
  //   "prompt pending — waiting for agent consume"
  //   "prompt consumed — resuming polling"
  let pendingLogged = false;
  while (!stopping) {
    // Heartbeat from the watch supervisor itself; child spawns alone aren't
    // enough when the loop is paused on promptExists backoff.
    recordAlive(args.convo);
    // Don't overwrite an unconsumed prompt — the agent hasn't read it yet.
    // NOTE: while paused here, this supervisor's child is NOT polling Telegram.
    // Other listeners (e.g. Claude Monitor) may still fetch + cache updates;
    // when the agent consumes the prompt, our next child poll reads them from
    // the local cache. If the only listener is THIS supervisor, replies that
    // arrive while paused will be picked up on the resume — the cache window
    // is bounded (500 updates) so very high admin-traffic bursts could miss.
    if (fs.existsSync(promptFile)) {
      if (!pendingLogged) {
        console.log(`[tele-watch] prompt pending — waiting for agent to consume ${path.basename(promptFile)}`);
        pendingLogged = true;
      }
      await sleepMaybe(BACKOFF_MS.promptExists);
      continue;
    }
    if (pendingLogged) {
      console.log('[tele-watch] prompt consumed — resuming polling');
      pendingLogged = false;
    }
    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, childArgs, {
        stdio: 'inherit',
        env: process.env,
      });
      currentChild = child;
      child.on('exit', (code) => { currentChild = null; resolve(code ?? 1); });
      child.on('error', (e) => {
        currentChild = null;
        console.error(`[tele-watch] child spawn failed: ${e instanceof Error ? e.message : String(e)}`);
        resolve(1);
      });
    });
    if (stopping) break;
    const sleepMs = exitCode === 0 ? BACKOFF_MS.success
      : exitCode === 2 ? BACKOFF_MS.noMatch
      : BACKOFF_MS.error;
    await sleepMaybe(sleepMs);
  }
  clearInterval(refreshTimer); // free the loop so the supervisor exits promptly
  console.log(`[tele-watch] supervisor exiting`);
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
  // Note (review S2-Minor): unlike watchSupervisor, this path does NOT fail-fast
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
    // --wait-once intentionally keeps a stable offset distinct from --watch's
    // PPID-scoped offset. Repeated synchronous invocations must not replay a
    // prompt they already consumed, while --watch can keep its own loop state.
    : path.join(DEFAULT_TMP_DIR, `convo-${args.convo}-wait-once-offset.txt`);
  childArgs.push('--offset-file', childOffsetFile);
  // Propagate --settle to the child (bare `--convo` main()) so the LISTEN loop
  // debounces bursts. --watch forwards argv verbatim; --wait-once rebuilds
  // childArgs, so thread it explicitly here.
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

const isDirectRun = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isDirectRun) {
  const argv = process.argv.slice(2);
  if (argv.includes('--watch')) {
    watchSupervisor(argv).catch((e) => {
      console.error(`[tele-watch] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
  } else if (argv.includes('--wait-once')) {
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
