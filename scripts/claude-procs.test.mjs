import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parsePsOutput, parseSessionFile, cwdToProjectSlug, hashtagForSession, styFromEnviron, styPidFromEnviron,
  procStartFromStat, screenFromAncestors, buildProcRows, formatAgentList, parseKillPidArg, findUnidentifiedProcs,
  checkKillTarget, killClaudePid, findProcForSession, etimeToSeconds, guessSessionFromTranscripts,
  inspectPid, readPs, listClaudeProcs,
} from './claude-procs.mjs';

const SID = '971e709e-2629-4d22-9943-40a52ee04a6b'; // hashtag #a7611284 (verified live)
const SID2 = '5ce13594-1e43-4d2d-afd3-ac16ccfece93';

const PS = [
  '      1       0     0 ?        10-00:00:00 systemd         /sbin/init',
  ' 830318  830000  1000 pts/7    2-00:49:26 claude          claude',
  '1129420       1  1000 ?        1-22:00:00 SCREEN          SCREEN -U -dmS tele-i0744244 claude --permission-mode auto',
  '1129421 1129420  1000 pts/8    1-22:00:00 claude          claude --permission-mode auto --session-id 5ce1',
  '   4242       1  1001 pts/1       05:00 claude          claude',
  '   5555       1  1000 pts/2       01:00 node            node /usr/lib/claude/cli.js',
  'garbage line',
].join('\n');

test('parsePsOutput: rows, tty ? → null, comm basename, args kept, junk dropped', () => {
  const rows = parsePsOutput(PS + '\n 77 1 501 ?? 00:01 /Applications/Claude/claude claude -r x');
  assert.equal(rows.length, 7);
  const giun = rows.find((r) => r.pid === 830318);
  assert.deepEqual(giun, { pid: 830318, ppid: 830000, uid: 1000, tty: 'pts/7', etime: '2-00:49:26', comm: 'claude', args: 'claude' });
  assert.equal(rows.find((r) => r.pid === 1129420).tty, null);
  const mac = rows.find((r) => r.pid === 77);
  assert.equal(mac.comm, 'claude');
  assert.equal(mac.tty, null);
});

test('etimeToSeconds: all ps shapes', () => {
  assert.equal(etimeToSeconds('00:05'), 5);
  assert.equal(etimeToSeconds('05:00'), 300);
  assert.equal(etimeToSeconds('01:00:00'), 3600);
  assert.equal(etimeToSeconds('2-00:00:01'), 2 * 86400 + 1);
  assert.equal(etimeToSeconds('nope'), null);
});

test('parseSessionFile: picks the useful fields, rejects junk / bad uuid', () => {
  const s = parseSessionFile(JSON.stringify({ pid: 830318, sessionId: SID, cwd: '/w/umipay', name: '🪱 Giun', status: 'idle', kind: 'interactive', procStart: '5943432' }));
  assert.deepEqual(s, { pid: 830318, sessionId: SID, cwd: '/w/umipay', name: '🪱 Giun', status: 'idle', bridgeSessionId: null, kind: 'interactive', procStart: '5943432' });
  assert.equal(parseSessionFile(JSON.stringify({ pid: 1, bridgeSessionId: 'session_01K' })).bridgeSessionId, 'session_01K');
  assert.equal(parseSessionFile(JSON.stringify({ pid: 1, bridgeSessionId: null })).bridgeSessionId, null);
  assert.equal(parseSessionFile('not json'), null);
  assert.equal(parseSessionFile(null), null);
  assert.equal(parseSessionFile(JSON.stringify({ sessionId: SID })), null); // no pid
  assert.equal(parseSessionFile(JSON.stringify({ pid: 1, sessionId: '../etc' })).sessionId, null);
});

test('styPidFromEnviron: the SCREEN pid from STY; null without STY', () => {
  assert.equal(styPidFromEnviron('A=1\0STY=331130.tele-d8133684\0B=2'), 331130);
  assert.equal(styPidFromEnviron('A=1\0B=2'), null);
});

