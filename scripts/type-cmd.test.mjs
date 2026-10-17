import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify, allowedOps, typeTargets, pinTarget, agentLine, messageNamesTarget, parseInputLine, suggestionSelects,
  rcDialogReady, targetMismatch, TypeRunner, TYPE_BUTTON_RE, COOLDOWN_MS, defaultIo, compactRefusedOnScreen, isPlaceholder,
} from './type-cmd.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'type-hardcopy');
const hc = (name) => fs.readFileSync(path.join(FIX, `${name}.txt`)).toString('latin1'); // as the daemon reads them
const IDLE = hc('idle-ghost'); // the empty box (its dim placeholder reads like text) — what /type sees before typing

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

test('allowedOps: idle → both commands (/remote-control only when not bridged); busy → /compact (queued) + Esc; waiting → Esc only', () => {
  assert.deepEqual(allowedOps('idle', null), ['c', 'r', 'i']);
  assert.deepEqual(allowedOps('idle', 'session_x'), ['c', 'i']);
  assert.deepEqual(allowedOps('busy', null), ['c', 'e', 'i']);
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
  const { io, st } = fakeIo({ screens: [IDLE, hc('compact-typed'), hc('compact-typed')], compact: { preTokens: 763065, postTokens: 8080 } });
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact', '\r']);
  assert.match(r.text, /đã gõ \/compact vào #abcd1234/);
  assert.equal(await r.watch(), '✅ đã compact: 763k → 8k');
  assert.deepEqual(st.audits.map((a) => a.step), ['typed', 'enter', 'result']);
});

test('runner /compact: "Not enough messages" is reported', async () => {
  const { io } = fakeIo({ screens: [IDLE, hc('compact-typed'), hc('compact-typed'), hc('compact-done-empty')] }); // before: none · after: one
  const r = await new TypeRunner(io).run('c', T);
  assert.match(await r.watch(), /chưa đủ tin nhắn/);
});

test('runner /compact: waiting (a dialog) / unknown / drifted target → refused, NO key sent', async () => {
  for (const [status, ended, re] of [['waiting', true, /hộp thoại/], ['shell', null, /không rõ/], [null, true, /không rõ/]]) {
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
  const { io, st } = fakeIo({ screens: [IDLE, hc('draft').replace('abc draft', 'abc draft/compact')] });
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact']);
  assert.match(r.text, /KHÔNG Enter.*xoá tay/);
  assert.equal(st.audits.at(-1).step, 'input-mismatch');
});

test('runner: state changes between typing and Enter → no Enter', async () => {
  const { io, st } = fakeIo({ screens: [IDLE, hc('compact-typed')], onStuff: (s, d) => { if (d === '/compact') s.status = 'waiting'; } });
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact']);
  assert.match(r.text, /vừa đổi trạng thái.*KHÔNG Enter/);
});

test('runner: cool-down after Enter blocks another command; per-agent lock blocks overlap', async () => {
  const { io, st } = fakeIo({ screens: [IDLE, hc('compact-typed')] });
  const runner = new TypeRunner(io);
  await runner.run('c', T);
  assert.match((await runner.run('c', T)).text, /vừa gõ lệnh/);
  st.now += COOLDOWN_MS;
  runner.locks.add(T.pid);
  assert.match((await runner.run('c', T)).text, /đang gõ lệnh khác/);
});

test('runner /remote-control: off → type, Enter, wait for the Enable dialog, Enter #2 → URL', async () => {
  const { io, st } = fakeIo({
    status: 'idle', screens: [IDLE, hc('rc-typed'), hc('rc-typed'), hc('rc-dialog')],
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
  const { io, st } = fakeIo({ status: 'idle', screens: [IDLE, hc('rc-typed'), hc('rc-typed'), hc('rewind')], onStuff: (s, d) => { if (d === '\r') s.status = 'waiting'; } });
  const r = await new TypeRunner(io).run('r', T);
  assert.deepEqual(st.keys, ['/remote-control', '\r']);
  assert.match(r.text, /không thấy hộp thoại/);
});

test('runner /remote-control: Esc during the chain cancels it before Enter #2', async () => {
  const { io, st } = fakeIo({ status: 'idle', screens: [IDLE, hc('rc-typed'), hc('rc-typed'), hc('rc-dialog')] });
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

// ── Review round 1 regressions ────────────────────────────────────────────────

test('Esc: two overlapping presses during the cool-down send ONE Esc (in-flight guard + gap vs actual sends)', async () => {
  const { io, st } = fakeIo({ status: 'busy' });
  const runner = new TypeRunner(io);
  runner.cooldown.set(T.pid, 5000);
  st.status = 'shell'; st.ended = true; // session file still says idle right after an Enter
  const a = runner.run('e', T);
  st.now += 3100; // the second press passes the old time-only limiter
  const b = runner.run('e', T);
  setTimeout(() => {}, 0);
  st.status = 'busy';
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(st.keys.filter((k) => k === '\x1b').length, 1);
  assert.ok([ra.text, rb.text].some((x) => /đang gửi Esc|vừa gửi Esc/.test(x)));
});

test('Esc: state or target changing during the quiet wait → no key', async () => {
  for (const change of [(s) => { s.status = 'shell'; s.ended = true; }, (s, io) => { io.session = () => ({ sessionId: 'OTHER', status: 'busy' }); }]) {
    const { io, st } = fakeIo({ status: 'busy' });
    const realSleep = io.sleep;
    io.sleep = async (ms) => { if (ms === 300) change(st, io); return realSleep(ms); };
    const r = await new TypeRunner(io).run('e', T);
    assert.deepEqual(st.keys, []);
    assert.match(r.text, /không có gì để dừng|đổi phiên/);
  }
});

test('Esc: during the cool-down it fires as soon as the agent shows busy (no fixed 5 s wait)', async () => {
  const { io, st } = fakeIo({ status: 'shell', ended: true });
  const runner = new TypeRunner(io);
  runner.cooldown.set(T.pid, 5000);
  const realSleep = io.sleep;
  io.sleep = async (ms) => { if (st.now >= 500) st.status = 'busy'; return realSleep(ms); };
  await runner.run('e', T);
  assert.deepEqual(st.keys, ['\x1b']);
  assert.ok(st.now < 5000 + 3000, `sent before the cool-down ended (now=${st.now})`);
});

test('/remote-control: an Esc pressed between typing and the FIRST Enter cancels it (no Enter at all)', async () => {
  const { io, st } = fakeIo({ status: 'idle', screens: [IDLE, hc('rc-typed')] });
  const runner = new TypeRunner(io);
  const realSleep = io.sleep;
  io.sleep = async (ms) => { if (ms === 500 && st.keys.length === 1) runner.cancel.set(T.pid, true); return realSleep(ms); };
  const r = await runner.run('r', T);
  assert.deepEqual(st.keys, ['/remote-control']);
  assert.match(r.text, /huỷ.*KHÔNG Enter/);
});

test('typeTargets: a screen whose claude switched to another session (hashtag ≠ screen name) is not listed', () => {
  const base = { pid: 10, ppid: 9, screenPid: 9, screen: 'tele-abcd1234', sessionId: 's', guessed: false, procStart: '1', hashtag: 'abcd1234' };
  assert.equal(typeTargets([{ ...base, hashtag: 'bbbb2222' }]).length, 0);
});

test('defaultIo: exact screen argv; window count parsing; hardcopy read back as latin1', async () => {
  const calls = [];
  const exec = (bin, args) => {
    calls.push([bin, ...args]);
    if (args.includes('windows')) return calls.length === 1 ? '0 claude' : '0$ bash  1-$ claude';
    if (args.includes('hardcopy')) fs.writeFileSync(args.at(-1), Buffer.from([0x6f, 0xa0, 0x2f, 0x63]));
    return '';
  };
  const io = defaultIo({ exec });
  assert.equal(io.windows('9.tele-x'), 1);
  assert.equal(io.windows('9.tele-x'), 2);
  io.stuff('9.tele-x', '/compact');
  assert.deepEqual(calls[2], ['screen', '-S', '9.tele-x', '-p', '0', '-X', 'stuff', '/compact']);
  assert.equal(await io.hardcopy('9.tele-x'), 'o\u00a0/c');
  assert.deepEqual(calls[3].slice(0, 7), ['screen', '-S', '9.tele-x', '-p', '0', '-X', 'hardcopy']);
  assert.ok(!fs.existsSync(calls[3][7]), 'temp hardcopy removed');
});

test('/compact: an OLD "Not enough messages" still on screen is not this run\'s result (watch the transcript)', async () => {
  const stale = hc('compact-typed') + '\n  x  Not enough messages to compact.';
  const { io } = fakeIo({ screens: [IDLE, stale, stale], compact: { preTokens: 900000, postTokens: 9000 } });
  const r = await new TypeRunner(io).run('c', T);
  assert.equal(await r.watch(), '✅ đã compact: 900k → 9k');
});

test('parseInputLine: a multi-line draft below the prompt line never reads as just the command', () => {
  const multi = hc('compact-typed').replace('o\u00a0/compact\n', 'o\u00a0/compact\n  more draft text\n');
  assert.notEqual(multi, hc('compact-typed'));
  assert.notEqual(parseInputLine(multi), '/compact');
  assert.match(parseInputLine(multi), /more draft text/);
});

test('defaultIo.windows: a last window with an empty title still counts', () => {
  const io = defaultIo({ exec: () => '0-$ claude  1*$' });
  assert.equal(io.windows('9.x'), 2);
});

test('Esc while a /remote-control chain runs but the agent is not busy: chain cancelled AND the owner is told', async () => {
  const { io, st } = fakeIo({ status: 'idle' });
  const runner = new TypeRunner(io);
  runner.locks.add(T.pid); // a chain holds the agent
  const r = await runner.run('e', T);
  assert.deepEqual(st.keys, []);
  assert.equal(runner.cancel.get(T.pid), true);
  assert.match(r.text, /đã huỷ lệnh đang gõ dở/);
});

test('compactRefusedOnScreen: only an error BELOW the last submitted /compact counts (old ones may scroll off or stay)', () => {
  assert.equal(compactRefusedOnScreen(hc('compact-done-empty')), true); // our /compact, error right below
  const old = 'o /compact\n  x  Not enough messages to compact.\no /compact\n  x  Compacted\n';
  assert.equal(compactRefusedOnScreen(old), false); // the error belongs to an EARLIER /compact
  const scrolledOff = 'o /compact\n  x  Not enough messages to compact.\n'; // old error scrolled away; only ours visible
  assert.equal(compactRefusedOnScreen(scrolledOff), true);
  assert.equal(compactRefusedOnScreen(hc('compact-typed')), false); // nothing submitted yet
});

test('/compact: a NEW refusal is seen even when an old one scrolled off (same count on screen)', async () => {
  const before = hc('compact-typed') + '\n  x  Not enough messages to compact.';
  const { io } = fakeIo({ screens: [IDLE, before, before, hc('compact-done-empty')] });
  const r = await new TypeRunner(io).run('c', T);
  assert.match(await r.watch(), /chưa đủ tin nhắn/);
});

test('Esc after a remote-control chain sent its last key: not reported as a cancel', async () => {
  const { io } = fakeIo({ status: 'idle' });
  const runner = new TypeRunner(io);
  runner.locks.add(T.pid); runner.keysDone.add(T.pid);
  assert.match((await runner.run('e', T)).text, /không có gì để dừng/);
});

test('runner /compact while BUSY: queued (Claude runs it when the turn ends); refused if something is already queued; /remote-control stays idle-only', async () => {
  const busyScreen = hc('compact-typed').replace('auto mode on', 'auto mode on · esc to interrupt');
  const { io, st } = fakeIo({ status: 'busy', screens: [IDLE, busyScreen, hc('compact-typed'), hc('compact-typed')], compact: { preTokens: 733000, postTokens: 9000 } });
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact', '\r']);
  assert.match(r.text, /đã xếp hàng/);
  assert.equal(await r.watch(), '✅ đã compact: 733k → 9k');
  assert.equal(st.audits.find((a) => a.step === 'enter').queued, true);
  const q = fakeIo({ status: 'busy', screens: [hc('compact-typed') + '\n  Press up to edit queued messages'] });
  assert.match((await new TypeRunner(q.io).run('c', T)).text, /đã có tin xếp hàng/);
  assert.deepEqual(q.st.keys, []);
  const rc = fakeIo({ status: 'busy' });
  assert.match((await new TypeRunner(rc.io).run('r', T)).text, /đang bận/);
  assert.deepEqual(rc.st.keys, []);
});

test('/compact while busy: a dialog appearing right before Enter (second screen read) → NO Enter', async () => {
  const { io, st } = fakeIo({ status: 'busy', screens: [IDLE, hc('compact-typed'), hc('rc-dialog')] }); // before · typed · right before Enter
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact']);
  assert.match(r.text, /màn hình vừa đổi.*KHÔNG Enter/);
});

test('runner: the typed text shows late (busy render) → re-read until it does, then Enter', async () => {
  const empty = hc('compact-done-empty');
  const { io, st } = fakeIo({ screens: [IDLE, empty, empty, hc('compact-typed'), hc('compact-typed')], compact: { preTokens: 1000, postTokens: 10 } });
  const r = await new TypeRunner(io).run('c', T);
  assert.deepEqual(st.keys, ['/compact', '\r'], 'no false "chữ khác" for an empty first read');
  assert.match(r.text, /đã gõ \/compact/);
});

test('runner: text already in the box (e.g. an earlier /compact without Enter) → refused, NO key sent', async () => {
  for (const scr of [hc('compact-typed'), hc('draft')]) {
    const { io, st } = fakeIo({ screens: [scr] });
    const r = await new TypeRunner(io).run('c', T);
    assert.match(r.text, /ô nhập đang có chữ/);
    assert.deepEqual(st.keys, []);
    assert.equal(st.audits.at(-1).reason, 'input-not-empty');
  }
});

test('isPlaceholder: the dim "Try …" hint is not a draft', () => {
  assert.equal(isPlaceholder('Try "fix lint errors"'), true);
  assert.equal(isPlaceholder('/compact'), false);
  assert.equal(isPlaceholder('abc draft'), false);
});

test('runner: 🔍 read input — empty / placeholder / text (offers clear); never sends a key', async () => {
  for (const [scr, re, canClear] of [[hc('compact-done-empty'), /đang trống/, undefined], [IDLE, /đang trống/, undefined], [hc('compact-typed'), /đang có: "\/compact"/, true]]) {
    const { io, st } = fakeIo({ screens: [scr] });
    const r = await new TypeRunner(io).run('i', T);
    assert.match(r.text, re);
    assert.equal(r.canClear, canClear);
    assert.deepEqual(st.keys, []);
  }
  const w = fakeIo({ status: 'waiting', ended: true, screens: [hc('compact-typed')] });
  assert.match((await new TypeRunner(w.io).run('i', T)).text, /không đọc ô nhập/);
});

test('runner: 🧹 clear input — End + Ctrl-U, verified empty; still text → told; empty / dialog → no key', async () => {
  const { io, st } = fakeIo({ screens: [hc('compact-typed'), hc('compact-done-empty')] });
  const r = await new TypeRunner(io).run('u', T);
  assert.deepEqual(st.keys, ['\x05\x15']);
  assert.match(r.text, /đã xoá ô nhập/);
  const stuck = fakeIo({ screens: [hc('draft')] });
  assert.match((await new TypeRunner(stuck.io).run('u', T)).text, /vẫn còn: "abc draft"/);
  const empty = fakeIo({ screens: [IDLE] });
  assert.match((await new TypeRunner(empty.io).run('u', T)).text, /đã trống — không gửi phím nào/);
  assert.deepEqual(empty.st.keys, []);
  const dlg = fakeIo({ status: 'waiting', ended: true, screens: [hc('compact-typed')] });
  assert.match((await new TypeRunner(dlg.io).run('u', T)).text, /không xoá ô nhập/);
  assert.deepEqual(dlg.st.keys, []);
});
