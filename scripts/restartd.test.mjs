import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serviceFromCgroup, checkRestartSafety, claudesInCgroup } from './restartd.mjs';

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
