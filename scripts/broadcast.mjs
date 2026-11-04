// `/broadcast <text>` — a daemon command (no project). Injects ONE system message
// into every topic that `/ls` shows (running agent: claude proc or tele-* screen) — dead
// topics are skipped and counted . Use-case: tell every running
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
import { isMainModule } from './is-direct-run.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { listLiveTopics } from './handover.mjs';
import { lsHashtagSet, personaByHashtag } from './spawn.mjs';
import { formatPersona } from './persona.mjs';
import { durableWrite } from './steer.mjs';
import { DEFAULT_TMP_DIR } from './tele-listen.mjs';
import { readProjectsConfig, resolveDefaultChatId, projectEntries, resolveProjectKey } from './projects-config.mjs';
import { lookupAllocationByConvo } from './convo-registry.mjs';
import { worktreeOf, gitCommonDir } from './machine-lock.mjs';

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

/**
 * The daemon's raw text (TELE_RAW_ARGS, RFC 26 §3.8) → { chat, text, error }: an optional LEADING
 * `--chat <id>` / `--chat=<id>`, then the message VERBATIM (quotes, newlines kept). A `--chat`
 * anywhere else is refused: argv mode took it anywhere, so silently sending to EVERY group would
 * widen an admin-wide action. Pure.
 */
export function parseBroadcastRaw(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^--chat(?:=(\S*)|\s+(\S+))(?:\s+([\s\S]*))?$/) || s.match(/^--chat()()$/);
  const out = m ? { chat: m[1] || m[2] || null, text: (m[3] || '').trim(), error: null } : { chat: null, text: s, error: null };
  if (m && !out.chat) out.error = USAGE;
  else if (!out.text) out.error = USAGE;
  // Any other `--chat` (quoted, mid-text…) is refused — argv mode honoured it, so dropping it would
  // silently widen the scope to every group.
  else if (/--chat/i.test(out.text)) out.error = `--chat phải đứng đầu (không trong ngoặc) — ${USAGE}`;
  return out;
}

// ── RFC 37: the pieces the `/broadcast` button board is built from ──

export const OTHER_PROJECT = 'khác';
const normTag = (h) => String(h).replace(/^#/, '').toLowerCase();

/**
 * One candidate per convo (RFC 37 §3.2): listLiveTopics gives a row per (chat, convo); the chat kept is
 * the one of the NEWEST topic (`ts`), a tie → the smaller chat id (string order). Pure.
 */
export function candidateTopics(store, chatIds) {
  const best = new Map();
  for (const t of listLiveTopics(store, chatIds)) {
    const cur = best.get(t.convoId);
    if (!cur || t.ts > cur.ts || (t.ts === cur.ts && t.chatId < cur.chatId)) best.set(t.convoId, t);
  }
  return [...best.values()];
}

/**
 * Which of `targets` ({convoId, hashtag}) are running, in /ls order → [{ target, row, i }]. The SAME rule at
 * board time and at Send time (RFC 37 §3.1): an /ls row with a convoId matches that convo exactly; a row with
 * only a hashtag (an empty tele-* screen) matches only when that hashtag is UNIQUE across the whole store
 * (every chat, distinct convoIds). Pure.
 */
export function resolveLive(targets, lsRows, store) {
  const entries = [...(lsRows || [])];
  const tagOwners = new Map(); // hashtag → distinct convoIds in the store
  for (const t of listLiveTopics(store, Object.keys(store || {}))) {
    const k = normTag(t.hashtag);
    if (!tagOwners.has(k)) tagOwners.set(k, new Set());
    tagOwners.get(k).add(String(t.convoId));
  }
  const indexOf = (t) => entries.findIndex((e) => {
    const isObj = e && typeof e === 'object';
    if (isObj && e.convoId != null) return String(e.convoId) === String(t.convoId);
    const h = isObj ? e.hashtag : e;
    if (!h || normTag(h) !== normTag(t.hashtag)) return false;
    const owners = tagOwners.get(normTag(t.hashtag)); // the UNIQUE current owner of the hashtag must be this very target
    return !!owners && owners.size === 1 && owners.has(String(t.convoId));
  });
  return targets.map((target) => ({ target, i: indexOf(target) })).filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i).map((x) => ({ ...x, row: entries[x.i] }));
}

