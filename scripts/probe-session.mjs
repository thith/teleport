#!/usr/bin/env node
// Probe the agent's process environment for any "session id" candidate the
// teleport convoId design could derive from. Run this from inside each of
// Claude Code, Codex, and Gemini to see which env vars are exposed.
//
// Usage:
//   node ../teleport/scripts/probe-session.mjs

const candidates = [
  // Claude Code
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CONVERSATION_ID',
  'ANTHROPIC_SESSION_ID',
  // Codex
  'CODEX_SESSION_ID',
  'CODEX_COMPANION_SESSION_ID',
  'CODEX_THREAD_ID',
  'OPENAI_SESSION_ID',
  // Gemini
  'GEMINI_SESSION_ID',
  'GEMINI_CONVERSATION_ID',
  'GOOGLE_AI_SESSION_ID',
  // Antigravity
  'ANTIGRAVITY_SESSION_ID',
  // Generic / future
  'AGENT_SESSION_ID',
  'AI_AGENT_SESSION_ID',
  'TELEPORT_CONVO_TOKEN',
  // Useful identifier hints (not for convo, just for cross-reference)
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'AI_AGENT',
];

console.log('=== Teleport session env probe ===');
console.log(`platform: ${process.platform}  node: ${process.version}  pid: ${process.pid}  ppid: ${process.ppid}`);
console.log();

let foundAny = false;
for (const name of candidates) {
  const v = process.env[name];
  if (v != null && v !== '') {
    console.log(`✓ ${name} = ${v}`);
    foundAny = true;
  } else {
    console.log(`· ${name} (unset)`);
  }
}

if (!foundAny) {
  console.log();
  console.log('No known session env var was set.');
}

// Dump anything else that smells like a session/convo identifier.
console.log();
console.log('=== Other env vars matching /session|conv|thread|agent/i ===');
for (const [k, v] of Object.entries(process.env)) {
  if (candidates.includes(k)) continue;
  if (/session|conv|thread|agent/i.test(k)) {
    console.log(`  ${k} = ${v}`);
  }
}
