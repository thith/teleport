// RFC 32 §4 — build quiet hours: quietState, the override file, the idempotent CPU-limit sync (systemctl always injected),
// and the `lock-queue quiet` CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  quietState, parseQuietConfig, parseTimespanUs, quotaUs, syncQuietCpu, readOverride, writeOverride, clearOverride, cpuLimitSupported,
  QUIET_SLICE, OVERRIDE_FILE, APPLIED_FILE, readOverrideStrict, buildRuleText,
} from './quiet-hours.mjs';
import { quietCmd, parseArgs } from './lock-queue.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp-quiet-'));
const at = (h, m, day = 3) => new Date(2026, 10, day, h, m).getTime();
const CFG = { from: '23:30', to: '06:00', cpuPercent: 25, maxBuilds: 1 };

test('quietState: a window across midnight at 23:29 / 23:30 / 03:00 / 06:00', () => {
  const s = (h, m) => quietState({ config: CFG, now: at(h, m) });
  assert.equal(s(23, 29).active, false);
  assert.equal(s(23, 29).until, at(23, 30), 'outside: until = the start of the next window');
  assert.equal(s(23, 30).active, true);
  assert.equal(s(23, 30).until, at(6, 0, 4), 'inside: until = the end, tomorrow morning');
  assert.equal(s(3, 0).active, true);
  assert.equal(s(3, 0).until, at(6, 0, 3), 'after midnight: the end is later today');
  assert.equal(s(6, 0).active, false, '"to" is exclusive');
  assert.equal(s(6, 0).until, at(23, 30, 3));
  const st = s(3, 0);
  assert.deepEqual([st.enabled, st.cpuPercent, st.maxBuilds, st.overridden, st.from, st.to], [true, 25, 1, false, '23:30', '06:00']);
});

test('quietState: a window inside one day; defaults; off when absent', () => {
  const c = { from: '13:00', to: '15:00' };
  assert.equal(quietState({ config: c, now: at(12, 59) }).active, false);
  assert.equal(quietState({ config: c, now: at(13, 0) }).active, true);
  assert.equal(quietState({ config: c, now: at(14, 59) }).active, true);
  assert.equal(quietState({ config: c, now: at(15, 0) }).active, false);
  assert.equal(quietState({ config: c, now: at(15, 0) }).until, at(13, 0, 4));
  const d = quietState({ config: c, now: at(14, 0) });
  assert.deepEqual([d.cpuPercent, d.maxBuilds], [25, 1], 'cpuPercent 25, maxBuilds 1 by default');
  const off = quietState({ config: undefined, now: at(3, 0) });
  assert.deepEqual([off.enabled, off.active, off.error], [false, false, undefined]);
});

test('quietState: a broken config means OFF (with the reason), never active', () => {
  for (const bad of [{ from: '25:00', to: '06:00' }, { from: '23:30' }, { from: '23:30', to: '23:30' }, { from: '23:30', to: '06:00', cpuPercent: 0 },
    { from: '23:30', to: '06:00', cpuPercent: 150 }, { from: '23:30', to: '06:00', maxBuilds: 0 }, { from: '23:30', to: '06:00', maxBuilds: 1.5 }, 'x', [], 42]) {
    const s = quietState({ config: bad, now: at(3, 0) });
    assert.equal(s.active, false, JSON.stringify(bad));
    assert.equal(s.enabled, false);
    assert.ok(s.error, JSON.stringify(bad));
  }
  assert.equal(parseQuietConfig(null).error, undefined);
});

test('quietState: an override that has not expired → overridden; an expired one is ignored; it never makes an inactive window active', () => {
  const until = at(6, 0, 4);
  const s = quietState({ config: CFG, now: at(23, 45), override: { offUntil: until } });
  assert.deepEqual([s.active, s.overridden], [true, true]);
  assert.equal(quietState({ config: CFG, now: at(23, 45), override: { offUntil: at(23, 40) } }).overridden, false, 'expired');
  assert.equal(quietState({ config: CFG, now: at(6, 0, 4), override: { offUntil: until } }).overridden, false, 'the window ended exactly then');
  assert.equal(quietState({ config: CFG, now: at(12, 0), override: { offUntil: until } }).overridden, false);
  assert.equal(quietState({ config: CFG, now: at(23, 45), override: { offUntil: 'x' } }).overridden, false);
  assert.equal(quietState({ config: CFG, now: at(23, 45), override: null }).overridden, false);
});

