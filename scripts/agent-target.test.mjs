import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentTarget, normalizeAgentName, HASHTAG_RE } from './agent-target.mjs';

test('parseAgentTarget: pid / name / hashtag / convoId, in that order', () => {
  assert.deepEqual(parseAgentTarget('pid:830318'), { kind: 'pid', value: 830318 });
  assert.deepEqual(parseAgentTarget('PID: 42'), { kind: 'pid', value: 42 });
  assert.match(parseAgentTarget('pid:abc').error, /bad pid target/);
  assert.match(parseAgentTarget('pid:1').error, /bad pid target/);
  assert.deepEqual(parseAgentTarget('#E5424020'), { kind: 'hashtag', value: 'e5424020' });
  assert.deepEqual(parseAgentTarget('e5424020'), { kind: 'hashtag', value: 'e5424020' });
  assert.deepEqual(parseAgentTarget('t1234'), { kind: 'hashtag', value: 't1234' });
  assert.deepEqual(parseAgentTarget('2205483045424020'), { kind: 'convoId', value: '2205483045424020' });
  assert.deepEqual(parseAgentTarget(' 🐍 Rắn 3 '), { kind: 'name', value: '🐍 Rắn 3' });
  assert.deepEqual(parseAgentTarget('elephant'), { kind: 'name', value: 'elephant' }, 'an 8-letter word is not a hashtag');
  assert.deepEqual(parseAgentTarget(''), { kind: 'name', value: '' });
});

test('parseAgentTarget: name: only rules out a pid (name:#hashtag stays a hashtag)', () => {
  assert.deepEqual(parseAgentTarget('name:Ma'), { kind: 'name', value: 'Ma' });
  assert.deepEqual(parseAgentTarget('name: #c2383556'), { kind: 'hashtag', value: 'c2383556' });
  assert.deepEqual(parseAgentTarget('name:pid:5'), { kind: 'name', value: 'pid:5' });
  assert.deepEqual(parseAgentTarget('name:'), { kind: 'name', value: '' });
});

test('normalizeAgentName / HASHTAG_RE', () => {
  assert.equal(normalizeAgentName(' 🐍  Rắn   3 '), 'rắn 3');
  assert.ok(HASHTAG_RE.test('a7611284') && HASHTAG_RE.test('t12') && !HASHTAG_RE.test('k7611284') && !HASHTAG_RE.test('a761128'));
});
