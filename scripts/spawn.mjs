#!/usr/bin/env node
// Spawn a new agent instance that reports to Telegram (RFC 03).
//
// Two modes:
//   interactive (--interactive): `screen -dmS <name> claude "<prompt>"` — a real
//     INTERACTIVE Claude session in a detached `screen` pty. Bills against the
//     normal subscription (NOT the Agent SDK pool). Persists until killed.
//   headless (default):          detached `claude -p "<prompt>"` — non-interactive,
//     fire-and-forget, auto-exits when done. Bills against the Agent SDK pool;
//     use only for true automation/workflow runs.
//
// The prompt is HARD-CODED: the new instance onboards by locating + reading
// process.md + review-guide.md IF PRESENT (path varies per project — e.g. root
// or guides/, so the agent finds them itself, no hard-coded path; "if present"
// so a project lacking them just skips ahead), then "Telegram me and wait" — and
// you give it work over Telegram (it gets its own persona topic via RFC 01/02,
// and resolves its group from the cwd it's spawned in via RFC 02).
//
// Permission mode: every spawn passes an EXPLICIT `--permission-mode` to claude,
// default `auto` (the new autonomous mode). Override with
//   --mode <default|auto|acceptEdits|bypassPermissions|dontAsk|plan>
// (also accepts `--mode=<value>`).
//
// Verbal convention (telegram-guide): "spawn Claude" → pnpm spawn:i (interactive);
// "spawn Claude headless" → pnpm spawn:headless.
//
// Run `node spawn.mjs --help` (or `-h`) for the full flag reference (see USAGE).

import { spawn as cpSpawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { formatPersona } from './persona.mjs';
import { peekPersona } from './persona-store.mjs';
import {
  listClaudeProcs, findProcForSession, findUnidentifiedProcs, cwdToProjectSlug, PROJECTS_DIR,
  formatAgentList, parseKillPidArg, killClaudePid, KILL_PID_GRACE_MS, inspectPid,
} from './claude-procs.mjs';
import { readProjectsConfig, resolveDaemonUserId } from './projects-config.mjs';

export const SPAWN_PROMPT = 'Find and read process.md and review-guide.md if present in this project, then Telegram me and wait for instructions';

// Claude CLI `--permission-mode` choices (verified on claude 2.1.186). A spawn
// ALWAYS sets one — defaulting to `auto`, the new autonomous mode (NOT the old
// blanket auto-accept `acceptEdits`/`bypassPermissions`), so a Telegram-driven
// agent can act without prompting for every permission. Override via `--mode`.
// Seed for `--resume-session`: the resumed agent already has its whole context
// (persona, convo, task) — it only lost its Telegram listener when the old
// process died. So: re-arm the listener FIRST (with --first-run so a prompt left
// claimed by the dead life is re-surfaced), then work the queue.
export const RESUME_PROMPT = 'You were just restarted by teleport: your previous process was stopped and this same session was resumed in a screen (spawn --resume-session / daemon /kill pid:<PID> --restart). Do these now, in order: 1) check your mailbox: node ../teleport/scripts/mailbox.mjs check (read it if there is mail); 2) re-arm your Telegram Monitor listener for your existing convo: re-read ../teleport/rules/telegram-guide.md section "Listening for replies" and use the canonical command (it passes --first-run on its first poll so anything left pending is re-surfaced); 3) send a short greeting in your Telegram topic saying you are back online, then handle whatever is queued.';

export const PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan'];
export const DEFAULT_PERMISSION_MODE = 'auto';

export const KILL_GRACE_MS = 10_000;

// `--help` / `-h` text. Printed to STDOUT and exit 0 (a REQUESTED help is not an
// error — unlike the sibling scripts' `USAGE`-to-stderr-on-misuse convention).
// Kept in sync with the header comment and the flags handled in the direct-run
// block below; the spawn.test.mjs "USAGE documents…" test guards that drift.
export const USAGE = `spawn.mjs — spawn a new agent instance that reports to Telegram (RFC 03).

Usage:
  node spawn.mjs [-i|--interactive] [--mode <mode>]   spawn an agent (headless by default)
  node spawn.mjs --resume-session <uuid> [--hashtag <h>] [--mode <mode>]
                                                      resume an existing Claude session in a screen
  node spawn.mjs --list | --ls                        list running agent sessions
  node spawn.mjs --attach|--resume [<id>]             re-attach your terminal to a session
  node spawn.mjs --kill|--quit <id>                   gracefully tear a session down
  node spawn.mjs --kill pid:<PID>|name:<name> [--restart]
                                                      SIGTERM one claude process (daemon owner only);
                                                      --restart then resumes its session in a screen
  node spawn.mjs --help | -h                          show this help

Spawn modes:
  (default)          headless: detached \`claude -p\` — fire-and-forget, auto-exits.
                     Bills the Agent SDK pool. Use for true automation only.
  -i, --interactive  a real interactive Claude session in a detached \`screen\`.
                     Bills the normal subscription. Persists until killed.
  --mode <mode>      permission mode for the spawned agent (also --mode=<mode>).
                     One of: ${PERMISSION_MODES.join(', ')}. Default: ${DEFAULT_PERMISSION_MODE}.

Resume (interactive/screen; for a hand-opened session whose listener died):
  --resume-session <uuid>  \`claude --resume <uuid>\` in screen \`tele-<hashtag>\` (hashtag
                     derived from the uuid). Refuses while a live claude process
                     still holds that session (stop it first: daemon /kill pid:<PID>)
                     or when the transcript isn't in this project folder.
  --hashtag <h>      optional cross-check: must equal the uuid's hashtag.
                     NB: \`--resume\` (no suffix) is the --attach alias, not this.

Manage sessions (interactive/screen only):
  --list, --ls       show running \`tele-*\` sessions with persona, pid, and topic,
                     then EVERY claude process of this user (pid, cwd, tty, uptime,
                     screen or terminal, session id + #hashtag) — incl. hand-opened ones.
  --attach [<id>]    re-attach; <id> = 3-char tail (116), #hashtag, or tele-name.
    (--resume)       Omit <id> when exactly one session is live. Detach: Ctrl-A D.
  --kill <id>        send /exit, wait up to ${KILL_GRACE_MS / 1000}s, then force-quit.
    (--quit)         Needs the FULL hashtag (no shortcuts — it's destructive).
  --kill name:<name> same, picking the process by its session name or Telegram persona
                     (full name, emoji/case ignored; must match exactly one — see --list).
  --kill pid:<PID>   SIGTERM a \`claude\` process of this user, wait up to ${KILL_PID_GRACE_MS / 1000}s,
                     never SIGKILL. Only via the daemon, only for its owner
                     (TELE_FROM_ID must equal projects.json _config.daemonUserId);
                     audited to scripts/tmp/kill-pid-audit.jsonl.
    --restart        after it exits, resume the same session in screen tele-<hashtag>
                     in its old cwd (= --resume-session). Needs a session id known
                     from its session file — checked BEFORE killing.

The prompt is HARD-CODED ("${SPAWN_PROMPT}"): the new
instance greets you in its own Telegram persona topic and waits for work there.

Verbal convention (telegram-guide): "spawn Claude" → pnpm spawn:i (interactive);
"spawn Claude headless" → pnpm spawn:headless.`;

// Session names must be shell/argv-safe — they're interpolated into the printed
// teardown command and passed to `screen`. Reject anything else (review C-Minor).
export const SAFE_SESSION_NAME = /^[A-Za-z0-9_.-]+$/;
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Derive a spawn seed (RFC 03): a real UUID we FORCE onto the child via
 * `claude --session-id`, plus the screen name built from the convo hashtag that
 * UUID will yield. The child computes its own convoId as
 * `uuidToConvoInt(CLAUDE_CODE_SESSION_ID)`, so naming the screen `tele-<hashtag>`
 * makes `screen -ls` line up EXACTLY with the `#<hashtag>` the agent shows in its
 * Telegram topic + every message — no more opaque random `tele-9a4bcab622a9`.
 * `genUuid` is injectable for tests.
 */
export function genSessionSeed(genUuid = () => crypto.randomUUID()) {
  for (let i = 0; i < 16; i++) {
    const sessionId = genUuid();
    const convoId = uuidToConvoInt(sessionId); // null only if first 13 hex ≤ 0 (≈impossible)
    if (convoId == null) continue;
    return { sessionId, convoId, sessionName: `tele-${shortConvoHash(convoId)}` };
  }
  throw new Error('spawn: failed to derive a valid session seed (uuid → convoId)');
}

/**
 * Pure: compute the launch plan. No side effects, so it's unit-testable.
 * Returns `{ mode, sessionName, command: [...], teardown }`.
 */
export function buildSpawnPlan({ interactive = false, sessionName, sessionId, seed, prompt, permissionMode = DEFAULT_PERMISSION_MODE, resumeSessionId } = {}) {
  // Every spawn is launched with an EXPLICIT `--permission-mode` (never left to
  // the CLI default) so the agent's autonomy is deliberate, not incidental.
  if (!PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`spawn: invalid permission mode ${JSON.stringify(permissionMode)} (allowed: ${PERMISSION_MODES.join(', ')})`);
  }
  if (resumeSessionId != null) {
    // Resume is always interactive (screen): the session's convoId — hence its
    // hashtag, persona and topic — is derived from the UUID, and `claude --resume`
    // keeps that UUID, so the screen name lines up with the agent's #hashtag.
    if (!UUID_RE.test(resumeSessionId)) {
      throw new Error(`spawn: invalid --resume-session ${JSON.stringify(resumeSessionId)} (must be a UUID)`);
    }
    const convoId = uuidToConvoInt(resumeSessionId);
    if (convoId == null) throw new Error(`spawn: cannot derive a hashtag from ${resumeSessionId}`);
    const name = `tele-${shortConvoHash(convoId)}`;
    return {
      mode: 'interactive',
      sessionName: name,
      sessionId: resumeSessionId,
      resumed: true,
      command: ['screen', '-U', '-dmS', name, 'claude', '--permission-mode', permissionMode, '--resume', resumeSessionId, prompt ?? RESUME_PROMPT],
      teardown: `screen -S ${name} -X quit`,
    };
  }
  prompt ??= SPAWN_PROMPT;
  if (interactive) {
    // Auto path: derive name + forced session-id from a seed so the screen name
    // matches the Telegram hashtag. Explicit `sessionName` (power-user override)
    // skips seeding → no forced --session-id, name as given.
    let name = sessionName;
    // A `seed` is an atomic name+UUID pair (the screen name IS the hashtag of the
    // UUID). If an explicit `sessionName` overrides the name, the seed's UUID must
    // be DROPPED too — forcing it would make the screen name disagree with the
    // child's hashtag, breaking the very invariant this feature exists for. An
    // explicit standalone `sessionId` is a deliberate advanced override → honored.
    let sid = sessionId ?? null;
    if (!name) {
      const s = seed || genSessionSeed();
      name = s.sessionName;
      sid = s.sessionId;
    }
    if (!SAFE_SESSION_NAME.test(name)) {
      throw new Error(`spawn: unsafe session name ${JSON.stringify(name)} (allowed: A-Za-z0-9_.-)`);
    }
    if (sid != null && !UUID_RE.test(sid)) {
      throw new Error(`spawn: invalid session id ${JSON.stringify(sid)} (must be a UUID)`);
    }
    // `screen -dmS` starts a DETACHED session running an interactive `claude`
    // seeded with the positional prompt → interactive (subscription) billing.
    // `--session-id` forces the session UUID so the child's convoId/persona/topic
    // are predictable from the parent (and the screen name matches the hashtag).
    // `--permission-mode` is always present (works alongside the positional prompt).
    const claudeArgs = sid != null
      ? ['claude', '--permission-mode', permissionMode, '--session-id', sid, prompt]
      : ['claude', '--permission-mode', permissionMode, prompt];
    return {
      mode: 'interactive',
      sessionName: name,
      sessionId: sid,
      // `-U` forces screen into UTF-8 mode so the child TUI's multibyte output
      // (e.g. Vietnamese) renders correctly; without it screen inherits whatever
      // the spawn-time locale was and garbles non-ASCII on attach.
      command: ['screen', '-U', '-dmS', name, ...claudeArgs],
      teardown: `screen -S ${name} -X quit`,
    };
  }
  return {
    mode: 'headless',
    sessionName: null,
    // `--permission-mode` also set on the headless (`-p`, SDK-pool) path. NB:
    // `auto` lets a headless agent run tools autonomously with no human watching a
    // screen session — that's the point of fire-and-forget automation, but it also
    // means a runaway loop bills the SDK pool unattended. Override with `--mode` for
    // a more conservative posture (e.g. `plan`) when that risk isn't wanted.
    command: ['claude', '--permission-mode', permissionMode, '-p', prompt], // launched detached below; auto-exits
    teardown: null,
  };
}

