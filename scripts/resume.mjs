// `/resume <persona name | #hashtag | 3-digit tail>` (and `teleport resume`) — a daemon command: bring a DEAD agent back
// by name instead of typing its session UUID (`/spawn <project> --resume-session`).
//
// Candidates are the Claude transcripts (~/.claude/projects/*/<uuid>.jsonl,
// touched in the last RECENT_DAYS) whose convo has a Telegram topic — i.e. the
// agents you talk to. Each is matched by its topic hashtag or its persona name
// (full name, emoji/case ignored). The newest match wins; others are listed. The
// project folder comes from the transcript's own `cwd` and must be inside the
// workspace. The resume itself is spawn.mjs performResume (every preflight:
// refuses while the agent is still alive, lock, screen verify, cooldown).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './is-direct-run.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { normalizeAgentName, parseAgentTarget, unquoteTarget, resolveTail } from './agent-target.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { peekPersona } from './persona-store.mjs';
import { formatPersona } from './persona.mjs';
import { PARENT_DIR } from './workspace.mjs';

export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
export const RECENT_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Name → comparable form (the shared rule, agent-target.mjs). Pure. */
export const normalizeName = normalizeAgentName;

/** One entry per session (the newest transcript wins): the same session can have transcripts in two project dirs. Pure. */
export function dedupeCandidates(cands) {
  const by = new Map();
  for (const c of cands) { const o = by.get(c.sessionId); if (!o || c.mtimeMs > o.mtimeMs) by.set(c.sessionId, c); }
  return [...by.values()];
}

/** "vừa xong" / "N phút trước" / "N giờ trước" / "N ngày trước". Pure. */
export function ago(mtimeMs, now = Date.now()) {
  const m = Math.floor(Math.max(0, now - mtimeMs) / 60_000);
  if (m < 1) return 'vừa xong';
  return m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.floor(m / 60)} giờ trước` : `${Math.floor(m / 1440)} ngày trước`;
}

const folderOfCandidate = (c) => { const cwd = c.file ? transcriptCwd(c.file) : null; return cwd ? path.basename(cwd) : ''; };

/**
 * Pick the session to resume. `candidates` = [{ sessionId, hashtag, persona, mtimeMs, file }]; `liveRows` =
 * every live claude row (listClaudeProcs, optionally with `persona`), guessed ones too.
 * Query `#a7611284` / `a7611284` → hashtag; 3 digits → tail (RFC 28: shorthand for the hashtag it ends,
 * resolved over candidates ∪ ALL live rows BEFORE any alive/dead filtering — a hidden twin is refused, never
 * skipped); otherwise a full persona name. Returns { target, others, skippedLive } | { error }. Pure.
 */
