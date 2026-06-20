import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPending } from './pending.mjs';

test('renderPending: returns a string for an empty store (no convos waiting)', () => {
  const out = renderPending({ store: {}, now: 1000 });
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});
