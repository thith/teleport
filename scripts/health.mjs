// `/health` — a daemon command: one-glance machine status for the owner (RFC 32 §4.5: short).
// One machine line (load/cores, RAM, free disk), one ⚠️ line of warnings, the biggest memory users only when RAM is
// tight, the locks, and "⚙️ Đang áp dụng" (the knobs in effect). Read-only. Pure formatting is unit-tested; the probes
// below read /proc, df, ps and the user journal (best effort — a missing source
// just drops that line).

import { pruneSkipLines } from './lock-queue.mjs';
import { LOCK_DIR, readHolders, readQueue, slotsFor, cpuGateNote } from './machine-lock.mjs';
import { readPolicy } from './build-policy.mjs';
import { quietState, readOverride, cpuLimitSupported } from './quiet-hours.mjs';
import { autoMergeAllowlist, readAutoMergeState } from './merge-inbox.mjs';
import { DEFAULT_PROJECTS_FILE } from './projects-config.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { listClaudeProcs } from './claude-procs.mjs';

const GB = 1024 ** 3;
const fmtGB = (b) => `${(b / GB).toFixed(1)} GB`;

/** /proc/meminfo body → { total, available, swapTotal, swapFree } in bytes. Pure. */
export function parseMeminfo(text) {
  const kb = (k) => { const m = String(text).match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm')); return m ? Number(m[1]) * 1024 : null; };
  return { total: kb('MemTotal'), available: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') };
}

/** `df -B1 --output=size,avail,target <path>` body → { size, avail, target } | null. Pure. */
export function parseDf(text) {
  const line = String(text).trim().split('\n')[1];
  const m = line && line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); // mount target may contain spaces
  return m ? { size: Number(m[1]), avail: Number(m[2]), target: m[3] } : null;
}

/** `ps -eo comm=,rss=` body → [{ name, mb, count }] top N by memory. Pure. */
export function topMemory(text, n = 5) {
  const agg = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^(.*?)\s+(\d+)$/); // comm may contain spaces
    if (!m) continue;
    const a = agg.get(m[1]) || { name: m[1], kb: 0, count: 0 };
    a.kb += Number(m[2]); a.count++;
    agg.set(m[1], a);
  }
  return [...agg.values()].sort((x, y) => y.kb - x.kb).slice(0, n).map((a) => ({ name: a.name, mb: Math.round(a.kb / 1024), count: a.count }));
}

/** Count `systemd-oomd killed` / `killed by the OOM killer` lines. Pure. */
export function countOomKills(journalText) {
  return String(journalText).split('\n').filter((l) => /systemd-oomd killed|killed by the OOM killer/i.test(l)).length;
}

/**
 * /proc/pressure/<cpu|io|memory> body → { some: {avg10, avg60, avg300}, full: {…} | null } | null. Pure.
 * PSI = % of wall time tasks were stalled waiting for that resource.
 */
export function parsePressure(text) {
  const row = (kind) => {
    const m = String(text ?? '').match(new RegExp(`^${kind}\\s+avg10=([\\d.]+)\\s+avg60=([\\d.]+)\\s+avg300=([\\d.]+)`, 'm'));
    return m ? { avg10: Number(m[1]), avg60: Number(m[2]), avg300: Number(m[3]) } : null;
  };
  const some = row('some');
  return some ? { some, full: row('full') } : null;
}

// Linux load counts tasks blocked on disk (D state) too, so load > cores alone
// doesn't mean the CPU is short — on this box it was the disk (PSI cpu ≈ 0,
// io full ≈ 67%). With PSI we warn on the resource tasks are actually waiting for.
export const CPU_PSI_ALERT = 50;  // cpu some avg10 %: tasks waiting for a CPU
export const IO_PSI_ALERT = 30;   // io full avg10 %: every task stalled on the disk

/** Build the /health message. All inputs passed in → pure. */
// Tappable next steps (Telegram turns a /command in the text into a link that sends it).
export const HEALTH_SHORTCUTS = '/cswap   /q   /ls';

