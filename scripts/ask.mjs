// ask.mjs — ASK: agent hỏi-đáp agent, user-triggered (RFC 10).
//
// The 3rd inter-agent primitive (after whisper = human→agent, handover = agent→agent
// transfer). ASK is a round-trip Q&A between two LIVE agents in the SAME group, to
// pull information — it does NOT transfer work and does NOT raise privilege.
//
//   ASK   (A→B): echo "<question>" | ask.mjs --to <persona|#hashtag|convoId> [--from-convo N]
//   REPLY (B→A): echo "<answer>"   | ask.mjs --reply --to <A-convoId>        [--from-convo N]
//
// Mechanism (reuses handover infra): the asker submits the question to the SYSTEM,
// which injects a `prompt-convo-<B>.json` into B's queue (B's tele-listen picks it
// up). B answers with `--reply`, injecting back into A's queue. Neither agent writes
// into the other's Telegram topic — no cross-write. Each agent narrates briefly in
// its own topic.
//
// SCOPE (security): SAME chatId only. The target is resolved against the asker's OWN
// group's live topics; a persona in a DIFFERENT group is `not_found` (cross-group
// ask is forbidden — "như gọi hồn"). No `--chat-id` override here, by design.
//
// Called by an AGENT (no TTY) → routing outcomes are EXIT CODES + structured stdout
// (reuses handover's EXIT enum) for the source agent to interpret and tell the user.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';

import { formatPersona } from './persona.mjs';
import { peekPersona } from './persona-store.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { resolveConvoIdFromEnv } from './convo-registry.mjs';
import { buildCombinedPromptData, DEFAULT_TMP_DIR, mergeOrSpoolPrompt } from './tele-listen.mjs';
import { loadEnvFromFile } from './send-telegram.mjs';
import { getLastAliveMs, DEFAULT_FRESH_MS as ALIVE_FRESH_MS } from './listener-alive.mjs';
import {
  normalizeTarget, listLiveTopics, matchTarget, formatTopicList,
  resolveChatIds, EXIT,
} from './handover.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

export const USAGE = `usage:
  ASK:   echo "<question>" | ask.mjs --to <persona|#hashtag|convoId> [--from-convo N]
  REPLY: echo "<answer>"   | ask.mjs --reply --to <A-convoId>        [--from-convo N]`;

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

export function parseAskArgs(argv) {
  const out = { to: null, reply: false, fromConvo: null, text: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') out.to = argv[++i];
    else if (a.startsWith('--to=')) out.to = a.slice('--to='.length);
    else if (a === '--reply') out.reply = true;
    else if (a === '--from-convo') out.fromConvo = argv[++i];
    else if (a.startsWith('--from-convo=')) out.fromConvo = a.slice('--from-convo='.length);
    else if (!a.startsWith('-') && out.text == null) out.text = a; // optional inline question/answer
  }
  if (!out.to) out.error = 'missing --to <persona|#hashtag|convoId>';
  else if (out.fromConvo != null && !/^\d+$/.test(String(out.fromConvo))) {
    out.error = `--from-convo must be a positive integer convoId (got "${out.fromConvo}")`;
  }
  return out;
}

// Attribution line shared by both prompt builders.
function attribution(sourceConvoId) {
  const persona = peekPersona(sourceConvoId);
  const from = persona ? formatPersona(persona) : 'một agent khác';
  const tag = sourceConvoId != null ? ` (topic #${shortConvoHash(sourceConvoId)})` : '';
  const fromRef = {
    persona,
    convoId: sourceConvoId != null ? String(sourceConvoId) : null,
    hashtag: sourceConvoId != null ? `#${shortConvoHash(sourceConvoId)}` : null,
  };
  return { from, tag, fromRef };
}

// Shape a synthetic prompt (handover-style) then attach an ASK-specific field.
function buildPromptBase({ targetConvoId, targetChatId, text, nowSec }) {
  const synthMsg = { message_id: null, chat: { id: targetChatId, type: 'private' }, from: null, text, date: nowSec };
  const base = buildCombinedPromptData([{ msg: synthMsg, update: { update_id: null } }], null, targetConvoId, null);
  base.messageId = null;
  base.fromRole = 'agent-ask';   // non-privileged, like 'handover'
  base.fromUserId = null;
  base.fromMember = null;        // ASK never raises privilege (context, not authority)
  base.attachments = [];
  return base;
}

