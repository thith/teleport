import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify, allowedOps, typeTargets, pinTarget, agentLine, messageNamesTarget, parseInputLine, suggestionSelects,
  rcDialogReady, targetMismatch, TypeRunner, TYPE_BUTTON_RE, COOLDOWN_MS,
} from './type-cmd.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'type-hardcopy');
const hc = (name) => fs.readFileSync(path.join(FIX, `${name}.txt`)).toString('latin1'); // as the daemon reads them

test('classify: idle / shell+turn-over = rảnh; shell mid-turn = bận; unknown never counts as idle', () => {
  assert.equal(classify('idle', null), 'idle');
  assert.equal(classify('shell', true), 'idle'); // every tele-* agent keeps a Monitor → "shell" when idle
  assert.equal(classify('shell', false), 'busy');
  assert.equal(classify('shell', null), 'unknown');
  assert.equal(classify('busy', true), 'busy'); // status busy wins over a lagging transcript
  assert.equal(classify('waiting', true), 'waiting');
  assert.equal(classify(null, true), 'unknown');
  assert.equal(classify('something-new', true), 'unknown');
});

test('allowedOps: commands only when idle (/remote-control only when not bridged); Esc only busy/waiting', () => {
  assert.deepEqual(allowedOps('idle', null), ['c', 'r']);
  assert.deepEqual(allowedOps('idle', 'session_x'), ['c']);
  assert.deepEqual(allowedOps('busy', null), ['e']);
  assert.deepEqual(allowedOps('waiting', null), ['e']);
  assert.deepEqual(allowedOps('unknown', null), []);
});

test('typeTargets: only a tele-* screen whose DIRECT child is claude, with a known (not guessed) session', () => {
  const base = { pid: 10, ppid: 9, screenPid: 9, screen: 'tele-abcd1234', sessionId: 's', guessed: false, procStart: '1', hashtag: 'abcd1234' };
  assert.equal(typeTargets([base]).length, 1);
  assert.equal(typeTargets([{ ...base, ppid: 8 }]).length, 0);           // claude under bash in the screen
  assert.equal(typeTargets([{ ...base, screen: 'work' }]).length, 0);    // not a teleport screen
  assert.equal(typeTargets([{ ...base, screen: null }]).length, 0);      // terminal agent
  assert.equal(typeTargets([{ ...base, guessed: true }]).length, 0);
  assert.equal(typeTargets([{ ...base, screenPid: null }]).length, 0);
});

test('agentLine / messageNamesTarget: the line carries #hash + PID; a press needs both in the message', () => {
  const t = pinTarget({ pid: 644406, procStart: 5, sessionId: 's', screenPid: 644405, screen: 'tele-c2383556', hashtag: 'c2383556', cwd: '/w' });
  const line = agentLine(t, { persona: '🧛 Ma', state: 'idle', ctx: 'ctx 693k', bridge: 'session_x' });
  assert.equal(line, '🧛 Ma #c2383556 · PID 644406 · rảnh · ctx 693k · 📡');
  assert.equal(messageNamesTarget(`⌨️ /type — ${line}`, t), true);
  assert.equal(messageNamesTarget('⌨️ /type — #c2383556 · PID 6444060', t), false); // no prefix match
  assert.equal(messageNamesTarget('#c23835560 · PID 644406', t), false);
  assert.equal(messageNamesTarget('#d8133684 · PID 331131', t), false); // a tampered entry pointing elsewhere
});

test('parseInputLine (real hardcopies): the live line, not history / suggestions; draft and ghost text read as text', () => {
  assert.equal(parseInputLine(hc('compact-typed')), '/compact');
  assert.equal(parseInputLine(hc('rc-typed')), '/remote-control');
  assert.equal(parseInputLine(hc('draft')), 'abc draft');
  assert.equal(parseInputLine(hc('compact-done-empty')), ''); // history shows "o /compact" (plain space) — ignored
  assert.equal(parseInputLine(hc('idle-ghost')), 'Try "fix lint errors"'); // ghost suggestion ≠ empty → we never Enter on it
  assert.equal(parseInputLine('no prompt here'), null);
});

test('suggestionSelects / rcDialogReady (real hardcopies)', () => {
  assert.equal(suggestionSelects(hc('compact-typed'), '/compact'), true);
  assert.equal(suggestionSelects(hc('rc-typed'), '/remote-control'), true);
  assert.equal(suggestionSelects(hc('draft'), '/compact'), false);
  assert.equal(suggestionSelects(hc('compact-typed'), '/autocompact'), false); // listed but not selected
  assert.equal(rcDialogReady(hc('rc-dialog')), true);
  assert.equal(rcDialogReady(hc('rewind')), false);
  assert.equal(rcDialogReady(hc('compact-typed')), false);
});

