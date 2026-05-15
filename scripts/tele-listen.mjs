#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnvFromFile, parseAdminChatIds, postReaction } from './send-telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const TELEGRAM_API = 'https://api.telegram.org/bot';

export const DEFAULT_TMP_DIR = path.join(__dirname, 'tmp', 'tele-reply');
export const DEFAULT_OFFSET_FILE = path.join(DEFAULT_TMP_DIR, 'last-update-id.txt');
export const GLOBAL_OFFSET_FILE = path.join(DEFAULT_TMP_DIR, 'global-offset.txt');
export const DEFAULT_PROMPT_FILE = path.join(DEFAULT_TMP_DIR, 'prompt.json');
export const DEFAULT_PROMPT_PROCESSING_FILE = path.join(DEFAULT_TMP_DIR, 'prompt.processing.json');
export const UPDATES_CACHE_FILE = path.join(DEFAULT_TMP_DIR, 'updates-cache.jsonl');
export const POLL_LOCK_FILE = path.join(DEFAULT_TMP_DIR, 'poll.lock');
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
  for (let i = 0; i < argv.length; i++) {
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
      i++;
    } else if (argv[i].startsWith('--')) {
      throw new Error(`Unknown flag: ${argv[i]}`);
    } else {
      throw new Error(`Unexpected positional argument: ${argv[i]}`);
    }
  }
  return { filterReplyTo, offsetFile };
}

export function filterAdminMessages(updates, adminIds, filterReplyTo = null) {
  const replyToSet = filterReplyTo == null ? null
    : Array.isArray(filterReplyTo) ? new Set(filterReplyTo)
    : new Set([filterReplyTo]);
  return updates
    .filter((u) => {
      const msg = u.message;
      if (!msg || !msg.text) return false;
      if (adminIds.length > 0 && !adminIds.includes(String(msg.chat.id))) return false;
      if (replyToSet != null && !replyToSet.has(msg.reply_to_message?.message_id)) return false;
      return true;
    })
    .map((u) => ({ update: u, msg: u.message }));
}

export function buildPromptData(msg) {
  return {
    text: msg.text,
    messageId: msg.message_id,
    chatId: String(msg.chat.id),
    fromUserId: String(msg.from?.id ?? msg.chat.id),
    replyToMessageId: msg.reply_to_message?.message_id ?? null,
    timestamp: msg.date,
  };
}

/**
 * Combine multiple admin messages into one prompt entry.
 * First message is primary; subsequent are appended as "Admin follow-up: …".
 * messageId/chatId/etc. are taken from the LAST message (newest) so the AI
 * replies to the right thread.
 */
export function buildCombinedPromptData(messages) {
  if (!messages.length) throw new Error('messages must not be empty');
  const [first, ...rest] = messages;
  const text =
    rest.length === 0
      ? first.msg.text
      : [first.msg.text, ...rest.map((m) => `Admin follow-up: ${m.msg.text}`)].join('\n\n');
  const last = messages[messages.length - 1].msg;
  return {
    text,
    messageId: last.message_id,
    chatId: String(last.chat.id),
    fromUserId: String(last.from?.id ?? last.chat.id),
    replyToMessageId: last.reply_to_message?.message_id ?? null,
    timestamp: last.date,
  };
}

export function findOrphanMessages(updates, adminIds) {
  return updates.filter((u) => {
    const msg = u.message;
    if (!msg || !msg.text) return false;
    if (msg.chat.type !== 'private') return false;
    if (adminIds.length > 0 && !adminIds.includes(String(msg.chat.id))) return false;
    if (msg.reply_to_message) return false;
    // Bot API 7.0+: quote-replies may surface reply info in external_reply when the
    // user quoted a fragment, even if reply_to_message is absent. Treat as non-orphan.
    if (msg.external_reply) return false;
    if (msg.text.trim().startsWith('/')) return false;
    return true;
  }).map((u) => ({ update: u, msg: u.message, orphan: true }));
}

