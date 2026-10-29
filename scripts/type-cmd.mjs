// type-cmd.mjs — RFC 22 `/type`: type ONE approved Claude command (/compact, /remote-control,
// ⎋ Esc) into an agent's `tele-*` screen session, from the daemon (owner only).
//
// Safety model (RFC 22 §2):
//   • a target is pinned at listing time: pid + procStart + sessionId + screenPid, and re-checked
//     before EVERY keystroke (pid alive, same start, same session file, parent = that SCREEN,
//     the screen has exactly one window);
//   • commands only when the agent is surely idle (status `idle`, or `shell` + the transcript says
//     the turn is over); Esc only when it is `busy`/`waiting`;
//   • typed text is verified on screen BEFORE Enter (the live input line must be exactly the
//     command and the suggestion box must select it); any doubt → no more keys at all;
//   • no automatic retries; the report says what was TYPED, then the observed result.
// Probe facts behind the screen parsing are in RFC 22 §1.1 (Claude Code 2.1.300).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { listClaudeProcs, parseSessionFile, inspectPid, SESSIONS_DIR } from './claude-procs.mjs';
import { parseAgentTarget, normalizeAgentName, unquoteTarget, resolveTail } from './agent-target.mjs';
export { unquoteTarget };
import { createListenerStatus } from './listener-status.mjs';
import { countUnread } from './mailbox.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { transcriptState, findTranscript, compactAfter, formatContext, contextWindowFor, fmtTokens } from './transcript-state.mjs';

export const TYPE_BUTTON_TTL_MS = 10 * 60 * 1000;
export const TYPE_GAP_MS = 500;          // text → Enter (paste detection / suggestion box)
export const TYPE_SETTLE_MS = 12000;     // how long to keep re-reading until the typed text shows (a busy box renders late; an ATTACHED screen with a background tool running measured ~5–6 s). Every loop exits early on a match.
export const SHOTS_KEEP = 10;            // hardcopies kept in type-shots/ (mismatch diagnostics)
export const PROBE_CHAR = 'x';           // typed (then ⌫) to tell an empty box from Claude's dim suggestion
// One clear round: End, kill to line start, kill to line end (on the now-empty line: pulls the next
// line up), ⌫ (at column 0: joins the previous line). Repeated, it empties a draft of any length,
// wherever the cursor is (probed on Claude Code 2.1.302: 4 pasted lines, cursor on line 2).
export const CLEAR_ROUND = '\x05\x15\x0b\x7f';
export const CLEAR_ROUNDS_PER_SEND = 10;
export const CLEAR_MAX_SENDS = 10;
export const COOLDOWN_MS = 5000;         // after Enter the session file still says idle for a moment
export const ESC_GAP_MS = 3000;          // two quick Escs at idle open the Rewind menu
export const RC_DIALOG_WAIT_MS = 5000;
export const RC_BRIDGE_WAIT_MS = 15000;
export const COMPACT_WATCH_MS = 5 * 60 * 1000;
export const COMPACT_QUEUED_WATCH_MS = 30 * 60 * 1000; // queued behind a running turn
export const AUDIT_FILE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'teleport', 'type-audit.jsonl');

/** Keep only the `keep` newest files in `dir` (names start with an ISO timestamp → name order = age). Never throws. */
export function pruneShots(dir, keep = SHOTS_KEEP) {
  try { for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.txt')).sort().reverse().slice(keep)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } } catch {}
}
/** Save a raw hardcopy as <dir>/<name> (0600, dir 0700), then prune. → path, or null. Best-effort, never throws. */
export function saveShotFile(dir, name, text, keep = SHOTS_KEEP) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700); // mkdir leaves an existing dir's mode as it was
    const file = path.join(dir, name);
    // 'wx' = O_EXCL: never reuse an existing file's mode or follow a planted symlink.
    fs.writeFileSync(file, Buffer.from(String(text), 'latin1'), { mode: 0o600, flag: 'wx' });
    pruneShots(dir, keep);
    return file;
  } catch { return null; }
}

// op letter (callback data) → command. Fixed table: the command never comes from stored data.
// 'k' only asks (a confirm button follows); 'y' is that confirmation: /kill pid:<PID> (SIGTERM), not a keystroke.
export const TYPE_OPS = { c: '/compact', r: '/remote-control', e: 'esc', i: 'read-input', u: 'clear-input', k: 'kill-ask', y: 'kill', n: 'nudge' };
// The lines /nudge types (Thi, RFC 26) — fixed, never from input. They arrive as host input, so each asks
// for a Telegram status or the owner sees nothing. Keep them ≤ NUDGE_MAX_LEN: an 80-column screen must not wrap one.
export const NUDGE_LINES = {
  both: 'Restart Telegram monitor, check mailbox, post a status in your topic.',
  listener: 'Restart Telegram monitor, then post a status in your topic.',
  mail: 'Check your mailbox, then post a status in your topic.',
};
export const NUDGE_TEXT = NUDGE_LINES.both;
export const NUDGE_MAX_LEN = 70;
export const COMPACT_OK = '✅ đã compact'; // a watch() result starting with this = a confirmed compaction
export const TYPE_BUTTON_RE = /^ty:(?:pick:([0-9a-z]{8})|([0-9a-f]{16}):([crexiukyn]))$/;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** status + transcript verdict → 'idle' | 'busy' | 'waiting' | 'unknown'. Pure. */
export function classify(status, ended) {
  if (status === 'idle') return 'idle';
  if (status === 'busy') return 'busy';
  if (status === 'waiting') return 'waiting';
  if (status === 'shell') return ended === true ? 'idle' : ended === false ? 'busy' : 'unknown';
  return 'unknown';
}

