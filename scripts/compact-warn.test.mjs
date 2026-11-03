import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  compactWindowFor, compactWarnNeed, compactWarnTick, buildCompactWarnPrompt, createWarnStore, makeSettingsReader, COMPACT_WARN_MARGIN, AUTO_COMPACT_RESERVE, warnAt, WARNED_TTL_MS,
} from './compact-warn.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';

// In-memory fs: files = { path: string }, dirs implied by files.
const memFs = (files) => ({
  read: (f) => (f in files ? files[f] : null),
  stat: (f) => {
    if (f in files) return { mtimeMs: 1, isFile: true, isDir: false };
    if (Object.keys(files).some((k) => k.startsWith(`${f}/`))) return { mtimeMs: 1, isFile: false, isDir: true };
    return null;
  },
});
const HOME = '/home/u';
const gset = (o) => ({ [`${HOME}/.claude/settings.json`]: JSON.stringify(o) });
const win = (files, a = {}) => compactWindowFor({ home: HOME, fsx: memFs(files), model: 'claude-opus-4-5', cwd: '/w/proj', hashtag: 'ab12', ...a });

test('threshold constants: warn at window − 40k, reserve 33k', () => {
  assert.equal(COMPACT_WARN_MARGIN, 40_000);
  assert.equal(AUTO_COMPACT_RESERVE, 33_000);
  assert.equal(warnAt(250_000), 210_000);
});

test('compactWindowFor: teleport override wins (hashtag, #hashtag, model); out of range ignored', () => {
  const cfg = { _config: { compactWindows: { '#ab12': 250000 } } };
  assert.equal(win({}, { cfg }), 250000);
  assert.equal(win({ ...gset({ autoCompactWindow: 300000 }) }, { cfg: { _config: { compactWindows: { 'claude-opus-4-5': 500000 } } } }), 500000);
  assert.equal(win(gset({ autoCompactWindow: 300000 }), { cfg: { _config: { compactWindows: { ab12: 5 } } } }), 300000, 'invalid override → falls through');
});

test('compactWindowFor: global top-level, range, "auto", missing, broken', () => {
  assert.equal(win(gset({ autoCompactWindow: 250000 })), 250000);
  assert.equal(win(gset({ autoCompactWindow: 99999 })), null);
  assert.equal(win(gset({ autoCompactWindow: 1000001 })), null);
  assert.equal(win(gset({ autoCompactWindow: 250000.5 })), null);
  assert.equal(win(gset({ autoCompactWindow: 'auto' })), null);
  assert.equal(win(gset({})), null);
  assert.equal(win({}), null);
  assert.equal(win({ [`${HOME}/.claude/settings.json`]: '{nope' }), null);
});

test('compactWindowFor: modelSettings normalises [1m] and -YYYYMMDD; conflicts and "auto" stop', () => {
  const ms = (o) => gset({ autoCompactWindow: 200000, modelSettings: o });
  assert.equal(win(ms({ 'claude-opus-4-5[1m]': { autoCompactWindow: 900000 } })), 900000);
  assert.equal(win(ms({ 'claude-opus-4-5-20251101': { autoCompactWindow: 400000 } })), 400000);
  assert.equal(win(ms({ 'claude-opus-4-5': { autoCompactWindow: 300000 }, 'claude-opus-4-5[1m]': { autoCompactWindow: 900000 } })), null, 'conflict');
  assert.equal(win(ms({ 'claude-opus-4-5': { autoCompactWindow: 300000 }, 'claude-opus-4-5[1m]': { autoCompactWindow: 300000 } })), 300000, 'same value is not a conflict');
  assert.equal(win(ms({ 'claude-opus-4-5': { autoCompactWindow: 'auto' } })), null, '"auto" at model stops even with a root number');
  assert.equal(win(ms({ 'claude-sonnet-4': { autoCompactWindow: 300000 } })), 200000, 'no key matches → root');
  assert.equal(win(ms({ 'claude-sonnet-4': { autoCompactWindow: 300000 } }), { model: null }), null, 'model never seen but modelSettings exist');
});

