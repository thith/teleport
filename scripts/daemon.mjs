// Teleport Supervisor Daemon (Phase 1).
//
// A best-effort, manually-started, NON-AI control plane. It is the always-on
// piece that lets you steer/recover from afar even when every agent has died
// (quota/network/API). You start it before stepping away (`node daemon.mjs`), or ask
// a live agent to start it; forget to, and teleport just behaves as before.
//
// Architecture ("hợp tác xã" — cooperative harvest): the daemon polls Telegram
// getUpdates into the SAME shared per-bot updates-cache that agent `tele-listen`
// loops use, under the SAME poll lock — so daemon and agents never fight the
// global offset; whoever is awake harvests into the common cache. Each consumer
// then picks up only its own lane: agents read their topic (by message_thread_id),
// the daemon reads the OWNER's messages (by from.id === daemonUserId) — both the
// owner's private control DM and any `/dm <cmd>` typed in a group topic (RFC 08).
// Up to retrieval it is identical to an agent; only the *processing* differs — the
// daemon runs known, deterministic, non-AI commands (it never calls an LLM).
//
// Domain split (validated at startup): agents/topics live in GROUPS (chatId < 0);
// the daemon owner is a single PRIVATE user id (daemonUserId > 0). Authorization
// is by from.id (Telegram-set), not by chat — so the owner can drive the daemon
// from a group topic, while everyone else is silently ignored.
//
// Commands are REGISTRY-DRIVEN (commands.json + projects.json `_commands`, loaded
// via commands.mjs): the daemon is a thin dispatcher. It parses `/cmd [folder]
// [args]`, gates by the command's minRole, and runs `node scripts/<run>` (cwd =
// the project when needsProject, else the workspace root), passing the sender's
// identity via env (TELE_FROM_*) and relaying the script's stdout back to the DM.
// Built-ins (spawn/headless/kill/ls/run/whisper/instruct/pending/broadcast/start)
// live in teleport's own commands.json so it stays self-sufficient. Plus the
// heartbeat auto-reminder
// pass (moved here from tele-listen).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

import {
  loadEnvFromFile, parseAdminChatIds, extractBotId, sendTextToAdmin,
} from './send-telegram.mjs';
import {
  readProjectsConfig, roleFor, assertChatIdKind, projectEntries, readDefaultGroup,
  resolveDefaultChatId, resolveDaemonUserId, resolveQuietHours,
  resolveSendOnly, SEND_ONLY_LISTEN_REFUSAL,
} from './projects-config.mjs';
import {
  DEFAULT_TMP_DIR, botScopedFiles, fetchUpdates, appendToCache, readCacheSinceOffset,
  readOffset, writeOffset, resolveStartOffset, acquirePollLock, releasePollLock,
  partitionOrphans, pruneCache, runHeartbeatReminders,
  isDmControlMessage, stripDmControlPrefix,
} from './tele-listen.mjs';
import { loadCommands, resolveCommand, roleMeets, tokenizeArgs } from './commands.mjs';

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

// Hard bound on a dispatched command (remote code execution); output beyond the
// buffer cap aborts the child. Output is relayed whole — teleport's send layer
// auto-attaches a .md document when it's too long for one Telegram message.
export const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

