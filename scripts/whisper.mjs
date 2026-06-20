// `/whisper #<hash> <text>` — a daemon command (no project). Injects a DISCREET
// steer into a live topic: nothing is posted in the group; the target agent
// picks it up as a prompt with `whisper:true` + the whisperer's real role (so its
// sensitive-action gate still applies). Identity comes from the daemon via env
// (TELE_FROM_*). Prints a confirmation to stdout for the daemon to relay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTopicsStore } from './topics-store.mjs';
import { listLiveTopics, normalizeTarget, matchTarget, writePromptExclusive } from './handover.mjs';
import { DEFAULT_TMP_DIR } from './tele-listen.mjs';
import { shortConvoHash } from './send-telegram.mjs';
import { readProjectsConfig, resolveDefaultChatId, projectEntries } from './projects-config.mjs';

// Build the injected prompt. `whisper:true` marks it discreet; `messageId:null`
// marks it injected (not a real Telegram message).
export function buildWhisperPrompt({ targetConvoId, targetChatId, fromUserId, fromName, fromRole, text }) {
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
    whisper: true,
  };
}

// All group chat ids (catch-all + dedicated) to search for the live topic.
function groupChatIds(config) {
  const ids = new Set();
  const def = resolveDefaultChatId(config, { env: process.env, envFile: {} });
  if (def) ids.add(String(def));
  for (const [, p] of projectEntries(config)) if (p && p.chatId) ids.add(String(p.chatId));
  return [...ids];
}

// Returns { ok, message }. Pure-ish (deps injectable for tests).
export function doWhisper(argv, { from = {}, config = readProjectsConfig(), store = readTopicsStore(), tmpDir = DEFAULT_TMP_DIR, writePrompt = writePromptExclusive } = {}) {
  const target = argv[0];
  const text = argv.slice(1).join(' ').trim();
  if (!target) return { ok: false, message: 'usage: /whisper #<hash|persona|convoId> <text>' };
  if (!text) return { ok: false, message: 'whisper needs a message after the target' };
  const matched = matchTarget(normalizeTarget(target), listLiveTopics(store, groupChatIds(config)));
  if (matched.status !== 'found') {
    return { ok: false, message: `target ${target} ${matched.status === 'ambiguous' ? 'is ambiguous' : 'not found among live topics'}.` };
  }
  const { convoId, chatId } = matched.match;
  const prompt = buildWhisperPrompt({
    targetConvoId: convoId, targetChatId: chatId,
    fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text,
  });
  const promptFile = path.join(tmpDir, `prompt-convo-${convoId}.json`);
  try {
    writePrompt(prompt, promptFile);
  } catch (e) {
    if (e && e.code === 'EEXIST') return { ok: false, message: `#${shortConvoHash(convoId)} đang bận (prompt trước chưa xử lý) — thử lại sau.` };
    throw e;
  }
  return { ok: true, message: `🤫 whispered to #${shortConvoHash(convoId)} (kín, không hiện trong group).` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const from = { id: process.env.TELE_FROM_ID, role: process.env.TELE_FROM_ROLE, name: process.env.TELE_FROM_NAME };
  const res = doWhisper(process.argv.slice(2), { from });
  process.stdout.write((res.message || '') + '\n');
  process.exit(res.ok ? 0 : 1);
}