const gbInt = (b) => Math.round(b / GB);
const topSize = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`);
export const RAM_TOP_SHOW_PCT = 80; // list the biggest RAM users only above this usage (or with a RAM / swap warning)

/**
 * RFC 32 §4.5: short, one line per fact. Machine line (load/N · RAM · free disk), ONE ⚠️ line joining every warning,
 * the biggest RAM users only when RAM is tight, the locks (formatLocksShort), then "⚙️ Đang áp dụng" (formatInEffect).
 * `extraWarn`: warnings the caller computed (e.g. builds running outside their scope).
 */
export function formatHealth({ cores, load, mem, disk, top, oomKills, locks = null, psi = null, inEffect = null, extraWarn = [] }) {
  const warn = [];
  const parts = [];
  let ramWarn = false;
  const cpuPsi = psi?.cpu?.some ?? null;
  const ioPsi = psi?.io?.full ?? null;
  if (load) {
    parts.push(`💻 load ${load[0].toFixed(1)}${cores ? `/${cores}` : ''}`); // load per core count, not a CPU % (a CPUQuota makes % misleading)
    if (cpuPsi) {
      if (cpuPsi.avg10 >= CPU_PSI_ALERT) warn.push(`CPU quá tải (${Math.round(cpuPsi.avg10)}% thời gian chờ CPU)`);
    } else if (cores && load[0] > cores) warn.push(`CPU quá tải (load ${load[0].toFixed(1)} > ${cores} nhân)`);
  }
  let usedPct = null;
  if (mem && mem.total) {
    const used = mem.total - (mem.available ?? 0);
    usedPct = (used / mem.total) * 100;
    parts.push(`🧠 RAM ${gbInt(used)}/${gbInt(mem.total)} GB`);
    if (mem.available != null && mem.available / mem.total < 0.15) { warn.push(`RAM sắp hết (còn ${fmtGB(mem.available)})`); ramWarn = true; }
    if (mem.swapTotal) {
      const swUsed = mem.swapTotal - (mem.swapFree ?? 0);
      if (swUsed / mem.swapTotal > 0.9) { warn.push(`Swap đầy ${gbInt(swUsed)}/${gbInt(mem.swapTotal)} GB`); ramWarn = true; }
    }
  }
  if (ioPsi && ioPsi.avg10 >= IO_PSI_ALERT) warn.push(`đĩa nghẽn ${Math.round(ioPsi.avg10)}% thời gian`);
  if (disk) {
    parts.push(`💾 đĩa trống ${gbInt(disk.avail)} GB`);
    if (diskLow(disk)) warn.push(`đĩa sắp đầy (còn ${Math.round((disk.avail / disk.size) * 100)}%)`);
  }
  if (oomKills) warn.push(`${oomKills} lần OOM-kill trong 24 giờ qua (xem /ls)`);
  warn.push(...extraWarn);
  const lines = ['🩺 Máy'];
  if (parts.length) lines.push(parts.join(' · '));
  if (warn.length) lines.push(`⚠️ ${warn.join(' · ')}`);
  if (top && top.length && ((usedPct != null && usedPct > RAM_TOP_SHOW_PCT) || ramWarn)) {
    lines.push(`🐘 ${top.slice(0, 5).map((t) => `${t.name}${t.count > 1 ? `×${t.count}` : ''} ${topSize(t.mb)}`).join(' · ')}`);
  }
  if (locks && locks.length) lines.push(...locks);
  if (inEffect && inEffect.length) lines.push('', '⚙️ Đang áp dụng', ...inEffect);
  lines.push('', HEALTH_SHORTCUTS);
  return lines.join('\n');
}

const labelOnly = (l) => String(l ?? '').replace(/\s#[a-z0-9]+$/i, '');

/**
 * RFC 32 §4.5: the locks, one line each. `build` always (holders with minutes, then waiting tickets); `merge` / `cleanup`
 * only while held or waited for. locks = { build?: { N, holders: [{label, startedAt, exclusive}], waiting }, merge?, cleanup? }.
 * A lock whose data could not be read is `null` → "?". Pure.
 */
export function formatLocksShort(locks, { now = Date.now() } = {}) {
  const out = [];
  for (const name of ['build', 'merge', 'cleanup']) {
    const l = locks?.[name];
    if (l === undefined) continue;
    if (l === null) { out.push(`🔒 ${name}: ?`); continue; }
    const hs = l.holders || [];
    if (name !== 'build' && !hs.length && !l.waiting) continue;
    const who = hs.map((h) => `▶ ${labelOnly(h.label) || 'pid ?'} (${Math.max(0, Math.round((now - h.startedAt) / 60000))}')${h.exclusive ? ' [giữ cả lock]' : ''}`);
    const head = name === 'build' ? `🔒 build ${hs.length}/${l.N ?? 1}` : `🔒 ${name}`;
    out.push(hs.length || name !== 'build' ? `${head}: ${[...who, `chờ ${l.waiting || 0}`].join(' · ')}` : `${head}: trống · chờ ${l.waiting || 0}`);
  }
  return out;
}

