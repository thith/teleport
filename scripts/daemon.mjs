// Teleport Supervisor Daemon (Phase 1).
//
// A best-effort, manually-started, NON-AI control plane. It is the always-on
// piece that lets you steer/recover from afar even when every agent has died
// (quota/network/API). You start it before stepping away (`pnpm daemon`), or ask
// a live agent to start it; forget to, and teleport just behaves as before.
//
// Architecture ("hợp tác xã" — cooperative harvest): the daemon polls Telegram
// getUpdates into the SAME shared per-bot updates-cache that agent `tele-listen`
// loops use, under the SAME poll lock — so daemon and agents never fight the
// global offset; whoever is awake harvests into the common cache. Each consumer
// then picks up only its own lane: agents read their topic (by message_thread_id),
// the daemon reads its PRIVATE control DM (DAEMON_CHAT_ID). Up to retrieval it is
// identical to an agent; only the *processing* differs — the daemon runs known,
// deterministic, non-AI commands (it never calls an LLM).
//
// Domain split (validated at startup): agents/topics live in GROUPS (chatId < 0);
// the daemon's control channel is a PRIVATE DM (DAEMON_CHAT_ID > 0).
//
// Phase 1 commands: /spawn <project>, /whisper topic:#<hash> <text>, /pending,
// /start — plus the heartbeat auto-reminder pass (moved here from tele-listen).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

import {
  loadEnvFromFile, parseAdminChatIds, extractBotId, sendTextToAdmin, shortConvoHash,
} from './send-telegram.mjs';
import {
  readProjectsConfig, roleFor, assertChatIdKind, projectEntries, readDefaultGroup,
  resolveDefaultChatId, resolveDaemonChatId, resolveQuietHours,
} from './projects-config.mjs';
import {
  DEFAULT_TMP_DIR, botScopedFiles, fetchUpdates, appendToCache, readCacheSinceOffset,
  readOffset, writeOffset, resolveStartOffset, acquirePollLock, releasePollLock,
  partitionOrphans, pruneCache, detectPendingCommands, dispatchPendingResponses,
  detectStartCommands, runHeartbeatReminders,
} from './tele-listen.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { listLiveTopics, normalizeTarget, matchTarget, writePromptExclusive } from './handover.mjs';
import { buildSpawnPlan, genSessionSeed, runSpawn, hasBinary } from './spawn.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');
const PROJECTS_FILE = path.join(__dirname, '..', 'projects.json');
// Common parent of teleport and its sibling projects (the workspace root). The
// daemon orchestrates across siblings, so `/spawn <project>` resolves to
// `<PARENT_DIR>/<project>`.
export const PARENT_DIR = path.resolve(__dirname, '..', '..');

export const DAEMON_POLL_MS = 3000;            // dedicated process → poll briskly
export const HEARTBEAT_EVERY_MS = 60_000;      // reminder scan cadence
const PID_FILE = path.join(DEFAULT_TMP_DIR, 'daemon.pid');

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

// Parse the leading `/command` of a message. Returns { cmd, rest } or null.
// `cmd` is lower-cased, sans the leading slash and any @botname suffix.
export function parseDaemonCommand(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^\/([a-zA-Z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), rest: (m[2] ?? '').trim() };
}

// Parse `/whisper` arguments: `topic:#<hash|convoId> <message>`. The `topic:`
// prefix is optional; the first token is the target, the remainder the message.
// Returns { target, message } or { error }.
export function parseWhisperArgs(rest) {
  if (!rest) return { error: 'usage: /whisper topic:#<hashtag> <message>' };
  const cleaned = rest.replace(/^topic:\s*/i, '').trim();
  const sp = cleaned.search(/\s/);
  if (sp < 0) return { error: 'whisper needs a message after the topic' };
  const target = cleaned.slice(0, sp).trim();
  const message = cleaned.slice(sp + 1).trim();
  if (!target) return { error: 'missing topic target' };
  if (!message) return { error: 'missing message' };
  return { target, message };
}