test('override file: atomic 0600 write, read, clear; corrupt = none', () => {
  const dir = tmpDir();
  assert.equal(readOverride(dir), null);
  writeOverride(dir, { offUntil: 123, by: 'q', at: 5 });
  const f = path.join(dir, OVERRIDE_FILE);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(readOverride(dir), { offUntil: 123, by: 'q', at: 5 });
  assert.deepEqual(fs.readdirSync(dir), [OVERRIDE_FILE], 'no temp file left');
  clearOverride(dir);
  clearOverride(dir); // already gone: fine
  assert.equal(readOverride(dir), null);
  fs.writeFileSync(f, '{nope');
  assert.equal(readOverride(dir), null);
});

test('parseTimespanUs: systemd timespans, odd ones included; infinity; junk', () => {
  assert.equal(parseTimespanUs('3s'), 3_000_000);
  assert.equal(parseTimespanUs('1s 500ms'), 1_500_000);
  assert.equal(parseTimespanUs('500ms'), 500_000);
  assert.equal(parseTimespanUs('2s 400ms\n'), 2_400_000);
  assert.equal(parseTimespanUs('1min 30s'), 90_000_000);
  assert.equal(parseTimespanUs('250us'), 250);
  assert.equal(parseTimespanUs('infinity'), Infinity);
  assert.equal(parseTimespanUs(''), null);
  assert.equal(parseTimespanUs('abc'), null);
  assert.equal(quotaUs(25, 12), 3_000_000, '25% of 12 cores = 300% = 3 s per second');
  assert.equal(quotaUs(25, 6), 1_500_000);
});