const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

/**
 * RFC 32 §4.5: "⚙️ Đang áp dụng" — only knobs teleport really has. Every input may be `undefined`/`null` = could not be
 * read → that line prints `?`. Pure.
 *   build   { slots, forced, gateNote }                    (forced = build.slots file)
 *   quiet   a quietState() result, optionally { error }
 *   policy  { max, paused, blocks: [{label, until}], boosts: k }
 *   automerge { enabled, patterns }
 */
export function formatInEffect({ build, quiet, policy, automerge } = {}) {
  const lines = [];
  if (!build) lines.push('• Build: ?');
  else {
    const how = build.forced ? `đặt tay = ${build.slots} (lock-queue slots 1)` : `tự động theo RAM${build.slots > 1 ? '; chỗ thứ 2 chỉ cấp khi CPU rảnh' : ''}`;
    lines.push(`• Build: ${build.slots} chỗ, ${how}${build.gateNote ? ` · chỗ thứ 2: ${build.gateNote}` : ''}`);
  }
  if (!quiet) lines.push('• 🌙 Giờ im lặng: ?');
  else if (!quiet.enabled) lines.push(`• 🌙 Giờ im lặng: tắt${quiet.error ? ` (cấu hình hỏng: ${quiet.error})` : ''}`);
  else {
    const now = !quiet.active ? 'chưa tới giờ' : quiet.overridden ? `TẮT TẠM tới ${hhmm(quiet.until)}` : `đang áp tới ${hhmm(quiet.until)}`;
    const rule = quiet.maxBuilds === 1 ? 'chỉ nhận build mới khi không còn build nào' : `tối đa ${quiet.maxBuilds} build`;
    lines.push(`• 🌙 Giờ im lặng ${quiet.from}–${quiet.to}: build ≤ ${quiet.cpuPercent}% CPU, ${rule} (bây giờ: ${now})${quiet.active && !quiet.overridden ? ' — bấm /q để tắt tạm' : ''}`);
  }
  if (!policy) lines.push('• Hàng /q: ?');
  else {
    const parts = [policy.max == null ? 'không giới hạn' : `max ${policy.max}`, policy.paused ? '⏸ tạm dừng' : 'không tạm dừng'];
    parts.push(policy.blocks?.length ? `chặn: ${policy.blocks.map((b) => `${b.label} tới ${hhmm(b.until)}`).join(', ')}` : 'không chặn ai');
    if (policy.boosts > 0) parts.push(`⬆ ưu tiên: ${policy.boosts} vé`);
    lines.push(`• Hàng /q: ${parts.join(', ')}`);
  }
  if (!automerge) lines.push('• Automerge: ?');
  else lines.push(`• Automerge: ${automerge.enabled ? 'bật' : 'tắt'}${automerge.patterns > 0 || automerge.enabled ? ` (${automerge.patterns} mẫu repo)` : ''}`);
  return lines;
}

// ── Proactive watch (daemon heartbeat): early low-RAM warning + agent deaths ──

export const MEM_ALERT_PCT = 15;
export const MEM_ALERT_REPEAT_MS = 30 * 60 * 1000;