// `/run` config. Only npm/pnpm/yarn are ever invoked (the PM is auto-detected,
// never user-supplied — it's remote code execution, keep it bounded). Hard
// timeout; output is sent as-is and teleport auto-attaches it as a file when long
// (we only tail-cap at a generous safety ceiling to avoid pathological sends).
export const RUN_TIMEOUT_MS = 5 * 60 * 1000;
export const RUN_MAX_BUFFER = 8 * 1024 * 1024;
export const RUN_OUTPUT_CAP = 100_000;

// Parse `/run <project> <script> [args...]` (NO package manager — auto-detected).
// Returns {project, script, args} or {error}.
export function parseRunArgs(rest) {
  const parts = (rest || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { error: 'usage: /run <project> <script> [args...]' };
  const [project, script, ...args] = parts;
  // A script starting with '-' would be parsed by the PM as a flag (e.g. a way
  // to slip `--prefix`); the script name must be a plain identifier.
  if (script.startsWith('-')) return { error: `invalid script name: ${JSON.stringify(script)}` };
  return { project, script, args };
}

// Detect the package manager a project uses: package.json `packageManager` field
// first, then lockfiles (pnpm > yarn > npm), default npm. Pure (deps injected).
export function detectPackageManager(cwd, { existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0].trim() : '';
    if (pm === 'pnpm' || pm === 'yarn' || pm === 'npm') return pm;
  } catch { /* fall through to lockfiles */ }
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
  return 'npm';
}

// Read a project's package.json scripts. Returns {scripts} or {error} (missing
// file / parse error). Pure (readFileSync injectable).
export function readPackageScripts(cwd, { readFileSync = fs.readFileSync } = {}) {
  let raw;
  try { raw = readFileSync(path.join(cwd, 'package.json'), 'utf8'); }
  catch { return { error: `no package.json in ${cwd}` }; }
  let pkg;
  try { pkg = JSON.parse(raw); } catch { return { error: `package.json is not valid JSON` }; }
  const scripts = (pkg && pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) ? pkg.scripts : {};
  return { scripts };
}

// Tail-cap a string at a generous ceiling (safety net only — normal output is
// sent whole and teleport files it if long). Pure.
export function tailOutput(s, max = RUN_OUTPUT_CAP) {
  s = s == null ? '' : String(s);
  if (s.length <= max) return s;
  return `…(truncated; showing last ${max} chars)\n` + s.slice(s.length - max);
}

// Resolve `/spawn <project>` to a sibling directory under PARENT_DIR. Returns
// { cwd } or { error }. Validates the project token (no path traversal) and that
// the directory exists with a package.json (teleport's project convention).
export function resolveSpawnCwd(project, { parentDir = PARENT_DIR, statSync = fs.statSync, realpathSync = fs.realpathSync } = {}) {
  if (!project) return { error: 'usage: /spawn <project>' };
  if (!/^[A-Za-z0-9._-]+$/.test(project) || project === '.' || project === '..') {
    return { error: `invalid project name: ${JSON.stringify(project)}` };
  }
  const cwd = path.join(parentDir, project);
  try {
    if (!statSync(cwd).isDirectory()) return { error: `not a directory: ${cwd}` };
  } catch {
    return { error: `project folder not found: ${cwd}` };
  }
  // Containment after following symlinks: a project dir that's a symlink to
  // OUTSIDE the workspace parent must not let /spawn or /run execute elsewhere.
  try {
    const realParent = realpathSync(parentDir);
    const realCwd = realpathSync(cwd);
    if (realCwd !== realParent && !realCwd.startsWith(realParent + path.sep)) {
      return { error: `project resolves outside the workspace: ${project}` };
    }
  } catch {
    return { error: `cannot resolve project path: ${cwd}` };
  }
  return { cwd };
}

