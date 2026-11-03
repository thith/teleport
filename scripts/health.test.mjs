import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMeminfo, parseDf, topMemory, countOomKills, formatHealth, parsePressure, formatLocksShort, formatInEffect, gatherLocal } from './health.mjs';

const GB = 1024 ** 3;

test('parsers: meminfo, df, ps aggregation, oom lines', () => {
  assert.deepEqual(parseMeminfo('MemTotal:       16000000 kB\nMemAvailable:    6000000 kB\nSwapTotal:       2000000 kB\nSwapFree:          10000 kB\n'),
    { total: 16000000 * 1024, available: 6000000 * 1024, swapTotal: 2000000 * 1024, swapFree: 10000 * 1024 });
  assert.deepEqual(parseDf('     1B-blocks        Avail Mounted on\n490000000000 125000000000 /\n'), { size: 490000000000, avail: 125000000000, target: '/' });
  assert.equal(parseDf('h\n1 2 /media/USB Drive\n').target, '/media/USB Drive');
  assert.equal(parseDf('garbage'), null);
  assert.equal(topMemory('Web Content 2048\n', 1)[0].name, 'Web Content');
  assert.deepEqual(topMemory('claude 100000\nclaude 200000\nnode 50000\njava 4000000\nbad line x\n', 2), [{ name: 'java', mb: 3906, count: 1 }, { name: 'claude', mb: 293, count: 2 }]);
  assert.equal(countOomKills('a\nfoo: systemd-oomd killed 233 process(es) in this unit.\nbar: A process of this unit has been killed by the OOM killer.\nok\n'), 2);
});

test('formatHealth (RFC 32 §4.5): calm = no ⚠️ line and no RAM top; warnings join into ONE line; RAM > 80% shows the top', () => {
  const base = {
    cores: 12, load: [4, 5, 7],
    mem: { total: 16 * GB, available: 6 * GB, swapTotal: 2 * GB, swapFree: 1 * GB },
    disk: { size: 500 * GB, avail: 120 * GB, target: '/' },
    top: [{ name: 'postgres', mb: 5120, count: 74 }, { name: 'node', mb: 700, count: 1 }],
    oomKills: 0,
  };
  const ok = formatHealth(base);
  assert.equal(ok, '🩺 Máy\n💻 load 4.0/12 · 🧠 RAM 10/16 GB · 💾 đĩa trống 120 GB\n\n/cswap   /q   /ls');
  assert.doesNotMatch(ok, /⚠️|🐘|Không có cảnh báo|Agent claude/);
  const bad = formatHealth({ ...base, load: [14, 9, 8], mem: { total: 16 * GB, available: 1 * GB, swapTotal: 8 * GB, swapFree: 0 }, disk: { size: 500 * GB, avail: 20 * GB, target: '/' }, oomKills: 3 });
  const warnLines = bad.split('\n').filter((l) => l.startsWith('⚠️'));
  assert.equal(warnLines.length, 1, 'one line');
  for (const w of [/CPU quá tải/, /RAM sắp hết/, /Swap đầy 8\/8 GB/, /đĩa sắp đầy \(còn 4%\)/, /3 lần OOM-kill/]) assert.match(warnLines[0], w);
  assert.match(bad, /\n🐘 postgres×74 5\.0G · node 700M\n/, 'RAM tight → top users in one line');
  assert.match(bad, /\n\n\/cswap {3}\/q {3}\/ls$/);
  const hot = formatHealth({ ...base, mem: { total: 16 * GB, available: 2.5 * GB, swapTotal: 2 * GB, swapFree: 2 * GB } });
  assert.match(hot, /🐘 postgres×74/, 'used > 80% shows the top even without a warning');
  assert.doesNotMatch(hot, /⚠️/);
  assert.equal(formatHealth({ cores: 4, load: null, mem: null, disk: null, top: null, oomKills: 0 }), '🩺 Máy\n\n/cswap   /q   /ls', 'missing sources just drop pieces');
});

