// Daemon warns a Claude agent ONCE when its context reaches (auto-compact window − 40k) (RFC 34).
// Runs on the daemon's 60 s heartbeat. The notice is an "info-only" daemon prompt dropped into the agent's
// convo queue (deliverResult); the listener announces it inline and deletes it (tele-listen.mjs, RFC 34 §2.3).
// Nice-to-have: when unsure (window unknown, project overrides it, guessed/twin process) → say nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidToConvoInt } from './convo-registry.mjs';
import { findTranscript, transcriptState, fmtTokens } from './transcript-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const COMPACT_WARN_FILE = path.join(__dirname, 'tmp', 'compact-warn.json');
export const COMPACT_WARN_MARGIN = 40_000; // Thi: warn when context >= window − 40k
// Claude Code compacts ~33k BELOW the window (output reserve + buffer; seen 217k at 250k, ~970k at 1M). Used only in the notice text.
export const AUTO_COMPACT_RESERVE = 33_000;
/** Context size at which the warning fires for window y. Pure. */
export const warnAt = (y) => y - COMPACT_WARN_MARGIN;
export const RESET_RATIO = 0.8;
export const WARNED_TTL_MS = 14 * 24 * 3600 * 1000;
export const MIN_WINDOW = 100_000;
export const MAX_WINDOW = 1_000_000;

// ── y: the auto-compact window (§2.2) ─────────────────────────────────────────

const validWindow = (v) => Number.isInteger(v) && v >= MIN_WINDOW && v <= MAX_WINDOW;
/** Model key normalised for matching: no `[1m]` suffix, no `-YYYYMMDD` date suffix. */
export const normModel = (k) => String(k).trim().replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '').toLowerCase();

/** Default file access: read(file) → string | null (missing), stat(file) → { mtimeMs, isFile, isDir } | null. */
export const realFs = {
  read: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
  stat: (f) => { try { const s = fs.statSync(f); return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile(), isDir: s.isDirectory() }; } catch { return null; } },
};

/** A settings reader cached by file mtime → { json } | { missing } | { broken }. */
export function makeSettingsReader(fsx = realFs) {
  const cache = new Map();
  return (file) => {
    const st = fsx.stat(file);
    if (!st) { cache.delete(file); return { missing: true }; }
    const hit = cache.get(file);
    if (hit && st.mtimeMs != null && hit.mtimeMs === st.mtimeMs) return hit.res;
    const text = fsx.read(file);
    let res;
    if (text == null) res = { missing: true };
    else { try { const j = JSON.parse(text); res = j && typeof j === 'object' && !Array.isArray(j) ? { json: j } : { broken: true }; } catch { res = { broken: true }; } }
    cache.set(file, { mtimeMs: st.mtimeMs, res });
    return res;
  };
}

/** Directories whose `.claude/settings*.json` could set the window: cwd, repo root, main checkout root of a worktree. */
export function projectSettingsDirs(cwd, fsx = realFs) {
  const dirs = [];
  const add = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };
  if (!cwd) return dirs;
  add(cwd);
  let d = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    const g = fsx.stat(path.join(d, '.git'));
    if (g) {
      add(d);
      if (g.isFile) { // worktree: `.git` file → gitdir → commondir → parent of the common .git = main checkout
        const m = /^gitdir:\s*(.+)$/m.exec(fsx.read(path.join(d, '.git')) || '');
        if (m) {
          const gitdir = path.resolve(d, m[1].trim());
          const common = (fsx.read(path.join(gitdir, 'commondir')) || '').trim();
          if (common) add(path.dirname(path.resolve(gitdir, common)));
        }
      }
      break;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirs;
}

/**
 * The auto-compact window for an agent, or null when it can't be known for sure (§2.2).
 * `cfg` = projects.json (`_config.compactWindows` = per-machine override keyed `#hash` | hash | model).
 * home / fsx / readSettings injectable. Never throws.
 */
