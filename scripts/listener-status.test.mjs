import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createListenerStatus, formatAge, resolveCacheFile } from './listener-status.mjs';
import { getProcessStartTime, isLiveEntry } from './tele-listen.mjs';
import { formatAgentList } from './claude-procs.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';
import { shortConvoHash } from './convo-hash.mjs';

const CHAT = '-1001';
const OTHER_CHAT = '-1002';
const CONVO = 2331951937261652;
const THREAD = 77;
const NOW = 1_800_000_000_000;
const sec = (agoS) => Math.floor((NOW - agoS * 1000) / 1000);

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ls-status-')); }
const topics = { [CHAT]: { [String(CONVO)]: THREAD, _is_forum: true } };
const msg = (id, { chat = CHAT, thread = THREAD, text = 'hi', date = sec(60), extra = {} } = {}) => ({
  update_id: id,
  message: { message_id: id + 1000, chat: { id: Number(chat) }, message_thread_id: thread, date, text, ...extra },
});

function writeCache(dir, updates, name = 'updates-cache.42.jsonl') {
  const f = path.join(dir, name);
  fs.writeFileSync(f, updates.map((u) => JSON.stringify(u)).join('\n') + '\n');
  return f;
}
function writeRegistry(dir, rows) {
  const f = path.join(dir, 'listener-registry.jsonl');
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const status = (dir, opts = {}) => createListenerStatus({
  tmpDir: dir, topics, cacheFile: null, isLive: () => false, now: NOW, botId: null, ...opts,
});

test('listener alive vs dead (injected liveness), only rows of THIS convo count', () => {
  const dir = tmp();
  writeRegistry(dir, [
    { pid: 500, convoId: 999, startTime: 'proc:1' },     // other convo, alive
    { pid: 501, convoId: CONVO, startTime: 'proc:old' }, // this convo, pid reused
  ]);
  const live = new Map([[500, 'proc:1'], [501, 'proc:new']]);
  const isLive = (e) => live.get(e.pid) === e.startTime;
  assert.equal(status(dir, { isLive })(CONVO), '🔇 listener tắt');
  live.set(501, 'proc:old');
  assert.equal(status(dir, { isLive })(CONVO), '🎧 đang nghe');
  assert.equal(status(dir, { isLive })(String(CONVO)), '🎧 đang nghe'); // string convo id too
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listener liveness uses the real isLiveEntry: own pid alive, mismatched start identity → dead', () => {
  const dir = tmp();
  const me = getProcessStartTime(process.pid);
  assert.ok(me, 'start identity of this process');
  writeRegistry(dir, [{ pid: process.pid, convoId: CONVO, startTime: me }]);
  assert.equal(status(dir, { isLive: isLiveEntry })(CONVO), '🎧 đang nghe');
  writeRegistry(dir, [{ pid: process.pid, convoId: CONVO, startTime: `${me}x` }]); // pid reused
  assert.equal(status(dir, { isLive: isLiveEntry })(CONVO), '🔇 listener tắt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unread: offset boundary is >=, /dm, service, other topic and other chat excluded; oldest age', () => {
  const dir = tmp();
  const cache = writeCache(dir, [
    msg(10, { date: sec(3600) }),                          // already read (< offset)
    msg(11, { date: sec(420) }),                           // == offset → unread (boundary)
    msg(12, { text: '/dm status' }),                       // daemon control
    msg(13, { thread: 88 }),                               // other topic
    msg(14, { chat: OTHER_CHAT }),                         // other chat, same thread id
    msg(15, { text: null, extra: { forum_topic_created: { name: 'x' } } }), // service
    msg(16, { date: sec(60) }),
    msg(16, { date: sec(60) }),                            // duplicate append → counted once
  ]);
  fs.writeFileSync(path.join(dir, `convo-${CONVO}-offset.txt`), '11\n');
  assert.equal(status(dir, { cacheFile: cache })(CONVO), '🔇 listener tắt · 📨 2 tin chưa đọc (cũ nhất 7 phút)');
  // Resolved from botId: ONLY that bot's file — another bot's cache and the
  // legacy cache (update_id sequences are per bot) never leak into the count.
  writeCache(dir, [msg(20, { date: sec(900) }), msg(21)], 'updates-cache.43.jsonl');
  writeCache(dir, [msg(22, { date: sec(900) })], 'updates-cache.jsonl');
  assert.equal(status(dir, { cacheFile: undefined, botId: 42 })(CONVO), '🔇 listener tắt · 📨 2 tin chưa đọc (cũ nhất 7 phút)');
  assert.equal(status(dir, { cacheFile: undefined, botId: 43 })(CONVO), '🔇 listener tắt · 📨 2 tin chưa đọc (cũ nhất 15 phút)');
  // Known bot whose file is missing → no unread shown (no fallback to others).
  assert.equal(status(dir, { cacheFile: undefined, botId: 99 })(CONVO), '🔇 listener tắt');
  // No bot id at all → legacy single cache only.
  assert.equal(status(dir, { cacheFile: undefined, botId: null })(CONVO), '🔇 listener tắt · 📨 1 tin chưa đọc (cũ nhất 15 phút)');
  fs.writeFileSync(path.join(dir, `convo-${CONVO}-offset.txt`), '12\n');
  assert.equal(status(dir, { cacheFile: cache })(CONVO), '🔇 listener tắt · 📨 1 tin chưa đọc (cũ nhất 1 phút)');
  fs.writeFileSync(path.join(dir, `convo-${CONVO}-offset.txt`), '17\n');
  assert.equal(status(dir, { cacheFile: cache })(CONVO), '🔇 listener tắt');
  // No offset file (never listened) → no unread claim; no topic → none either.
  fs.rmSync(path.join(dir, `convo-${CONVO}-offset.txt`));
  assert.equal(status(dir, { cacheFile: cache })(CONVO), '🔇 listener tắt');
  fs.writeFileSync(path.join(dir, `convo-${CONVO}-offset.txt`), '11\n');
  assert.equal(status(dir, { cacheFile: cache, topics: {} })(CONVO), '🔇 listener tắt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('open prompt (pending) and processing batch are shown with their age', () => {
  const dir = tmp();
  const prompt = path.join(dir, `prompt-convo-${CONVO}.json`);
  const proc = path.join(dir, `prompt-convo-${CONVO}.processing.json`);
  fs.writeFileSync(prompt, JSON.stringify({ messages: [{ text: 'a' }, { text: 'b' }] }));
  fs.writeFileSync(proc, '{}');
  fs.utimesSync(prompt, new Date(NOW - 30_000), new Date(NOW - 30_000));
  fs.utimesSync(proc, new Date(NOW - 125_000), new Date(NOW - 125_000));
  assert.equal(status(dir)(CONVO), '🔇 listener tắt · 📥 2 tin chờ agent nhận (30 giây) · ⏳ đang xử lý 2 phút');
  fs.writeFileSync(prompt, 'not json{');
  fs.utimesSync(prompt, new Date(NOW - 30_000), new Date(NOW - 30_000));
  assert.match(status(dir)(CONVO), /📥 chờ agent nhận \(30 giây\)/); // unreadable → still pending, no count
  fs.rmSync(dir, { recursive: true, force: true });
});

test('errors never throw: missing dir, garbage files, throwing liveness, bad convo id', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'listener-registry.jsonl'), 'garbage\n{"pid":1,"convoId":' + CONVO + '}\n');
  const cache = writeCache(dir, ['nope'].map(() => ({})));
  fs.appendFileSync(cache, '{torn');
  fs.writeFileSync(path.join(dir, `convo-${CONVO}-offset.txt`), 'xx');
  const st = status(dir, { cacheFile: cache, isLive: () => { throw new Error('boom'); } });
  assert.equal(st(CONVO), '🔇 listener tắt');
  fs.writeFileSync(path.join(dir, `convo-${CONVO}-offset.txt`), '1');
  assert.equal(status(dir, { cacheFile: path.join(dir, 'missing.jsonl') })(CONVO), '🔇 listener tắt');
  assert.equal(st(null), null);
  assert.equal(st('abc'), null);
  const gone = createListenerStatus({ tmpDir: path.join(dir, 'nope'), topics: null, now: NOW, botId: null });
  assert.equal(gone(CONVO), '🔇 listener tắt'); // no registry → nobody listening
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveCacheFile: known bot → its own file only (missing → null); no bot → legacy file; never another bot', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'updates-cache.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'updates-cache.7.jsonl'), '');
  assert.equal(resolveCacheFile({ tmpDir: dir, botId: 7 }), path.join(dir, 'updates-cache.7.jsonl'));
  assert.equal(resolveCacheFile({ tmpDir: dir, botId: 8 }), null); // not bot 7's, not legacy
  assert.equal(resolveCacheFile({ tmpDir: dir, botId: null }), path.join(dir, 'updates-cache.jsonl'));
  assert.equal(resolveCacheFile({ tmpDir: dir }), path.join(dir, 'updates-cache.jsonl'));
  fs.rmSync(path.join(dir, 'updates-cache.jsonl'));
  assert.equal(resolveCacheFile({ tmpDir: dir, botId: null }), null); // no fallback to bot 7
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatAge', () => {
  assert.equal(formatAge(5_000), '5 giây');
  assert.equal(formatAge(7 * 60_000 + 59_000), '7 phút');
  assert.equal(formatAge(2 * 3600_000), '2 giờ');
  assert.equal(formatAge(3 * 86400_000), '3 ngày');
  assert.equal(formatAge(-1), '0 giây');
});

