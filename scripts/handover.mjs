// Handover between convos/topics (RFC 05).
//
// "handover cho <target>" — bàn giao việc từ topic agent nguồn sang một topic
// khác, ngay ở tầng Telegram. Hai ý định tách bạch:
//
//   (i)  --to <target>  → topic ĐÃ CÓ (persona name / #hashtag / convoId).
//        Resolve target trong các convo đang sống (topics.json), rồi GHI THẲNG
//        một prompt file `prompt-convo-<N>.json` (đúng shape buildCombinedPromptData)
//        để agent target nhặt làm prompt kế tiếp. Inject = giao NON-PRIVILEGED:
//        fromRole:'handover', notes chỉ là context, KHÔNG nâng quyền.
//
//   (ii) --new           → topic HOÀN TOÀN MỚI. Spawn một claude mới với handover
//        làm seed prompt (qua spawn.buildSpawnPlan). Billable + sensitive → bắt
//        buộc --by-role admin|maintainer (fail-closed exit 6).
//
// Vì sao ghi prompt file (không "gửi 1 message"): một message bot tự post vào
// topic bị listener lọc thành orphan, KHÔNG thành prompt cho agent. Đường duy
// nhất tới một agent đang chạy là file prompt mà waitOnceSupervisor nhặt.
//
// Script do AGENT gọi (không TTY) → mọi nhánh "cần người quyết" trả về bằng
// EXIT CODE + stdout có cấu trúc (xem EXIT) để agent nguồn diễn giải & hỏi user.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';

import { formatPersona, PERSONA_POOL, personaForConvo } from './persona.mjs';
import { peekPersona } from './persona-store.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { listAliveConvos } from './listener-alive.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { readProjectsConfig, resolveProjectConfig, resolveProjectKey, adminIdsFrom, resolveDefaultChatId } from './projects-config.mjs';
import { resolveConvoIdFromEnv, validateConvoIdString } from './convo-registry.mjs';

/** True iff `s` is a convoId the listener can actually watch (positive,
 * safe-integer, no leading zero) — i.e. `prompt-convo-<s>.json` is a path some
 * `tele-listen --convo <s>` resolves to. */
function isWatchableConvoId(s) {
  try { validateConvoIdString(String(s)); return true; } catch { return false; }
}
import { buildCombinedPromptData, DEFAULT_TMP_DIR, mergeOrSpoolPrompt } from './tele-listen.mjs';
import { loadEnvFromFile, parseAdminChatIds } from './send-telegram.mjs';
import { buildSpawnPlan, runSpawn, genSessionSeed, listSpawnSessions, hasBinary } from './spawn.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

// Fixed exit-code enum (RFC 05 §2.5). The source agent parses these to decide
// what to tell the user. Do NOT reuse 1 for routing outcomes (1 = generic
// infra error, kept distinct from the structured 2–6 below).
export const EXIT = {
  OK: 0,
  ERROR: 1,        // unexpected infra error
  USAGE: 2,        // bad flags / empty notes / no source convo
  BUSY: 3,         // target already has an unconsumed prompt (no overwrite)
  NOT_FOUND: 4,    // --to matched no live topic
  AMBIGUOUS: 5,    // --to matched ≥2 live topics (persona-name collision)
  FORBIDDEN: 6,    // --new but --by-role not admin/maintainer
};

// `--ack` targets an exact convoId (the source's, lifted from the received
// `handover.from.convoId`) — no persona/hashtag resolution needed, so it never
// returns NOT_FOUND/AMBIGUOUS. Kept distinct from the (i)/(ii) branches below.

const PRIVILEGED_ROLES = new Set(['admin', 'maintainer']);

/** Fail-closed role gate for --new (spawn = billable + sensitive). Unknown/typo
 * roles are non-privileged (least privilege), matching the teleport role model. */
export function isPrivilegedRole(role) {
  return PRIVILEGED_ROLES.has(role);
}

