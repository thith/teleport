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
import { transcriptState, findTranscript, compactAfter, formatContext, contextWindowFor } from './transcript-state.mjs';

export const TYPE_BUTTON_TTL_MS = 10 * 60 * 1000;
export const TYPE_GAP_MS = 500;          // text → Enter (paste detection / suggestion box)
export const COOLDOWN_MS = 5000;         // after Enter the session file still says idle for a moment
export const ESC_GAP_MS = 3000;          // two quick Escs at idle open the Rewind menu
export const RC_DIALOG_WAIT_MS = 5000;
export const RC_BRIDGE_WAIT_MS = 15000;
export const COMPACT_WATCH_MS = 5 * 60 * 1000;
export const AUDIT_FILE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'teleport', 'type-audit.jsonl');

// op letter (callback data) → command. Fixed table: the command never comes from stored data.
export const TYPE_OPS = { c: '/compact', r: '/remote-control', e: 'esc' };
export const TYPE_BUTTON_RE = /^ty:(?:pick:([0-9a-z]{8})|([0-9a-f]{16}):([crex]))$/;

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
  if (state === 'idle') return bridgeSessionId ? ['c'] : ['c', 'r'];
  if (state === 'busy' || state === 'waiting') return ['e'];
  return [];
}

/** listClaudeProcs rows → agents /type can reach: a tele-* screen whose DIRECT child is claude, known session. Pure. */
export function typeTargets(rows) {
  return rows.filter((r) => typeof r.screen === 'string' && r.screen.startsWith('tele-')
    && r.screenPid && r.ppid === r.screenPid && r.sessionId && !r.guessed && r.procStart);
}

/** The pinned target stored in a button entry. Pure. */
export function pinTarget(r) {
  return { pid: r.pid, procStart: String(r.procStart), sessionId: r.sessionId, screenPid: r.screenPid, screen: r.screen, hashtag: r.hashtag, cwd: r.cwd };
}

export const screenId = (t) => `${t.screenPid}.${t.screen}`;

/** One agent line — carries `#hash` and `PID n` (a press is checked against them). Pure. */
export function agentLine(t, { persona = null, state = 'unknown', ctx = null, bridge = null } = {}) {
  return [`${persona ? `${persona} ` : ''}#${t.hashtag}`, `PID ${t.pid}`, STATE_LABEL[state] || state, ctx, bridge ? '📡' : null].filter(Boolean).join(' · ');
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
  let found = null;
  for (const raw of String(screenText || '').split('\n')) {
    const l = raw.replace(/\0/g, '');
    if (/^[^\s] /.test(l)) found = l.slice(2).replace(/[\s ]+$/, '');
  }
  return found;
}

