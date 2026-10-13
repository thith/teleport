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
// live in teleport's own commands.json so it stays self-sufficient. The one
// in-process built-in is `/reload` (re-reads the registry; see reloadDaemonState). Plus the
// heartbeat auto-reminder
// pass (moved here from tele-listen).

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { execFile, execFileSync as execFileSyncD } from 'node:child_process';
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
  isDmControlMessage, stripDmControlPrefix, prLinksOnly, PR_LINK_RE,
} from './tele-listen.mjs';
export { prLinksOnly, PR_LINK_RE };
import { loadCommands, resolveCommand, roleMeets, tokenizeArgs, COMMANDS_FILE } from './commands.mjs';
import { canonicalPrUrl } from './merge.mjs';
// Workspace paths live in workspace.mjs (merge.mjs needs them too — importing
// daemon.mjs from there made a circular import that deadlocked merge.mjs).
import { PARENT_DIR, resolveSpawnCwd } from './workspace.mjs';
export { PARENT_DIR, resolveSpawnCwd };
import {
  readAutoMerge, writeAutoMerge, decideRequest, validRequest, claimRequests,
  deliverResult, auditAutoMerge, readAutoMergeState, addAutoMergeRepo, removeAutoMergeRepo, autoMergeAllowlist,
  AUTOMERGE_STATE_FILE,
} from './merge-inbox.mjs';
import { peekPersona } from './persona-store.mjs';
import { machineWatch } from './health.mjs';
import { recordFetchOk, startListenWatchdog } from './listen-watch.mjs';
import { launchCleanup, startCleanupScheduler } from './cleanup-launch.mjs';
import { processCleanupRequests, processCleanupOffers, handleCleanupButton, CLEANUP_BUTTON_RE } from './cleanup-inbox.mjs';
import { PersistentMap } from './button-store.mjs';
import { formatPersona } from './persona.mjs';
import { shortConvoHash } from './convo-hash.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');
const PROJECTS_FILE = path.join(__dirname, '..', 'projects.json');

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
export const RELOAD_COMMAND = 'reload';
export const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

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

