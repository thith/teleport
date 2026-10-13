import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentMap } from './button-store.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-btn-')), 'sub', 'pending-buttons.json');

test('PersistentMap: set/delete survive a reload (a daemon restart); file is 0600', () => {
  const f = tmpFile();
  const a = new PersistentMap(f);
  a.set('t1', { links: ['x'], createdAt: 1 });
  a.set('t2', { kind: 'cleanup', createdAt: 2 });
  a.delete('t1');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const b = new PersistentMap(f);
  assert.deepEqual([...b.keys()], ['t2']);
  assert.deepEqual(b.get('t2'), { kind: 'cleanup', createdAt: 2 });
});

test('PersistentMap: missing / corrupt file → empty; cap drops the oldest', () => {
  const f = tmpFile();
  assert.equal(new PersistentMap(f).size, 0);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{not json');
  assert.equal(new PersistentMap(f).size, 0);
  const m = new PersistentMap(f, { cap: 2 });
  m.set('a', { createdAt: 1 }); m.set('b', { createdAt: 3 }); m.set('c', { createdAt: 2 });
  assert.deepEqual([...new PersistentMap(f).keys()].sort(), ['b', 'c']);
});

test('PersistentMap: a consumption that cannot be written THROWS (the button must not come back after a restart)', () => {
  const f = tmpFile();
  const m = new PersistentMap(f);
  m.set('t', { createdAt: 1 });
  fs.chmodSync(path.dirname(f), 0o500); // rename into the dir now fails
  try {
    assert.throws(() => m.delete('t'));
    m.set('u', { createdAt: 2 }); // a set failure is only logged
  } finally { fs.chmodSync(path.dirname(f), 0o700); }
});

test('BUTTON_STORE_FILE lives in the daemon state dir, not the agents\' scripts/tmp', async () => {
  const { BUTTON_STORE_FILE } = await import('./button-store.mjs');
  assert.match(BUTTON_STORE_FILE, /teleport\/pending-buttons\.json$/);
  assert.doesNotMatch(BUTTON_STORE_FILE, /scripts\/tmp/);
});