// Resolve `<folder>` (positional first token when needsProject) to a sibling
// directory under PARENT_DIR. Returns
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
// chat must be a GROUP, and the daemon owner id must be a PRIVATE (positive) user
// id. Throws with a clear message on the first violation. Pure (config + env
// passed in).
export function validateDaemonConfig({ projectsConfig, catchAllIds, daemonUserId }) {
  if (!daemonUserId) throw new Error('Missing daemonUserId — set projects.json `_config.daemonUserId` (a positive user id).');
  assertChatIdKind(daemonUserId, 'private', 'projects.json `_config.daemonUserId`');
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
  // The secret boundary: every key teleport loads from `.env` is a secret and
  // MUST NOT leak into a dispatched child (esp. `/run`, which executes a sibling
  // project's npm script — a hostile package.json could otherwise exfiltrate
  // REPORT_BOT_TOKEN). Scripts that genuinely need a secret read it from the
  // `.env` FILE themselves (e.g. send-telegram), so stripping is always safe.
  const secretEnvKeys = [...new Set([...Object.keys(env), 'REPORT_BOT_TOKEN'])];
  const botId = extractBotId(token);
  const projectsConfig = readProjectsConfig(PROJECTS_FILE);
  const registry = loadCommands({ projectsConfig });
  // Config lives in projects.json `_config` (env only for secrets); env names
  // remain a deprecated fallback during migration.
  const daemonUserId = resolveDaemonUserId(projectsConfig, { env: process.env, envFile: env }) || '';
  const catchAllIds = parseAdminChatIds(resolveDefaultChatId(projectsConfig, { env: process.env, envFile: env }) || '');

  try {
    validateDaemonConfig({ projectsConfig, catchAllIds, daemonUserId });
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

  console.error(`[daemon] up. pid=${process.pid} bot=${botId} owner=${daemonUserId} parent=${PARENT_DIR}`);
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

      // 2) Pick up the daemon owner's lane from the shared cache. Two entry
      //    points, both gated on from.id === daemonUserId (Telegram-set, so
      //    trustworthy; an unauthorized sender is a SILENT DROP — never dispatched,
      //    never answered):
      //      • the owner's PRIVATE DM — any /command (legacy behavior; in a DM the
      //        chat id equals the user id, so this matches as before);
      //      • a GROUP topic — only `/dm <cmd>` control messages, so ordinary
      //        topic chatter from the owner is ignored (RFC 08).
      const loopOffset = resolveStartOffset(daemonOffsetFile, globalOffsetFile, cacheFile);
      const updates = readCacheSinceOffset(loopOffset, cacheFile);
      const mine = updates.filter((u) => {
        const msg = u.message;
        if (!msg || String(msg.from?.id) !== daemonUserId) return false;
        if (msg.chat?.type === 'private') return true;
        return isDmControlMessage(msg.text);
      });
      if (mine.length) {
        handleControlMessages(mine, { token, daemonUserId, projectsConfig, registry, sendText, secretEnvKeys });
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

// Dispatch the control-DM messages: each `/command` is resolved against the
// registry and run as a teleport script (non-AI). Dispatch is FIRE-AND-FORGET:
// a command runs a child process that can take seconds-to-minutes (a build, a
// graceful kill), and awaiting it here would freeze the daemon's poll + heartbeat
// for that whole time. We launch each and attach a `.catch` so a thrown dispatch
// still reports instead of becoming an unhandled rejection. (Offset is advanced
// by the caller regardless, so a slow command is never re-processed.)
export function handleControlMessages(mine, ctx) {
  for (const u of mine) {
    const msg = u.message;
    // A `/dm <cmd>` sent from a group topic is rewritten to `/<cmd>` before
    // dispatch (RFC 08); a bare `/dm` strips to null and is ignored. DM messages
    // carry no /dm prefix and pass through verbatim.
    const dispatchText = isDmControlMessage(msg.text) ? stripDmControlPrefix(msg.text) : msg.text;
    const parsed = parseDaemonCommand(dispatchText);
    if (!parsed) continue;
    // Pass the replied-to message text (if this DM is a Telegram reply) so
    // /whisper|/instruct can pick the target from a previous ack/reply instead of
    // retyping it (RFC 07/13). Fall back to `.caption`: a long agent reply is
    // auto-converted to a `.md` DOCUMENT whose text rides in `caption`, not `text`
    // — without this, replying to continue an instruct thread would find no #hash.
    const rt = msg.reply_to_message;
    dispatchCommand(parsed, msg.from || {}, ctx, rt?.text ?? rt?.caption, msg.message_id).catch((e) =>
      ctx.sendText(ctx.daemonUserId, `❌ /${parsed.cmd} failed: ${e instanceof Error ? e.message : e}`));
  }
}

// Generic registry dispatcher. Resolves `/cmd` to a command spec, gates by
// minRole, then runs `node scripts/<run> [...spec.args] [...rest]` with:
//   • cwd     = the project folder (positional first token) when needsProject,
//               else the workspace root;
//   • env     = the sender's identity (TELE_FROM_*), so the script can apply the
//               whisperer's real role to a target's sensitive-action gate, etc.;
//   • stdout  = relayed verbatim to the control DM (teleport files it if long).
// Unknown commands are ignored silently (the DM may carry non-command chatter).
// REMOTE CODE EXECUTION: the registry's minRole + resolveSpawnCwd containment are
// the gate; `runner`/`scriptsDir`/`parentDir` are injectable for tests.
export async function dispatchCommand(parsed, from, {
  daemonUserId, projectsConfig, registry, sendText, secretEnvKeys = [],
  runner = execFileP, scriptsDir = __dirname, parentDir = PARENT_DIR,
}, replyText = null, messageId = null) {
  const spec = resolveCommand(parsed.cmd, registry);
  if (!spec) return; // not a known command → stay quiet
  const role = resolveSenderRole(projectsConfig, from && from.id);
  if (!roleMeets(role, spec.minRole)) {
    await sendText(daemonUserId, `❌ /${parsed.cmd} cần quyền ${spec.minRole} (bạn: ${role}).`);
    return;
  }
  const parts = tokenizeArgs(parsed.rest); // quote-aware (`--grep "a b"` → one arg)
  let cwd = parentDir;
  let rest = parts;
  if (spec.needsProject) {
    const r = resolveSpawnCwd(parts[0], { parentDir });
    if (r.error) { await sendText(daemonUserId, `❌ ${r.error}`); return; }
    cwd = r.cwd;
    rest = parts.slice(1); // drop the folder token
  }
  const argv = [path.join(scriptsDir, spec.run), ...spec.args, ...rest];
  const env = { ...process.env };
  for (const k of secretEnvKeys) delete env[k]; // strip teleport secrets (see secret boundary in main)
  Object.assign(env, {
    TELE_FROM_ID: from && from.id != null ? String(from.id) : '',
    TELE_FROM_ROLE: role,
    TELE_FROM_NAME: (from && (from.first_name || from.username)) || 'admin',
    TELE_FROM_USERNAME: (from && from.username) || '',
    // Replied-to text (capped) — ONLY for commands that opt in (`wantsReplyText`,
    // i.e. /whisper and /instruct). Arbitrary DM reply content must NOT leak to
    // other children (esp. /run, which executes project scripts). NEVER a
    // privilege input.
    TELE_REPLY_TEXT: (spec.wantsReplyText && replyText) ? String(replyText).slice(0, 256) : '',
    // The sender's command message id — only for reply-context commands
    // (/whisper, /instruct). Lets kind-aware reply routing thread the agent's
    // reply under the sender's command in their DM. Not a privilege input.
    TELE_MESSAGE_ID: (spec.wantsReplyText && messageId != null) ? String(messageId) : '',
  });
  try {
    const { stdout, stderr } = await runner(process.execPath, argv, {
      cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER,
    });
    const out = ((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
    await sendText(daemonUserId, out || '✅ (no output)');
  } catch (e) {
    // execFile rejects on non-zero exit / timeout / ENOENT — surface the child's
    // own output (scripts print their own ❌ messages) before falling back.
    const body = ((e.stdout || '') + (e.stderr ? `\n[stderr]\n${e.stderr}` : '') + (e.killed ? '\n[killed: timeout]' : '')).trim();
    await sendText(daemonUserId, body || `❌ /${parsed.cmd} failed: ${e.message || e}`);
  }
}

// CLI: `node daemon.mjs` (run) | `--status` | `--stop`.
const isDirectRun = isMainModule(import.meta.url);
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
  } else if (resolveSendOnly(readProjectsConfig(PROJECTS_FILE))) {
    // Refused before the singleton lock / getUpdates. Exit 0 = "nothing to run
    // here by design", so a restart-on-failure supervisor doesn't loop on it.
    console.error(`[daemon] ${SEND_ONLY_LISTEN_REFUSAL}`);
    process.exit(0);
  } else {
    main().catch((e) => { console.error(`[daemon] fatal: ${e instanceof Error ? e.stack : e}`); releaseSingleton(); process.exit(1); });
  }
}