// Build the prompt object injected into a target convo by /whisper. Mirrors the
// handover prompt shape but carries `whisper:true` (discreet steer) and the
// REAL fromRole of the whisperer so the target's sensitive-action gate still
// applies. `messageId:null` marks it as injected (not a real Telegram message).
export function buildWhisperPrompt({ targetConvoId, targetChatId, fromUserId, fromName, fromRole, text }) {
  return {
    text,
    messageId: null,
    chatId: targetChatId == null ? null : String(targetChatId),
    fromUserId: fromUserId == null ? null : String(fromUserId),
    fromName: fromName ?? 'admin',
    fromRole: fromRole ?? 'member',
    fromMember: null,
    replyToMessageId: null,
    replyToText: null,
    quotedText: null,
    timestamp: Math.floor(Date.now() / 1000),
    attachments: [],
    convoId: Number(targetConvoId),
    whisper: true,
  };
}

// The whisperer's advisory role, looked up across the catch-all roster
// (`_default.roles`) AND every dedicated project's roles. The control-DM owner is
// typically admin in the catch-all, so `_default.roles` MUST be consulted (it's
// skipped by projectEntries). Highest privilege wins; unmapped → 'member' (least
// privilege, so the target still gates).
const ROLE_RANK = { admin: 3, maintainer: 2, dev: 1, member: 0 };
export function resolveSenderRole(projectsConfig, userId) {
  let best = 'member';
  // Consult ONLY the rosters that are actually authoritative: `_default.roles`
  // (the catch-all group) + each DEDICATED project's own roles. A SHARED project's
  // `roles` block is dead config (resolveProjectConfig ignores it, using
  // `_default.roles` instead), so it must NOT grant privilege here either.
  const rosters = [
    readDefaultGroup(projectsConfig).roles,
    ...projectEntries(projectsConfig)
      .filter(([, p]) => p && p.chatId != null && String(p.chatId).trim() !== '')
      .map(([, p]) => p.roles),
  ];
  for (const roles of rosters) {
    const r = roleFor(roles, userId);
    if (r && (ROLE_RANK[r] ?? -1) > (ROLE_RANK[best] ?? -1)) best = r;
  }
  return best;
}

// Validate the whole teleport config for the daemon: every project/catch-all
// chat must be a GROUP, and DAEMON_CHAT_ID must be a PRIVATE DM. Throws with a
// clear message on the first violation. Pure (config + env passed in).
export function validateDaemonConfig({ projectsConfig, catchAllIds, daemonChatId }) {
  if (!daemonChatId) throw new Error('Missing daemonChatId — set projects.json `_config.daemonChatId` (a private chat id).');
  assertChatIdKind(daemonChatId, 'private', 'projects.json `_config.daemonChatId`');
  for (const id of catchAllIds) assertChatIdKind(id, 'group', 'projects.json `_default.chatId`');
  for (const [key, proj] of projectEntries(projectsConfig)) {
    // Trim first: an empty/whitespace chatId means "shared" (no own group) — same
    // as resolveProjectConfig — so don't validate (or reject startup on) it.
    const chatId = proj?.chatId == null ? '' : String(proj.chatId).trim();
    if (chatId) assertChatIdKind(chatId, 'group', `project '${key}' chatId`);
  }
}