/** Low-RAM early warning, rate-limited. Pure → { alert, text? }. */
/** Is a low-RAM warning due now? Pure. */
export function memoryAlertDue({ mem, now, lastAlertAt = 0, thresholdPct = MEM_ALERT_PCT, repeatMs = MEM_ALERT_REPEAT_MS }) {
  if (!mem || !mem.total || mem.available == null) return false;
  return (mem.available / mem.total) * 100 < thresholdPct && now - lastAlertAt >= repeatMs;
}

export function memoryAlert({ mem, top = [], now, lastAlertAt = 0, thresholdPct = MEM_ALERT_PCT, repeatMs = MEM_ALERT_REPEAT_MS }) {
  if (!memoryAlertDue({ mem, now, lastAlertAt, thresholdPct, repeatMs })) return { alert: false };
  const pct = (mem.available / mem.total) * 100;
  const swap = mem.swapTotal ? ` · swap ${fmtGB(mem.swapTotal - (mem.swapFree ?? 0))} / ${fmtGB(mem.swapTotal)}` : '';
  const tops = top.slice(0, 4).map((t) => `${t.name}${t.count > 1 ? ` ×${t.count}` : ''} ${t.mb >= 1024 ? `${(t.mb / 1024).toFixed(1)} GB` : `${t.mb} MB`}`).join(', ');
  return {
    alert: true,
    text: `⚠️ RAM sắp hết: còn ${fmtGB(mem.available)} / ${fmtGB(mem.total)} (${Math.round(pct)}%)${swap}.\nHệ thống có thể sắp giết agent (systemd-oomd).${tops ? `\nĂn RAM nhiều nhất: ${tops}.` : ''}\nXem /health · /ls, tắt bớt phiên không dùng: /kill <tên>`,
  };
}

// ── Disk alert (RFC 18 §D): statfs of $HOME → immediate DM, then a `du` table ──

export const DISK_ALERT_PCT = 15;
export const DISK_ALERT_BYTES = 40 * GB;
export const DISK_ALERT_REPEAT_MS = 30 * 60 * 1000;
export const DU_TIMEOUT_MS = 60_000;
export const DU_TOP_N = 8;

/** fs.statfsSync result → { size, avail } in bytes (avail = what an unprivileged user can write). Pure. */
export function diskFromStatfs(s) {
  if (!s || !s.bsize) return null;
  return { size: Number(s.blocks) * Number(s.bsize), avail: Number(s.bavail) * Number(s.bsize) };
}

/** Free space below 15% OR below 40 GiB. Pure. */
export function diskLow(disk, { pct = DISK_ALERT_PCT, bytes = DISK_ALERT_BYTES } = {}) {
  if (!disk || !disk.size) return false;
  return (disk.avail / disk.size) * 100 < pct || disk.avail < bytes;
}

/** Is a low-disk DM due now? Pure. */
export function diskAlertDue({ disk, now, lastAlertAt = 0, repeatMs = DISK_ALERT_REPEAT_MS }) {
  return diskLow(disk) && now - lastAlertAt >= repeatMs;
}

export function diskAlertText(disk) {
  const pct = Math.round((disk.avail / disk.size) * 100);
  return `💾 Disk sắp đầy: còn ${fmtGB(disk.avail)} / ${fmtGB(disk.size)} (${pct}%).\nĐang đo các thư mục lớn nhất, sẽ gửi ngay sau. Xem /health.`;
}

/**
 * Directories to measure, expanded with readdir (execFile has no shell, so a
 * glob string would reach `du` literally): ~/Projects/*, ~/.cache/teleport/*,
 * /tmp/claude-*. Only real directories (no symlinks). Missing roots are skipped.
 */
export function duTargets({ home = os.homedir(), tmp = '/tmp', readdir = (d) => fs.readdirSync(d, { withFileTypes: true }) } = {}) {
  const out = [];
  const expand = (dir, keep = () => true) => {
    let ents;
    try { ents = readdir(dir); } catch { return; }
    for (const e of ents) if (e.isDirectory() && keep(e.name)) out.push(path.join(dir, e.name));
  };
  expand(path.join(home, 'Projects'));
  expand(path.join(home, '.cache', 'teleport'));
  expand(tmp, (n) => n.startsWith('claude-'));
  return out;
}