test('compactWindowFor: any project-level definition → unknown (cwd, repo root, main checkout of a worktree)', () => {
  const g = gset({ autoCompactWindow: 250000 });
  assert.equal(win({ ...g, '/w/proj/.claude/settings.local.json': JSON.stringify({ autoCompactWindow: 'auto' }) }), null, 'cwd');
  assert.equal(win({ ...g, '/w/proj/.claude/settings.json': JSON.stringify({ modelSettings: { x: { autoCompactWindow: 300000 } } }) }), null, 'modelSettings in project');
  assert.equal(win({ ...g, '/w/proj/.git/HEAD': 'x', '/w/proj/.claude/settings.json': '{"autoCompactWindow":300000}' }, { cwd: '/w/proj/sub' }), null, 'repo root');
  const wt = {
    ...g,
    '/wt/feat/.git': 'gitdir: /main/.git/worktrees/feat\n',
    '/main/.git/worktrees/feat/commondir': '../..\n',
    '/main/.claude/settings.json': '{"autoCompactWindow":300000}',
  };
  assert.equal(win(wt, { cwd: '/wt/feat' }), null, 'main checkout');
  assert.equal(win({ ...wt, '/main/.claude/settings.json': '{"other":1}' }, { cwd: '/wt/feat' }), 250000, 'no definition → global');
  assert.equal(win({ ...g, '/w/proj/.claude/settings.json': '{bad' }), null, 'broken project file');
});

test('makeSettingsReader caches by mtime', () => {
  let reads = 0; let m = 1;
  const fsx = { stat: () => ({ mtimeMs: m }), read: () => { reads++; return '{"a":1}'; } };
  const r = makeSettingsReader(fsx);
  r('/f'); r('/f'); assert.equal(reads, 1);
  m = 2; r('/f'); assert.equal(reads, 2);
});

test('compactWarnNeed: once at >= window−40k, reset on compacted or < 0.8·warnAt, unknown x/y changes nothing', () => {
  const y = 250000;
  const n = (o) => compactWarnNeed({ y, ...o });
  assert.deepEqual(n({ x: 209_999 }), { warn: false, clear: false });
  assert.deepEqual(n({ x: 210_000 }), { warn: true, clear: false });
  assert.deepEqual(n({ x: 240_000, warned: true }), { warn: false, clear: false }, 'only once');
  assert.deepEqual(n({ x: 170_000, warned: true }), { warn: false, clear: false }, 'above 0.8·210k=168k keeps the mark');
  assert.deepEqual(n({ x: 167_000, warned: true }), { warn: false, clear: true });
  assert.deepEqual(n({ x: 8000, compacted: true, warned: true }), { warn: false, clear: true });
  assert.deepEqual(n({ x: null, warned: true }), { warn: false, clear: false });
  assert.deepEqual(n({ x: 240_000, y: null }), { warn: false, clear: false });
});

test('compactWarnNeed: small window (100k) warns at 60k and does not clear at 70k once warned', () => {
  const n = (o) => compactWarnNeed({ y: 100_000, ...o });
  assert.deepEqual(n({ x: 59_999 }), { warn: false, clear: false });
  assert.deepEqual(n({ x: 60_000 }), { warn: true, clear: false });
  assert.deepEqual(n({ x: 70_000, warned: true }), { warn: false, clear: false });
  assert.deepEqual(n({ x: 47_000, warned: true }), { warn: false, clear: true });
});

test('buildCompactWarnPrompt: exact wording, daemon-framed, infoOnly', () => {
  const p = buildCompactWarnPrompt({ convoId: 7, chatId: -1, x: 238000, y: 250000 });
  assert.equal(p.text, '🤖 Teleport daemon: context ~238k/250k, sắp auto compact (sẽ compact khi context chạm ~217k). Lưu lại state cần thiết.');
  assert.equal(p.infoOnly, true);
  assert.equal(p.fromRole, 'daemon');
  assert.equal(p.messageId, null);
  assert.equal(p.convoId, 7);
});