// ── Process lifecycle ─────────────────────────────────────────────────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Single-instance guard: refuse to start if a live daemon already holds the pid
// file (two daemons = two getUpdates consumers = offset war). Reaps a stale pid.
export function acquireSingleton(pidFile = PID_FILE) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  try {
    const existing = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pidAlive(existing)) return { ok: false, pid: existing };
    fs.unlinkSync(pidFile); // stale
  } catch { /* no pid file */ }
  fs.writeFileSync(pidFile, String(process.pid));
  return { ok: true, pid: process.pid };
}
export function releaseSingleton(pidFile = PID_FILE) {
  try {
    const p = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (p === process.pid) fs.unlinkSync(pidFile);
  } catch { /* gone */ }
}
export function daemonStatus(pidFile = PID_FILE) {
  try {
    const p = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return pidAlive(p) ? { running: true, pid: p } : { running: false, pid: p, stale: true };
  } catch { return { running: false }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DEFAULT_TMP_DIR, { recursive: true });
  const env = loadEnvFromFile(ENV_FILE);
  const token = process.env.REPORT_BOT_TOKEN || env.REPORT_BOT_TOKEN;
  if (!token) { console.error('[daemon] Missing REPORT_BOT_TOKEN in .env or env.'); process.exit(1); }
  const botId = extractBotId(token);
  const projectsConfig = readProjectsConfig(PROJECTS_FILE);
  // Config lives in projects.json `_config` (env only for secrets); env names
  // remain a deprecated fallback during migration.
  const daemonChatId = resolveDaemonChatId(projectsConfig, { env: process.env, envFile: env }) || '';
  const catchAllIds = parseAdminChatIds(resolveDefaultChatId(projectsConfig, { env: process.env, envFile: env }) || '');

  try {
    validateDaemonConfig({ projectsConfig, catchAllIds, daemonChatId });
  } catch (e) {
    console.error(`[daemon] config error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const lock = acquireSingleton();
  if (!lock.ok) { console.error(`[daemon] already running (pid ${lock.pid}). Refusing to start a second instance.`); process.exit(1); }

  const cleanup = () => { releaseSingleton(); process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => releaseSingleton());

  const { cacheFile, globalOffsetFile } = botScopedFiles(botId);
  const daemonOffsetFile = path.join(DEFAULT_TMP_DIR, `daemon-offset.${botId}.txt`);
  // Start at the CURRENT frontier so a freshly-started daemon does NOT replay
  // historical /spawn|/whisper commands sitting in the shared cache (that would
  // re-spawn agents / re-inject whispers). Only commands arriving AFTER startup
  // are acted on. Existing offset file (a restart mid-life) is left as-is.
  if (!fs.existsSync(daemonOffsetFile)) {
    try { fs.writeFileSync(daemonOffsetFile, String(readOffset(globalOffsetFile))); } catch {}
  }
  // Group admin ids for heartbeat reminders (where agent topics live).
  const groupAdminIds = [...new Set(catchAllIds.concat(
    projectEntries(projectsConfig).map(([, p]) => p && p.chatId).filter(Boolean).map(String),
  ))];

  console.error(`[daemon] up. pid=${process.pid} bot=${botId} control-DM=${daemonChatId} parent=${PARENT_DIR}`);
  const sendText = async (chatId, text) => {
    // sendTextToAdmin (not sendTextChunk) so LONG output — e.g. a /run build log —
    // auto-falls-back to a .md document instead of throwing on the 4096 limit.
    try { await sendTextToAdmin(token, chatId, text, { raw: false, plain: true }); } catch (e) { console.error(`[daemon] send failed: ${e?.message ?? e}`); }
  };

  let lastHeartbeat = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // 1) Co-op harvest into the shared cache (under the shared poll lock).
      if (acquirePollLock()) {
        try {
          const offset = readOffset(globalOffsetFile);
          const fetched = await fetchUpdates(token, offset);
          if (fetched.length) {
            const { nonOrphan } = partitionOrphans(fetched, groupAdminIds);
            if (nonOrphan.length) appendToCache(nonOrphan, cacheFile);
            writeOffset(Math.max(...fetched.map((u) => u.update_id)), globalOffsetFile);
            pruneCache(500, cacheFile);
          }
        } finally { releasePollLock(); }
      }

      // 2) Pick up the daemon's own lane (control DM) from the shared cache.
      const loopOffset = resolveStartOffset(daemonOffsetFile, globalOffsetFile, cacheFile);
      const updates = readCacheSinceOffset(loopOffset, cacheFile);
      const mine = updates.filter((u) => u.message && String(u.message.chat?.id) === daemonChatId);
      if (mine.length) {
        await handleControlMessages(mine, { token, daemonChatId, projectsConfig, catchAllIds, sendText });
      }
      if (updates.length) writeOffset(Math.max(...updates.map((u) => u.update_id)), daemonOffsetFile);

      // 3) Heartbeat reminders (moved here from tele-listen) — throttled.
      if (Date.now() - lastHeartbeat > HEARTBEAT_EVERY_MS) {
        lastHeartbeat = Date.now();
        try {
          const quietHours = resolveQuietHours(readProjectsConfig(PROJECTS_FILE), { env: process.env, envFile: env });
          await runHeartbeatReminders(token, groupAdminIds, { quietHours });
        } catch (e) { console.error(`[daemon] heartbeat: ${e?.message ?? e}`); }
      }
    } catch (e) {
      console.error(`[daemon] loop error: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(DAEMON_POLL_MS);
  }
}

// Dispatch the control-DM messages. Reuses tele-listen's /pending + /start
// handlers; implements /spawn and /whisper directly (non-AI).
async function handleControlMessages(mine, { token, daemonChatId, projectsConfig, catchAllIds, sendText }) {
  // /pending + /start: reuse the existing detect/dispatch (scoped to the DM).
  try {
    const { responses: pend } = detectPendingCommands(mine, [daemonChatId]);
    const { responses: start } = detectStartCommands(mine);
    const responses = [...pend, ...start];
    if (responses.length) await dispatchPendingResponses(token, responses);
  } catch (e) { console.error(`/pending|/start: ${e?.message ?? e}`); }

  for (const u of mine) {
    const msg = u.message;
    const parsed = parseDaemonCommand(msg.text);
    if (!parsed) continue;
    const from = msg.from || {};
    const ctx = { token, daemonChatId, msg, from, projectsConfig, catchAllIds, sendText };
    try {
      if (parsed.cmd === 'spawn') await cmdSpawn(parsed.rest, ctx);
      else if (parsed.cmd === 'whisper') await cmdWhisper(parsed.rest, ctx);
      else if (parsed.cmd === 'run') await cmdRun(parsed.rest, ctx);
      // /pending, /start handled above; unknown commands ignored silently.
    } catch (e) {
      await sendText(daemonChatId, `❌ /${parsed.cmd} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// `/run <project> <npm|pnpm|yarn> <args>` — cd into a sibling project and run a
// package-manager command, sending the result back to the control DM. REMOTE
// EXEC → gated to admin/maintainer (resolveSenderRole), binary whitelisted, hard
// timeout. `runner` injectable for tests.
export async function cmdRun(rest, { daemonChatId, from, projectsConfig, sendText, runner = execFileP, parentDir = PARENT_DIR }) {
  const role = resolveSenderRole(projectsConfig, from && from.id);
  if (role !== 'admin' && role !== 'maintainer') {
    await sendText(daemonChatId, `❌ /run cần quyền admin/maintainer (bạn: ${role}).`);
    return;
  }
  const a = parseRunArgs(rest);
  if (a.error) { await sendText(daemonChatId, `❌ ${a.error}`); return; }
  const r = resolveSpawnCwd(a.project, { parentDir });
  if (r.error) { await sendText(daemonChatId, `❌ ${r.error}`); return; }
  // package.json must exist and define the requested script.
  const pkg = readPackageScripts(r.cwd);
  if (pkg.error) { await sendText(daemonChatId, `❌ ${pkg.error}`); return; }
  if (!Object.prototype.hasOwnProperty.call(pkg.scripts, a.script)) {
    const avail = Object.keys(pkg.scripts);
    await sendText(daemonChatId, `❌ script "${a.script}" không có trong ${a.project}/package.json. Có: ${avail.length ? avail.join(', ') : '(không có script nào)'}`);
    return;
  }
  const pm = detectPackageManager(r.cwd);
  // argv: `<pm> run <script> -- <args>`. The `--` makes everything after it go to
  // the SCRIPT, not the package manager — so a trailing `--prefix /elsewhere` (npm)
  // / `--dir` (pnpm) / `--cwd` (yarn) can't redirect the PM out of the project cwd.
  // No `hasBinary(pm)` pre-check (it shells out): a missing PM surfaces as the
  // execFile ENOENT below, caught and reported.
  const args = a.args.length ? ['run', a.script, '--', ...a.args] : ['run', a.script];
  const label = `${a.project}: ${pm} run ${a.script}${a.args.length ? ' ' + a.args.join(' ') : ''}`;
  await sendText(daemonChatId, `▶️ ${label} …`);
  try {
    const { stdout, stderr } = await runner(pm, args, { cwd: r.cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: RUN_MAX_BUFFER });
    const out = tailOutput((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : ''));
    await sendText(daemonChatId, `✅ ${label} — exit 0\n\n${out || '(no output)'}`);
  } catch (e) {
    const body = (e.stdout || '') + (e.stderr ? `\n[stderr]\n${e.stderr}` : '') + (e.killed ? '\n[killed: timeout]' : '');
    await sendText(daemonChatId, `❌ ${label} — exit ${e.code ?? e.signal ?? '?'}\n\n${tailOutput(body) || (e.message || 'failed')}`);
  }
}

async function cmdSpawn(rest, { daemonChatId, sendText }) {
  const project = rest.split(/\s+/)[0];
  const r = resolveSpawnCwd(project);
  if (r.error) { await sendText(daemonChatId, `❌ ${r.error}`); return; }
  if (!hasBinary('claude')) { await sendText(daemonChatId, '❌ `claude` not found on PATH.'); return; }
  if (!hasBinary('screen')) { await sendText(daemonChatId, '❌ `screen` not found (needed for interactive spawn).'); return; }
  const seed = genSessionSeed();
  runSpawn(buildSpawnPlan({ interactive: true, sessionName: seed.sessionName, sessionId: seed.sessionId, seed }), { cwd: r.cwd });
  await sendText(daemonChatId, `✅ spawned agent in ${project} (${seed.sessionName}) — it will greet in its topic shortly.`);
}

async function cmdWhisper(rest, { daemonChatId, from, projectsConfig, catchAllIds, sendText }) {
  const args = parseWhisperArgs(rest);
  if (args.error) { await sendText(daemonChatId, `❌ ${args.error}`); return; }
  // Resolve #hashtag/convoId/persona → a live topic across all group chats.
  const store = readTopicsStore();
  const groupChatIds = [...new Set(catchAllIds.concat(
    projectEntries(projectsConfig).map(([, p]) => p && p.chatId).filter(Boolean).map(String),
  ))];
  const matched = matchTarget(normalizeTarget(args.target), listLiveTopics(store, groupChatIds));
  if (matched.status !== 'found') {
    await sendText(daemonChatId, `❌ target ${args.target} ${matched.status === 'ambiguous' ? 'is ambiguous' : 'not found among live topics'}.`);
    return;
  }
  const { convoId, chatId } = matched.match;
  // fromRole = the whisperer's advisory role so the target agent's sensitive-
  // action gate still applies (owner of the control DM is normally admin).
  const fromRole = resolveSenderRole(projectsConfig, from.id);
  const prompt = buildWhisperPrompt({
    targetConvoId: convoId, targetChatId: chatId,
    fromUserId: from.id, fromName: from.first_name || from.username || 'admin', fromRole,
    text: args.message,
  });
  const promptFile = path.join(DEFAULT_TMP_DIR, `prompt-convo-${convoId}.json`);
  try {
    writePromptExclusive(prompt, promptFile);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      await sendText(daemonChatId, `⚠️ #${shortConvoHash(convoId)} đang bận (prompt trước chưa xử lý) — thử lại sau.`);
      return;
    }
    throw e;
  }
  await sendText(daemonChatId, `🤫 whispered to #${shortConvoHash(convoId)} (kín, không hiện trong group).`);
}

// CLI: `node daemon.mjs` (run) | `--status` | `--stop`.
const isDirectRun = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isDirectRun) {
  const argv = process.argv.slice(2);
  if (argv.includes('--status')) {
    const s = daemonStatus();
    console.log(s.running ? `daemon running (pid ${s.pid})` : s.stale ? `daemon NOT running (stale pid ${s.pid})` : 'daemon not running');
    process.exit(s.running ? 0 : 1);
  } else if (argv.includes('--stop')) {
    const s = daemonStatus();
    if (!s.running) { console.log('daemon not running'); process.exit(0); }
    try { process.kill(s.pid, 'SIGTERM'); console.log(`sent SIGTERM to daemon (pid ${s.pid})`); } catch (e) { console.error(`stop failed: ${e?.message ?? e}`); process.exit(1); }
    process.exit(0);
  } else {
    main().catch((e) => { console.error(`[daemon] fatal: ${e instanceof Error ? e.stack : e}`); releaseSingleton(); process.exit(1); });
  }
}
