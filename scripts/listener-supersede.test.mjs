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
  YIELD_TO_ONE_SHOT,
  mergePromptData,
  mergeOrSpoolPrompt,
  buildCombinedPromptData,
  dropPresentSegments,
  promptSegmentKeys,
} from './tele-listen.mjs';

// The --loop listener must YIELD (inconclusive → main exits 2, offset not
// advanced) — never be "superseded" (a real row → exit 3, wrapper breaks).
function assertYield(r) {
  assert.ok(r, 'expected a yield, got null (would run alongside the drain → duplicate prompt)');
  assert.equal(r.__inconclusive, true, 'expected a yield, got a real superseder (would stand down → deaf)');
  assert.equal(r.reason, YIELD_TO_ONE_SHOT);
}

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

test('a --loop listener YIELDS (not superseded) to a newer live one-shot drain; the drain proceeds', async () => {
  const { file, lockFile } = tmpRegistry();
  await refreshRegistry({ pid: LOOP_PID, filter: null, offsetFile: 'o', convoId: '7', loop: true, file, lockFile, now: 1000 });
  // Drain registers LATER (newer startedAt) while the --loop listener is live.
  const afterDrain = await refreshRegistry({ pid: DRAIN_PID, filter: null, offsetFile: 'o', convoId: '7', loop: false, file, lockFile, now: 2000 });
  assert.equal(afterDrain.find((e) => e.pid === DRAIN_PID).loop, false);
  // Next --loop poll refreshes and checks supersede.
  const registry = await refreshRegistry({ pid: LOOP_PID, filter: null, offsetFile: 'o', convoId: '7', loop: true, file, lockFile, now: 3000 });
  assert.equal(registry.find((e) => e.pid === LOOP_PID).loop, true);
  assert.ok(registry.some((e) => e.pid === DRAIN_PID), 'drain row is live and present');
  assertYield(findSuperseder({ myPid: LOOP_PID, myFilter: null, myConvoId: '7', myLoop: true, registry }));
  // Pre-write guard agrees.
  assertYield(findPreWriteWinner({ myPid: LOOP_PID, myConvoId: '7', myLoop: true, registry: readRegistry(file) }));
  // And the drain itself is not stopped by the OLDER --loop listener (it still drains).
  assert.equal(findSuperseder({ myPid: DRAIN_PID, myFilter: null, myConvoId: '7', myLoop: false, registry }), null);
  assert.equal(findPreWriteWinner({ myPid: DRAIN_PID, myConvoId: '7', myLoop: false, registry: readRegistry(file) }), null);
});

test('once the drain row is dead, the --loop listener proceeds normally', async () => {
  const { file, lockFile } = tmpRegistry();
  const dead = deadPid();
  await refreshRegistry({ pid: LOOP_PID, filter: null, offsetFile: 'o', convoId: '7', loop: true, file, lockFile, now: 1000 });
  // A drain that already exited left its (newer) row behind.
  const rows = readRegistry(file);
  rows.push({ pid: dead, convoId: '7', loop: false, startedAt: 2000 });
  fs.writeFileSync(file, rows.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // Pre-write guard on the raw file: dead row ignored.
  assert.equal(findPreWriteWinner({ myPid: LOOP_PID, myConvoId: '7', myLoop: true, registry: readRegistry(file) }), null);
  // Next poll: refreshRegistry drops the dead row, supersede check is clean.
  const registry = await refreshRegistry({ pid: LOOP_PID, filter: null, offsetFile: 'o', convoId: '7', loop: true, file, lockFile, now: 3000 });
  assert.deepEqual(registry.map((e) => e.pid), [LOOP_PID]);
  assert.equal(findSuperseder({ myPid: LOOP_PID, myFilter: null, myConvoId: '7', myLoop: true, registry }), null);
});

test('a real --loop superseder takes precedence over a one-shot yield; an OLDER one-shot causes no yield', () => {
  const registry = [
    { pid: 100, convoId: '7', loop: true, startedAt: 1000 },
    { pid: 300, convoId: '7', loop: false, startedAt: 3000 },
    { pid: 200, convoId: '7', loop: true, startedAt: 2000 },
  ];
  assert.equal(findSuperseder({ myPid: 100, myFilter: null, myConvoId: '7', myLoop: true, registry })?.pid, 200);
  assert.equal(findPreWriteWinner({ myPid: 100, myConvoId: '7', myLoop: true, registry, isLive: () => true })?.pid, 200);
  const olderOneShot = [
    { pid: 100, convoId: '7', loop: true, startedAt: 2000 },
    { pid: 300, convoId: '7', loop: false, startedAt: 1000 },
  ];
  assert.equal(findSuperseder({ myPid: 100, myFilter: null, myConvoId: '7', myLoop: true, registry: olderOneShot }), null);
  assert.equal(findPreWriteWinner({ myPid: 100, myConvoId: '7', myLoop: true, registry: olderOneShot, isLive: () => true }), null);
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

// ── Idempotent merge/spool (residual drain-vs-loop TOCTOU) ────────────────────
// The --loop listener can pass its pre-write check, then the drain writes the
// same updates first; the listener's already-prepared batch must not add a
// second copy of a message that is still pending.

function tgMsg(id, text, { chat = -100, edit = null, from = { id: 42, first_name: 'Thi' } } = {}) {
  const m = { message_id: id, chat: { id: chat, type: 'supergroup' }, from, date: 1700000000 + id, text };
  if (edit != null) m.edit_date = edit;
  return { msg: m, update: { update_id: 9000 + id } };
}
const prompt = (...msgs) => buildCombinedPromptData(msgs);

test('mergePromptData: merging the same message twice yields one copy', () => {
  const a = prompt(tgMsg(1, 'hello'));
  const merged = mergePromptData(a, prompt(tgMsg(1, 'hello')));
  assert.equal(merged.messages.length, 1);
  assert.equal(merged.text, 'hello');
  // Partial overlap: only the new message is appended.
  const m2 = mergePromptData(a, prompt(tgMsg(1, 'hello'), tgMsg(2, 'world')));
  assert.deepEqual(m2.messages.map((s) => s.messageId), [1, 2]);
  assert.equal((m2.text.match(/hello/g) || []).length, 1);
  assert.match(m2.text, /world/);
  assert.equal(m2.messageId, 2);
});

test('mergePromptData: an EDIT, another chat, or a synthetic (no messageId) prompt is NOT deduped', () => {
  const a = prompt(tgMsg(1, 'hello'));
  assert.equal(mergePromptData(a, prompt(tgMsg(1, 'hello v2', { edit: 1700000100 }))).messages.length, 2);
  assert.equal(mergePromptData(a, prompt(tgMsg(1, 'other chat', { chat: -200 }))).messages.length, 2);
  const synth = { text: 'ask', messageId: null, chatId: '-100', messages: [{ messageId: null, text: 'ask' }] };
  assert.equal(mergePromptData(synth, { ...synth }).messages.length, 2);
});

test('mergeOrSpoolPrompt: merge path is idempotent (same batch twice → one copy)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-idem-'));
  const promptFile = path.join(dir, 'prompt-convo-7.json');
  assert.equal(await mergeOrSpoolPrompt(promptFile, prompt(tgMsg(1, 'hello')), null), 'spooled');
  assert.equal(await mergeOrSpoolPrompt(promptFile, prompt(tgMsg(1, 'hello')), null), 'duplicate');
  assert.equal(JSON.parse(fs.readFileSync(promptFile, 'utf8')).messages.length, 1);
  assert.equal(await mergeOrSpoolPrompt(promptFile, prompt(tgMsg(1, 'hello'), tgMsg(2, 'world')), null), 'merged');
  assert.deepEqual(JSON.parse(fs.readFileSync(promptFile, 'utf8')).messages.map((s) => s.messageId), [1, 2]);
});

