import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoNudgeNeed, autoNudgeTick, AUTO_NUDGE_WINDOW_MS } from './auto-nudge.mjs';
import { NUDGE_LINES } from './type-cmd.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';

const NOW = 1_800_000_000_000;

test('autoNudgeNeed: only NEW items inside the window; listener off alone is never a reason', () => {
  const n = (o) => autoNudgeNeed({ now: NOW, listener: 'on', mailAt: null, tgAt: null, ...o });
  assert.equal(n({ listener: 'off' }), null, 'listener off, nothing waiting → leave it (may be intentional)');
  assert.equal(n({ mailAt: NOW - 10_000 }).line, NUDGE_LINES.mail);
  assert.equal(n({ mailAt: NOW - AUTO_NUDGE_WINDOW_MS - 1 }), null, 'older than the window');
  assert.equal(n({ tgAt: NOW - 5_000 }), null, 'Telegram waiting but the listener runs → it will read it');
  assert.equal(n({ listener: null, tgAt: NOW - 5_000 }), null, 'unknown listener → no');
  assert.equal(n({ listener: 'off', tgAt: NOW - 5_000 }).line, NUDGE_LINES.listener);
  assert.equal(n({ listener: 'off', tgAt: NOW - 5_000, mailAt: NOW - 1_000 }).line, NUDGE_LINES.both);
  assert.equal(n({ mailAt: NOW - 10_000, prev: { mail: NOW - 10_000 } }), null, 'already reminded of that one');
  const again = n({ listener: 'off', mailAt: NOW - 10_000, tgAt: NOW - 3_000, prev: { mail: NOW - 10_000, tg: NOW - 50_000 } });
  assert.equal(again.line, NUDGE_LINES.listener, 'only the new Telegram item');
  assert.deepEqual(again.mark, { mail: NOW - 10_000, tg: NOW - 3_000 });
});

const SID = '848e5ded-a905-4b49-8448-12ed50f4a7dc';
const CONVO = uuidToConvoInt(SID);
const row = (o) => ({ pid: 101, ppid: 100, screenPid: 100, screen: 'tele-aaaa0001', hashtag: 'aaaa0001', sessionId: SID, guessed: false, procStart: '5', cwd: '/w', ...o });
const io = { session: () => ({ sessionId: SID, status: 'idle' }), proc: () => ({ comm: 'claude', start: '5' }), ppid: (pid) => pid - 1, windows: () => 1, transcript: () => ({ ended: true }) };

test('autoNudgeTick: nudges once per new item with the fixed line; twins, drifted and unknown convos skipped', async () => {
  const ran = [];
  const runner = { run: async (op, t, who, o) => { ran.push([op, t.hashtag, who, o.line, o.persona]); return { text: 'ok' }; } };
  const seen = new Map();
  const deps = { io, runner, seen, mailAt: (c) => (c === CONVO ? NOW - 5_000 : null), tgAt: () => null, listener: () => 'on', personaOf: () => '🐺 Sói', now: NOW };
  await autoNudgeTick({ ...deps, list: () => [row({})] });
  assert.deepEqual(ran, [['n', 'aaaa0001', 'auto', NUDGE_LINES.mail, '🐺 Sói']]);
  await autoNudgeTick({ ...deps, list: () => [row({})], now: NOW + 60_000 });
  assert.equal(ran.length, 1, 'next tick, same mail → no second nudge');
  await autoNudgeTick({ ...deps, seen: new Map(), list: () => [row({}), { pid: 900, hashtag: 'aaaa0001', sessionId: 'X', procStart: '5' }] });
  assert.equal(ran.length, 1, 'a twin hashtag → skipped');
  await autoNudgeTick({ ...deps, seen: new Map(), list: () => [row({})], io: { ...io, windows: () => 2 } });
  assert.equal(ran.length, 1, 'drifted target → skipped');
  await autoNudgeTick({ ...deps, seen: new Map(), list: () => [row({ screen: 'other' })] });
  assert.equal(ran.length, 1, 'not in its tele-* screen → skipped');
});

test('autoNudgeTick: a throwing runner is logged, never thrown', async () => {
  const logs = [];
  const runner = { run: async () => { throw new Error('boom'); } };
  await autoNudgeTick({ list: () => [row({})], io, runner, seen: new Map(), mailAt: () => NOW, tgAt: () => null, listener: () => 'on', now: NOW, log: (s) => logs.push(s) });
  assert.match(logs[0], /#aaaa0001: ❌ boom/);
});
