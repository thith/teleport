// q-panel.mjs — RFC 29: the `/q` board. gatherQ() reads the queue + policy; renderQ() turns that into
// the message text, the inline keyboard and the maps (button number → ticket / running build / block)
// that the daemon stores in the button store and checks again on every press. Pure but for gatherQ's reads.

import fs from 'node:fs';
import path from 'node:path';
import {
  LOCK_DIR, readHolders, readQueue, readClaimed, readServed, queueOrder, hasLegacyWaiter, hasPreBoostWaiter, slotsFor, cpuGateNote, quietNowFor, memTotal, TWO_SLOT_MIN_RAM,
} from './machine-lock.mjs';
import { readPolicy, TICKET_V } from './build-policy.mjs';
import { shortCmd, ticketWorktree } from './lock-queue.mjs';
import { blockPlan } from './queue-control.mjs';
import { escapeControls } from './cleanup-inbox.mjs';

export const Q_PAGE_SIZE = 8;
export const Q_TTL_MS = 2 * 3600_000;
/** q:<tok12>:<rev base36>:<op>[:<idx>[:<arg>]] — always < 48 bytes. */
export const Q_BUTTON_RE = /^q:([0-9a-f]{12}):([0-9a-z]{1,8}):([a-z+-]{1,3})(?::(\d{1,3}))?(?::([a-z0-9]{1,8}))?$/;
export const Q_DURATIONS = { '30m': "30'", '1h': '1h', '3h': '3h', td: 'Hết hôm nay' };

export const qCallback = (tok, rev, op, idx = null, arg = null) => `q:${tok}:${rev.toString(36)}:${op}${idx != null ? `:${idx}` : ''}${arg != null ? `:${arg}` : ''}`;

const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const clean = (s) => escapeControls(String(s ?? ''));
const wtName = (t) => { const w = ticketWorktree(t); return w ? ` · ${clean(path.basename(w))}` : ''; };

/** What N=auto resolves to on this machine (RAM only; ignores build.slots). */
export const autoSlots = (total = memTotal()) => (total >= TWO_SLOT_MIN_RAM ? 2 : 1);
const slotsForcedIn = (dir) => fs.existsSync(path.join(dir, 'build.slots'));

/** Read everything the board shows. */
export function gatherQ({ dir = LOCK_DIR, now = Date.now(), read = readQueue, holdersOf = readHolders, claimedOf = readClaimed, servedOf = readServed, policyOf = readPolicy, slotsOf = slotsFor, gate, quietOf = quietNowFor, forcedOf = slotsForcedIn, autoOf = autoSlots } = {}) {
  const pr = policyOf(dir, { now });
  const holders = holdersOf('build', { dir }).sort((a, b) => a.startedAt - b.startedAt || a.slot - b.slot);
  const tickets = read('build', { dir, now }).filter((t) => t.status !== 'dead');
  const fair = !hasLegacyWaiter(tickets);
  const named = new Set(holders.map((h) => h.ticket).filter(Boolean));
  const running = fair ? [...holders.filter((h) => !h.exclusive), ...claimedOf('build', { dir }).filter((c) => !named.has(c.ticket))] : [];
  const order = queueOrder(tickets, { fair, running, served: fair ? servedOf('build', { dir, now }) : {}, boosts: pr.policy.boosts });
  const N = slotsOf('build', { dir });
  return {
    gateNote: pr.policy.paused ? '' : cpuGateNote({ dir, N, holders, claimed: claimedOf('build', { dir }), now, gate }), // RFC 32: why a free slot is not handed out
    quiet: (({ active, overridden, until }) => ({ active: !!active, overridden: !!overridden, until: until ?? null }))(quietOf(dir, now)),
    now, policy: pr.policy, corrupt: pr.corrupt, error: pr.error ?? null, holders, tickets: order, N, slotsForced: !!forcedOf(dir), autoN: autoOf(),
    preBoost: hasPreBoostWaiter(tickets), oldCode: tickets.filter((t) => t.status === 'live' && !(t.v >= TICKET_V)).length,
  };
}