export const STATE_LABEL = { idle: 'rảnh', busy: 'đang bận', waiting: 'đang chờ hộp thoại', unknown: 'không rõ trạng thái' };

/** Which ops a state allows (buttons shown / presses accepted). Pure. */
export function allowedOps(state, bridgeSessionId) {
  // 'i' = read what is in the input box (a [🧹 clear] follows when it holds text) — idle / busy only.
  if (state === 'idle') return bridgeSessionId ? ['c', 'i'] : ['c', 'r', 'i'];
  // Busy: /compact is QUEUED by Claude and runs as the command when the turn ends (probed
  // 2.1.300). Waiting (a dialog is open): Enter would answer the dialog → Esc only.
  if (state === 'busy') return ['c', 'e', 'i'];
  if (state === 'waiting') return ['e'];
  return [];
}

/** Claude shows this while messages are queued for after the turn. Pure. */
export function hasQueuedInput(screenText) {
  return /Press up to edit queued messages/.test(String(screenText || '').replace(/\0/g, ''));
}

/**
 * listClaudeProcs rows → agents /type can reach: screen `tele-<its own hashtag>` (a session switched
 * in place no longer matches its screen → not listed), claude its DIRECT child, known session. Pure.
 */
export function typeTargets(rows) {
  return rows.filter((r) => typeof r.screen === 'string' && r.hashtag && r.screen === `tele-${r.hashtag}`
    && r.screenPid && r.ppid === r.screenPid && r.sessionId && !r.guessed && r.procStart);
}

// Below this context /compact gains little (Thi): no 🗜️ button (unknown usage keeps it), no /compact_x link.
export const COMPACT_MIN_TOKENS = 100_000;

/**
 * The tappable commands under one /ls block (RFC 26 §3.10) — the same gates the taps re-check:
 * /kill_x: a known (not guessed) session + start; /compact_x: typeable and context ≥ 100k (known — Thi 11229);
 * /nudge_x: typeable and (listener off or mail waiting). `reachable` = typeTargets(rows) includes it. Pure.
 */
export function lsLinks(r, { reachable = false, tokens = null, listener = null, mail = null, unique = true } = {}) {
  // `unique` = no other live claude row shares the hashtag (every tap refuses then).
  if (!r.hashtag || !unique || r.guessed || !r.sessionId || !r.procStart) return [];
  const out = [];
  if (reachable && tokens != null && tokens >= COMPACT_MIN_TOKENS) out.push(`/compact_${r.hashtag}`);
  out.push(`/kill_${r.hashtag}`);
  if (reachable && (listener === 'off' || mail > 0)) out.push(`/nudge_${r.hashtag}`);
  return out;
}

/** The pinned target stored in a button entry. Pure. */
export function pinTarget(r) {
  return { pid: r.pid, procStart: String(r.procStart), sessionId: r.sessionId, screenPid: r.screenPid, screen: r.screen, hashtag: r.hashtag, cwd: r.cwd, name: r.name ?? null };
}

export const screenId = (t) => `${t.screenPid}.${t.screen}`;


/**
 * `/compact`, `/nudge` target (RFC 26 §3.2): `query` = the whole rest (spaces allowed). A hashtag must be
 * unique across ALL live claude rows first (a terminal twin is never "replaced" by a reachable screen
 * one); then only `typeTargets` rows. Names: tier 1 literal (case-insensitive, leading emoji off), tier 2
 * normalized with `_` → space; the first tier with a hit decides, > 1 session → refuse. A 3-digit tail (RFC 28) is a
 * hashtag shorthand resolved over ALL live rows (not just typeable ones: a terminal twin makes it ambiguous).
 * `personaOf(row)` takes the row (its own convo's persona). → { row } | { error }. Pure.
 */
