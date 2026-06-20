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

import {
  loadEnvFromFile, parseAdminChatIds, extractBotId, sendTextChunk, shortConvoHash,
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

// Resolve `/spawn <project>` to a sibling directory under PARENT_DIR. Returns
// { cwd } or { error }. Validates the project token (no path traversal) and that
// the directory exists with a package.json (teleport's project convention).
export function resolveSpawnCwd(project, { parentDir = PARENT_DIR, statSync = fs.statSync } = {}) {
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
    try { await sendTextChunk(token, chatId, text, { raw: false, plain: true }); } catch (e) { console.error(`[daemon] send failed: ${e?.message ?? e}`); }
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
      // /pending, /start handled above; unknown commands ignored silently.
    } catch (e) {
      await sendText(daemonChatId, `❌ /${parsed.cmd} failed: ${e instanceof Error ? e.message : e}`);
    }
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