// ── tick ──
const SID = '848e5ded-a905-4b49-8448-12ed50f4a7dc';
const CONVO = uuidToConvoInt(SID);
const row = (o) => ({ pid: 1, hashtag: 'aaaa0001', sessionId: SID, guessed: false, cwd: '/w', ...o });
function harness(o = {}) {
  const h = {
    rows: [row()], usage: { compacted: false, tokens: 240000, model: 'claude-opus-4-5' }, mtime: 1, listener: 'on',
    sent: [], fail: false, reads: 0, logs: [], cache: new Map(), y: 250000,
    store: createWarnStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-')), 'cw.json') }),
    ...o,
  };
  h.tick = () => compactWarnTick({
    list: () => h.rows, store: h.store, cache: h.cache, listener: () => h.listener, log: (s) => h.logs.push(s),
    findFile: () => '/t.jsonl', stat: () => ({ size: 10, mtimeMs: h.mtime }), windowFor: () => h.y,
    readUsage: () => { h.reads++; return h.usage; },
    deliver: async (r, { build }) => { if (h.fail) throw new Error('boom'); h.sent.push(build({ ...r, chatId: 1 })); },
  });
  return h;
}

test('tick: warns once, then stays silent', async () => {
  const h = harness();
  assert.equal((await h.tick()).length, 1);
  assert.equal(h.sent[0].convoId, CONVO);
  assert.match(h.sent[0].text, /240k\/250k/);
  assert.equal((await h.tick()).length, 0);
  assert.equal(h.sent.length, 1);
});

test('tick: guessed, no session, twin and unknown window are skipped', async () => {
  for (const rows of [[row({ guessed: true })], [row({ sessionId: null })], [row(), row({ pid: 2 })]]) {
    const h = harness({ rows });
    assert.equal((await h.tick()).length, 0);
  }
  const h = harness({ y: null });
  assert.equal((await h.tick()).length, 0);
});

test('tick: listener off → nothing; later on with unchanged file → sends from cache (no re-read)', async () => {
  const h = harness({ listener: 'off' });
  assert.equal((await h.tick()).length, 0);
  h.listener = 'on';
  assert.equal((await h.tick()).length, 1);
  assert.equal(h.reads, 1, 'second tick used the cached usage');
});

test('tick: a failed delivery unmarks, next tick retries', async () => {
  const h = harness({ fail: true });
  assert.equal((await h.tick()).length, 0);
  assert.equal(h.store.has(SID), false);
  h.fail = false;
  assert.equal((await h.tick()).length, 1);
});

test('tick: reset on compact / drop below 80%, then warns again', async () => {
  const h = harness();
  await h.tick();
  h.usage = { compacted: true, tokens: 8000, model: null }; h.mtime = 2;
  await h.tick();
  assert.equal(h.store.has(SID), false);
  h.usage = { compacted: false, tokens: 245000, model: 'claude-opus-4-5' }; h.mtime = 3;
  assert.equal((await h.tick()).length, 1);
  h.usage = { compacted: false, tokens: 100000, model: 'claude-opus-4-5' }; h.mtime = 4; await h.tick();
  assert.equal(h.store.has(SID), false);
});

test('tick: model survives a compacted usage (model null) via the cache', async () => {
  let seen;
  const h = harness();
  h.tick = () => compactWarnTick({
    list: () => h.rows, store: h.store, cache: h.cache, listener: () => 'on', findFile: () => '/t', stat: () => ({ size: 1, mtimeMs: h.mtime }),
    readUsage: () => h.usage, windowFor: ({ model }) => { seen = model; return 250000; }, deliver: async () => {},
  });
  await h.tick();
  h.usage = { compacted: true, tokens: 5, model: null }; h.mtime = 2; await h.tick();
  h.usage = { compacted: false, tokens: 1, model: null }; h.mtime = 3; await h.tick();
  assert.equal(seen, 'claude-opus-4-5');
});

test('state: marks survive a restart, are not pruned when the process is absent, expire after 14 days', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-')), 'cw.json');
  const h = harness({ store: createWarnStore({ file }) });
  await h.tick();
  h.rows = []; await h.tick(); // process gone
  assert.equal(createWarnStore({ file }).has(SID), true, 'disk mark kept');
  const h2 = harness({ store: createWarnStore({ file }) });
  assert.equal((await h2.tick()).length, 0, 'no second warning after a daemon restart');
  let t = Date.now() + WARNED_TTL_MS + 1000;
  assert.equal(createWarnStore({ file, now: () => t }).has(SID), false, 'older than 14 days');
});
