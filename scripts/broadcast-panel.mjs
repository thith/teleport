// broadcast-panel.mjs — RFC 37: the `/broadcast <text>` button board (daemon side). The owner gets the running
// sessions grouped by project, all ✅; a tap toggles one session / one project; [📢 Gửi] writes the prompts to
// the selected sessions that are STILL running; [✖] cancels. Pattern of q-cmd.mjs (RFC 29): a press is processed
// in order (exclusive chain), every check happens BEFORE the revision is consumed, state changes are one strict
// store write, and nothing is ever sent twice (`state: 'sending'` is persisted before the first prompt write).

import crypto from 'node:crypto';
import { escapeControls } from './cleanup-inbox.mjs';
import { tokenizeArgs, roleMeets } from './commands.mjs';
import { extractBotId } from './send-telegram.mjs';
import { readRows } from './convo-registry.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { lsHashtagSet } from './spawn.mjs';
import { durableWrite } from './steer.mjs';
import { DEFAULT_TMP_DIR } from './tele-listen.mjs';
import { readProjectsConfig } from './projects-config.mjs';
import {
  parseBroadcastRaw, parseBroadcastArgs, groupChatIds, listTargets, resolveLive, sendTo, USAGE,
} from './broadcast.mjs';

export const BC_TTL_MS = 10 * 60_000;
export const BC_MAX_TEXT = 3500;
export const BC_PREVIEW = 600;
export const BC_MAX_TARGETS = 40;
const MSG_BUDGET = 3900; // the board / result always stays below Telegram's 4096
/** bc:<tok12>:<rev base36>:<op>[:<idx>] — op t (session) / p (project) / s (send) / x (cancel); < 32 bytes. */
export const BC_BUTTON_RE = /^bc:([0-9a-f]{12}):([0-9a-z]{1,8}):([tpsx])(?::(\d{1,3}))?$/;
export const bcCallback = (tok, rev, op, idx = null) => `bc:${tok}:${rev.toString(36)}:${op}${idx != null ? `:${idx}` : ''}`;

export const MSG_STALE = '⌛ Hết hạn hoặc đã thay bảng — gõ /broadcast lại.';
export const MSG_INTERRUPTED = '⚠️ Gửi bị gián đoạn — có thể đã tới một phần session; không gửi lại. Kiểm tra /ls rồi gõ /broadcast lại nếu cần.';

const clean = (s) => escapeControls(String(s ?? ''));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const selSet = (entry) => new Set(entry.selected);
const membersOf = (entry, project) => entry.targets.map((t, i) => (t.project === project ? i : -1)).filter((i) => i >= 0);

/** The projects of `targets` in first-seen order (the order of /ls). */
export const projectsOf = (targets) => [...new Set(targets.map((t) => t.project))];

function previewOf(text, n) {
  const over = text.length - n;
  return `${clean(over > 0 ? text.slice(0, n) : text)}${over > 0 ? `… (+${over} ký tự)` : ''}`;
}

/** The board for a stored entry → { text, rows }. Callback data carry only the revision and an index. Pure. */
export function renderBroadcast(entry, tok) {
  const sel = selSet(entry);
  const cb = (op, idx) => bcCallback(tok, entry.rev, op, idx);
  const head = (n) => `📢 Broadcast — nội dung:\n«${previewOf(entry.text, n)}»\n\nGửi tới ${sel.size}/${entry.targets.length} session:${entry.hidden ? `\n⚠️ chỉ hiện ${entry.targets.length}/${entry.targets.length + entry.hidden}` : ''}`;
  let n = BC_PREVIEW, text = head(n);
  while (text.length > MSG_BUDGET && n > 20) { n = Math.floor(n / 2); text = head(n); } // control chars expand when escaped
  const rows = [];
  entry.projects.forEach((p, j) => {
    const mem = membersOf(entry, p);
    const on = mem.filter((i) => sel.has(i)).length;
    rows.push([{ text: `📁 ${cut(clean(p), 28)} ${on === mem.length ? '✅' : on === 0 ? '⬜' : '◐'} ${on}/${mem.length}`, callback_data: cb('p', j) }]);
    for (let k = 0; k < mem.length; k += 2) {
      rows.push(mem.slice(k, k + 2).map((i) => ({ text: `${sel.has(i) ? '✅' : '⬜'} ${cut(clean(entry.targets[i].label), 24)}`, callback_data: cb('t', i) })));
    }
  });
  rows.push([{ text: `📢 Gửi (${sel.size})`, callback_data: cb('s') }, { text: '✖', callback_data: cb('x') }]);
  return { text, rows };
}