// ASK prompt injected into B's queue.
export function buildAskPrompt({ targetConvoId, targetChatId, sourceConvoId, question, nowSec }) {
  const { from, tag, fromRef } = attribution(sourceConvoId);
  const q = String(question).trim();
  const text = `❓ ${from}${tag} hỏi bạn:\n\n${q}\n\n→ Trả lời (đọc/phân tích thôi, ngắn gọn) bằng:\n   node ../teleport/scripts/ask.mjs --reply --to ${sourceConvoId} "<câu trả lời>"\nrồi tự kể ngắn trong topic của bạn.`;
  const base = buildPromptBase({ targetConvoId, targetChatId, text, nowSec });
  base.fromName = from;
  base.ask = { from: fromRef, replyTo: sourceConvoId != null ? String(sourceConvoId) : null, question: q };
  return base;
}

// REPLY prompt injected back into A's queue.
export function buildReplyPrompt({ targetConvoId, targetChatId, sourceConvoId, answer, nowSec }) {
  const { from, tag, fromRef } = attribution(sourceConvoId);
  const ans = String(answer).trim();
  const text = `💬 ${from}${tag} trả lời câu bạn vừa hỏi:\n\n${ans}\n\n→ Apply rồi tự kể NGẮN GỌN cho user (không cần verbatim).`;
  const base = buildPromptBase({ targetConvoId, targetChatId, text, nowSec });
  base.fromName = from;
  base.askReply = { from: fromRef, answer: ans };
  return base;
}

// Question/answer text: inline arg, or stdin. CONTRACT: a stdin caller MUST close
// the pipe (EOF) — `readFile(0)` blocks until EOF, so an agent that leaves an
// inherited stdin pipe open would hang. Prefer the inline arg when unsure. (review M2)
export function readText(args, deps = {}) {
  const readFile = deps.readFileSync ?? fs.readFileSync;
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
  if (args.text != null && String(args.text).trim()) return String(args.text);
  if (stdinIsTTY) return '';
  return readFile(0, 'utf8');
}

// ── Orchestration (testable; injectable deps) ─────────────────────────────────

// Resolve the target within the asker's OWN group and build the right prompt.
// Returns { code, message, promptFile?, promptObj?, match? }. Does NOT write.
export function planAsk({ args, sourceConvoId, text, envFile = {}, nowSec, deps = {} }) {
  const store = deps.readTopicsStore ? deps.readTopicsStore() : readTopicsStore();
  // SAME-group scope: resolveChatIds with NO override → the asker's own chat.
  const { chatIds } = (deps.resolveChatIds ?? resolveChatIds)({ envFile });
  if (!chatIds.length) return { code: EXIT.USAGE, message: 'no admin chat configured for this project (cwd)' };
  const live = listLiveTopics(store, chatIds);
  const target = normalizeTarget(args.to);
  const m = matchTarget(target, live);
  if (m.status === 'not_found') {
    return { code: EXIT.NOT_FOUND, message: `not-found "${args.to}" in this group; live: ${formatTopicList(live) || '(none)'} — cross-group ask is forbidden (ask an admin)` };
  }
  if (m.status === 'ambiguous') {
    return { code: EXIT.AMBIGUOUS, message: `ambiguous "${args.to}": ${formatTopicList(m.candidates)} — redirect with --to "#<hashtag>"` };
  }
  const { match } = m;
  // Don't ask/reply to YOURSELF (would inject into your own queue). Harmless but
  // confusing — refuse early. (review M3)
  if (String(match.convoId) === String(sourceConvoId)) {
    return { code: EXIT.USAGE, message: `target is your own convo (${sourceConvoId}) — cannot ask yourself` };
  }
  const promptObj = args.reply
    ? buildReplyPrompt({ targetConvoId: match.convoId, targetChatId: match.chatId, sourceConvoId, answer: text, nowSec })
    : buildAskPrompt({ targetConvoId: match.convoId, targetChatId: match.chatId, sourceConvoId, question: text, nowSec });
  const promptFile = path.join(DEFAULT_TMP_DIR, `prompt-convo-${match.convoId}.json`);
  return { code: EXIT.OK, match, promptFile, promptObj, shadowed: m.shadowed };
}

// RFC 03 §5.1: the target mailbox is no longer a single O_EXCL slot that bounces
// `EEXIST` when busy. The old T1 auto-retry + T3 "RETRY-LATER give-up" path
// (writePromptWithRetry / RETRY / RETRY_LATER_MIN) is removed — a busy target now
// COALESCES via mergeOrSpoolPrompt (durable), so there is nothing to retry.