/** [bin, args] for the low-priority du (plain du when nice/ionice are unavailable). Pure. */
export function duCommand(dirs, { lowPriority = true } = {}) {
  const du = ['du', '-x', '-B1', '-s', '--', ...dirs];
  return lowPriority ? ['nice', ['-n19', 'ionice', '-c3', ...du]] : [du[0], du.slice(1)];
}

/** `du -B1 -s` body → [{ bytes, path }] (a cut-off last line is dropped). Pure. */
export function parseDu(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\d+)\t(.+)$/);
    if (m) rows.push({ bytes: Number(m[1]), path: m[2] });
  }
  return rows;
}

const fmtSize = (b) => (b >= GB ? fmtGB(b) : `${Math.round(b / 1024 ** 2)} MB`);

/** The second DM: top N directories by size. Pure. */
export function formatDuTop(rows, { partial = false, home = os.homedir(), n = DU_TOP_N } = {}) {
  const top = [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, n);
  const short = (p) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p);
  const lines = [`📂 Thư mục lớn nhất${partial ? ' (một phần / quá giờ)' : ''}:`];
  top.forEach((r, i) => lines.push(`${i + 1}. ${short(r.path)}: ${fmtSize(r.bytes)}`));
  return lines.join('\n');
}

/**
 * Run du async, bounded. Resolves { stdout, timedOut, code } — never rejects.
 * `code`: 'ENOENT' when the binary is missing, the exit status otherwise (127 =
 * `nice` ran but could not find `ionice`/`du`), null on success.
 */
export function runDuDefault(bin, args, timeout = DU_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      // du exits 1 on an unreadable subdir but its totals are still valid → keep stdout on any error
      resolve({ stdout: String(stdout || ''), timedOut: !!(err && (err.killed || err.signal)), code: err ? (err.code ?? null) : null });
    });
  });
}

/** ENOENT (no `nice`) or exit 127 (`nice` could not exec `ionice`). Pure. */
export const wrapperUnavailable = (code) => code === 'ENOENT' || code === 127;

/**
 * The du follow-up. One at a time: `state.duInFlight` guards it, so a slow du
 * is never stacked by the next heartbeat. Returns the promise (tests await it;
 * machineWatch does not).
 */
export function diskFollowUp(state, send, { targets = () => duTargets(), runDu = runDuDefault, home = os.homedir() } = {}) {
  if (state.duInFlight) return state.duPromise;
  state.duInFlight = true;
  state.duPromise = (async () => {
    try {
      const dirs = targets();
      if (!dirs.length) return;
      let [bin, args] = duCommand(dirs);
      let r = await runDu(bin, args);
      let rows = parseDu(r.stdout);
      if (!rows.length && wrapperUnavailable(r.code)) { // nice or ionice missing → plain du
        [bin, args] = duCommand(dirs, { lowPriority: false });
        r = await runDu(bin, args);
        rows = parseDu(r.stdout);
      }
      if (!rows.length) return; // nothing measured (timed out before the first total) → skip
      await send(formatDuTop(rows, { partial: r.timedOut, home }));
    } catch {} finally { state.duInFlight = false; }
  })();
  return state.duPromise;
}

