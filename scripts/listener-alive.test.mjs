import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordAlive,
  isAlive,
  getLastAliveMs,
  pruneStale,
  alivePath,
  _resetThrottle,
} from './listener-alive.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alive-'));
}

test('listener-alive — recordAlive creates file, isAlive sees it fresh', () => {
  _resetThrottle();
  const dir = tmpDir();
  recordAlive('c1', { dir });
  assert.ok(fs.existsSync(alivePath('c1', dir)));
  assert.strictEqual(isAlive('c1', { dir, freshMs: 60_000 }), true);
});

test('listener-alive — isAlive false when stale', () => {
  _resetThrottle();
  const dir = tmpDir();
  recordAlive('c1', { dir, now: 1_000_000 });
  // recordAlive writes mtime from `now`, but on some filesystems (notably
  // older ext2 / FAT32 without sub-second support) the truncation could
  // drift; force a known mtime explicitly so the staleness check below is
  // not sensitive to filesystem timestamp resolution.
  const t = (1_000_000) / 1000;
  fs.utimesSync(alivePath('c1', dir), t, t);
  assert.strictEqual(isAlive('c1', { dir, now: 1_000_000 + 120_000, freshMs: 90_000 }), false);
});

test('listener-alive — isAlive false for unknown convoId (no file)', () => {
  const dir = tmpDir();
  assert.strictEqual(isAlive('unknown', { dir, freshMs: 60_000 }), false);
});

test('listener-alive — getLastAliveMs returns mtime or null', () => {
  _resetThrottle();
  const dir = tmpDir();
  recordAlive('c1', { dir });
  const t = getLastAliveMs('c1', { dir });
  assert.ok(t != null && t > 0);
  assert.strictEqual(getLastAliveMs('missing', { dir }), null);
});

test('listener-alive — pruneStale removes only files older than maxAge', () => {
  _resetThrottle();
  const dir = tmpDir();
  recordAlive('fresh', { dir });
  recordAlive('old', { dir });
  // Backdate `old` by 30 hours.
  const ancient = (Date.now() - 30 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(alivePath('old', dir), ancient, ancient);
  const removed = pruneStale({ dir, maxAgeMs: 24 * 60 * 60 * 1000 });
  assert.strictEqual(removed, 1);
  assert.ok(fs.existsSync(alivePath('fresh', dir)));
  assert.ok(!fs.existsSync(alivePath('old', dir)));
});

test('listener-alive — pruneStale on missing dir returns 0 (no throw)', () => {
  const dir = path.join(os.tmpdir(), `no-such-${Date.now()}`);
  assert.strictEqual(pruneStale({ dir }), 0);
});

test('listener-alive — safeName rejects path traversal', () => {
  _resetThrottle();
  const dir = tmpDir();
  recordAlive('../escape', { dir });
  // Whichever file was written must be inside `dir`.
  const written = fs.readdirSync(dir);
  assert.strictEqual(written.length, 1);
  assert.ok(!written[0].includes('/') && !written[0].includes('..'));
});

test('listener-alive — per-process throttle skips writes within 30s', () => {
  _resetThrottle();
  const dir = tmpDir();
  const t0 = Date.now();
  assert.strictEqual(recordAlive('c1', { dir, now: t0 }), true);
  // Second call within throttle window must return false (no write).
  assert.strictEqual(recordAlive('c1', { dir, now: t0 + 5_000 }), false);
  // After window, write again.
  assert.strictEqual(recordAlive('c1', { dir, now: t0 + 35_000 }), true);
});
