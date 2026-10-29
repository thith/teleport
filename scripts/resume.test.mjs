import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findResumeTarget, transcriptCwd, checkCwd, listCandidates, formatStopped, dedupeCandidates, ago, runMain } from './resume.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';

const C = [
  { sessionId: 's1', hashtag: 'j8436116', persona: '🧚 Tiên', mtimeMs: 100 },
  { sessionId: 's2', hashtag: 'b1111111', persona: '🧚 Tiên', mtimeMs: 50 },
  { sessionId: 's3', hashtag: 'c2383556', persona: '👻 Ma', mtimeMs: 70 },
  { sessionId: 's4', hashtag: 'd2222222', persona: '🐍 Rắn 3', mtimeMs: 60 },
  { sessionId: 's5', hashtag: 'e3333333', persona: '🐍 Rắn', mtimeMs: 90 },
];

test('findResumeTarget: by hashtag, by full persona name (newest wins, others listed), never a substring', () => {
  assert.equal(findResumeTarget('#c2383556', C).target.sessionId, 's3');
  assert.equal(findResumeTarget('c2383556', C).target.sessionId, 's3');
  assert.equal(findResumeTarget('“tiên”', C).target.sessionId, findResumeTarget('tiên', C).target.sessionId, 'phone quotes off (RFC 26 §3.8)');
  const t = findResumeTarget('tiên', C);
  assert.equal(t.target.sessionId, 's1', 'newest');
  assert.deepEqual(t.others.map((o) => o.sessionId), ['s2']);
  assert.equal(findResumeTarget('Rắn', C).target.sessionId, 's5', '"Rắn" is not "Rắn 3"');
  assert.equal(findResumeTarget('rắn 3', C).target.sessionId, 's4');
  assert.match(findResumeTarget('Cú', C).error, /no agent "Cú"/);
  assert.match(findResumeTarget('', C).error, /usage/);
});

test('transcriptCwd / checkCwd: cwd from the transcript; must be inside the workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  const ws = path.join(dir, 'ws'); fs.mkdirSync(path.join(ws, 'umipay'), { recursive: true });
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, '{"type":"mode"}\n{"type":"user","cwd":"' + path.join(ws, 'umipay') + '"}\n');
  assert.equal(transcriptCwd(f), path.join(ws, 'umipay'));
  assert.equal(transcriptCwd(path.join(dir, 'missing')), null);
  assert.equal(checkCwd(path.join(ws, 'umipay'), { parentDir: ws }).cwd, fs.realpathSync(path.join(ws, 'umipay')));
  assert.match(checkCwd(dir, { parentDir: ws }).error, /outside the workspace/);
  assert.match(checkCwd(ws, { parentDir: ws }).error, /outside the workspace/, 'the workspace root itself is not a project');
  assert.match(checkCwd(path.join(ws, 'gone'), { parentDir: ws }).error, /no longer exists/);
  assert.match(checkCwd(null).error, /no working directory/);
});

test('listCandidates: only recent transcripts whose convo has a Telegram topic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsc-'));
  const pdir = path.join(dir, '-w-umipay'); fs.mkdirSync(pdir);
  const withTopic = 'ac22f365-d351-4e54-82a5-303156081507', noTopic = '00000000-0000-4000-8000-000000000123', old = 'ae61d4f1-5ecc-46fe-9cea-75b4c9d9b751';
  for (const id of [withTopic, noTopic, old]) fs.writeFileSync(path.join(pdir, `${id}.jsonl`), '{}');
  const t = new Date(Date.now() - 90 * 86400_000); fs.utimesSync(path.join(pdir, `${old}.jsonl`), t, t);
  const store = { '-100': { [uuidToConvoInt(withTopic)]: 5, [uuidToConvoInt(old)]: 6, _ts: {} } };
  const c = listCandidates({ projectsDir: dir, store });
  assert.deepEqual(c.map((x) => x.sessionId), [withTopic]);
  assert.equal(c[0].hashtag, shortConvoHash(uuidToConvoInt(withTopic)));
});

test('findResumeTarget: skips sessions still alive (newest dead match wins); all alive → clear error', () => {
  assert.equal(findResumeTarget('tiên', C, { aliveSessions: new Set(['s1']) }).target.sessionId, 's2');
  assert.match(findResumeTarget('ma', C, { aliveSessions: new Set(['s3']) }).error, /still running/);
});

