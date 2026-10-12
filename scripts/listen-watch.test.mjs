// RFC 18 §B: stuck-listener watchdog (daemon), listener warning, own-token lock release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listenWatchdogTick, listenerStaleWarning, recordFetchOk, readLastFetchOk, describePollLock,
  startListenWatchdog,
} from './listen-watch.mjs';
import { acquirePollLock, releasePollLock, heldPollLockToken, FETCH_UPDATES_TIMEOUT_MS, fetchUpdates } from './tele-listen.mjs';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-watch-'));
  const files = {
    lastFetchOkFile: path.join(dir, 'last-fetch-ok'),
    stateFile: path.join(dir, 'listen-watch.json'),
    lockFile: path.join(dir, 'poll.lock'),
    markerFile: path.join(dir, 'listen-warn-7.txt'),
  };
  return { dir, files };
}

function watchdog(files) {
  const sent = [];
  const tick = (now) => listenWatchdogTick({ ...files, markerFile: undefined, now, send: async (t) => { sent.push(t); } });
  return { sent, tick };
}

test('recordFetchOk / readLastFetchOk round-trip; missing → null', () => {
  const { files } = sandbox();
  assert.equal(readLastFetchOk(files.lastFetchOkFile), null);
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 });
  assert.equal(readLastFetchOk(files.lastFetchOkFile), T0);
});

test('watchdog: no alert while fresh, none when last-fetch-ok is missing', async () => {
  const { files } = sandbox();
  const { sent, tick } = watchdog(files);
  assert.equal(await tick(T0), null, 'missing file');
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 });
  assert.equal(await tick(T0 + 4 * MIN), null);
  assert.equal(await tick(T0 + 5 * MIN), null, 'exactly 5 min is not yet stale');
  assert.deepEqual(sent, []);
});

test('watchdog: > 5 min → one DM with minutes and poll.lock status, then throttled 30 min', async () => {
  const { files } = sandbox();
  const { sent, tick } = watchdog(files);
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 });
  assert.equal(await tick(T0 + 6 * MIN), 'alert');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^📡 Không ai nghe được Telegram đã 6 phút \(poll\.lock: không có\)\. Gửi tin vẫn chạy\.$/);
  assert.equal(await tick(T0 + 7 * MIN), null);
  assert.equal(await tick(T0 + 35 * MIN), null, '29 min after the alert: still throttled');
  assert.equal(await tick(T0 + 36 * MIN), 'alert', '30 min after the alert: again');
  assert.equal(sent.length, 2);
  assert.match(sent[1], /đã 36 phút/);
});

test('watchdog: throttle survives a restart (state persisted in its own file)', async () => {
  const { files } = sandbox();
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 });
  const a = watchdog(files);
  await a.tick(T0 + 6 * MIN);
  const b = watchdog(files); // "new daemon process": no in-memory state
  assert.equal(await b.tick(T0 + 10 * MIN), null);
  assert.deepEqual(b.sent, []);
});

test('watchdog: the alert shows the poll.lock age and body', async () => {
  const { files } = sandbox();
  const { sent, tick } = watchdog(files);
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 });
  fs.writeFileSync(files.lockFile, `${T0 + 60_000}:123:abc`);
  await tick(T0 + 8 * MIN);
  assert.match(sent[0], /poll\.lock: tuổi 420s, nội dung "1800000060000:123:abc"/);
  fs.writeFileSync(files.lockFile, '');
  assert.match(describePollLock(files.lockFile, Date.now()), /nội dung rỗng/);
});

test('watchdog: fetching resumes after an alert → one recovery line with the outage length', async () => {
  const { files } = sandbox();
  const { sent, tick } = watchdog(files);
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 });
  await tick(T0 + 6 * MIN);
  await tick(T0 + 40 * MIN); // second alert in the same outage
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 + 47 * MIN });
  assert.equal(await tick(T0 + 47 * MIN + 30_000), 'recovered');
  assert.equal(sent.at(-1), '✅ Đã nghe Telegram lại (gián đoạn 47 phút).');
  assert.equal(await tick(T0 + 48 * MIN), null, 'recovery is said once');
  assert.equal(sent.length, 3);
  // A new outage alerts immediately (throttle was cleared by the recovery).
  assert.equal(await tick(T0 + 53 * MIN), 'alert');
});

