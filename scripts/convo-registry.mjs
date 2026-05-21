// Convo registry: stable per-conversation identity for teleport.
//
// Wire-format (one JSON line per row):
//   { "v": 1, "convoId": <int>, "messageId": <int>, "chatId": "<string>",
//     "botId": <int>, "ts": <epoch-ms> }
//
// Invariants
//   - convoId === messageId of the FIRST send (the allocation row).
//   - subsequent appends in convo N MUST reuse the same convoId.
//   - readers tolerate but skip unknown `v` values (forward-compat — prune
//     preserves raw lines so we don't lose unknown rows on rotation).
//
// All write paths (append + prune) hold a single `convo-registry.lock`. Reads
// do not lock: writes go via openSync('a') + fsync (atomic for our small line
// size on local FS) and prune does read → tmp-write → atomic rename. Readers
// that race a half-written trailing line drop it silently (see tolerateTail).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_FILE = path.join(__dirname, 'tmp', 'tele-reply', 'convo-registry.jsonl');
export const DEFAULT_LOCK_FILE = path.join(__dirname, 'tmp', 'tele-reply', 'convo-registry.lock');

export const CONVO_SCHEMA_VERSION = 1;
export const REGISTRY_CAP = 10_000;
export const REGISTRY_KEEP_NON_ALLOC = 8_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;
const LOCK_RETRY_COUNT = 150; // ~3 s total — covers contention from concurrent send + listener record + import-convo

export const CONVO_ID_RE = /^[1-9]\d{0,18}$/;

// Native session env vars the agent runtimes set. Tried in this order; first
// non-empty wins.
export const NATIVE_SESSION_ENV_VARS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];

// Convert a UUID (or any hex string) to a positive integer that fits
// Number.isSafeInteger. We take the first 13 hex chars (52 bits). Caller
// MUST handle null returns (invalid input → no convoId).
export function uuidToConvoInt(s) {
  if (typeof s !== 'string') return null;
  const hex = s.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < 13) return null;
  const head = hex.slice(0, 13);
  const n = parseInt(head, 16);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

// Shared resolver used by send-telegram and tele-listen. Returns a positive
// integer convoId or null when nothing is set. Caller decides whether null is
// an error (most paths require a convoId).
//
// Chain (first non-null wins):
//   1. CLAUDE_CODE_SESSION_ID (UUID) → hex→int
//   2. CODEX_THREAD_ID (UUID) → hex→int
//   3. argConvo (--convo flag) — effective ONLY when no native env (Gemini /
//      other agents). For Claude/Codex it is silently ignored: env is more
//      reliable than asking the agent to remember an integer.
//   4. null — caller may fall back to --reply-to inference (send side)
//             or require --convo (listen side).
export function resolveConvoIdFromEnv({ argConvo = null, env = process.env } = {}) {
  for (const name of NATIVE_SESSION_ENV_VARS) {
    const v = env[name];
    if (v != null && v !== '') {
      const n = uuidToConvoInt(v);
      if (n != null) return { convoId: n, source: name };
      console.error(`[convo-registry] WARNING: ${name} is set but not parseable as UUID/hex; ignoring`);
    }
  }
  if (argConvo != null) return { convoId: argConvo, source: '--convo' };
  return { convoId: null, source: null };
}

// Look up the convoId that owns a given (botId, chatId, messageId). Returns
// the NEWEST matching row's convoId, or null when no match. Newest-wins
// guards against a misrouted older row (e.g. import-convo over-attribution)
// silently overriding a correct rerouting.
export function lookupConvoIdByMessageId(rows, botId, chatId, messageId) {
  const chatStr = String(chatId);
  let best = null;
  for (const row of rows) {
    if (typeof row.v === 'number' && row.v > CONVO_SCHEMA_VERSION) continue;
    if (row.botId !== botId) continue;
    if (String(row.chatId) !== chatStr) continue;
    if (row.messageId !== messageId) continue;
    const ts = Number.isInteger(row.ts) ? row.ts : 0;
    // Strictly-greater ts wins (handles "positive beats zero" automatically).
    // Positive-ts millisecond-tie: later scanned row wins (`>=` only when both
    // are positive; zero-tie keeps first-seen, since file position is unstable
    // across prune).
    if (best == null) {
      best = { convoId: row.convoId, ts };
    } else if (ts > best.ts) {
      best = { convoId: row.convoId, ts };
    } else if (ts === best.ts && ts > 0) {
      best = { convoId: row.convoId, ts };
    }
  }
  return best ? best.convoId : null;
}

export function validateConvoIdString(s) {
  if (typeof s !== 'string' || !CONVO_ID_RE.test(s)) {
    throw new Error(`invalid convoId (expected positive integer string, got ${JSON.stringify(s)})`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`convoId ${s} exceeds JS safe-integer range (2^53-1)`);
  }
  return n;
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false; // reject 0 and init/launchd
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = exists but we can't signal; treat alive
}

export async function acquireLock(lockFile = DEFAULT_LOCK_FILE) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, `${Date.now()}:${process.pid}`);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale-lock reap: body is `${ts}:${pid}`; both must agree it's dead.
      try {
        const body = fs.readFileSync(lockFile, 'utf8').trim();
        const [tsStr, pidStr] = body.split(':');
        const ts = parseInt(tsStr, 10);
        const pid = parseInt(pidStr, 10);
        const stale = !Number.isFinite(ts) || Date.now() - ts > LOCK_STALE_MS;
        const dead = !pidIsAlive(pid);
        if (stale && dead) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  return false;
}

export function releaseLock(lockFile = DEFAULT_LOCK_FILE) {
  try { fs.unlinkSync(lockFile); } catch {}
}

