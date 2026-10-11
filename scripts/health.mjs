// `/health` — a daemon command: one-glance machine status for the owner.
// CPU load, RAM / swap, disk, the running claude agents (screen vs terminal,
// busy/idle), the biggest memory users, and warnings (low RAM / disk, an OOM
// kill in the last 24h). Read-only. Pure formatting is unit-tested; the probes
// below read /proc, df, ps and the user journal (best effort — a missing source
// just drops that line).

import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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
  const m = line && line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
  return m ? { size: Number(m[1]), avail: Number(m[2]), target: m[3] } : null;
}

/** `ps -eo comm=,rss=` body → [{ name, mb, count }] top N by memory. Pure. */
export function topMemory(text, n = 5) {
  const agg = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\d+)$/);
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
export function memoryAlert({ mem, top = [], now, lastAlertAt = 0, thresholdPct = MEM_ALERT_PCT, repeatMs = MEM_ALERT_REPEAT_MS }) {
  if (!mem || !mem.total || mem.available == null) return { alert: false };
  const pct = (mem.available / mem.total) * 100;
  if (pct >= thresholdPct || now - lastAlertAt < repeatMs) return { alert: false };
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

/** Death notice text. `oom` = an OOM kill was logged since the last check; `killedByOwner` = in the kill audit. Pure. */
export function deathText(rows, { oom = false, killedByOwner = new Set() } = {}) {
  const lines = [];
  for (const r of rows) {
    if (killedByOwner.has(r.pid)) continue; // the owner's own /kill — not news
    const who = `${r.name || 'agent'}${r.hashtag ? ` #${r.hashtag}` : ''}`;
    const why = oom ? ' — có vẻ do HẾT RAM (systemd-oomd vừa giết tiến trình)' : '';
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

/**
 * One watch pass (daemon heartbeat). `state` persists across calls:
 * { prevAgents, lastMemAlertAt, lastCheckSec }. Sends at most one RAM warning per
 * repeat window and one death notice per vanished agent. Side effects injectable.
 */
export async function machineWatch(state, send, {
  readMem = () => { try { return parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch { return null; } },
  listAgents = () => listClaudeProcs(),
  top = () => { const o = tryRun('ps', ['-eo', 'comm=,rss=']); return o ? topMemory(o) : []; },
  oomSince = (sec) => { const j = tryRun('journalctl', ['--user', '--since', `@${sec}`, '--no-pager', '-q']); return j ? countOomKills(j) : 0; },
  recentKills = () => recentOwnerKills(),
  now = Date.now,
} = {}) {
  const t = now();
  const mem = readMem();
  const m = memoryAlert({ mem, top: mem ? top() : [], now: t, lastAlertAt: state.lastMemAlertAt || 0 });
  if (m.alert) { state.lastMemAlertAt = t; await send(m.text); }
  let agents = null;
  try { agents = listAgents(); } catch { agents = null; }
  if (agents) {
    if (state.prevAgents) {
      const gone = agentDeaths(state.prevAgents, agents);
      if (gone.length) {
        const sinceSec = state.lastCheckSec || Math.floor(t / 1000) - 120;
        const text = deathText(gone, { oom: oomSince(sinceSec) > 0, killedByOwner: recentKills() });
        if (text) await send(text);
      }
    }
    state.prevAgents = agents;
  }
  state.lastCheckSec = Math.floor(t / 1000);
}

/** PIDs killed through /kill pid|name in the last 5 minutes (kill audit). */
export function recentOwnerKills(file = new URL('./tmp/kill-pid-audit.jsonl', import.meta.url), { now = Date.now(), windowMs = 5 * 60 * 1000 } = {}) {
  const out = new Set();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.trim().split('\n').slice(-50)) {
    try { const j = JSON.parse(line); if (now - Date.parse(j.ts) < windowMs && /exited|restarted/.test(j.result || '')) out.add(j.pid); } catch {}
  }
  return out;
}