export function findTypeTarget(query, rows, personaOf = () => null) {
  let t = parseAgentTarget(unquoteTarget(query));
  if (t.kind === 'pid' || t.kind === 'convoId' || !String(t.value ?? '').trim()) return { error: 'cần <tên | #hashtag | 3 số cuối> (xem /ls).' };
  const label = (r) => `${personaOf(r) || r.name || '?'} #${r.hashtag} · PID ${r.pid}`;
  if (t.kind === 'tail') {
    const r = resolveTail(t.value, rows, label);
    if (r.error) return { error: r.error };
    if (r.none) return { error: `không thấy agent có đuôi "${t.value}" đang chạy (xem /ls).` };
    t = { kind: 'hashtag', value: r.hashtag };
  }
  const sessions = (hits) => hits.length; // processes, not sessions: two PIDs on one session are ambiguous too
  const reachable = typeTargets(rows);
  const pick = (hits) => {
    if (sessions(hits) > 1) return { error: `"${t.value}" khớp ${sessions(hits)} process: ${hits.map(label).join(', ')} — dùng #hashtag.` };
    const ok = hits.filter((r) => reachable.includes(r));
    if (!ok.length) return { error: `${label(hits[0])} không ở trong screen tele-* của nó — không gõ được (xem /ls).` };
    return { row: ok[0] };
  };
  if (t.kind === 'hashtag') {
    const hits = rows.filter((r) => r.hashtag === t.value);
    return hits.length ? pick(hits) : { error: `không thấy agent #${t.value} đang chạy (xem /ls).` };
  }
  // Names: over the agents we can type into (a terminal namesake must not shadow a screen one).
  const names = (r) => [r.name, personaOf(r)].filter(Boolean);
  const strip = (s) => String(s).trim().replace(/^[^\p{L}\p{N}]+\s*/u, '').toLowerCase();
  const lit = strip(t.value), norm = normalizeAgentName(String(t.value).replace(/_+/g, ' '));
  const byName = (pool) => {
    const a = pool.filter((r) => names(r).some((n) => strip(n) === lit));
    return a.length ? a : pool.filter((r) => names(r).some((n) => normalizeAgentName(n) === norm));
  };
  const hits = byName(reachable);
  // A name hit still answers to its hashtag: a live twin anywhere (e.g. a terminal copy) → refuse.
  if (hits.length) return pick(rows.filter((r) => hits.some((h) => h.hashtag && h.hashtag === r.hashtag) || hits.includes(r)));
  const elsewhere = byName(rows);
  return { error: elsewhere.length ? `${label(elsewhere[0])} không ở trong screen tele-* của nó — không gõ được (xem /ls).` : `không thấy agent "${t.value}" đang chạy (xem /ls).` };
}

/**
 * Which line to type: ask only for what is broken — listener off, mail waiting. Neither (or unknown) → both:
 * the owner asked anyway, so it is a force (Thi). `listener` 'on'|'off'|null, `mail` unread count|null. Pure.
 */
export function nudgeText({ listener, mail } = {}) {
  const off = listener === 'off', unread = mail > 0;
  return off === unread ? NUDGE_LINES.both : off ? NUDGE_LINES.listener : NUDGE_LINES.mail;
}

/** One agent line — carries `#hash` and `PID n` (a press is checked against them). Pure. */
/** `🐺 Sói #d7261652`, or `#d7261652` without a persona — how results name an agent (Thi 11247, 11264). Pure. */
export const agentLabel = (t, persona = null) => `${persona ? `${persona} ` : ''}#${t.hashtag}`;

export function agentLine(t, { persona = null, state = 'unknown', ctx = null, bridge = null } = {}) {
  return [agentLabel(t, persona), `PID ${t.pid}`, STATE_LABEL[state] || state, ctx, bridge ? '📡' : null].filter(Boolean).join(' · ');
}

/** A press is only honoured if the message the owner saw names the entry's target. Pure. */
export function messageNamesTarget(text, t) {
  const s = String(text || '');
  return new RegExp(`#${t.hashtag}\\b`).test(s) && new RegExp(`\\bPID ${t.pid}\\b`).test(s);
}

/**
 * The live input line of a hardcopy (read as latin1): the LAST line that starts with the prompt
 * glyph's surviving byte followed by U+00A0 — history lines use a plain space, suggestion rows
 * are indented. → its text (trimmed) or null. Pure.
 */
export function parseInputLine(screenText) {
  const lines = String(screenText || '').split('\n');
  let idx = -1;
  for (const [i, raw] of lines.entries()) if (/^[^\s]\u00a0/.test(raw.replace(/\0/g, ''))) idx = i;
  if (idx < 0) return null;
  const text = lines[idx].replace(/\0/g, '').slice(2).replace(/[\s\u00a0]+$/, '');
  // The box's bottom border ('─' → NUL bytes in hardcopy) must follow: anything else is a
  // multi-line draft below the prompt line → reported as extra text (never equals the command).
  const next = lines[idx + 1] ?? '';
  return /^\0+\s*$/.test(next) ? text : `${text} ⏎ ${next.replace(/\0/g, '').trim()}…`;
}

/** The empty box's dim placeholder (`Try "fix lint errors"`) reads like text in a hardcopy: it is not a draft. Pure. */
export const isPlaceholder = (line) => /^Try "[^"]*"$/.test(String(line ?? ''));