export function findResumeTarget(query, cands, { aliveSessions = new Set(), liveRows = [], folderOf = folderOfCandidate, now = Date.now() } = {}) {
  const candidates = dedupeCandidates(cands);
  let t = parseAgentTarget(unquoteTarget(query)); // `name:` (the /kill form) accepted too; outer quotes off (RFC 26 §3.8)
  const usage = 'usage: /resume <persona name | #hashtag | 3-digit tail>';
  if (!String(t.value ?? '') || t.kind === 'pid' || t.kind === 'convoId') return { error: usage };
  const typedTail = t.kind === 'tail' ? t.value : null;
  if (typedTail) {
    const state = (x) => (x.pid != null ? ` — đang chạy, PID ${x.pid}` : aliveSessions.has(x.sessionId) ? ' — đang chạy' : '');
    // A confirmed live session is ONE identity: its candidate merged with its live row (keeps the PID); guessed rows stay apart.
    const liveBySid = new Map(liveRows.filter((r) => r.sessionId && !r.guessed).map((r) => [r.sessionId, r]));
    const pool = [...candidates.map((c) => (liveBySid.has(c.sessionId) ? { ...c, pid: liveBySid.get(c.sessionId).pid } : c)),
      ...liveRows.filter((r) => !(r.sessionId && !r.guessed && candidates.some((c) => c.sessionId === r.sessionId)))];
    const r = resolveTail(typedTail, pool, (x) => `${x.persona || '?'} #${x.hashtag}${state(x)}`);
    if (r.error) return { error: r.error };
    if (r.none) return { error: `no agent ending in "${typedTail}" with a Telegram topic in the last ${RECENT_DAYS} days.` };
    t = { kind: 'hashtag', value: r.hashtag };
  }
  const q = String(t.value);
  // A hashtag is an exact address: no name fallback.
  const hits = t.kind === 'hashtag'
    ? candidates.filter((c) => c.hashtag === q)
    : candidates.filter((c) => c.persona && normalizeName(c.persona) === normalizeName(q));
  const attachHint = (rows) => (rows.some((r) => String(r.screen || '').startsWith('tele-')) ? ` — dùng \`teleport attach ${typedTail || q}\`` : '');
  if (!hits.length) {
    const live = t.kind === 'hashtag' ? liveRows.filter((r) => r.hashtag === q) : [];
    // Alive but not a candidate (no topic / too old / no known session): "not found" would be a lie.
    if (live.length) return { error: `${live[0].persona ? `${live[0].persona} ` : ''}#${q} đang chạy (${live.map((r) => `PID ${r.pid}`).join(', ')}) — không có gì để resume${attachHint(live)}.` };
    return { error: `no agent "${typedTail || q}" with a Telegram topic in the last ${RECENT_DAYS} days.` };
  }
  // A hashtag is an exact address: two different sessions behind it → refuse, never pick the newest (RFC 26 §3.9).
  if (t.kind === 'hashtag' && new Set(hits.map((h) => h.sessionId)).size > 1) {
    const one = (h) => `${h.persona || '?'} ${h.sessionId} (${[folderOf(h), ago(h.mtimeMs, now)].filter(Boolean).join(', ')})`;
    return { error: `#${q} matches ${hits.length} sessions: ${hits.map(one).join('; ')} — resume by UUID: /spawn <project> --resume-session <uuid>.` };
  }
  // …including a LIVE claude behind the same hashtag that is not a candidate (no topic, too old,
  // or no known session): the tap may have meant that one, so never resume the other.
  if (t.kind === 'hashtag') {
    const known = new Set(hits.map((h) => h.sessionId));
    const other = liveRows.filter((r) => r.hashtag === q && !(r.sessionId && !r.guessed && known.has(r.sessionId)));
    if (other.length) return { error: `#${q} also belongs to live claude ${other.map((r) => `PID ${r.pid}`).join(', ')} — check /ls; resume by UUID if you mean the dead one.` };
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Only DEAD sessions can be resumed: skip ones a live claude still holds.
  const dead = hits.filter((h) => !aliveSessions.has(h.sessionId));
  if (!dead.length) return { error: `${hits[0].persona || q} #${hits[0].hashtag} is still running — nothing to resume (use /kill <name> --restart to restart it)${attachHint(liveRows.filter((r) => hits.some((h) => h.sessionId === r.sessionId)))}.` };
  return { target: dead[0], others: dead.slice(1), skippedLive: hits.filter((h) => aliveSessions.has(h.sessionId)) };
}

/**
 * `teleport ls off`: the agents stopped in the last RECENT_DAYS days, newest first (max `max` lines). A session a
 * live claude holds for SURE is left out; one only GUESSED to be running stays, flagged. `procsError` (the process
 * list could not be read) → a warning first: the list may include running agents. Pure.
 */
export function formatStopped(cands, { liveRows = [], procsError = null, now = Date.now(), folderOf = folderOfCandidate, max = 20 } = {}) {
  const sure = new Set(liveRows.filter((r) => r.sessionId && !r.guessed).map((r) => r.sessionId));
  const guess = new Set(liveRows.filter((r) => r.sessionId && r.guessed).map((r) => r.sessionId));
  const list = dedupeCandidates(cands).filter((c) => !sure.has(c.sessionId)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const line = (c) => `💤 ${[c.persona, `#${c.hashtag}`].filter(Boolean).join(' ')} · ${[folderOf(c), ago(c.mtimeMs, now)].filter(Boolean).join(' · ')}${guess.has(c.sessionId) ? ' (có thể đang chạy?)' : ''}`;
  const lines = list.slice(0, max).map(line);
  if (list.length > max) lines.push(`… và ${list.length - max} agent cũ hơn (tối đa ${RECENT_DAYS} ngày)`);
  const warn = procsError ? '⚠️ không đọc được danh sách process — danh sách dưới có thể lẫn agent đang chạy' : null;
  return [warn, ...(lines.length ? lines : [`(không có agent nào tắt trong ${RECENT_DAYS} ngày qua)`])].filter(Boolean).join('\n');
}

/** The `cwd` recorded in a transcript (first entries that carry one), or null. */
export function transcriptCwd(file, { maxBytes = 256 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try { const j = JSON.parse(line); if (typeof j.cwd === 'string') return j.cwd; } catch { /* partial line */ }
    }
  } catch { /* unreadable */ } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  return null;
}

/** Recent transcripts whose convo has a Telegram topic → candidates. */
export function listCandidates({ projectsDir = PROJECTS_DIR, store = readTopicsStore(), now = Date.now(), days = RECENT_DAYS } = {}) {
  const withTopic = new Set();
  for (const entry of Object.values(store || {})) {
    if (entry && typeof entry === 'object') for (const k of Object.keys(entry)) if (!k.startsWith('_')) withTopic.add(String(k));
  }
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(projectsDir, d)); } catch { continue; }
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '');
      if (id === f || !UUID_RE.test(id)) continue;
      const convo = uuidToConvoInt(id);
      if (convo == null || !withTopic.has(String(convo))) continue;
      const file = path.join(projectsDir, d, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (now - st.mtimeMs > days * 86400_000) continue;
      const p = peekPersona(convo);
      out.push({ sessionId: id, hashtag: shortConvoHash(convo), persona: p ? formatPersona(p) : null, mtimeMs: st.mtimeMs, file });
    }
  }
  return dedupeCandidates(out);
}

