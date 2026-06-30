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
// Permission mode: every spawn passes an EXPLICIT `--permission-mode` to claude,
// default `auto` (the new autonomous mode). Override with
//   --mode <default|auto|acceptEdits|bypassPermissions|dontAsk|plan>
// (also accepts `--mode=<value>`).
//
// Verbal convention (telegram-guide): "spawn Claude" → pnpm spawn:i (interactive);
// "spawn Claude headless" → pnpm spawn:headless.

import { spawn as cpSpawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { formatPersona } from './persona.mjs';
import { peekPersona } from './persona-store.mjs';

export const SPAWN_PROMPT = 'Telegram me and wait for instructions';

// Claude CLI `--permission-mode` choices (verified on claude 2.1.186). A spawn
// ALWAYS sets one — defaulting to `auto`, the new autonomous mode (NOT the old
// blanket auto-accept `acceptEdits`/`bypassPermissions`), so a Telegram-driven
// agent can act without prompting for every permission. Override via `--mode`.
export const PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan'];
export const DEFAULT_PERMISSION_MODE = 'auto';

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
export function buildSpawnPlan({ interactive = false, sessionName, sessionId, seed, prompt = SPAWN_PROMPT, permissionMode = DEFAULT_PERMISSION_MODE } = {}) {
  // Every spawn is launched with an EXPLICIT `--permission-mode` (never left to
  // the CLI default) so the agent's autonomy is deliberate, not incidental.
  if (!PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`spawn: invalid permission mode ${JSON.stringify(permissionMode)} (allowed: ${PERMISSION_MODES.join(', ')})`);
  }
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

export const KILL_GRACE_MS = 10_000;

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

/** Non-blocking delay (avoids spawning the `sleep` binary + its fractional-second assumption). */
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute a plan. `runner` is injectable for tests (default actually spawns).
 * - interactive: `screen -dm` self-detaches; we invoke and return.
 * - headless: detached + unref so it survives this process exiting.
 */
export function runSpawn(plan, { runner, cwd, spawnFn = cpSpawn } = {}) {
  if (runner) return runner(plan);
  // `cwd` sets the spawned agent's working directory — which is how it later
  // resolves its Telegram group (RFC 02: group derived from basename(cwd)). The
  // supervisor daemon passes a sibling project dir here so `/spawn <project>`
  // lands the new agent in that project's group. Undefined → inherit our cwd.
  const opts = cwd ? { cwd } : {};
  if (plan.mode === 'interactive') {
    // No `detached: true` needed: `screen -dm` self-daemonizes, so the front-end
    // `screen` process exits immediately and the claude session lives on inside
    // screen. unref() releases our handle to that short-lived front-end.
    const r = spawnFn(plan.command[0], plan.command.slice(1), { stdio: 'ignore', ...opts });
    r.unref?.();
    return { ...plan };
  }
  const child = spawnFn(plan.command[0], plan.command.slice(1), { detached: true, stdio: 'ignore', ...opts });
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
    const pmap = personaByHashtag();
    for (const s of sessions) {
      const hashtag = s.name.replace(/^tele-/, '');
      const persona = pmap[hashtag];
      const label = persona ? `${formatPersona(persona)}  ` : '';
      console.log(`  ${label}${s.name}  (pid ${s.pid})  → topic #${hashtag}`);
    }
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

  const interactive = argv.includes('--interactive') || argv.includes('-i');
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
  const plan = buildSpawnPlan({ interactive, permissionMode });
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