test('formatHealth: approved mock — machine line, ⚠️ line, locks, ⚙️ Đang áp dụng', () => {
  const now = 100 * 60_000;
  const locks = formatLocksShort({ build: { N: 2, holders: [{ label: '🤖 Robot 2 #aaaa1111', startedAt: now - 4 * 60_000 }, { label: '🧚 Tiên', startedAt: now - 60_000 }], waiting: 0 }, merge: { holders: [], waiting: 0 }, cleanup: { holders: [], waiting: 0 } }, { now });
  const inEffect = formatInEffect({
    build: { slots: 2, forced: false, gateNote: '' },
    quiet: { enabled: true, active: false, overridden: false, from: '23:30', to: '06:00', cpuPercent: 25, maxBuilds: 1, until: now },
    policy: { max: null, paused: false, blocks: [], boosts: 0 }, automerge: { enabled: true, patterns: 3 },
  });
  const text = formatHealth({
    cores: 12, load: [11.5, 9, 8], mem: { total: 31 * GB, available: 21 * GB, swapTotal: 8 * GB, swapFree: 0 }, disk: { size: 500 * GB, avail: 138 * GB, target: '/' },
    psi: { io: { some: { avg10: 40, avg60: 1, avg300: 1 }, full: { avg10: 30, avg60: 1, avg300: 1 } } }, locks, inEffect,
  });
  assert.equal(text, [
    '🩺 Máy',
    '💻 load 11.5/12 · 🧠 RAM 10/31 GB · 💾 đĩa trống 138 GB',
    '⚠️ Swap đầy 8/8 GB · đĩa nghẽn 30% thời gian',
    "🔒 build 2/2: ▶ 🤖 Robot 2 (4') · ▶ 🧚 Tiên (1') · chờ 0",
    '',
    '⚙️ Đang áp dụng',
    '• Build: 2 chỗ, tự động theo RAM; chỗ thứ 2 chỉ cấp khi CPU rảnh',
    '• 🌙 Giờ im lặng 23:30–06:00: build ≤ 25% CPU, chỉ nhận build mới khi không còn build nào (bây giờ: chưa tới giờ)',
    '• Hàng /q: không giới hạn, không tạm dừng, không chặn ai',
    '• Automerge: bật (3 mẫu repo)',
    '',
    '/cswap   /q   /ls',
  ].join('\n'));
});

test('formatLocksShort: build always one line; merge / cleanup only when held or waited for; unreadable → ?', () => {
  const now = 10 * 60_000;
  assert.deepEqual(formatLocksShort({ build: { N: 2, holders: [], waiting: 0 }, merge: { holders: [], waiting: 0 }, cleanup: { holders: [], waiting: 0 } }, { now }), ['🔒 build 0/2: trống · chờ 0']);
  const l = formatLocksShort({ build: { N: 1, holders: [{ label: 'Ma', startedAt: 0 }], waiting: 2 }, merge: { holders: [{ label: '🦊 Cáo #ab12', startedAt: now - 120_000 }], waiting: 1 }, cleanup: { holders: [], waiting: 3 } }, { now });
  assert.deepEqual(l, ["🔒 build 1/1: ▶ Ma (10') · chờ 2", "🔒 merge: ▶ 🦊 Cáo (2') · chờ 1", '🔒 cleanup: chờ 3']);
  assert.deepEqual(formatLocksShort({ build: null }, { now }), ['🔒 build: ?']);
  assert.deepEqual(formatLocksShort({ build: { N: 1, holders: [{ label: 'cleanup', startedAt: now, exclusive: true }], waiting: 0 } }, { now }), ["🔒 build 1/1: ▶ cleanup (0') [giữ cả lock] · chờ 0"]);
});