export function compactWindowFor({ cfg = null, hashtag = null, model = null, cwd = null, home = os.homedir(), fsx = realFs, readSettings = makeSettingsReader(fsx) } = {}) {
  try {
    const ov = cfg?._config?.compactWindows;
    if (ov && typeof ov === 'object') {
      for (const k of [hashtag && `#${hashtag}`, hashtag, model]) {
        const v = k ? Number(ov[k]) : NaN;
        if (validWindow(v)) return v;
      }
    }
    // Project-level settings that set it anywhere → we can't tell which one Claude Code honours → unknown.
    for (const dir of projectSettingsDirs(cwd, fsx)) {
      for (const name of ['settings.local.json', 'settings.json']) {
        const r = readSettings(path.join(dir, '.claude', name));
        if (r.broken) return null;
        const j = r.json;
        if (!j) continue;
        if (Object.hasOwn(j, 'autoCompactWindow')) return null;
        if (j.modelSettings && typeof j.modelSettings === 'object' && Object.values(j.modelSettings).some((m) => m && typeof m === 'object' && Object.hasOwn(m, 'autoCompactWindow'))) return null;
      }
    }
    const r = readSettings(path.join(home, '.claude', 'settings.json'));
    if (r.broken || !r.json) return null;
    const ms = r.json.modelSettings && typeof r.json.modelSettings === 'object' ? r.json.modelSettings : {};
    const entries = Object.entries(ms).filter(([, m]) => m && typeof m === 'object' && Object.hasOwn(m, 'autoCompactWindow'));
    if (model == null && entries.length) return null; // never saw the model, can't pick a modelSettings entry
    const hit = model == null ? [] : entries.filter(([k]) => normModel(k) === normModel(model));
    if (hit.length) {
      const vals = [...new Set(hit.map(([, m]) => m.autoCompactWindow))];
      return vals.length === 1 && validWindow(vals[0]) ? vals[0] : null; // "auto" / conflict / junk → unknown (a stop, no fallback)
    }
    const top = r.json.autoCompactWindow;
    return validWindow(top) ? top : null;
  } catch { return null; }
}

// ── decision (§2.1) ───────────────────────────────────────────────────────────

/**
 * What to do for one agent now. `x` = context tokens, `y` = window, `compacted` = usage says "just compacted",
 * `warned` = the "already warned" mark is set. → { warn: boolean, clear: boolean }. Pure.
 */
export function compactWarnNeed({ x, y, compacted = false, warned = false }) {
  if (compacted) return { warn: false, clear: warned };
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(y > 0)) return { warn: false, clear: false };
  // reset is relative to the warn line (not y): with a small window 0.8·y could sit above warnAt(y) and re-warn repeatedly
  if (x < RESET_RATIO * warnAt(y)) return { warn: false, clear: warned };
  return { warn: x >= warnAt(y) && !warned, clear: false };
}

/** The info-only daemon notice (Thi 13184). `infoOnly` makes the listener announce it inline and delete it. Pure. */
export function buildCompactWarnPrompt({ convoId, chatId, x, y }) {
  return {
    text: `🤖 Teleport daemon: context ~${fmtTokens(x)}/${fmtTokens(y)}, sắp auto compact (sẽ compact khi context chạm ~${fmtTokens(y - AUTO_COMPACT_RESERVE)}). Lưu lại state cần thiết.`,
    messageId: null, chatId: chatId == null ? null : String(chatId),
    fromUserId: null, fromName: 'teleport daemon', fromRole: 'daemon', fromMember: null,
    replyToMessageId: null, replyToText: null, quotedText: null,
    timestamp: Math.floor(Date.now() / 1000), attachments: [], convoId: Number(convoId),
    infoOnly: true,
  };
}

// ── state (§2.4) ──────────────────────────────────────────────────────────────

