// `/health` — a daemon command: one-glance machine status for the owner.
// CPU load, RAM / swap, disk, the running claude agents (screen vs terminal,
// busy/idle), the biggest memory users, and warnings (low RAM / disk, an OOM
// kill in the last 24h). Read-only. Pure formatting is unit-tested; the probes
// below read /proc, df, ps and the user journal (best effort — a missing source
// just drops that line).

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

/** Build the /health message. All inputs passed in → pure. */
export function formatHealth({ cores, load, mem, disk, agents, top, oomKills }) {
  const warn = [];
  const lines = ['🩺 Tình trạng máy', ''];
  if (load) {
    const pct = cores ? Math.round((load[0] / cores) * 100) : null;
    lines.push(`🖥 CPU: ${cores} nhân · load ${load.map((x) => x.toFixed(2)).join(' / ')}${pct != null ? ` (~${pct}%)` : ''}`);
    if (cores && load[0] > cores) warn.push(`CPU quá tải (load ${load[0].toFixed(1)} > ${cores} nhân)`);
  }
  if (mem && mem.total) {
    const used = mem.total - (mem.available ?? 0);
    lines.push(`🧠 RAM: dùng ${fmtGB(used)} / ${fmtGB(mem.total)} · còn khả dụng ${fmtGB(mem.available ?? 0)}`);
    if (mem.available != null && mem.available / mem.total < 0.15) warn.push(`RAM sắp hết (còn ${fmtGB(mem.available)})`);
    if (mem.swapTotal) {
      const swUsed = mem.swapTotal - (mem.swapFree ?? 0);
      lines.push(`💤 Swap: ${fmtGB(swUsed)} / ${fmtGB(mem.swapTotal)}${swUsed / mem.swapTotal > 0.9 ? ' ⚠️ gần đầy' : ''}`);
    }
  }
  if (disk) {
    const pctFree = Math.round((disk.avail / disk.size) * 100);
    lines.push(`💾 Disk ${disk.target}: còn trống ${fmtGB(disk.avail)} / ${fmtGB(disk.size)} (${pctFree}%)`);
    if (pctFree < 10) warn.push(`Disk sắp đầy (còn ${pctFree}%)`);
  }
  if (agents) {
    const screen = agents.filter((a) => a.screen).length;
    const busy = agents.filter((a) => a.status === 'busy').length;
    lines.push(`🤖 Agent claude: ${agents.length} đang chạy (📺 screen ${screen} · 🖥 terminal ${agents.length - screen}) · busy ${busy}`);
  }
  if (top && top.length) {
    lines.push('', 'Ăn RAM nhiều nhất:');
    for (const t of top) lines.push(`• ${t.name}${t.count > 1 ? ` ×${t.count}` : ''}: ${t.mb >= 1024 ? `${(t.mb / 1024).toFixed(1)} GB` : `${t.mb} MB`}`);
  }
  if (oomKills) warn.push(`${oomKills} lần OOM-kill trong 24 giờ qua (systemd-oomd). Có thể có agent đã bị tắt, xem /ls`);
  lines.push('', warn.length ? `⚠️ ${warn.join('\n⚠️ ')}` : '✅ Không có cảnh báo.');
  return lines.join('\n');
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
    text: `⚠️ RAM sắp hết: còn ${fmtGB(mem.available)} / ${fmtGB(mem.total)} (${Math.round(pct)}%)${swap}.\nHệ thống có thể sắp giết agent (systemd-oomd).${tops ? `\nĂn RAM nhiều nhất: ${tops}.` : ''}\nXem /health · /ls, tắt bớt phiên không dùng: /kill name:"…"`,
  };
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
 * Death notice text. `oomOf(row)` → OOM evidence for that agent; `killedByOwner`
 * = { pids, hashtags } from the kill audit (the owner's own /kill is not news). Pure.
 */
export function deathText(rows, { oomOf = () => false, killedByOwner = { pids: new Set(), hashtags: new Set() } } = {}) {
  const lines = [];
  for (const r of rows) {
    if (killedByOwner.pids?.has(r.pid) || (r.hashtag && killedByOwner.hashtags?.has(r.hashtag))) continue;
    const who = `${r.name || 'agent'}${r.hashtag ? ` #${r.hashtag}` : ''}`;
    const why = oomOf(r) ? ' — do HẾT RAM (bị OOM-killer giết)' : ' (không rõ lý do — có thể đã thoát bình thường)';
    lines.push(`💀 ${who} (PID ${r.pid}) đã tắt${why}. Bật lại: /resume ${r.hashtag ? `#${r.hashtag}` : (r.name || '<tên>')}`);
  }
  return lines.join('\n');
}

function tryRun(bin, args) {
  try { return String(execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })); } catch { return null; }
}

if (isMainModule(import.meta.url)) {
  let mem = null;
  try { mem = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch {}
  const dfOut = tryRun('df', ['-B1', '--output=size,avail,target', os.homedir()]);
  const psOut = tryRun('ps', ['-eo', 'comm=,rss=']);
  const journal = tryRun('journalctl', ['--user', '--since', '24 hours ago', '--no-pager', '-q']);
  let agents = null;
  try { agents = listClaudeProcs(); } catch {}
  process.stdout.write(formatHealth({
    cores: os.cpus().length, load: os.loadavg(), mem,
    disk: dfOut ? parseDf(dfOut) : null, agents,
    top: psOut ? topMemory(psOut) : null, oomKills: journal ? countOomKills(journal) : 0,
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
 * memory users are only collected when a warning is actually due.
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
} = {}) {
  const t = now();
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
      const text = deathText(gone, { oomOf: (r) => oomVictim(r, journal, state.units?.[key(r)]), killedByOwner: recentKills() });
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
