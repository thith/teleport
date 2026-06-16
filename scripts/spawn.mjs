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

export const SPAWN_PROMPT = 'Telegram me and wait for instructions';

// Session names must be shell/argv-safe — they're interpolated into the printed
// teardown command and passed to `screen`. Reject anything else (review C-Minor).
export const SAFE_SESSION_NAME = /^[A-Za-z0-9_.-]+$/;

/** Short, unique screen session name (for teardown). 48 bits of entropy. */
export function genSessionName(rand = () => crypto.randomBytes(6).toString('hex')) {
  return `tele-${rand()}`;
}

/**
 * Pure: compute the launch plan. No side effects, so it's unit-testable.
 * Returns `{ mode, sessionName, command: [...], teardown }`.
 */
export function buildSpawnPlan({ interactive = false, sessionName, prompt = SPAWN_PROMPT } = {}) {
  if (interactive) {
    const name = sessionName || genSessionName();
    if (!SAFE_SESSION_NAME.test(name)) {
      throw new Error(`spawn: unsafe session name ${JSON.stringify(name)} (allowed: A-Za-z0-9_.-)`);
    }
    return {
      mode: 'interactive',
      sessionName: name,
      // `screen -dmS` starts a DETACHED session running an interactive `claude`
      // seeded with the positional prompt → interactive (subscription) billing.
      command: ['screen', '-dmS', name, 'claude', prompt],
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
    // if claude failed to exec inside it (review C-Major). Tiny settle delay.
    execFileSync('sleep', ['0.5'], { stdio: 'ignore' });
    if (!screenSessionExists(plan.sessionName)) {
      console.error(`[spawn] FAILED: screen session "${plan.sessionName}" not found after launch (claude or screen may have errored). Check: screen -ls`);
      process.exit(1);
    }
    console.log(`[spawn] interactive agent launched in screen session "${plan.sessionName}" (subscription billing).`);
    console.log(`[spawn] it will greet you on Telegram shortly (its own persona topic).`);
    console.log(`[spawn] teardown: ${plan.teardown}`);
  } else {
    console.log(`[spawn] headless agent launched (pid ${result.pid}, Agent SDK pool). Auto-exits when done.`);
    console.log(`[spawn] it will greet you on Telegram shortly (its own persona topic).`);
  }
}
