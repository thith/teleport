// Inspect and (owner-only) stop the user's running `claude` processes.
//
// Why this exists: an agent opened BY HAND in a terminal (not via spawn.mjs, so
// not in a `tele-*` screen) whose Telegram listener died is unreachable from afar
// — the owner can't type into that terminal, the daemon's `/kill <hashtag>` only
// knows screen sessions, and Claude Code's own permission layer (rightly) stops
// one agent from killing another session's process. So the daemon gets:
//   • `/ps`            — list every `claude` process of this user (this script);
//   • `/kill pid:<P>`  — owner-only SIGTERM of ONE such process (daemon.mjs calls
//                        killClaudePid in-process; there is deliberately no CLI
//                        entry point for it here);
//   • `/spawn <project> --resume-session <id>` (spawn.mjs) — bring the session
//     back inside a screen, listener re-armed.
//
// Source of truth for pid → session: Claude Code writes `~/.claude/sessions/<pid>.json`
// for every live process ({ pid, sessionId, cwd, name, status, kind, procStart, … }).
// `procStart` is the process start time in clock ticks (= /proc/<pid>/stat field
// 22 on Linux), so a stale file left by a dead process whose pid got reused is
// detected and ignored. When no session file matches, we fall back to the newest
// transcript in `~/.claude/projects/<cwd-slug>/` and mark it as a GUESS.
//
// Process listing uses `ps` (Linux + macOS); /proc is used opportunistically
// (procStart check, STY for "is it in screen") when present.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './is-direct-run.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';

export const CLAUDE_HOME = path.join(os.homedir(), '.claude');
export const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');
export const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
export const KILL_PID_GRACE_MS = 10_000;
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/**
 * Parse `ps -A -o pid=,ppid=,uid=,tty=,etime=,comm=,args=` output. `comm` may be
 * a full path on macOS → basename. Rows that don't fit the shape are dropped.
 */
export function parsePsOutput(out) {
  const rows = [];
  for (const line of String(out ?? '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]),
      tty: m[4] === '?' || m[4] === '??' ? null : m[4],
      etime: m[5], comm: path.basename(m[6]), args: m[7] ?? '',
    });
  }
  return rows;
}

