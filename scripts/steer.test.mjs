import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRawTarget, matchSteerName, resolveSteerTargetRaw, resolveSteerTarget, doSteer } from './steer.mjs';
import { shortConvoHash } from './send-telegram.mjs';

const row = (convoId, name, extra = {}) => ({ chatId: '-100', convoId, threadId: 1, ts: 0, persona: name ? { emoji: '🐉', name } : null, hashtag: shortConvoHash(convoId), ...extra });
const A = '12345678901234', B = '98765432109876', C = '55555555555555';
const LIVE = [row(A, 'Cà Rồng', { ts: 5 }), row(B, 'my_agent'), row(C, 'Mèo')];

test('splitRawTarget: first token (quoted: ASCII or curly, matching close) + the rest verbatim', () => {
  assert.deepEqual(splitRawTarget('Mèo  làm "tiếp"\nđi'), { token: 'Mèo', quoted: false, text: 'làm "tiếp"\nđi' });
  assert.deepEqual(splitRawTarget('"Cà Rồng" it\'s ok'), { token: 'Cà Rồng', quoted: true, text: "it's ok" });
  assert.deepEqual(splitRawTarget('“Cà Rồng” xin chào'), { token: 'Cà Rồng', quoted: true, text: 'xin chào' });
  assert.deepEqual(splitRawTarget('‘Cà Rồng’ x'), { token: 'Cà Rồng', quoted: true, text: 'x' });
  assert.match(splitRawTarget('“Cà Rồng" x').error, /thiếu dấu đóng ”/, 'the close must match the open');
  assert.match(splitRawTarget('"Cà Rồng x').error, /thiếu dấu đóng/);
  assert.deepEqual(splitRawTarget('   '), { token: '', quoted: false, text: '' });
});

test('matchSteerName: literal tier, then normalized (`_` = space); two convos with one name → ambiguous', () => {
  assert.equal(matchSteerName('Cà_Rồng', LIVE).match.convoId, A);
  assert.equal(matchSteerName('cà rồng', LIVE).match.convoId, A);
  assert.equal(matchSteerName('my_agent', LIVE).match.convoId, B, 'literal first');
  assert.equal(matchSteerName('nobody', LIVE).status, 'not_found');
  const dup = [...LIVE, row('77777777777777', 'Mèo', { ts: 99 })];
  assert.equal(matchSteerName('Mèo', dup).status, 'ambiguous', 'never pick the newest for a private message');
  assert.equal(matchSteerName('Mèo', [row(C, 'Mèo'), row(C, 'Mèo', { chatId: '-200' })]).status, 'found', 'one convo in two groups is not a duplicate');
  assert.equal(matchSteerName('Mèo', [row(C, 'Mèo', { source: 'alive' })]).status, 'not_found', 'alive-only rows: by hashtag only');
});

test('resolveSteerTargetRaw: # explicit; reply → ALL text; else quoted / `_` target; text verbatim', () => {
  const opts = (replyText = null) => ({ live: LIVE, replyText, usage: 'U' });
  const hA = shortConvoHash(A);
  assert.deepEqual(resolveSteerTargetRaw(`#${hA} it's\n  fine`, opts()), { match: LIVE[0], text: "it's\n  fine" });
  assert.match(resolveSteerTargetRaw('#zzz hi', opts(`… #${hA}`)).error, /not found/, 'an explicit # never falls to the reply');
  assert.deepEqual(resolveSteerTargetRaw('"Cà Rồng" xin chào', opts(`ack #${shortConvoHash(C)}`)), { match: LIVE[2], text: '"Cà Rồng" xin chào' }, 'reply mode: quotes mean nothing');
  assert.deepEqual(resolveSteerTargetRaw('“Cà Rồng” xin "chào"', opts()), { match: LIVE[0], text: 'xin "chào"' });
  assert.deepEqual(resolveSteerTargetRaw('Cà_Rồng hi', opts()), { match: LIVE[0], text: 'hi' });
  assert.match(resolveSteerTargetRaw('"Cà Rồng hi', opts()).error, /thiếu dấu đóng/);
  assert.deepEqual(resolveSteerTargetRaw('“please continue', opts(`ack #${shortConvoHash(C)}`)), { match: LIVE[2], text: '“please continue' }, 'reply mode: an unclosed quote is just text');
  assert.match(resolveSteerTargetRaw('Cà Rồng hi', opts()).error, /Cà not found/, 'unquoted: the first word only');
  const dup = [...LIVE, row('77777777777777', 'Mèo', { ts: 99 })];
  assert.match(resolveSteerTargetRaw('Mèo hi', { live: dup, usage: 'U' }).error, /ambiguous .*#.*— dùng #hashtag/);
  assert.equal(resolveSteerTargetRaw('', opts()).error, 'U');
  const twin = [row(A, 'X'), { ...row(B, 'Y'), hashtag: shortConvoHash(A) }];
  assert.match(resolveSteerTargetRaw(`#${shortConvoHash(A)} hi`, { live: twin, usage: 'U' }).error, new RegExp(`ambiguous \\((${A}|${B}), (${A}|${B})\\) — dùng convoId`), 'a shared hashtag lists convoIds');
});

test('resolveSteerTarget (argv, manual run): a duplicate persona name is refused too', () => {
  const dup = [...LIVE, row('77777777777777', 'Mèo', { ts: 99 })];
  assert.match(resolveSteerTarget(['Mèo', 'hi'], { live: dup, usage: 'U' }).error, /ambiguous/);
  assert.equal(resolveSteerTarget(['Cà_Rồng', 'hi'], { live: LIVE, usage: 'U' }).match.convoId, A);
});

test('doSteer: raw (TELE_RAW_ARGS) wins over the tokenized argv — newlines and quotes reach the prompt', async () => {
  const writes = [];
  const store = { '-100': { [A]: 7 } };
  const res = await doSteer(['ignored'], { flag: 'whisper', usage: 'U', ack: () => 'ok' }, {
    from: { id: '7', role: 'admin' }, config: { _default: { chatId: '-100' } }, store, tmpDir: '/t', replyText: '',
    raw: `${A} dòng 1\n"dòng 2" it's`, writePrompt: (p) => writes.push(p),
  });
  assert.equal(res.ok, true, res.message);
  assert.equal(writes[0].text, `dòng 1\n"dòng 2" it's`);
});