test('cwdToProjectSlug matches Claude Code project dir names', () => {
  assert.equal(cwdToProjectSlug('/home/admin123/Projects/teleport'), '-home-admin123-Projects-teleport');
  assert.equal(cwdToProjectSlug('/home/a/.config/x_y'), '-home-a--config-x-y');
});

test('hashtagForSession: same derivation the agent uses', () => {
  assert.equal(hashtagForSession(SID), 'a7611284');
  assert.equal(hashtagForSession('nope'), null);
  assert.equal(hashtagForSession(null), null);
});

test('styFromEnviron / procStartFromStat', () => {
  assert.equal(styFromEnviron('A=1\0STY=1129420.tele-i0744244\0B=2'), 'tele-i0744244');
  assert.equal(styFromEnviron('A=1\0B=2'), null);
  assert.equal(styFromEnviron(null), null);
  // comm with spaces + parens must not shift the fields
  const stat = '830318 (cl (a) ude) S 830000 830318 830000 34823 830318 4194560 1 2 3 4 5 6 7 8 20 0 12 0 5943432 100 200';
  assert.equal(procStartFromStat(stat), '5943432');
  assert.equal(procStartFromStat('garbage'), null);
});

test('screenFromAncestors: finds the screen -dmS name up the parent chain', () => {
  const rows = parsePsOutput(PS);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  assert.equal(screenFromAncestors(1129421, byPid), 'tele-i0744244');
  assert.equal(screenFromAncestors(830318, byPid), null); // parent not in list → terminal
});

test('buildProcRows: only this uid + comm=claude; session file joined; screen detected', () => {
  const rows = buildProcRows({
    psRows: parsePsOutput(PS), uid: 1000,
    sessions: new Map([[830318, parseSessionFile(JSON.stringify({ pid: 830318, sessionId: SID, cwd: '/w/umipay', name: '🪱 Giun', status: 'idle', procStart: '5943432' }))]]),
    procExtras: new Map([[830318, { procStart: '5943432' }]]),
  });
  assert.deepEqual(rows.map((r) => r.pid), [830318, 1129421]); // 4242 = other uid, 5555 = node
  const g = rows[0];
  assert.equal(g.sessionId, SID);
  assert.equal(g.hashtag, 'a7611284');
  assert.equal(g.name, '🪱 Giun');
  assert.equal(g.screen, null);
  assert.equal(g.guessed, false);
  assert.equal(rows[1].screen, 'tele-i0744244');
});

test('buildProcRows: stale session file (procStart mismatch = pid reused) is ignored', () => {
  const rows = buildProcRows({
    psRows: parsePsOutput(PS), uid: 1000,
    sessions: new Map([[830318, parseSessionFile(JSON.stringify({ pid: 830318, sessionId: SID, cwd: '/w/umipay', procStart: '111' }))]]),
    procExtras: new Map([[830318, { procStart: '5943432', cwd: '/w/other' }]]),
  });
  assert.equal(rows[0].sessionId, null);
  assert.equal(rows[0].cwd, '/w/other'); // falls back to /proc cwd
});

test('buildProcRows: guess skips claimed sessions and passes the process start time', () => {
  const calls = [];
  const rows = buildProcRows({
    psRows: parsePsOutput(PS), uid: 1000, nowMs: 1_000_000_000,
    sessions: new Map([[1129421, parseSessionFile(JSON.stringify({ pid: 1129421, sessionId: SID2, cwd: '/w/d' }))]]),
    procExtras: new Map([[830318, { cwd: '/w/umipay' }]]),
    guessSession: (cwd, claimed, sinceMs) => { calls.push({ cwd, claimed: [...claimed], sinceMs }); return { sessionId: SID }; },
  });
  assert.deepEqual(calls[0].claimed, [SID2]);
  assert.equal(calls[0].cwd, '/w/umipay');
  assert.equal(calls[0].sinceMs, 1_000_000_000 - (2 * 86400 + 49 * 60 + 26) * 1000 - 2000);
  assert.equal(rows[0].guessed, true);
  assert.equal(rows[0].sessionId, SID);
});