/** `{ sessionId: { warnedAt } }` on disk, atomic write on every change; entries older than 14 days drop out. */
export function createWarnStore({ file = COMPACT_WARN_FILE, now = () => Date.now() } = {}) {
  let map = null;
  const load = () => {
    if (map) return map;
    map = new Map();
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j || {})) if (v && Number.isFinite(v.warnedAt) && now() - v.warnedAt <= WARNED_TTL_MS) map.set(k, { warnedAt: v.warnedAt });
    } catch { /* none / corrupt → start empty */ }
    return map;
  };
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(load()), null, 1)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  };
  return {
    has: (id) => load().has(id),
    set(id) { load().set(id, { warnedAt: now() }); save(); },
    clear(id) { if (load().delete(id)) save(); },
  };
}

// ── heartbeat pass ────────────────────────────────────────────────────────────

/**
 * One pass over `list()` (claude rows). deps: store (createWarnStore), cache (Map sessionId → { size, mtimeMs, usage, model }),
 * listener(convo) 'on'|'off'|null, deliver(result, { build }), cfg(), windowFor, stat, readUsage(sessionId, cwd) → usage|null,
 * findFile(sessionId, cwd), log. → [{ hashtag, x, y }] of the notices sent.
 */
export async function compactWarnTick({
  list, store, cache, listener, deliver, cfg = () => null, windowFor = compactWindowFor, log = () => {},
  stat = (f) => realFs.stat(f), findFile = findTranscript, readUsage = (id, cwd) => transcriptState(id, cwd).usage,
}) {
  const rows = list();
  const count = new Map();
  for (const r of rows) if (r.hashtag) count.set(r.hashtag, (count.get(r.hashtag) || 0) + 1);
  const live = new Set(rows.map((r) => r.sessionId));
  for (const k of [...cache.keys()]) if (!live.has(k)) cache.delete(k); // RAM only; the disk marks are never pruned by absence
  const out = [];
  for (const r of rows) {
    try {
      if (!r.sessionId || r.guessed) continue;
      if (r.hashtag && count.get(r.hashtag) > 1) continue; // a twin: never guess which one
      const convo = uuidToConvoInt(r.sessionId);
      if (convo == null) continue;
      const file = findFile(r.sessionId, r.cwd);
      const st = file ? stat(file) : null;
      if (!st) continue;
      let c = cache.get(r.sessionId);
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) { // changed (or first sight) → read the tail once
        const usage = readUsage(r.sessionId, r.cwd) ?? null;
        c = { size: st.size, mtimeMs: st.mtimeMs, usage, model: usage?.model ?? c?.model ?? null };
        cache.set(r.sessionId, c);
      }
      const usage = c.usage;
      if (!usage) continue;
      const warned = store.has(r.sessionId);
      const x = usage.tokens;
      const y = usage.compacted || !Number.isFinite(x) ? null : windowFor({ cfg: cfg(), hashtag: r.hashtag ?? null, model: c.model, cwd: r.cwd ?? null });
      const need = compactWarnNeed({ x, y, compacted: !!usage.compacted, warned });
      if (need.clear) store.clear(r.sessionId);
      if (!need.warn) continue;
      if (listener(convo) !== 'on') continue; // retried next tick from the cached usage
      store.set(r.sessionId); // mark BEFORE sending
      try {
        await deliver({ convoId: convo, x, y }, { build: buildCompactWarnPrompt });
      } catch (e) {
        store.clear(r.sessionId); // not delivered → try again next tick
        log(`[compact-warn] #${r.hashtag}: deliver failed: ${e?.message ?? e}`);
        continue;
      }
      log(`[compact-warn] #${r.hashtag}: ${fmtTokens(x)}/${fmtTokens(y)}`);
      out.push({ hashtag: r.hashtag ?? null, x, y });
    } catch (e) { log(`[compact-warn] ${r.hashtag ?? r.pid}: ${e?.message ?? e}`); }
  }
  return out;
}