test('watchdog: a throwing send does not cause a DM every tick', async () => {
  const { files } = sandbox();
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 });
  let calls = 0;
  const send = async () => { calls++; throw new Error('net down'); };
  await assert.rejects(listenWatchdogTick({ ...files, now: T0 + 6 * MIN, send }));
  await listenWatchdogTick({ ...files, now: T0 + 7 * MIN, send });
  assert.equal(calls, 1);
});

test('startListenWatchdog: interval is unref\'d and calls the tick with send', async () => {
  let got = null;
  const t = startListenWatchdog({ send: 'S', everyMs: 5, tick: async (a) => { got = a; } });
  try {
    assert.equal(t.hasRef(), false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.send, 'S');
    assert.equal(typeof got.now, 'number');
  } finally { clearInterval(t); }
});

test('listener warning: none when fresh or missing; after 5 min one line, then at most every 15 min', () => {
  const { files } = sandbox();
  const w = (now) => listenerStaleWarning({ convo: 7, now, lastFetchOkFile: files.lastFetchOkFile, markerFile: files.markerFile });
  assert.equal(w(T0), null, 'never recorded');
  recordFetchOk({ file: files.lastFetchOkFile, now: T0 });
  assert.equal(w(T0 + 5 * MIN), null);
  const line = w(T0 + 6 * MIN);
  assert.equal(line, '[tele-listen] ⚠️ Không ai nghe được Telegram đã 6 phút — listener có thể đang kẹt (không phải prompt, đừng đăng vào topic).');
  assert.equal(w(T0 + 7 * MIN), null);
  assert.equal(w(T0 + 20 * MIN), null, '14 min after the warning');
  assert.match(w(T0 + 21 * MIN), /đã 21 phút/);
  // Per-convo marker: another convo is not throttled by convo 7's marker.
  const other = path.join(path.dirname(files.markerFile), 'listen-warn-8.txt');
  assert.ok(listenerStaleWarning({ convo: 8, now: T0 + 22 * MIN, lastFetchOkFile: files.lastFetchOkFile, markerFile: other }));
});

test('releasePollLock removes only a lock that still carries our token', () => {
  const { files } = sandbox();
  const f = files.lockFile;
  assert.equal(acquirePollLock(f), true);
  const tok = heldPollLockToken(f);
  assert.match(tok, /^\d+:\d+:[0-9a-f]+$/);
  assert.equal(fs.readFileSync(f, 'utf8'), tok);
  // We overran; a peer reclaimed the stale lock and wrote its own token.
  const peer = `${Date.now()}:99999:peer`;
  fs.writeFileSync(f, peer);
  releasePollLock(f);
  assert.equal(fs.readFileSync(f, 'utf8'), peer, 'peer lock kept');
  assert.equal(heldPollLockToken(f), null);
  // Our own lock is released normally.
  fs.unlinkSync(f);
  assert.equal(acquirePollLock(f), true);
  releasePollLock(f);
  assert.equal(fs.existsSync(f), false);
  // Releasing a lock we do not hold is a no-op.
  fs.writeFileSync(f, 'someone else');
  releasePollLock(f);
  assert.ok(fs.existsSync(f));
});

test('the new lock body still ages by its timestamp (stale reclaim from #20 intact)', () => {
  const { files } = sandbox();
  const f = files.lockFile;
  fs.writeFileSync(f, `${Date.now()}:1:x`);
  assert.equal(acquirePollLock(f), false, 'fresh tokened lock is respected');
  fs.writeFileSync(f, `${Date.now() - 31_000}:1:x`);
  assert.equal(acquirePollLock(f), true, 'old tokened lock is reclaimed');
  releasePollLock(f);
});

test('fetchUpdates passes a 20 s abort signal', async () => {
  assert.equal(FETCH_UPDATES_TIMEOUT_MS, 20_000);
  const orig = globalThis.fetch;
  let opts;
  globalThis.fetch = async (_u, o) => { opts = o; return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }; };
  try { assert.deepEqual(await fetchUpdates('T', 1), []); } finally { globalThis.fetch = orig; }
  assert.ok(opts?.signal instanceof AbortSignal);
});