const USAGE = `Usage:
  cat notes.md | node handover.mjs --to <persona|#hashtag|convoId> [--from-convo N] [--chat-id ID]
  cat notes.md | node handover.mjs --new --by-role <admin|maintainer> [--from-convo N]
  node handover.mjs --to "Cú" --notes-file ./tmp/handover.md
  node handover.mjs --ack <sourceConvoId> [--from-convo N]   # receiver confirms receipt back to source
Notes come from stdin (default) or --notes-file. See teleport-docs/rfc/05-handover.md.`;

/**
 * Parse argv. Returns `{ to, isNew, notesFile, fromConvo, byRole, chatId, ack, error }`.
 * `error` (string) set on a usage violation; caller exits EXIT.USAGE.
 */
export function parseArgs(argv) {
  const out = { to: null, isNew: false, notesFile: null, fromConvo: null, byRole: null, chatId: null, ack: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const needVal = (name) => {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) { out.error = `${name} requires a value`; return null; }
      i++;
      return v;
    };
    if (a === '--to') { const v = needVal('--to'); if (v != null) out.to = v.trim(); continue; }
    if (a === '--new') { out.isNew = true; continue; }
    if (a === '--notes-file') { const v = needVal('--notes-file'); if (v != null) out.notesFile = v; continue; }
    if (a === '--from-convo') { const v = needVal('--from-convo'); if (v != null) out.fromConvo = v.trim(); continue; }
    if (a === '--by-role') { const v = needVal('--by-role'); if (v != null) out.byRole = v.trim(); continue; }
    if (a === '--chat-id') { const v = needVal('--chat-id'); if (v != null) out.chatId = v.trim(); continue; }
    if (a === '--ack') { const v = needVal('--ack'); if (v != null) out.ack = v.trim(); continue; }
    out.error = `unknown argument: ${a}`;
  }
  if (out.error) return out;
  if (out.fromConvo != null && !isWatchableConvoId(out.fromConvo)) {
    out.error = `--from-convo must be a positive integer convoId (got "${out.fromConvo}")`;
    return out;
  }
  if (out.chatId != null && !/^-?\d+$/.test(out.chatId)) {
    out.error = `--chat-id must be a numeric chat id (got "${out.chatId}")`;
    return out;
  }
  if (out.ack != null) {
    if (out.to || out.isNew) { out.error = '--ack is mutually exclusive with --to/--new'; return out; }
    if (!isWatchableConvoId(out.ack)) { out.error = `--ack must be a positive integer convoId (got "${out.ack}")`; return out; }
    return out;
  }
  if (out.to && out.isNew) { out.error = '--to and --new are mutually exclusive'; return out; }
  if (!out.to && !out.isNew) { out.error = 'one of --to, --new, or --ack is required'; return out; }
  if (out.isNew && !out.byRole) { out.error = '--new requires --by-role <admin|maintainer>'; return out; }
  return out;
}

/**
 * Classify a raw --to target. Returns `{ kind, value }`:
 * - hashtag: leading `#`, or the shortConvoHash shape (`[a-j]` + 7 digits, or `t` + digits)
 * - convoId: all-digits
 * - name:    anything else (persona name, case-insensitive)
 */
export function normalizeTarget(raw) {
  const s = String(raw).trim();
  if (s.startsWith('#')) return { kind: 'hashtag', value: s.slice(1).toLowerCase() };
  if (/^[a-j]\d{7}$/i.test(s) || /^t\d+$/i.test(s)) return { kind: 'hashtag', value: s.toLowerCase() };
  if (/^\d+$/.test(s)) return { kind: 'convoId', value: s };
  return { kind: 'name', value: s };
}

/**
 * Enumerate live topics across `chatIds` from a topics.json store. Each entry:
 * `{ chatId, convoId, threadId, persona, hashtag }`. Underscore-prefixed store
 * metadata keys are skipped (RFC 01 topics-store convention).
 */
