// Regression tests: a one-shot run (the bare pre-critical-action drain, no
// --loop) must never make the agent's persistent --loop listener stand down.
//
// Bug 1: the drain registered in the listener registry with the same convoId
// and a NEWER startedAt (its parent bash is brand-new), so a --loop poll that
// refreshed in that window saw a newer live peer via findSuperseder and exited
// 3 → the `while` wrapper broke → agent deaf.
// Bug 2: the pre-write guard re-read the registry WITHOUT a liveness filter, so
// a dead drain row could also make the --loop listener stand down.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  refreshRegistry,
  readRegistry,
  findSuperseder,
  findPreWriteWinner,
  isLiveEntry,
} from './tele-listen.mjs';

function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-supersede-'));
  return { dir, file: path.join(dir, 'listener-registry.jsonl'), lockFile: path.join(dir, 'registry.lock') };
}

// A pid that has certainly exited (spawned + reaped synchronously).
function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

const LOOP_PID = process.pid;   // live: plays the --loop listener's wrapper shell
const DRAIN_PID = process.ppid; // live: plays the drain's short-lived bash

test('a --loop listener is NOT superseded by a newer one-shot drain on the same convo', async () => {
  const { file, lockFile } = tmpRegistry();
  await refreshRegistry({ pid: LOOP_PID, filter: null, offsetFile: 'o', convoId: '7', loop: true, file, lockFile, now: 1000 });
  // Drain registers LATER (newer startedAt) while the --loop listener is live.
  const afterDrain = await refreshRegistry({ pid: DRAIN_PID, filter: null, offsetFile: 'o', convoId: '7', loop: false, file, lockFile, now: 2000 });
  assert.equal(afterDrain.find((e) => e.pid === DRAIN_PID).loop, false);
  // Next --loop poll refreshes and checks supersede.
  const registry = await refreshRegistry({ pid: LOOP_PID, filter: null, offsetFile: 'o', convoId: '7', loop: true, file, lockFile, now: 3000 });
  assert.equal(registry.find((e) => e.pid === LOOP_PID).loop, true);
  assert.ok(registry.some((e) => e.pid === DRAIN_PID), 'drain row is live and present');
  assert.equal(findSuperseder({ myPid: LOOP_PID, myFilter: null, myConvoId: '7', myLoop: true, registry }), null);
  // Pre-write guard agrees.
  assert.equal(findPreWriteWinner({ myPid: LOOP_PID, myConvoId: '7', myLoop: true, registry: readRegistry(file) }), null);
  // And the drain itself is not stopped by the OLDER --loop listener (it still drains).
  assert.equal(findSuperseder({ myPid: DRAIN_PID, myFilter: null, myConvoId: '7', myLoop: false, registry }), null);
});

test('two --loop listeners on the same convo: newer still wins (unchanged)', () => {
  const registry = [
    { pid: 100, convoId: '7', loop: true, startedAt: 1000 },
    { pid: 200, convoId: '7', loop: true, startedAt: 2000 },
  ];
  assert.equal(findSuperseder({ myPid: 100, myFilter: null, myConvoId: '7', myLoop: true, registry })?.pid, 200);
  assert.equal(findSuperseder({ myPid: 200, myFilter: null, myConvoId: '7', myLoop: true, registry }), null);
  const live = () => true;
  assert.equal(findPreWriteWinner({ myPid: 100, myConvoId: '7', myLoop: true, registry, isLive: live })?.pid, 200);
  assert.equal(findPreWriteWinner({ myPid: 200, myConvoId: '7', myLoop: true, registry, isLive: live }), null);
});

test('one-shot vs one-shot and legacy rows keep newer-wins', () => {
  const twoOneShots = [
    { pid: 100, convoId: '7', loop: false, startedAt: 1000 },
    { pid: 200, convoId: '7', loop: false, startedAt: 2000 },
  ];
  assert.equal(findSuperseder({ myPid: 100, myFilter: null, myConvoId: '7', myLoop: false, registry: twoOneShots })?.pid, 200);
  // A row written by older code (no `loop` field) is treated as a --loop row.
  const legacyPeer = [
    { pid: 100, convoId: '7', loop: true, startedAt: 1000 },
    { pid: 200, convoId: '7', startedAt: 2000 },
  ];
  assert.equal(findSuperseder({ myPid: 100, myFilter: null, myConvoId: '7', myLoop: true, registry: legacyPeer })?.pid, 200);
  // Different convo never supersedes.
  const otherConvo = [
    { pid: 100, convoId: '7', loop: true, startedAt: 1000 },
    { pid: 200, convoId: '8', loop: true, startedAt: 2000 },
  ];
  assert.equal(findSuperseder({ myPid: 100, myFilter: null, myConvoId: '7', myLoop: true, registry: otherConvo }), null);
});

test('pre-write guard ignores dead rows (even a newer --loop row)', () => {
  const dead = deadPid();
  const registry = [
    { pid: LOOP_PID, convoId: '7', loop: true, startedAt: 1000 },
    { pid: dead, convoId: '7', loop: true, startedAt: 2000 },
  ];
  assert.equal(isLiveEntry(registry[1]), false);
  assert.equal(findPreWriteWinner({ myPid: LOOP_PID, myConvoId: '7', myLoop: true, registry }), null);
  // Sanity: the same row, if live, would win.
  assert.equal(findPreWriteWinner({ myPid: LOOP_PID, myConvoId: '7', myLoop: true, registry, isLive: () => true })?.pid, dead);
});

test('pre-write guard: my row missing → inconclusive', () => {
  const r = findPreWriteWinner({ myPid: 1, myConvoId: '7', myLoop: true, registry: [{ pid: 2, convoId: '7', startedAt: 1 }] });
  assert.equal(r.__inconclusive, true);
});

test('refreshRegistry read-only fallback (lock held) drops dead rows but keeps mine', async () => {
  const { file, lockFile } = tmpRegistry();
  const dead = deadPid();
  fs.writeFileSync(file, [
    { pid: LOOP_PID, convoId: '7', loop: true, startedAt: 1000 },
    { pid: dead, convoId: '7', loop: true, startedAt: 2000 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(lockFile, String(Date.now())); // fresh lock held by "someone else"
  const origErr = console.error;
  console.error = () => {};
  let registry;
  try {
    registry = await refreshRegistry({ pid: LOOP_PID, filter: null, offsetFile: 'o', convoId: '7', loop: true, file, lockFile });
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(registry.map((e) => e.pid), [LOOP_PID]);
  assert.equal(findSuperseder({ myPid: LOOP_PID, myFilter: null, myConvoId: '7', myLoop: true, registry }), null);
});
