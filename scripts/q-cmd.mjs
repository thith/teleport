// q-cmd.mjs — RFC 29, the daemon side of `/q`: the board (startQ), button presses (handleQButton) and the typed
// forms (runQCommand). Owner only. Every collaborator is injectable; the lock dir is `ctx.lockDir || LOCK_DIR`.
//
// A press is processed in order, one at a time (mutex): owner → live token/chat/message → revision → target
// still the same ticket/build → CONSUME the revision (strict store write: failure = nothing happens) → act →
// redraw (strict edit) → answer. A crash between "consume" and "act" loses the press, never replays it.

import crypto from 'node:crypto';
import { LOCK_DIR, readQueue, readHolders } from './machine-lock.mjs';
import { parseDuration, readPolicy } from './build-policy.mjs';
import {
  setMax, stepMax, toggleMax, setRetry, setPaused, updatePolicy, kickTicket, topTicket, blockPlan, blockOwner, unblockOwner, resetPolicy,
  resolveQueueTarget, blockMatches, parseBlockArgs,
} from './queue-control.mjs';
import { gatherQ, renderQ, Q_BUTTON_RE, Q_TTL_MS } from './q-panel.mjs';
import { verifyHolder, holderKey, createStopJob, retireLongBuildAlert } from './long-build.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { peekPersona } from './persona-store.mjs';
import { formatPersona } from './persona.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';

const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const dirOf = (ctx, deps) => deps.dir ?? ctx.lockDir ?? LOCK_DIR;
const nowOf = (deps) => (deps.now ?? Date.now)();
const stoppingKeysOf = (store) => new Set([...store.entries()].filter(([, e]) => e && e.kind === 'stop').map(([, j]) => j.key));
const sameTicket = (t, row) => t.name === row.file && t.status !== 'dead' && t.pid === row.pid && String(t.procStart ?? null) === String(row.procStart ?? null);

/** The newest unexpired `/q` board entry → [tok, entry] | null. */
export function latestQ(store, now = Date.now()) {
  let best = null;
  for (const [k, v] of store.entries()) if (v?.kind === 'q' && now - v.createdAt <= Q_TTL_MS && (!best || v.createdAt > best[1].createdAt)) best = [k, v];
  return best;
}

const entryFor = (g, r, base) => ({ ...base, rows: r.maps.rows, running: r.maps.running, blocks: r.maps.blocks });

/** Send a fresh board and make it the only live one. */
export async function startQ(ctx, deps = {}) {
  const { daemonUserId, sendText, sendButtonRows, buttonStore: store } = ctx;
  if (!sendButtonRows || !store?.setStrict) { await sendText(daemonUserId, '❌ /q cần chạy trong daemon.'); return; }
  const dir = dirOf(ctx, deps), now = nowOf(deps);
  const tok = (deps.rand ?? (() => crypto.randomBytes(6).toString('hex')))();
  const g = (deps.gather ?? gatherQ)({ dir, now });
  const r = renderQ(g, { tok, rev: 0, page: 0, view: 'main', stoppingKeys: stoppingKeysOf(store) });
  const sent = await sendButtonRows(daemonUserId, r.text, r.rows);
  const entry = entryFor(g, r, { kind: 'q', createdAt: now, chatId: daemonUserId, messageId: sent?.message_id ?? null, rev: 0, page: 0, view: 'main' });
  try { store.setStrict(tok, entry); } catch {
    if (sent?.message_id != null) await (ctx.editButtonRows?.(daemonUserId, sent.message_id, `${r.text}\n\n❌ không lưu được trạng thái nút — gõ /q lại.`, []) ?? null);
    return;
  }
  for (const [k, v] of [...store.entries()]) if (k !== tok && v?.kind === 'q') { try { store.delete(k); } catch {} } // the older board expires
}

/** ⏹ confirmed on a running build: a separate status message + the RFC 24 stop job. → a one-line note. */
export async function qStop(ctx, runEntry, deps = {}) {
  const dir = dirOf(ctx, deps), now = nowOf(deps), store = ctx.buttonStore;
  const v = (deps.verify ?? verifyHolder)(runEntry, { dir });
  if (!v.holder) return `không dừng: ${v.why}`;
  const h = v.holder, key = holderKey(h);
  if (store.has(`stop:${key}`)) return 'đang dừng rồi';
  const text = `⏹ đang dừng ${h.label || `pid ${h.pid}`} pid ${h.pid}…`;
  let sent = null;
  try { sent = await ctx.sendButtonRows(ctx.daemonUserId, text, []); } catch (e) { return `không gửi được tin trạng thái: ${e?.message ?? e}`; }
  try { store.setStrict(`stop:${key}`, createStopJob(h, { chatId: ctx.daemonUserId, statusMessageId: sent?.message_id ?? null, text, now })); }
  catch { await ctx.editButtonRows?.(ctx.daemonUserId, sent?.message_id, `${text}\n\n❌ không lưu được lệnh dừng — không làm gì.`, []); return 'không lưu được lệnh dừng'; }
  try { await (deps.retire ?? retireLongBuildAlert)(key, ctx); } catch (e) { console.error(`[q] retire alert: ${e?.message ?? e}`); }
  deps.kick?.();
  return `đang dừng ${h.label || `pid ${h.pid}`} pid ${h.pid}`;
}