test('formatAgentList: status line under agents with a convo only; throwing statusOf → omitted', () => {
  const SID = '848e5ded-a905-4b49-8448-12ed50f4a7dc';
  const SID_T = '971e709e-2629-4d22-9943-40a52ee04a6b';
  const cScreen = uuidToConvoInt(SID);
  const cTerm = uuidToConvoInt(SID_T);
  const procs = [
    { pid: 1, etime: '1:00', cwd: '/w/a', screen: `tele-${shortConvoHash(cScreen)}`, sessionId: SID, hashtag: shortConvoHash(cScreen) },
    { pid: 2, etime: '1:00', cwd: '/w/b', screen: null, sessionId: SID_T, hashtag: shortConvoHash(cTerm) },
    { pid: 3, etime: '1:00', cwd: '/w/c', screen: null, sessionId: null },
  ];
  const seen = [];
  const out = formatAgentList({
    screens: [{ name: 'tele-e5424020' }], procs, home: '/h',
    statusOf: (c) => { seen.push(c); return c === 4242 ? null : `S${c}`; },
    convoOfHashtag: (h) => (h === 'e5424020' ? 4242 : null),
  });
  assert.match(out, new RegExp(`• tele-${shortConvoHash(cScreen)}\\n  PID 1 · a · 1:00\\n  session ${SID} · #\\w+\\n  S${cScreen}\\n`));
  assert.match(out, new RegExp(`• PID 2 · b · 1:00\\n  session ${SID_T} · #\\w+\\n  S${cTerm}\\n`));
  assert.match(out, /• PID 3 · c · 1:00\n  session \?\n\n/); // no convo → nothing extra
  assert.match(out, /• tele-e5424020 · \(không thấy claude bên trong\)\n  ─+\n•/); // status null → no line (next is the separator)
  assert.deepEqual(seen.sort(), [4242, cScreen, cTerm].sort());
  const safe = formatAgentList({ procs, statusOf: () => { throw new Error('x'); }, convoOfHashtag: () => { throw new Error('y'); } });
  assert.doesNotMatch(safe, /S\d/);
  assert.match(safe, /PID 2/);
});
