// `/restartd` — a daemon command: restart the teleport daemon itself when it runs
// as a systemd user service (e.g. teleport-daemon.service), so a daemon code
// change can be picked up from Telegram.
//
// Safety: with the default KillMode=control-group, systemd kills EVERY process in
// the service's cgroup on stop/restart — and agents the daemon spawned before
// spawn.mjs learned to escape into their own scope still live there. So we list
// the `claude` processes inside the daemon's cgroup and REFUSE unless the unit
// uses KillMode=process or `--force` is given. The restart is queued with
// `systemctl --no-block` so this child can print its line before systemd stops
// the daemon (the reply is best-effort — the daemon may be stopped first).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { acquireHelperLock } from './machine-lock.mjs';
import { unquoteTarget } from './agent-target.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { readProjectsConfig } from './projects-config.mjs';
import { listSteerableTargets } from './handover.mjs';
import { resolveSingleSteerTarget, groupChatIds } from './steer.mjs';
import { loadEnvFromFile } from './send-telegram.mjs';
import { formatPersona } from './persona.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');
/** The one-shot "tell this agent the daemon is back" request (daemon.mjs `takeRestartNotify`). */
export const RESTARTD_NOTIFY_FILE = path.join(__dirname, 'tmp', 'restartd-notify.json');

/** The service leaf + cgroup path of a /proc/<pid>/cgroup body, or null. Pure. */
export function serviceFromCgroup(text) {
  for (const line of String(text ?? '').split('\n')) {
    const m = line.trim().match(/^\d+:[^:]*:(\/.*)$/);
    if (!m) continue;
    const leaf = m[1].split('/').pop() || '';
    if (leaf.endsWith('.service') && !/^user@\d+\.service$/.test(leaf)) return { unit: leaf, cgroupPath: m[1] };
  }
  return null;
}

/**
 * Decide whether restarting is safe. Pure.
 *   killMode — systemd KillMode of the unit
 *   claudes  — [{ pid, args }] claude processes inside the unit's cgroup
 */
export function checkRestartSafety({ killMode, claudes, force = false }) {
  if (killMode === 'process' || force || claudes.length === 0) return { ok: true };
  return {
    error: `KillMode=${killMode || '?'}: restarting would also kill ${claudes.length} agent(s) living in the daemon's cgroup: `
      + claudes.map((c) => `PID ${c.pid}`).join(', ')
      + '. Set KillMode=process in the unit (then `systemctl --user daemon-reload`), or move them first (/kill pid:<PID> --restart puts them in their own scope), or use /restartd --force.',
  };
}

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

/** claude processes in a cgroup (cgroup v2 unified path). */
export function claudesInCgroup(cgroupPath, { root = '/sys/fs/cgroup', procDir = '/proc' } = {}) {
  const procs = read(path.join(root, cgroupPath, 'cgroup.procs'));
  if (procs == null) return null;
  const out = [];
  for (const p of procs.split('\n').map((x) => x.trim()).filter(Boolean)) {
    if ((read(path.join(procDir, p, 'comm')) || '').trim() === 'claude') out.push({ pid: Number(p) });
  }
  return out;
}

/**
 * Restart the daemon's systemd unit if it is safe. `ppid` = the daemon (we are
 * its child). Returns { ok, message } | { error }. Shared by `/restartd` and the
 * temporary `/kill --restartd` bridge in spawn.mjs (for a daemon whose registry
 * predates `restartd`).
 */
