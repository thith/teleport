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
import { isMainModule } from './is-direct-run.mjs';

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
  try {
    exec('systemctl', ['--user', '--no-block', 'restart', svc.unit], { stdio: 'ignore' });
  } catch (e) {
    return { error: `systemctl restart ${svc.unit} failed: ${e?.message ?? e}` };
  }
  return { ok: true, message: `🔄 restarting ${svc.unit} (KillMode=${killMode || '?'})… check with /help or /ls in a few seconds.` };
}

if (isMainModule(import.meta.url)) {
  const r = runRestartd({ force: process.argv.includes('--force') });
  console.log(r.error ? `❌ ${r.error}` : r.message);
  process.exit(r.error ? 1 : 0);
}