/** The suggestion box selects `cmd` (marker + cmd + description). Pure. */
export function suggestionSelects(screenText, cmd) {
  const esc = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s+\\S ${esc}\\s{2,}\\S`, 'm').test(String(screenText || '').replace(/\0/g, ''));
}

/**
 * "Not enough messages to compact" printed for the LAST submitted `/compact` (a history line
 * "<glyph> /compact" with a plain space), i.e. below it — not an older one still on screen. Pure.
 */
export function compactRefusedOnScreen(screenText) {
  const lines = String(screenText || '').split('\n').map((l) => l.replace(/\0/g, ''));
  let last = -1;
  for (const [i, l] of lines.entries()) if (/^\S \/compact\s*$/.test(l)) last = i;
  return last >= 0 && lines.slice(last + 1).some((l) => /Not enough messages to compact/.test(l));
}

/** Remote Control's enable dialog is up with option 1 ("Enable") selected. Pure. */
export function rcDialogReady(screenText) {
  return /^\s*\S\s+1\.\s+Enable Remote Control/m.test(String(screenText || '').replace(/\0/g, ''));
}

/** Does a live session match the pinned target? → null (ok) | reason. Pure. */
export function targetMismatch(t, { proc, sess, ppid, windows }) {
  if (!proc || proc.comm !== 'claude') return 'tiến trình claude không còn';
  if (String(proc.start) !== String(t.procStart)) return 'PID đã thuộc tiến trình khác';
  if (!sess || sess.sessionId !== t.sessionId) return 'phiên đã đổi';
  if (ppid !== t.screenPid) return 'claude không còn là con của screen';
  if (windows !== 1) return `screen có ${windows ?? '?'} cửa sổ`;
  return null;
}

// ── I/O layer (injectable) ────────────────────────────────────────────────────

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export function defaultIo({ exec = execFileSync, sessionsDir = SESSIONS_DIR } = {}) {
  return {
    now: () => Date.now(),
    sleep: sleepReal,
    proc: (pid) => inspectPid(pid),
    session: (pid) => { try { return parseSessionFile(fs.readFileSync(path.join(sessionsDir, `${pid}.json`), 'utf8')); } catch { return null; } },
    ppid: (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]); } catch { return null; } },
    windows: (sid) => { try { const out = String(exec('screen', ['-S', sid, '-Q', 'windows'], { encoding: 'utf8', timeout: 5000 })); return (out.match(/(?:^|\s{2})\d+\S*(?:\s|$)/g) || []).length; } catch { return null; } },
    stuff: (sid, data) => exec('screen', ['-S', sid, '-p', '0', '-X', 'stuff', data], { timeout: 5000 }),
    hardcopy: async (sid) => {
      const f = path.join(os.tmpdir(), `teleport-type-${process.pid}-${crypto.randomBytes(4).toString('hex')}.txt`);
      try {
        exec('screen', ['-S', sid, '-p', '0', '-X', 'hardcopy', f], { timeout: 5000 });
        for (let i = 0; i < 20; i++) { // the screen server writes it asynchronously
          try { if (fs.statSync(f).size > 0) { await sleepReal(50); return fs.readFileSync(f).toString('latin1'); } } catch {}
          await sleepReal(100);
        }
        return null;
      } catch { return null; } finally { try { fs.unlinkSync(f); } catch {} }
    },
    transcript: (sessionId, cwd) => transcriptState(sessionId, cwd),
    transcriptFile: (sessionId, cwd) => findTranscript(sessionId, cwd),
    transcriptSize: (file) => { try { const st = fs.statSync(file); return { size: st.size, ino: st.ino, dev: st.dev }; } catch { return null; } },
    compactAfter,
    // Listener on/off + unread mailbox mail for the PINNED session's convo (RFC 26 §3.5). Never throws.
    nudgeSignals: (t) => {
      const convo = uuidToConvoInt(t.sessionId);
      if (convo == null) return { listener: null, mail: null };
      let listener = null, mail = null;
      try { listener = createListenerStatus().listener(convo); } catch {}
      try { mail = countUnread(String(convo)); } catch {}
      return { listener, mail };
    },
    saveShot: (name, text) => saveShotFile(path.join(path.dirname(AUDIT_FILE), 'type-shots'), name, text),
    audit: (entry) => { try { fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true }); fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 }); } catch {} },
  };
}

/** Live view of a pinned target → { mismatch, state, bridge, sess, usage }. */
export function observe(t, io) {
  const sess = io.session(t.pid);
  const mismatch = targetMismatch(t, { proc: io.proc(t.pid), sess, ppid: io.ppid(t.pid), windows: io.windows(screenId(t)) });
  if (mismatch) return { mismatch };
  const tr = io.transcript(t.sessionId, t.cwd);
  return { mismatch: null, state: classify(sess.status, tr.ended), status: sess.status, bridge: sess.bridgeSessionId, usage: tr.usage };
}

/** Agents for the /type menu (fresh), with their display lines. */
export function listForType({ list = () => listClaudeProcs(), personaOf = () => null, cfg = {}, io = defaultIo() } = {}) {
  return typeTargets(list()).map((r) => {
    const t = pinTarget(r);
    const o = observe(t, io);
    const ctx = o.mismatch ? null : formatContext(o.usage, contextWindowFor(cfg, { hashtag: t.hashtag, model: o.usage?.model }));
    return { target: t, obs: o, ctx, line: agentLine(t, { persona: personaOf(r), state: o.mismatch ? 'unknown' : o.state, ctx, bridge: o.bridge }) };
  });
}

/**
 * Per-daemon runner: one agent at a time per target, cool-down after Enter, Esc rate limit,
 * Esc cancels a /remote-control chain in progress. All keystrokes go through `io`.
 */
export class TypeRunner {
  constructor(io = defaultIo()) {
    this.io = io;
    this.locks = new Set();
    this.cooldown = new Map(); // pid → until
    this.lastEsc = new Map();  // pid → time of the last Esc actually SENT
    this.escInFlight = new Set();
    this.keysDone = new Set(); // pid whose running chain has sent its last key
    this.cancel = new Map();   // pid → true while a chain should stop
  }

  /** Run `op` ('c'|'r'|'e') against pinned target `t`. → { text, watch? } — `watch()` resolves a later result line. */
  async run(op, t, who = 'owner', { persona = null, line = null } = {}) {
    const audit = (step, extra = {}) => this.io.audit({ who, op: TYPE_OPS[op], pid: t.pid, sessionId: t.sessionId, hashtag: t.hashtag, step, ...extra });
    if (op === 'e') return this.esc(t, audit);
    if (this.locks.has(t.pid)) return { text: '⏳ đang gõ lệnh khác vào agent này — thử lại sau.' };
    if (op === 'i') { // the probe types too: same lock, no cool-down
      this.locks.add(t.pid);
      try { return await this.readInput(t, audit); } finally { this.locks.delete(t.pid); }
    }
    if ((this.cooldown.get(t.pid) || 0) > this.io.now()) return { text: '⏳ vừa gõ lệnh vào agent này — đợi vài giây rồi thử lại.' };
    this.locks.add(t.pid);
    this.cancel.delete(t.pid);
    this.keysDone.delete(t.pid);
    try {
      if (op === 'c') return await this.compact(t, audit, persona);
      if (op === 'u') return await this.clearInput(t, audit);
      if (op === 'r') return await this.remoteControl(t, audit);
      if (op === 'n') return await this.nudge(t, audit, persona, line);
      audit('refused', { reason: `unknown op ${op}` });
      return { text: `❌ lệnh không hợp lệ (${op}).` };
    }
    finally { this.locks.delete(t.pid); this.keysDone.delete(t.pid); }
  }

  /** Common part: check → type the command → verify on screen → re-check → Enter. → { ok } | { text }. */
  async typeAndEnter(t, cmd, audit, { needNoBridge = false, allowBusy = false, slash = true } = {}) {
    // slash=false (the fixed nudge line only): no slash-command suggestion row to check — the input line alone must match.
    const selects = (scr) => !slash || suggestionSelects(scr, cmd);
    const io = this.io, sid = screenId(t);
    const ok = (st) => st === 'idle' || (allowBusy && st === 'busy');
    const pre = observe(t, io);
    if (pre.mismatch) { audit('refused', { reason: pre.mismatch }); return { text: `❌ agent đã đổi phiên (${pre.mismatch}) — gõ /type lại.` }; }
    if (!ok(pre.state)) { audit('refused', { reason: pre.state }); return { text: `❌ agent ${STATE_LABEL[pre.state]} — không gõ ${cmd}.${pre.state === 'busy' ? ' Bấm Esc trước nếu cần dừng.' : ''}` }; }
    if (needNoBridge && pre.bridge) return { text: `📡 Remote Control đang bật: https://claude.ai/code/${pre.bridge}` };
    const shot = await io.hardcopy(sid); // one look before typing: queued input, and what is in the box
    if (pre.state === 'busy' && hasQueuedInput(shot)) { // don't stack onto a queue we can't see
      audit('refused', { reason: 'queued' });
      return { text: `❌ agent đang bận và đã có tin xếp hàng — không gõ thêm ${cmd}.` };
    }
    // Never type over something already in the box (a draft, or our own earlier /type whose Enter was withheld).
    const before = parseInputLine(shot);
    if (before == null) { audit('refused', { reason: 'input-unreadable' }); return { text: `❔ không đọc được ô nhập (hộp thoại mở?) — không gõ ${cmd}.` }; }
    if (before && !isPlaceholder(before)) { // a draft — or Claude's dim suggestion, which reads the same
      const p = await this.probeEmpty(t, before, audit, { allowBusy });
      if (p.text) return { text: `${p.text} — không gõ ${cmd}.` };
      if (!p.empty) {
        audit('refused', { reason: 'input-not-empty', line: before });
        return { text: `❌ ô nhập đang có chữ ("${before}") — không gõ ${cmd}. Bấm 🔍 → 🧹 rồi /type lại.` };
      }
    }
    const now0 = observe(t, io); // re-checked right before the key (the screen read took a moment)
    if (now0.mismatch || !ok(now0.state)) { audit('refused', { reason: now0.mismatch || now0.state }); return { text: `❌ agent vừa đổi trạng thái (${now0.mismatch || STATE_LABEL[now0.state]}) — không gõ ${cmd}.` }; }
    io.stuff(sid, cmd);
    audit('typed', { status: pre.status });
    // The text can take a moment to show: re-read until it does (≤ TYPE_SETTLE_MS) before calling it a mismatch.
    let scr = null, line = null, lastShot = null; // lastShot: the last READABLE screen, for the diagnostic only
    for (let waited = 0; ; waited += TYPE_GAP_MS) {
      await io.sleep(TYPE_GAP_MS);
      scr = await io.hardcopy(sid);
      if (scr != null) lastShot = scr;
      line = parseInputLine(scr);
      if ((line === cmd && selects(scr)) || waited + TYPE_GAP_MS >= TYPE_SETTLE_MS) break;
    }
    if (line !== cmd || !selects(scr)) {
      let shot = null; // the last raw hardcopy, for diagnosing late renders (best-effort)
      if (lastShot != null) { try { shot = io.saveShot?.(`${new Date().toISOString().replaceAll(':', '-')}-${t.hashtag}.txt`, lastShot) ?? null; } catch {} }
      audit('input-mismatch', { line, ...(shot ? { shot } : {}) });
      return { text: `⚠️ ô nhập có chữ khác (đọc được: "${line ?? '?'}") sau ${Math.round(TYPE_SETTLE_MS / 1000)}s — đã gõ ${cmd} nhưng KHÔNG Enter, không gửi thêm phím nào. Chữ có thể hiện muộn (nhất là khi đang attach): nếu ô nhập đã có đúng lệnh thì Enter tay, không thì 🧹 xoá rồi thử lại.` };
    }
    const mid = observe(t, io);
    if (this.cancel.get(t.pid)) { audit('cancelled'); return { text: `✖ đã huỷ (⎋ Esc) — đã gõ ${cmd} nhưng KHÔNG Enter.` }; }
    if (mid.mismatch || !ok(mid.state)) {
      audit('changed-before-enter', { reason: mid.mismatch || mid.state });
      return { text: `⚠️ agent vừa đổi trạng thái (${mid.mismatch || STATE_LABEL[mid.state]}) — đã gõ ${cmd} nhưng KHÔNG Enter. Kiểm tra tay.` };
    }
    const file = io.transcriptFile(t.sessionId, t.cwd);
    const offset = file ? io.transcriptSize(file) : null; // { size, ino, dev } — replacement-proof baseline
    // A busy agent can open a dialog (permission / question) at any moment, and Enter would answer
    // it: read the screen AGAIN, then status, then Enter with no await in between.
    const scr2 = await io.hardcopy(sid);
    if (parseInputLine(scr2) !== cmd || !selects(scr2)) {
      audit('changed-before-enter', { reason: 'screen' });
      return { text: `⚠️ màn hình vừa đổi (có thể một hộp thoại mở ra) — đã gõ ${cmd} nhưng KHÔNG Enter. Kiểm tra tay.` };
    }
    const last = observe(t, io);
    if (this.cancel.get(t.pid) || last.mismatch || !ok(last.state)) {
      audit('changed-before-enter', { reason: last.mismatch || last.state });
      return { text: `⚠️ agent vừa đổi trạng thái (${last.mismatch || STATE_LABEL[last.state]}) — đã gõ ${cmd} nhưng KHÔNG Enter. Kiểm tra tay.` };
    }
    io.stuff(sid, '\r');
    this.cooldown.set(t.pid, io.now() + COOLDOWN_MS);
    audit('enter', { queued: last.state === 'busy' });
    return { ok: true, file, offset, screenBefore: scr, queued: last.state === 'busy' };
  }

  async compact(t, audit, persona = null) {
    const r = await this.typeAndEnter(t, '/compact', audit, { allowBusy: true });
    if (!r.ok) return r;
    const io = this.io;
    const watch = async () => {
      const until = io.now() + (r.queued ? COMPACT_QUEUED_WATCH_MS : COMPACT_WATCH_MS);
      await io.sleep(3000);
      const scr = await io.hardcopy(screenId(t));
      if (compactRefusedOnScreen(scr)) { // tied to the LAST submitted /compact — an old one may still be on screen
        audit('result', { result: 'not-enough' });
        return 'ℹ️ Claude báo: chưa đủ tin nhắn để compact.';
      }
      if (!r.file || r.offset == null) return '❔ không tìm thấy transcript để theo dõi kết quả.';
      while (io.now() < until) {
        const c = io.compactAfter(r.file, r.offset);
        if (c?.error) { audit('result', { result: c.error }); return `❔ không theo dõi được (${c.error}).`; }
        if (c) {
          audit('result', { result: 'compacted', ...c });
          return `${COMPACT_OK}: ${fmtTokens(c.preTokens)} → ${fmtTokens(c.postTokens)}`;
        }
        await io.sleep(5000);
      }
      audit('result', { result: 'timeout' });
      return `❔ chưa thấy compact xong sau ${r.queued ? 30 : 5} phút — kiểm tra tay.`;
    };
    return { text: `⌨️ đã gõ /compact vào ${agentLabel(t, persona)}${r.queued ? ' (đang bận → đã xếp hàng, chạy khi xong lượt)' : ''} — đang chờ kết quả…`, watch };
  }

  async nudge(t, audit, persona = null, want = null) {
    // Signals read HERE (not when a button was drawn): the line matches the agent as it is now.
    // `want` (auto-nudge) must be one of the fixed lines — never typed from anywhere else.
    const line = Object.values(NUDGE_LINES).includes(want) ? want : nudgeText(this.io.nudgeSignals ? this.io.nudgeSignals(t) : {});
    const r = await this.typeAndEnter(t, line, audit, { allowBusy: true, slash: false });
    if (!r.ok) return r;
    return { text: `👋 đã nudge ${agentLabel(t, persona)}${r.queued ? ' (đang bận → đã xếp hàng, chạy khi xong lượt)' : ''}.` };
  }

  async remoteControl(t, audit) {
    const io = this.io, sid = screenId(t);
    const r = await this.typeAndEnter(t, '/remote-control', audit, { needNoBridge: true });
    if (!r.ok) return r;
    // Enter #1 opens the dialog (status → waiting, option 1 = Enable) — only then Enter #2.
    let ready = false;
    for (const end = io.now() + RC_DIALOG_WAIT_MS; io.now() < end;) {
      await io.sleep(500);
      if (this.cancel.get(t.pid)) { audit('cancelled'); return { text: '✖ đã huỷ (⎋ Esc) — không gửi thêm phím.' }; }
      const s = io.session(t.pid);
      if (s?.bridgeSessionId) { audit('result', { result: 'bridged' }); return { text: `📡 Remote Control đã bật: https://claude.ai/code/${s.bridgeSessionId}` }; }
      if (s?.status === 'waiting' && rcDialogReady(await io.hardcopy(sid))) { ready = true; break; }
    }
    if (!ready) { audit('result', { result: 'no-dialog' }); return { text: '⚠️ đã gõ /remote-control + Enter nhưng không thấy hộp thoại "Enable Remote Control" — không gửi thêm phím. Kiểm tra tay.' }; }
    const o = observe(t, io);
    if (this.cancel.get(t.pid) || o.mismatch || o.state !== 'waiting') {
      audit('cancelled', { reason: o.mismatch || o.state });
      return { text: '✖ dừng trước Enter thứ hai (đã huỷ hoặc trạng thái đổi) — kiểm tra tay.' };
    }
    io.stuff(sid, '\r');
    this.keysDone.add(t.pid);
    audit('enter2');
    for (const end = io.now() + RC_BRIDGE_WAIT_MS; io.now() < end;) {
      await io.sleep(1000);
      const s = io.session(t.pid);
      if (s?.bridgeSessionId) { audit('result', { result: 'bridged' }); return { text: `📡 Remote Control đã bật: https://claude.ai/code/${s.bridgeSessionId}` }; }
    }
    audit('result', { result: 'no-bridge' });
    return { text: '❔ đã bật nhưng chưa thấy phiên Remote Control trong 15 giây — kiểm tra tay.' };
  }

  /**
   * Is the box really empty? A hardcopy has no colours, so Claude's dim suggestion (any text — e.g.
   * a past `! git …` command) reads exactly like a draft. Type PROBE_CHAR and look: an empty box then
   * shows just that char. It is taken back (⌫) only once seen to land, and only if the agent is
   * still at the box. → { empty, line } | { text } (refused / unreadable / left in the box).
   */
  async probeEmpty(t, before, audit, { allowBusy = true } = {}) {
    const io = this.io, sid = screenId(t);
    const atBox = () => { const o = observe(t, io); return o.mismatch || !(o.state === 'idle' || (allowBusy && o.state === 'busy')) ? o : null; };
    const bad = atBox(); // re-checked right before the key
    if (bad) { audit('refused', { reason: bad.mismatch || bad.state }); return { text: `❌ agent vừa đổi trạng thái (${bad.mismatch || STATE_LABEL[bad.state]})` }; }
    if (/ ⏎ /.test(before)) return { empty: false, line: before }; // several lines: never a suggestion
    io.stuff(sid, PROBE_CHAR);
    let line = before;
    for (let waited = 0; waited < TYPE_SETTLE_MS && line === before; waited += TYPE_GAP_MS) {
      await io.sleep(TYPE_GAP_MS);
      line = parseInputLine(await io.hardcopy(sid));
    }
    audit('probe', { before, line });
    const left = `đã gõ thử "${PROBE_CHAR}" vào ô nhập và chưa xoá lại — kiểm tay`;
    if (line == null) return { text: `❔ không đọc lại được ô nhập (hộp thoại mở?) — ${left}` };
    if (line === before) return { text: `❔ không thấy chữ gõ thử hiện lên — ${left}` }; // never ⌫ a char we did not see land
    const now = atBox();
    if (now) { audit('refused', { reason: now.mismatch || now.state }); return { text: `❌ agent vừa đổi trạng thái (${now.mismatch || STATE_LABEL[now.state]}) — ${left}` }; }
    io.stuff(sid, '\x7f');
    await io.sleep(TYPE_GAP_MS); // let the ⌫ land before anyone reads or types again
    return { empty: line === PROBE_CHAR, line };
  }

  /** What is in the agent's input box. → { text, line, canClear }. Sends at most PROBE_CHAR + ⌫ (only when the box may be a dim suggestion). */
  async readInput(t, audit) {
    const o = observe(t, this.io);
    if (o.mismatch) return { text: `❌ agent đã đổi phiên (${o.mismatch}) — gõ /type lại.` };
    if (o.state !== 'idle' && o.state !== 'busy') return { text: `ℹ️ agent ${STATE_LABEL[o.state]} — không đọc ô nhập.` };
    const line = parseInputLine(await this.io.hardcopy(screenId(t)));
    audit('read-input', { line });
    if (line == null) return { text: '❔ không đọc được ô nhập trên màn hình.' };
    if (!line || isPlaceholder(line)) return { text: '🔍 ô nhập đang trống.', line: '' };
    const p = await this.probeEmpty(t, line, audit);
    if (p.text) return { text: `${p.text} — đọc được: "${line}".` };
    if (p.empty) return { text: `🔍 ô nhập đang trống (dòng mờ "${line}" chỉ là gợi ý của Claude).`, line: '' };
    return { text: `🔍 ô nhập đang có: "${line}"`, line, canClear: true };
  }

  /**
   * Clear the input box, whatever is in it and however many lines: CLEAR_ROUND repeated (never
   * Enter / Esc), then verified — '' / the placeholder, or else the PROBE_CHAR probe (a dim
   * suggestion comes back once the box is empty).
   */
  async clearInput(t, audit) {
    const io = this.io, sid = screenId(t);
    const o = observe(t, io);
    if (o.mismatch) { audit('refused', { reason: o.mismatch }); return { text: `❌ agent đã đổi phiên (${o.mismatch}) — gõ /type lại.` }; }
    if (o.state !== 'idle' && o.state !== 'busy') { audit('refused', { reason: o.state }); return { text: `❌ agent ${STATE_LABEL[o.state]} — không xoá ô nhập.` }; }
    const empty = (l) => l === '' || isPlaceholder(l); // (null = unreadable: never counted as cleared)
    const before = parseInputLine(await io.hardcopy(sid));
    if (before == null) return { text: '❔ không đọc được ô nhập — không gửi phím nào.' };
    if (empty(before)) return { text: '🔍 ô nhập đã trống — không gửi phím nào.' };
    const first = await this.probeEmpty(t, before, audit);
    if (first.text) return { text: `${first.text} — không xoá.` };
    if (first.empty) return { text: `🔍 ô nhập đã trống (dòng mờ "${before}" chỉ là gợi ý của Claude) — không xoá gì.` };
    let line = before;
    const cancelled = () => { if (!this.cancel.get(t.pid)) return null; audit('cancelled'); return { text: '✖ đã huỷ (⎋ Esc) — dừng xoá, ô nhập có thể còn một phần.' }; };
    for (let send = 1; send <= CLEAR_MAX_SENDS; send++) {
      const c = cancelled(); if (c) return c;
      const now = observe(t, io); // re-checked before every batch of keys
      if (now.mismatch || (now.state !== 'idle' && now.state !== 'busy')) { audit('refused', { reason: now.mismatch || now.state }); return { text: `❌ agent vừa đổi trạng thái (${now.mismatch || STATE_LABEL[now.state]}) — dừng xoá.` }; }
      io.stuff(sid, CLEAR_ROUND.repeat(CLEAR_ROUNDS_PER_SEND));
      audit('clear-input', { send, line });
      const prev = line;
      for (let waited = 0; waited < TYPE_SETTLE_MS; waited += TYPE_GAP_MS) {
        await io.sleep(TYPE_GAP_MS);
        line = parseInputLine(await io.hardcopy(sid));
        if (line !== prev) break;
      }
      if (empty(line)) { audit('result', { result: 'cleared', send }); return { text: '🧹 đã xoá ô nhập (giờ trống).' }; }
      if (line == null) { audit('result', { result: 'unreadable' }); return { text: '❔ đã gửi phím xoá nhưng không đọc lại được ô nhập — kiểm tay.' }; }
      const c2 = cancelled(); if (c2) return c2;
      const p = await this.probeEmpty(t, line, audit);
      if (p.text) return { text: `${p.text} — dừng xoá.` };
      if (p.empty) { audit('result', { result: 'cleared', send }); return { text: '🧹 đã xoá ô nhập (giờ trống).' }; }
    }
    audit('result', { result: 'not-cleared', line });
    return { text: `⚠️ đã gửi ${CLEAR_MAX_SENDS * CLEAR_ROUNDS_PER_SEND} vòng phím xoá mà ô nhập vẫn còn: "${line}" — vào screen xoá tay.` };
  }

  async esc(t, audit) {
    const io = this.io;
    // One Esc in flight per agent (across every wait below), and the 3 s gap is measured
    // against ACTUAL sends — two quick Escs at idle open the Rewind menu.
    if (this.escInFlight.has(t.pid)) return { text: '⏳ đang gửi Esc — đợi chút.' };
    const last = this.lastEsc.get(t.pid);
    if (last != null && io.now() - last < ESC_GAP_MS) return { text: '⏳ vừa gửi Esc — đợi 3 giây (Esc kép mở menu Rewind).' };
    this.escInFlight.add(t.pid);
    try {
      // A /remote-control chain in progress stops at its next step — and the owner is told so,
      // even when there is nothing for the Esc key itself to stop.
      const chain = this.locks.has(t.pid) && !this.keysDone.has(t.pid); // a chain that can still send keys
      this.cancel.set(t.pid, true);
      // Right after an Enter the session file still says idle: wait (≤ cool-down) until it shows busy/waiting.
      while ((this.cooldown.get(t.pid) || 0) > io.now()) {
        const w = observe(t, io);
        if (w.mismatch || w.state === 'busy' || w.state === 'waiting') break;
        await io.sleep(250);
      }
      await io.sleep(300); // quiet before, so it isn't read as part of an escape sequence
      const o = observe(t, io); // validated IMMEDIATELY before the key
      if (o.mismatch) { audit('refused', { reason: o.mismatch }); return { text: `❌ agent đã đổi phiên (${o.mismatch}) — gõ /type lại.` }; }
      if (o.state !== 'busy' && o.state !== 'waiting') {
        audit('refused', { reason: o.state, chain });
        return { text: chain ? '✖ đã huỷ lệnh đang gõ dở (không gửi phím Esc — agent không bận).' : `ℹ️ agent ${STATE_LABEL[o.state]} — không có gì để dừng.` };
      }
      const prev = this.lastEsc.get(t.pid);
      if (prev != null && io.now() - prev < ESC_GAP_MS) return { text: '⏳ vừa gửi Esc — đợi 3 giây (Esc kép mở menu Rewind).' };
      io.stuff(screenId(t), '\x1b');
      this.lastEsc.set(t.pid, io.now());
      audit('esc', { status: o.status });
      await io.sleep(ESC_GAP_MS);
      const after = observe(t, io);
      const text = after.mismatch ? `⌨️ đã gửi Esc; giờ ${after.mismatch}.`
        : after.state === 'idle' ? '⌨️ đã gửi Esc — đã ngắt, giờ rảnh.'
          : `⌨️ đã gửi Esc — giờ ${STATE_LABEL[after.state]}.`;
      audit('result', { result: after.mismatch || after.state });
      return { text };
    } finally { this.escInFlight.delete(t.pid); }
  }
}