/** ps `etime` (`[[dd-]hh:]mm:ss`) → seconds, or null. */
export function etimeToSeconds(etime) {
  const m = String(etime ?? '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** Parse a `~/.claude/sessions/<pid>.json` body. Returns null if unusable. */
export function parseSessionFile(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || !Number.isInteger(j.pid)) return null;
  return {
    pid: j.pid,
    sessionId: typeof j.sessionId === 'string' && UUID_RE.test(j.sessionId) ? j.sessionId : null,
    cwd: typeof j.cwd === 'string' ? j.cwd : null,
    name: typeof j.name === 'string' && j.name ? j.name : null,
    status: typeof j.status === 'string' ? j.status : null,
    kind: typeof j.kind === 'string' ? j.kind : null,
    procStart: j.procStart != null ? String(j.procStart) : null,
  };
}

/** Claude Code's per-project transcript dir name: every non-alphanumeric char → '-'. */
export function cwdToProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** Telegram hashtag for a Claude session UUID (same derivation the agent uses). */
export function hashtagForSession(sessionId) {
  if (!sessionId || !UUID_RE.test(sessionId)) return null;
  const convo = uuidToConvoInt(sessionId);
  return convo == null ? null : shortConvoHash(convo);
}

/** `STY=<pid>.<name>` from a NUL-separated /proc/<pid>/environ body → screen session name. */
export function styFromEnviron(environ) {
  for (const kv of String(environ ?? '').split('\0')) {
    if (kv.startsWith('STY=')) return kv.slice(4).replace(/^\d+\./, '') || null;
  }
  return null;
}

/** Field 22 (starttime, clock ticks) of a /proc/<pid>/stat body; comm may contain spaces/parens. */
export function procStartFromStat(stat) {
  const s = String(stat ?? '');
  const close = s.lastIndexOf(')');
  if (close === -1) return null;
  const fields = s.slice(close + 2).split(' '); // fields[0] = field 3 (state)
  return fields[19] ?? null;                       // field 22
}

/**
 * The screen session a process runs in, by walking its ancestors for a `screen`
 * process and reading its `-S <name>` / `-dmS <name>` arg. Portable fallback for
 * when /proc/<pid>/environ (STY) isn't readable. `byPid` = Map<pid, psRow>.
 */
export function screenFromAncestors(pid, byPid) {
  const seen = new Set();
  let cur = byPid.get(pid);
  while (cur && cur.ppid > 1 && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    const parent = byPid.get(cur.ppid);
    if (!parent) return null;
    if (/^screen$/i.test(parent.comm)) {
      const m = parent.args.match(/(?:^|\s)-[a-zA-Z]*S\s+(\S+)/);
      return m ? m[1] : 'screen';
    }
    cur = parent;
  }
  return null;
}

/**
 * Join ps rows + session files (+ optional /proc extras) into display rows for
 * the user's `claude` processes. Pure: every input is passed in.
 *   psRows     — parsePsOutput() result (all processes; ancestors needed for screen)
 *   uid        — only this user's processes
 *   sessions   — Map<pid, parseSessionFile()>
 *   procExtras — Map<pid, { procStart?, sty?, cwd? }> (Linux /proc reads; may be empty)
 *   guessSession(cwd, claimed, sinceMs) → { sessionId } | null — transcript fallback;
 *     `claimed` = session ids already owned by a live process's session file, which
 *     the guess must skip (else a file-less process "inherits" a sibling's session);
 *     `sinceMs` = the process start time — a transcript untouched since then can't
 *     be this process's.
 *   nowMs      — clock for etime → start time
 */
export function buildProcRows({ psRows, uid, sessions = new Map(), procExtras = new Map(), guessSession = () => null, nowMs = Date.now() }) {
  const byPid = new Map(psRows.map((r) => [r.pid, r]));
  const mine = psRows.filter((r) => r.comm === 'claude' && r.uid === uid);
  // A session file whose procStart disagrees with the live process is a stale
  // leftover from a dead process whose pid was reused → ignore it.
  const validSess = (r) => {
    const sess = sessions.get(r.pid) || null;
    const extra = procExtras.get(r.pid) || {};
    return sess && sess.procStart && extra.procStart && sess.procStart !== extra.procStart ? null : sess;
  };
  const claimed = new Set(mine.map((r) => validSess(r)?.sessionId).filter(Boolean));
  const out = [];
  for (const r of mine) {
    const extra = procExtras.get(r.pid) || {};
    const sess = validSess(r);
    const cwd = sess?.cwd ?? extra.cwd ?? null;
    let sessionId = sess?.sessionId ?? null;
    let guessed = false;
    if (!sessionId && cwd) {
      const up = etimeToSeconds(r.etime);
      const g = up == null ? null : guessSession(cwd, claimed, nowMs - up * 1000 - 2000);
      if (g?.sessionId) { sessionId = g.sessionId; guessed = true; }
    }
    out.push({
      pid: r.pid, tty: r.tty, etime: r.etime, cwd,
      screen: extra.sty ?? screenFromAncestors(r.pid, byPid),
      sessionId, guessed,
      hashtag: hashtagForSession(sessionId),
      name: sess?.name ?? null,
      status: sess?.status ?? null,
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Render rows for Telegram (plain text). `home` shortens paths to `~`. */
export function formatProcRows(rows, { home = os.homedir() } = {}) {
  if (!rows.length) return '🖥 Không có tiến trình claude nào đang chạy.';
  const short = (p) => (p && home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);
  const lines = [`🖥 ${rows.length} tiến trình claude:`, ''];
  for (const r of rows) {
    const head = [`PID ${r.pid}`, r.name, r.status ? `(${r.status})` : null].filter(Boolean).join(' · ');
    lines.push(`• ${head}`);
    lines.push(`  cwd ${short(r.cwd) ?? '?'} · tty ${r.tty ?? '-'} · chạy ${r.etime}`);
    lines.push(`  ${r.screen ? `screen ${r.screen}` : 'terminal (không screen)'}`);
    if (r.sessionId) {
      lines.push(`  session ${r.sessionId}${r.guessed ? ' (đoán từ transcript mới nhất)' : ''}${r.hashtag ? ` · #${r.hashtag}` : ''}`);
    } else {
      lines.push('  session ?');
    }
  }
  lines.push('', 'Dừng (chỉ owner): /kill pid:<PID>');
  lines.push('Chạy lại trong screen: /spawn <project> --resume-session <session>');
  return lines.join('\n');
}

/** `pid:<N>` (whitespace tolerated after the colon) → N, else null. */
export function parseKillPidArg(rest) {
  const m = String(rest ?? '').trim().match(/^pid:\s*(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 1 ? n : null;
}

/**
 * Decide whether `pid` may be killed: it must be a live process of THIS user
 * whose command is exactly `claude`, and never ourselves. `info` is a fresh
 * snapshot `{ uid, comm }` (null = no such process). Pure → { ok } | { error }.
 */
export function checkKillTarget(pid, info, { uid, selfPid = process.pid } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { error: `PID không hợp lệ: ${pid}` };
  if (pid === selfPid) return { error: 'không tự kill daemon.' };
  if (!info) return { error: `không có tiến trình PID ${pid}.` };
  if (info.uid !== uid) return { error: `PID ${pid} không thuộc user hiện tại — từ chối.` };
  if (info.comm !== 'claude') return { error: `PID ${pid} là "${info.comm}", không phải claude — từ chối.` };
  return { ok: true };
}

// ── Side-effecting layer (injectable for tests) ───────────────────────────────

function readFileOrNull(file, enc = 'utf8') {
  try { return fs.readFileSync(file, enc); } catch { return null; }
}

/** All processes via `ps` (portable). Returns [] if ps fails. */
export function readPs(exec = execFileSync) {
  try {
    return parsePsOutput(exec('ps', ['-A', '-o', 'pid=,ppid=,uid=,tty=,etime=,comm=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch { return []; }
}

/**
 * Fresh `{ uid, comm }` of one pid, or null if it doesn't exist. Linux: read
 * /proc/<pid>/comm + the real uid from /proc/<pid>/status (what the owner asked
 * for). Elsewhere: `ps -p`.
 */
export function inspectPid(pid, { procDir = '/proc', exec = execFileSync } = {}) {
  const comm = readFileOrNull(path.join(procDir, String(pid), 'comm'));
  if (comm != null) {
    const status = readFileOrNull(path.join(procDir, String(pid), 'status')) || '';
    const m = status.match(/^Uid:\s+(\d+)/m);
    return m ? { uid: Number(m[1]), comm: comm.trim() } : null;
  }
  if (fs.existsSync(procDir)) return null; // /proc exists but no entry → gone
  const row = readPs(exec).find((r) => r.pid === pid);
  return row ? { uid: row.uid, comm: row.comm } : null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Newest unclaimed `<uuid>.jsonl` transcript written since `sinceMs` in the cwd's project dir → { sessionId } | null. */
export function guessSessionFromTranscripts(cwd, { projectsDir = PROJECTS_DIR, claimed = new Set(), sinceMs = 0 } = {}) {
  const dir = path.join(projectsDir, cwdToProjectSlug(cwd));
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      const id = f.replace(/\.jsonl$/, '');
      if (id === f || !UUID_RE.test(id) || claimed.has(id)) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (m < sinceMs) continue;
      if (!best || m > best.m) best = { sessionId: id, m };
    }
  } catch { return null; }
  return best ? { sessionId: best.sessionId } : null;
}

/** Gather everything and return display rows (see buildProcRows). */
export function listClaudeProcs({
  uid = process.getuid?.() ?? -1, sessionsDir = SESSIONS_DIR, procDir = '/proc',
  projectsDir = PROJECTS_DIR, exec = execFileSync,
} = {}) {
  const psRows = readPs(exec);
  const sessions = new Map();
  const procExtras = new Map();
  for (const r of psRows) {
    if (r.comm !== 'claude' || r.uid !== uid) continue;
    const s = parseSessionFile(readFileOrNull(path.join(sessionsDir, `${r.pid}.json`)));
    if (s && s.pid === r.pid) sessions.set(r.pid, s);
    const base = path.join(procDir, String(r.pid));
    let cwd = null;
    try { cwd = fs.readlinkSync(path.join(base, 'cwd')); } catch {}
    procExtras.set(r.pid, {
      procStart: procStartFromStat(readFileOrNull(path.join(base, 'stat'))),
      sty: styFromEnviron(readFileOrNull(path.join(base, 'environ'))),
      cwd,
    });
  }
  return buildProcRows({
    psRows, uid, sessions, procExtras,
    guessSession: (cwd, claimed, sinceMs) => guessSessionFromTranscripts(cwd, { projectsDir, claimed, sinceMs }),
  });
}

/**
 * Owner-gated SIGTERM of one claude process. The OWNER check is the caller's
 * (daemon.mjs — it knows daemonUserId); this enforces the target rules, sends
 * SIGTERM, and waits up to `graceMs` for it to exit. It never escalates to
 * SIGKILL: a process that ignores SIGTERM is reported, not force-killed.
 * Returns { ok, exited, error?, target? } — `target` = the /ps row (for audit).
 */
export async function killClaudePid(pid, {
  uid = process.getuid?.() ?? -1,
  inspect = (p) => inspectPid(p),
  kill = (p, sig) => process.kill(p, sig),
  alive = pidAlive,
  describe = (p) => listClaudeProcs({ uid }).find((r) => r.pid === p) || null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  graceMs = KILL_PID_GRACE_MS, pollMs = 500, selfPid = process.pid,
} = {}) {
  const chk = checkKillTarget(pid, inspect(pid), { uid, selfPid });
  if (chk.error) return { ok: false, exited: false, error: chk.error };
  const target = describe(pid);
  try { kill(pid, 'SIGTERM'); } catch (e) {
    return { ok: false, exited: false, error: `SIGTERM thất bại: ${e?.code || e?.message || e}`, target };
  }
  for (let waited = 0; waited < graceMs; waited += pollMs) {
    if (!alive(pid)) return { ok: true, exited: true, target };
    await sleep(Math.min(pollMs, graceMs - waited));
  }
  return { ok: true, exited: !alive(pid), target };
}

/** Find a LIVE claude process that holds `sessionId` (resume guard). A guessed match counts too — when unsure, refuse. */
export function findProcForSession(sessionId, rows) {
  return rows.find((r) => r.sessionId === sessionId) || null;
}

// CLI: `node claude-procs.mjs` → the /ps listing.
if (isMainModule(import.meta.url)) {
  process.stdout.write(formatProcRows(listClaudeProcs()) + '\n');
}