/**
 * True if `bin` is on PATH. Runs `command -v` THROUGH a shell (`command` is a
 * POSIX shell builtin, not an executable — invoking it directly only works on
 * macOS and false-negatives on Linux/minimal images; review S-Major). `sh` is
 * universally present. `exec` is injectable for tests.
 */
export function hasBinary(bin, exec = execFileSync) {
  try {
    exec('/bin/sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort check that a `screen` session named `name` exists. `screen -ls`
 * may exit non-zero depending on state, so we read its output regardless. Used
 * to VERIFY an interactive spawn actually created the session before claiming
 * success (review C-Major). `exec` injectable for tests.
 */
export function screenSessionExists(name, exec = execFileSync) {
  let out = '';
  try { out = String(exec('screen', ['-ls'], { encoding: 'utf8' })); }
  catch (e) { out = String(e?.stdout ?? ''); }
  // screen lists sessions as "<pid>.<name>\t(...)"; anchor on the "<digits>."
  // PID boundary so a name that is merely a SUFFIX of another session's name
  // (e.g. "bot" vs "1234.my.bot") doesn't false-match (review G-Major).
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)\\d+\\.${esc}(\\s|$)`, 'm').test(out);
}

/**
 * Normalize a user-supplied session id into a screen session name (RFC 03):
 *   - strip a leading `#` (so the Telegram hashtag `#d1331668` works verbatim)
 *   - prepend `tele-` if absent (so the bare hashtag `d1331668` works too)
 * Throws on anything that isn't shell/argv-safe afterwards (the name is passed
 * to `screen -S` and printed). Pure → unit-testable.
 */
export function normalizeSessionName(raw) {
  let id = String(raw ?? '').trim();
  if (id.startsWith('#')) id = id.slice(1);
  if (!id.startsWith('tele-')) id = `tele-${id}`;
  if (id === 'tele-' || !SAFE_SESSION_NAME.test(id)) {
    throw new Error(`spawn: invalid session id ${JSON.stringify(raw)} → ${JSON.stringify(id)} (allowed: A-Za-z0-9_.-)`);
  }
  return id;
}

/**
 * Parse `screen -ls` output into our spawned sessions (`tele-*` only). Pure.
 * Anchors to screen's full row shape `<ws><pid>.<name><ws>(<state>)` so a stray
 * `digits.tele-` substring mid-line, or a `pid.other.tele-x` name, can't be
 * mis-captured (review B). Header/footer/"No Sockets" lines lack a pid.tele- token
 * and a trailing `(state)`, so anchoring drops zero real sessions.
 */
export function parseScreenSessions(lsOut) {
  const sessions = [];
  for (const line of String(lsOut).split('\n')) {
    const m = line.match(/^\s*(\d+)\.(tele-[A-Za-z0-9_.-]+)\s+\(/);
    if (m) sessions.push({ pid: m[1], name: m[2] });
  }
  return sessions;
}

/** List our spawned screen sessions. `exec` injectable for tests. */
export function listSpawnSessions(exec = execFileSync) {
  let out = '';
  try { out = String(exec('screen', ['-ls'], { encoding: 'utf8' })); }
  catch (e) { out = String(e?.stdout ?? ''); } // screen -ls can exit non-zero
  return parseScreenSessions(out);
}

/**
 * Build `{ <hashtag>: persona }` from the topics store so `--list` can show the
 * persona name beside each `tele-<hashtag>` session ("kill Cú" → which hashtag).
 * The screen name carries only the (lossy) hashtag, so persona — which is
 * derived from the convoId — must be recovered via the convoId keys in
 * topics.json: `shortConvoHash(convoId)` is the same hashtag the session is named
 * after. A session with no topic yet (hasn't sent its first message) won't be in
 * the map → printed without a persona. `store` injectable for tests.
 */
export function personaByHashtag(store = readTopicsStore()) {
  const map = {};
  for (const entry of Object.values(store || {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const key of Object.keys(entry)) {
      if (key.startsWith('_')) continue;
      map[shortConvoHash(key)] = peekPersona(key);
    }
  }
  return map;
}

/**
 * Graceful teardown of an interactive (screen) agent: first ask claude to quit
 * cleanly via its own `/exit`, wait up to `graceMs`, and only force-`quit` if it's
 * still "stubborn".
 *
 * The `/exit` is typed via `screen -X stuff`, which injects the keystrokes
 * wherever claude's input cursor currently is — it is NOT conditionally delivered
 * only to an idle prompt. If claude is at the REPL it exits cleanly (softer than
 * the SIGHUP of `screen -X quit`); if it's mid-task the keys buffer (or land in a
 * sub-prompt) and `/exit` may not take effect — which is exactly why we wait then
 * force-`quit`. So `/exit` is best-effort, the hard quit is the guarantee.
 *
 * Returns `{ method, killed }`:
 * - `method: 'exit'` — gone on its own within grace (attributed to `/exit`).
 * - `method: 'quit'` — needed the hard fallback; `killed` = whether it's gone.
 * `exec`/`sleep`/`sessionExists` injectable for tests (no real screen / clock).
 */
export async function gracefulKill(name, {
  exec = execFileSync,
  sleep = sleepMs,
  sessionExists = (n) => screenSessionExists(n, exec),
  graceMs = KILL_GRACE_MS,
  pollMs = 500,
} = {}) {
  // 1. Polite: type "/exit\r" into the REPL (CR = Enter; passed as one argv
  //    element via execFileSync, no shell, so the literal CR is safe). If it
  //    can't even be DELIVERED (screen unreachable), there's nothing to wait for
  //    → skip the grace poll, go straight to the hard quit (don't hang 10s).
  let politeSent = false;
  try { exec('screen', ['-S', name, '-X', 'stuff', '/exit\r'], { stdio: 'ignore' }); politeSent = true; } catch { /* skip poll */ }
  // 2. Poll for it to disappear on its own, up to graceMs. Check BEFORE sleeping
  //    (already-gone returns with no delay), and clamp the sleep so a pollMs that
  //    doesn't divide graceMs can't overshoot the grace window.
  if (politeSent) {
    for (let waited = 0; waited < graceMs; waited += pollMs) {
      if (!sessionExists(name)) return { method: 'exit', killed: true };
      await sleep(Math.min(pollMs, graceMs - waited));
    }
    if (!sessionExists(name)) return { method: 'exit', killed: true }; // final check at t=graceMs
  }
  // 3. Still there (or polite undelivered) → hard quit (SIGHUP teardown), then
  //    re-verify a few times: a loaded box can take >300ms to reap the session,
  //    and a single check would false-report killed:false.
  try { exec('screen', ['-S', name, '-X', 'quit'], { stdio: 'ignore' }); } catch { /* re-check decides */ }
  for (let i = 0; i < 3; i++) {
    await sleep(300);
    if (!sessionExists(name)) return { method: 'quit', killed: true };
  }
  return { method: 'quit', killed: false };
}

/**
 * Resolve the `--kill <id>` target from argv. Pure → unit-testable.
 * Returns `{ found, raw }`: `found` = a --kill/--quit flag is present; `raw` = the
 * id token, or null when it's missing or flag-looking (a `-`-prefixed next token
 * means the id was omitted, e.g. `--kill -i` / `--kill --list`).
 */
export function resolveKillId(argv) {
  const i = argv.findIndex((a) => a === '--kill' || a === '--quit');
  if (i === -1) return { found: false, raw: null };
  const raw = argv[i + 1];
  return { found: true, raw: !raw || raw.startsWith('-') ? null : raw };
}

/**
 * Resolve the `--attach <id>` target from argv. Same shape/semantics as
 * resolveKillId (the id may be missing or a flag-looking token). Pure → testable.
 */
export function resolveAttachId(argv) {
  const i = argv.findIndex((a) => a === '--attach' || a === '--resume');
  if (i === -1) return { found: false, raw: null };
  const raw = argv[i + 1];
  return { found: true, raw: !raw || raw.startsWith('-') ? null : raw };
}

// The hashtag of a `tele-<hashtag>` session, lowercased (for suffix matching).
const sessHashtag = (s) => String(s.name).replace(/^tele-/, '').toLowerCase();
/** Render a session list as `#c8630116, #t1234` for error/help output. */
export function formatSessionList(sessions) {
  return sessions.map((s) => `#${sessHashtag(s)}`).join(', ');
}

/**
 * Resolve `--attach <raw>` against the LIVE sessions (convenience, RFC 03 follow-up):
 *  1. NO id → attach iff exactly ONE session is live ("nếu chỉ có 1 thì bỏ qua ID").
 *     With ≥2 → require an id.
 *  2. `raw` is exactly 3 chars → an EXACT hashtag wins, else match the hashtag TAIL
 *     (`116` → `tele-c8630116`). 0 → not-found, 1 → attach, ≥2 → ambiguous (list).
 *  3. Otherwise → the full form (bare hashtag / `#hashtag` / `tele-name`), which must
 *     exist among the live sessions (case-insensitive).
 * A *given* id is always validated — a wrong id never silently attaches to the lone
 * survivor. Pure → testable. Returns `{ ok, name }` or `{ error }`.
 */
export function resolveAttachTarget(raw, sessions) {
  if (!sessions.length) return { error: 'no live agent sessions (try: spawn.mjs --list).' };
  const id = raw == null ? '' : String(raw).trim().replace(/^#/, '');

  // (1) NO id → attach iff exactly one session is live (the "nếu chỉ 1 thì bỏ qua
  //     ID" case). With ≥2, require an id. A *given* id is always validated below —
  //     a wrong id never silently lands you in the lone survivor.
  if (!id) {
    if (sessions.length === 1) return { ok: true, name: sessions[0].name };
    return { error: `${sessions.length} live sessions — give an id (3-char tail or #hashtag): ${formatSessionList(sessions)}` };
  }
  const lid = id.toLowerCase();

  // (2) 3-char shorthand: an EXACT hashtag wins (e.g. Gemini `t12`), else match the
  //     hashtag TAIL (`116` → `tele-c8630116`). ≥2 tail matches → ambiguous.
  if (/^[A-Za-z0-9]{3}$/.test(id)) {
    const exact = sessions.find((s) => sessHashtag(s) === lid);
    if (exact) return { ok: true, name: exact.name };
    const hits = sessions.filter((s) => sessHashtag(s).endsWith(lid));
    if (hits.length === 0) return { error: `no session matching "${id}". live: ${formatSessionList(sessions)}` };
    if (hits.length > 1) return { error: `"${id}" matches ${hits.length} sessions (${formatSessionList(hits)}) — use the full #hashtag.` };
    return { ok: true, name: hits[0].name };
  }

  // (3) full form (bare / #/ tele- hashtag) → must exist among live sessions (case-insensitive).
  let name;
  try { name = normalizeSessionName(id); } catch (e) { return { error: e.message }; }
  const hit = sessions.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!hit) return { error: `no live session "${name}". live: ${formatSessionList(sessions)}` };
  return { ok: true, name: hit.name };
}

/**
 * Resolve the `--mode <permissionMode>` override from argv. Pure → testable.
 * - Absent → `DEFAULT_PERMISSION_MODE` ('auto').
 * - Present with a missing/flag-looking value → `null` (caller errors out).
 * - Present with a value → that string verbatim (caller validates against
 *   PERMISSION_MODES so an unknown mode gets a clear message, not a deep throw).
 */
export function resolveMode(argv) {
  // Accept BOTH `--mode <value>` and `--mode=<value>`. The whole point is to never
  // SILENTLY fall back to the `auto` default when the user tried to set a mode —
  // that would over-grant autonomy (a quiet footgun). So:
  //  - 0 occurrences → the `auto` default.
  //  - exactly 1 → parse it (`--mode=` with empty value → null so caller errors).
  //  - >1 (e.g. `--mode plan --mode=auto`) → ambiguous → null; refuse to arbitrarily
  //    pick one rather than risk choosing the more-autonomous mode by accident.
  const hits = argv.filter((a) => a === '--mode' || a.startsWith('--mode='));
  if (hits.length === 0) return DEFAULT_PERMISSION_MODE;
  if (hits.length > 1) return null;
  const h = hits[0];
  if (h.startsWith('--mode=')) {
    const v = h.slice('--mode='.length);
    return v === '' ? null : v;
  }
  const raw = argv[argv.indexOf('--mode') + 1];
  return (!raw || raw.startsWith('-')) ? null : raw;
}

/**
 * Resolve `--resume-session <uuid>` and the optional `--hashtag <h>` from argv.
 * Pure → testable. Returns:
 *   { found: false }                       — no --resume-session flag
 *   { found: true, error }                 — missing/invalid value, or hashtag mismatch
 *   { found: true, sessionId, hashtag }    — hashtag = the one derived from the uuid
 * `--hashtag` accepts `a7611284`, `#a7611284` or `tele-a7611284`; it is a typo
 * guard (a wrong uuid would resume the wrong agent), never a rename.
 */
export function resolveResumeSession(argv) {
  const value = (flag) => {
    const hits = argv.filter((a) => a === flag || a.startsWith(`${flag}=`));
    if (hits.length === 0) return { present: false };
    if (hits.length > 1) return { present: true, raw: null };
    if (hits[0].startsWith(`${flag}=`)) return { present: true, raw: hits[0].slice(flag.length + 1) || null };
    const raw = argv[argv.indexOf(flag) + 1];
    return { present: true, raw: !raw || raw.startsWith('-') ? null : raw };
  };
  const rs = value('--resume-session');
  if (!rs.present) return { found: false };
  if (!rs.raw) return { found: true, error: '--resume-session needs exactly one session UUID.' };
  if (!UUID_RE.test(rs.raw)) return { found: true, error: `--resume-session: not a UUID: ${JSON.stringify(rs.raw)}` };
  const convoId = uuidToConvoInt(rs.raw);
  const hashtag = convoId == null ? null : shortConvoHash(convoId);
  if (!hashtag) return { found: true, error: `--resume-session: cannot derive a hashtag from ${rs.raw}` };
  const ht = value('--hashtag');
  if (ht.present) {
    if (!ht.raw) return { found: true, error: '--hashtag needs exactly one value.' };
    const given = ht.raw.trim().replace(/^#/, '').replace(/^tele-/, '').toLowerCase();
    if (given !== hashtag.toLowerCase()) {
      return { found: true, error: `--hashtag #${given} does not match session ${rs.raw} (its hashtag is #${hashtag}) — check the session id.` };
    }
  }
  return { found: true, sessionId: rs.raw, hashtag };
}

/**
 * Preflight for a resume, all inputs injected. Refuses (returns { error }) when:
 *  - a live claude process still holds the session (two processes appending to
 *    one transcript = corruption; stop it first with the daemon's /kill pid:);
 *  - a screen with the target name already exists;
 *  - the transcript isn't in THIS project's folder (`claude --resume <id>` looks
 *    in the cwd's project dir) — names the project it IS in when found elsewhere.
 * `procs` = listClaudeProcs() rows; `transcriptDirs` = project-dir names that
 * contain `<sessionId>.jsonl`.
 */
export function checkResumePreflight({ sessionId, sessionName, cwd, procs, procsError = null, screenExists, transcriptDirs }) {
  // Unknown is not "nothing running": a failed process scan refuses.
  if (procsError || !Array.isArray(procs)) return { error: `cannot verify no live process holds the session (${procsError || 'no process list'}) — refusing.` };
  const holder = findProcForSession(sessionId, procs);
  if (holder) {
    return { error: `session ${sessionId} is still held by live claude PID ${holder.pid}${holder.guessed ? ' (guessed from its newest transcript)' : ''}${holder.cwd ? ` in ${holder.cwd}` : ''}. Stop it first (owner: /kill pid:${holder.pid}), then resume.` };
  }
  const unknown = findUnidentifiedProcs(cwd, procs);
  if (unknown.length) {
    return { error: `live claude process(es) ${unknown.map((r) => `PID ${r.pid}`).join(', ')} in ${cwd} have no session file, so they might hold this session — check /ls; stop them (/kill pid:<PID>) if they do.` };
  }
  if (screenExists) return { error: `a screen session "${sessionName}" already exists (try: spawn.mjs --attach ${sessionName}).` };
  const slug = cwdToProjectSlug(cwd);
  if (!transcriptDirs.includes(slug)) {
    if (transcriptDirs.length) return { error: `session ${sessionId} belongs to another folder (${transcriptDirs.join(', ')}), not ${cwd} — resume it from that project.` };
    return { error: `no transcript for session ${sessionId} under ~/.claude/projects/ — wrong id?` };
  }
  return { ok: true };
}

/**
 * Resume lock (async). On Linux it is KERNEL-backed: listening on an
 * abstract-namespace unix socket `\0teleport-resume-<uuid>` succeeds for exactly
 * one process and is released by the kernel when that process exits — however it
 * exits — so there are no stale locks and no takeover races. Elsewhere (macOS)
 * it falls back to the file lock below.
 *
 * A launch that never showed up can't be proven dead (screen forks its server),
 * so performResume calls `markFailed()`: a cooldown marker that makes the next
 * acquire refuse for `cooldownMs`, by when a late session is visible to the
 * preflight. Returns { release, markFailed } or { error }.
 */
export const RESUME_COOLDOWN_MS = 120_000;

/**
 * Per-install secret (0600 file) mixed into the abstract socket name: abstract
 * sockets have no permissions, so a predictable name would let another local user
 * squat it in advance and block every resume. (Accepted residual: a user who
 * watches /proc/net/unix while a resume is running can learn that one name and
 * squat it afterwards. That only BLOCKS resumes — it can never make one proceed
 * wrongly — and teleport hosts are single-user dev boxes.)
 * Published atomically (private temp file + link, which never replaces a winner),
 * and an existing secret is only accepted if it is ours, a regular file, and not
 * readable by group/others. Returns the secret or throws.
 */
export function resumeLockSecret(dir, { uid = process.getuid?.() } = {}) {
  const file = path.join(dir, '.resume-lock-secret');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(tmp, file); } catch (e) {
        if (e.code !== 'EEXIST') {
          // No hardlinks on this filesystem → plain exclusive create (a racing
          // reader may briefly see it empty and get a "malformed" refusal; retry).
          try { fs.writeFileSync(file, fs.readFileSync(tmp), { flag: 'wx', mode: 0o600 }); }
          catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
        }
      }
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`resume lock secret ${file} is not a regular file`);
  if (uid != null && st.uid !== uid) throw new Error(`resume lock secret ${file} is not owned by this user`);
  if (st.mode & 0o077) throw new Error(`resume lock secret ${file} is readable by others (mode ${(st.mode & 0o777).toString(8)}) — delete it so a fresh one is made`);
  const secret = fs.readFileSync(file, 'utf8').trim();
  if (secret.length < 32) throw new Error(`resume lock secret ${file} is malformed — delete it so a fresh one is made`);
  return secret;
}

export async function acquireResumeLock(sessionId, {
  dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp'),
  platform = process.platform, cooldownMs = RESUME_COOLDOWN_MS, now = Date.now,
  name = null,
  fileLock = (id) => acquireResumeFileLock(id, { dir }),
} = {}) {
  const marker = path.join(dir, `resume-${sessionId}.failed`);
  let lock;
  if (platform === 'linux') {
    if (!name) {
      try { name = `\0teleport-resume-${crypto.createHash('sha256').update(`${resumeLockSecret(dir)}:${sessionId}`).digest('hex').slice(0, 40)}`; }
      catch (e) { return { error: `cannot prepare the resume lock: ${e.message}` }; }
    }
    lock = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (e) => resolve(e.code === 'EADDRINUSE'
        ? { error: `another resume of ${sessionId} is in progress.` }
        : { error: `cannot take the resume lock: ${e.message}` }));
      server.listen(name, () => {
        server.unref(); // never keeps the process alive; the kernel frees it on exit
        let released = false;
        resolve({ release: () => { if (!released) { released = true; server.close(); } } });
      });
    });
  } else {
    lock = fileLock(sessionId);
  }
  if (lock.error) return lock;
  // Cooldown after a failed launch (checked while holding the lock).
  try {
    const age = now() - fs.statSync(marker).mtimeMs;
    if (age < cooldownMs) {
      lock.release();
      return { error: `a resume of ${sessionId} failed ${Math.round(age / 1000)}s ago and may still be starting — check /ls, retry after ${Math.ceil((cooldownMs - age) / 1000)}s.` };
    }
  } catch { /* no marker */ }
  return {
    ...lock,
    // Written BEFORE launching (fail closed: no marker → no launch), removed only
    // after the screen is verified. A launch that failed or crashed leaves it, and
    // the cooldown check above then blocks a premature retry.
    beginLaunch: () => {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, `${process.pid} ${now()}\n`); return { ok: true }; }
      catch (e) { return { error: `cannot record the launch (${e.message}) — refusing to launch without the retry guard.` }; }
    },
    launchSucceeded: () => { try { fs.unlinkSync(marker); } catch {} },
    markFailed: () => { try { fs.utimesSync(marker, new Date(now()), new Date(now())); } catch {} },
  };
}