export function runRestartd({
  force = false, ppid = process.ppid,
  readFile = read, exec = execFileSync, listClaudes = (cg) => claudesInCgroup(cg),
  beforeRestart = null, onRestartFailed = null, // RFC 33: write / roll back the notify file
} = {}) {
  const svc = serviceFromCgroup(readFile(`/proc/${ppid}/cgroup`) || readFile('/proc/self/cgroup'));
  if (!svc) return { error: 'the daemon is not running as a systemd service — restart it by hand (node scripts/daemon.mjs --stop, then start it again).' };
  let killMode = '';
  try { killMode = String(exec('systemctl', ['--user', 'show', svc.unit, '-p', 'KillMode', '--value'], { encoding: 'utf8' })).trim(); } catch {}
  const claudes = listClaudes(svc.cgroupPath);
  if (claudes == null && killMode !== 'process' && !force) {
    return { error: `cannot inspect the cgroup of ${svc.unit} to make sure no agent would be killed — use --force if you are sure.` };
  }
  const safe = checkRestartSafety({ killMode, claudes: claudes || [], force });
  if (safe.error) return safe;
  try { if (beforeRestart) beforeRestart(); } catch (e) { return { error: `cannot record the restart notice: ${e?.message ?? e}` }; }
  try {
    exec('systemctl', ['--user', '--no-block', 'restart', svc.unit], { stdio: 'ignore' });
  } catch (e) {
    try { if (onRestartFailed) onRestartFailed(); } catch {}
    return { error: `systemctl restart ${svc.unit} failed: ${e?.message ?? e}` };
  }
  return { ok: true, message: `🔄 restarting ${svc.unit} (KillMode=${killMode || '?'})… check with /help or /ls in a few seconds.` };
}

/** `--force` anywhere; the rest (joined, outer quotes off) is ONE target; any other `-…` token is an error. Pure. */
export function parseRestartdArgs(argv) {
  let force = false;
  const words = [];
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (String(a).startsWith('-')) return { error: `cờ lạ ${a} — dùng /restartd [<đích>] [--force].` };
    else words.push(a);
  }
  return { force, target: unquoteTarget(words.join(' ').trim()) };
}

const REAL_FS = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, mkdirSync: fs.mkdirSync };

/**
 * The whole `/restartd` command (RFC 33). Everything is injectable; returns { ok, message } | { error }.
 */
export async function restartdCommand(argv, {
  fsx = REAL_FS, notifyFile = RESTARTD_NOTIFY_FILE, now = Date.now, newId = () => crypto.randomBytes(8).toString('hex'),
  acquireLock = () => acquireHelperLock('restartd', { waitMs: 0 }),
  loadLive = () => listSteerableTargets(readTopicsStore(), groupChatIds(readProjectsConfig(), loadEnvFromFile(ENV_FILE))),
  gitHead = (exec = execFileSync) => { try { return String(exec('git', ['-C', path.join(__dirname, '..'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null; } catch { return null; } },
  ...run
} = {}) {
  const args = parseRestartdArgs(argv);
  if (args.error) return { error: args.error };
  const release = await acquireLock();
  if (!release) return { error: 'đang có /restartd khác.' };
  try {
    let match = null;
    if (args.target) {
      const r = resolveSingleSteerTarget(args.target, loadLive());
      if (r.error) return { error: r.error };
      match = r.match;
    }
    // Every /restartd drops a stale request first, so an old intent is never picked up.
    try { fsx.unlinkSync(notifyFile); } catch (e) { if (e?.code !== 'ENOENT') return { error: `không xoá được file notify cũ (${e?.message ?? e}) — không restart.` }; }
    const id = newId();
    const hooks = !match ? {} : {
      beforeRestart: () => {
        fsx.mkdirSync(path.dirname(notifyFile), { recursive: true });
        const tmp = `${notifyFile}.${process.pid}.tmp`;
        fsx.writeFileSync(tmp, JSON.stringify({ id, convoId: Number(match.convoId), at: now(), fromCommit: gitHead() }), { mode: 0o600 });
        fsx.renameSync(tmp, notifyFile);
      },
      onRestartFailed: () => { // only our own request: a later /restartd may have replaced the file
        try { if (JSON.parse(fsx.readFileSync(notifyFile, 'utf8')).id === id) fsx.unlinkSync(notifyFile); } catch {}
      },
    };
    const r = runRestartd({ force: args.force, ...hooks, ...run });
    if (r.error || !match) return r;
    const label = `${match.persona ? `${formatPersona(match.persona)} ` : ''}(#${match.hashtag})`;
    return { ...r, message: `${r.message} · sẽ báo ${label} ở lần khởi động tới` };
  } finally { release(); }
}

if (isMainModule(import.meta.url)) {
  // The daemon tokenizes the command text; a multi-word target arrives as several tokens and is re-joined here.
  const r = await restartdCommand(process.argv.slice(2));
  console.log(r.error ? `❌ ${r.error}` : r.message);
  process.exit(r.error ? 1 : 0);
}