// `/reload` (built-in, admin): re-read projects.json + the command registry so a
// new/changed commands.json entry or `_commands` override takes effect without a
// restart. It must live IN the daemon (a child script can't swap the parent's
// in-memory registry). Validates the new config first and returns { error } —
// keeping the old state — if it's invalid. The owner id and the heartbeat group
// list are startup-only: a changed daemonUserId is reported, not applied.
export function reloadDaemonState({ daemonUserId, readConfig, loadRegistry, resolveOwner, resolveCatchAll }) {
  let projectsConfig, registry;
  try {
    projectsConfig = readConfig();
    registry = loadRegistry(projectsConfig);
    if (!registry || typeof registry !== 'object' || !Object.keys(registry).length) throw new Error('command registry is empty');
    validateDaemonConfig({ projectsConfig, catchAllIds: resolveCatchAll(projectsConfig), daemonUserId });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const newOwner = resolveOwner(projectsConfig);
  const ownerChanged = newOwner != null && String(newOwner) !== String(daemonUserId);
  return { projectsConfig, registry, ownerChanged };
}

/** Parse a JSON object file or THROW (no silent `{}` fallback — see /reload). */
export function readJsonStrict(file, label = path.basename(file)) {
  let v;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${label}: ${e instanceof Error ? e.message : e}`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label}: not a JSON object`);
  return v;
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
  let projectsConfig = readProjectsConfig(PROJECTS_FILE);
  let registry = loadCommands({ projectsConfig });
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

  // Say hello to the owner on every start, so a /restartd (or a crash-restart by
  // systemd) is visible from Telegram, with the code version it came up on.
  sendText(daemonUserId, startupGreeting({ pid: process.pid, commit: gitShortHead(), commands: Object.keys(registry).length }));

  // Bot API calls for the PR-link merge buttons (sendMessage with an inline
  // keyboard, answer/edit on press). Failures are logged, never fatal.
  const tg = async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `HTTP ${res.status}`);
    return j.result;
  };
  const linkMergeUi = {
    sendButtons: (chatId, text, buttons) => tg('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [buttons] }, link_preview_options: { is_disabled: true } }),
    answerButton: (id, text) => tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {}),
    editButtonsMessage: (chatId, messageId, text) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } }).catch(() => {}),
  };
  // Pending buttons (merge previews, manual cleanups) survive a restart.
  pendingMergeButtons = new PersistentMap();
  // The Merge button pins the head commit read here (gh, without our secrets).
  const ghEnv = { ...process.env };
  for (const k of secretEnvKeys) delete ghEnv[k];
  linkMergeUi.fetchHead = (link) => defaultFetchHead(link, { env: ghEnv });

  // `/reload`: swap in a fresh registry + projects config (see reloadDaemonState).
  const reload = () => {
    const r = reloadDaemonState({
      daemonUserId,
      // STRICT readers: the normal ones swallow a JSON error into `{}`, which
      // would "successfully" wipe roles + commands (and lock out /reload itself).
      readConfig: () => readJsonStrict(PROJECTS_FILE, 'projects.json'),
      loadRegistry: (cfg) => { readJsonStrict(COMMANDS_FILE, 'commands.json'); return loadCommands({ projectsConfig: cfg }); },
      resolveOwner: (cfg) => resolveDaemonUserId(cfg, { env: process.env, envFile: env }),
      resolveCatchAll: (cfg) => parseAdminChatIds(resolveDefaultChatId(cfg, { env: process.env, envFile: env }) || ''),
    });
    if (!r.error) { projectsConfig = r.projectsConfig; registry = r.registry; }
    return r;
  };

  // RFC 18 B: "is anyone hearing Telegram?" watchdog. Its own interval, so it
  // still fires while the loop below is stuck in an await (e.g. a hung fetch).
  // Its send must THROW on failure (unlike sendText, which swallows) so a DM lost
  // during the outage is retried instead of counted as delivered.
  startListenWatchdog({ send: (t) => sendTextToAdmin(token, daemonUserId, t, { raw: false, plain: true }) });

  // RFC 18 E: daily worktree/target cleanup — launched DETACHED by its own
  // timers (never awaited here); cleanup.mjs DMs the owner its report. The very
  // first run (no state file) is a dry run.
  startCleanupScheduler({
    launch: ({ dryRun }) => {
      const childEnv = { ...process.env };
      for (const k of secretEnvKeys) delete childEnv[k];
      launchCleanup({ dryRun, env: childEnv });
    },
  });

  let lastHeartbeat = 0;
  let mergeInboxBusy = false;
  let cleanupInboxBusy = false;
  const watchState = {}; // machineWatch memory (previous agent list, last RAM alert)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // 1) Co-op harvest into the shared cache (under the shared poll lock).
      if (acquirePollLock()) {
        try {
          const offset = readOffset(globalOffsetFile);
          const fetched = await fetchUpdates(token, offset);
          recordFetchOk();
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
      const ctx = { token, daemonUserId, projectsConfig, registry, sendText, secretEnvKeys, reload, ...linkMergeUi, buttonStore: pendingMergeButtons };
      if (mine.length) handleControlMessages(mine, ctx);
      // Inline-button presses (PR-link merge confirmation) — owner only.
      const presses = updates.filter((u) => u.callback_query && String(u.callback_query.from?.id) === daemonUserId);
      for (const u of presses) {
        const handler = CLEANUP_BUTTON_RE.test(String(u.callback_query.data || '')) ? handleCleanupButton : handleMergeButton;
        handler(u.callback_query, ctx).catch((e) => console.error(`[daemon] button: ${e?.message ?? e}`));
      }
      // Agent merge requests (file inbox) — one pass at a time.
      if (!mergeInboxBusy) {
        mergeInboxBusy = true;
        processMergeRequests(ctx).catch((e) => console.error(`[daemon] merge inbox: ${e?.message ?? e}`)).finally(() => { mergeInboxBusy = false; });
      }
      // Agent cleanup requests (file inbox) — NOT awaited (git/gh/du + up to
      // ~60 s waiting for the `cleanup` lock); one pass at a time.
      if (!cleanupInboxBusy) {
        cleanupInboxBusy = true;
        processCleanupRequests(ctx, { label: requesterLabel }).then(() => processCleanupOffers(ctx)).catch((e) => console.error(`[daemon] cleanup inbox: ${e?.message ?? e}`)).finally(() => { cleanupInboxBusy = false; });
      }
      if (updates.length) writeOffset(Math.max(...updates.map((u) => u.update_id)), daemonOffsetFile);

      // 3) Heartbeat reminders (moved here from tele-listen) — throttled.
      if (Date.now() - lastHeartbeat > HEARTBEAT_EVERY_MS) {
        lastHeartbeat = Date.now();
        try {
          const quietHours = resolveQuietHours(readProjectsConfig(PROJECTS_FILE), { env: process.env, envFile: env });
          await runHeartbeatReminders(token, groupAdminIds, { quietHours });
        } catch (e) { console.error(`[daemon] heartbeat: ${e?.message ?? e}`); }
        // Machine watch: early low-RAM warning + agents that vanished (OOM-kills).
        try { await machineWatch(watchState, (t) => sendText(daemonUserId, t)); }
        catch (e) { console.error(`[daemon] machine watch: ${e?.message ?? e}`); }
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
    if (!parsed) {
      // A private message that is ONLY GitHub PR link(s) → merge preview with
      // [Merge] [Cancel] buttons (nothing is merged until the button is pressed).
      const links = msg.chat?.type === 'private' ? prLinksOnly(msg.text) : null;
      if (links) {
        handlePrLinks(links, msg, ctx).catch((e) =>
          ctx.sendText(ctx.daemonUserId, `❌ merge preview failed: ${e instanceof Error ? e.message : e}`));
      }
      continue;
    }
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

/** Short HEAD sha of the teleport checkout the daemon runs from, or null. */
export function gitShortHead(exec = execFileSyncD) {
  try { return String(exec('git', ['-C', path.join(__dirname, '..'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null; }
  catch { return null; }
}

/** The owner's "daemon is up" message. Pure. */
export function startupGreeting({ pid, commit, commands }) {
  return `🟢 Teleport daemon đã chạy · pid ${pid}${commit ? ` · code ${commit}` : ''} · ${commands} lệnh. Gõ /help để xem lệnh.`;
}

// ── Paste a PR link → preview + [✅ Merge] [✖ Cancel] ─────────────────────────

// 24 h: the owner may only see the DM hours later. Safe because the Merge
// button pins the previewed head commit (--expect-head) and merge.mjs re-runs
// every check at press time.
export const MERGE_BUTTON_TTL_MS = 24 * 60 * 60 * 1000;
export const PREVIEW_INLINE_MAX = 3500;

// token → { links, chatId, createdAt, canMerge, heads?, requester? } — also the
// manual-cleanup buttons ({ kind: 'cleanup', … }, see cleanup-inbox.mjs). A
// plain Map for tests / imports; main() swaps in a PersistentMap
// (scripts/tmp/pending-buttons.json) so a restart doesn't expire them.
// eslint-disable-next-line import/no-mutable-exports
export let pendingMergeButtons = new Map();

/** One-shot take: returns the entry (if fresh) and deletes it, so a double tap can't merge twice. */
export function takeMergeButton(tok, { now = Date.now(), store = pendingMergeButtons, ttlMs = MERGE_BUTTON_TTL_MS } = {}) {
  const e = store.get(tok);
  if (e?.kind === 'cleanup') return null; // not a merge button (cleanup-inbox takes those)
  store.delete(tok);
  for (const [k, v] of store) if (now - v.createdAt > ttlMs) store.delete(k); // sweep
  if (!e || now - e.createdAt > ttlMs) return null;
  return e;
}

/** `gh pr view` → the PR's head commit sha (or throws). */
export async function defaultFetchHead(link, { runner = execFileP, env = process.env } = {}) {
  const m = String(link).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (!m) throw new Error('not a canonical PR link');
  const { stdout } = await runner('gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'headRefOid', '-q', '.headRefOid'], { env, timeout: 60_000 });
  const sha = String(stdout).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('bad sha');
  return sha;
}

/** heads { link: sha } → '\n📌 <link> @ <sha12>' lines (shown in the button message). Pure. */
export function pinLines(heads) {
  return Object.entries(heads || {}).map(([l, sha]) => `\n📌 ${l} @ ${String(sha).slice(0, 12)}`).join('');
}

/**
 * Does the pressed message show exactly what this entry would act on? Every link
 * (and its pinned commit, when pinned) must be written in it — so a tampered
 * persisted entry can't redirect the owner's tap. Pure.
 */
export function entryMatchesMessage(entry, text) {
  const t = String(text || '');
  const heads = entry.heads || {};
  const lines = t.split('\n');
  // Whole lines / whole links: `…/pull/3` must not match a message showing `…/pull/36`.
  return (entry.links || []).length > 0 && entry.links.every((l) => (heads[l]
    ? lines.includes(`📌 ${l} @ ${String(heads[l]).slice(0, 12)}`)
    : new RegExp(`(^|\\s)${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(t)));
}

/** heads { link: sha } → ' --expect-head=owner/name#N=sha …' (canonical links only). Pure. */
export function expectHeadArgs(heads) {
  let out = '';
  for (const [link, sha] of Object.entries(heads || {})) {
    const m = String(link).match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/);
    if (m && /^[0-9a-f]{40,64}$/.test(String(sha))) out += ` --expect-head=${m[1]}#${m[2]}=${sha}`;
  }
  return out;
}

/** Child env for a dispatched script: our env minus teleport secrets, plus the sender's identity. */
function childEnv(from, role, secretEnvKeys, extra = {}) {
  const env = { ...process.env };
  for (const k of secretEnvKeys) delete env[k];
  return Object.assign(env, {
    TELE_FROM_ID: from && from.id != null ? String(from.id) : '',
    TELE_FROM_ROLE: role,
    TELE_FROM_NAME: (from && (from.first_name || from.username)) || 'admin',
    TELE_FROM_USERNAME: (from && from.username) || '',
    TELE_REPLY_TEXT: '', TELE_MESSAGE_ID: '',
  }, extra);
}

export async function handlePrLinks(links, msg, {
  daemonUserId, projectsConfig, registry, sendText, sendButtons, secretEnvKeys = [],
  runner = execFileP, scriptsDir = __dirname, parentDir = PARENT_DIR, store = pendingMergeButtons,
  requester = null, header = '', deliver = deliverResult, fetchHead = null,
}) {
  const spec = resolveCommand('merge', registry);
  if (!spec || !sendButtons) return;
  // Canonical owner/name/pull/N only — what is previewed is exactly what a button runs.
  links = [...new Set(links.map((l) => canonicalPrUrl(l)).filter(Boolean))];
  if (!links.length) return;
  // The button chooses the operation: never let a deployment arg (`--close`)
  // turn the Merge preview into a close check.
  const baseArgs = spec.args.filter((a) => a !== '--close');
  const role = resolveSenderRole(projectsConfig, msg.from && msg.from.id);
  if (!roleMeets(role, spec.minRole)) { await sendText(daemonUserId, `❌ merge cần quyền ${spec.minRole} (bạn: ${role}).`); return; }
  const run = async (extra) => {
    try {
      const r = await runner(process.execPath, [path.join(scriptsDir, spec.run), ...baseArgs, ...links, ...extra], {
        cwd: parentDir, env: childEnv(msg.from, role, secretEnvKeys), timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER,
      });
      return { ok: true, out: (r.stdout || '').trim() };
    } catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr ? `\n${e.stderr}` : '')).trim() || `❌ ${e.message || e}` }; }
  };
  // The head commit of each PR, read BEFORE the preview: the Merge button merges
  // exactly these (merge.mjs --expect-head), so a push after the preview — even
  // hours later — is refused instead of merged unseen.
  // (main() passes fetchHead; without it — tests, older callers — nothing is pinned.)
  const heads = {};
  if (fetchHead) {
    for (const l of links) {
      const h = await Promise.resolve().then(() => fetchHead(l)).catch(() => null);
      if (h) heads[l] = h;
    }
    // No pin → no button: an unpinned Merge could merge a later push unseen.
    const missing = links.filter((l) => !heads[l]);
    if (missing.length) {
      const why = `⚠️ Không đọc được commit của ${missing.join(', ')} (gh lỗi) — không gửi nút. Thử lại sau.`;
      await sendText(msg.chat.id, header ? `${header}\n\n${why}` : why);
      if (requester) await deliver({ convoId: requester.convoId, text: `${why} (gửi lại merge-request sau)`, mode: 'ask' });
      return { offered: false };
    }
  }
  const { ok: canMerge, out } = await run(['--preview']);
  // Not mergeable → maybe still closable (all open): offer only [Close] [Cancel].
  if (!canMerge && !(await run(['--close', '--preview'])).ok) {
    await sendText(msg.chat.id, header ? `${header}\n\n${out}` : out);
    // An agent's request that can't even be offered → tell the agent why.
    if (requester) await deliver({ convoId: requester.convoId, text: `Không merge/đóng được:\n${out}`, mode: 'ask' });
    return { offered: false };
  }
  const tok = crypto.randomBytes(8).toString('hex');
  store.set(tok, { links, chatId: msg.chat.id, createdAt: Date.now(), canMerge, heads, ...(requester ? { requester } : {}) });
  // Keep the button message well under Telegram's 4096 chars (status edits are
  // appended later): a long batch preview goes out first as its own message.
  const what = links.length > 1 ? `these ${links.length} PRs (in order)` : 'this PR';
  const ask = canMerge ? `Merge or close ${what}?` : `Can't merge — close ${what} without merging?`;
  const head = header ? `${header}\n\n` : '';
  // The pinned commits are part of the button message itself: a press is only
  // honoured if what it would act on is written in the message the owner saw.
  const pins = pinLines(heads);
  let body = `${head}${out}${pins}\n\n${ask}`;
  if (body.length > PREVIEW_INLINE_MAX) { await sendText(msg.chat.id, out); body = `${head}🔎 ${links.length} PR(s) ready — details above.${pins}\n\n${ask}`; }
  await sendButtons(msg.chat.id, body,
    [
      ...(canMerge ? [{ text: '✅ Merge', callback_data: `mg:${tok}` }] : []),
      { text: '🚫 Close', callback_data: `cl:${tok}` },
      { text: '✖ Huỷ', callback_data: `mc:${tok}` },
    ]);
  return { offered: true };
}

export async function handleMergeButton(cq, ctx, { take = takeMergeButton, dispatch = dispatchCommand, deliver = deliverResult, audit = auditAutoMerge } = {}) {
  const m = String(cq.data || '').match(/^(mg|cl|mc):([0-9a-f]{16})$/);
  if (!m) { await ctx.answerButton(cq.id); return; }
  const entry = take(m[2]);
  const chatId = cq.message?.chat?.id, messageId = cq.message?.message_id;
  const original = cq.message?.text || '';
  if (!entry) {
    await ctx.answerButton(cq.id, '⌛ Hết hạn hoặc đã xử lý — dán lại link.');
    if (chatId != null) await ctx.editButtonsMessage(chatId, messageId, `${original}\n\n⌛ Hết hạn.`);
    return;
  }
  if (m[1] === 'mc') {
    await ctx.answerButton(cq.id, 'Đã huỷ');
    await ctx.editButtonsMessage(chatId, messageId, `${original}\n\n✖ Đã huỷ.`);
    if (entry.requester) await deliver({ convoId: entry.requester.convoId, text: 'Owner đã huỷ — không merge, không đóng.', mode: 'ask' }).catch(() => {});
    return;
  }
  if (m[1] === 'mg' && entry.canMerge === false) { // never offered — refuse a forged press
    await ctx.answerButton(cq.id, 'Không merge được PR này.');
    return;
  }
  // Production pins every Merge (ctx.fetchHead): an entry without pins, or one
  // that doesn't match the message the owner saw, is refused.
  const unpinned = m[1] === 'mg' && ctx.fetchHead && entry.links.some((l) => !entry.heads?.[l]);
  if (unpinned || !entryMatchesMessage(entry, original)) {
    await ctx.answerButton(cq.id, 'Nút không khớp nội dung — dán lại link.');
    await ctx.editButtonsMessage(chatId, messageId, `${original}\n\n⚠️ Nút không khớp nội dung tin nhắn — không làm gì. Dán lại link / gửi lại merge-request.`);
    return;
  }
  const closing = m[1] === 'cl';
  await ctx.answerButton(cq.id, closing ? 'Đang đóng…' : 'Đang merge…');
  await ctx.editButtonsMessage(chatId, messageId, `${original}\n\n⏳ ${closing ? 'Đang đóng PR…' : 'Đang merge…'}`);
  // Same path as typing /merge <links> [--close]: registry spec, role gate, all
  // checks — but the operation is the button's: strip a deployment `--close`
  // from the spec args so Merge can never close.
  // Resolve first (merge may be an alias), then pin the resolved spec without --close.
  const resolved = resolveCommand('merge', ctx.registry);
  if (!resolved) { await ctx.answerButton(cq.id, 'merge is not configured.'); return; }
  const registry = { ...ctx.registry, merge: { ...resolved, args: resolved.args.filter((a) => a !== '--close') } };
  // For an agent's request, the result also goes back to that agent's queue.
  const sendText = entry.requester
    ? async (c, t) => {
      await ctx.sendText(c, t);
      // A batch can partly fail: only "no ❌ / ⏹ line anywhere" counts as ok.
      audit({ requester: entry.requester.convoId, links: entry.links, ok: !/^\s*(❌|⏹)/mu.test(String(t)), mode: closing ? 'button-close' : 'button-merge' });
      await deliver({ convoId: entry.requester.convoId, text: t, mode: 'ask' }).catch(() => {});
    }
    : ctx.sendText;
  await dispatch({ cmd: 'merge', rest: entry.links.join(' ') + (closing ? ' --close' : expectHeadArgs(entry.heads)) }, cq.from || {}, { ...ctx, registry, sendText });
}

// ── Agent merge requests (file inbox; see merge-request.mjs / merge-inbox.mjs) ─

export const AUTOMERGE_COMMAND = 'automerge';

/**
 * Allowlist matcher — EXPLICIT only (owner's choice): patterns in projects.json
 * `_config.autoMergeRepos` + patterns added with /automerge add. Being a
 * routing key in projects.json does NOT make a repo auto-mergeable.
 */
export function buildAllowlist(projectsConfig, { state = readAutoMergeState } = {}) {
  const cfgPatterns = Array.isArray(projectsConfig?._config?.autoMergeRepos) ? projectsConfig._config.autoMergeRepos : [];
  return autoMergeAllowlist({ configPatterns: cfgPatterns, addedPatterns: state().repos });
}

/** /automerge status text. Pure. */
export function formatAutoMergeStatus({ enabled, list }) {
  const lines = [enabled
    ? '🤖 Auto-merge: BẬT. merge-request của agent cho các repo dưới đây được merge ngay (vẫn qua mọi kiểm tra), anh nhận FYI.'
    : '✋ Auto-merge: TẮT. Mọi merge-request của agent sẽ hỏi anh bằng nút.'];
  lines.push('', 'Repo được tự merge:');
  const config = list.config || [];
  for (const p of list.patterns) {
    const tags = [p.includes('*') ? 'mẫu' : null, config.includes(p) ? 'projects.json — sửa ở đó' : null].filter(Boolean);
    lines.push(`• ${p}${tags.length ? ` (${tags.join(', ')})` : ''}`);
  }
  if (!list.patterns.length) lines.push('• (trống — mọi merge-request sẽ hỏi anh bằng nút)');
  lines.push('', '/automerge on | off · /automerge add <owner/repo | owner/*mẫu*> · /automerge remove <…>');
  return lines.join('\n');
}

/** "🪱 Giun #a7611284" for a requester convo (best effort). */
function requesterLabel(convoId) {
  const p = peekPersona(convoId);
  return `${p ? `${formatPersona(p)} ` : ''}#${shortConvoHash(convoId)}`;
}

/**
 * Handle every pending agent request once. AUTO → merge.mjs as the owner, result
 * to the agent + one-line FYI to the owner (+ audit); ASK → owner preview with
 * buttons, result to the agent after the tap. Requests are claimed atomically and
 * always removed afterwards (a malformed one is dropped with a log line).
 */
export async function processMergeRequests(ctx, {
  claim = claimRequests, autoEnabled = readAutoMerge, allowed = (cfg) => buildAllowlist(cfg),
  runner = execFileP, deliver = deliverResult, audit = auditAutoMerge, prLinks = handlePrLinks, remove = (f) => { try { fs.unlinkSync(f); } catch {} },
  scriptsDir = __dirname, label = requesterLabel,
} = {}) {
  const { daemonUserId, projectsConfig, registry, sendText, secretEnvKeys = [] } = ctx;
  for (const { file, body } of claim()) {
    try {
      const req = validRequest(body);
      if (!req) { console.error(`[daemon] dropped malformed/stale merge request ${path.basename(file)}`); continue; }
      const who = label(req.convoId);
      const spec = resolveCommand('merge', registry);
      if (!spec) { await deliver({ convoId: req.convoId, text: '❌ /merge is not configured on the daemon.', mode: 'ask' }); continue; }
      const on = autoEnabled();
      // Re-read per request (tiny JSON read): an /automerge remove that lands
      // mid-pass must apply to the very next request.
      const decision = decideRequest(req.links, { autoEnabled: on, allowed: on ? allowed(projectsConfig) : new Set() });
      if (decision.mode === 'auto') { // explicit allowlist + switch on
        const owner = { id: daemonUserId };
        const role = resolveSenderRole(projectsConfig, daemonUserId);
        let ok = true, text;
        try {
          // --skip-merged: a request retried after a crash continues past the PRs it already merged.
          const r = await runner(process.execPath, [path.join(scriptsDir, spec.run), ...spec.args.filter((a) => a !== '--close'), ...req.links, '--skip-merged'], {
            cwd: ctx.parentDir ?? PARENT_DIR, env: childEnv(owner, role, secretEnvKeys), timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER,
          });
          text = (r.stdout || '').trim();
        } catch (e) { ok = false; text = ((e.stdout || '') + (e.stderr ? `\n${e.stderr}` : '')).trim() || `❌ ${e.message || e}`; }
        audit({ requester: req.convoId, links: req.links, ok, mode: 'auto' });
        await sendText(daemonUserId, `🤖 Tự merge theo yêu cầu của ${who}:\n\n${text}`);
        try { await deliver({ convoId: req.convoId, text, mode: 'auto' }); }
        catch (e) { await sendText(daemonUserId, `⚠️ Không gửi được kết quả về ${who}: ${e?.message ?? e}`); }
      } else {
        try {
          await prLinks(req.links, { chat: { id: daemonUserId }, from: { id: daemonUserId } },
            { ...ctx, requester: { convoId: req.convoId, label: who }, header: `📨 ${who} xin merge (${decision.reason}):`, deliver });
        } catch (e) {
          // Couldn't reach the owner (Telegram error) → the agent must not wait forever.
          await deliver({ convoId: req.convoId, text: `⚠️ Không gửi được yêu cầu tới owner (${e?.message ?? e}) — thử merge-request lại sau.`, mode: 'ask' }).catch(() => {});
        }
      }
    } catch (e) {
      console.error(`[daemon] merge request ${path.basename(file)}: ${e?.message ?? e}`);
    } finally {
      remove(file);
    }
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
  runner = execFileP, scriptsDir = __dirname, parentDir = PARENT_DIR, reload = null,
  automergeStateFile = AUTOMERGE_STATE_FILE,
}, replyText = null, messageId = null) {
  // Built-in: handled in-process, never via the registry (a `_commands` entry
  // named `reload` can't shadow it). Admin-only.
  if (parsed.cmd === AUTOMERGE_COMMAND) {
    const role = resolveSenderRole(projectsConfig, from && from.id);
    if (!roleMeets(role, 'admin')) { await sendText(daemonUserId, `❌ /${AUTOMERGE_COMMAND} cần quyền admin (bạn: ${role}).`); return; }
    const usage = `usage: /${AUTOMERGE_COMMAND} on | off | status | add <owner/repo | owner/*pattern*> | remove <…>`;
    const toks = tokenizeArgs(parsed.rest);
    const op = (toks[0] || 'status').toLowerCase();
    const f = automergeStateFile;
    const wantsTarget = op === 'add' || op === 'remove';
    // Exactly the expected arguments: a stray token is an error, never silently ignored.
    if (toks.length > (wantsTarget ? 2 : 1) || (wantsTarget && toks.length < 2)) { await sendText(daemonUserId, usage); return; }
    if (op === 'on' || op === 'off') writeAutoMerge(op === 'on', f);
    else if (wantsTarget) {
      const r = op === 'add' ? addAutoMergeRepo(toks[1], f) : removeAutoMergeRepo(toks[1], f);
      if (r.error) { await sendText(daemonUserId, `❌ ${r.error}`); return; }
    } else if (op !== 'status') { await sendText(daemonUserId, usage); return; }
    await sendText(daemonUserId, formatAutoMergeStatus({ enabled: readAutoMerge(f), list: buildAllowlist(projectsConfig, { state: () => readAutoMergeState(f) }) }));
    return;
  }
  if (parsed.cmd === RELOAD_COMMAND && reload) {
    const role = resolveSenderRole(projectsConfig, from && from.id);
    if (!roleMeets(role, 'admin')) { await sendText(daemonUserId, `❌ /${RELOAD_COMMAND} cần quyền admin (bạn: ${role}).`); return; }
    const r = reload();
    if (r.error) { await sendText(daemonUserId, `❌ /${RELOAD_COMMAND}: config lỗi, giữ cấu hình cũ — ${r.error}`); return; }
    const n = Object.keys(r.registry).length;
    await sendText(daemonUserId, `🔄 Đã đọc lại commands.json + projects.json (${n} lệnh).`
      + (r.ownerChanged ? '\n⚠️ daemonUserId đã đổi trong projects.json — chỉ có hiệu lực sau khi restart daemon.' : ''));
    return;
  }
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