const DISK_STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp', 'disk-watch.json');
function readDiskState(file = DISK_STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeDiskState(obj, file = DISK_STATE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch {}
}

/** Disk part of a watch pass. Own state file (never the shared health-state.json). */
export async function diskWatch(state, send, {
  statfs = () => fs.statfsSync(os.homedir()),
  diskPersisted = { read: readDiskState, write: writeDiskState },
  followUp = (st, s) => diskFollowUp(st, s),
  now = Date.now,
} = {}) {
  let disk;
  try { disk = diskFromStatfs(statfs()); } catch { return; }
  const t = now();
  let saved = {};
  try { saved = diskPersisted.read() || {}; } catch {}
  // in-memory fallback: on a FULL disk the persisted write fails (ENOSPC), and
  // without it every heartbeat would DM again
  const last = Math.max(saved.lastDiskAlertAt || 0, state.lastDiskAlertAt || 0);
  if (!diskAlertDue({ disk, now: t, lastAlertAt: last })) return;
  state.lastDiskAlertAt = t;
  try { diskPersisted.write({ ...saved, lastDiskAlertAt: t }); } catch {}
  await send(diskAlertText(disk));
  followUp(state, send); // not awaited: du can take up to a minute
}

/** Agents (claude rows) present before and gone now, matched by pid + start fingerprint. Pure. */
export function agentDeaths(prev = [], now = []) {
  const key = (r) => `${r.pid}:${r.procStart ?? ''}`;
  const alive = new Set(now.map(key));
  return prev.filter((r) => !alive.has(key(r)));
}

/**
 * Was THIS agent an OOM victim? The journal names the exact pid ("Killed process
 * <pid>") or the agent's own systemd unit ("<unit>: … killed …"). Pure.
 */
export function oomVictim(row, journalText, unit = null) {
  const t = String(journalText || '');
  if (new RegExp(`Killed process ${row.pid}\\b`).test(t)) return true;
  if (unit && t.split('\n').some((l) => l.includes(`${unit}:`) && /killed/i.test(l))) return true;
  return false;
}

/**
 * systemd-oomd kills in a journal window → { kills, procs, at, units } (at = time
 * of the last one) | null. oomd kills a whole scope under memory pressure, so its
 * line often names neither the agent's pid nor a unit we recorded. Kills of a
 * unit in `skipUnits` (a still-living agent's) are not counted. Pure.
 */
export function oomdSummary(journalText, { skipUnits = [] } = {}) {
  let kills = 0, procs = 0, at = null;
  const units = [];
  for (const l of String(journalText || '').split('\n')) {
    const m = /\s([^\s:]+): systemd-oomd killed (\d+) process/i.exec(l);
    if (!m || skipUnits.includes(m[1])) continue;
    kills++; procs += Number(m[2]);
    if (!units.includes(m[1])) units.push(m[1]);
    at = (/^\w{3}\s+\d+ (\d\d:\d\d)/.exec(l) || [])[1] || at; // journalctl pads days 1–9 with a space
  }
  return kills ? { kills, procs, at, units } : null;
}

/**
 * Death notice text. `oomOf(row)` → OOM evidence for that agent; `oomd` → an
 * oomd kill in the same window that names nobody (shown as context, not as the
 * cause); `killedByOwner` = { pids, hashtags } from the kill audit (the owner's
 * own /kill is not news). Pure.
 */
export function deathText(rows, { oomOf = () => false, oomd = null, killedByOwner = { pids: new Set(), hashtags: new Set() } } = {}) {
  const lines = [];
  for (const r of rows) {
    if (killedByOwner.pids?.has(r.pid) || (r.hashtag && killedByOwner.hashtags?.has(r.hashtag))) continue;
    const who = `${r.name || 'agent'}${r.hashtag ? ` #${r.hashtag}` : ''}`;
    const why = oomOf(r) ? ' — do HẾT RAM (bị OOM-killer giết)'
      : oomd ? ` (lúc ${oomd.at || 'đó'} systemd-oomd có giết ${oomd.procs} tiến trình ở ${oomd.units.slice(0, 2).join(', ')} vì máy thiếu bộ nhớ — có thể liên quan)`
        : ' (không rõ lý do — có thể đã thoát bình thường)';
    lines.push(`💀 ${who} (PID ${r.pid}) đã tắt${why}. Bật lại: /resume ${r.hashtag ? `#${r.hashtag}` : (r.name || '<tên>')}`);
  }
  return lines.join('\n');
}

function tryRun(bin, args) {
  try { return String(execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })); } catch { return null; }
}

/** Strict JSON read for /health: missing file → {} (nothing configured), any other failure throws (that line prints `?`). */
const readJsonOrEmpty = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return {}; throw e; } };
const tryOr = (f, fallback = null) => { try { return f(); } catch { return fallback; } };