let qChain = Promise.resolve();
/** Presses run one after the other (a double tap on Max + can only count once). */
export function handleQButton(cq, ctx, deps = {}) {
  const run = qChain.then(() => qPress(cq, ctx, deps));
  qChain = run.catch(() => {});
  return run;
}

export async function qPress(cq, ctx, deps = {}) {
  const dir = dirOf(ctx, deps), now = nowOf(deps), store = ctx.buttonStore;
  const m = String(cq.data || '').match(Q_BUTTON_RE);
  const chatId = cq.message?.chat?.id, messageId = cq.message?.message_id, original = cq.message?.text || '';
  if (!m || chatId == null) { await ctx.answerButton(cq.id); return; }
  if (String(cq.from?.id) !== String(ctx.daemonUserId)) { await ctx.answerButton(cq.id, '❌ Chỉ owner dùng được.'); return; }
  const [, tok, revS, op0, idx] = m;
  const arg = m[5];
  const entry = store.get(tok);
  if (!entry || entry.kind !== 'q') { await ctx.answerButton(cq.id, '⌛ Hết hạn hoặc đã thay bảng — gõ /q lại.'); await ctx.editButtonRows(chatId, messageId, `${original}\n\n⌛ Hết hạn.`, []); return; }
  if (now - entry.createdAt > Q_TTL_MS) {
    try { store.delete(tok); } catch {}
    await ctx.answerButton(cq.id, '⌛ Hết hạn — gõ /q lại.');
    await ctx.editButtonRows(chatId, messageId, `${original}\n\n⌛ Hết hạn.`, []);
    return;
  }
  if (String(entry.chatId) !== String(chatId) || entry.messageId !== messageId) { await ctx.answerButton(cq.id, 'Nút không khớp tin nhắn — không làm gì.'); return; }

  let op = op0, note = null;
  if (parseInt(revS, 36) !== entry.rev) { op = 'r'; note = 'Bảng cũ — đã làm mới, bấm lại nếu vẫn muốn.'; } // old board: refresh only
  // the target must still be what the board showed
  let row = null, run = null, owner = null;
  if (['k', 't', 'b', 'bd'].includes(op)) {
    row = entry.rows?.[idx];
    const cur = row ? (deps.readQ ?? readQueue)('build', { dir, now }).find((t) => sameTicket(t, row)) : null;
    if (!cur) { op = 'r'; note = 'Vé đã đổi hoặc đã chạy — đã làm mới.'; row = null; } else row = { ...row, ...(op === 'bd' ? { v: cur.v, cur } : {}) };
  } else if (op === 'u') {
    owner = entry.blocks?.[idx];
    if (!owner) { op = 'r'; note = 'Mục chặn đã đổi — đã làm mới.'; }
  } else if (op === 's' || op === 'sy') {
    run = entry.running?.[idx];
    const v = run ? (deps.verify ?? verifyHolder)(run, { dir }) : { why: 'build đó không còn' };
    if (!v.holder) { op = 'r'; note = `Không dừng: ${v.why}.`; run = null; }
  }
  // consume the revision FIRST (strict; failure = nothing is done)
  const next = { ...entry, rev: entry.rev + 1, createdAt: now };
  try { store.setStrict(tok, next); } catch { await ctx.answerButton(cq.id, '❌ không lưu được trạng thái nút — gõ /q lại.'); return; }

  let view = 'main', page = entry.page ?? 0;
  const res = async (p) => { const r = await p; if (!r.ok) note = r.message; return r; };
  switch (op) {
    case 'r': break;
    case 'x': break;
    case 'pg': page = Number(idx) || 0; break;
    case 'm-': await res(stepMax(dir, -1, { now })); break;
    case 'm+': await res(stepMax(dir, +1, { now })); break;
    case 'mt': await res(toggleMax(dir, { now })); break;
    case 'p': await res(updatePolicy(dir, (p) => { p.paused = !p.paused; return { paused: p.paused }; }, { now })); break;
    case 'k': { const r = await res(kickTicket(dir, { name: row.file, pid: row.pid, procStart: row.procStart }, { now })); if (r.ok) note = `Đã kick ${row.label} (vé chưa chạy, agent được báo).`; break; }
    case 't': { const r = await res(topTicket(dir, { name: row.file, pid: row.pid, procStart: row.procStart, toggle: true }, { now })); if (r.ok) note = r.value.boosted ? `${row.label} lên đầu hàng.` : `Bỏ ưu tiên ${row.label}.`; break; }
    case 'b': view = `b:${idx}`; break;
    case 'bd': {
      const d = parseDuration(arg === 'td' ? 'today' : arg, { now });
      if (d.error) { note = d.error; break; }
      const plan = blockPlan(row.cur);
      const r = await res(blockOwner(dir, { owner: plan.owner, label: plan.label, until: d.until, ident: plan.ident }, { now }));
      if (r.ok) note = `Đã chặn ${plan.label} tới ${hhmm(d.until)}; kick ${r.value.struck.length} vé đang chờ.`;
      break;
    }
    case 'u': { const r = await res(unblockOwner(dir, owner, { now })); if (r.ok) note = 'Đã bỏ chặn.'; break; }
    case 's': view = `s:${idx}`; break;
    case 'sy': note = await qStop(ctx, run, deps); break;
    case 'rs': view = 'rs'; break;
    case 'rsy': { const r = await res(resetPolicy(dir, { now })); if (r.ok) note = 'Đã ghi lại policy mặc định.'; break; }
    default: break;
  }

  const g = (deps.gather ?? gatherQ)({ dir, now });
  const r = renderQ(g, { tok, rev: next.rev, page, view, stoppingKeys: stoppingKeysOf(store) });
  const text = note ? `ℹ️ ${note}\n${r.text}` : r.text;
  const final = entryFor(g, r, { ...next, view, page: r.page ?? page });
  const edit = ctx.editButtonRowsStrict || ctx.editButtonRows;
  try { store.setStrict(tok, final); } catch {
    try { await edit(chatId, messageId, `${text}\n\n❌ không lưu được trạng thái nút — gõ /q lại.`, []); } catch {}
    await ctx.answerButton(cq.id, '❌ không lưu được trạng thái nút.');
    return;
  }
  try { await edit(chatId, messageId, text, r.rows); }
  catch (e) { // message too old / deleted: a new board, and this one expires
    console.error(`[q] edit failed (${e?.message ?? e}) — sending a new board`);
    try { await startQ(ctx, deps); } catch (e2) { console.error(`[q] new board: ${e2?.message ?? e2}`); }
  }
  await ctx.answerButton(cq.id, note ? note.slice(0, 190) : undefined);
}