test('formatInEffect: every state of every line; unreadable → ?', () => {
  const q = { enabled: true, from: '23:30', to: '06:00', cpuPercent: 25, maxBuilds: 1 };
  const until = new Date(2026, 10, 4, 6, 0).getTime();
  const get = (o, i) => formatInEffect(o)[i];
  assert.equal(get({ build: { slots: 1, forced: true } }, 0), '• Build: 1 chỗ, đặt tay = 1 (lock-queue slots 1)');
  assert.equal(get({ build: { slots: 1, forced: false } }, 0), '• Build: 1 chỗ, tự động theo RAM');
  assert.equal(get({ build: { slots: 2, forced: false, gateNote: 'chờ CPU (load 11.2/12)' } }, 0), '• Build: 2 chỗ, tự động theo RAM; chỗ thứ 2 chỉ cấp khi CPU rảnh · chỗ thứ 2: chờ CPU (load 11.2/12)');
  assert.match(get({ quiet: { ...q, active: true, overridden: false, until } }, 1), /\(bây giờ: đang áp tới 06:00\) — bấm \/q để tắt tạm$/);
  assert.match(get({ quiet: { ...q, active: true, overridden: true, until } }, 1), /\(bây giờ: TẮT TẠM tới 06:00\)$/);
  assert.match(get({ quiet: { ...q, active: false, overridden: false } }, 1), /\(bây giờ: chưa tới giờ\)$/);
  assert.match(get({ quiet: { ...q, maxBuilds: 2, active: false } }, 1), /tối đa 2 build/);
  assert.equal(get({ quiet: { enabled: false } }, 1), '• 🌙 Giờ im lặng: tắt');
  assert.equal(get({ quiet: { enabled: false, error: 'x' } }, 1), '• 🌙 Giờ im lặng: tắt (cấu hình hỏng: x)');
  const until2 = new Date(2026, 10, 3, 15, 30).getTime();
  assert.equal(get({ policy: { max: 3, paused: true, blocks: [{ label: '🦊 Cáo', until: until2 }], boosts: 2 } }, 2), '• Hàng /q: max 3, ⏸ tạm dừng, chặn: 🦊 Cáo tới 15:30, ⬆ ưu tiên: 2 vé');
  assert.equal(get({ policy: { max: null, paused: false, blocks: [], boosts: 0 } }, 2), '• Hàng /q: không giới hạn, không tạm dừng, không chặn ai');
  assert.equal(get({ automerge: { enabled: false, patterns: 0 } }, 3), '• Automerge: tắt');
  assert.equal(get({ automerge: { enabled: false, patterns: 2 } }, 3), '• Automerge: tắt (2 mẫu repo)');
  assert.deepEqual(formatInEffect({}), ['• Build: ?', '• 🌙 Giờ im lặng: ?', '• Hàng /q: ?', '• Automerge: ?']);
});

test('gatherLocal: reads buildQuietHours (not quietHours), counts automerge patterns once, a read error prints ?', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-health-'));
  const cfg = { _config: { quietHours: { start: '01:00', end: '02:00' }, buildQuietHours: { from: '23:30', to: '06:00' }, autoMergeRepos: ['a/b', 'A/B', 'c/*'] } };
  const g = gatherLocal({ dir, now: new Date(2026, 10, 3, 12, 0).getTime(), readProjects: () => cfg, supported: () => true, pruneLines: () => [] });
  const text = g.inEffect.join('\n');
  assert.match(text, /Giờ im lặng 23:30–06:00: build ≤ 25% CPU/);
  assert.match(text, /Automerge: (bật|tắt) \(\d+ mẫu repo\)/);
  assert.deepEqual(g.extraWarn, []);
  const broken = gatherLocal({ dir, readProjects: () => { throw new Error('EACCES'); }, pruneLines: () => [] });
  assert.match(broken.inEffect.join('\n'), /Giờ im lặng: \?/);
  assert.match(broken.inEffect.join('\n'), /Automerge: \?/);
  assert.match(broken.inEffect.join('\n'), /Hàng \/q: không giới hạn/, 'the other lines are unaffected');
  // quiet configured but no cgroup cpu → a warning; a holder running outside its scope → a warning (pending / exclusive ones are not counted)
  fs.writeFileSync(path.join(dir, 'build.holder.json'), JSON.stringify({ pid: process.pid, label: 'A', startedAt: Date.now(), scoped: false }));
  const w = gatherLocal({ dir, readProjects: () => cfg, supported: () => false, pruneLines: () => ['⚠️ cargo cache chưa prune được 5 lần'] });
  assert.ok(w.extraWarn.some((x) => /không giới hạn được CPU/.test(x)));
  assert.ok(w.extraWarn.some((x) => /^1 build đang chạy ngoài scope/.test(x)));
  assert.ok(w.extraWarn.includes('cargo cache chưa prune được 5 lần'));
  assert.equal(w.locks[0].startsWith('🔒 build'), true);
  const bad = gatherLocal({ dir, readProjects: () => ({ _config: { buildQuietHours: { from: 'x', to: 'y' } } }), supported: () => true, pruneLines: () => [] });
  assert.ok(bad.extraWarn.some((x) => /cấu hình hỏng/.test(x)));
  assert.match(bad.inEffect.join('\n'), /Giờ im lặng: tắt \(cấu hình hỏng/);
});