/** The final message after a send (no buttons). Pure. */
export function renderResult(entry, { sent, dead, failed }) {
  const total = sent.length + dead.length + failed.length;
  const skipped = entry.targets.length - total;
  const lines = [`📢 Đã gửi ${sent.length}/${total}`, ...sent.map((t) => `✅ ${clean(t.label)}`)];
  dead.forEach((t) => lines.push(`⏹ ${clean(t.label)} — đã tắt`));
  failed.forEach((t) => lines.push(`❌ ${clean(t.label)} — không ghi được hàng đợi`));
  if (skipped > 0) lines.push('', `Bỏ qua (bạn bỏ chọn): ${skipped}`);
  const txt = lines.join('\n');
  return txt.length > MSG_BUDGET ? `${txt.slice(0, MSG_BUDGET)}…` : txt;
}

// ── the exclusive chain (a press in flight can't race a new board or another press) ──

let bcChain = Promise.resolve();
const exclusive = (fn) => { const run = bcChain.then(fn); bcChain = run.catch(() => {}); return run; };

const nowOf = (deps) => (deps.now ?? Date.now)();
const editOf = (ctx) => ctx.editButtonRowsStrict || ctx.editButtonRows;

/** Edit the board message to a final text (no buttons); a failure only logs — it never reopens anything. */
async function finalEdit(ctx, chatId, messageId, text, { fallbackNew = false } = {}) {
  try { await editOf(ctx)(chatId, messageId, text, []); return true; }
  catch (e) {
    console.error(`[broadcast] edit failed: ${e?.message ?? e}`);
    if (fallbackNew) { try { await ctx.sendText(ctx.daemonUserId, text); } catch (e2) { console.error(`[broadcast] result send failed: ${e2?.message ?? e2}`); } }
    return false;
  }
}

/** Leftover entries: open+expired → drop; sending → tell the owner it was interrupted, then drop. Best effort. */
async function sweep(store, ctx, now) {
  const gone = [];
  for (const [k, v] of [...store.entries()]) {
    if (v?.kind !== 'broadcast') continue;
    // 'sending' is dropped only once the owner has been told (a failed edit keeps it for the next sweep / press)
    if (v.state === 'sending') { if (v.messageId == null || await finalEdit(ctx, v.chatId, v.messageId, MSG_INTERRUPTED)) gone.push(k); }
    else if (now - v.createdAt > BC_TTL_MS) { if (v.messageId != null) await finalEdit(ctx, v.chatId, v.messageId, '⌛ Hết hạn — không gửi gì.'); gone.push(k); }
  }
  return gone;
}

// ── `/broadcast <text>` ──

/** `/broadcast <text>` from the daemon: checks, then the board. `deps` are all injectable. */
export function runBroadcastCommand(rest, from, ctx, deps = {}) {
  return exclusive(() => runBroadcastUnlocked(rest, from, ctx, deps));
}

