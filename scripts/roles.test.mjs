import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptData, buildCombinedPromptData } from './tele-listen.mjs';

// RFC 02: roles are a plain { userId: role } object (from projects.json), and
// fromRole resolution uses projects-config.roleFor (unmapped sender → 'member').
// (parseRoles/resolveRole + the TELE_ROLES env map were removed.)

test('buildPromptData: fromRole from roles object', () => {
  const roles = { '7': 'admin' };
  const msg = { message_id: 1, chat: { id: -100 }, from: { id: 7, first_name: 'Alice' }, text: 'hi' };
  assert.equal(buildPromptData(msg, null, null, roles).fromRole, 'admin');
});

test('buildPromptData: unmapped sender → member', () => {
  const roles = { '7': 'admin' };
  const msg = { message_id: 1, chat: { id: -100 }, from: { id: 999, first_name: 'X' }, text: 'hi' };
  assert.equal(buildPromptData(msg, null, null, roles).fromRole, 'member');
});

test('buildPromptData: no roles object → member', () => {
  const msg = { message_id: 1, chat: { id: -100 }, from: { id: 7, first_name: 'Alice' }, text: 'hi' };
  assert.equal(buildPromptData(msg).fromRole, 'member');
});

test('buildCombinedPromptData: role of LAST sender (object roles)', () => {
  const roles = { '2': 'dev' };
  const mk = (id, name) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: name }, text: `m${id}` } });
  const out = buildCombinedPromptData([mk(1, 'Alice'), mk(2, 'Nam')], null, null, roles);
  assert.equal(out.fromRole, 'dev');
});