test('findResumeTarget: reports skipped live namesakes; accepts the name: prefix', () => {
  const r = findResumeTarget('tiên', C, { aliveSessions: new Set(['s1']) });
  assert.equal(r.target.sessionId, 's2');
  assert.deepEqual(r.skippedLive.map((x) => x.sessionId), ['s1']);
  assert.equal(findResumeTarget('name:Ma', C).target.sessionId, 's3');
  assert.equal(findResumeTarget('name: #c2383556', C).target.sessionId, 's3');
  assert.match(findResumeTarget('#c9999999', C).error, /no agent/, 'an unmatched hashtag never falls back to names');
  assert.match(findResumeTarget('pid:123', C).error, /usage/);
  const twin = [...C, { ...C.find((c) => c.hashtag === 'c2383556'), sessionId: 's9', mtimeMs: 1 }];
  assert.match(findResumeTarget('#c2383556', twin).error, /matches 2 sessions/, 'two sessions behind one hashtag → refuse');
  assert.match(findResumeTarget('#c2383556', C, { liveRows: [{ pid: 4, hashtag: 'c2383556', sessionId: 'zz' }] }).error, /also belongs to live claude PID 4/);
  assert.match(findResumeTarget('#c2383556', C, { liveRows: [{ pid: 4, hashtag: 'c2383556', sessionId: 's3', guessed: true }] }).error, /PID 4/, 'a guess is not proof');
  assert.match(findResumeTarget('#c2383556', C, { aliveSessions: new Set(['s3']), liveRows: [{ pid: 4, hashtag: 'c2383556', sessionId: 's3' }] }).error, /still running/, 'its own live process → the usual refusal');
});

// ── RFC 28: 3-digit tail, ls off, runMain ─────────────────────────────────────

const SUA = { sessionId: 'u-sua', hashtag: 'f4451780', persona: '🪼 Sứa', mtimeMs: 1000 };
const CAO = { sessionId: 'u-cao', hashtag: 'b2222780', persona: '🦊 Cáo', mtimeMs: 2000 };
const NOW = 10_000_000;

test('findResumeTarget: a 3-digit tail resolves to the one hashtag it ends → resume (also name:780)', () => {
  assert.equal(findResumeTarget('780', [SUA, C[0]]).target.sessionId, 'u-sua');
  assert.equal(findResumeTarget('name:780', [SUA]).target.sessionId, 'u-sua');
  assert.match(findResumeTarget('999', [SUA]).error, /no agent ending in "999"/);
  assert.equal(findResumeTarget('#780', [SUA]).error.includes('no agent "780"'), true, '#780 is a hashtag, never a tail');
});

