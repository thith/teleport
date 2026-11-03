// quiet-hours.mjs — RFC 32 §4: build quiet hours. At night builds may use only a fraction of the CPU (so the
// fans stay quiet) and, when the build count is auto, only one new build starts at a time.
//
// Config (off unless present): projects.json `_config.buildQuietHours` = { from: "23:30", to: "06:00", cpuPercent: 25,
// maxBuilds: 1 }. NOT `_config.quietHours` (that one silences heartbeat reminders). Local time of this machine.
// Pure parts (quietState, parseTimespanUs) take everything injected; the IO helpers are small and injectable too.
//
// The CPU limit is `CPUQuota` on ONE shared slice, `app-teleportbuild.slice` (heavy puts every build scope in it;
// the name makes it a child of app.slice, so appSliceOomKills() still sees the builds). syncQuietCpu() makes the
// slice match quietState() and is idempotent: it only calls `systemctl --user set-property --runtime` when the
// slice differs. Nothing here may throw into its caller: no systemd / no cgroup cpu controller = warn and go on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readProjectsConfig } from './projects-config.mjs';

export const QUIET_SLICE = 'app-teleportbuild.slice';
export const OVERRIDE_FILE = 'quiet.override.json';
export const APPLIED_FILE = 'quiet.applied'; // marker: we set a quota, so a later "off" config must still remove it
export const DEFAULT_QUIET_CPU_PERCENT = 25;
export const DEFAULT_QUIET_MAX_BUILDS = 1;

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const toMin = (s) => { const m = HHMM.exec(String(s ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

/** raw `_config.buildQuietHours` → { config } | { config: null } (not set) | { config: null, error }. Pure. */
export function parseQuietConfig(raw) {
  if (raw == null) return { config: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { config: null, error: 'buildQuietHours phải là object {from,to,cpuPercent,maxBuilds}' };
  const from = toMin(raw.from), to = toMin(raw.to);
  if (from == null || to == null) return { config: null, error: 'buildQuietHours.from/to phải dạng HH:MM' };
  if (from === to) return { config: null, error: 'buildQuietHours.from và to không được bằng nhau' };
  const cpuPercent = raw.cpuPercent == null ? DEFAULT_QUIET_CPU_PERCENT : Number(raw.cpuPercent);
  if (!(cpuPercent > 0 && cpuPercent <= 100)) return { config: null, error: 'buildQuietHours.cpuPercent phải trong (0, 100]' };
  const maxBuilds = raw.maxBuilds == null ? DEFAULT_QUIET_MAX_BUILDS : Number(raw.maxBuilds);
  if (!Number.isSafeInteger(maxBuilds) || maxBuilds < 1) return { config: null, error: 'buildQuietHours.maxBuilds phải là số nguyên ≥ 1' };
  return { config: { from: String(raw.from), to: String(raw.to), fromMin: from, toMin: to, cpuPercent, maxBuilds } };
}

/** The next time of day `min` strictly after `now` (ms). */
function nextAt(min, now) {
  const d = new Date(now);
  d.setHours(Math.floor(min / 60), min % 60, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * The quiet-hours state at `now`. `config` = the raw `_config.buildQuietHours` value; `override` = the parsed
 * quiet.override.json ({ offUntil }) or null.
 * → { enabled, active, until, cpuPercent, maxBuilds, overridden, from, to, error? }
 *   until = end of the running window, or the start of the next one when outside; overridden = active but
 *   switched off by the owner until the window's end.
 */
export function quietState({ config, now = Date.now(), override = null } = {}) {
  const { config: c, error } = parseQuietConfig(config);
  if (!c) return { enabled: false, active: false, until: null, cpuPercent: null, maxBuilds: null, overridden: false, ...(error ? { error } : {}) };
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const active = c.fromMin < c.toMin ? m >= c.fromMin && m < c.toMin : m >= c.fromMin || m < c.toMin;
  const until = nextAt(active ? c.toMin : c.fromMin, now);
  const overridden = active && Number.isFinite(override?.offUntil) && override.offUntil > now;
  return { enabled: true, active, until, cpuPercent: c.cpuPercent, maxBuilds: c.maxBuilds, overridden, from: c.from, to: c.to };
}

/** True while the night rules apply (active and not switched off). */
export const quietApplies = (q) => !!(q && q.active && !q.overridden);

// ── override file ──

export const overridePath = (dir) => path.join(dir, OVERRIDE_FILE);

/** { offUntil, by, at } | null (missing / corrupt). */
export function readOverride(dir, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  try { const j = JSON.parse(read(overridePath(dir))); return j && typeof j === 'object' && Number.isFinite(j.offUntil) ? j : null; } catch { return null; }
}

/** Atomic, 0600. Throws on IO error (the caller reports it). */
export function writeOverride(dir, { offUntil, by = null, at = Date.now() }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = overridePath(dir), tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ offUntil, by, at }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearOverride(dir) {
  try { fs.unlinkSync(overridePath(dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

/** The raw `_config.buildQuietHours` of projects.json (undefined when unset / unreadable). */
export function readQuietConfig(file) {
  try { return (file ? readProjectsConfig(file) : readProjectsConfig())?._config?.buildQuietHours; } catch { return undefined; }
}

/** quietState from the real config file + override in `dir`. */
export function quietNow({ dir, now = Date.now(), configOf = readQuietConfig, overrideOf = readOverride } = {}) {
  return quietState({ config: configOf(), now, override: overrideOf(dir) });
}

// ── the CPU limit on the shared slice ──

/** systemd timespan ("3s", "1s 500ms", "500ms", "2s 400ms", "1min 30s", "infinity") → µs | Infinity | null. Pure. */
export function parseTimespanUs(text) {
  const t = String(text ?? '').trim();
  if (t === 'infinity') return Infinity;
  if (!t) return null;
  const units = { us: 1, ms: 1000, s: 1e6, min: 60e6, h: 3600e6 };
  let total = 0, rest = t;
  while (rest.length) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|min|h|s)\b/.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * units[m[2]];
    rest = rest.slice(m[0].length);
  }
  return Math.round(total);
}

/** CPUQuotaPerSecUSec for `cpuPercent` of the whole machine: 25% of 12 cores = 300% = 3 s per second = 3 000 000 µs. */
export const quotaUs = (cpuPercent, cores) => Math.round(cpuPercent * cores * 10_000);

/** Does this user manager delegate the cpu controller? (read-only, no systemctl) */
export function cpuLimitSupported({ uid = process.getuid?.() ?? 0, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  try { return /\bcpu\b/.test(read(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`)); } catch { return false; }
}

let lastWarn = null;
const warnOnce = (warn, msg) => { if (msg !== lastWarn) { lastWarn = msg; warn(msg); } };

/**
 * Make the build slice's CPUQuota match quietState(). Idempotent; never throws.
 * `state` = a quietState() result (default: computed from the real config + `dir` override).
 * → { ok, changed?, unsupported?, skipped?, why? }
 */
export function syncQuietCpu({
  dir, state = null, now = Date.now(), cores = os.availableParallelism?.() ?? os.cpus().length,
  run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000 }), supported = cpuLimitSupported,
  warn = (m) => console.error(m), exists = fs.existsSync,
} = {}) {
  try {
    const st = state || quietNow({ dir, now });
    const applied = path.join(dir, APPLIED_FILE);
    const want = quietApplies(st) ? quotaUs(st.cpuPercent, cores) : Infinity;
    // A machine that never used this feature (no config, nothing we applied) is not touched at all.
    if (!st.enabled && want === Infinity && !exists(applied)) return { ok: true, skipped: true };
    if (!supported()) { if (want !== Infinity) warnOnce(warn, '⚠️ giờ im lặng: máy này không giới hạn được CPU (thiếu systemd cpu) — chỉ giới hạn số build.'); return { ok: false, unsupported: true, why: 'thiếu systemd cpu' }; }
    const cur = run('systemctl', ['--user', 'show', '-p', 'CPUQuotaPerSecUSec', '--value', QUIET_SLICE]);
    if (cur.error || cur.status !== 0) { warnOnce(warn, `⚠️ giờ im lặng: không đọc được ${QUIET_SLICE} (${String(cur.error?.message || cur.stderr || `exit ${cur.status}`).trim().split('\n')[0]})`); return { ok: false, unsupported: !!cur.error, why: 'systemctl lỗi' }; }
    const have = parseTimespanUs(cur.stdout);
    if (have == null) { warnOnce(warn, `⚠️ giờ im lặng: không hiểu CPUQuotaPerSecUSec=${String(cur.stdout).trim()}`); return { ok: false, why: 'không hiểu giá trị' }; }
    if (have === want || (Number.isFinite(have) && Number.isFinite(want) && Math.abs(have - want) <= 1000)) return { ok: true, changed: false };
    const prop = want === Infinity ? 'CPUQuota=' : `CPUQuota=${Math.round(st.cpuPercent * cores * 100) / 100}%`;
    const r = run('systemctl', ['--user', 'set-property', '--runtime', QUIET_SLICE, prop]);
    if (r.error || r.status !== 0) { warnOnce(warn, `⚠️ giờ im lặng: set-property ${prop} lỗi (${String(r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0]})`); return { ok: false, why: 'set-property lỗi' }; }
    lastWarn = null;
    try {
      if (want === Infinity) fs.unlinkSync(applied);
      else { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(applied, `${Date.now()}\n`, { mode: 0o600 }); }
    } catch {}
    return { ok: true, changed: true, quota: want };
  } catch (e) {
    warnOnce(warn, `⚠️ giờ im lặng: ${e?.message ?? e}`);
    return { ok: false, why: String(e?.message ?? e) };
  }
}
