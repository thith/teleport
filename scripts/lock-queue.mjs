// lock-queue.mjs — see / leave the machine-lock queues (RFC 21).
//
//   node ../teleport/scripts/lock-queue.mjs ls [--lock build]
//   node ../teleport/scripts/lock-queue.mjs leave [--lock build] [--all | --pid N]
//   node ../teleport/scripts/lock-queue.mjs slots [1|auto]     (owner: build slots, RFC 23)
//
// `leave` strikes waiting tickets (renames them to `.left`): by default the
// tickets of THIS agent's convo started in THIS worktree (subagents share the
// convo but each works in its own worktree, so one never strikes another's);
// --all: every ticket of the convo; --pid: that process's tickets
// (admin/maintainer use — the caller checks its role, like DM). Each ticket
// shows its worktree in `ls` / /health. A struck ticket can never run: if its waiter wins the lock in
// the same instant, the atomic claim (.json → .acq) decides — the loser gives
// way. A job already running is never touched.
// `slots 1` writes `<LOCK_DIR>/build.slots` (build lock limited to 1 slot even on
// a big machine); `slots auto` removes it; `slots` alone prints the current N.

import fs from 'node:fs';
import path from 'node:path';
import { LOCK_DIR, readQueue, readHolder, readHolders, cancelTickets, selfConvoId, describeHolder, readStruck, readClaimed, worktreeOf, slotsFor, slotFiles, memTotal, TWO_SLOT_MIN_RAM } from './machine-lock.mjs';
import { isMainModule } from './is-direct-run.mjs';

export const LOCK_NAMES = ['build', 'merge', 'cleanup'];
export const LIST_MAX = 10;

const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const STATUS_TEXT = { live: 'chờ', stalled: 'kẹt (mất nhịp tim)', stopped: 'bị dừng (ctrl-Z)', left: 'đã gạch (đang rời)' };

