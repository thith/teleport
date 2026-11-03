import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serviceFromCgroup, checkRestartSafety, claudesInCgroup, runRestartd, restartdCommand, parseRestartdArgs } from './restartd.mjs';

test('serviceFromCgroup: the service leaf + path; scopes / user manager are not services', () => {
  assert.deepEqual(serviceFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/teleport-daemon.service\n'),
    { unit: 'teleport-daemon.service', cgroupPath: '/user.slice/user-1000.slice/user@1000.service/app.slice/teleport-daemon.service' });
  assert.equal(serviceFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-x.scope'), null);
  assert.equal(serviceFromCgroup('0::/user.slice/user-1000.slice/user@1000.service'), null);
  assert.equal(serviceFromCgroup(null), null);
});

test('checkRestartSafety: refuses while claude agents share the cgroup under control-group; process/force/empty pass', () => {
  const claudes = [{ pid: 3364049 }, { pid: 3391469 }];
  const r = checkRestartSafety({ killMode: 'control-group', claudes });
  assert.match(r.error, /would also kill 2 agent\(s\).*PID 3364049, PID 3391469/);
  assert.match(r.error, /KillMode=process/);
  assert.deepEqual(checkRestartSafety({ killMode: 'process', claudes }), { ok: true });
  assert.deepEqual(checkRestartSafety({ killMode: 'control-group', claudes, force: true }), { ok: true });
  assert.deepEqual(checkRestartSafety({ killMode: 'control-group', claudes: [] }), { ok: true });
  assert.match(checkRestartSafety({ killMode: 'mixed', claudes }).error, /KillMode=mixed/, 'mixed also kills the cgroup');
});

test('claudesInCgroup: reads cgroup.procs and keeps comm=claude only; unreadable → null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'cgp-'));
  fs.mkdirSync(path.join(root, 'a', 'svc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'svc', 'cgroup.procs'), '10\n11\n12\n');
  for (const [pid, comm] of [[10, 'node'], [11, 'claude'], [12, 'SCREEN']]) {
    fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), 'comm'), `${comm}\n`);
  }
  assert.deepEqual(claudesInCgroup('/a/svc', { root, procDir: proc }), [{ pid: 11 }]);
  assert.equal(claudesInCgroup('/missing', { root, procDir: proc }), null);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(proc, { recursive: true, force: true });
});

const SVC = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/teleport-daemon.service\n';
const fakeExec = (killMode, calls) => (bin, args) => { calls.push([bin, ...args]); return args.includes('show') ? `${killMode}\n` : ''; };

test('runRestartd: agents in the cgroup under control-group → NO restart call', () => {
  const calls = [];
  const r = runRestartd({ ppid: 1, readFile: () => SVC, exec: fakeExec('control-group', calls), listClaudes: () => [{ pid: 42 }] });
  assert.match(r.error, /PID 42/);
  assert.equal(calls.some((c) => c.includes('restart')), false);
});