test('PSI: parse /proc/pressure; warn on what tasks actually wait for, not raw load', () => {
  const io = parsePressure('some avg10=71.77 avg60=71.27 avg300=55.75 total=344279498\nfull avg10=66.88 avg60=67.09 avg300=52.48 total=321719232\n');
  assert.deepEqual(io, { some: { avg10: 71.77, avg60: 71.27, avg300: 55.75 }, full: { avg10: 66.88, avg60: 67.09, avg300: 52.48 } });
  const cpuIdle = parsePressure('some avg10=0.00 avg60=0.00 avg300=1.15 total=57760764\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
  assert.equal(parsePressure('garbage'), null);
  assert.equal(parsePressure(null), null);
  // The real case: load 17.6 on 12 cores, but nothing waits for CPU — the disk is the jam. No CPU %, just load/cores.
  const jam = formatHealth({ cores: 12, load: [17.64, 13.26, 7.46], psi: { cpu: cpuIdle, io } });
  assert.match(jam, /💻 load 17\.6\/12/);
  assert.doesNotMatch(jam, /%\)|~\d+%/);
  assert.match(jam, /⚠️ đĩa nghẽn 67% thời gian/);
  assert.doesNotMatch(jam, /CPU quá tải/);
  // Real CPU shortage: PSI cpu high → CPU warning.
  const busy = formatHealth({ cores: 12, load: [20, 18, 15], psi: { cpu: { some: { avg10: 80, avg60: 70, avg300: 60 }, full: null }, io: { some: io.some, full: { avg10: 5, avg60: 4, avg300: 3 } } } });
  assert.match(busy, /CPU quá tải \(80% thời gian chờ CPU\)/);
  assert.doesNotMatch(formatHealth({ cores: 12, load: [6, 6, 6], psi: { cpu: { some: { avg10: 60, avg60: 50, avg300: 40 }, full: null }, io: null } }), /load 6\.0 > 12/);
  assert.doesNotMatch(busy, /đĩa nghẽn/);
  // Calm: no warning line at all.
  assert.doesNotMatch(formatHealth({ cores: 12, load: [2, 2, 2], psi: { cpu: cpuIdle, io: { some: io.some, full: { avg10: 3, avg60: 2, avg300: 1 } } } }), /⚠️/);
  // No PSI (old kernel / not Linux): fall back to load > cores.
  assert.match(formatHealth({ cores: 12, load: [14, 9, 8] }), /CPU quá tải \(load 14\.0 > 12 nhân\)/);
});

test('memoryAlert: below threshold and outside the repeat window only', async () => {
  const { memoryAlert } = await import('./health.mjs');
  const low = { total: 16 * GB, available: 1.5 * GB, swapTotal: 2 * GB, swapFree: 0 };
  const a = memoryAlert({ mem: low, top: [{ name: 'java', mb: 4200, count: 2 }], now: 10_000_000, lastAlertAt: 0 });
  assert.equal(a.alert, true);
  assert.match(a.text, /RAM sắp hết: còn 1\.5 GB \/ 16\.0 GB \(9%\) · swap 2\.0 GB \/ 2\.0 GB[\s\S]*java ×2 4\.1 GB[\s\S]*\/kill <tên>/);
  assert.equal(memoryAlert({ mem: low, now: 10_000_000, lastAlertAt: 10_000_000 - 60_000 }).alert, false, 'rate-limited');
  assert.equal(memoryAlert({ mem: { ...low, available: 8 * GB }, now: 10_000_000 }).alert, false, 'plenty of RAM');
  assert.equal(memoryAlert({ mem: null, now: 1 }).alert, false);
});