test('targetMismatch: every way the pinned target can drift', () => {
  const t = { pid: 10, procStart: '100', sessionId: 'S', screenPid: 9 };
  const ok = { proc: { comm: 'claude', start: '100' }, sess: { sessionId: 'S' }, ppid: 9, windows: 1 };
  assert.equal(targetMismatch(t, ok), null);
  assert.match(targetMismatch(t, { ...ok, proc: null }), /không còn/);
  assert.match(targetMismatch(t, { ...ok, proc: { comm: 'bash', start: '100' } }), /không còn/);
  assert.match(targetMismatch(t, { ...ok, proc: { comm: 'claude', start: '101' } }), /PID đã thuộc/);
  assert.match(targetMismatch(t, { ...ok, sess: { sessionId: 'T' } }), /phiên đã đổi/);
  assert.match(targetMismatch(t, { ...ok, ppid: 8 }), /không còn là con/);
  assert.match(targetMismatch(t, { ...ok, windows: 2 }), /2 cửa sổ/);
  assert.match(targetMismatch(t, { ...ok, windows: null }), /\? cửa sổ/);
});

test('TYPE_BUTTON_RE: pick + fixed ops only', () => {
  assert.ok(TYPE_BUTTON_RE.test('ty:pick:c2383556'));
  assert.ok(TYPE_BUTTON_RE.test('ty:0123456789abcdef:c'));
  assert.ok(!TYPE_BUTTON_RE.test('ty:0123456789abcdef:z'));
  assert.ok(!TYPE_BUTTON_RE.test('ty:0123456789abcdef:/clear'));
  assert.ok(!TYPE_BUTTON_RE.test('mg:0123456789abcdef'));
});

// ── Runner flows against a fake session/screen ────────────────────────────────

const T = { pid: 10, procStart: '100', sessionId: 'S', screenPid: 9, screen: 'tele-abcd1234', hashtag: 'abcd1234', cwd: '/w' };

/** A scripted fake: `state` drives status/transcript; `screens` = hardcopies served in order. */
function fakeIo({ status = 'shell', ended = true, screens = [], bridge = null, onStuff = () => {}, compact = null } = {}) {
  const st = { status, ended, bridge, now: 0, keys: [], audits: [], screens: [...screens] };
  const io = {
    now: () => st.now,
    sleep: async (ms) => { st.now += ms; },
    proc: () => ({ comm: 'claude', start: '100' }),
    session: () => ({ sessionId: 'S', status: st.status, bridgeSessionId: st.bridge }),
    ppid: () => 9,
    windows: () => 1,
    stuff: (sid, data) => { assert.equal(sid, '9.tele-abcd1234'); st.keys.push(data); onStuff(st, data); },
    hardcopy: async () => (st.screens.length > 1 ? st.screens.shift() : st.screens[0] ?? null),
    transcript: () => ({ ended: st.ended, usage: null }),
    transcriptFile: () => '/t.jsonl',
    transcriptSize: () => 1000,
    compactAfter: () => compact,
    audit: (e) => st.audits.push(e),
  };
  return { io, st };
}