export function listLiveTopics(store, chatIds) {
  const wanted = new Set(chatIds.map(String));
  const out = [];
  for (const [chatId, entry] of Object.entries(store || {})) {
    if (!wanted.has(String(chatId)) || !entry || typeof entry !== 'object') continue;
    for (const [key, threadId] of Object.entries(entry)) {
      if (key.startsWith('_')) continue;
      if (!(typeof threadId === 'number' && threadId > 0)) continue;
      // Only numeric convoId keys are valid handover targets: the listener
      // watches `prompt-convo-<positive-int>.json`. A legacy/shared project-code
      // key (e.g. "luni", "tea_game") would match by name/hashtag but the
      // injected file could never be picked up → silent permanent hang + a false
      // exit-0 baton no one catches (review C1). Skip it.
      if (!isWatchableConvoId(key)) continue;
      const ts = (entry._ts && typeof entry._ts[key] === 'number') ? entry._ts[key] : 0;
      out.push({
        chatId: String(chatId),
        convoId: key,
        threadId,
        ts,                       // last-use epoch_ms (RFC 01 topics-store _ts), 0 if unknown
        persona: peekPersona(key),
        hashtag: shortConvoHash(key),
      });
    }
  }
  return out;
}

/**
 * Steer target pool (RFC 14): live topics (`listLiveTopics`) PLUS live-but-
 * topic-less convos (a session that only DM'd the owner, never posted a group
 * topic — see `listener-alive`). Used by the steer commands (`/whisper`,
 * `/instruct`) so `#hash`/convoId of such a session resolves instead of
 * "not found among live topics".
 *
 * Merge rule: a convo present as a topic WINS (keeps its real chatId/threadId);
 * alive-only entries carry `chatId:null`/`threadId:null` + `source:'alive'`, are
 * `isWatchableConvoId`-filtered, and get a deterministic `personaForConvo` (so
 * the display persona matches the `--dm` sign tag). Alive-only entries are
 * matched by hashtag/convoId only — `matchTarget` skips them for persona-name
 * (names are reused, so a name could resolve the wrong DM-only session).
 *
 * NOT used by ask/broadcast/handover — those keep their topic-only / group-scope
 * invariants (esp. ask's same-group rule, which alive-only chatId:null breaks).
 */
export function listSteerableTargets(store, chatIds, { aliveDir, now = Date.now(), freshMs } = {}) {
  const out = listLiveTopics(store, chatIds);
  const seen = new Set(out.map((t) => String(t.convoId)));
  const aliveOpts = { now };
  if (aliveDir !== undefined) aliveOpts.dir = aliveDir;
  if (freshMs !== undefined) aliveOpts.freshMs = freshMs;
  for (const { convoId, ts } of listAliveConvos(aliveOpts)) {
    const id = String(convoId);
    if (seen.has(id) || !isWatchableConvoId(id)) continue;
    seen.add(id);
    out.push({
      chatId: null,
      convoId: id,
      threadId: null,
      ts,
      persona: personaForConvo(id),
      hashtag: shortConvoHash(id),
      source: 'alive',
    });
  }
  return out;
}

/**
 * Match a normalized target against live topics. Returns:
 * - `{ status: 'found', match, shadowed? }`
 * - `{ status: 'ambiguous', candidates }`
 * - `{ status: 'not_found' }`
 *
 * Hashtag/convoId are unique (hashtag is derived 1:1 from convoId), so they
 * never collide. Persona NAMES are reused (~40-pair pool, index = hash % 40), so
 * a name can match several historical topics. The relevant one is almost always
 * the most RECENTLY ACTIVE → pick the freshest by `_ts` and report the others as
 * `shadowed` (so the user can redirect with `--to "#hashtag"`). Only a genuine
 * recency TIE (equal/zero `_ts` at the top) stays ambiguous.
 */
export function matchTarget(target, liveTopics) {
  let hits;
  if (target.kind === 'hashtag') {
    hits = liveTopics.filter((t) => t.hashtag === target.value);
  } else if (target.kind === 'convoId') {
    hits = liveTopics.filter((t) => String(t.convoId) === target.value);
  } else {
    // Persona names have ASCII initials, so plain toLowerCase() is correct and
    // ICU-independent (and matches the hashtag casing rule in normalizeTarget).
    // RFC 14: skip alive-only (topic-less) entries here — persona names are
    // reused across the ~40-pair pool, so a name could resolve the wrong DM-only
    // session. Alive-only targets are reachable by hashtag/convoId (unique) only.
    const want = target.value.toLowerCase();
    hits = liveTopics.filter((t) => t.source !== 'alive' && t.persona && t.persona.name.toLowerCase() === want);
  }
  if (hits.length === 0) return { status: 'not_found' };
  if (hits.length === 1) return { status: 'found', match: hits[0] };
  // ≥2 hits: prefer the most recently active. Tie at the top (incl. all-zero
  // ts, i.e. no recency signal) → ambiguous, let the human disambiguate.
  const sorted = [...hits].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if ((sorted[0].ts || 0) > (sorted[1].ts || 0)) {
    return { status: 'found', match: sorted[0], shadowed: sorted.slice(1) };
  }
  return { status: 'ambiguous', candidates: sorted };
}