const ticketRow = (t) => ({ file: t.name, pid: t.pid, procStart: t.procStart ?? null, owner: t.owner, label: t.label || `pid ${t.pid}`, status: t.status });
const runRow = (h) => ({
  slot: h.slot ?? 0, pid: h.pid, procStart: h.procStart ?? null, startedAt: h.startedAt, label: h.label || `pid ${h.pid}`, cmd: h.cmd || '', worktree: h.worktree || null,
  convoId: h.convoId ?? null, unit: h.unit ?? null, pgid: h.pgid ?? null, pgidStart: h.pgidStart ?? null,
});

/** Short persona-ish name for a button label ("🐙 Tuộc"): the label without its #hash. */
const shortName = (label) => clean(String(label).replace(/\s#[a-z0-9]+$/i, ''));

/**
 * The board for `view`: 'main' | 's:<i>' (ask to stop running #i) | 'b:<i>' (pick a block length for ticket #i) | 'rs' (ask to reset a corrupt policy).
 * → { text, rows, maps: { rows, running, blocks } }. `stoppingKeys`: holder keys (pid:startedAt) that already have a stop job.
 */
export function renderQ(g, { tok, rev, page = 0, view = 'main', pin = null, stoppingKeys = new Set() } = {}) {
  const { policy: pol, now } = g;
  const cb = (op, idx, arg) => qCallback(tok, rev, op, idx, arg);
  const maps = { rows: {}, running: {}, blocks: {}, quiet: g.quiet || null };
  // every non-dead waiting ticket gets a number (stalled / stopped count toward max too)
  g.tickets.forEach((t, i) => { maps.rows[String(i + 1)] = ticketRow(t); });
  const runnable = g.holders.filter((h) => !h.exclusive);
  runnable.forEach((h, i) => { maps.running[String(i + 1)] = runRow(h); });
  pol.blocks.forEach((b, i) => { maps.blocks[String(i + 1)] = b.owner; });

  if (view.startsWith('s:')) {
    const r = pin; // the build the owner pressed ⏹ on (identity, not a number that may have moved)
    if (r) return { view, text: `⏹ Dừng build của ${clean(r.label)} (pid ${r.pid})?\n${clean(shortCmd(r.cmd))}\nBuild bị dừng thoát exit 77; agent được báo đừng tự chạy lại.`, rows: [[{ text: `✅ Dừng ${shortName(r.label)} pid ${r.pid}`, callback_data: cb('sy', view.slice(2)) }, { text: '✖', callback_data: cb('x') }]], maps };
  }
  if (view.startsWith('b:')) {
    const r = pin;
    if (r) {
      const plan = blockPlan(r);
      return {
        text: `⛔ ${plan.scope}\nChọn thời hạn (vé đang chờ của họ bị kick luôn):`,
        view, rows: [[...Object.entries(Q_DURATIONS).map(([k, label]) => ({ text: label, callback_data: cb('bd', view.slice(2), k) })), { text: '✖', callback_data: cb('x') }]], maps,
      };
    }
  }
  if (view === 'rs') {
    return { view, text: '⚠️ Ghi đè build.policy.json bằng policy mặc định (max tắt, không chặn, không tạm dừng)?', rows: [[{ text: '✅ Ghi lại', callback_data: cb('rsy') }, { text: '✖', callback_data: cb('x') }]], maps };
  }

  const busy = g.holders.some((h) => h.exclusive) ? Math.max(g.N, g.holders.length) : g.holders.length;
  const lines = [`🔒 build ${busy}/${g.N} · chờ ${g.tickets.length} · max chờ: ${pol.max == null ? 'tắt' : `${pol.max} (thử lại sau ${pol.retryMin}')`}${pol.paused ? ' · ⏸' : ''}${g.gateNote ? ` · ${g.gateNote}` : ''}`];
  if (g.corrupt) lines.unshift(`⚠️ build.policy.json hỏng (${clean(g.error)}) — hạn chế của owner đang bị bỏ qua; mọi thao tác ghi bị từ chối.`);
  if (pol.paused && g.oldCode) lines.push(`⏸ (còn ${g.oldCode} vé code cũ không theo pause)`);
  if (g.preBoost) lines.push('⬆ tạm tắt: còn người chờ chạy code cũ — chờ họ xong');
  const rows = [];
  if (g.holders.length) lines.push('', `▶ Đang chạy (${g.holders.length}):`);
  g.holders.forEach((h) => {
    const idx = h.exclusive ? null : runnable.indexOf(h) + 1;
    const stopping = h.stopping || stoppingKeys.has(`${h.pid}:${h.startedAt}`) || h.stopAck;
    lines.push(`▶ ${clean(h.label || `pid ${h.pid}`)}${wtName(h)}${h.cmd ? ` — ${clean(shortCmd(h.cmd))}` : ''} (${mins(now - h.startedAt)}')${h.exclusive ? ' [cleanup giữ cả lock]' : ''}${stopping ? ' ⏳ đang dừng' : ''}`);
    if (idx && !stopping) rows.push([{ text: `⏹ ${shortName(h.label || `pid ${h.pid}`)}`, callback_data: cb('s', idx) }]);
  });
  const pages = Math.max(1, Math.ceil(g.tickets.length / Q_PAGE_SIZE));
  const pg = Math.min(Math.max(0, page), pages - 1);
  if (g.tickets.length) lines.push('', `⏳ Chờ (${g.tickets.length}):`);
  g.tickets.forEach((t, i) => {
    const boosted = Number.isFinite(pol.boosts[t.name]);
    const state = t.status === 'live' ? `chờ ${mins(now - t.createdAt)}'` : t.status === 'stalled' ? 'mất nhịp tim' : t.status === 'stopped' ? 'ctrl-Z' : t.status;
    if (Math.floor(i / Q_PAGE_SIZE) !== pg) return;
    lines.push(`${i + 1}. ${boosted ? '⬆ ' : ''}${clean(t.label || `pid ${t.pid}`)}${wtName(t)}${t.cmd ? ` — ${clean(shortCmd(t.cmd))}` : ''} (${state})`);
    const btn = [];
    if (t.status === 'live' && !g.preBoost) btn.push({ text: boosted ? `⬆✓ ${i + 1}` : `⬆ ${i + 1}`, callback_data: cb('t', i + 1) });
    btn.push({ text: `✖ ${i + 1}`, callback_data: cb('k', i + 1) }, { text: `⛔ ${i + 1}`, callback_data: cb('b', i + 1) });
    rows.push(btn);
  });
  if (pages > 1) lines.push(`(trang ${pg + 1}/${pages})`);
  if (pol.blocks.length) {
    lines.push('', '⛔ Đang chặn:');
    pol.blocks.forEach((b, i) => { lines.push(`${i + 1}. ${clean(b.label)} tới ${hhmm(b.until)}`); rows.push([{ text: `Bỏ chặn ${i + 1}`, callback_data: cb('u', i + 1) }]); });
  }
  if (pages > 1) rows.push([{ text: '‹', callback_data: cb('pg', Math.max(0, pg - 1)) }, { text: `${pg + 1}/${pages}`, callback_data: cb('r') }, { text: '›', callback_data: cb('pg', Math.min(pages - 1, pg + 1)) }]);
  rows.push([{ text: '▶ −', callback_data: cb('n-') }, { text: g.slotsForced ? '▶ 1' : `▶ ${g.autoN ?? g.N} (auto)`, callback_data: cb(g.slotsForced ? 'n+' : 'n-') }, { text: '▶ +', callback_data: cb('n+') }]);
  rows.push([{ text: '⏳ −', callback_data: cb('m-') }, { text: pol.max == null ? '⏳ tắt' : `⏳ ${pol.max}`, callback_data: cb('mt') }, { text: '⏳ +', callback_data: cb('m+') }]);
  // RFC 32 §4.4: switch the night rules off until the window ends / back on. The state is checked against the stored board on press.
  if (g.quiet?.active) rows.push([{ text: g.quiet.overridden ? '🌙 Bật lại' : `⏩ Tắt giờ im lặng tới ${hhmm(g.quiet.until)}`, callback_data: cb('qz') }]);
  rows.push([{ text: pol.paused ? '▶' : '⏸', callback_data: cb('p') }, { text: '🔄', callback_data: cb('r') }]);
  if (g.corrupt) rows.push([{ text: 'Ghi lại policy mặc định', callback_data: cb('rs') }]);
  return { view: 'main', text: lines.join('\n'), rows, maps, page: pg };
}