// ── T2: non-gating liveness advisory (kept) ───────────────────────────────────
//
// The prompt is ALWAYS written (a dead target's prompt just waits harmlessly).
// But if the target's listener heartbeat is stale (or absent), nobody is
// draining that mailbox right now — so we tell the caller, who may need to nudge
// the target to restart its listener before waiting for a reply. Threshold
// reuses listener-alive's DEFAULT_FRESH_MS (30 min) — no new constant. Returns
// the advisory string, or null when the target looks healthy.
export function inactivityNote({ convoId, hashtag, now = Date.now(), freshMs = ALIVE_FRESH_MS, deps = {} }) {
  const getFn = deps.getLastAliveMs ?? getLastAliveMs;
  const last = getFn(convoId);
  if (last != null && now - last <= freshMs) return null; // fresh heartbeat → healthy
  const stale = last == null
    ? 'không thấy listener nào đang chạy'
    : `listener im ~${Math.max(1, Math.round((now - last) / 60000))} phút`;
  return `[ask] ⚠️ đã ghi prompt OK nhưng #${hashtag} có vẻ không active (${stale}) — có thể cần nhờ họ bật lại listener trước khi chờ trả lời.`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const log = (m) => console.log(m);
  const err = (m) => console.error(m);
  const args = parseAskArgs(process.argv.slice(2));
  if (args.error) { err(`[ask] ${args.error}\n${USAGE}`); process.exit(EXIT.USAGE); }

  let text = '';
  try { text = readText(args); } catch (e) { err(`[ask] cannot read text: ${e.message}`); process.exit(EXIT.USAGE); }
  const kind = args.reply ? 'answer' : 'question';
  if (!text.trim()) { err(`[ask] empty ${kind} (pass inline or pipe via stdin)\n${USAGE}`); process.exit(EXIT.USAGE); }

  const sourceConvoId = args.fromConvo ?? resolveConvoIdFromEnv({ argConvo: null }).convoId;
  if (sourceConvoId == null) {
    err('[ask] no source convo: pass --from-convo N or run inside a native session (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID)');
    process.exit(EXIT.USAGE);
  }

  const envFile = loadEnvFromFile(ENV_FILE);
  const plan = planAsk({ args, sourceConvoId, text, envFile, nowSec: Math.floor(Date.now() / 1000) });
  if (plan.code !== EXIT.OK) { log(`[ask] ${plan.message}`); process.exit(plan.code); }

  // RFC 03 §5.1 — DURABLE, non-blocking inject: coalesce into the target's OPEN
  // prompt (or spool a fresh one alongside a claimed batch) via the shared
  // mergeOrSpoolPrompt, serialized against the target's listener by the per-convo
  // write-lock. Replaces the old O_EXCL writePromptWithRetry: a BUSY target no
  // longer bounces (EEXIST → retry → RETRY-LATER give-up) — the message is queued
  // durably and delivered when the target processes its prompt.
  let outcome;
  try {
    const writeLock = path.join(DEFAULT_TMP_DIR, `prompt-write-${plan.match.convoId}.lock`);
    outcome = await mergeOrSpoolPrompt(plan.promptFile, plan.promptObj, writeLock);
  } catch (e) {
    // Only a real write/lock failure reaches here now (disk, lock exhaustion) —
    // durable delivery was NOT achieved, so this is a hard error (never report queued).
    err(`[ask] write failed: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
  const verb = args.reply ? 'reply' : 'ask';
  const how = outcome === 'merged' ? 'coalesced into pending prompt' : 'queued';
  log(`[ask] ${verb} injected → convo ${plan.match.convoId} #${plan.match.hashtag} (${how}, durable — will be delivered)`);
  if (plan.shadowed && plan.shadowed.length) {
    log(`[ask] note: ${plan.shadowed.length} older topic(s) share that persona name — picked the most recent; redirect with --to "#${plan.match.hashtag}"`);
  }
  // T2 — non-gating liveness advisory (target may not be draining its mailbox).
  const note = inactivityNote({ convoId: plan.match.convoId, hashtag: plan.match.hashtag });
  if (note) log(note);
  process.exit(EXIT.OK);
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  main().catch((e) => { console.error(`[ask] ${e instanceof Error ? e.stack : String(e)}`); process.exit(EXIT.ERROR); });
}
