// `/broadcast <text>` — a daemon command (no project). Injects ONE system message
// into EVERY live topic's prompt-queue (whisper × all). Use-case: tell every running
// agent "reload the telegram guide, rules changed". Nothing posted to a group; each
// agent picks it up as a prompt with `broadcast:true` and applies it (may ack briefly).
// Admin-only (gated by commands.json minRole). Identity from the daemon via TELE_FROM_*.
//
//   /broadcast <text>            → every group the admin configures (RFC 11)
//   /broadcast --chat <id> <text> → limit to one group
//
// Durable fan-out (RFC 03 §5.1): each topic's prompt is coalesced/spooled under its
// per-convo write-lock — a busy topic no longer bounces (nothing skipped); a dead
// agent's prompt just waits. Prints a sent summary for the daemon to relay.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTopicsStore } from './topics-store.mjs';
import { listLiveTopics } from './handover.mjs';
import { durableWrite } from './steer.mjs';
import { DEFAULT_TMP_DIR } from './tele-listen.mjs';
import { readProjectsConfig, resolveDefaultChatId, projectEntries } from './projects-config.mjs';

export const USAGE = 'usage: /broadcast [--chat <id>] <text>';

// All group chat ids (catch-all + dedicated) — the default broadcast scope.
export function groupChatIds(config, { env = process.env, envFile = {} } = {}) {
  const ids = new Set();
  const def = resolveDefaultChatId(config, { env, envFile });
  if (def) ids.add(String(def));
  for (const [, p] of projectEntries(config)) if (p && p.chatId && String(p.chatId).trim()) ids.add(String(p.chatId).trim());
  return [...ids];
}

// Parse argv → { chat, text, error }. `--chat <id>` (or `--chat=<id>`) optional first;
// everything else joins into the system message text.
export function parseBroadcastArgs(argv) {
  const out = { chat: null, text: '', error: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chat') out.chat = argv[++i];
    else if (a.startsWith('--chat=')) out.chat = a.slice('--chat='.length);
    else rest.push(a);
  }
  out.text = rest.join(' ').trim();
  if (!out.text) out.error = USAGE;
  return out;
}

// The injected system prompt. `broadcast:true` marks it; non-privileged `fromRole`
// (the sender's real role is carried for the receiver's sensitive-action gate, but
// 'broadcast' itself grants nothing). `messageId:null` = injected, not a real message.
export function buildBroadcastPrompt({ targetConvoId, targetChatId, fromUserId, fromName, fromRole, text }) {
  return {
    text,
    messageId: null,
    chatId: targetChatId == null ? null : String(targetChatId),
    fromUserId: fromUserId == null || fromUserId === '' ? null : String(fromUserId),
    fromName: fromName || 'admin',
    fromRole: fromRole || 'member',
    fromMember: null,
    replyToMessageId: null,
    replyToText: null,
    quotedText: null,
    timestamp: Math.floor(Date.now() / 1000),
    attachments: [],
    convoId: Number(targetConvoId),
    broadcast: { from: { role: fromRole || 'member' }, text },
  };
}

// Fan out to every live topic. Returns { ok, sent, skipped, total, message }.
// Pure-ish: deps injectable for tests.
export async function doBroadcast(argv, {
  from = {}, config = readProjectsConfig(), store = readTopicsStore(),
  tmpDir = DEFAULT_TMP_DIR, writePrompt = durableWrite, env = process.env, envFile = {},
} = {}) {
  const args = parseBroadcastArgs(argv);
  if (args.error) return { ok: false, message: args.error };
  const chatIds = args.chat ? [String(args.chat)] : groupChatIds(config, { env, envFile });
  const live = listLiveTopics(store, chatIds);
  if (!live.length) return { ok: false, message: '📢 broadcast: no live topics found (nothing sent).' };

  // RFC 03 §5.1: durable coalesce/spool into each topic — a busy topic no longer
  // bounces, so nothing is skipped; a hard write/lock failure (rare) is surfaced.
  let sent = 0; const failed = [];
  for (const t of live) {
    const prompt = buildBroadcastPrompt({
      targetConvoId: t.convoId, targetChatId: t.chatId,
      fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text: args.text,
    });
    const promptFile = path.join(tmpDir, `prompt-convo-${t.convoId}.json`);
    try {
      await writePrompt(prompt, promptFile);
      sent++;
    } catch (e) {
      failed.push(t.hashtag);   // real write/lock failure (not busy) → count + continue fan-out
    }
  }
  const msg = `📢 broadcast: sent ${sent}, failed ${failed.length}${failed.length ? ` (${failed.map((h) => `#${h}`).join(', ')})` : ''} / ${live.length} live topic(s) — durable.`;
  return { ok: true, sent, skipped: failed.length, total: live.length, message: msg };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const from = { id: process.env.TELE_FROM_ID, role: process.env.TELE_FROM_ROLE, name: process.env.TELE_FROM_NAME };
  const res = await doBroadcast(process.argv.slice(2), { from });
  process.stdout.write((res.message || '') + '\n');
  process.exit(res.ok ? 0 : 1);
}