test('findResumeTarget: tail over a LIVE #a…780 and a dead #b…780 → refused, both listed (never silently the dead one)', () => {
  const live = { pid: 77, hashtag: 'f4451780', sessionId: 'u-sua', persona: '🪼 Sứa', screen: 'tele-f4451780' };
  const r = findResumeTarget('780', [SUA, CAO], { aliveSessions: new Set(['u-sua']), liveRows: [live] });
  assert.match(r.error, /"780" khớp 2 agent/);
  assert.match(r.error, /Sứa #f4451780 — đang chạy, PID 77/);
  assert.match(r.error, /Cáo #b2222780/);
  assert.equal(r.target, undefined);
});

test('findResumeTarget: only the live one matches → "đang chạy / still running" with a teleport attach hint (screen only)', () => {
  const live = { pid: 77, hashtag: 'f4451780', sessionId: 'u-sua', screen: 'tele-f4451780' };
  const r = findResumeTarget('780', [SUA], { aliveSessions: new Set(['u-sua']), liveRows: [live] });
  assert.match(r.error, /is still running/); assert.match(r.error, /teleport attach 780/);
  const term = findResumeTarget('780', [SUA], { aliveSessions: new Set(['u-sua']), liveRows: [{ ...live, screen: null }] });
  assert.doesNotMatch(term.error, /teleport attach/);
});

test('findResumeTarget: a live row that is NOT a candidate (guessed / older than 30 days / no topic) still counts toward the tail and is reported when typed by hashtag', () => {
  const guessed = { pid: 5, hashtag: 'c0000780', sessionId: 'g', guessed: true };
  assert.match(findResumeTarget('780', [SUA], { liveRows: [guessed] }).error, /"780" khớp 2 agent/);
  const old = { pid: 6, hashtag: 'd0000780', sessionId: 'old-session', screen: 'tele-d0000780' };
  assert.match(findResumeTarget('780', [SUA], { liveRows: [old] }).error, /"780" khớp 2 agent/);
  // by hashtag / by a tail that leads only to it: no candidate but alive → "đang chạy", not "no agent … in the last 30 days"
  const e = findResumeTarget('#d0000780', [SUA], { liveRows: [old] }).error;
  assert.match(e, /đang chạy \(PID 6\)/); assert.match(e, /teleport attach d0000780/); assert.doesNotMatch(e, /last 30 days/);
  assert.match(findResumeTarget('780', [], { liveRows: [old] }).error, /đang chạy \(PID 6\).*teleport attach 780/);
  assert.doesNotMatch(findResumeTarget('#d0000780', [], { liveRows: [{ ...old, screen: null }] }).error, /teleport attach/);
});

test('candidates: one session with transcripts in two project dirs is ONE (newest wins) — no false "matches 2 sessions"', () => {
  const a = { ...SUA, mtimeMs: 10, file: '/p1/u-sua.jsonl' }, b = { ...SUA, mtimeMs: 50, file: '/p2/u-sua.jsonl' };
  assert.deepEqual(dedupeCandidates([a, b]), [b]);
  const r = findResumeTarget('780', [a, b]);
  assert.equal(r.target.file, '/p2/u-sua.jsonl'); assert.deepEqual(r.others, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsd-'));
  const id = 'ac22f365-d351-4e54-82a5-303156081507';
  for (const d of ['-w-a', '-w-b']) { fs.mkdirSync(path.join(dir, d)); fs.writeFileSync(path.join(dir, d, `${id}.jsonl`), '{}'); }
  const c = listCandidates({ projectsDir: dir, store: { '-1': { [uuidToConvoInt(id)]: 5 } } });
  assert.equal(c.length, 1);
});

test('findResumeTarget: two sessions behind one hashtag → refused with UUID, folder and last activity of each', () => {
  const x = { sessionId: 'uuid-x', hashtag: 'j8436116', persona: '🧚 Tiên', mtimeMs: NOW - 2 * 3600_000 }, y = { sessionId: 'uuid-y', hashtag: 'j8436116', persona: '🧚 Tiên', mtimeMs: NOW - 3 * 86400_000 };
  const r = findResumeTarget('#j8436116', [x, y], { folderOf: (c) => (c === x ? 'teleport' : 'digesty'), now: NOW });
  assert.match(r.error, /uuid-x \(teleport, 2 giờ trước\)/); assert.match(r.error, /uuid-y \(digesty, 3 ngày trước\)/);
  assert.match(r.error, /--resume-session <uuid>/);
});

test('ago: vừa xong / phút / giờ / ngày', () => {
  assert.equal(ago(NOW - 30_000, NOW), 'vừa xong'); assert.equal(ago(NOW - 5 * 60_000, NOW), '5 phút trước');
  assert.equal(ago(NOW - 2 * 3600_000, NOW), '2 giờ trước'); assert.equal(ago(NOW - 3 * 86400_000, NOW), '3 ngày trước');
});

test('formatStopped: newest first, max 20 + "và N agent cũ hơn", relative time, folder and persona optional', () => {
  const cs = Array.from({ length: 23 }, (_, i) => ({ sessionId: `s${i}`, hashtag: `a${String(1000000 + i)}`, persona: i === 22 ? null : '🪼 Sứa', mtimeMs: NOW - (i + 1) * 3600_000 }));
  const out = formatStopped(cs, { now: NOW, folderOf: (c) => (c.sessionId === 's0' ? 'teleport' : '') }).split('\n');
  assert.equal(out.length, 21);
  assert.equal(out[0], '💤 🪼 Sứa #a1000000 · teleport · 1 giờ trước');
  assert.equal(out[1], '💤 🪼 Sứa #a1000001 · 2 giờ trước', 'no folder → that part is dropped');
  assert.equal(out[20], '… và 3 agent cũ hơn (tối đa 30 ngày)');
  const last = formatStopped(cs.slice(20), { now: NOW, folderOf: () => '' }).split('\n');
  assert.equal(last[2], '💤 #a1000022 · 23 giờ trước', 'no persona → just the hashtag');
  assert.equal(formatStopped([], { now: NOW }), '(không có agent nào tắt trong 30 ngày qua)');
});

test('formatStopped: a session a live claude holds for SURE is hidden; a merely GUESSED one stays, flagged; a failed process read warns (and is not the same as an empty list)', () => {
  const cs = [{ ...SUA, mtimeMs: NOW - 60_000 }, { ...CAO, mtimeMs: NOW - 120_000 }];
  const fo = () => '';
  assert.equal(formatStopped(cs, { liveRows: [{ sessionId: 'u-sua', guessed: false }], now: NOW, folderOf: fo }), '💤 🦊 Cáo #b2222780 · 2 phút trước');
  assert.match(formatStopped(cs, { liveRows: [{ sessionId: 'u-sua', guessed: true }], now: NOW, folderOf: fo }), /Sứa #f4451780 · 1 phút trước \(có thể đang chạy\?\)/);
  const w = formatStopped(cs, { procsError: 'ps failed', now: NOW, folderOf: fo });
  assert.match(w, /^⚠️ không đọc được danh sách process — danh sách dưới có thể lẫn agent đang chạy\n💤/);
  const e = formatStopped([], { procsError: 'ps failed', now: NOW });
  assert.match(e, /⚠️/); assert.match(e, /không có agent nào tắt/);
  assert.doesNotMatch(formatStopped([], { now: NOW }), /⚠️/);
});

test('runMain: --list-stopped (the ONLY argument) lists and never resumes; with anything else it is just a (failing) query', async () => {
  const logs = []; let performed = 0;
  const d = { log: (m) => logs.push(m), listCandidates: () => [{ ...SUA, mtimeMs: Date.now() - 60_000, file: null }], listClaudeProcs: () => [], performResume: async () => { performed++; return { error: 'x' }; }, personaOf: () => null, callerIsOwner: false };
  assert.equal(await runMain(['--list-stopped'], d), 0);
  assert.match(logs[0], /💤 🪼 Sứa #f4451780/);
  assert.equal(performed, 0);
  assert.equal(await runMain(['--list-stopped', 'x'], d), 1);
  assert.match(logs.at(-1), /^❌/);
  assert.equal(performed, 0);
  assert.equal(await runMain(['--list-stopped', '--', '--model', 'x'], d), 1, 'a query with forwarded flags is not list mode');
  assert.equal(performed, 0);
  // an unreadable process list degrades to a warning in list mode …
  const bad = { ...d, listClaudeProcs: () => { throw new Error('ps down'); } };
  assert.equal(await runMain(['--list-stopped'], bad), 0);
  assert.match(logs.at(-1), /⚠️ +không đọc được danh sách process/);
  // … but resuming blind is refused
  assert.equal(await runMain(['780'], bad), 1);
  assert.match(logs.at(-1), /not resuming blind/);
  assert.equal(performed, 0);
});

test('runMain: tail → performResume with the right session, flags forwarded; refusal → exit 1', async () => {
  const logs = []; const calls = [];
  const d = { log: (m) => logs.push(m), listCandidates: () => [{ ...SUA, mtimeMs: 5 }], listClaudeProcs: () => [], personaOf: () => null, callerIsOwner: true,
    resolveCwd: () => ({ cwd: '/ws/teleport' }), performResume: async (o) => { calls.push(o); return { plan: { sessionName: 'tele-f4451780', extraArgs: o.extraArgs ?? [] } }; } };
  assert.equal(await runMain(['780', '--', '--model', 'opus'], d), 0);
  assert.equal(calls[0].sessionId, 'u-sua'); assert.deepEqual(calls[0].extraArgs, ['--model', 'opus']); assert.equal(calls[0].setBy, 'owner');
  assert.match(logs.at(-1), /🔁 resumed 🪼 Sứa #f4451780/);
  assert.equal(await runMain(['780', '--', '--bogus'], d), 1);
  assert.equal(calls.length, 1, 'a rejected flag resumes nothing');
  assert.equal(await runMain(['999'], d), 1);
  assert.equal(calls.length, 1);
});

test('findResumeTarget: a confirmed live session is ONE entry in the tail ambiguity list (candidate + live row coalesced, PID kept); a guessed row stays separate', () => {
  const live = { pid: 77, hashtag: 'f4451780', sessionId: 'u-sua', persona: '🪼 Sứa', screen: 'tele-f4451780' };
  const e = findResumeTarget('780', [SUA, CAO], { aliveSessions: new Set(['u-sua']), liveRows: [live] }).error;
  assert.equal((e.match(/#f4451780/g) || []).length, 1, e);
  assert.match(e, /Sứa #f4451780 — đang chạy, PID 77/);
  const g = findResumeTarget('780', [SUA, CAO], { aliveSessions: new Set(), liveRows: [{ ...live, guessed: true }] }).error;
  assert.equal((g.match(/#f4451780/g) || []).length, 2, 'guessed rows are not merged');
});