/**
 * Read the state files for the locks lines and "Đang áp dụng". Every piece is independent: one that cannot be read is
 * `null` (the line prints `?`), never an exception. Returns { locks, inEffect, extraWarn }. Injectable for tests.
 * (health.mjs reads `_config.buildQuietHours`, never `_config.quietHours` — that one belongs to the heartbeat reminders.)
 */
export function gatherLocal({ dir = LOCK_DIR, now = Date.now(), projectsFile = DEFAULT_PROJECTS_FILE, readProjects = readJsonOrEmpty, supported = cpuLimitSupported, pruneLines = () => pruneSkipLines({ dir }) } = {}) {
  const cfg = tryOr(() => readProjects(projectsFile));
  const lockData = {};
  const buildHolders = tryOr(() => readHolders('build', { dir }));
  for (const name of ['build', 'merge', 'cleanup']) {
    lockData[name] = tryOr(() => ({
      N: slotsFor(name, { dir }), holders: name === 'build' && buildHolders ? buildHolders : readHolders(name, { dir }),
      waiting: readQueue(name, { dir, now }).filter((t) => t.status !== 'dead').length,
    }));
  }
  const quiet = cfg ? tryOr(() => quietState({ config: cfg._config?.buildQuietHours, now, override: readOverride(dir) })) : null;
  const inEffect = formatInEffect({
    build: tryOr(() => { const N = slotsFor('build', { dir }); return { slots: N, forced: fs.existsSync(path.join(dir, 'build.slots')), gateNote: cpuGateNote({ dir, N, now }) }; }),
    quiet,
    policy: tryOr(() => { const r = readPolicy(dir, { now }); return r.corrupt ? null : { max: r.policy.max, paused: r.policy.paused, blocks: r.policy.blocks, boosts: Object.keys(r.policy.boosts || {}).length }; }),
    automerge: cfg ? tryOr(() => ({ enabled: readAutoMergeState().enabled, patterns: autoMergeAllowlist({ configPatterns: Array.isArray(cfg._config?.autoMergeRepos) ? cfg._config.autoMergeRepos : [], addedPatterns: readAutoMergeState().repos }).patterns.length })) : null,
  });
  const extraWarn = [];
  if (quiet?.error) extraWarn.push(`giờ im lặng: cấu hình hỏng (${quiet.error}) — đang tắt`);
  if (quiet?.enabled && !tryOr(() => supported(), false)) extraWarn.push('giờ im lặng: máy này không giới hạn được CPU (thiếu systemd cpu)');
  const outside = quiet?.enabled && buildHolders ? buildHolders.filter((h) => h.scoped === false && !h.exclusive && !h.pending).length : 0; // (holders still `pending` have not passed the scope preflight yet)
  if (outside) extraWarn.push(`${outside} build đang chạy ngoài scope, không bị giới hạn CPU`);
  for (const l of tryOr(() => pruneLines(), [])) extraWarn.push(l.replace(/^⚠️\s*/, ''));
  return { locks: formatLocksShort(lockData, { now }), inEffect, extraWarn };
}

if (isMainModule(import.meta.url)) {
  let mem = null;
  try { mem = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch {}
  const dfOut = tryRun('df', ['-B1', '--output=size,avail,target', os.homedir()]);
  const psOut = tryRun('ps', ['-eo', 'comm=,rss=']);
  const journal = tryRun('journalctl', ['--user', '--since', '24 hours ago', '--no-pager', '-q']);
  const local = gatherLocal();
  process.stdout.write(formatHealth({
    cores: os.cpus().length, load: os.loadavg(), mem,
    psi: (() => { const r = (k) => { try { return parsePressure(fs.readFileSync(`/proc/pressure/${k}`, 'utf8')); } catch { return null; } }; return { cpu: r('cpu'), io: r('io') }; })(),
    disk: dfOut ? parseDf(dfOut) : null,
    top: psOut ? topMemory(psOut) : null, oomKills: journal ? countOomKills(journal) : 0,
    ...local,
  }) + '\n');
}

const execFileP = (bin, args, timeout = 10_000) => new Promise((resolve) => {
  execFile(bin, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
});
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp', 'health-state.json');
function readState(file = STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeState(obj, file = STATE_FILE) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); } catch {} }