/** Render a live-topic list as `🐱 Mèo #t1234, 🐷 Heo #e5424020` for stdout. */
export function formatTopicList(topics) {
  return topics
    .map((t) => `${t.persona ? formatPersona(t.persona) : '?'} #${t.hashtag}`)
    .join(', ');
}

/** The attribution header prepended to handover notes so even a model that
 * ignores the `handover` field sees the baton-pass in plain text. */
export function handoverHeader(sourcePersona, sourceConvoId, targetPersona) {
  const from = sourcePersona ? formatPersona(sourcePersona) : 'agent khác';
  const tag = sourceConvoId != null ? ` (topic #${shortConvoHash(sourceConvoId)})` : '';
  const to = targetPersona ? formatPersona(targetPersona) : 'bạn';
  return `🔁 Handover từ ${from}${tag}. ${to} tiếp quản — đây là handover notes:`;
}

/**
 * Build the prompt object injected into the target's prompt file. Reuses
 * `buildCombinedPromptData` for SHAPE FIDELITY (so a shape change there flows
 * through), then overrides the handover-specific fields:
 * - non-privileged `fromRole:'handover'`, `fromMember:null`
 * - `fromName` = source persona, `attachments:[]` (notes-only)
 * - `messageId:null` (no real Telegram message to --reply-to; receiver acks as a
 *   fresh message routed by --convo)
 * - `handover.from` attribution so the receiver recognizes a legitimate baton-pass
 */
export function buildHandoverPrompt({ targetConvoId, targetChatId, sourceConvoId, notes, nowSec }) {
  const sourcePersona = peekPersona(sourceConvoId);
  const targetPersona = peekPersona(targetConvoId);
  const text = `${handoverHeader(sourcePersona, sourceConvoId, targetPersona)}\n\n${notes.trim()}`;
  const synthMsg = {
    message_id: null,
    chat: { id: targetChatId, type: 'private' },
    from: null,
    text,
    date: nowSec,
  };
  // roles intentionally NOT threaded: §2.2 forbids handover authority deriving
  // from project roles, and from:null makes roleFor/memberFor inert anyway — we
  // override fromRole/fromMember below regardless.
  // projectDescription (5th arg) also intentionally omitted: the target agent is
  // already operating inside its project (so it has that context), the handover
  // notes carry the task context, and threading the SOURCE project's description
  // here would mislabel a cross-group `--chat-id` handover. Descriptive-only, so
  // dropping it changes nothing about authority.
  const base = buildCombinedPromptData([{ msg: synthMsg, update: { update_id: null } }], null, targetConvoId, null);
  base.messageId = null;
  base.fromRole = 'handover';
  base.fromName = sourcePersona ? formatPersona(sourcePersona) : null;
  base.fromUserId = null;
  base.fromMember = null;
  base.attachments = [];
  base.handover = {
    from: {
      persona: sourcePersona,
      convoId: sourceConvoId != null ? String(sourceConvoId) : null,
      hashtag: sourceConvoId != null ? `#${shortConvoHash(sourceConvoId)}` : null,
    },
  };
  return base;
}

/** Best-effort chatId lookup for a convoId across ALL chats in the topics
 * store (not scoped to one project) — handover/ack can legitimately cross
 * groups (RFC 05 §2.5 --chat-id). Purely descriptive metadata on the injected
 * prompt (routing is by convoId → prompt-file path, not chatId); returns
 * `null` if the convoId isn't currently a live topic anywhere, which is fine
 * — the ack still gets written, the source just sees `chatId: null`. */