/** The suggestion box selects `cmd` (marker + cmd + description). Pure. */
export function suggestionSelects(screenText, cmd) {
  const esc = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s+\\S ${esc}\\s{2,}\\S`, 'm').test(String(screenText || '').replace(/\0/g, ''));
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
    windows: (sid) => { try { const out = String(exec('screen', ['-S', sid, '-Q', 'windows'], { encoding: 'utf8', timeout: 5000 })); return (out.match(/(?:^|\s{2})\d+\S*\s/g) || []).length; } catch { return null; } },
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
    transcriptSize: (file) => { try { return fs.statSync(file).size; } catch { return null; } },
    compactAfter,
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
    return { target: t, obs: o, line: agentLine(t, { persona: personaOf(t.hashtag), state: o.mismatch ? 'unknown' : o.state, ctx, bridge: o.bridge }) };
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
    this.lastEsc = new Map();  // pid → at
    this.cancel = new Map();   // pid → true while a chain should stop
  }

  /** Run `op` ('c'|'r'|'e') against pinned target `t`. → { text, watch? } — `watch()` resolves a later result line. */
  async run(op, t, who = 'owner') {
    const audit = (step, extra = {}) => this.io.audit({ who, op: TYPE_OPS[op], pid: t.pid, sessionId: t.sessionId, hashtag: t.hashtag, step, ...extra });
    if (op === 'e') return this.esc(t, audit);
    if (this.locks.has(t.pid)) return { text: '⏳ đang gõ lệnh khác vào agent này — thử lại sau.' };
    if ((this.cooldown.get(t.pid) || 0) > this.io.now()) return { text: '⏳ vừa gõ lệnh vào agent này — đợi vài giây rồi thử lại.' };
    this.locks.add(t.pid);
    this.cancel.delete(t.pid);
    try { return op === 'c' ? await this.compact(t, audit) : await this.remoteControl(t, audit); }
    finally { this.locks.delete(t.pid); }
  }

  /** Common part: check → type the command → verify on screen → re-check → Enter. → { ok } | { text }. */
  async typeAndEnter(t, cmd, audit, { needNoBridge = false } = {}) {
    const io = this.io, sid = screenId(t);
    const pre = observe(t, io);
    if (pre.mismatch) { audit('refused', { reason: pre.mismatch }); return { text: `❌ agent đã đổi phiên (${pre.mismatch}) — gõ /type lại.` }; }
    if (pre.state !== 'idle') { audit('refused', { reason: pre.state }); return { text: `❌ agent ${STATE_LABEL[pre.state]} — không gõ ${cmd}.${pre.state === 'busy' ? ' Bấm ⎋ Esc trước nếu cần dừng.' : ''}` }; }
    if (needNoBridge && pre.bridge) return { text: `📡 Remote Control đang bật: https://claude.ai/code/${pre.bridge}` };
    io.stuff(sid, cmd);
    audit('typed', { status: pre.status });
    await io.sleep(TYPE_GAP_MS);
    const scr = await io.hardcopy(sid);
    const line = parseInputLine(scr);
    if (line !== cmd || !suggestionSelects(scr, cmd)) {
      audit('input-mismatch', { line });
      return { text: `⚠️ ô nhập có chữ khác (đọc được: "${line ?? '?'}") — đã gõ ${cmd} nhưng KHÔNG Enter, không gửi thêm phím nào. Vào xoá tay.` };
    }
    const mid = observe(t, io);
    if (mid.mismatch || mid.state !== 'idle') {
      audit('changed-before-enter', { reason: mid.mismatch || mid.state });
      return { text: `⚠️ agent vừa đổi trạng thái (${mid.mismatch || STATE_LABEL[mid.state]}) — đã gõ ${cmd} nhưng KHÔNG Enter. Kiểm tra tay.` };
    }
    const file = io.transcriptFile(t.sessionId, t.cwd);
    const offset = file ? io.transcriptSize(file) : null;
    io.stuff(sid, '\r');
    this.cooldown.set(t.pid, io.now() + COOLDOWN_MS);
    audit('enter');
    return { ok: true, file, offset };
  }

  async compact(t, audit) {
    const r = await this.typeAndEnter(t, '/compact', audit);
    if (!r.ok) return r;
    const io = this.io;
    const watch = async () => {
      const until = io.now() + COMPACT_WATCH_MS;
      await io.sleep(3000);
      const scr = await io.hardcopy(screenId(t));
      if (/Not enough messages to compact/.test(scr || '')) { audit('result', { result: 'not-enough' }); return 'ℹ️ Claude báo: chưa đủ tin nhắn để compact.'; }
      if (!r.file || r.offset == null) return '❔ không tìm thấy transcript để theo dõi kết quả.';
      while (io.now() < until) {
        const c = io.compactAfter(r.file, r.offset);
        if (c?.error) { audit('result', { result: c.error }); return `❔ không theo dõi được (${c.error}).`; }
        if (c) {
          audit('result', { result: 'compacted', ...c });
          const fmt = (n) => (n == null ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
          return `✅ đã compact: ${fmt(c.preTokens)} → ${fmt(c.postTokens)}`;
        }
        await io.sleep(5000);
      }
      audit('result', { result: 'timeout' });
      return '❔ chưa thấy compact xong sau 5 phút — kiểm tra tay.';
    };
    return { text: `⌨️ đã gõ /compact vào #${t.hashtag} — đang chờ kết quả…`, watch };
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
    audit('enter2');
    for (const end = io.now() + RC_BRIDGE_WAIT_MS; io.now() < end;) {
      await io.sleep(1000);
      const s = io.session(t.pid);
      if (s?.bridgeSessionId) { audit('result', { result: 'bridged' }); return { text: `📡 Remote Control đã bật: https://claude.ai/code/${s.bridgeSessionId}` }; }
    }
    audit('result', { result: 'no-bridge' });
    return { text: '❔ đã bật nhưng chưa thấy phiên Remote Control trong 15 giây — kiểm tra tay.' };
  }

  async esc(t, audit) {
    const io = this.io;
    const last = this.lastEsc.get(t.pid);
    if (last != null && io.now() - last < ESC_GAP_MS) return { text: '⏳ vừa gửi Esc — đợi 3 giây (Esc kép mở menu Rewind).' };
    this.lastEsc.set(t.pid, io.now()); // claim now: a second press during the waits below is refused
    const unclaim = () => { if (last == null) this.lastEsc.delete(t.pid); else this.lastEsc.set(t.pid, last); };
    this.cancel.set(t.pid, true); // a /remote-control chain in progress stops at its next step
    const cool = (this.cooldown.get(t.pid) || 0) - io.now();
    if (cool > 0) await io.sleep(cool); // right after Enter the session file still says idle
    const o = observe(t, io);
    if (o.mismatch) { unclaim(); audit('refused', { reason: o.mismatch }); return { text: `❌ agent đã đổi phiên (${o.mismatch}) — gõ /type lại.` }; }
    if (o.state !== 'busy' && o.state !== 'waiting') { unclaim(); audit('refused', { reason: o.state }); return { text: `ℹ️ agent ${STATE_LABEL[o.state]} — không có gì để dừng.` }; }
    await io.sleep(300); // quiet before, so it isn't read as part of an escape sequence
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
  }
}