test('agentDeaths / deathText / oomVictim: per-agent OOM evidence, owner kills skipped, unknown cause otherwise', async () => {
  const { agentDeaths, deathText, oomVictim } = await import('./health.mjs');
  const a = { pid: 1, procStart: '10', name: '🧚 Tiên', hashtag: 'j8436116' };
  const b = { pid: 2, procStart: '20', name: '👻 Ma', hashtag: 'c2383556' };
  const c = { pid: 3, procStart: '30', name: 'Sói', hashtag: 'd7261652' };
  assert.deepEqual(agentDeaths([a, b], [a]), [b]);
  assert.deepEqual(agentDeaths([a], [{ ...a, procStart: '99' }]), [a], 'pid reused by another process = the old one died');
  const journal = 'kernel: Out of memory: Killed process 2 (claude) total-vm:1kB\nsystemd[1403]: run-rABC.scope: A process of this unit has been killed by the OOM killer.\n';
  assert.equal(oomVictim(b, journal), true, 'exact pid');
  assert.equal(oomVictim({ pid: 22 }, journal), false, 'pid 22 is not pid 2');
  assert.equal(oomVictim(c, journal, 'run-rABC.scope'), true, 'its own unit');
  assert.equal(oomVictim(c, journal, 'run-rXYZ.scope'), false);
  const t = deathText([a, b, c], { oomOf: (r) => r.pid === 2, killedByOwner: { pids: new Set([1]), hashtags: new Set() } });
  assert.doesNotMatch(t, /Tiên/, 'owner /kill pid is not news');
  assert.match(t, /💀 👻 Ma #c2383556 \(PID 2\) đã tắt — do HẾT RAM[\s\S]*\/resume #c2383556/);
  assert.match(t, /💀 Sói #d7261652 \(PID 3\) đã tắt \(không rõ lý do/, 'no OOM evidence → unknown, not blamed');
  assert.equal(deathText([c], { killedByOwner: { pids: new Set(), hashtags: new Set(['d7261652']) } }), '', 'owner screen kill (/kill <hashtag>) skipped');
});

test('machineWatch: records first, reports deaths once, keeps the snapshot on a failed listing, RAM alert throttled across restarts', async () => {
  const { machineWatch } = await import('./health.mjs');
  const sent = []; let state = {}; let disk = {};
  const a = { pid: 1, procStart: '1', name: 'A', hashtag: 'a1111111' }, b = { pid: 2, procStart: '2', name: 'B', hashtag: 'b2222222' };
  let agents = [a, b]; let mem = { total: 16 * GB, available: 8 * GB }; let topCalls = 0;
  const deps = {
    readMem: () => mem, listAgents: () => agents, top: async () => { topCalls++; return []; },
    journalSince: async () => 'Killed process 2 (claude)', recentKills: () => ({ pids: new Set(), hashtags: new Set() }),
    unit: () => null, persisted: { read: () => disk, write: (o) => { disk = o; } }, now: () => 100_000_000,
    statfs: () => ({ bsize: 4096, blocks: 1e8, bavail: 5e7 }), diskPersisted: { read: () => ({}), write: () => { throw new Error('no disk alert expected'); } },
  };
  const send = async (t) => sent.push(t);
  await machineWatch(state, send, deps);
  assert.equal(sent.length, 0);
  assert.equal(topCalls, 0, 'no ps for top memory while RAM is fine');
  await machineWatch(state, send, { ...deps, listAgents: () => { throw new Error('ps failed'); } });
  assert.equal(sent.length, 0, 'failed listing → no false deaths');
  agents = [a];
  await machineWatch(state, send, deps);
  assert.match(sent[0], /💀 B #b2222222.*HẾT RAM/);
  await machineWatch(state, send, deps);
  assert.equal(sent.length, 1, 'reported once');
  mem = { total: 16 * GB, available: 1 * GB };
  await machineWatch(state, send, deps);
  state = {}; // daemon restart: in-memory state lost, disk state kept
  await machineWatch(state, send, deps);
  assert.equal(sent.filter((t) => /RAM sắp hết/.test(t)).length, 1, 'one warning per window, even across a restart');
  assert.equal(topCalls, 1);
});

const dirent = (name, dir = true) => ({ name, isDirectory: () => dir });

test('diskLow / diskAlertDue: threshold by % and by GiB, throttled', async () => {
  const { diskLow, diskAlertDue, diskFromStatfs, diskAlertText } = await import('./health.mjs');
  assert.deepEqual(diskFromStatfs({ bsize: 4096, blocks: 1000, bavail: 250 }), { size: 4096000, avail: 1024000 });
  assert.equal(diskLow({ size: 500 * GB, avail: 120 * GB }), false, '24% and 120 GB → healthy');
  assert.equal(diskLow({ size: 1000 * GB, avail: 140 * GB }), true, '14% → low even with 140 GB');
  assert.equal(diskLow({ size: 1000 * GB, avail: 150 * GB }), false, 'exactly 15% / 150 GB → fine');
  assert.equal(diskLow({ size: 200 * GB, avail: 39 * GB }), true, '19.5% but 39 GB → low by GiB');
  assert.equal(diskLow({ size: 200 * GB, avail: 40 * GB }), false, '20% and 40 GB → fine');
  const low = { size: 500 * GB, avail: 30 * GB };
  assert.equal(diskAlertDue({ disk: low, now: 10_000_000, lastAlertAt: 0 }), true);
  assert.equal(diskAlertDue({ disk: low, now: 10_000_000, lastAlertAt: 10_000_000 - 29 * 60_000 }), false, 'within 30 min');
  assert.equal(diskAlertDue({ disk: low, now: 10_000_000, lastAlertAt: 10_000_000 - 30 * 60_000 }), true);
  assert.equal(diskAlertDue({ disk: null, now: 1 }), false);
  assert.match(diskAlertText(low), /^💾 Disk sắp đầy: còn 30\.0 GB \/ 500\.0 GB \(6%\)/);
  assert.match(formatHealth({ disk: { size: 200 * GB, avail: 39 * GB, target: '/' } }), /⚠️ đĩa sắp đầy \(còn 20%\)/, '/health warns on the same thresholds');
});

test('diskWatch: alerts once per window, throttle persisted in its own store across restarts, follow-up kicked once', async () => {
  const { diskWatch } = await import('./health.mjs');
  let store = {}; let clock = 50_000_000; let avail = 30; const sent = []; let followUps = 0;
  const deps = {
    statfs: () => ({ bsize: GB, blocks: 500, bavail: avail }),
    diskPersisted: { read: () => store, write: (o) => { store = o; } },
    followUp: () => { followUps++; }, now: () => clock,
  };
  const send = async (t) => sent.push(t);
  await diskWatch({}, send, deps);
  assert.equal(sent.length, 1); assert.match(sent[0], /Disk sắp đầy: còn 30\.0 GB/);
  assert.equal(store.lastDiskAlertAt, 50_000_000, 'throttle persisted');
  assert.equal(followUps, 1);
  clock += 10 * 60_000;
  await diskWatch({}, send, deps); // fresh in-memory state = daemon restart
  assert.equal(sent.length, 1, 'still throttled after a restart');
  clock += 21 * 60_000;
  await diskWatch({}, send, deps);
  assert.equal(sent.length, 2, 'repeats after 30 min');
  avail = 200; clock += 60 * 60_000;
  await diskWatch({}, send, deps);
  assert.equal(sent.length, 2, 'healthy → no alert');
  assert.equal(followUps, 2);
  await diskWatch({}, send, { ...deps, statfs: () => { throw new Error('EACCES'); } });
  assert.equal(sent.length, 2, 'statfs failure → silent');

  // full disk: the persisted write fails (ENOSPC) → the in-memory throttle still holds
  const full = {}; const sentFull = [];
  const fullDeps = { ...deps, statfs: () => ({ bsize: GB, blocks: 500, bavail: 0 }), diskPersisted: { read: () => ({}), write: () => { throw new Error('ENOSPC'); } } };
  await diskWatch(full, async (t) => sentFull.push(t), fullDeps);
  clock += 5 * 60_000;
  await diskWatch(full, async (t) => sentFull.push(t), fullDeps);
  assert.equal(sentFull.length, 1, 'no repeat DM within 30 min when the throttle cannot be persisted');
  clock += 26 * 60_000;
  await diskWatch(full, async (t) => sentFull.push(t), fullDeps);
  assert.equal(sentFull.length, 2, 'repeats after the window');
});

test('duTargets / duCommand: readdir-expanded dirs, no glob strings, nice+ionice with plain-du fallback', async () => {
  const { duTargets, duCommand } = await import('./health.mjs');
  const tree = {
    '/h/Projects': [dirent('teleport'), dirent('umipay'), dirent('notes.txt', false)],
    '/h/.cache/teleport': [dirent('cargo-target')],
    '/t': [dirent('claude-1000'), dirent('other'), dirent('claude-x', false)],
  };
  const dirs = duTargets({ home: '/h', tmp: '/t', readdir: (d) => { if (!tree[d]) throw new Error('ENOENT'); return tree[d]; } });
  assert.deepEqual(dirs, ['/h/Projects/teleport', '/h/Projects/umipay', '/h/.cache/teleport/cargo-target', '/t/claude-1000']);
  assert.deepEqual(duTargets({ home: '/none', tmp: '/none', readdir: () => { throw new Error('ENOENT'); } }), []);
  const [bin, args] = duCommand(dirs);
  assert.equal(bin, 'nice');
  assert.deepEqual(args, ['-n19', 'ionice', '-c3', 'du', '-x', '-B1', '-s', '--', ...dirs]);
  assert.ok(!args.some((a) => a.includes('*')), 'no glob reaches du');
  assert.ok(!(args.includes('-s') && args.some((a) => a.startsWith('--max-depth'))), '-s with --max-depth is invalid');
  assert.deepEqual(duCommand(['/a'], { lowPriority: false }), ['du', ['-x', '-B1', '-s', '--', '/a']]);
});

test('diskFollowUp: runs once while in flight, formats top 8, partial on timeout, falls back without nice', async () => {
  const { diskFollowUp, parseDu, formatDuTop } = await import('./health.mjs');
  assert.deepEqual(parseDu('100\t/a b\n200\t/c\n30'), [{ bytes: 100, path: '/a b' }, { bytes: 200, path: '/c' }], 'cut-off line dropped, spaces kept');
  const rows = Array.from({ length: 10 }, (_, i) => ({ bytes: (i + 1) * GB, path: `/h/Projects/p${i}` }));
  rows.push({ bytes: 500 * 1024 ** 2, path: '/t/claude-1000' });
  const top = formatDuTop(rows, { home: '/h' });
  assert.match(top, /^📂 Thư mục lớn nhất:\n1\. ~\/Projects\/p9: 10\.0 GB\n2\. ~\/Projects\/p8: 9\.0 GB/);
  assert.equal(top.split('\n').length, 9, 'header + top 8');
  assert.match(formatDuTop([{ bytes: 500 * 1024 ** 2, path: '/t/claude-1000' }], { home: '/h' }), /1\. \/t\/claude-1000: 500 MB/);

  const state = {}; const sent = []; const calls = []; let release;
  const gate = new Promise((r) => { release = r; });
  const runDu = async (bin, args) => { calls.push([bin, args]); await gate; return { stdout: `${5 * GB}\t/h/Projects/big\n${GB}\t/h/.cache/teleport/x\n`, timedOut: false }; };
  const send = async (t) => sent.push(t);
  const p1 = diskFollowUp(state, send, { targets: () => ['/h/Projects/big', '/h/.cache/teleport/x'], runDu, home: '/h' });
  const p2 = diskFollowUp(state, send, { targets: () => ['/h/Projects/big'], runDu, home: '/h' });
  assert.equal(state.duInFlight, true);
  release(); await p1; await p2;
  assert.equal(calls.length, 1, 'second call while in flight does not start another du');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /1\. ~\/Projects\/big: 5\.0 GB\n2\. ~\/\.cache\/teleport\/x: 1\.0 GB/);
  assert.equal(state.duInFlight, false, 'flag released');

  const sent2 = []; const calls2 = [];
  await diskFollowUp({}, async (t) => sent2.push(t), {
    targets: () => ['/a', '/b'], home: '/h',
    runDu: async (bin, args) => { calls2.push(bin); return bin === 'nice' ? { stdout: '', code: 'ENOENT' } : { stdout: `${2 * GB}\t/a\n`, timedOut: true }; },
  });
  assert.deepEqual(calls2, ['nice', 'du'], 'nice missing → plain du');
  assert.match(sent2[0], /\(một phần \/ quá giờ\):\n1\. \/a: 2\.0 GB/);

  const sent3 = [];
  await diskFollowUp({}, async (t) => sent3.push(t), { targets: () => ['/a'], runDu: async () => ({ stdout: '', timedOut: true }) });
  assert.equal(sent3.length, 0, 'timed out with nothing parsed → skip');

  const sent4 = []; const calls4 = [];
  await diskFollowUp({}, async (t) => sent4.push(t), {
    targets: () => ['/a'], home: '/h',
    runDu: async (bin) => { calls4.push(bin); return bin === 'nice' ? { stdout: '', code: 127 } : { stdout: `${3 * GB}\t/a\n`, code: null }; },
  });
  assert.deepEqual(calls4, ['nice', 'du'], 'nice present but ionice missing (exit 127) → plain du');
  assert.match(sent4[0], /1\. \/a: 3\.0 GB/);

  const calls5 = [];
  await diskFollowUp({}, async () => {}, { targets: () => ['/a'], runDu: async (bin) => { calls5.push(bin); return { stdout: '', code: 1 }; } });
  assert.deepEqual(calls5, ['nice'], 'a plain du failure (exit 1) is not retried');
  const calls6 = [];
  await diskFollowUp({}, async () => {}, { targets: () => ['/a'], runDu: async (bin) => { calls6.push(bin); return { stdout: `${GB}\t/a\n`, code: 127 }; } });
  assert.deepEqual(calls6, ['nice'], 'rows parsed → no rerun even with an odd exit code');
});

test('runDuDefault: reports ENOENT for a missing binary and the exit status otherwise (127 = wrapper could not exec)', async () => {
  const { runDuDefault } = await import('./health.mjs');
  assert.equal((await runDuDefault('/nonexistent/teleport-no-such-bin', [])).code, 'ENOENT');
  assert.equal((await runDuDefault('sh', ['-c', 'exit 127'])).code, 127);
  const ok = await runDuDefault('sh', ['-c', 'printf "5\\t/x\\n"']);
  assert.equal(ok.code, null); assert.equal(ok.stdout, '5\t/x\n'); assert.equal(ok.timedOut, false);
});

test('machineWatch wires the disk alert (follow-up not awaited); real du on a tiny temp dir parses', async () => {
  const { machineWatch, diskFollowUp } = await import('./health.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const sent = []; let kicked = 0; let store = {};
  let timer;
  const finished = await Promise.race([
    machineWatch({}, async (t) => sent.push(t), {
      readMem: () => null, listAgents: () => [], persisted: { read: () => ({}), write: () => {} }, now: () => 1e9,
      statfs: () => ({ bsize: GB, blocks: 500, bavail: 10 }), diskPersisted: { read: () => store, write: (o) => { store = o; } },
      followUp: () => { kicked++; return new Promise(() => {}); }, // never settles: machineWatch must not wait on it
    }).then(() => true),
    new Promise((r) => { timer = setTimeout(() => r(false), 1000); }),
  ]);
  clearTimeout(timer);
  assert.equal(finished, true, 'machineWatch returns without waiting for the du follow-up');
  assert.match(sent[0], /💾 Disk sắp đầy: còn 10\.0 GB \/ 500\.0 GB \(2%\)/);
  assert.equal(kicked, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-du-'));
  try {
    fs.mkdirSync(path.join(dir, 'a b')); fs.writeFileSync(path.join(dir, 'a b', 'f'), Buffer.alloc(3 * 1024 * 1024, 1));
    const out = [];
    await diskFollowUp({}, async (t) => out.push(t), { targets: () => [path.join(dir, 'a b')], home: '/nonexistent' });
    assert.ok(out[0].includes(`1. ${dir}/a b: 3 MB`), out[0]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('oomdSummary + deathText: an oomd scope kill naming no agent → shown as context ("có thể liên quan")', async () => {
  const { oomdSummary, deathText } = await import('./health.mjs');
  const j = 'Oct 13 09:38:17 admin123 systemd[1403]: run-r008f.scope: systemd-oomd killed 125 process(es) in this unit.\nOct 13 09:38:18 admin123 systemd-oomd[1]: Killed /user.slice/… due to memory pressure';
  assert.deepEqual(oomdSummary(j), { kills: 1, procs: 125, at: '09:38', units: ['run-r008f.scope'] });
  assert.equal(oomdSummary('nothing here'), null);
  assert.equal(oomdSummary(j, { skipUnits: ['run-r008f.scope'] }), null, "a living agent's own unit is not context for another's death");
  const t = deathText([{ pid: 7, name: 'Tiên', hashtag: 'x1' }], { oomd: oomdSummary(j) });
  assert.match(t, /Tiên #x1 \(PID 7\) đã tắt \(lúc 09:38 systemd-oomd có giết 125 tiến trình ở run-r008f\.scope vì máy thiếu bộ nhớ — có thể liên quan\)/);
  assert.match(deathText([{ pid: 7, name: 'A' }], {}), /không rõ lý do/);
});

test('oomdSummary: a single-digit day (journalctl pads it with a space) still gives the time', async () => {
  const { oomdSummary } = await import('./health.mjs');
  assert.equal(oomdSummary('Oct  3 09:38:17 h systemd[1]: run-x.scope: systemd-oomd killed 4 process(es) in this unit.').at, '09:38');
});