export function collectMessagesToProcess(updates, adminIds, filterReplyTo) {
  return filterAdminMessages(updates, adminIds, filterReplyTo);
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
  if (perLoop > 0) return perLoop;

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
  const cache = readCache(cacheFile);
  if (cache.length > 0) {
    // Use reduce instead of Math.min(...spread) to avoid call-stack limits if
    // the cache cap is ever raised above the JS argument limit.
    const minCached = cache.reduce(
      (m, u) => (u.update_id < m ? u.update_id : m),
      Infinity,
    );
    if (Number.isFinite(minCached) && minCached > 0 && (startOffset === 0 || minCached < startOffset)) {
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
  const results = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try { results.push(JSON.parse(line)); } catch {}
  }
  return results;
}

export function readCacheSinceOffset(offset, cacheFile = UPDATES_CACHE_FILE) {
  return readCache(cacheFile).filter((u) => u.update_id >= offset);
}

export function pruneCache(maxEntries = 500, cacheFile = UPDATES_CACHE_FILE) {
  const all = readCache(cacheFile);
  if (all.length <= maxEntries) return;
  const kept = all.slice(-maxEntries);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = cacheFile + `.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, kept.map((u) => JSON.stringify(u)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, cacheFile);
}

export function partitionOrphans(fetched, adminIds) {
  const orphanEntries = findOrphanMessages(fetched, adminIds);
  const orphanIds = new Set(orphanEntries.map((e) => e.update.update_id));
  return {
    orphans: orphanEntries,
    nonOrphan: fetched.filter((u) => !orphanIds.has(u.update_id)),
  };
}

export async function reactToOrphans(token, orphanEntries) {
  const reacted = [];
  for (const entry of orphanEntries) {
    try {
      const { ok, description } = await postReaction(token, String(entry.msg.chat.id), entry.msg.message_id, '🤔');
      if (ok) reacted.push(entry);
      else console.error(`[tele-listen] orphan react rejected for ${entry.msg.message_id}: ${description}`);
    } catch (e) {
      console.error(`[tele-listen] orphan react failed for ${entry.msg.message_id}: ${e instanceof Error ? e.message : String(e)}`);
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

export function writePromptAtomic(data, promptFile = DEFAULT_PROMPT_FILE) {
  const dir = path.dirname(promptFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = promptFile + `.${Date.now()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, promptFile);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[tele-listen] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const { filterReplyTo, offsetFile } = args;

  const envFromFile = loadEnvFromFile(ENV_FILE);
  const token = process.env.REPORT_BOT_TOKEN || envFromFile.REPORT_BOT_TOKEN;
  const adminIds = parseAdminChatIds(
    process.env.TELEGRAM_ADMIN_CHAT_ID || envFromFile.TELEGRAM_ADMIN_CHAT_ID,
  );

  if (!token) {
    console.error('[tele-listen] Missing REPORT_BOT_TOKEN');
    process.exit(1);
  }

  const promptFile = getPromptFile(filterReplyTo);
  const processingFile = getProcessingFile(filterReplyTo);

  if (fs.existsSync(processingFile)) {
    console.log(`[tele-listen] ${path.basename(processingFile)} exists — still processing, skipping`);
    process.exit(2);
  }

  if (fs.existsSync(promptFile)) {
    console.log(`[tele-listen] ${path.basename(promptFile)} exists — not yet consumed, skipping`);
    process.exit(2);
  }

  // Centralized fetch: acquire lock, fetch updates, cache locally.
  // Orphans are detected and excluded from cache under lock; reaction happens after.
  let fetchFailed = false;
  let pendingOrphans = [];
  const lockAcquired = acquirePollLock();
  if (lockAcquired) {
    try {
      const globalOffset = readOffset(GLOBAL_OFFSET_FILE);
      const fetched = await fetchUpdates(token, globalOffset);
      if (fetched.length > 0) {
        const { orphans, nonOrphan } = partitionOrphans(fetched, adminIds);
        pendingOrphans = orphans;
        if (nonOrphan.length > 0) appendToCache(nonOrphan);
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
        const maxUpdateId = Math.max(...fetched.map((u) => u.update_id));
        writeOffset(maxUpdateId, GLOBAL_OFFSET_FILE);
      }
      pruneCache();
    } catch (e) {
      fetchFailed = true;
      console.error(`[tele-listen] getUpdates failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      releasePollLock();
    }
  }

  // React 🤔 to orphans outside lock (best-effort, does not block polling)
  if (pendingOrphans.length > 0) {
    await reactToOrphans(token, pendingOrphans);
  }

  // Resolve per-loop offset AFTER fetch+prune so a new loop's min(cache)
  // initialization reflects what is actually still buffered. Calling it before
  // pruning races: pruneCache may remove the oldest cached entries that the
  // new loop's offset would have pointed at, and the subsequent cache read
  // would then yield only newer entries while `advanceLoopOffset` jumped past
  // the now-deleted ones, permanently skipping any matching updates.
  const loopOffset = resolveStartOffset(offsetFile);

  // Read from local cache using per-loop offset.
  let updates = readCacheSinceOffset(loopOffset);

  if (fetchFailed && updates.length === 0) {
    process.exit(1);
  }

  const toProcess = collectMessagesToProcess(updates, adminIds, filterReplyTo);

  const advanceLoopOffset = () => {
    if (updates.length > 0) {
      const maxUpdateId = Math.max(...updates.map((u) => u.update_id));
      writeOffset(maxUpdateId, offsetFile);
    }
  };

  if (toProcess.length === 0) {
    advanceLoopOffset();
    process.exit(2);
  }

  let data;
  data = buildCombinedPromptData(toProcess);
  writePromptAtomic(data, promptFile);
  // React 👍 AFTER successful prompt write to avoid false ack on failure.
  await reactToMessages(token, toProcess);
  advanceLoopOffset();
  const preview = data.text.slice(0, 60);
  console.log(
    `[tele-listen] prompt written to ${promptFile}: "${preview}${data.text.length > 60 ? '…' : ''}" (messageId: ${data.messageId})`,
  );
  process.exit(0);
}

const isDirectRun = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isDirectRun) {
  main().catch((e) => {
    console.error(`[tele-listen] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