export function resolveConvoChatId(store, convoId) {
  for (const [chatId, entry] of Object.entries(store || {})) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [key, threadId] of Object.entries(entry)) {
      if (key === String(convoId) && typeof threadId === 'number' && threadId > 0) return chatId;
    }
  }
  return null;
}

/**
 * Build the receipt-confirmation prompt injected back into the ORIGINAL
 * source's queue (RFC 05 ack loop, mirrors ask.mjs's `--reply`). `sourceConvoId`
 * here is the ACKER (the receiver who just adopted the handover); `targetConvoId`
 * is the original handover sender, now on the receiving end of the ack. Lets the
 * source agent know for CERTAIN the handover was picked up, instead of just
 * "injected" (file written, but maybe never read).
 */
export function buildAckPrompt({ targetConvoId, targetChatId, sourceConvoId, note, nowSec }) {
  const ackerPersona = peekPersona(sourceConvoId);
  const from = ackerPersona ? formatPersona(ackerPersona) : 'agent khác';
  const tag = sourceConvoId != null ? ` (topic #${shortConvoHash(sourceConvoId)})` : '';
  const extra = note && note.trim() ? `\n\n${note.trim()}` : '';
  const text = `✅ ${from}${tag} đã NHẬN handover và đang tiếp quản.${extra}`;
  const synthMsg = { message_id: null, chat: { id: targetChatId, type: 'private' }, from: null, text, date: nowSec };
  const base = buildCombinedPromptData([{ msg: synthMsg, update: { update_id: null } }], null, targetConvoId, null);
  base.messageId = null;
  base.fromRole = 'handover-ack';
  base.fromName = from;
  base.fromUserId = null;
  base.fromMember = null;
  base.attachments = [];
  base.handoverAck = {
    from: {
      persona: ackerPersona,
      convoId: sourceConvoId != null ? String(sourceConvoId) : null,
      hashtag: sourceConvoId != null ? `#${shortConvoHash(sourceConvoId)}` : null,
    },
  };
  return base;
}

// RFC 03 §5.1: writePromptExclusive (O_EXCL single-slot write) was RETIRED once all
// senders (ask/handover/whisper/instruct/broadcast) moved to the durable
// mergeOrSpoolPrompt (coalesce/spool under the per-convo write-lock) — a busy target
// no longer bounces EEXIST. Removed to avoid a dead, misleading primitive.

/** Seed prompt for a freshly-spawned agent (--new). It must open its own
 * Telegram channel so the user can follow up, then await instructions. */
export function buildSeedPrompt({ sourceConvoId, notes }) {
  const sourcePersona = peekPersona(sourceConvoId);
  const from = sourcePersona ? formatPersona(sourcePersona) : 'một agent khác';
  return [
    `Bạn vừa được bàn giao việc từ ${from} (handover).`,
    `Hãy GỬI MỘT Telegram message qua \`node ../teleport/scripts/send-telegram.mjs\` để báo bạn đã nhận handover (việc gửi này tạo topic riêng của bạn + tự xưng persona), rồi BẮT ĐẦU LISTEN reply và đợi lệnh.`,
    `KHÔNG tự chạy bất kỳ sensitive action nào (commit/push/deploy/xoá…) cho tới khi có admin xác nhận trong topic.`,
    ``,
    `--- HANDOVER NOTES ---`,
    notes.trim(),
  ].join('\n');
}

/** Resolve the admin chat ids this run is scoped to (cwd project → dedicated
 * group, else shared catch-all), honoring an explicit --chat-id override. */
export function resolveChatIds({ cwd = process.cwd(), env = process.env, envFile = {}, chatIdOverride = null } = {}) {
  if (chatIdOverride) return { chatIds: [String(chatIdOverride)], roles: {} };
  const projectsConfig = readProjectsConfig();
  // A git-worktree folder (e.g. `digesty-frontend-uifix`) is not itself a
  // projects.json key; resolve it to the longest matching project key so it lands
  // in the project's real group instead of the shared `_default` fallback.
  const lookupKey = resolveProjectKey(path.basename(cwd) || '', projectsConfig);
  const fallbackChatId = resolveDefaultChatId(projectsConfig, { env, envFile });
  const projCfg = resolveProjectConfig(lookupKey, { config: projectsConfig, fallbackChatId });
  const chatIds = adminIdsFrom(projCfg, fallbackChatId, parseAdminChatIds).filter(Boolean);
  return { chatIds, roles: projCfg.roles };
}

