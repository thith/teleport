// transcript-state.mjs — what a Claude Code transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`)
// says about its session, read from the TAIL only (RFC 22 §2.4, §2.7):
//   • turnEnded(lines)   — is the last turn over? (the session file says `shell` for an idle
//                          agent that keeps a Monitor running, so status alone can't tell)
//   • contextUsage(lines) — how full the context is (last main-chain API call), or "just compacted"
//   • compactAfter(file, offset) — a NEW manual compact_boundary written after `offset`
// Pure helpers take parsed lines; the I/O layer reads the tail in growing blocks.

import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, cwdToProjectSlug, UUID_RE } from './claude-procs.mjs';

export const TAIL_START = 512 * 1024;
export const TAIL_MAX = 8 * 1024 * 1024;

const contentText = (msg) => {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
  return '';
};
const isToolResult = (msg) => Array.isArray(msg?.content) && msg.content.some((p) => p?.type === 'tool_result');

/**
 * Walk back over main-chain lines; the first MEANINGFUL one decides (RFC 22 §2.4, v6).
 * Unknown line types are ignored (no deny-list). → true (turn over) | false (in a turn) | null (no evidence).
 *   done:     system turn_duration / stop_hook_summary / compact_boundary; a user interrupt marker;
 *             a user line carrying local-command OUTPUT (<local-command-stdout|stderr>) or isCompactSummary
 *   not done: any other user line (prompt, isMeta agent/cron message, bare <command-name>, caveat,
 *             tool_result) or an assistant line; a queue-operation enqueue not cancelled by a later dequeue
 */
export function turnEnded(lines) {
  let dequeues = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = lines[i];
    if (!j || typeof j !== 'object' || j.isSidechain) continue;
    if (j.type === 'queue-operation') {
      if (j.operation === 'dequeue' || j.operation === 'remove') dequeues++;
      else if (j.operation === 'enqueue') { if (dequeues > 0) dequeues--; else return false; }
      continue;
    }
    if (j.type === 'system') {
      if (['turn_duration', 'stop_hook_summary', 'compact_boundary'].includes(j.subtype)) return true;
      continue;
    }
    if (j.type === 'assistant') return false;
    if (j.type === 'user') {
      if (j.isCompactSummary) return true;
      const t = contentText(j.message);
      if (!isToolResult(j.message)) {
        if (/^\s*\[Request interrupted by user/.test(t)) return true;
        if (/<local-command-std(out|err)>/.test(t)) return true;
      }
      return false;
    }
  }
  return null;
}

/**
 * Context fill from the last main-chain assistant line with real usage:
 * input + cache_read + cache_creation (output excluded). A compact_boundary AFTER it means
 * that number is stale → { compacted: true, tokens: postTokens }. → null when unknown.
 */
export function contextUsage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = lines[i];
    if (!j || typeof j !== 'object' || j.isSidechain) continue;
    if (j.type === 'system' && j.subtype === 'compact_boundary') {
      const post = Number(j.compactMetadata?.postTokens);
      return { compacted: true, tokens: Number.isFinite(post) ? post : null, model: null };
    }
    if (j.type !== 'assistant') continue;
    const m = j.message;
    if (!m || m.model === '<synthetic>') continue;
    const u = m.usage || {};
    const tokens = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    if (tokens > 0) return { compacted: false, tokens, model: m.model || null };
  }
  return null;
}

