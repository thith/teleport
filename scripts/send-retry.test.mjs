import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWithRetry, TRANSIENT_SEND_STATUSES } from './send-telegram.mjs';

const noSleep = async () => {};

test('first success returns immediately, no retry', async () => {
  let calls = 0;
  const res = await sendWithRetry(async () => { calls++; return { ok: true, status: 200, messageId: 1 }; }, { sleepFn: noSleep });
  assert.equal(calls, 1);
  assert.equal(res.ok, true);
  assert.equal(res.messageId, 1);
});

test('504 then success — retries once', async () => {
  const seq = [
    { ok: false, status: 504, description: 'Gateway Timeout' },
    { ok: true, status: 200, messageId: 7 },
  ];
  let calls = 0;
  const sleeps = [];
  const res = await sendWithRetry(async () => seq[calls++], { sleepFn: async (ms) => { sleeps.push(ms); } });
  assert.equal(calls, 2);
  assert.equal(res.ok, true);
  assert.equal(res.messageId, 7);
  assert.deepEqual(sleeps, [500]); // non-429 transient uses default backoff schedule
});

test('permanent error (400) is NOT retried', async () => {
  let calls = 0;
  const res = await sendWithRetry(async () => { calls++; return { ok: false, status: 400, description: 'Bad Request' }; }, { sleepFn: noSleep });
  assert.equal(calls, 1);
  assert.equal(res.status, 400);
});

test('exhausts attempts on persistent transient, returns last result', async () => {
  let calls = 0;
  const sleeps = [];
  const res = await sendWithRetry(
    async () => { calls++; return { ok: false, status: 503, description: 'unavailable' }; },
    { attempts: 3, sleepFn: async (ms) => { sleeps.push(ms); } },
  );
  assert.equal(calls, 3);
  assert.equal(res.status, 503);
  assert.deepEqual(sleeps, [500, 1500]); // i=0→500, i=1→1500 (clamp), last iter no sleep
});

test('attempts <= 0 is clamped to 1 (never returns undefined)', async () => {
  let calls = 0;
  const res = await sendWithRetry(async () => { calls++; return { ok: true, status: 200, messageId: 5 }; }, { attempts: 0, sleepFn: noSleep });
  assert.equal(calls, 1);
  assert.equal(res.messageId, 5);
});

test('429 with retry_after <= 0 falls back to backoff (no hot retry)', async () => {
  const seq = [
    { ok: false, status: 429, retryAfter: 0, description: 'Too Many Requests' },
    { ok: true, status: 200, messageId: 6 },
  ];
  let calls = 0;
  const sleeps = [];
  await sendWithRetry(async () => seq[calls++], { sleepFn: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [500]); // retryAfter 0 ignored → default backoff, not a 0ms hot retry
});

test('network throw on every attempt rethrows last error', async () => {
  let calls = 0;
  await assert.rejects(
    sendWithRetry(async () => { calls++; throw new Error('ECONNRESET'); }, { attempts: 2, sleepFn: noSleep }),
    /ECONNRESET/,
  );
  assert.equal(calls, 2);
});

test('network throw then success', async () => {
  let calls = 0;
  const res = await sendWithRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('network blip');
    return { ok: true, status: 200, messageId: 9 };
  }, { sleepFn: noSleep });
  assert.equal(calls, 2);
  assert.equal(res.messageId, 9);
});

test('429 honors retry_after (seconds → ms, capped)', async () => {
  const seq = [
    { ok: false, status: 429, retryAfter: 2, description: 'Too Many Requests' },
    { ok: true, status: 200, messageId: 3 },
  ];
  let calls = 0;
  const sleeps = [];
  const res = await sendWithRetry(async () => seq[calls++], { sleepFn: async (ms) => { sleeps.push(ms); } });
  assert.equal(res.ok, true);
  assert.deepEqual(sleeps, [2000]);
});

test('429 retry_after is capped at MAX_RETRY_AFTER_MS', async () => {
  const seq = [
    { ok: false, status: 429, retryAfter: 9999, description: 'Too Many Requests' },
    { ok: true, status: 200, messageId: 4 },
  ];
  let calls = 0;
  const sleeps = [];
  await sendWithRetry(async () => seq[calls++], { sleepFn: async (ms) => { sleeps.push(ms); } });
  assert.equal(sleeps[0], 8000);
});

test('TRANSIENT_SEND_STATUSES covers gateway + rate-limit, not 400', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.ok(TRANSIENT_SEND_STATUSES.has(s));
  assert.ok(!TRANSIENT_SEND_STATUSES.has(400));
  assert.ok(!TRANSIENT_SEND_STATUSES.has(200));
});
