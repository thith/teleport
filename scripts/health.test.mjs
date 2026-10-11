import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeminfo, parseDf, topMemory, countOomKills, formatHealth } from './health.mjs';

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
  assert.match(ok, /Agent claude: 2 đang chạy \(📺 screen 1 · 🖥 terminal 1\) · busy 1/);
  assert.match(ok, /• java ×2: 4\.1 GB\n• node ×22: 700 MB/);
  assert.match(ok, /✅ Không có cảnh báo\./);
  const bad = formatHealth({ ...base, load: [14, 9, 8], mem: { total: 16 * GB, available: 1 * GB, swapTotal: 2 * GB, swapFree: 0 }, disk: { size: 500 * GB, avail: 20 * GB, target: '/' }, oomKills: 3 });
  assert.match(bad, /Swap: 2\.0 GB \/ 2\.0 GB ⚠️ gần đầy/);
  for (const w of [/CPU quá tải/, /RAM sắp hết/, /Disk sắp đầy \(còn 4%\)/, /3 lần OOM-kill/]) assert.match(bad, w);
  assert.doesNotMatch(bad, /Không có cảnh báo/);
  assert.match(formatHealth({ cores: 4, load: null, mem: null, disk: null, agents: null, top: null, oomKills: 0 }), /Không có cảnh báo/, 'missing sources just drop lines');
});

test('memoryAlert: below threshold and outside the repeat window only', async () => {
  const { memoryAlert } = await import('./health.mjs');
  const low = { total: 16 * GB, available: 1.5 * GB, swapTotal: 2 * GB, swapFree: 0 };
  const a = memoryAlert({ mem: low, top: [{ name: 'java', mb: 4200, count: 2 }], now: 10_000_000, lastAlertAt: 0 });
  assert.equal(a.alert, true);
  assert.match(a.text, /RAM sắp hết: còn 1\.5 GB \/ 16\.0 GB \(9%\) · swap 2\.0 GB \/ 2\.0 GB[\s\S]*java ×2 4\.1 GB[\s\S]*\/kill name:/);
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