// Parse a single jsonl line. Returns the row object or null on parse error.
// Caller decides what to do with nulls (count + log once per poll).
export function parseRow(line) {
  try {
    const row = JSON.parse(line);
    if (typeof row !== 'object' || row === null) return null;
    return row;
  } catch { return null; }
}

// Read every parseable row. Trailing line tolerance:
//   - If the file ends with '\n' (normal writer path), the split's last
//     element is '' — drop it as a no-op.
//   - If the file ends WITHOUT '\n', the last element is the writer mid-append.
//     We try to parse it; if it parses we keep it (foreign editor closed the
//     file cleanly), if not we drop it silently (partial-tail, not malformed).
export function readRows(registryFile = DEFAULT_REGISTRY_FILE) {
  let raw;
  try { raw = fs.readFileSync(registryFile, 'utf8'); }
  catch { return { rows: [], malformed: 0, rawLines: [] }; }
  const lines = raw.split('\n');
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === '';
  const candidate = endsWithNewline ? lines.slice(0, -1) : lines;
  const rows = [];
  const rawLines = [];
  let malformed = 0;
  for (let i = 0; i < candidate.length; i++) {
    const line = candidate[i];
    if (!line) continue;
    const row = parseRow(line);
    const isTrailingWithoutNewline = !endsWithNewline && i === candidate.length - 1;
    if (row === null) {
      if (isTrailingWithoutNewline) continue; // mid-write tail; not malformed
      malformed += 1;
      continue;
    }
    if (!isRowShapeValid(row)) {
      malformed += 1;
      continue;
    }
    rawLines.push(line);
    rows.push(row);
  }
  return { rows, malformed, rawLines };
}

// Defends prune and filter against junk rows that happen to be JSON-parseable.
// All v1 rows MUST have the integer convoId/messageId/botId + string chatId.
// Forward-compat rows (v > 1) are accepted shape-as-is so prune can preserve
// them byte-for-byte downstream callers can decide what to do.
function isRowShapeValid(row) {
  if (typeof row !== 'object' || row === null) return false;
  if (typeof row.v === 'number' && row.v > CONVO_SCHEMA_VERSION) return true;
  return Number.isInteger(row.convoId)
    && Number.isInteger(row.messageId)
    && Number.isInteger(row.botId)
    && typeof row.chatId === 'string';
}

// Build the (chatId, messageId) filter set for tele-listen.
// Returns Set<string> of `<chatId>:<messageId>`.
export function buildConvoFilter(rows, convoId, botId, chatIds) {
  const chatSet = chatIds instanceof Set ? chatIds : new Set(chatIds.map(String));
  const out = new Set();
  for (const row of rows) {
    if (typeof row.v === 'number' && row.v > CONVO_SCHEMA_VERSION) continue;
    if (row.convoId !== convoId) continue;
    if (row.botId !== botId) continue;
    if (!chatSet.has(String(row.chatId))) continue;
    if (!Number.isInteger(row.messageId)) continue;
    out.add(`${row.chatId}:${row.messageId}`);
  }
  return out;
}

// Has an allocation row for (botId, chatId, convoId)?
// Allocation = the very first row where convoId === messageId.
export function hasAllocationRow(rows, convoId, botId, chatId) {
  const chatStr = String(chatId);
  for (const row of rows) {
    if (typeof row.v === 'number' && row.v > CONVO_SCHEMA_VERSION) continue;
    if (row.convoId === convoId && row.botId === botId
      && String(row.chatId) === chatStr && row.messageId === convoId) {
      return true;
    }
  }
  return false;
}

// Append one row under the lock. The caller MUST have acquired it. We open with
// 'a', write+fsync, close. The trailing newline guarantees a reader sees no
// partial-line ambiguity.
export function appendRowLocked(row, registryFile = DEFAULT_REGISTRY_FILE) {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  const line = JSON.stringify(row) + '\n';
  const fd = fs.openSync(registryFile, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Prune: keep all allocation rows + newest `keepNonAlloc` non-allocation rows.
// Caller MUST hold the lock. Atomic via tmp + rename. Unknown-`v` rows are
// preserved byte-for-byte (raw line) so a future writer's rows survive a
// downgrade-roundtrip.
export function pruneLocked(registryFile = DEFAULT_REGISTRY_FILE) {
  const { rows, rawLines } = readRows(registryFile);
  if (rawLines.length <= REGISTRY_CAP) return { pruned: false, kept: rawLines.length };
  const allocIdx = new Set();
  const forwardIdx = new Set();
  // Track allocation rows (one per (botId, chatId, convoId)).
  const seenAlloc = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row.v === 'number' && row.v > CONVO_SCHEMA_VERSION) {
      forwardIdx.add(i); // unknown v: preserve byte-for-byte
      continue;
    }
    if (row.messageId === row.convoId && row.botId != null && row.chatId != null) {
      const key = `${row.botId}:${row.chatId}:${row.convoId}`;
      if (!seenAlloc.has(key)) {
        allocIdx.add(i);
        seenAlloc.add(key);
      }
    }
  }
  const nonAlloc = [];
  for (let i = 0; i < rows.length; i++) {
    if (allocIdx.has(i) || forwardIdx.has(i)) continue;
    nonAlloc.push(i);
  }
  const keepNonAlloc = nonAlloc.slice(-REGISTRY_KEEP_NON_ALLOC);
  const keepSet = new Set([...allocIdx, ...forwardIdx, ...keepNonAlloc]);
  const next = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (keepSet.has(i)) next.push(rawLines[i]);
  }
  const tmp = registryFile + `.${process.pid}.${Date.now()}.tmp`;
  const body = next.length === 0 ? '' : next.join('\n') + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    if (body) fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, registryFile);
  return { pruned: true, kept: next.length, before: rawLines.length };
}