/**
 * File lock fallback (non-Linux): one resume per session, so two concurrent `/spawn --resume-session`
 * (or `/kill pid: --restart`) of the same uuid can't both pass the preflight
 * before either screen exists (the daemon dispatches fire-and-forget).
 *
 *  - The lock is only ever CREATED with `wx` (atomic), holding `<pid> <token>`.
 *  - It is stale only when its holder pid is dead AND it is older than
 *    `staleMs`. The age floor covers an abnormal exit (daemon timeout, crash)
 *    that leaves a launch still starting: nobody may take over until that launch
 *    has had time to show up (and then the preflight sees it).
 *  - Breaking a stale lock is serialized by a second `wx` guard file
 *    (`.breaking`). Under the guard the breaker re-reads the lock and unlinks it
 *    only if it still holds the exact dead content it judged — nobody else can
 *    remove it meanwhile (only guard holders unlink others' locks, and a live
 *    owner's lock is never judged stale) — then tries the normal `wx` create;
 *    losing that create to a plain acquirer is just "busy". A live owner's lock is
 *    never moved or removed by anyone else, so there is at most one owner.
 *  - A guard left by a crashed breaker is itself broken by the same rule (dead pid
 *    + older than `staleMs`); it is held for microseconds, so that is rare.
 *  - release() unlinks only our own token (a live owner's lock can't be replaced).
 * Returns { file, release } or { error }.
 */
