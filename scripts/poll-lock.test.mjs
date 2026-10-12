import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquirePollLock, releasePollLock } from './tele-listen.mjs';

const lockIn = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-poll-')), 'poll.lock');
const age = (f, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(f, t, t); };

test('acquirePollLock: free → taken; held (fresh) → refused; release → free', () => {
  const f = lockIn();
  assert.equal(acquirePollLock(f), true);
  assert.match(fs.readFileSync(f, 'utf8'), /^\d+:\d+:[0-9a-f]+$/); // <ms>:<pid>:<random> (RFC 18 B)
  assert.equal(acquirePollLock(f), false);
  releasePollLock(f);
  assert.equal(acquirePollLock(f), true);
});

test('acquirePollLock: a stale timestamp (> 30 s) is taken over', () => {
  const f = lockIn();
  fs.writeFileSync(f, String(Date.now() - 60_000));
  assert.equal(acquirePollLock(f), true);
});

test('acquirePollLock: an EMPTY lock (died / disk full between create and write) is not a permanent wedge', () => {
  const f = lockIn();
  fs.writeFileSync(f, '');
  assert.equal(acquirePollLock(f), false, 'fresh empty lock: someone may be mid-write');
  age(f, 60_000);
  assert.equal(acquirePollLock(f), true, 'old empty lock → stale by mtime → taken over');
  fs.writeFileSync(f, 'garbage');
  age(f, 60_000);
  assert.equal(acquirePollLock(f), true, 'garbled content too');
});
