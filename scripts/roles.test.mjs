import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoles, resolveRole, buildPromptData, buildCombinedPromptData } from './tele-listen.mjs';

test('parseRoles: basic mapping', () => {
  const m = parseRoles('144242180:admin, 555:dev');
  assert.equal(m.get('144242180'), 'admin');
  assert.equal(m.get('555'), 'dev');
  assert.equal(m.size, 2);
});

test('parseRoles: empty / null → empty map', () => {
  assert.equal(parseRoles('').size, 0);
  assert.equal(parseRoles(null).size, 0);
  assert.equal(parseRoles(undefined).size, 0);
});

test('parseRoles: skips malformed pairs', () => {
  const m = parseRoles('garbage, 7:dev, :nope, alsobad');
  assert.equal(m.size, 1);
  assert.equal(m.get('7'), 'dev');
});

test('resolveRole: mapped and unmapped', () => {
  const m = parseRoles('7:admin');
  assert.equal(resolveRole(m, 7), 'admin');
  assert.equal(resolveRole(m, '7'), 'admin');
  assert.equal(resolveRole(m, 999), null);
  assert.equal(resolveRole(null, 7), null);
});

test('buildPromptData includes fromRole from roles map', () => {
  const roles = parseRoles('7:admin');
  const msg = { message_id: 1, chat: { id: -100 }, from: { id: 7, first_name: 'Thi' }, text: 'hi' };
  assert.equal(buildPromptData(msg, null, null, roles).fromRole, 'admin');
});

test('buildPromptData fromRole null without roles', () => {
  const msg = { message_id: 1, chat: { id: -100 }, from: { id: 7, first_name: 'Thi' }, text: 'hi' };
  assert.equal(buildPromptData(msg).fromRole, null);
});

test('buildCombinedPromptData resolves role of last sender', () => {
  const roles = parseRoles('2:dev');
  const mk = (id, name) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: name }, text: `m${id}` } });
  const out = buildCombinedPromptData([mk(1, 'Thi'), mk(2, 'Nam')], null, null, roles);
  assert.equal(out.fromRole, 'dev');
});
