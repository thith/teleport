import { test } from 'node:test';
import assert from 'node:assert/strict';
import { START_BODY } from './start.mjs';

test('START_BODY: non-empty onboarding text mentioning Telegram + setup', () => {
  assert.equal(typeof START_BODY, 'string');
  assert.ok(START_BODY.length > 100);
  assert.match(START_BODY, /Teleport/);
  assert.match(START_BODY, /Topics/);
});