// ── typed forms ──

/** Candidate convos for a persona / #hash, in priority order: the queue, then live agents, then topics.json. */
export function queueTargetTiers({ dir = LOCK_DIR, now = Date.now(), procs = () => [], topics = () => [], peek = peekPersona, readQ = readQueue, holdersOf = readHolders } = {}) {
  const personaName = (cid) => { try { const p = peek(cid); return p ? formatPersona(p) : null; } catch { return null; } };
  const labelName = (l) => String(l || '').replace(/\s#[a-z0-9]+$/i, '');
  const fromRecord = (t) => (t.convoId != null ? { convoId: String(t.convoId), names: [personaName(t.convoId), labelName(t.label)].filter(Boolean), hashtag: shortConvoHash(t.convoId) } : null);
  const t1 = [...readQ('build', { dir, now }).filter((t) => t.status !== 'dead'), ...holdersOf('build', { dir })].map(fromRecord).filter(Boolean);
  const t2 = [];
  try {
    for (const r of procs()) {
      const cid = r.sessionId && !r.guessed ? uuidToConvoInt(r.sessionId) : null;
      if (cid != null) t2.push({ convoId: String(cid), names: [personaName(cid), r.name].filter(Boolean), hashtag: r.hashtag });
    }
  } catch {}
  const t3 = [];
  try { for (const cid of topics()) t3.push({ convoId: String(cid), names: [personaName(cid)].filter(Boolean), hashtag: shortConvoHash(cid) }); } catch {}
  return [t1, t2, t3];
}

const MAN_USAGE = 'usage: /q  ·  /q max <n|off>  ·  /q retry <phút>  ·  /q kick <số>  ·  /q top <số>  ·  /q block <số|persona|#hash> <30m|1h|2h30m|today>  ·  /q unblock <số|persona|#hash>  ·  /q pause|resume';

/** `/q …` typed. No argument = the board. Numbers refer to the newest board. */
export async function runQCommand(rest, ctx, deps = {}) {
  const { daemonUserId, sendText } = ctx;
  const dir = dirOf(ctx, deps), now = nowOf(deps), store = ctx.buttonStore;
  const toks = String(rest || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) { await startQ(ctx, deps); return; }
  const sub = toks[0].toLowerCase(), args = toks.slice(1);
  const say = (t) => sendText(daemonUserId, t);
  const out = async (r, ok) => say(r.ok ? ok(r) : r.message);
  const board = () => latestQ(store, now);
  const rowOf = (n) => { const b = board(); return b ? { row: b[1].rows?.[n], owner: b[1].blocks?.[n] } : { none: true }; };
  const liveTicket = (row) => (deps.readQ ?? readQueue)('build', { dir, now }).find((t) => sameTicket(t, row));
  const num = (s) => (/^\d{1,3}$/.test(s || '') ? Number(s) : null);
  switch (sub) {
    case 'max': {
      const v = args[0]?.toLowerCase();
      if (args.length !== 1 || !(v === 'off' || /^\d{1,2}$/.test(v))) { await say('usage: /q max <0..20 | off>'); return; }
      await out(await setMax(dir, v === 'off' ? null : Number(v), { now }), (r) => (r.value.max == null ? '✅ max hàng chờ: tắt.' : `✅ max hàng chờ: ${r.value.max} (vé đã xếp không bị đuổi).`));
      return;
    }
    case 'retry': {
      const n = args.length === 1 && /^\d{1,3}$/.test(args[0]) ? Number(args[0]) : null;
      if (n == null) { await say('usage: /q retry <1..120 phút>'); return; }
      await out(await setRetry(dir, n, { now }), () => `✅ "thử lại sau" ${n} phút.`);
      return;
    }
    case 'pause': case 'resume':
      await out(await setPaused(dir, sub === 'pause', { now }), () => (sub === 'pause' ? '⏸ đã tạm dừng phát chỗ build (build đang chạy chạy nốt).' : '▶ đã tiếp tục phát chỗ build.'));
      return;
    case 'kick': case 'top': {
      const n = num(args[0]);
      if (n == null || args.length !== 1) { await say(`usage: /q ${sub} <số trong bảng /q>`); return; }
      const { row, none } = rowOf(String(n));
      if (none) { await say('❌ chưa có bảng /q — gõ /q trước.'); return; }
      const cur = row ? liveTicket(row) : null;
      if (!cur) { await say(`❌ vé ${n} không còn (gõ /q để xem bảng mới).`); return; }
      const f = sub === 'kick' ? kickTicket : topTicket;
      await out(await f(dir, { name: row.file, pid: row.pid, procStart: row.procStart }, { now }), () => (sub === 'kick' ? `✅ đã kick ${row.label}.` : `✅ ${row.label} lên đầu hàng.`));
      return;
    }
    case 'block': {
      const a = parseBlockArgs(args.join(' '), { now });
      if (a.error) { await say(`❌ ${a.error}`); return; }
      let plan = null;
      const n = num(a.target);
      if (n != null) {
        const { row, none } = rowOf(String(n));
        if (none) { await say('❌ chưa có bảng /q — gõ /q trước.'); return; }
        const cur = row ? liveTicket(row) : null;
        if (!cur) { await say(`❌ vé ${n} không còn (gõ /q để xem bảng mới).`); return; }
        plan = blockPlan(cur);
      } else if (/^(convo|git|sid|pid):\S+$/.test(a.target)) {
        plan = { owner: a.target, label: a.target, ident: null, scope: `chặn ${a.target}` };
      } else {
        const tg = resolveQueueTarget(a.target, queueTargetTiers({ dir, now, procs: deps.procs ?? (() => []), topics: deps.topics ?? (() => []), peek: deps.peek ?? peekPersona }));
        if (tg.error) { await say(`❌ ${tg.error}`); return; }
        plan = { owner: `convo:${tg.convoId}`, label: tg.label, ident: null, scope: `chặn ${tg.label} (convo ${tg.convoId})` };
      }
      await out(await blockOwner(dir, { owner: plan.owner, label: plan.label, until: a.until, ident: plan.ident }, { now }),
        (r) => `⛔ ${plan.scope} tới ${hhmm(a.until)}; đã kick ${r.value.struck.length} vé đang chờ.`);
      return;
    }
    case 'unblock': {
      if (!args.length) { await say('usage: /q unblock <số trong mục Đang chặn | persona | #hash>'); return; }
      const q = args.join(' ');
      let owner = null;
      const n = num(q);
      if (n != null) { const b = rowOf(String(n)); owner = b.owner; if (!owner) { await say(`❌ không có mục chặn ${n} trong bảng /q mới nhất.`); return; } }
      else {
        const blocks = readPolicy(dir, { now }).policy.blocks.filter((b) => blockMatches(b, q));
        if (blocks.length !== 1) { await say(blocks.length ? `❌ "${q}" khớp ${blocks.length} mục chặn: ${blocks.map((b) => b.label).join(', ')} — dùng số.` : `❌ không thấy mục chặn "${q}".`); return; }
        owner = blocks[0].owner;
      }
      await out(await unblockOwner(dir, owner, { now }), () => '✅ đã bỏ chặn.');
      return;
    }
    default: await say(MAN_USAGE);
  }
}
