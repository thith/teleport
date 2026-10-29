import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentTarget, normalizeAgentName, HASHTAG_RE, resolveTail } from './agent-target.mjs';

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

test('parseAgentTarget (RFC 28): exactly 3 digits = tail; name:780 too; 4+ digits = convoId; #780 = hashtag; convo:<id> = explicit convoId', () => {
  assert.deepEqual(parseAgentTarget('780'), { kind: 'tail', value: '780' });
  assert.deepEqual(parseAgentTarget('name:780'), { kind: 'tail', value: '780' });
  assert.deepEqual(parseAgentTarget(' 780 '), { kind: 'tail', value: '780' });
  assert.deepEqual(parseAgentTarget('1234'), { kind: 'convoId', value: '1234' });
  assert.deepEqual(parseAgentTarget('78'), { kind: 'convoId', value: '78' });
  assert.deepEqual(parseAgentTarget('#780'), { kind: 'hashtag', value: '780' });
  assert.deepEqual(parseAgentTarget('convo:780'), { kind: 'convoId', value: '780' });
  assert.deepEqual(parseAgentTarget('CONVO: 3552300954451780'), { kind: 'convoId', value: '3552300954451780' });
  assert.match(parseAgentTarget('convo:abc').error, /bad convo target/);
  assert.equal(parseAgentTarget('convo:0').value, '', 'a convoId has no leading zero');
  assert.deepEqual(parseAgentTarget('t12'), { kind: 'hashtag', value: 't12' }, 'letter+digit stays a hashtag');
});

test('resolveTail: none / one hashtag / several hashtags (listed with their label); the same hashtag twice is one', () => {
  const ids = [{ hashtag: 'f4451780', persona: 'Sứa' }, { hashtag: 'b2222222' }, { hashtag: 'F4451780' }, { hashtag: null }];
  const label = (x) => `${x.persona || '?'} #${x.hashtag}`;
  assert.deepEqual(resolveTail('999', ids, label), { none: true });
  assert.deepEqual(resolveTail('780', ids, label), { hashtag: 'f4451780' });
  assert.deepEqual(resolveTail('780', [], label), { none: true });
  const r = resolveTail('780', [...ids, { hashtag: 'b2222780', persona: 'Cáo' }], label);
  assert.match(r.error, /"780" khớp 2 agent/);
  assert.match(r.error, /Sứa #f4451780/); assert.match(r.error, /Cáo #b2222780/);
  assert.match(r.error, /hashtag đầy đủ/);
  assert.equal(r.hashtag, undefined);
});