// Notes come from --notes-file or stdin. CONTRACT: a stdin caller MUST close the
// pipe (EOF) — e.g. `cat notes.md | handover.mjs` or a heredoc, both of which
// the guide uses. fs.readFileSync(0) blocks until EOF, so an agent that leaves
// an inherited stdin pipe open would hang; prefer --notes-file if unsure.
function readNotes(args, deps = {}) {
  const readFile = deps.readFileSync ?? fs.readFileSync;
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
  if (args.notesFile) return readFile(args.notesFile, 'utf8');
  if (stdinIsTTY) return ''; // interactive stdin, no --notes-file → empty (usage error)
  return readFile(0, 'utf8'); // fd 0 = stdin (caller must close it)
}

async function main() {
  const log = (m) => console.log(m);
  const err = (m) => console.error(m);
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { err(`[handover] ${args.error}\n${USAGE}`); process.exit(EXIT.USAGE); }

  // Source convo (attribution): explicit flag overrides env session. For
  // --ack this is the ACKER's own convo (they're attributing the ack to
  // themselves), same as the (i)/(ii) branches attribute notes to themselves.
  const sourceConvoId = args.fromConvo ?? resolveConvoIdFromEnv({ argConvo: null }).convoId;
  if (sourceConvoId == null) {
    err('[handover] no source convo: pass --from-convo N or run inside a native session (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID)');
    process.exit(EXIT.USAGE);
  }

  if (args.ack) {
    // Receipt confirmation, round-tripped back to whoever sent the handover
    // (RFC 05 ack loop). Note is optional — unlike (i)/(ii), an empty note is
    // NOT a usage error; the ack itself ("đã nhận") already carries the signal.
    let note = '';
    try { note = readNotes(args); } catch { /* no piped/--notes-file note → ack with no extra text */ }
    const store = readTopicsStore();
    const targetChatId = resolveConvoChatId(store, args.ack);
    const promptObj = buildAckPrompt({
      targetConvoId: args.ack,
      targetChatId,
      sourceConvoId,
      note,
      nowSec: Math.floor(Date.now() / 1000),
    });
    const promptFile = path.join(DEFAULT_TMP_DIR, `prompt-convo-${args.ack}.json`);
    // RFC 03 §5.1 — durable non-blocking inject (coalesce/spool under the per-convo
    // write-lock) instead of O_EXCL: a busy target no longer bounces BUSY.
    try {
      const writeLock = path.join(DEFAULT_TMP_DIR, `prompt-write-${args.ack}.lock`);
      await mergeOrSpoolPrompt(promptFile, promptObj, writeLock);
    } catch (e) {
      err(`[handover] ack write failed: ${e.message}`);
      process.exit(EXIT.ERROR);
    }
    log(`[handover] ack injected → convo ${args.ack} (durable — will be delivered)`);
    process.exit(EXIT.OK);
  }

  let notes = '';
  try { notes = readNotes(args); } catch (e) { err(`[handover] cannot read notes: ${e.message}`); process.exit(EXIT.USAGE); }
  if (!notes.trim()) { err(`[handover] empty notes (pipe via stdin or pass --notes-file)\n${USAGE}`); process.exit(EXIT.USAGE); }

  const envFile = loadEnvFromFile(ENV_FILE);

  if (args.isNew) {
    // (ii) brand-new topic → spawn. Sensitive + billable → fail-closed role gate.
    if (!isPrivilegedRole(args.byRole)) {
      err(`[handover] --new requires --by-role admin|maintainer (got "${args.byRole}") — refused`);
      process.exit(EXIT.FORBIDDEN);
    }
    // Preflight binaries BEFORE claiming success: runSpawn's child errors are
    // async (spawn 'error' fires after we'd have returned), so a missing
    // claude/screen would otherwise exit 0 with no agent started (Codex M1).
    if (!hasBinary('claude')) { err('[handover] `claude` not found on PATH — cannot spawn'); process.exit(EXIT.ERROR); }
    if (!hasBinary('screen')) { err('[handover] interactive spawn needs `screen` on PATH — not found'); process.exit(EXIT.ERROR); }
    const seed = buildSeedPrompt({ sourceConvoId, notes });
    // No `permissionMode` passed → inherits buildSpawnPlan's `auto` default
    // (intentional: a handover spawn is interactive, so a human watches the screen
    // session). handover exposes no `--mode` passthrough by design.
    const plan = buildSpawnPlan({ interactive: true, seed: genSessionSeed(), prompt: seed });
    runSpawn(plan);
    const hashtag = plan.sessionName.replace(/^tele-/, '');
    log(`[handover] spawned new agent → screen ${plan.sessionName} (topic #${hashtag})`);
    process.exit(EXIT.OK);
  }

  // (i) existing topic → resolve + inject.
  const { chatIds } = resolveChatIds({ envFile, chatIdOverride: args.chatId });
  if (!chatIds.length) {
    err('[handover] no admin chat configured (set projects.json[<cwd>].chatId or _default.chatId)');
    process.exit(EXIT.USAGE);
  }
  const store = readTopicsStore();
  const live = listLiveTopics(store, chatIds);
  const target = normalizeTarget(args.to);
  const m = matchTarget(target, live);
  if (m.status === 'not_found') {
    const scope = args.chatId ? ` in chat ${args.chatId}` : '';
    log(`[handover] not-found "${args.to}"${scope}; live: ${formatTopicList(live) || '(none — check --chat-id / project config)'}`);
    process.exit(EXIT.NOT_FOUND);
  }
  if (m.status === 'ambiguous') {
    log(`[handover] ambiguous "${args.to}": ${formatTopicList(m.candidates)}`);
    process.exit(EXIT.AMBIGUOUS);
  }

  const { match } = m;
  const promptFile = path.join(DEFAULT_TMP_DIR, `prompt-convo-${match.convoId}.json`);
  const promptObj = buildHandoverPrompt({
    targetConvoId: match.convoId,
    targetChatId: match.chatId,
    sourceConvoId,
    notes,
    nowSec: Math.floor(Date.now() / 1000),
  });
  // RFC 03 §5.1 — durable non-blocking inject (coalesce/spool under the per-convo
  // write-lock) instead of O_EXCL: a busy target no longer bounces BUSY.
  try {
    const writeLock = path.join(DEFAULT_TMP_DIR, `prompt-write-${match.convoId}.lock`);
    await mergeOrSpoolPrompt(promptFile, promptObj, writeLock);
  } catch (e) {
    err(`[handover] write failed: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
  log(`[handover] injected → convo ${match.convoId} #${match.hashtag} (durable — will be delivered)`);
  if (m.shadowed && m.shadowed.length) {
    log(`[handover] note: ${m.shadowed.length} older topic(s) share that persona name — picked the most recent; redirect with --to "#${match.hashtag}" or another: ${formatTopicList(m.shadowed)}`);
  }
  // Liveness FYI (non-gating): if no screen session matches the hashtag, the
  // agent may have exited and the prompt will just wait until one listens.
  try {
    const sessions = listSpawnSessions();
    const alive = sessions.some((s) => s.name === `tele-${match.hashtag}`);
    if (!alive) log(`[handover] note: no live screen session tele-${match.hashtag} — if the topic is silent, spawn/attach an agent there to pick up the prompt`);
  } catch (e) {
    // `screen` absent is expected (FYI is non-gating); surface anything else so a
    // broken liveness hint is at least diagnosable rather than silently missing.
    if (!/not found|ENOENT/i.test(e?.message ?? '')) console.error(`[handover] liveness check skipped: ${e?.message ?? e}`);
  }
  process.exit(EXIT.OK);
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  main().catch((e) => { console.error(`[handover] ${e instanceof Error ? e.stack : String(e)}`); process.exit(EXIT.ERROR); });
}

// Silence unused-import lints for re-exported helpers used only in tests.
export { PERSONA_POOL };