test('guessSessionFromTranscripts: newest unclaimed, written since start; ignores non-uuid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-proj-'));
  const cwd = '/w/app';
  const pdir = path.join(dir, cwdToProjectSlug(cwd));
  fs.mkdirSync(pdir);
  const touch = (name, t) => { const f = path.join(pdir, name); fs.writeFileSync(f, '{}'); fs.utimesSync(f, t, t); };
  touch(`${SID}.jsonl`, 1000);
  touch(`${SID2}.jsonl`, 2000);
  touch('notes.jsonl', 3000);
  assert.equal(guessSessionFromTranscripts(cwd, { projectsDir: dir }).sessionId, SID2);
  assert.equal(guessSessionFromTranscripts(cwd, { projectsDir: dir, claimed: new Set([SID2]) }).sessionId, SID);
  assert.equal(guessSessionFromTranscripts(cwd, { projectsDir: dir, sinceMs: 2_500_000 }), null);
  assert.equal(guessSessionFromTranscripts('/w/none', { projectsDir: dir }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatAgentList: one block per claude process — title, `<emoji> <name>: <value>` lines, links last', () => {
  const procs = [
    { pid: 830318, tty: 'pts/7', etime: '2-00:49:26', cwd: '/home/u/Projects/umipay', screen: null, sessionId: SID, guessed: false, hashtag: 'a7611284', name: '🪱 Giun', status: 'idle', bridgeSessionId: 'b1' },
    { pid: 9, tty: 'pts/8', etime: '00:01', cwd: null, screen: 'tele-i0744244', sessionId: SID2, guessed: true, hashtag: 'i0744244', name: null, status: null },
    { pid: 11, tty: null, etime: '00:02', cwd: '/w', screen: 'work', sessionId: null, guessed: false, hashtag: null, name: 'x', status: null },
  ];
  const out = formatAgentList({
    screens: [{ pid: '1', name: 'tele-i0744244' }, { pid: '2', name: 'tele-empty123' }], procs,
    personaOf: (h) => (h === 'i0744244' ? '🦛 Hà Mã' : null), home: '/home/u',
    ctxOf: (r) => (r.pid === 830318 ? 'ctx 172k (17%)' : null),
    linksOf: (r) => (r.pid === 830318 ? ['/compact_a7611284', '/kill_a7611284'] : []),
  });
  const iScreen = out.indexOf('📺 Screen (3)');
  const iTerm = out.indexOf('🖥 Terminal (1)');
  assert.ok(iScreen === 0 && iTerm > iScreen, out);
  assert.match(out, new RegExp(`\n\n🦛 Hà Mã #i0744244\n📺 Screen: tele-i0744244\n🔢 PID: 9\n🆔 Session: ${SID2} \\(đoán\\)\n⏱️ Uptime: 00:01\n\n`));
  assert.match(out, /\n\n📺 tele-empty123 · không thấy claude bên trong\n\n/);
  assert.match(out, /\n\nx\n📺 Screen: work\n🔢 PID: 11\n📨 Session: x\n📁 Folder: w\n⏱️ Uptime: 00:02\n\n/); // non-tele screen hosting a claude
  const term = out.slice(iTerm);
  assert.equal(term, `🖥 Terminal (1)\n\n🪱 Giun #a7611284\n🔢 PID: 830318\n📨 Session: 🪱 Giun\n🆔 Session: ${SID}\n⚙️ Trạng thái: idle\n📁 Folder: umipay\n⏱️ Uptime: 2-00:49:26\n🧠 Context: 172k\n📡 Remote Control: bật\n/compact_a7611284 /kill_a7611284`);
  assert.doesNotMatch(out, /pts\//);   // no tty line
  assert.doesNotMatch(out, /\n\n\n/);  // exactly one empty line between blocks
  const hidden = formatAgentList({ procs, showSession: false });
  assert.doesNotMatch(hidden, /🆔|5ce13594/, 'UUIDs hidden on Telegram');
  assert.match(formatAgentList({ procs: [{ ...procs[1], name: 'g' }], showSession: false }), /📨 Session: g \(đoán\)/, 'a guess stays visible without the UUID');
  assert.match(formatAgentList({ procs: [{ pid: 5 }] }), /🖥 Terminal \(1\)\n\n🖥 PID 5\n🔢 PID: 5$/);
  const empty = formatAgentList({});
  assert.equal(empty, '📺 Screen (0)\n\n(không có)\n\n🖥 Terminal (0)\n\n(không có)');
});

test('formatAgentList full:false — one line per agent (icon, name #hash, state, ctx, 🔇, 📬) + its links', () => {
  const procs = [
    { pid: 1, etime: '1:00', cwd: '/w/a', screen: 'tele-a7611284', sessionId: SID, hashtag: 'a7611284', name: 'sess-a', status: 'busy' },
    { pid: 2, etime: '1:00', cwd: '/w/b', screen: null, sessionId: null, hashtag: null, name: 'term', status: null },
    { pid: 3, etime: '1:00', cwd: '/w/c', screen: null, sessionId: null, hashtag: null, name: null, status: null },
  ];
  const out = formatAgentList({
    full: false, screens: [{ name: 'tele-empty123' }], procs,
    personaOf: (h) => (h === 'a7611284' ? '🪱 Giun' : null),
    ctxOf: (r) => (r.pid === 1 ? 'ctx 150k (15%)' : null),
    listenerOf: () => 'off', mailOf: () => 2,
    linksOf: (r) => (r.pid === 1 ? ['/compact_a7611284', '/kill_a7611284', '/nudge_a7611284'] : []),
  });
  assert.equal(out, [
    '📺 tele-empty123 · không thấy claude bên trong',
    '📺 🪱 Giun #a7611284 · busy · 150k · 🔇 · 📬2\n/compact_a7611284 /kill_a7611284 /nudge_a7611284',
    '🖥 term',
    '🖥 PID 3',
  ].join('\n\n'));
  assert.equal(formatAgentList({ full: false }), '(không có agent nào)');
  const hl = (n) => formatAgentList({ full: false, procs: [procs[0]], ctxOf: () => 'ctx Xk (9%)', tokensOf: () => n });
  assert.match(hl(300_000), /busy · Xk$/);
  assert.match(hl(300_001), /busy · 🟡 Xk$/);
  assert.match(hl(700_001), /busy · 🔴 Xk$/);
  assert.match(formatAgentList({ procs: [procs[0]], ctxOf: () => 'ctx 800k', tokensOf: () => 800_000 }), /🧠 Context: 🔴 800k/, 'full form too');
});

test('formatAgentList: a throwing lookup drops its line, never the list', () => {
  const boom = () => { throw new Error('x'); };
  const out = formatAgentList({ procs: [{ pid: 2, sessionId: SID, hashtag: 'a7611284', cwd: '/w' }], personaOf: boom, ctxOf: boom, linksOf: boom, statusLinesOf: boom, mailOf: boom });
  assert.match(out, /#a7611284\n🔢 PID: 2\n🆔 Session: \S+\n📁 Folder: w$/);
});

test('findUnidentifiedProcs: no session file (or guessed) AND cwd unknown/same', () => {
  const rows = [
    { pid: 1, sessionId: SID, guessed: false, cwd: '/w/a' },  // identified → fine
    { pid: 2, sessionId: null, guessed: false, cwd: '/w/a' }, // unknown, same cwd → suspect
    { pid: 3, sessionId: SID2, guessed: true, cwd: '/w/a' },  // guess is not proof → suspect
    { pid: 4, sessionId: null, guessed: false, cwd: null },   // cwd unknown → suspect
    { pid: 5, sessionId: null, guessed: false, cwd: '/w/b' }, // other folder → can't hold /w/a's session
  ];
  assert.deepEqual(findUnidentifiedProcs('/w/a', rows).map((r) => r.pid), [2, 3, 4]);
});

test('killClaudePid: pid reused between check and signal (start changed) → no signal', async () => {
  const sent = []; let n = 0;
  const r = await killClaudePid(500, {
    uid: 1000, describe: () => null, kill: (p, s) => sent.push(s),
    inspect: () => ({ uid: 1000, comm: 'claude', start: n++ === 0 ? '100' : '200' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /pid bị dùng lại/);
  assert.equal(sent.length, 0);
});

test('killClaudePid: replaced by a non-claude during describe → refused on the re-check', async () => {
  const sent = []; let n = 0;
  const r = await killClaudePid(500, {
    uid: 1000, describe: () => null, kill: (p, s) => sent.push(s),
    inspect: () => (n++ === 0 ? { uid: 1000, comm: 'claude', start: '1' } : { uid: 1000, comm: 'bash', start: '2' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /không phải claude/);
  assert.equal(sent.length, 0);
});

test('parseKillPidArg', () => {
  assert.equal(parseKillPidArg('pid:830318'), 830318);
  assert.equal(parseKillPidArg(' PID: 42 '), 42);
  assert.equal(parseKillPidArg('pid:1'), null);       // init
  assert.equal(parseKillPidArg('pid:-5'), null);
  assert.equal(parseKillPidArg('pid:12abc'), null);
  assert.equal(parseKillPidArg('a7611284'), null);
  assert.equal(parseKillPidArg('pid:99999999999999999999'), null);
});

test('checkKillTarget: only a live claude of this uid, never self', () => {
  const opts = { uid: 1000, selfPid: 77 };
  assert.ok(checkKillTarget(500, { uid: 1000, comm: 'claude' }, opts).ok);
  assert.match(checkKillTarget(500, null, opts).error, /không có tiến trình/);
  assert.match(checkKillTarget(500, { uid: 0, comm: 'claude' }, opts).error, /không thuộc user/);
  assert.match(checkKillTarget(500, { uid: 1000, comm: 'node' }, opts).error, /không phải claude/);
  assert.match(checkKillTarget(77, { uid: 1000, comm: 'claude' }, opts).error, /không tự kill/);
  assert.match(checkKillTarget(1, { uid: 1000, comm: 'claude' }, opts).error, /không hợp lệ/);
});

test('killClaudePid: refuses a non-claude without sending any signal', async () => {
  const sent = [];
  const r = await killClaudePid(500, { uid: 1000, inspect: () => ({ uid: 1000, comm: 'bash' }), kill: (p, s) => sent.push([p, s]), describe: () => null });
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
});

test('killClaudePid: SIGTERM, then reports exit within grace', async () => {
  const sent = []; let aliveChecks = 0;
  const r = await killClaudePid(500, {
    uid: 1000, inspect: () => ({ uid: 1000, comm: 'claude' }), describe: () => ({ pid: 500, sessionId: SID }),
    kill: (p, s) => sent.push([p, s]), alive: () => ++aliveChecks < 3, sleep: async () => {}, graceMs: 10_000, pollMs: 500,
  });
  assert.deepEqual(sent, [[500, 'SIGTERM']]);
  assert.deepEqual(r, { ok: true, exited: true, target: { pid: 500, sessionId: SID } });
});

test('killClaudePid: still alive after grace → exited:false, never SIGKILL', async () => {
  const sent = []; const slept = [];
  const r = await killClaudePid(500, {
    uid: 1000, inspect: () => ({ uid: 1000, comm: 'claude' }), describe: () => null,
    kill: (p, s) => sent.push(s), alive: () => true, sleep: async (ms) => slept.push(ms), graceMs: 1200, pollMs: 500,
  });
  assert.deepEqual(sent, ['SIGTERM']);
  assert.equal(r.exited, false);
  assert.equal(slept.reduce((a, b) => a + b, 0), 1200); // clamped to the grace window
});

test('killClaudePid: a failing SIGTERM is reported', async () => {
  const r = await killClaudePid(500, {
    uid: 1000, inspect: () => ({ uid: 1000, comm: 'claude' }), describe: () => null,
    kill: () => { const e = new Error('x'); e.code = 'EPERM'; throw e; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /EPERM/);
});

test('findProcForSession: exact or guessed holder counts', () => {
  const rows = [{ pid: 1, sessionId: SID, guessed: false }, { pid: 2, sessionId: SID2, guessed: true }];
  assert.equal(findProcForSession(SID, rows).pid, 1);
  assert.equal(findProcForSession(SID2, rows).pid, 2);
  assert.equal(findProcForSession('x', rows), null);
});

// ── Side-effecting layer with fixtures (the real kill gate) ───────────────────
const STAT = (start) => `123 (claude) S 1 123 123 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 12 0 ${start} 100 200`;
function procFixture(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'procfx-'));
  for (const [pid, e] of Object.entries(entries)) {
    const d = path.join(dir, pid); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'comm'), `${e.comm}\n`);
    fs.writeFileSync(path.join(d, 'status'), `Name:\t${e.comm}\nUid:\t${e.uid}\t${e.uid}\t${e.uid}\t${e.uid}\nGid:\t${e.gid}\t${e.gid}\t${e.gid}\t${e.gid}\n`);
    fs.writeFileSync(path.join(d, 'stat'), STAT(e.start));
  }
  return dir;
}

test('inspectPid (/proc): uid from the Uid line (not Gid), comm trimmed, start = stat field 22; gone → null', () => {
  const dir = procFixture({ 123: { comm: 'claude', uid: 1001, gid: 1000, start: '777' } });
  assert.deepEqual(inspectPid(123, { procDir: dir }), { uid: 1001, comm: 'claude', start: '777' });
  let psCalls = 0;
  assert.equal(inspectPid(999, { procDir: dir, exec: () => { psCalls++; return ' 1000 claude Mon Oct  6 09:00:00 2026'; } }), null);
  assert.equal(psCalls, 0, '/proc present but no entry → gone, never a ps fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectPid (no /proc): ps -p fallback with lstart as the start fingerprint', () => {
  const calls = [];
  const exec = (bin, args) => { calls.push([bin, ...args]); return ' 501 /Applications/claude Mon Oct  6 09:00:00 2026\n'; };
  assert.deepEqual(inspectPid(42, { procDir: '/nonexistent-proc', exec }), { uid: 501, comm: 'claude', start: 'Mon Oct  6 09:00:00 2026' });
  assert.deepEqual(calls[0], ['ps', '-p', '42', '-o', 'uid=,comm=,lstart=']);
  assert.equal(inspectPid(42, { procDir: '/nonexistent-proc', exec: () => { throw new Error('no such pid'); } }), null);
});

test('readPs: null on failure or empty output (unknown ≠ nothing running)', () => {
  assert.equal(readPs(() => { throw new Error('ps missing'); }), null);
  assert.equal(readPs(() => ''), null);
  assert.equal(readPs(() => PS).length, 6);
});

test('listClaudeProcs: strict throws on ps failure, lenient → []; session file must match its pid', () => {
  const failing = () => { throw new Error('ps missing'); };
  assert.throws(() => listClaudeProcs({ uid: 1000, exec: failing, strict: true }), /ps failed/);
  assert.deepEqual(listClaudeProcs({ uid: 1000, exec: failing }), []);
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessfx-'));
  // 830318.json claims to be pid 1 → must be ignored
  fs.writeFileSync(path.join(sdir, '830318.json'), JSON.stringify({ pid: 1, sessionId: SID, cwd: '/w' }));
  fs.writeFileSync(path.join(sdir, '1129421.json'), JSON.stringify({ pid: 1129421, sessionId: SID2, cwd: '/w/d', name: 'a7' }));
  const rows = listClaudeProcs({ uid: 1000, exec: () => PS, sessionsDir: sdir, procDir: '/nonexistent-proc', projectsDir: '/nonexistent-proj' });
  assert.equal(rows.find((r) => r.pid === 830318).sessionId, null);
  assert.equal(rows.find((r) => r.pid === 1129421).sessionId, SID2);
  fs.rmSync(sdir, { recursive: true, force: true });
});

test('killClaudePid: a bad pid is refused BEFORE the slow describe() scan', async () => {
  let described = 0;
  const r = await killClaudePid(500, { uid: 1000, inspect: () => null, describe: () => { described++; return null; }, kill: () => {} });
  assert.equal(r.ok, false);
  assert.equal(described, 0);
});

test('listClaudeProcs (/proc extras): stale session file dropped by procStart; cwd symlink + STY used', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'procx-'));
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessx-'));
  const mk = (pid, { start, cwd, sty }) => {
    const d = path.join(proc, String(pid)); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'stat'), STAT(start));
    fs.symlinkSync(cwd, path.join(d, 'cwd'));
    fs.writeFileSync(path.join(d, 'environ'), sty ? `A=1\0STY=99.${sty}\0` : 'A=1\0');
  };
  mk(830318, { start: '5943432', cwd: '/w/live' });
  mk(1129421, { start: '42', cwd: '/w/scr', sty: 'tele-i0744244' });
  // 830318's file is from an earlier process with the same pid (different procStart)
  fs.writeFileSync(path.join(sdir, '830318.json'), JSON.stringify({ pid: 830318, sessionId: SID, cwd: '/w/old', procStart: '111' }));
  fs.writeFileSync(path.join(sdir, '1129421.json'), JSON.stringify({ pid: 1129421, sessionId: SID2, cwd: '/w/scr', procStart: '42' }));
  const rows = listClaudeProcs({ uid: 1000, exec: () => PS, sessionsDir: sdir, procDir: proc, projectsDir: '/nonexistent-proj' });
  const a = rows.find((r) => r.pid === 830318);
  assert.equal(a.sessionId, null, 'stale file must be dropped');
  assert.equal(a.cwd, '/w/live', 'falls back to /proc cwd');
  const b = rows.find((r) => r.pid === 1129421);
  assert.equal(b.sessionId, SID2);
  assert.equal(b.screen, 'tele-i0744244');
  assert.equal(b.procStart, '42', 'rows carry their start fingerprint');
  fs.rmSync(proc, { recursive: true, force: true }); fs.rmSync(sdir, { recursive: true, force: true });
});

test('killClaudePid: describe() runs BEFORE the final re-inspect (race window stays narrow)', async () => {
  const order = [];
  await killClaudePid(500, {
    uid: 1000, alive: () => false, sleep: async () => {}, kill: () => order.push('kill'),
    inspect: () => { order.push('inspect'); return { uid: 1000, comm: 'claude', start: '1' }; },
    describe: () => { order.push('describe'); return null; },
  });
  assert.deepEqual(order, ['inspect', 'describe', 'inspect', 'kill']);
});

test('killClaudePid: expectStart (caller snapshot) mismatch → refused, no signal', async () => {
  const sent = [];
  const r = await killClaudePid(500, {
    uid: 1000, expectStart: '100', describe: () => null, kill: (p, s) => sent.push(s),
    inspect: () => ({ uid: 1000, comm: 'claude', start: '200' }),
  });
  assert.match(r.error, /pid bị dùng lại/);
  assert.equal(sent.length, 0);
});