/** Repo name from a git common dir: `/x/repo/.git` → `repo`, a bare `/x/repo.git` → `repo`. */
const repoNameOf = (common) => {
  const base = path.basename(common);
  return base === '.git' ? path.basename(path.dirname(common)) : base.replace(/\.git$/, '');
};

/**
 * The project of one running session (RFC 37 §3.2, RFC 15 order, no `git` subprocess):
 * allocation of the convo → cwd's git repo (worktrees fold into the main repo; outside a repo: nothing) →
 * the chat when it is the dedicated group of exactly ONE project → 'khác'.
 */
export function projectOf({ convoId, chatId, cwd }, { config = {}, allocRows: rawRows = [], botId = null, worktreeFn = worktreeOf, commonDirFn = gitCommonDir } = {}) {
  const allocRows = Array.isArray(rawRows) ? rawRows : rawRows?.rows ?? []; // readRows() returns { rows, … }
  try {
    const a = allocRows.length ? lookupAllocationByConvo(allocRows, Number(convoId), botId) : null;
    if (a && a.projectKey) return resolveProjectKey(a.projectKey, config);
  } catch { /* fall through */ }
  if (cwd) {
    try {
      const common = commonDirFn(worktreeFn(cwd));
      if (common) { const name = repoNameOf(common); if (name) return resolveProjectKey(name, config); }
    } catch { /* fall through */ }
  }
  const owners = projectEntries(config).filter(([, p]) => p && p.chatId != null && String(p.chatId).trim() === String(chatId));
  if (owners.length === 1) return owners[0][0];
  return OTHER_PROJECT;
}

/**
 * The running sessions for the board: [{ convoId, chatId, hashtag, project, label }], deduped by convo,
 * in /ls order (projects are grouped by the caller in first-seen order). `ls` = /ls rows (with `cwd`).
 */
export function listTargets({ store, chatIds, ls, config = {}, allocRows = [], botId = null, projectDeps = {} }) {
  const live = resolveLive(candidateTopics(store, chatIds), ls, store);
  return live.map(({ target: t, row }) => ({
    convoId: String(t.convoId), chatId: String(t.chatId), hashtag: t.hashtag,
    project: projectOf({ convoId: t.convoId, chatId: t.chatId, cwd: row && typeof row === 'object' ? row.cwd : null }, { config, allocRows, botId, ...projectDeps }),
    label: `${t.persona ? `${formatPersona(t.persona)} ` : ''}#${t.hashtag}`,
  }));
}

