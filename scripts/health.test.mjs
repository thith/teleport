import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeminfo, parseDf, topMemory, countOomKills, formatHealth, parsePressure } from './health.mjs';

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

test('formatHealth: all sections + warnings only when thresholds are crossed', () => {
  const base = {
    cores: 12, load: [4, 5, 7],
    mem: { total: 16 * GB, available: 6 * GB, swapTotal: 2 * GB, swapFree: 1 * GB },
    disk: { size: 500 * GB, avail: 120 * GB, target: '/' },
    agents: [{ screen: 'tele-a', status: 'busy' }, { screen: null, status: 'idle' }],
    top: [{ name: 'java', mb: 4200, count: 2 }, { name: 'node', mb: 700, count: 22 }],
    oomKills: 0,
  };
  const ok = formatHealth(base);
  assert.match(ok, /CPU: 12 nhân · load 4\.00 \/ 5\.00 \/ 7\.00 \(~33%\)/);
  assert.match(ok, /RAM: dùng 10\.0 GB \/ 16\.0 GB · còn khả dụng 6\.0 GB/);
  assert.match(ok, /Swap: 1\.0 GB \/ 2\.0 GB\n/);
  assert.match(ok, /Disk \/: còn trống 120\.0 GB \/ 500\.0 GB \(24%\)/);
  assert.match(ok, /Agent claude: 2 đang chạy \(📺 screen 1 · 💻 terminal 1\) · busy 1/);
  assert.match(ok, /• java ×2: 4\.1 GB\n• node ×22: 700 MB/);
  assert.match(ok, /✅ Không có cảnh báo\.\n\n\/cswap {3}\/type {3}\/ls$/); // tappable shortcuts close the message
  const bad = formatHealth({ ...base, load: [14, 9, 8], mem: { total: 16 * GB, available: 1 * GB, swapTotal: 2 * GB, swapFree: 0 }, disk: { size: 500 * GB, avail: 20 * GB, target: '/' }, oomKills: 3 });
  assert.match(bad, /Swap: 2\.0 GB \/ 2\.0 GB ⚠️ gần đầy/);
  for (const w of [/CPU quá tải/, /RAM sắp hết/, /Disk sắp đầy \(còn 4%\)/, /3 lần OOM-kill/]) assert.match(bad, w);
  assert.doesNotMatch(bad, /Không có cảnh báo/);
  assert.match(bad, /\n\n\/cswap {3}\/type {3}\/ls$/); // also after warnings
  assert.match(formatHealth({ cores: 4, load: null, mem: null, disk: null, agents: null, top: null, oomKills: 0 }), /Không có cảnh báo/, 'missing sources just drop lines');
});

test('PSI: parse /proc/pressure; warn on what tasks actually wait for, not raw load', () => {
  const io = parsePressure('some avg10=71.77 avg60=71.27 avg300=55.75 total=344279498\nfull avg10=66.88 avg60=67.09 avg300=52.48 total=321719232\n');
  assert.deepEqual(io, { some: { avg10: 71.77, avg60: 71.27, avg300: 55.75 }, full: { avg10: 66.88, avg60: 67.09, avg300: 52.48 } });
  const cpuIdle = parsePressure('some avg10=0.00 avg60=0.00 avg300=1.15 total=57760764\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
  assert.equal(parsePressure('garbage'), null);
  assert.equal(parsePressure(null), null);
  // The real case: load 17.6 on 12 cores, but nothing waits for CPU — the disk is the jam.
  const jam = formatHealth({ cores: 12, load: [17.64, 13.26, 7.46], psi: { cpu: cpuIdle, io } });
  assert.match(jam, /load 17\.64 \/ 13\.26 \/ 7\.46 \(~147%\) · chờ CPU 0%/);
  assert.match(jam, /💽 Disk IO: đứng chờ ổ đĩa 67% thời gian \(TB 1 phút 67% · 5 phút 52%\)/);
  assert.match(jam, /⚠️ Disk IO nghẽn: 67% thời gian mọi tiến trình đứng chờ ổ đĩa \(load cao là do chờ disk, không phải thiếu CPU\)/);
  assert.doesNotMatch(jam, /CPU quá tải/);
  // Real CPU shortage: PSI cpu high → CPU warning, no disk hint.
  const busy = formatHealth({ cores: 12, load: [20, 18, 15], psi: { cpu: { some: { avg10: 80, avg60: 70, avg300: 60 }, full: null }, io: { some: io.some, full: { avg10: 5, avg60: 4, avg300: 3 } } } });
  assert.match(busy, /CPU quá tải \(80% thời gian có tiến trình chờ CPU\)/);
  // PSI-triggered warning never quotes a load that contradicts it.
  assert.doesNotMatch(formatHealth({ cores: 12, load: [6, 6, 6], psi: { cpu: { some: { avg10: 60, avg60: 50, avg300: 40 }, full: null }, io: null } }), /load 6\.0 > 12/);
  assert.doesNotMatch(busy, /Disk IO nghẽn/);
  // Calm disk: the IO line shows, no warning.
  assert.match(formatHealth({ cores: 12, load: [2, 2, 2], psi: { cpu: cpuIdle, io: { some: io.some, full: { avg10: 3, avg60: 2, avg300: 1 } } } }), /✅ Không có cảnh báo/);
  // No PSI (old kernel / not Linux): fall back to load > cores, no IO line.
  const legacy = formatHealth({ cores: 12, load: [14, 9, 8] });
  assert.match(legacy, /CPU quá tải/);
  assert.doesNotMatch(legacy, /Disk IO/);
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
  assert.match(formatHealth({ disk: { size: 200 * GB, avail: 39 * GB, target: '/' } }), /⚠️ Disk sắp đầy \(còn 20%\)/, '/health warns on the same thresholds');
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