export const RESUME_LOCK_STALE_MS = 120_000;
export function acquireResumeFileLock(sessionId, {
  dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp'),
  pid = process.pid, isAlive = pidAliveLocal, token = crypto.randomUUID(),
  staleMs = RESUME_LOCK_STALE_MS, now = Date.now,
} = {}) {
  const file = path.join(dir, `resume-${sessionId}.lock`);
  const guard = `${file}.breaking`;
  const mine = `${pid} ${token}\n`;
  const busy = { error: `another resume of ${sessionId} is in progress (lock ${path.basename(file)}).` };
  fs.mkdirSync(dir, { recursive: true });
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const create = (f, body) => { try { fs.writeFileSync(f, body, { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };
  const isStale = (f, body) => {
    const holder = Number.parseInt(body, 10);
    // No parseable holder (a creator between O_EXCL and write, or garbage) is
    // UNKNOWN, never stale — eviction needs a pid we can prove dead.
    if (!(Number.isInteger(holder) && holder > 0)) return false;
    if (isAlive(holder)) return false;
    try { return now() - fs.statSync(f).mtimeMs >= staleMs; } catch { return false; }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (create(file, mine)) {
        let released = false;
        return {
          file,
          release: () => {
            if (released) return;
            released = true;
            if (read(file) === mine) { try { fs.unlinkSync(file); } catch {} }
          },
        };
      }
      const seen = read(file);
      if (seen == null) continue;          // released meanwhile → retry the create
      if (!isStale(file, seen)) return busy;
      // Stale: break it under the guard.
      if (!create(guard, mine)) {
        const g = read(guard);
        if (g == null || !isStale(guard, g)) return busy; // another breaker is at work
        if (read(guard) === g) { try { fs.unlinkSync(guard); } catch {} } // crashed breaker
        continue;
      }
      try {
        // Re-check we still own the guard right before the destructive step: a
        // straggler that cleared a "crashed" guard may have taken ours (narrows
        // the window; this file lock is only the non-Linux fallback).
        if (read(guard) === mine && read(file) === seen) { try { fs.unlinkSync(file); } catch {} }
      } finally {
        if (read(guard) === mine) { try { fs.unlinkSync(guard); } catch {} }
      }
    }
  } catch (e) {
    return { error: `cannot create resume lock: ${e.message}` };
  }
  return busy;
}

function pidAliveLocal(p) {
  try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * The whole resume: plan → lock → preflight → launch in `cwd` → verify the screen
 * came up. Shared by `--resume-session` and `--kill pid:<P> --restart`. Every
 * side effect is injectable for tests. Returns { ok, plan } | { error, plan }.
 */
export async function performResume({ sessionId, cwd, permissionMode = DEFAULT_PERMISSION_MODE }, {
  // A lock the CALLER already holds (`--restart` takes it before killing and
  // keeps it to the end) — then we neither acquire nor release it here.
  heldLock = null,
  acquireLock = acquireResumeLock,
  exec = execFileSync, spawnFn = cpSpawn,
  listProcs = () => listClaudeProcs({ strict: true, exec }),
  screenExists = (n) => screenSessionExists(n),
  transcriptDirs = (id) => findTranscriptDirs(id),
  run = (plan) => runSpawn(plan, { cwd, spawnFn }),
  sleep = sleepMs, timeoutMs = SPAWN_VERIFY_TIMEOUT_MS, pollMs = SPAWN_VERIFY_POLL_MS,
} = {}) {
  const plan = buildSpawnPlan({ interactive: true, permissionMode, resumeSessionId: sessionId });
  // Held until the screen is verified — see acquireResumeLock.
  const lock = heldLock || await acquireLock(plan.sessionId);
  if (lock.error) return { error: lock.error, plan };
  try {
    let procs = null, procsError = null;
    try { procs = listProcs(); } catch (e) { procsError = e?.message ?? String(e); }
    const pre = checkResumePreflight({
      sessionId: plan.sessionId, sessionName: plan.sessionName, cwd,
      procs, procsError, screenExists: screenExists(plan.sessionName),
      transcriptDirs: transcriptDirs(plan.sessionId),
    });
    if (pre.error) return { error: pre.error, plan };
    const begun = lock.beginLaunch ? lock.beginLaunch() : { ok: true };
    if (begun.error) return { error: begun.error, plan };
    const launched = run(plan);
    // Poll (the login shell takes seconds to exec screen) — same as a fresh spawn.
    const up = () => { lock.launchSucceeded?.(); return { ok: true, plan }; };
    for (let waited = 0; waited < timeoutMs; waited += pollMs) {
      if (screenExists(plan.sessionName)) return up();
      await sleep(Math.min(pollMs, timeoutMs - waited));
    }
    if (screenExists(plan.sessionName)) return up();
    // Timed out. The launcher (login shell → screen) may still be starting; if
    // we just released the lock it could create a writer AFTER a retry launched
    // another. So stop it first, then look one last time.
    const child = launched && launched.child;
    if (child && child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL'); } catch {}
      await sleep(pollMs);
      if (screenExists(plan.sessionName)) return up();
    }
    // We can't prove nothing is still starting (screen forks its server; a killed
    // front-end doesn't stop an already-forked one): the launch marker stays (its
    // mtime refreshed), so a retry waits until a late session would be visible.
    lock.markFailed?.();
    return { error: `screen session "${plan.sessionName}" not found after ${timeoutMs / 1000}s (claude or screen may have errored). Check /ls before retrying — a retry is blocked for ${RESUME_COOLDOWN_MS / 1000}s in case it is still starting.`, plan, launchFailed: true };
  } finally {
    if (!heldLock) lock.release();
  }
}

/**
 * Can `--restart` resume this kill target? Checked BEFORE the kill so a restart
 * that can't work never leaves the agent dead. `target` = the /ls row. Pure.
 */
export function checkRestartTarget(target, { transcriptDirs }) {
  if (!target || !target.sessionId) return { error: 'cannot restart: no session id known for this PID (no session file).' };
  if (target.guessed) return { error: `cannot restart: session id ${target.sessionId} is only a guess — resume manually after checking /ls.` };
  if (!target.cwd) return { error: 'cannot restart: unknown working directory.' };
  if (!transcriptDirs.includes(cwdToProjectSlug(target.cwd))) {
    return { error: `cannot restart: no transcript for ${target.sessionId} under ${target.cwd}'s project folder.` };
  }
  return { ok: true };
}

/**
 * Full pre-kill check for `--restart`: the target itself (checkRestartTarget) AND
 * every refusal the post-kill resume would hit (checkResumePreflight with the
 * target pid excluded — it is about to die): an unidentified claude in the same
 * cwd, an existing screen, a failed ps. So "killed, but restart failed" can only
 * come from something that changed in between, never from a knowable refusal. Pure.
 */
export function checkRestartPreflight(target, { procs, procsError = null, screenExists, transcriptDirs }) {
  const rc = checkRestartTarget(target, { transcriptDirs });
  if (rc.error) return rc;
  const plan = buildSpawnPlan({ interactive: true, resumeSessionId: target.sessionId });
  return checkResumePreflight({
    sessionId: target.sessionId, sessionName: plan.sessionName, cwd: target.cwd,
    procs: Array.isArray(procs) ? procs.filter((r) => r.pid !== target.pid) : procs, procsError,
    screenExists, transcriptDirs,
  });
}

/** Project dirs under ~/.claude/projects that hold `<sessionId>.jsonl`. */
export function findTranscriptDirs(sessionId, projectsDir = PROJECTS_DIR) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return out; }
  for (const d of dirs) {
    try { if (fs.statSync(path.join(projectsDir, d, `${sessionId}.jsonl`)).isFile()) out.push(d); } catch {}
  }
  return out;
}

/**
 * Owner gate for `--kill pid:`. The daemon passes the sender's Telegram id as
 * TELE_FROM_ID; only the daemon owner may kill by pid. Pure → { ok } | { error }.
 * (Advisory like every TELE_FROM_* input: it stops a non-owner going through the
 * daemon, not a local process that forges the env — same bound as whisper.)
 */
export function checkPidKillAuth({ fromId, daemonUserId }) {
  if (!daemonUserId) return { error: 'no daemon owner configured (projects.json `_config.daemonUserId`) — pid kills disabled.' };
  if (!fromId) return { error: '`--kill pid:` is daemon-only: send `/kill pid:<PID>` to the daemon (owner only).' };
  if (String(fromId) !== String(daemonUserId)) return { error: '`/kill pid:` is owner-only.' };
  return { ok: true };
}

/** The `pid:<N>` target after --kill/--quit, tolerating `pid: N` split into two tokens. */
export function resolveKillPid(argv) {
  const i = argv.findIndex((a) => a === '--kill' || a === '--quit');
  // `name:<persona or session name>` — the words after `name:` up to the next
  // --flag (so both `name:"Rắn 3"` and unquoted `name:Rắn 3` work).
  if (i !== -1 && /^name:/i.test(argv[i + 1] ?? '')) {
    const words = [argv[i + 1].slice(5)];
    for (let j = i + 2; j < argv.length && !argv[j].startsWith('--'); j++) words.push(argv[j]);
    const name = words.join(' ').trim();
    return name ? { found: true, name } : { found: true, error: 'name: needs a name, e.g. name:"Rắn 3" (see /ls).' };
  }
  if (i === -1 || !/^pid:/i.test(argv[i + 1] ?? '')) return { found: false };
  const raw = argv[i + 1] === 'pid:' || /^pid:$/i.test(argv[i + 1]) ? `pid:${argv[i + 2] ?? ''}` : argv[i + 1];
  const pid = parseKillPidArg(raw);
  return pid ? { found: true, pid } : { found: true, error: `bad pid target ${JSON.stringify(raw)} — use pid:<PID> (see /ls).` };
}

/** Name → comparable form: drop emoji/symbols, collapse spaces, lowercase. Pure. */
export function normalizeAgentName(s) {
  return String(s ?? '').normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Resolve `name:` to exactly one live claude process: a FULL-name match (case,
 * emoji and punctuation ignored) against the session name or the Telegram persona
 * shown in /ls. 0 or ≥2 matches → { error } listing candidates. Pure.
 */
export function matchProcsByName(name, rows, personaOf = () => null) {
  const q = normalizeAgentName(name);
  if (!q) return { error: 'empty name.' };
  const hits = rows.filter((r) => [r.name, personaOf(r)].some((n) => n && normalizeAgentName(n) === q));
  const label = (r) => `PID ${r.pid}${r.name ? ` (${r.name})` : ''}`;
  if (hits.length === 1) return { pid: hits[0].pid };
  if (!hits.length) return { error: `no claude process named "${name}" (see /ls for names).` };
  return { error: `"${name}" matches ${hits.length} processes: ${hits.map(label).join(', ')} — use /kill pid:<PID>.` };
}

export const KILL_PID_AUDIT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp', 'kill-pid-audit.jsonl');

/** Append one audit line; never throws (an audit failure must not mask the result). */
export function appendKillAudit(entry, file = KILL_PID_AUDIT_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) { console.error(`[spawn] audit write failed: ${e?.message ?? e}`); }
}

/** How long to wait for the screen session to appear, and how often to look. */
export const SPAWN_VERIFY_TIMEOUT_MS = 15_000;
export const SPAWN_VERIFY_POLL_MS = 250;

/** Non-blocking delay (avoids spawning the `sleep` binary + its fractional-second assumption). */
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch the agent "as if it had been started by hand from a terminal" (RFC 15
 * follow-up; 3-reviewer decision).
 *
 * We are ourselves a Claude session, so our env is the user's shell env PLUS a
 * layer Claude injects per session: `CLAUDE_CODE_CHILD_SESSION=1` (the poisonous
 * one — inherited by the new `claude` it TURNS OFF transcript saving:
 * "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"), the
 * parent's `CLAUDE_CODE_SESSION_ID` / messaging socket+token / `CLAUDE_PID`,
 * plus `CLAUDE_EFFORT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_PLUGIN_DATA`… A spawned
 * agent is a real, standalone session: it must keep its transcript (that is what
 * /handover, /resume and the session-log workflow read later) and must not run
 * at OUR reasoning effort or against OUR plugin/IPC state.
 *
 * Deleting a hand-kept list of those names is a losing game (the CLI adds/renames
 * them at will, and a miss fails SILENTLY — you only notice when a transcript is
 * missing). So we don't build an env at all: we start from a bare seed and let
 * the user's own LOGIN + INTERACTIVE shell rebuild it, exactly as it would for a
 * `claude` typed into Terminal. Anything Claude injects is gone by construction —
 * including vars that don't exist yet — while everything the user exports in their
 * rc file survives (e.g. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` in ~/.zshrc).
 *
 * `-i` is REQUIRED, not paranoia: zsh sources ~/.zshrc only for interactive
 * shells, and on this machine `-lc` alone yields no user exports and a PATH
 * without nvm — i.e. `claude` itself would not be on it.
 *
 * `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` is deliberately NOT set: a clean env is
 * empirically enough to keep transcripts on, a real terminal doesn't have it, and
 * it would leak down to the agent's own genuine sub-sessions.
 */

/**
 * Vars a fresh terminal gets from launchd / the login session, which rc files do
 * NOT set — the session sockets matter most (ssh-agent for `git push`, the
 * desktop bus for keyrings/credential helpers, the display for GUI tools).
 */
export const ENV_SEED_KEYS = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY',
  '__CF_USER_TEXT_ENCODING', 'COLORTERM', 'TERM_PROGRAM',
  'http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
];

/** Bootstrap PATH — only needs to be enough for the rc files to run; they rebuild the real one. */
export const SEED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * The bare env the login shell starts from. `TELEPORT_SPAWN=1` is a courtesy
 * marker so a heavy rc file can early-return if the user ever wants that.
 */
export function loginSeedEnv(base = process.env) {
  const env = {};
  for (const k of ENV_SEED_KEYS) if (base[k] != null && base[k] !== '') env[k] = base[k];
  env.PATH = SEED_PATH;
  env.TELEPORT_SPAWN = '1';
  return env;
}

/**
 * Wrap a command so the user's login+interactive shell execs it.
 *
 * `exec "$@"` with the argv passed POSITIONALLY is what makes this safe: the
 * multi-line prompt seed (quotes, newlines, backticks) stays one argv item and is
 * never re-parsed by the shell — the classic footgun of building a `-c` string.
 * `exec` means no extra process survives, so the returned pid is still the agent's.
 * Returns null when there is no usable POSIX-style $SHELL (caller falls back).
 */
export function wrapInLoginShell(command, base = process.env) {
  const shell = base.SHELL;
  if (!shell || !shell.startsWith('/')) return null;
  // `exec "$@"` is POSIX-sh syntax: only wrap known POSIX shells (sh, bash, zsh,
  // ksh, mksh, dash, yash). Anything else (fish, csh, nu, pwsh, xonsh…) → let the
  // caller fall back instead of failing the spawn.
  if (!/\/(ba|z|k|mk|da|ya)?sh$/.test(shell)) return null;
  return [shell, '-lic', 'exec "$@"', 'teleport-spawn', ...command];
}

/**
 * Fallback env for the (rare) no-$SHELL case: scrub every Claude-injected var by
 * PREFIX so a future rename can't sneak through. This may also drop a user's own
 * `CLAUDE_*` export — accepted, because the alternative (leaking the session
 * marker) is the bug we are fixing.
 */
export function scrubClaudeEnv(base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (/^CLAUDE(CODE)?(_|$)/.test(k)) delete env[k];
  return env;
}

/**
 * True when `/proc/self/cgroup` puts us inside a systemd SERVICE (e.g. the daemon
 * running as teleport-daemon.service) — not the user manager itself. Pure.
 */
export function inSystemdService(cgroupText) {
  for (const line of String(cgroupText ?? '').split('\n')) {
    const leaf = line.trim().split('/').pop() || '';
    if (leaf.endsWith('.service') && !/^user@\d+\.service$/.test(leaf)) return true;
  }
  return false;
}

/**
 * Run agents OUTSIDE the daemon's service cgroup. Under systemd (KillMode=
 * control-group, the default) everything the daemon launches lives in its
 * cgroup, so restarting/stopping the daemon — or systemd restarting it after a
 * crash — would kill every agent it ever spawned or resumed. `systemd-run --user
 * --scope` gives the launch its own transient scope (it execs the command, so the
 * pid is unchanged). Only when inside a service AND a probe of systemd-run
 * succeeds; otherwise the command is returned as-is. Injectable for tests.
 */
export const SYSTEMD_SCOPE_PREFIX = ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--'];
export function escapeServiceCgroup(command, env, {
  cgroup = (() => { try { return fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch { return ''; } })(),
  run = execFileSync,
  probe = () => {
    const [bin, ...args] = SYSTEMD_SCOPE_PREFIX;
    try { run(bin, [...args, 'true'], { env, stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; }
  },
} = {}) {
  if (!inSystemdService(cgroup) || !probe()) return command;
  return [...SYSTEMD_SCOPE_PREFIX, ...command];
}

/** The (command, env) pair to actually spawn: login-shell wrapped when possible. */
export function childLaunch(command, base = process.env) {
  const wrapped = wrapInLoginShell(command, base);
  return wrapped
    ? { command: wrapped, env: loginSeedEnv(base) }
    : { command, env: scrubClaudeEnv(base) };
}

/**
 * Execute a plan. `runner` is injectable for tests (default actually spawns).
 * - interactive: `screen -dm` self-detaches; we invoke and return.
 * - headless: detached + unref so it survives this process exiting.
 */
export function runSpawn(plan, { runner, cwd, spawnFn = cpSpawn, escape = escapeServiceCgroup } = {}) {
  if (runner) return runner(plan);
  // `cwd` sets the spawned agent's working directory — which is how it later
  // resolves its Telegram group. Since RFC 15 routing is convo-anchored: at
  // cold-start the project comes from the MAIN git checkout of that cwd
  // (git-common-dir → projects.json), not raw basename(cwd). The supervisor
  // daemon passes a sibling project dir here so `/spawn <project>` lands the new
  // agent in that project's group. Undefined → inherit our cwd.
  const launch = childLaunch(plan.command);
  const { env } = launch;
  const command = escape(launch.command, env);
  const opts = { env, ...(cwd ? { cwd } : {}) };
  if (plan.mode === 'interactive') {
    // No `detached: true` needed: `screen -dm` self-daemonizes, so the front-end
    // `screen` process exits immediately and the claude session lives on inside
    // screen. unref() releases our handle to that short-lived front-end.
    const r = spawnFn(command[0], command.slice(1), { stdio: 'ignore', ...opts });
    r.unref?.();
    // `child` = the launcher (login shell → screen front-end), so a caller that
    // gives up waiting can stop it before it launches late (performResume).
    return { ...plan, child: r };
  }
  const child = spawnFn(command[0], command.slice(1), { detached: true, stdio: 'ignore', ...opts });
  child.unref();
  return { ...plan, pid: child.pid };
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  const argv = process.argv.slice(2);

  // --help / -h: FIRST check — a requested help prints to stdout and exits 0
  // (before any subcommand dispatch, so `--help` never falls through to a spawn).
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  // --list / --ls: show our spawned screen sessions (name == convo hashtag).
  if (argv.includes('--list') || argv.includes('--ls')) {
    // Two sections (screens first, then hand-opened terminal sessions), each claude
    // line with its full session id — see formatAgentList.
    const screens = hasBinary('screen') ? listSpawnSessions() : [];
    const pmap = personaByHashtag();
    console.log(formatAgentList({
      screens, procs: listClaudeProcs(),
      personaOf: (h) => (pmap[h] ? formatPersona(pmap[h]) : null),
    }));
    process.exit(0);
  }

  // TEMPORARY bridge (remove once every daemon has `restartd` in its registry):
  // `/kill --restartd [--force]` reaches us through the old `/kill` entry, so a
  // running daemon can be restarted from Telegram without editing its config.
  // Owner only, same gate as pid kills.
  if (argv.includes('--restartd')) {
    const fromId = process.env.TELE_FROM_ID || '';
    const daemonUserId = resolveDaemonUserId(readProjectsConfig(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects.json')), { env: {} });
    const auth = checkPidKillAuth({ fromId, daemonUserId });
    if (auth.error) { console.error(`[spawn] ❌ \`/kill --restartd\` is daemon-only and owner-only (${auth.error})`); process.exit(1); }
    const { runRestartd } = await import('./restartd.mjs');
    const r = runRestartd({ force: argv.includes('--force') });
    console.log(r.error ? `[spawn] ❌ ${r.error}` : `[spawn] ${r.message}`);
    process.exit(r.error ? 1 : 0);
  }

  // --kill pid:<PID>: owner-only SIGTERM of one claude process (via the daemon).
  const killPid = resolveKillPid(argv);
  if (killPid.found) {
    if (killPid.error) { console.error(`[spawn] ${killPid.error}`); process.exit(1); }
    const fromId = process.env.TELE_FROM_ID || '';
    // projects.json only — no env fallback, so the owner id can't be overridden
    // from the environment the request arrives with.
    const daemonUserId = resolveDaemonUserId(readProjectsConfig(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects.json')), { env: {} });
    const auth = checkPidKillAuth({ fromId, daemonUserId });
    if (auth.error) {
      appendKillAudit({ pid: killPid.pid ?? null, name: killPid.name ?? null, fromId, result: 'denied', reason: auth.error });
      console.error(`[spawn] ❌ ${auth.error}`);
      process.exit(1);
    }
    if (killPid.name) {
      // Owner only from here (no process list for anyone else).
      const pmap = personaByHashtag();
      const m = matchProcsByName(killPid.name, listClaudeProcs(), (r) => (r.hashtag && pmap[r.hashtag] ? formatPersona(pmap[r.hashtag]) : null));
      if (m.error) { appendKillAudit({ name: killPid.name, fromId, result: 'refused', reason: m.error }); console.error(`[spawn] ❌ ${m.error}`); process.exit(1); }
      console.log(`[spawn] name "${killPid.name}" → PID ${m.pid}`);
      killPid.pid = m.pid;
    }
    const restart = argv.includes('--restart');
    let restartMode = DEFAULT_PERMISSION_MODE;
    let restartLock = null;
    let restartSessionId = null;
    let preRow = null, preStart = null, ownScreen = false;
    if (restart) {
      // Everything a restart needs is checked BEFORE the kill: never leave the
      // agent dead because the resume half was doomed from the start.
      restartMode = resolveMode(argv);
      if (restartMode === null || !PERMISSION_MODES.includes(restartMode)) {
        console.error(`[spawn] --mode needs one of: ${PERMISSION_MODES.join(', ')} (default ${DEFAULT_PERMISSION_MODE}).`); process.exit(1);
      }
      if (!hasBinary('claude') || !hasBinary('screen')) { console.error('[spawn] --restart needs `claude` and `screen` on PATH.'); process.exit(1); }
      // Bracket the snapshot with two start fingerprints: the row we keep is
      // bound to THIS process only if the pid kept the same identity throughout.
      const startBefore = inspectPid(killPid.pid)?.start ?? null;
      let procs = null, procsError = null;
      try { procs = listClaudeProcs({ strict: true }); } catch (e) { procsError = e.message; }
      const startAfter = inspectPid(killPid.pid)?.start ?? null;
      if (!procsError && (startBefore == null || startBefore !== startAfter)) {
        procsError = 'cannot establish the identity of this PID (start time unknown or changed)';
      }
      const pre = procs?.find((row) => row.pid === killPid.pid) || null;
      // Take the session's resume lock NOW and hold it through kill + resume, so
      // a lock held elsewhere is a refusal BEFORE the kill, not after it.
      if (pre?.sessionId && !pre.guessed) {
        restartSessionId = pre.sessionId;
        restartLock = await acquireResumeLock(pre.sessionId);
        if (restartLock.error) {
          appendKillAudit({ pid: killPid.pid, fromId, result: 'refused', reason: restartLock.error, restart: true });
          console.error(`[spawn] ❌ cannot restart: ${restartLock.error} Nothing was killed.`);
          process.exit(1);
        }
        process.on('exit', restartLock.release);
      }
      preRow = pre;
      preStart = startBefore;
      const sessionName = pre?.sessionId && !pre.guessed ? buildSpawnPlan({ interactive: true, resumeSessionId: pre.sessionId }).sessionName : null;
      // A target living in its OWN tele-<hashtag> screen: that screen dies with it,
      // so it is not a conflict — we wait for it to go after the kill.
      ownScreen = Boolean(sessionName && pre?.screen === sessionName);
      const rc = procsError
        ? { error: `cannot restart: ${procsError}.` }
        : checkRestartPreflight(pre, {
          procs, screenExists: sessionName && !ownScreen ? screenSessionExists(sessionName) : false,
          transcriptDirs: pre?.sessionId ? findTranscriptDirs(pre.sessionId) : [],
        });
      if (rc.error) {
        appendKillAudit({ pid: killPid.pid, fromId, result: 'refused', reason: rc.error, restart: true });
        console.error(`[spawn] ❌ ${rc.error} Nothing was killed.`);
        process.exit(1);
      }
    }
    console.log(`[spawn] SIGTERM → PID ${killPid.pid}, waiting up to ${KILL_PID_GRACE_MS / 1000}s…`);
    const r = await killClaudePid(killPid.pid, restart ? { expectStart: preStart } : {});
    // The kill-time describe() is lenient (a transient ps failure → null); the
    // pre-kill row of the SAME process (start fingerprint checked) is the fallback.
    const t = r.target ?? (restart ? preRow : null);
    appendKillAudit({
      pid: killPid.pid, fromId, restart, result: r.error ? 'refused' : r.exited ? 'exited' : 'still-alive',
      reason: r.error, sessionId: t?.sessionId ?? null, sessionGuessed: t?.guessed ?? false,
      cwd: t?.cwd ?? null, name: t?.name ?? null, tty: t?.tty ?? null,
    });
    if (r.error) { console.error(`[spawn] ❌ ${r.error}`); process.exit(1); }
    const who = [t?.name, t?.cwd, t?.sessionId ? `session ${t.sessionId}${t.guessed ? ' (guessed)' : ''}` : null].filter(Boolean).join(' · ');
    if (r.exited) {
      console.log(`[spawn] ✅ PID ${killPid.pid} exited${who ? ` (${who})` : ''}.`);
      if (restart) {
        // Re-validated against the row captured at kill time (the pre-kill check
        // used an earlier snapshot of the same pid).
        const rc = checkRestartTarget(t, { transcriptDirs: t?.sessionId ? findTranscriptDirs(t.sessionId) : [] });
        // The kill-time row must still be the session we locked before killing.
        const rc2 = rc.error ? rc : (restartLock && t.sessionId === restartSessionId ? rc : { error: 'session changed between the pre-kill check and the kill.' });
        if (!rc2.error && ownScreen) {
          // Its old screen exits with it; give it a moment so the preflight's
          // "screen already exists" check doesn't trip on the dying session.
          for (let w = 0; w < 5000 && screenSessionExists(buildSpawnPlan({ interactive: true, resumeSessionId: t.sessionId }).sessionName); w += 250) await sleepMs(250);
        }
        const res = rc2.error ? rc2 : await performResume({ sessionId: t.sessionId, cwd: t.cwd, permissionMode: restartMode }, { heldLock: restartLock });
        appendKillAudit({ pid: killPid.pid, fromId, result: res.error ? 'restart-failed' : 'restarted', reason: res.error, sessionId: t?.sessionId ?? null, screen: res.plan?.sessionName ?? null });
        if (res.error) {
          console.error(`[spawn] ❌ killed, but restart failed: ${res.error}`);
          if (t?.sessionId && !t.guessed) console.error(`[spawn] retry: /spawn <project> --resume-session ${t.sessionId}`);
          process.exit(1);
        }
        console.log(`[spawn] 🔁 restarted session ${t.sessionId} in screen "${res.plan.sessionName}" (cwd ${t.cwd}) → topic #${res.plan.sessionName.replace(/^tele-/, '')}. It will check its mailbox, re-arm its listener and greet in its topic.`);
        process.exit(0);
      }
      // Only suggest a resume for a session we KNOW (session file), never a guess.
      if (t?.sessionId && !t.guessed) console.log(`[spawn] resume it in a screen: /spawn <project> --resume-session ${t.sessionId}`);
      process.exit(0);
    }
    console.error(`[spawn] ⚠️ PID ${killPid.pid} still alive after ${KILL_PID_GRACE_MS / 1000}s (SIGTERM sent, no SIGKILL by design). Check /ls, retry later.`);
    process.exit(1);
  }

  // --kill <id>: id may be `d1331668`, `#d1331668`, or `tele-d1331668`.
  const kill = resolveKillId(argv);
  if (kill.found) {
    if (!kill.raw) { console.error('[spawn] --kill needs an id, e.g. `pnpm spawn:kill d1331668` (or #d1331668 / tele-d1331668).'); process.exit(1); }
    if (!hasBinary('screen')) { console.error('[spawn] `screen` not found on PATH.'); process.exit(1); }
    let name;
    try { name = normalizeSessionName(kill.raw); }
    catch (e) { console.error(`[spawn] ${e.message}`); process.exit(1); }
    if (!screenSessionExists(name)) {
      console.error(`[spawn] no screen session "${name}" (try: spawn.mjs --list). NB: --kill needs the FULL hashtag — the 3-char tail / no-id shortcuts are --attach only (destructive, so kill stays explicit).`);
      process.exit(1);
    }
    // Graceful: try claude's own /exit first, wait up to 10s, force-quit if stubborn.
    console.log(`[spawn] sending /exit to "${name}", waiting up to ${KILL_GRACE_MS / 1000}s…`);
    const r = await gracefulKill(name);
    if (!r.killed) {
      console.error(`[spawn] FAILED to kill "${name}" (still listed). Try: screen -S ${name} -X quit`);
      process.exit(1);
    }
    console.log(r.method === 'exit'
      ? `[spawn] "${name}" exited gracefully (/exit).`
      : `[spawn] "${name}" didn't exit in ${KILL_GRACE_MS / 1000}s — force-killed.`);
    process.exit(0);
  }

  // --attach <id>: re-attach this terminal to a running agent's screen session.
  // id may be the 3-char hashtag tail (`116`), a bare/`#`/`tele-` hashtag, or OMITTED
  // when only one session is live (see resolveAttachTarget). ≥2 suffix matches → error.
  const attach = resolveAttachId(argv);
  if (attach.found) {
    if (!hasBinary('screen')) { console.error('[spawn] `screen` not found on PATH.'); process.exit(1); }
    // Resolve against the live session list: a 3-char suffix (`116`) is enough, and
    // when only ONE session is live the id is optional. ≥2 matches → ambiguous error.
    const r = resolveAttachTarget(attach.raw, listSpawnSessions());
    if (r.error) { console.error(`[spawn] ${r.error}`); process.exit(1); }
    const name = r.name;
    // Hand the TTY to screen. `-r` re-attaches; `-d -r` steals it back if the
    // session is already attached elsewhere (e.g. another terminal). stdio
    // 'inherit' gives screen the real pty; detach with Ctrl-A D to leave it
    // running. We exit with screen's own status.
    console.log(`[spawn] attaching to "${name}" — detach with Ctrl-A then D (leaves the agent running).`);
    try {
      execFileSync('screen', ['-U', '-d', '-r', name], { stdio: 'inherit' });
      process.exit(0);
    } catch (e) {
      process.exit(typeof e?.status === 'number' ? e.status : 1);
    }
  }

  const resume = resolveResumeSession(argv);
  if (resume.found && resume.error) { console.error(`[spawn] ${resume.error}`); process.exit(1); }
  const interactive = resume.found || argv.includes('--interactive') || argv.includes('-i');
  // Permission mode: always explicit (default `auto`), overridable via `--mode`.
  const permissionMode = resolveMode(argv);
  if (permissionMode === null || !PERMISSION_MODES.includes(permissionMode)) {
    console.error(`[spawn] --mode needs one of: ${PERMISSION_MODES.join(', ')} (default ${DEFAULT_PERMISSION_MODE}).`);
    process.exit(1);
  }
  // Preflight: the binaries we need must exist.
  if (!hasBinary('claude')) {
    console.error('[spawn] `claude` not found on PATH.');
    process.exit(1);
  }
  if (interactive && !hasBinary('screen')) {
    console.error('[spawn] interactive mode needs `screen` (or install tmux + switch backend). Not found on PATH.');
    process.exit(1);
  }
  if (resume.found) {
    const res = await performResume({ sessionId: resume.sessionId, cwd: process.cwd(), permissionMode });
    if (res.error) { console.error(`[spawn] refusing to resume / FAILED: ${res.error}`); process.exit(1); }
    const { plan } = res;
    console.log(`[spawn] resumed session ${plan.sessionId} in screen "${plan.sessionName}" → topic #${plan.sessionName.replace(/^tele-/, '')} (subscription billing).`);
    console.log('[spawn] it will check its mailbox, re-arm its Telegram listener and greet in its existing topic.');
    console.log(`[spawn] teardown: ${plan.teardown}`);
    process.exit(0);
  }
  const plan = buildSpawnPlan({ interactive, permissionMode });
  const result = runSpawn(plan);
  if (plan.mode === 'interactive') {
    // Verify the screen session actually came up — `screen -dmS` returns 0 even if
    // claude failed to exec inside it. (NB: verifies screen presence, not claude
    // liveness.)
    //
    // POLL, don't sleep once: the launch now goes through the user's login shell
    // (see childLaunch — that is what keeps the agent's env identical to a
    // hand-typed `claude`), and an interactive zsh with a real rc file takes a
    // couple of SECONDS to start before `screen` is even exec'd. A single 500ms
    // settle reported a healthy spawn as FAILED — verified on this machine, where
    // the session was in fact running the whole time.
    let up = false;
    for (let waited = 0; waited < SPAWN_VERIFY_TIMEOUT_MS; waited += SPAWN_VERIFY_POLL_MS) {
      if (screenSessionExists(plan.sessionName)) { up = true; break; }
      await sleepMs(SPAWN_VERIFY_POLL_MS);
    }
    if (!up && !screenSessionExists(plan.sessionName)) {
      console.error(`[spawn] FAILED: screen session "${plan.sessionName}" not found after ${SPAWN_VERIFY_TIMEOUT_MS / 1000}s (claude or screen may have errored). Check: screen -ls`);
      process.exit(1);
    }
    console.log(`[spawn] interactive agent launched in screen session "${plan.sessionName}" (subscription billing).`);
    if (plan.sessionId) {
      // The session name IS the convo hashtag → it matches the #tag the agent
      // shows in its Telegram topic, so you can map screen ⇄ topic at a glance.
      console.log(`[spawn] forced session-id ${plan.sessionId} → topic hashtag #${plan.sessionName.replace(/^tele-/, '')}.`);
    }
    console.log(`[spawn] it will greet you on Telegram shortly (its own persona topic).`);
    console.log(`[spawn] teardown: ${plan.teardown}`);
  } else {
    console.log(`[spawn] headless agent launched (pid ${result.pid}, Agent SDK pool). Auto-exits when done.`);
    console.log(`[spawn] it will greet you on Telegram shortly (its own persona topic).`);
  }
}