/** Durable prompt write (RFC 03 §5.1) to each target → { sent: [target], failed: [target] }. One write per convo. */
export async function sendTo(targets, text, from = {}, { tmpDir = DEFAULT_TMP_DIR, writePrompt = durableWrite } = {}) {
  const sent = [], failed = [];
  for (const t of targets) {
    const prompt = buildBroadcastPrompt({ targetConvoId: t.convoId, targetChatId: t.chatId, fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text });
    try { await writePrompt(prompt, path.join(tmpDir, `prompt-convo-${t.convoId}.json`)); sent.push(t); }
    catch { failed.push(t); }
  }
  return { sent, failed };
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
  raw = process.env.TELE_RAW_ARGS, // the daemon's untokenized text; unset/'' → argv
  lsHashtags = lsHashtagSet,       // () => /ls rows ({convoId,hashtag} | hashtag); throws → fail closed
  personaOf = null,                // (hashtag) → name; default = /ls's lookup (personaByHashtag + formatPersona)
} = {}) {
  const args = raw ? parseBroadcastRaw(raw) : parseBroadcastArgs(argv);
  if (args.error) return { ok: false, message: args.error };
  // The scope must agree with the tokenized argv (which honours quotes like `--"chat"`): raw mode may
  // keep the text verbatim, never send wider than the old reading would.
  if (raw && (parseBroadcastArgs(argv).chat ?? null) !== (args.chat ?? null)) {
    return { ok: false, message: `--chat phải đứng đầu, không trong ngoặc — ${USAGE}` };
  }
  const chatIds = args.chat ? [String(args.chat)] : groupChatIds(config, { env, envFile });
  const all = listLiveTopics(store, chatIds);
  if (!all.length) return { ok: false, message: '📢 broadcast: no live topics found (nothing sent).' };
  // Only topics /ls shows (running agents). Fail closed if the listing itself breaks.
  // Entries are `{convoId, hashtag}` (a bare string = hashtag only). A convoId matches exactly; a
  // hashtag-only row matches only when that hashtag belongs to ONE candidate topic (short hashes can
  // collide across convoIds — ambiguous → skipped, counted as not running).
  let entries;
  try { entries = [...(await lsHashtags())]; }
  catch (e) { return { ok: false, message: `📢 broadcast: không liệt kê được agent đang chạy (${e?.message || e}) — nothing sent.` }; }
  const norm = (h) => String(h).replace(/^#/, '').toLowerCase();
  const tagCount = new Map();
  // Uniqueness is store-wide (every chat), not just the --chat scope: a hashtag-only row may belong to
  // a topic in another chat. Distinct convoIds only.
  const seenConvo = new Set();
  for (const t of listLiveTopics(store, Object.keys(store || {}))) {
    if (seenConvo.has(t.convoId)) continue;
    seenConvo.add(t.convoId);
    tagCount.set(norm(t.hashtag), (tagCount.get(norm(t.hashtag)) || 0) + 1);
  }
  // Position of a topic in /ls order (first matching row), or -1.
  const lsIndex = (t) => entries.findIndex((e) => {
    const isObj = e && typeof e === 'object';
    if (isObj && e.convoId != null) return String(e.convoId) === String(t.convoId);
    const h = isObj ? e.hashtag : e;
    return !!h && norm(h) === norm(t.hashtag) && tagCount.get(norm(t.hashtag)) === 1;
  });
  const live = all.map((t) => ({ t, i: lsIndex(t) })).filter((x) => x.i >= 0).sort((x, y) => x.i - y.i).map((x) => x.t);
  if (!live.length) return { ok: false, total: 0, message: '📢 broadcast — không có session nào đang chạy (/ls trống), không gửi gì.' };

  // RFC 03 §5.1: durable coalesce/spool into each topic — a busy topic no longer
  // bounces, so nothing is skipped; a hard write/lock failure (rare) is surfaced.
  const label = (t) => {
    let p = null;
    try { p = personaOf(t.hashtag); } catch { /* hashtag only */ }
    return `${p ? `${p} ` : ''}#${t.hashtag}`;
  };
  let pmap = {};
  if (!personaOf) { try { pmap = personaByHashtag(store); } catch { /* hashtag only */ } personaOf = (h) => (pmap[h] ? formatPersona(pmap[h]) : null); }
  let sent = 0; const okLines = []; const failLines = [];
  for (const t of live) {
    const prompt = buildBroadcastPrompt({
      targetConvoId: t.convoId, targetChatId: t.chatId,
      fromUserId: from.id, fromName: from.name, fromRole: from.role || 'member', text: args.text,
    });
    const promptFile = path.join(tmpDir, `prompt-convo-${t.convoId}.json`);
    try {
      await writePrompt(prompt, promptFile);
      sent++; okLines.push(label(t));
    } catch (e) {
      failLines.push(`${label(t)} — không ghi được hàng đợi`);   // real write/lock failure (not busy) → continue fan-out
    }
  }
  const msg = [`📢 broadcast — ${live.length} session`, '', '✅ Đã gửi', ...okLines,
    ...(failLines.length ? ['', '❌ Lỗi', ...failLines] : [])].join('\n');
  return { ok: true, sent, skipped: failLines.length, total: live.length, message: msg };
}

if (isMainModule(import.meta.url)) {
  const from = { id: process.env.TELE_FROM_ID, role: process.env.TELE_FROM_ROLE, name: process.env.TELE_FROM_NAME };
  const res = await doBroadcast(process.argv.slice(2), { from });
  process.stdout.write((res.message || '') + '\n');
  process.exit(res.ok ? 0 : 1);
}