test('mergeOrSpoolPrompt: spool skips a message already in the claimed .processing batch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-idem-'));
  const promptFile = path.join(dir, 'prompt-convo-7.json');
  const processingFile = path.join(dir, 'prompt-convo-7.processing.json');
  fs.writeFileSync(processingFile, JSON.stringify(prompt(tgMsg(1, 'hello'))));
  assert.equal(await mergeOrSpoolPrompt(promptFile, prompt(tgMsg(1, 'hello')), null), 'duplicate');
  assert.equal(fs.existsSync(promptFile), false, 'nothing spooled');
  // A batch mixing the claimed message with a new one spools only the new one.
  assert.equal(await mergeOrSpoolPrompt(promptFile, prompt(tgMsg(1, 'hello'), tgMsg(2, 'world')), null), 'spooled');
  const spooled = JSON.parse(fs.readFileSync(promptFile, 'utf8'));
  assert.deepEqual(spooled.messages.map((s) => s.messageId), [2]);
  assert.equal(spooled.text, 'world');
  assert.equal(spooled.messageId, 2);
});

test('partial dedupe: a dropped segment\'s fromMember / chatId never leak onto the rebuilt batch', () => {
  const roles = { '43': { role: 'member', note: 'designer' } };
  const user = tgMsg(1, 'from user');                                           // sender 42, not a member
  const member = tgMsg(2, 'from member', { chat: -200, from: { id: 43, first_name: 'Mem' } });
  const batch = buildCombinedPromptData([user, member], null, null, roles);
  assert.ok(batch.fromMember, 'precondition: newest sender is a member');
  assert.equal(batch.chatId, '-200');
  // The member's message is already pending → only the user's survives.
  const existing = buildCombinedPromptData([member], null, null, roles);
  const merged = mergePromptData(existing, batch);
  assert.deepEqual(merged.messages.map((s) => s.messageId), [2, 1]);
  assert.equal(merged.fromUserId, '42');
  assert.equal(merged.fromMember, null);
  assert.equal(merged.chatId, '-100');
  // Same sender kept → its member record is kept.
  const m1 = tgMsg(3, 'a', { from: { id: 43, first_name: 'Mem' } });
  const m2 = tgMsg(4, 'b', { from: { id: 43, first_name: 'Mem' } });
  const both = buildCombinedPromptData([m1, m2], null, null, roles);
  const kept = mergePromptData(buildCombinedPromptData([m2], null, null, roles), both);
  assert.deepEqual(kept.messages.map((s) => s.messageId), [4, 3]);
  assert.deepEqual(kept.fromMember, both.fromMember);
  // Kept segment with no chatId (older prompt) → chatId null, not the dropped one's.
  const legacy = { chatId: '-200', fromUserId: '43', messages: [
    { messageId: 5, fromUserId: '42', text: 'old' },
    { messageId: 6, chatId: '-200', fromUserId: '43', text: 'dup' },
  ] };
  const rebuilt = dropPresentSegments(legacy, promptSegmentKeys({ chatId: '-200', messages: [{ messageId: 6, chatId: '-200' }] }));
  assert.deepEqual(rebuilt.messages.map((s) => s.messageId), [5]);
  assert.equal(rebuilt.chatId, null);
});