test('runRestartd: safe → systemctl --user --no-block restart <unit>; uninspectable cgroup refuses; not a service refuses', () => {
  let calls = [];
  const r = runRestartd({ ppid: 1, readFile: () => SVC, exec: fakeExec('process', calls), listClaudes: () => [{ pid: 42 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.at(-1), ['systemctl', '--user', '--no-block', 'restart', 'teleport-daemon.service']);
  calls = [];
  assert.match(runRestartd({ ppid: 1, readFile: () => SVC, exec: fakeExec('control-group', calls), listClaudes: () => null }).error, /cannot inspect/);
  assert.equal(calls.some((c) => c.includes('restart')), false);
  assert.ok(runRestartd({ ppid: 1, readFile: () => SVC, exec: fakeExec('control-group', calls), listClaudes: () => null, force: true }).ok);
  assert.match(runRestartd({ ppid: 1, readFile: () => '0::/user.slice/x.scope', exec: fakeExec('process', []) }).error, /not running as a systemd service/);
});

test('runRestartd: reads the DAEMON\'s cgroup (ppid), falls back to self', () => {
  const read = [];
  runRestartd({ ppid: 777, readFile: (f) => { read.push(f); return f.includes('777') ? SVC : null; }, exec: fakeExec('process', []), listClaudes: () => [] });
  assert.equal(read[0], '/proc/777/cgroup');
});

test('runRestartd: a failing systemctl restart is reported, not swallowed', () => {
  const exec = (bin, args) => { if (args.includes('restart')) throw new Error('Failed to restart'); return 'process\n'; };
  assert.match(runRestartd({ ppid: 1, readFile: () => SVC, exec, listClaudes: () => [] }).error, /systemctl restart teleport-daemon\.service failed/);
});

// ── RFC 33: /restartd <target> ──────────────────────────────────────────────
const LIVE = [
  { convoId: '111', hashtag: 'f4451780', persona: { emoji: '🪼', name: 'Sứa' }, source: 'topic', ts: 2 },
  { convoId: '222', hashtag: 'a1111111', persona: { emoji: '🐱', name: 'Mèo' }, source: 'topic', ts: 1 },
  { convoId: '333', hashtag: 'b2222222', persona: { emoji: '🐱', name: 'Mèo' }, source: 'topic', ts: 1 },
  { convoId: '444', hashtag: 'c3333333', persona: { emoji: '🪼', name: 'Sứa 2' }, source: 'topic', ts: 1 },
];
function rig({ killMode = 'process', lock = true, unlinkErr = null, execFail = false, live = LIVE } = {}) {
  const files = new Map(); const calls = [];
  const fsx = {
    mkdirSync() {}, writeFileSync: (f, d) => files.set(f, d), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    readFileSync: (f) => { if (!files.has(f)) throw Object.assign(new Error('nf'), { code: 'ENOENT' }); return files.get(f); },
    unlinkSync: (f) => { if (unlinkErr) throw Object.assign(new Error('perm'), { code: unlinkErr }); if (!files.delete(f)) throw Object.assign(new Error('nf'), { code: 'ENOENT' }); },
  };
  const exec = (bin, args) => { calls.push([bin, ...args]); if (execFail && args.includes('restart')) throw new Error('boom'); return args.includes('show') ? `${killMode}\n` : ''; };
  let released = 0;
  const deps = { fsx, notifyFile: '/n.json', now: () => 1000, newId: () => 'ID1', gitHead: () => 'abc1234', ppid: 1, readFile: () => SVC, exec,
    listClaudes: () => [], loadLive: () => live, acquireLock: async () => (lock ? () => { released++; } : null) };
  return { files, calls, deps, released: () => released };
}
const restarted = (calls) => calls.some((c) => c.includes('restart'));

test('parseRestartdArgs: --force anywhere, rest is one target, odd flag errors, quotes off', () => {
  assert.deepEqual(parseRestartdArgs(['Sứa', '2']), { force: false, target: 'Sứa 2' });
  assert.deepEqual(parseRestartdArgs(['--force', 'Sứa']), { force: true, target: 'Sứa' });
  assert.deepEqual(parseRestartdArgs(['Sứa', '--force']), { force: true, target: 'Sứa' });
  assert.deepEqual(parseRestartdArgs(['“Sứa', '2”']), { force: false, target: 'Sứa 2' });
  assert.match(parseRestartdArgs(['--froce']).error, /--froce/);
  assert.deepEqual(parseRestartdArgs([]), { force: false, target: '' });
});

test('restartdCommand: unknown / ambiguous target → error, exec never called', async () => {
  let r = rig();
  assert.match((await restartdCommand(['Nobody'], r.deps)).error, /not found/);
  assert.equal(r.calls.length, 0);
  r = rig();
  const a = await restartdCommand(['Mèo'], r.deps);
  assert.match(a.error, /ambiguous.*#a1111111.*#b2222222.*#hashtag/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.released(), 1, 'lock released');
});

test('restartdCommand: valid target + safe → file written (id, convoId, at, fromCommit) then restart; message names the agent', async () => {
  const r = rig();
  const out = await restartdCommand(['Sứa'], r.deps);
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(r.files.get('/n.json')), { id: 'ID1', convoId: 111, at: 1000, fromCommit: 'abc1234' });
  assert.equal(restarted(r.calls), true);
  assert.match(out.message, /sẽ báo 🪼 Sứa \(#f4451780\)/);
});

test('restartdCommand: "Sứa 2" is ONE target (also curly-quoted)', async () => {
  for (const argv of [['Sứa', '2'], ['“Sứa', '2”']]) {
    const r = rig();
    assert.equal((await restartdCommand(argv, r.deps)).ok, true);
    assert.equal(JSON.parse(r.files.get('/n.json')).convoId, 444);
  }
});

test('restartdCommand: systemctl fails → own file removed; a file overwritten by another request (other id) is kept', async () => {
  let r = rig({ execFail: true });
  assert.match((await restartdCommand(['Sứa'], r.deps)).error, /failed/);
  assert.equal(r.files.has('/n.json'), false);
  r = rig({ execFail: true });
  const exec = r.deps.exec;
  r.deps.exec = (bin, args) => { if (args.includes('restart')) r.files.set('/n.json', JSON.stringify({ id: 'OTHER' })); return exec(bin, args); };
  await restartdCommand(['Sứa'], r.deps);
  assert.equal(JSON.parse(r.files.get('/n.json')).id, 'OTHER');
});

test('restartdCommand: refused for safety → no file', async () => {
  const r = rig({ killMode: 'control-group' });
  r.deps.listClaudes = () => [{ pid: 9 }];
  assert.match((await restartdCommand(['Sứa'], r.deps)).error, /PID 9/);
  assert.equal(r.files.size, 0);
  assert.equal(restarted(r.calls), false);
});

test('restartdCommand: --force before or after the target; --froce errors without restart', async () => {
  for (const argv of [['--force', 'Sứa'], ['Sứa', '--force']]) {
    const r = rig({ killMode: 'control-group' });
    r.deps.listClaudes = () => [{ pid: 9 }];
    assert.equal((await restartdCommand(argv, r.deps)).ok, true);
    assert.equal(JSON.parse(r.files.get('/n.json')).convoId, 111);
  }
  const r = rig();
  assert.match((await restartdCommand(['Sứa', '--froce'], r.deps)).error, /--froce/);
  assert.equal(r.calls.length, 0);
});

test('restartdCommand: no target → old file deleted, none written, old behaviour; delete failure (EACCES) → no restart', async () => {
  let r = rig();
  r.files.set('/n.json', 'stale');
  const out = await restartdCommand([], r.deps);
  assert.equal(out.ok, true);
  assert.equal(r.files.has('/n.json'), false);
  assert.doesNotMatch(out.message, /sẽ báo/);
  assert.equal(restarted(r.calls), true);
  r = rig({ unlinkErr: 'EACCES' });
  assert.match((await restartdCommand([], r.deps)).error, /không xoá được/);
  assert.equal(r.calls.length, 0);
});

test('restartdCommand: busy restartd lock → error, nothing done', async () => {
  const r = rig({ lock: false });
  assert.match((await restartdCommand(['Sứa'], r.deps)).error, /đang có \/restartd khác/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.files.size, 0);
});

test('restartdCommand: chat ids come from the .env loader (env has none)', async () => {
  // default loadLive reads projects config + .env; here we just prove groupChatIds takes the envFile.
  const { groupChatIds } = await import('./steer.mjs');
  const saved = process.env.TELEGRAM_ADMIN_CHAT_ID; delete process.env.TELEGRAM_ADMIN_CHAT_ID;
  try {
    assert.deepEqual(groupChatIds({}, { TELEGRAM_ADMIN_CHAT_ID: '-100,-200' }), ['-100', '-200']);
    assert.deepEqual(groupChatIds({ _default: { chatId: '-1,-2' } }), ['-1', '-2'], 'multi-group default is split');
  } finally { if (saved !== undefined) process.env.TELEGRAM_ADMIN_CHAT_ID = saved; }
});

test('restartdCommand: systemctl fails AND rollback unlink fails (EACCES) → error mentions the leftover file; ENOENT is ignored', async () => {
  const r = rig({ execFail: true });
  const exec = r.deps.exec; let n = 0;
  r.deps.fsx = { ...r.deps.fsx, unlinkSync: (f) => { if (n++ === 0) return r.files.delete(f) || (() => { throw Object.assign(new Error('nf'), { code: 'ENOENT' }); })(); throw Object.assign(new Error('EACCES denied'), { code: 'EACCES' }); } };
  const out = await restartdCommand(['Sứa'], r.deps);
  assert.match(out.error, /failed.*không xoá được file báo: EACCES denied/);
  assert.equal(exec === r.deps.exec, true);
  const r2 = rig({ execFail: true });
  const real = r2.deps.fsx.unlinkSync; let k = 0;
  r2.deps.fsx.unlinkSync = (f) => { if (k++ === 0) return real(f); r2.files.delete(f); throw Object.assign(new Error('nf'), { code: 'ENOENT' }); };
  assert.doesNotMatch((await restartdCommand(['Sứa'], r2.deps)).error, /không xoá được/);
});
