import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCswap } from './cswap.mjs';

test('planCswap: no args → --list', () => {
  assert.deepEqual(planCswap([]), { argv: ['--list'] });
});

test('planCswap: numeric target → --switch-to <n>', () => {
  assert.deepEqual(planCswap(['2']), { argv: ['--switch-to', '2'] });
});

test('planCswap: email target passes through verbatim (cswap itself validates NUM|EMAIL)', () => {
  assert.deepEqual(planCswap(['a@b.com']), { argv: ['--switch-to', 'a@b.com'] });
});

test('planCswap: only the first token is used as target', () => {
  assert.deepEqual(planCswap(['2', 'extra']), { argv: ['--switch-to', '2'] });
});