async function runBroadcastUnlocked(rest, from, ctx, deps) {
  const { daemonUserId, sendText, sendButtonRows, buttonStore: store } = ctx;
  const say = (t) => sendText(daemonUserId, t);
  if (String(from?.id) !== String(daemonUserId)) { await say('❌ /broadcast chỉ owner dùng được.'); return; }
  const config = deps.config ?? ctx.projectsConfig ?? readProjectsConfig();
  const role = (deps.roleOf ?? (() => 'member'))(from?.id);
  if (!roleMeets(role, 'admin')) { await say(`❌ /broadcast cần quyền admin (bạn: ${role}).`); return; }
  if (!sendButtonRows || !store?.setStrict) { await say('❌ /broadcast cần chạy trong daemon.'); return; }

  const args = parseBroadcastRaw(rest);
  if (args.error) { await say(args.error); return; }
  // The scope must agree with the tokenized reading (which honours quotes like `--"chat"`): never send wider.
  if ((parseBroadcastArgs(tokenizeArgs(rest)).chat ?? null) !== (args.chat ?? null)) { await say(`❌ --chat phải đứng đầu, không trong ngoặc — ${USAGE}`); return; }
  if (args.text.length > BC_MAX_TEXT) { await say(`❌ nội dung quá dài (${args.text.length} > ${BC_MAX_TEXT} ký tự).`); return; }

  // recovery of leftover boards runs first, whatever the discovery below turns out to be
  const now = nowOf(deps);
  const gone = await sweep(store, ctx, now);
  const dropGone = () => { for (const k of gone) { try { store.delete(k); } catch { /* the next sweep retries */ } } };
  const chatIds = args.chat ? [String(args.chat)] : groupChatIds(config, { env: deps.env ?? process.env, envFile: deps.envFile ?? {} });
  const topics = deps.store ?? readTopicsStore();
  let ls;
  try { ls = [...await (deps.lsRows ?? (() => lsHashtagSet({ withCwd: true })))()]; }
  catch (e) { await say(`📢 broadcast: không liệt kê được agent đang chạy (${e?.message || e}) — nothing sent.`); dropGone(); return; }
  let allocRows = [];
  try { allocRows = (deps.allocRows ?? (() => readRows().rows))(); } catch { /* no allocation info → cwd / chat fallbacks */ }
  const all = listTargets({ store: topics, chatIds, ls, config, allocRows, botId: deps.botId ?? extractBotId(ctx.token), projectDeps: deps.projectDeps });
  if (!all.length) { await say('📢 broadcast — không có session nào đang chạy (/ls trống), không gửi gì.'); dropGone(); return; }

  const targets = all.slice(0, BC_MAX_TARGETS);
  const tok = (deps.rand ?? (() => crypto.randomBytes(6).toString('hex')))();
  const entry = {
    kind: 'broadcast', createdAt: now, chatId: daemonUserId, messageId: null, rev: 0, state: 'open',
    text: args.text, from: { id: from?.id ?? null, name: from?.first_name || from?.username || from?.name || 'admin', role },
    targets, projects: projectsOf(targets), selected: targets.map((_, i) => i), hidden: all.length - targets.length,
  };
  const r = renderBroadcast(entry, tok);
  const sent = await sendButtonRows(daemonUserId, r.text, r.rows);
  entry.messageId = sent?.message_id ?? null;
  try { store.setStrict(tok, entry, { remove: gone }); }
  catch {
    if (entry.messageId != null) await finalEdit(ctx, daemonUserId, entry.messageId, `${r.text}\n\n❌ không lưu được trạng thái nút — gõ /broadcast lại.`);
  }
}

// ── button presses ──

export function handleBroadcastButton(cq, ctx, deps = {}) {
  return exclusive(() => bcPress(cq, ctx, deps));
}