/** A fake systemctl with a stored CPUQuotaPerSecUSec; records every call. */
function fakeSystemctl(initial = 'infinity', { failShow = false, failSet = false } = {}) {
  const calls = [];
  let cur = initial;
  const run = (bin, args) => {
    calls.push([bin, ...args]);
    if (args.includes('show')) return failShow ? { status: 1, stderr: 'Failed to connect to bus' } : { status: 0, stdout: `${cur}\n` };
    if (args.includes('set-property')) {
      if (failSet) return { status: 1, stderr: 'denied' };
      const m = /CPUQuota=(.*)$/.exec(args.at(-1));
      cur = m[1] === '' ? 'infinity' : (() => { const us = Math.round(parseFloat(m[1]) * 10_000); const s = Math.floor(us / 1e6), ms = (us % 1e6) / 1000; return ms ? `${s ? `${s}s ` : ''}${ms}ms` : `${s}s`; })();
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };
  return { run, calls, get cur() { return cur; } };
}
const sync = (o) => syncQuietCpu({ cores: 12, supported: () => true, warn: () => {}, ...o });

test('syncQuietCpu: sets 300% on 12 cores while active; removes it when over; no call when already right (idempotent, odd cores too)', () => {
  const dir = tmpDir();
  const sc = fakeSystemctl();
  const night = quietState({ config: CFG, now: at(23, 45) });
  const day = quietState({ config: CFG, now: at(12, 0) });
  let r = sync({ dir, state: night, run: sc.run });
  assert.deepEqual([r.ok, r.changed], [true, true]);
  assert.deepEqual(sc.calls.at(-1), ['systemctl', '--user', 'set-property', '--runtime', QUIET_SLICE, 'CPUQuota=300%']);
  assert.equal(sc.cur, '3s');
  assert.ok(fs.existsSync(path.join(dir, APPLIED_FILE)), 'remember we applied it, so a later "off" config still removes it');
  sc.calls.length = 0;
  r = sync({ dir, state: night, run: sc.run });
  assert.equal(r.changed, false);
  assert.ok(sc.calls.every((c) => c.includes('show')), 'only a read');
  r = sync({ dir, state: day, run: sc.run });
  assert.equal(r.changed, true);
  assert.deepEqual(sc.calls.at(-1), ['systemctl', '--user', 'set-property', '--runtime', QUIET_SLICE, 'CPUQuota=']);
  assert.equal(sc.cur, 'infinity');
  assert.equal(fs.existsSync(path.join(dir, APPLIED_FILE)), false);
  // a machine with 6 cores: 25% = 150% → systemd prints "1s 500ms"; parsed to µs, so no set-property loop
  const odd = fakeSystemctl();
  sync({ dir, cores: 6, state: night, run: odd.run });
  assert.equal(odd.cur, '1s 500ms');
  odd.calls.length = 0;
  assert.equal(sync({ dir, cores: 6, state: night, run: odd.run }).changed, false);
  assert.equal(odd.calls.length, 1);
  // overridden = no limit
  const off = fakeSystemctl('3s');
  const ov = quietState({ config: CFG, now: at(23, 45), override: { offUntil: at(6, 0, 4) } });
  assert.equal(sync({ dir, state: ov, run: off.run }).changed, true);
  assert.equal(off.cur, 'infinity');
});

test('syncQuietCpu: a machine that never used the feature is not touched (no systemctl at all)', () => {
  const dir = tmpDir();
  const sc = fakeSystemctl();
  const r = sync({ dir, state: quietState({ config: undefined, now: at(3, 0) }), run: sc.run });
  assert.equal(r.skipped, true);
  assert.equal(sc.calls.length, 0);
  // …but once we have applied a limit, switching the config off still removes it
  fs.writeFileSync(path.join(dir, APPLIED_FILE), '1\n');
  const sc2 = fakeSystemctl('3s');
  assert.equal(sync({ dir, state: quietState({ config: undefined, now: at(3, 0) }), run: sc2.run }).changed, true);
  assert.equal(sc2.cur, 'infinity');
});

test('syncQuietCpu: no systemd / no cpu controller / systemctl errors → a warning (once), never a throw', () => {
  const dir = tmpDir();
  const night = quietState({ config: CFG, now: at(23, 45) });
  const warns = [];
  const sc = fakeSystemctl();
  const u = syncQuietCpu({ dir, state: night, cores: 12, supported: () => false, run: sc.run, warn: (m) => warns.push(m) });
  assert.deepEqual([u.ok, u.unsupported], [false, true]);
  assert.equal(sc.calls.length, 0, 'no systemctl without the cpu controller');
  assert.match(warns[0], /không giới hạn được CPU/);
  syncQuietCpu({ dir, state: night, cores: 12, supported: () => false, run: sc.run, warn: (m) => warns.push(m) });
  assert.equal(warns.length, 1, 'warned once');
  const w2 = [];
  const bad = fakeSystemctl('infinity', { failShow: true });
  assert.equal(syncQuietCpu({ dir, state: night, cores: 12, supported: () => true, run: bad.run, warn: (m) => w2.push(m) }).ok, false);
  assert.match(w2[0], /không đọc được/);
  const w3 = [];
  const bad2 = fakeSystemctl('infinity', { failSet: true });
  assert.equal(syncQuietCpu({ dir, state: night, cores: 12, supported: () => true, run: bad2.run, warn: (m) => w3.push(m) }).ok, false);
  assert.match(w3[0], /set-property .* lỗi/);
  const w4 = [];
  assert.doesNotThrow(() => syncQuietCpu({ dir, state: night, cores: 12, supported: () => true, run: () => { throw new Error('ENOENT systemctl'); }, warn: (m) => w4.push(m) }));
  assert.match(w4[0], /ENOENT/);
  assert.deepEqual(syncQuietCpu({ dir, state: night, cores: 12, supported: () => true, run: () => ({ error: new Error('spawn systemctl ENOENT') }), warn: () => {} }).unsupported, true);
  assert.equal(cpuLimitSupported({ read: () => { throw new Error('ENOENT'); } }), false);
  assert.equal(cpuLimitSupported({ read: () => 'memory pids' }), false);
  assert.equal(cpuLimitSupported({ read: () => 'cpuset cpu io memory pids' }), true);
});

test('lock-queue quiet: parse; status; off → override file + sync; on → removes it; not active / not configured / broken', () => {
  assert.deepEqual(parseArgs(['quiet']), { cmd: 'quiet', value: null });
  assert.deepEqual(parseArgs(['quiet', 'off']), { cmd: 'quiet', value: 'off' });
  assert.deepEqual(parseArgs(['quiet', 'on']), { cmd: 'quiet', value: 'on' });
  assert.match(parseArgs(['quiet', 'maybe']).error, /usage/);
  assert.match(parseArgs(['quiet', 'on', 'x']).error, /usage/);
  const dir = tmpDir();
  let syncs = 0;
  const now = at(23, 45);
  const stateOf = (cfg) => (d, n) => quietState({ config: cfg, now: n, override: readOverride(d) });
  const run = (v, cfg = CFG, n = now) => quietCmd(v, { dir, now: n, sync: () => { syncs++; }, stateOf: stateOf(cfg) });
  assert.match(run(null).lines[0], /23:30–06:00: build ≤ 25% CPU, chỉ nhận build mới khi không còn build nào — đang áp tới 06:00/);
  const off = run('off');
  assert.equal(off.code, 0);
  assert.match(off.lines[0], /TẮT TẠM tới 06:00/);
  assert.equal(readOverride(dir).offUntil, at(6, 0, 4));
  assert.equal(readOverride(dir).by, 'cli');
  assert.equal(syncs, 1);
  assert.match(run(null).lines[0], /TẮT TẠM/);
  const on = run('on');
  assert.match(on.lines[0], /đang áp tới 06:00/);
  assert.equal(readOverride(dir), null);
  assert.equal(syncs, 2);
  // outside the window: nothing to switch off
  const day = run('off', CFG, at(12, 0));
  assert.equal(day.code, 1);
  assert.match(day.lines[0], /chưa tới giờ/);
  assert.equal(readOverride(dir), null);
  assert.equal(run('off', null).code, 1);
  assert.equal(run(null, null).code, 0);
  assert.match(run(null, { from: 'x' }).lines[0], /cấu hình hỏng/);
});

test('R1 marker: written BEFORE a finite quota; repaired when the quota already matches; a stale one is removed when the slice reads infinity', () => {
  const dir = tmpDir();
  const night = quietState({ config: CFG, now: at(23, 45) });
  const marker = path.join(dir, APPLIED_FILE);
  // marker first: at the moment set-property runs, it already exists
  let markerAtSet = null;
  const sc = fakeSystemctl();
  const run = (bin, args) => { if (args.includes('set-property')) markerAtSet = fs.existsSync(marker); return sc.run(bin, args); };
  sync({ dir, state: night, run });
  assert.equal(markerAtSet, true);
  // a crash / failed write lost the marker but the quota stays: the next sync repairs it
  fs.unlinkSync(marker);
  assert.equal(sync({ dir, state: night, run: sc.run }).changed, false);
  assert.ok(fs.existsSync(marker), 'reconciled on the already-matching path');
  // reboot: slice is unlimited again, config turned off, the marker lingers → one look removes it, then no more systemctl at all
  const rebooted = fakeSystemctl('infinity');
  const offState = quietState({ config: undefined, now: at(12, 0) });
  assert.equal(sync({ dir, state: offState, run: rebooted.run }).changed, false);
  assert.equal(fs.existsSync(marker), false, 'stale marker gone');
  rebooted.calls.length = 0;
  assert.equal(sync({ dir, state: offState, run: rebooted.run }).skipped, true);
  assert.equal(rebooted.calls.length, 0);
});

test('R6 one wording for the build rule (health and lock-queue quiet)', () => {
  assert.equal(buildRuleText(1), 'chỉ nhận build mới khi không còn build nào');
  assert.equal(buildRuleText(2), 'tối đa 2 build');
  const r = quietCmd(null, { dir: tmpDir(), now: at(23, 45), stateOf: () => quietState({ config: { ...CFG, maxBuilds: 2 }, now: at(23, 45) }) });
  assert.match(r.lines[0], /CPU, tối đa 2 build —/);
});

test('R3 readOverrideStrict: absent = none; unreadable or corrupt throws', () => {
  const dir = tmpDir();
  assert.equal(readOverrideStrict(dir), null);
  fs.writeFileSync(path.join(dir, OVERRIDE_FILE), '{nope');
  assert.throws(() => readOverrideStrict(dir));
  fs.unlinkSync(path.join(dir, OVERRIDE_FILE));
  fs.mkdirSync(path.join(dir, OVERRIDE_FILE)); // EISDIR: a read error that is not ENOENT
  assert.throws(() => readOverrideStrict(dir), /EISDIR/);
});