/** The leaf systemd unit of a pid (e.g. run-r….scope), or null. */
export function unitOf(pid) {
  try {
    const t = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    return t.trim().split('\n').map((l) => l.split('/').pop()).find((x) => /\.(scope|service)$/.test(x)) || null;
  } catch { return null; }
}

/**
 * One watch pass (daemon heartbeat). `state` persists across calls (in memory):
 * { prevAgents, units, lastCheckSec }; the last RAM-alert time is persisted on
 * disk so a daemon restart doesn't reset the 30-min throttle. Probes are async
 * and bounded (ps / journalctl never block the daemon's event loop); the top
 * memory users are only collected when a warning is actually due. The disk
 * check (diskWatch) runs first, with its own throttle file and a detached du
 * follow-up.
 */
export async function machineWatch(state, send, {
  readMem = () => { try { return parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch { return null; } },
  listAgents = () => listClaudeProcs({ strict: true }),
  top = async () => { const o = await execFileP('ps', ['-eo', 'comm=,rss=']); return o ? topMemory(o) : []; },
  journalSince = async (sec) => (await execFileP('journalctl', ['--since', `@${sec}`, '--no-pager', '-q'])) ?? (await execFileP('journalctl', ['--user', '--since', `@${sec}`, '--no-pager', '-q'])) ?? '',
  recentKills = () => recentOwnerKills(),
  unit = unitOf,
  persisted = { read: readState, write: writeState },
  now = Date.now,
  statfs, diskPersisted, followUp,
} = {}) {
  const t = now();
  try { await diskWatch(state, send, { statfs, diskPersisted, followUp, now }); } catch {}
  const disk = persisted.read();
  const mem = readMem();
  if (memoryAlertDue({ mem, now: t, lastAlertAt: disk.lastMemAlertAt || 0 })) {
    const m = memoryAlert({ mem, top: await top(), now: t, lastAlertAt: disk.lastMemAlertAt || 0 });
    if (m.alert) { persisted.write({ ...disk, lastMemAlertAt: t }); await send(m.text); }
  }
  let agents;
  try { agents = listAgents(); } catch { return; } // listing failed → keep the previous snapshot, report nothing
  const key = (r) => `${r.pid}:${r.procStart ?? ''}`;
  if (state.prevAgents) {
    const gone = agentDeaths(state.prevAgents, agents);
    if (gone.length) {
      const sinceSec = (state.lastCheckSec || Math.floor(t / 1000) - 120) - 5;
      const journal = await journalSince(sinceSec);
      const text = deathText(gone, { oomOf: (r) => oomVictim(r, journal, state.units?.[key(r)]), oomd: oomdSummary(journal, { skipUnits: agents.map((r) => state.units?.[key(r)]).filter(Boolean) }), killedByOwner: recentKills() });
      if (text) await send(text);
    }
  }
  state.prevAgents = agents;
  state.units = Object.fromEntries(agents.map((r) => [key(r), unit(r.pid)]));
  state.lastCheckSec = Math.floor(t / 1000);
}

/** PIDs and screen hashtags stopped through /kill (pid|name|<hashtag>) in the last 5 minutes. */
export function recentOwnerKills(file = new URL('./tmp/kill-pid-audit.jsonl', import.meta.url), { now = Date.now(), windowMs = 5 * 60 * 1000 } = {}) {
  const pids = new Set(), hashtags = new Set();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { pids, hashtags }; }
  for (const line of text.trim().split('\n').slice(-50)) {
    try {
      const j = JSON.parse(line);
      if (now - Date.parse(j.ts) >= windowMs || !/exited|restarted|killed/.test(j.result || '')) continue;
      if (j.pid) pids.add(j.pid);
      if (j.hashtag) hashtags.add(j.hashtag);
    } catch {}
  }
  return { pids, hashtags };
}
