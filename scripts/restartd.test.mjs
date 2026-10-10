import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serviceFromCgroup, checkRestartSafety, claudesInCgroup, runRestartd } from './restartd.mjs';

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