export async function bcPress(cq, ctx, deps = {}) {
  const now = nowOf(deps), store = ctx.buttonStore;
  const m = String(cq.data || '').match(BC_BUTTON_RE);
  const chatId = cq.message?.chat?.id, messageId = cq.message?.message_id;
  const answer = (t) => ctx.answerButton(cq.id, t ? String(t).slice(0, 190) : undefined);
  if (!m || chatId == null) { await answer(); return; }
  // ── checks, all BEFORE the revision is touched ──
  if (String(cq.from?.id) !== String(ctx.daemonUserId)) { await answer('❌ Chỉ owner dùng được.'); return; }
  const [, tok, revS, op, idxS] = m;
  const entry = store.get(tok);
  if (!entry || entry.kind !== 'broadcast') { await answer(MSG_STALE); return; }
  if (String(entry.chatId) !== String(chatId) || entry.messageId !== messageId) { await answer(MSG_STALE); return; }
  if (entry.state === 'sending') { // the daemon died (or the write below failed) after the send began: never send again
    // dropped only after the warning is out; a failed edit keeps it so the next press / sweep can still warn
    if (await finalEdit(ctx, chatId, messageId, MSG_INTERRUPTED)) { try { store.delete(tok); } catch { /* stays: the next press says the same */ } }
    await answer('⚠️ Gửi bị gián đoạn — không gửi lại.');
    return;
  }
  if (now - entry.createdAt > BC_TTL_MS) {
    try { store.delete(tok); } catch { /* an expired entry never sends anyway */ }
    await finalEdit(ctx, chatId, messageId, '⌛ Hết hạn — không gửi gì.');
    await answer('⌛ Hết hạn — không gửi gì.');
    return;
  }
  const idx = idxS == null ? null : Number(idxS);
  if ((op === 't' && !(idx != null && idx < entry.targets.length)) || (op === 'p' && !(idx != null && idx < entry.projects.length)) || ((op === 's' || op === 'x') && idx != null)) { await answer(MSG_STALE); return; }
  const revOk = parseInt(revS, 36) === entry.rev;
  if (!revOk && op !== 's') { await answer(MSG_STALE); return; }

  const edit = editOf(ctx);
  if (op === 'x') {
    try { store.delete(tok); } catch { await answer('❌ không lưu được trạng thái nút — gõ /broadcast lại.'); return; }
    await finalEdit(ctx, chatId, messageId, '✖ Đã huỷ — không gửi gì.');
    await answer('Đã huỷ');
    return;
  }

  if (op === 't' || op === 'p') {
    const sel = selSet(entry);
    if (op === 't') { if (sel.has(idx)) sel.delete(idx); else sel.add(idx); }
    else {
      const mem = membersOf(entry, entry.projects[idx]);
      if (mem.every((i) => sel.has(i))) mem.forEach((i) => sel.delete(i)); else mem.forEach((i) => sel.add(i));
    }
    // revision AND selection in ONE write, before the redraw (a restart after the redraw still matches what is shown)
    const next = { ...entry, rev: entry.rev + 1, createdAt: now, selected: [...sel].sort((a, b) => a - b) };
    try { store.setStrict(tok, next); } catch { await answer('❌ không lưu được trạng thái nút — gõ /broadcast lại.'); return; }
    const r = renderBroadcast(next, tok);
    try { await edit(chatId, messageId, r.text, r.rows); }
    catch (e) {
      console.error(`[broadcast] redraw failed: ${e?.message ?? e}`);
      // no rollback: the edit may have been applied (only the reply failed). The new revision stays; stale old buttons fail safe.
      await answer('❌ không vẽ lại được bảng — gõ /broadcast lại.'); return;
    }
    await answer();
    return;
  }

  // ── op === 's': Send ──
  if (!revOk) { // a toggle landed first: show the board as it really is, send nothing
    const r = renderBroadcast(entry, tok);
    try { await edit(chatId, messageId, r.text, r.rows); } catch (e) { console.error(`[broadcast] redraw failed: ${e?.message ?? e}`); }
    await answer('Bảng vừa đổi — kiểm tra rồi bấm Gửi lại');
    return;
  }
  const sel = selSet(entry);
  if (sel.size === 0) { await answer('Chưa chọn ai'); return; }
  let rows;
  try { rows = [...await (deps.lsRows ?? (() => lsHashtagSet({ withCwd: true })))()]; }
  catch (e) { await answer(`❌ không liệt kê được agent đang chạy (${e?.message || e}) — không gửi.`); return; } // fail closed; the board stays open
  const chosen = entry.targets.filter((_, i) => sel.has(i));
  const liveIds = new Set(resolveLive(chosen, rows, deps.store ?? readTopicsStore()).map((x) => x.target.convoId));
  const live = chosen.filter((t) => liveIds.has(t.convoId));
  const dead = chosen.filter((t) => !liveIds.has(t.convoId));
  // from here the owner's tap is committed: 'sending' is on disk BEFORE any prompt is written
  try { store.setStrict(tok, { ...entry, rev: entry.rev + 1, state: 'sending' }); } catch { await answer('❌ không lưu được trạng thái nút — không gửi.'); return; }
  const { sent, failed } = await sendTo(live, entry.text, entry.from, { tmpDir: deps.tmpDir ?? DEFAULT_TMP_DIR, writePrompt: deps.writePrompt ?? durableWrite });
  try { store.delete(tok); } catch (e) { console.error(`[broadcast] could not drop the sent entry: ${e?.message ?? e}`); } // stays 'sending' → "gián đoạn", never re-sent
  await finalEdit(ctx, chatId, messageId, renderResult(entry, { sent, dead, failed }), { fallbackNew: true });
  await answer(`📢 Đã gửi ${sent.length}`);
}