/** "733k" / "8k" / "950". Pure. */
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '?';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Context window for a session: `_config.contextWindows` keyed by hashtag (`#abcd1234` or `abcd1234`) or model id.
 * Never guessed from the model id alone (the transcript's id has no `[1m]`). → number | null. Pure.
 */
export function contextWindowFor(cfg, { hashtag = null, model = null } = {}) {
  const w = cfg?._config?.contextWindows;
  if (!w || typeof w !== 'object') return null;
  for (const k of [hashtag && `#${hashtag}`, hashtag, model]) {
    const v = k ? Number(w[k]) : NaN;
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** "ctx 733k (73%)" · "ctx 733k" · "vừa compact (~8k)" · null. Pure. */
export function formatContext(usage, window = null) {
  if (!usage) return null;
  if (usage.compacted) return `vừa compact${usage.tokens != null ? ` (~${fmtTokens(usage.tokens)})` : ''}`;
  const pct = window ? ` (${Math.round((usage.tokens / window) * 100)}%)` : '';
  return `ctx ${fmtTokens(usage.tokens)}${pct}`;
}

/** Parse complete JSONL lines; a cut first line / garbage line is skipped. Pure. */
export function parseJsonl(text, { dropFirst = false } = {}) {
  const parts = String(text).split('\n');
  if (dropFirst) parts.shift(); // started mid-line
  const out = [];
  for (const l of parts) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

// ── I/O ───────────────────────────────────────────────────────────────────────

/** The transcript file of a session: `<projects>/<slug(cwd)>/<id>.jsonl`, else a scan of project dirs. */
export function findTranscript(sessionId, cwd, { projectsDir = PROJECTS_DIR } = {}) {
  if (!sessionId || !UUID_RE.test(sessionId)) return null;
  if (cwd) {
    const f = path.join(projectsDir, cwdToProjectSlug(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const f = path.join(projectsDir, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

/**
 * Read the tail of `file` in growing blocks (512 KB → 8 MB) until `decide(lines)` returns
 * non-null (or the whole file / the cap is read). → { lines, size, result }.
 */
export function readTail(file, decide = () => true, { start = TAIL_START, max = TAIL_MAX } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { lines: [], size: 0, result: null }; }
  try {
    const size = fs.fstatSync(fd).size;
    let len = Math.min(start, size), lines = [], result = null;
    for (;;) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      lines = parseJsonl(buf.toString('utf8'), { dropFirst: len < size });
      result = decide(lines);
      if (result != null || len >= size || len >= max) break;
      len = Math.min(len * 4, size, max);
    }
    return { lines, size, result };
  } finally { try { fs.closeSync(fd); } catch {} }
}

/** { ended, usage, size } for a session's transcript (each null when unknown). */
export function transcriptState(sessionId, cwd, opts = {}) {
  const file = findTranscript(sessionId, cwd, opts);
  if (!file) return { file: null, ended: null, usage: null, size: null };
  const a = readTail(file, turnEnded, opts);
  const usage = contextUsage(a.lines) ?? readTail(file, contextUsage, opts).result;
  return { file, ended: a.result, usage, size: a.size };
}

/**
 * A manual compact_boundary written AFTER the baseline `{ size, ino, dev }` recorded before typing
 * (a bare number = size only). → { postTokens, preTokens } | null (not yet) | { error } (file shrank
 * or was replaced — a boundary in another file can't be attributed to our command).
 */
export function compactAfter(file, base) {
  const b = typeof base === 'number' ? { size: base } : (base || {});
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { error: 'transcript biến mất' }; }
  try {
    const st = fs.fstatSync(fd); // identity + size of the file we actually read
    if ((b.ino != null && st.ino !== b.ino) || (b.dev != null && st.dev !== b.dev)) return { error: 'transcript bị thay file' };
    if (st.size < b.size) return { error: 'transcript bị cắt ngắn / thay' };
    if (st.size === b.size) return null;
    const buf = Buffer.alloc(st.size - b.size);
    fs.readSync(fd, buf, 0, buf.length, b.size);
    for (const j of parseJsonl(buf.toString('utf8'))) {
      if (j.type === 'system' && j.subtype === 'compact_boundary' && !j.isSidechain && j.compactMetadata?.trigger === 'manual') {
        const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
        return { postTokens: num(j.compactMetadata.postTokens), preTokens: num(j.compactMetadata.preTokens) };
      }
    }
    return null;
  } catch { return null; } finally { try { fs.closeSync(fd); } catch {} }
}
