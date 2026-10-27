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

test('formatAgentList: status + mailbox lines in the block of agents with a convo only; a throw → omitted', () => {
  const SID = '848e5ded-a905-4b49-8448-12ed50f4a7dc';
  const SID_T = '971e709e-2629-4d22-9943-40a52ee04a6b';
  const cScreen = uuidToConvoInt(SID);
  const cTerm = uuidToConvoInt(SID_T);
  const procs = [
    { pid: 1, etime: '1:00', cwd: '/w/a', screen: `tele-${shortConvoHash(cScreen)}`, sessionId: SID, hashtag: shortConvoHash(cScreen) },
    { pid: 2, etime: '1:00', cwd: '/w/b', screen: null, sessionId: SID_T, hashtag: shortConvoHash(cTerm) },
    { pid: 3, etime: '1:00', cwd: '/w/c', screen: null, sessionId: null },
    { pid: 4, etime: '1:00', cwd: '/w/d', screen: 'tele-e5424020', sessionId: null },
  ];
  const seen = [];
  const out = formatAgentList({
    procs, home: '/h', showSession: false,
    statusLinesOf: (c) => { seen.push(c); return [`🎧 S${c}`]; },
    mailOf: (c) => (c === cTerm ? 2 : 0),
    convoOfHashtag: (h) => (h === 'e5424020' ? 4242 : null),
  });
  assert.match(out, new RegExp(`⏱️ Uptime: 1:00\\n🎧 S${cScreen}\\n\\n`));
  assert.match(out, new RegExp(`📁 Folder: b\\n⏱️ Uptime: 1:00\\n🎧 S${cTerm}\\n📬 Mailbox: 2 thư chưa đọc`));
  assert.match(out, /🖥 PID 3\n🔢 PID: 3\n📁 Folder: c\n⏱️ Uptime: 1:00(\n\n|$)/); // no convo → nothing extra
  assert.match(out, /🎧 S4242/, 'a tele-* screen without a session falls back to the topics store');
  assert.deepEqual(seen.sort(), [4242, cScreen, cTerm].sort());
});

test('statusOf.lines: one labelled line per signal (the /ls blocks); same signals as statusOf', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-lines-'));
  fs.writeFileSync(path.join(dir, 'prompt-convo-7.json'), JSON.stringify({ messages: [{ text: 'a' }] }));
  fs.writeFileSync(path.join(dir, 'prompt-convo-7.processing.json'), '{}');
  const st = createListenerStatus({ tmpDir: dir, registryFile: path.join(dir, 'none.jsonl'), cacheFile: null, topics: {}, isLive: () => false });
  const lines = st.lines(7);
  assert.equal(lines[0], '🔇 Listener: tắt');
  assert.match(lines.join('\n'), /🔇 Listener: tắt\n📥 Hàng đợi: .*chờ agent nhận \(\d+ giây\)\n⏳ Đang xử lý: \d+ giây/);
  assert.match(st(7), /^🔇 listener tắt · 📥 .*chờ agent nhận .* · ⏳ đang xử lý /);
  assert.deepEqual(st.lines(0), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('newestUnreadAt: newest unread topic message (its date) or queued prompt (mtime); nothing → null', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, `convo-${CONVO}-offset.txt`), '10');
  const cacheFile = writeCache(dir, [msg(9, { date: sec(5) }), msg(10, { date: sec(300) }), msg(11, { date: sec(100) }), msg(12, { chat: OTHER_CHAT, date: sec(1) })]);
  const st = status(dir, { cacheFile });
  assert.equal(st.newestUnreadAt(CONVO), sec(100) * 1000, 'id 9 is read (below offset), other chat excluded');
  const p = path.join(dir, `prompt-convo-${CONVO}.json`);
  fs.writeFileSync(p, '{}');
  fs.utimesSync(p, new Date(NOW - 20_000), new Date(NOW - 20_000));
  assert.equal(st.newestUnreadAt(CONVO), NOW - 20_000, 'a queued prompt counts');
  assert.equal(status(tmp()).newestUnreadAt(CONVO), null);
  assert.equal(st.newestUnreadAt('garbage'), null);
});