export const CMD_MAX = 80;
/** "🧚 Tiên #j8436116 · kytfunds" — who, and in which worktree. Pure. */
const who = (t) => `${t.label || `pid ${t.pid}`}${t.worktree ? ` · ${path.basename(t.worktree)}` : ''}`;
/** A command for display: whitespace folded, cut at ~80 chars with " …". Pure. */
export function shortCmd(cmd, max = CMD_MAX) {
  const s = String(cmd || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()} …` : s;
}

/**
 * One lock's running jobs + queue as text lines (read-only). RFC 23: one layout
 * for 1 or 2 slots — "đang chạy x/N", one ▶ line per running job, "Chờ (k):".
 */
export function formatQueue(name, { dir = LOCK_DIR, now = Date.now(), max = LIST_MAX, read = readQueue, struck = readStruck, holderOf = readHolder, slots = null } = {}) {
  const N = slotsFor(name, { slots, dir });
  const hs = readHolders(name, { dir, holderOf }).sort((a, b) => a.startedAt - b.startedAt || a.slot - b.slot);
  const q = [...read(name, { dir, now }).filter((t) => t.status !== 'dead'), ...struck(name, { dir }).map((t) => ({ ...t, status: 'left' }))]
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const head = q.find((t) => t.status === 'live');
  // an exclusive holder (cleanup) holds every slot; a build in a slot N no longer grants still counts (x may exceed N for a while)
  const busy = hs.some((h) => h.exclusive) ? Math.max(N, hs.length) : hs.length;
  const lines = [busy
    ? `🔒 ${name}: đang chạy ${busy}/${N}${busy < N ? ` — còn ${N - busy} chỗ trống` : ''}`
    : `🔒 ${name}: trống (0/${N})${head ? ` — ${head.label || `pid ${head.pid}`} đang nhận lock` : ''}`];
  for (const h of hs) {
    lines.push(`  ▶ ${describeHolder({ ...h, label: who(h), cmd: shortCmd(h.cmd) }, now)}${h.exclusive ? ` (giữ cả ${slotFiles(name)} chỗ)` : ''}${h.waitingRam ? ' (chờ RAM)' : ''}`);
  }
  if (q.length) lines.push(`  Chờ (${q.length}):`);
  q.slice(0, max).forEach((t, i) => lines.push(`  ${i + 1}. ${who(t)}${t.cmd ? ` — ${shortCmd(t.cmd)}` : ''} — ${STATUS_TEXT[t.status] || t.status} ${mins(now - t.createdAt)} phút`));
  if (q.length > max) lines.push(`  … và ${q.length - max} vé nữa`);
  return lines;
}

export function parseArgs(argv) {
  const o = { cmd: argv[0], lock: null, pid: null, all: false };
  if (o.cmd === 'slots') {
    if (argv.length > 2 || (argv[1] != null && !['1', 'auto'].includes(argv[1]))) return { error: 'usage: lock-queue.mjs slots [1|auto]' };
    return { cmd: 'slots', value: argv[1] ?? null };
  }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--lock') o.lock = argv[++i];
    else if (argv[i] === '--all') o.all = true;
    else if (argv[i] === '--pid') { o.pid = Number(argv[++i]); if (!Number.isSafeInteger(o.pid) || o.pid <= 0) return { error: '--pid cần một số' }; }
    else return { error: `không hiểu: ${argv[i]}` };
  }
  if (!['ls', 'leave'].includes(o.cmd)) return { error: 'usage: lock-queue.mjs ls [--lock build] | leave [--lock build] [--all | --pid N] | slots [1|auto]' };
  if (o.all && o.pid != null) return { error: '--all và --pid không dùng chung' };
  if (o.lock && !LOCK_NAMES.includes(o.lock)) return { error: `lock phải là một trong: ${LOCK_NAMES.join(', ')}` };
  return o;
}

/** leave → { lines, code } (code 0 = something struck, 1 = nothing to leave / refused). */
export function leave({ lock = null, pid = null, all = false }, { dir = LOCK_DIR, convoId = selfConvoId(), worktree = worktreeOf(), cancel = cancelTickets, holderOf = readHolder, claimed = readClaimed, read = readQueue } = {}) {
  if (pid == null && convoId == null) return { code: 1, lines: ['❌ Không xác định được convo của bạn — dùng --pid N (chỉ admin/maintainer).'] };
  const mine = (t) => t.convoId != null && String(t.convoId) === String(convoId);
  // default: this worktree only (not in a git worktree → the whole convo, as before)
  const here = all || !worktree ? () => true : (t) => t.worktree === worktree;
  const match = pid != null ? (t) => t.pid === pid : (t) => mine(t) && here(t);
  const lines = [];
  let struck = 0;
  for (const name of lock ? [lock] : LOCK_NAMES) {
    for (const t of cancel(name, match, { dir })) { struck++; lines.push(`✅ đã rời hàng ${name}: ${t.label || `pid ${t.pid}`}${t.cmd ? ` — ${t.cmd}` : ''} (sẽ không chạy)`); }
    // (every slot; a ticket claimed a moment ago — .acq, holder file not written yet — is running too)
    // (reported for the whole convo — useful context, never struck)
    const running = [...readHolders(name, { dir, holderOf }), ...claimed(name, { dir })].find((x) => (pid != null ? x.pid === pid : mine(x)));
    if (running) lines.push(`ℹ️ ${name}: việc của bạn đang chạy rồi (${running.cmd || `pid ${running.pid}`}) — không rời được; muốn dừng thì dừng chính tiến trình đó.`);
  }
  if (!lines.length) {
    const elsewhere = pid == null && !all && worktree ? (lock ? [lock] : LOCK_NAMES).flatMap((n) => read(n, { dir })).filter((t) => t.status !== 'dead' && mine(t)).length : 0;
    lines.push(elsewhere
      ? `ℹ️ Không có vé nào của bạn đang chờ trong worktree này (${path.basename(worktree)}); convo bạn còn ${elsewhere} vé ở worktree khác — rời hết thì thêm --all.`
      : 'ℹ️ Không có vé nào của bạn đang chờ.');
  }
  return { code: struck ? 0 : 1, lines };
}

export const PRUNE_SKIP_WARN = 5;
/** /health warning when the daily cargo-cache prune was skipped ≥ 5 times in a row (builds always running). */
export function pruneSkipLines({ dir = LOCK_DIR } = {}) {
  let n = 0;
  try { n = Number(fs.readFileSync(path.join(dir, 'cargo-prune-skips'), 'utf8')) || 0; } catch {}
  return n >= PRUNE_SKIP_WARN ? [`⚠️ cargo cache chưa prune được ${n} lần liên tiếp (lúc dọn luôn có build chạy)`] : [];
}

/** slots [1|auto] → lines. `1` writes <dir>/build.slots, `auto` removes it; none prints the current N. */
export function setSlots(value, { dir = LOCK_DIR, total = memTotal() } = {}) {
  const file = path.join(dir, 'build.slots');
  if (value === '1') { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, '1\n', { mode: 0o600 }); }
  else if (value === 'auto') { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const auto = total >= TWO_SLOT_MIN_RAM ? 2 : 1;
  const forced = fs.existsSync(file);
  return [`🔒 build: ${slotsFor('build', { dir })} chỗ (${forced ? `giới hạn 1 bởi ${file}` : `tự động theo RAM ${(total / 1024 ** 3).toFixed(0)} GiB → ${auto}`}). Áp dụng cho build lấy chỗ từ giờ; build đang chạy chạy nốt.`];
}

if (isMainModule(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) { console.error(a.error); process.exit(2); }
  if (a.cmd === 'slots') { console.log(setSlots(a.value).join('\n')); process.exit(0); }
  if (a.cmd === 'ls') {
    for (const name of a.lock ? [a.lock] : LOCK_NAMES) console.log(formatQueue(name).join('\n'));
    process.exit(0);
  }
  const r = leave(a);
  console.log(r.lines.join('\n'));
  process.exit(r.code);
}
