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
// The prompt is HARD-CODED: the new instance just says "Telegram me and wait" and
// you give it work over Telegram (it gets its own persona topic via RFC 01/02,
// and resolves its group from the cwd it's spawned in via RFC 02).
//
// Verbal convention (telegram-guide): "spawn Claude" → pnpm spawn:i (interactive);
// "spawn Claude headless" → pnpm spawn:headless.

import { spawn as cpSpawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';

export const SPAWN_PROMPT = 'Telegram me and wait for instructions';

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
export function buildSpawnPlan({ interactive = false, sessionName, sessionId, seed, prompt = SPAWN_PROMPT } = {}) {
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
    const claudeArgs = sid != null ? ['claude', '--session-id', sid, prompt] : ['claude', prompt];
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
    command: ['claude', '-p', prompt], // launched detached below; auto-exits (SDK pool)
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

/** Non-blocking delay (avoids spawning the `sleep` binary + its fractional-second assumption). */
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute a plan. `runner` is injectable for tests (default actually spawns).
 * - interactive: `screen -dm` self-detaches; we invoke and return.
 * - headless: detached + unref so it survives this process exiting.
 */
export function runSpawn(plan, { runner } = {}) {
  if (runner) return runner(plan);
  if (plan.mode === 'interactive') {
    // No `detached: true` needed: `screen -dm` self-daemonizes, so the front-end
    // `screen` process exits immediately and the claude session lives on inside
    // screen. unref() releases our handle to that short-lived front-end.
    const r = cpSpawn(plan.command[0], plan.command.slice(1), { stdio: 'ignore' });
    r.unref?.();
    return { ...plan };
  }
  const child = cpSpawn(plan.command[0], plan.command.slice(1), { detached: true, stdio: 'ignore' });
  child.unref();
  return { ...plan, pid: child.pid };
}

const isDirectRun = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isDirectRun) {
  const argv = process.argv.slice(2);

  // --list / --ls: show our spawned screen sessions (name == convo hashtag).
  if (argv.includes('--list') || argv.includes('--ls')) {
    if (!hasBinary('screen')) { console.error('[spawn] `screen` not found on PATH.'); process.exit(1); }
    const sessions = listSpawnSessions();
    if (!sessions.length) { console.log('[spawn] no agent sessions (tele-*) running.'); process.exit(0); }
    console.log(`[spawn] ${sessions.length} agent session(s):`);
    for (const s of sessions) console.log(`  ${s.name}  (pid ${s.pid})  → topic #${s.name.replace(/^tele-/, '')}`);
    process.exit(0);
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
      console.error(`[spawn] no screen session "${name}" (try: pnpm spawn:ls).`);
      process.exit(1);
    }
    // `screen -X quit` can exit non-zero (race, perms) → don't let it throw a stack
    // trace; the re-check below is the source of truth (kill verified by absence).
    try { execFileSync('screen', ['-S', name, '-X', 'quit'], { stdio: 'ignore' }); } catch { /* re-check decides */ }
    await sleepMs(300); // settle, then verify it's gone
    if (screenSessionExists(name)) {
      console.error(`[spawn] FAILED to kill "${name}" (still listed). Try: screen -S ${name} -X quit`);
      process.exit(1);
    }
    console.log(`[spawn] killed agent session "${name}".`);
    process.exit(0);
  }

  // --attach <id>: re-attach this terminal to a running agent's screen session.
  // id may be `d1331668`, `#d1331668`, or `tele-d1331668` (same as --kill).
  const attach = resolveAttachId(argv);
  if (attach.found) {
    if (!attach.raw) { console.error('[spawn] --attach needs an id, e.g. `pnpm spawn:attach d1331668` (or #d1331668 / tele-d1331668).'); process.exit(1); }
    if (!hasBinary('screen')) { console.error('[spawn] `screen` not found on PATH.'); process.exit(1); }
    let name;
    try { name = normalizeSessionName(attach.raw); }
    catch (e) { console.error(`[spawn] ${e.message}`); process.exit(1); }
    if (!screenSessionExists(name)) {
      console.error(`[spawn] no screen session "${name}" (try: pnpm spawn:ls).`);
      process.exit(1);
    }
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

  const interactive = argv.includes('--interactive') || argv.includes('-i');
  // Preflight: the binaries we need must exist.
  if (!hasBinary('claude')) {
    console.error('[spawn] `claude` not found on PATH.');
    process.exit(1);
  }
  if (interactive && !hasBinary('screen')) {
    console.error('[spawn] interactive mode needs `screen` (or install tmux + switch backend). Not found on PATH.');
    process.exit(1);
  }
  const plan = buildSpawnPlan({ interactive });
  const result = runSpawn(plan);
  if (plan.mode === 'interactive') {
    // Verify the screen session actually came up — `screen -dmS` returns 0 even
    // if claude failed to exec inside it. Tiny settle delay. (NB: verifies screen
    // presence, not claude liveness.)
    await sleepMs(500);
    if (!screenSessionExists(plan.sessionName)) {
      console.error(`[spawn] FAILED: screen session "${plan.sessionName}" not found after launch (claude or screen may have errored). Check: screen -ls`);
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
