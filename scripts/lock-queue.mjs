// lock-queue.mjs — see / leave the machine-lock queues (RFC 21).
//
//   node ../teleport/scripts/lock-queue.mjs ls [--lock build]
//   node ../teleport/scripts/lock-queue.mjs leave [--lock build] [--pid N]
//
// `leave` strikes waiting tickets (renames them to `.left`): by default every
// ticket of THIS agent's convo (subagents share it — all of them leave); with
// --pid, that process's tickets (admin/maintainer use — the caller checks its
// role, like DM). A struck ticket can never run: if its waiter wins the lock in
// the same instant, the atomic claim (.json → .acq) decides — the loser gives
// way. A job already running is never touched.

import { LOCK_DIR, readQueue, readHolder, cancelTickets, selfConvoId, describeHolder, readStruck, readClaimed } from './machine-lock.mjs';
import { isMainModule } from './is-direct-run.mjs';

export const LOCK_NAMES = ['build', 'merge', 'cleanup'];
export const LIST_MAX = 10;

const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const STATUS_TEXT = { live: 'chờ', stalled: 'kẹt (mất nhịp tim)', stopped: 'bị dừng (ctrl-Z)', left: 'đã gạch (đang rời)' };

/** One lock's holder + queue as text lines (read-only). */
export function formatQueue(name, { dir = LOCK_DIR, now = Date.now(), max = LIST_MAX, read = readQueue, struck = readStruck, holderOf = readHolder } = {}) {
  const holder = holderOf(`${dir}/${name}.holder.json`);
  const q = [...read(name, { dir, now }).filter((t) => t.status !== 'dead'), ...struck(name, { dir }).map((t) => ({ ...t, status: 'left' }))]
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const head = q.find((t) => t.status === 'live');
  const lines = [`🔒 ${name}: ${holder?.alive ? `đang giữ — ${describeHolder(holder, now)}` : head ? `trống — ${head.label || `pid ${head.pid}`} đang nhận lock` : 'trống'}`];
  q.slice(0, max).forEach((t, i) => lines.push(`  ${i + 1}. ${t.label || `pid ${t.pid}`}${t.cmd ? ` — ${t.cmd}` : ''} — ${STATUS_TEXT[t.status] || t.status} ${mins(now - t.createdAt)} phút (pid ${t.pid})`));
  if (q.length > max) lines.push(`  … và ${q.length - max} vé nữa`);
  return lines;
}

export function parseArgs(argv) {
  const o = { cmd: argv[0], lock: null, pid: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--lock') o.lock = argv[++i];
    else if (argv[i] === '--pid') { o.pid = Number(argv[++i]); if (!Number.isSafeInteger(o.pid) || o.pid <= 0) return { error: '--pid cần một số' }; }
    else return { error: `không hiểu: ${argv[i]}` };
  }
  if (!['ls', 'leave'].includes(o.cmd)) return { error: 'usage: lock-queue.mjs ls [--lock build] | leave [--lock build] [--pid N]' };
  if (o.lock && !LOCK_NAMES.includes(o.lock)) return { error: `lock phải là một trong: ${LOCK_NAMES.join(', ')}` };
  return o;
}

/** leave → { lines, code } (code 0 = something struck, 1 = nothing to leave / refused). */
export function leave({ lock = null, pid = null }, { dir = LOCK_DIR, convoId = selfConvoId(), cancel = cancelTickets, holderOf = readHolder, claimed = readClaimed } = {}) {
  if (pid == null && convoId == null) return { code: 1, lines: ['❌ Không xác định được convo của bạn — dùng --pid N (chỉ admin/maintainer).'] };
  const match = pid != null ? (t) => t.pid === pid : (t) => t.convoId != null && String(t.convoId) === String(convoId);
  const lines = [];
  let struck = 0;
  for (const name of lock ? [lock] : LOCK_NAMES) {
    for (const t of cancel(name, match, { dir })) { struck++; lines.push(`✅ đã rời hàng ${name}: ${t.label || `pid ${t.pid}`}${t.cmd ? ` — ${t.cmd}` : ''} (sẽ không chạy)`); }
    const h = holderOf(`${dir}/${name}.holder.json`);
    // (a ticket claimed a moment ago — .acq, holder file not written yet — is running too)
    const running = [...(h?.alive ? [h] : []), ...claimed(name, { dir })].find((x) => match(x));
    if (running) lines.push(`ℹ️ ${name}: việc của bạn đang chạy rồi (${running.cmd || `pid ${running.pid}`}) — không rời được; muốn dừng thì dừng chính tiến trình đó.`);
  }
  if (!lines.length) lines.push('ℹ️ Không có vé nào của bạn đang chờ.');
  return { code: struck ? 0 : 1, lines };
}

if (isMainModule(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) { console.error(a.error); process.exit(2); }
  if (a.cmd === 'ls') {
    for (const name of a.lock ? [a.lock] : LOCK_NAMES) console.log(formatQueue(name).join('\n'));
    process.exit(0);
  }
  const r = leave(a);
  console.log(r.lines.join('\n'));
  process.exit(r.code);
}