test('runner /compact: idle (shell + turn over) → text, verify, Enter; result read from the transcript', async () => {
  const { io, st } = fakeIo({ screens: [hc('compact-typed'), hc('compact-typed')], compact: { preTokens: 763065, postTokens: 8080 } });
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact', '\r']);
  assert.match(r.text, /đã gõ \/compact vào #abcd1234/);
  assert.equal(await r.watch(), '✅ đã compact: 763k → 8k');
  assert.deepEqual(st.audits.map((a) => a.step), ['typed', 'enter', 'result']);
});

test('runner /compact: "Not enough messages" is reported', async () => {
  const { io } = fakeIo({ screens: [hc('compact-typed'), hc('compact-done-empty').replace('o ', 'o ') + '\n  x  Not enough messages to compact.'] });
  const r = await new TypeRunner(io).run('c', T);
  assert.match(await r.watch(), /chưa đủ tin nhắn/);
});

test('runner: busy / waiting / unknown / drifted target → refused, NO key sent', async () => {
  for (const [status, ended, re] of [['busy', true, /đang bận.*Esc/], ['waiting', true, /hộp thoại/], ['shell', false, /đang bận/], ['shell', null, /không rõ/], [null, true, /không rõ/]]) {
    const { io, st } = fakeIo({ status, ended });
    const r = await new TypeRunner(io).run('c', T);
    assert.match(r.text, re);
    assert.deepEqual(st.keys, []);
  }
  const { io, st } = fakeIo();
  io.proc = () => ({ comm: 'claude', start: '999' }); // pid reused
  assert.match((await new TypeRunner(io).run('c', T)).text, /đổi phiên/);
  assert.deepEqual(st.keys, []);
});

test('runner: a draft in the input box → typed but NO Enter and no other key (no blind Backspace)', async () => {
  const { io, st } = fakeIo({ screens: [hc('draft').replace('abc draft', 'abc draft/compact')] });
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact']);
  assert.match(r.text, /KHÔNG Enter.*xoá tay/);
  assert.equal(st.audits.at(-1).step, 'input-mismatch');
});

test('runner: state changes between typing and Enter → no Enter', async () => {
  const { io, st } = fakeIo({ screens: [hc('compact-typed')], onStuff: (s, d) => { if (d === '/compact') s.status = 'busy'; } });
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact']);
  assert.match(r.text, /vừa đổi trạng thái.*KHÔNG Enter/);
});

test('runner: cool-down after Enter blocks another command; per-agent lock blocks overlap', async () => {
  const { io, st } = fakeIo({ screens: [hc('compact-typed')] });
  const runner = new TypeRunner(io);
  await runner.run('c', T);
  assert.match((await runner.run('c', T)).text, /vừa gõ lệnh/);
  st.now += COOLDOWN_MS;
  runner.locks.add(T.pid);
  assert.match((await runner.run('c', T)).text, /đang gõ lệnh khác/);
});

test('runner /remote-control: off → type, Enter, wait for the Enable dialog, Enter #2 → URL', async () => {
  const { io, st } = fakeIo({
    status: 'idle', screens: [hc('rc-typed'), hc('rc-dialog')],
    onStuff: (s, d) => { if (d === '\r' && s.keys.length === 2) s.status = 'waiting'; if (d === '\r' && s.keys.length === 3) { s.status = 'idle'; s.bridge = 'session_ABC'; } },
  });
  const r = await new TypeRunner(io).run('r', T);
  assert.deepEqual(st.keys, ['/remote-control', '\r', '\r']);
  assert.equal(r.text, '📡 Remote Control đã bật: https://claude.ai/code/session_ABC');
});

test('runner /remote-control: already on → nothing typed, URL returned', async () => {
  const { io, st } = fakeIo({ bridge: 'session_ON' });
  const r = await new TypeRunner(io).run('r', T);
  assert.deepEqual(st.keys, []);
  assert.match(r.text, /đang bật: https:\/\/claude\.ai\/code\/session_ON/);
});

test('runner /remote-control: dialog not recognised → no second Enter, no Esc', async () => {
  const { io, st } = fakeIo({ status: 'idle', screens: [hc('rc-typed'), hc('rewind')], onStuff: (s, d) => { if (d === '\r') s.status = 'waiting'; } });
  const r = await new TypeRunner(io).run('r', T);
  assert.deepEqual(st.keys, ['/remote-control', '\r']);
  assert.match(r.text, /không thấy hộp thoại/);
});

test('runner /remote-control: Esc during the chain cancels it before Enter #2', async () => {
  const { io, st } = fakeIo({ status: 'idle', screens: [hc('rc-typed'), hc('rc-dialog')] });
  const runner = new TypeRunner(io);
  io.stuff = ((orig) => (sid, d) => { orig(sid, d); if (d === '\r' && st.keys.length === 2) { st.status = 'waiting'; runner.cancel.set(T.pid, true); } })(io.stuff);
  const r = await runner.run('r', T);
  assert.deepEqual(st.keys, ['/remote-control', '\r']);
  assert.match(r.text, /huỷ/);
});

test('runner Esc: only when busy/waiting, sent alone, rate-limited; report reads the state after', async () => {
  const idle = fakeIo({ status: 'idle' });
  assert.match((await new TypeRunner(idle.io).run('e', T)).text, /không có gì để dừng/);
  assert.deepEqual(idle.st.keys, []);
  const { io, st } = fakeIo({ status: 'busy', onStuff: (s, d) => { if (d === '\x1b') { s.status = 'shell'; s.ended = true; } } });
  const runner = new TypeRunner(io);
  const r = await runner.run('e', T);
  assert.deepEqual(st.keys, ['\x1b']);
  assert.match(r.text, /đã ngắt, giờ rảnh/);
  st.status = 'busy';
  runner.lastEsc.set(T.pid, st.now - 1000); // a second Esc 1 s after the last one
  assert.match((await runner.run('e', T)).text, /vừa gửi Esc/);
  assert.deepEqual(st.keys, ['\x1b']);
});
