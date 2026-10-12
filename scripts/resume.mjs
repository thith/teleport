// `/resume <persona name | #hashtag>` — a daemon command: bring a DEAD agent back
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
import { readTopicsStore } from './topics-store.mjs';
import { peekPersona } from './persona-store.mjs';
import { formatPersona } from './persona.mjs';
import { PARENT_DIR } from './workspace.mjs';

export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
export const RECENT_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Name → comparable form (same rule as /kill name:). Pure. */
export function normalizeName(s) {
  return String(s ?? '').normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Pick the session to resume. `candidates` = [{ sessionId, hashtag, persona, mtimeMs, cwd }].
 * Query `#a7611284` / `a7611284` → hashtag; otherwise a full persona name.
 * Returns { target, others } | { error }. Pure.
 */
export function findResumeTarget(query, candidates, { aliveSessions = new Set() } = {}) {
  const q = String(query ?? '').trim().replace(/^name:\s*/i, ''); // accept the /kill name: form too
  if (!q) return { error: 'usage: /resume <persona name | #hashtag>' };
  const tag = q.replace(/^#/, '').toLowerCase();
  let hits = /^[a-j]\d{7}$|^t\d+$/.test(tag) ? candidates.filter((c) => c.hashtag === tag) : [];
  if (!hits.length) {
    const n = normalizeName(q);
    hits = candidates.filter((c) => c.persona && normalizeName(c.persona) === n);
  }
  if (!hits.length) return { error: `no agent "${q}" with a Telegram topic in the last ${RECENT_DAYS} days.` };
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Only DEAD sessions can be resumed: skip ones a live claude still holds.
  const dead = hits.filter((h) => !aliveSessions.has(h.sessionId));
  if (!dead.length) return { error: `${hits[0].persona || q} #${hits[0].hashtag} is still running — nothing to resume (use /kill name:"…" --restart to restart it).` };
  return { target: dead[0], others: dead.slice(1), skippedLive: hits.filter((h) => aliveSessions.has(h.sessionId)) };
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
  return out;
}

/** The transcript's cwd if it is the workspace or inside it (realpath), else { error }. */
export function checkCwd(cwd, { parentDir = PARENT_DIR, realpath = fs.realpathSync } = {}) {
  if (!cwd) return { error: 'the transcript has no working directory recorded.' };
  let real, parent;
  try { real = realpath(cwd); parent = realpath(parentDir); } catch { return { error: `folder ${cwd} no longer exists.` }; }
  if (real === parent || !real.startsWith(parent + path.sep)) return { error: `${cwd} is outside the workspace — refusing.` };
  return { cwd: real };
}

if (isMainModule(import.meta.url)) {
  // Forwarded claude flags (RFC 18): split BEFORE joining the name query.
  const { splitForwarded, parseExtraArgs } = await import('./spawn-extra-args.mjs');
  // (resume.mjs splits BEFORE joining the name query — a flag must never become part of the name.)
  const { readProjectsConfig, resolveDaemonUserId } = await import('./projects-config.mjs');
  const { own, fwd } = splitForwarded(process.argv.slice(2));
  const query = own.join(' ');
  const ownerId = resolveDaemonUserId(readProjectsConfig(new URL('../projects.json', import.meta.url).pathname), { env: {} });
  const { isOwnerCaller } = await import('./spawn-extra-args.mjs');
  const callerIsOwner = isOwnerCaller({ isTTY: process.stdin.isTTY, env: process.env, ownerId });
  let extraArgs;
  if (fwd !== null) {
    const px = parseExtraArgs(fwd, { owner: callerIsOwner });
    if (px.error) { console.log(`❌ ${px.error}`); process.exit(1); }
    extraArgs = px.args;
  }
  const { listClaudeProcs } = await import('./claude-procs.mjs');
  const alive = new Set(listClaudeProcs().map((r) => r.sessionId).filter(Boolean));
  const pick = findResumeTarget(query, listCandidates(), { aliveSessions: alive });
  if (pick.error) { console.log(`❌ ${pick.error}`); process.exit(1); }
  const t = pick.target;
  const c = checkCwd(transcriptCwd(t.file));
  if (c.error) { console.log(`❌ ${t.persona || ''} #${t.hashtag}: ${c.error}`); process.exit(1); }
  const { performResume } = await import('./spawn.mjs');
  const res = await performResume({ sessionId: t.sessionId, cwd: c.cwd, extraArgs, setBy: callerIsOwner ? 'owner' : 'agent' });
  const also = (pick.others.length ? `\n(also matched, older: ${pick.others.slice(0, 5).map((o) => `#${o.hashtag}`).join(', ')} — use /resume #<hashtag> for one of those)` : '')
    + (pick.skippedLive?.length ? `\n(skipped — still running: ${pick.skippedLive.map((o) => `#${o.hashtag}`).join(', ')})` : '');
  if (res.error) { console.log(`❌ ${t.persona || ''} #${t.hashtag}: ${res.error}${also}`); process.exit(1); }
  console.log(`🔁 resumed ${t.persona || ''} #${t.hashtag} (session ${t.sessionId}) in screen "${res.plan.sessionName}", folder ${path.basename(c.cwd)}. It will check its mailbox, re-arm its listener and greet in its topic.${res.plan.extraArgs?.length ? `\nclaude flags: ${res.plan.extraArgs.join(' ')}` : ''}${res.plan.extraNote ? `\n${res.plan.extraNote}` : ''}${also}`);
}