/** The transcript's cwd if it is the workspace or inside it (realpath), else { error }. */
export function checkCwd(cwd, { parentDir = PARENT_DIR, realpath = fs.realpathSync } = {}) {
  if (!cwd) return { error: 'the transcript has no working directory recorded.' };
  let real, parent;
  try { real = realpath(cwd); parent = realpath(parentDir); } catch { return { error: `folder ${cwd} no longer exists.` }; }
  if (real === parent || !real.startsWith(parent + path.sep)) return { error: `${cwd} is outside the workspace — refusing.` };
  return { cwd: real };
}

/**
 * The CLI: `resume.mjs <name | #hashtag | tail> [-- <claude flags>]`, or the read-only `resume.mjs --list-stopped`
 * (ONLY as the single argument; `teleport ls off`) which never resumes anything. → exit code. `d` = test seams.
 */
export async function runMain(argv, d = {}) {
  const log = d.log ?? ((m) => console.log(m));
  const procsMod = await import('./claude-procs.mjs');
  const listLive = d.listClaudeProcs ?? procsMod.listClaudeProcs;
  const candidates = d.listCandidates ?? listCandidates;
  if (argv.length === 1 && argv[0] === '--list-stopped') {
    let liveRows = [], procsError = null;
    try { liveRows = listLive({ strict: true }); } catch (e) { procsError = e?.message ?? String(e); }
    log(procsMod.padNarrowEmoji(formatStopped(candidates(), { liveRows, procsError, now: d.now }))); // terminal only
    return 0;
  }
  // Forwarded claude flags (RFC 18): split BEFORE joining the name query — a flag must never become part of the name.
  const { splitForwarded, parseExtraArgs, isOwnerCaller } = await import('./spawn-extra-args.mjs');
  const { own, fwd } = splitForwarded(argv);
  const query = own.join(' ');
  let callerIsOwner = d.callerIsOwner;
  if (callerIsOwner === undefined) {
    const { readProjectsConfig, resolveDaemonUserId } = await import('./projects-config.mjs');
    const ownerId = resolveDaemonUserId(readProjectsConfig(new URL('../projects.json', import.meta.url).pathname), { env: {} });
    callerIsOwner = isOwnerCaller({ isTTY: process.stdin.isTTY, env: process.env, ownerId });
  }
  let extraArgs;
  if (fwd !== null) {
    const px = parseExtraArgs(fwd, { owner: callerIsOwner });
    if (px.error) { log(`❌ ${px.error}`); return 1; }
    extraArgs = px.args;
  }
  let liveRows;
  try { liveRows = listLive({ strict: true }); } catch (e) { log(`❌ cannot list live claude processes (${e.message}) — not resuming blind.`); return 1; }
  const spawnMod = d.performResume && d.personaOf ? null : await import('./spawn.mjs');
  const personaOf = d.personaOf ?? spawnMod.makePersonaOf();
  liveRows = liveRows.map((r) => ({ ...r, persona: personaOf(r) }));
  const alive = new Set(liveRows.map((r) => r.sessionId).filter(Boolean));
  const pick = findResumeTarget(query, candidates(), { aliveSessions: alive, liveRows, now: d.now });
  if (pick.error) { log(`❌ ${pick.error}`); return 1; }
  const t = pick.target;
  const c = d.resolveCwd ? d.resolveCwd(t) : checkCwd(transcriptCwd(t.file));
  if (c.error) { log(`❌ ${t.persona || ''} #${t.hashtag}: ${c.error}`); return 1; }
  const res = await (d.performResume ?? spawnMod.performResume)({ sessionId: t.sessionId, cwd: c.cwd, extraArgs, setBy: callerIsOwner ? 'owner' : 'agent' });
  const also = (pick.others.length ? `\n(also matched, older: ${pick.others.slice(0, 5).map((o) => `/resume_${o.hashtag}`).join(', ')} — tap one of those)` : '')
    + (pick.skippedLive?.length ? `\n(skipped — still running: ${pick.skippedLive.map((o) => `#${o.hashtag}`).join(', ')})` : '');
  if (res.error) { log(`❌ ${t.persona || ''} #${t.hashtag}: ${res.error}${also}`); return 1; }
  log(`🔁 resumed ${t.persona || ''} #${t.hashtag} (session ${t.sessionId}) in screen "${res.plan.sessionName}", folder ${path.basename(c.cwd)}. It will check its mailbox, re-arm its listener and greet in its topic.${res.plan.extraArgs?.length ? `\nclaude flags: ${res.plan.extraArgs.join(' ')}` : ''}${res.plan.extraNote ? `\n${res.plan.extraNote}` : ''}${also}`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(await runMain(process.argv.slice(2)));
