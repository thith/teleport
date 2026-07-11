import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
// Isolate the persona pin store (resolved at call-time from TELE_PERSONA_STORE)
// so these tests DERIVE personas instead of reading machine-local pins.
process.env.TELE_PERSONA_STORE = path.join(os.tmpdir(), `teleport-persona-store-attribution-${process.pid}.jsonl`);
import { formatFromName, buildPromptData, buildCombinedPromptData } from './tele-listen.mjs';
import { personaForConvo } from './persona.mjs';

test('formatFromName: full name from first + last', () => {
  assert.equal(formatFromName({ first_name: 'Thi', last_name: 'Truong' }), 'Thi Truong');
});

test('formatFromName: first name only', () => {
  assert.equal(formatFromName({ first_name: 'Thi' }), 'Thi');
});

test('formatFromName: falls back to @username', () => {
  assert.equal(formatFromName({ username: 'thith' }), '@thith');
});

test('formatFromName: null when no identity', () => {
  assert.equal(formatFromName({}), null);
  assert.equal(formatFromName(null), null);
});

test('buildPromptData includes fromName', () => {
  const msg = { message_id: 1, chat: { id: -100 }, from: { id: 7, first_name: 'Thi' }, text: 'hi' };
  const out = buildPromptData(msg);
  assert.equal(out.fromName, 'Thi');
  assert.equal(out.fromUserId, '7');
});

test('buildCombinedPromptData uses last sender for fromName; text attributes each sender (P2)', () => {
  const mk = (id, name) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id: id, first_name: name }, text: `m${id}` } });
  const out = buildCombinedPromptData([mk(1, 'Thi'), mk(2, 'Nam')]);
  assert.equal(out.fromName, 'Nam');                 // top-level metadata = last sender (UNCHANGED)
  assert.doesNotMatch(out.text, /Admin follow-up/);  // old blanket label removed
  assert.match(out.text, /Thi \(member\): m1/);      // no roles → default 'member'
  assert.match(out.text, /Nam \(member\): m2/);
});

test('buildCombinedPromptData: multi-msg attributes real name + role from roles config (P2)', () => {
  const mk = (id, name) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: name }, text: `m${id}` } });
  const roles = { 1: { role: 'admin' }, 2: { role: 'member' } };
  const out = buildCombinedPromptData([mk(1, 'Thi'), mk(2, 'Nam')], null, null, roles);
  assert.match(out.text, /Thi \(admin\): m1/);       // authority now visible: admin ≠ member
  assert.match(out.text, /Nam \(member\): m2/);
});

test('buildCombinedPromptData: single message text is bare — no attribution prefix (common case unchanged)', () => {
  const mk = (id, name) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: name }, text: `m${id}` } });
  assert.equal(buildCombinedPromptData([mk(1, 'Thi')]).text, 'm1');
});

// Forum phantom-reply: Telegram sets reply_to_message → the topic-creation
// service message for EVERY message in a topic. That is NOT a real reply, so it
// must not surface as bogus reply context to the agent.
test('buildPromptData: forum phantom reply_to is suppressed', () => {
  const msg = {
    message_id: 95, chat: { id: -100 }, from: { id: 7, first_name: 'Thi' }, text: 'hi',
    reply_to_message: { message_id: 93, forum_topic_created: { name: '🐍 Rắn' } },
  };
  const out = buildPromptData(msg);
  assert.equal(out.replyToMessageId, null);
  assert.equal(out.replyToText, null);
});

test('buildPromptData: a genuine reply is preserved as context', () => {
  const msg = {
    message_id: 96, chat: { id: -100 }, from: { id: 7, first_name: 'Thi' }, text: 'theo ý đó',
    reply_to_message: { message_id: 50, text: 'đề xuất A' },
  };
  const out = buildPromptData(msg);
  assert.equal(out.replyToMessageId, 50);
  assert.equal(out.replyToText, 'đề xuất A');
});

test('buildCombinedPromptData: phantom suppressed, real reply kept (from last msg)', () => {
  const phantom = { message_id: 93, forum_topic_created: { name: 'x' } };
  const mk = (id, replyTo) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: 'Thi' }, text: `m${id}`, reply_to_message: replyTo } });

  const allPhantom = buildCombinedPromptData([mk(1, phantom), mk(2, phantom)]);
  assert.equal(allPhantom.replyToMessageId, null);
  assert.equal(allPhantom.replyToText, null);

  const lastReal = buildCombinedPromptData([mk(1, phantom), mk(2, { message_id: 50, text: 'gốc' })]);
  assert.equal(lastReal.replyToMessageId, 50);
  assert.equal(lastReal.replyToText, 'gốc');
});

// RFC 04: the agent's own persona is injected into the inbound prompt so it can
// self-identify and recognize when a human addresses it by name.
test('buildCombinedPromptData: injects own persona when convoId is known', () => {
  const mk = (id) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: 'Thi' }, text: `m${id}` } });
  const convoId = 2120524005926900; // → 🐧 Cánh Cụt (index 26) on the 110-pool
  const out = buildCombinedPromptData([mk(1)], null, convoId);
  assert.deepEqual(out.persona, personaForConvo(convoId));
  assert.equal(out.persona.name, 'Cánh Cụt');
  assert.equal(out.persona.emoji, '🐧');
});

test('buildCombinedPromptData: no persona field when convoId absent', () => {
  const mk = (id) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: 'Thi' }, text: `m${id}` } });
  const out = buildCombinedPromptData([mk(1)]);
  assert.equal(out.convoId, undefined);
  assert.equal('persona' in out, false);
});

// RFC 02: a project's `description` reaches the agent as prompt `projectDescription`.
test('buildCombinedPromptData: includes projectDescription when provided (trimmed)', () => {
  const mk = (id) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: 'Thi' }, text: `m${id}` } });
  assert.equal(buildCombinedPromptData([mk(1)], null, null, null, 'Backend API + worker').projectDescription, 'Backend API + worker');
  assert.equal(buildCombinedPromptData([mk(1)], null, null, null, '  padded  ').projectDescription, 'padded'); // boundary trim
});

test('buildCombinedPromptData: no projectDescription field when null/absent/blank/non-string', () => {
  const mk = (id) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: 'Thi' }, text: `m${id}` } });
  assert.equal('projectDescription' in buildCombinedPromptData([mk(1)]), false); // arg omitted
  assert.equal('projectDescription' in buildCombinedPromptData([mk(1)], null, null, null, null), false); // explicit null
  assert.equal('projectDescription' in buildCombinedPromptData([mk(1)], null, null, null, '   '), false); // whitespace-only → dropped
  assert.equal('projectDescription' in buildCombinedPromptData([mk(1)], null, null, null, 123), false); // non-string → dropped
});

// RFC 02: member `note` rides fromMember; the builder normalizes it at the boundary
// (keep only a non-empty string) WITHOUT mutating the shared roles config.
test('buildCombinedPromptData: fromMember.note passthrough + boundary sanitization', () => {
  const mk = (id) => ({ msg: { message_id: id, chat: { id: -100 }, from: { id, first_name: 'Thi' }, text: `m${id}` } });
  const roles = { 1: { role: 'maintainer', name: 'Bảo', note: '  review kỹ  ' } };
  assert.equal(buildCombinedPromptData([mk(1)], null, null, roles).fromMember.note, 'review kỹ'); // trimmed passthrough

  // Blank / non-string note → field dropped, and the SHARED roles config is untouched.
  const blankRoles = { 1: { role: 'dev', name: 'X', note: '   ' } };
  assert.equal('note' in buildCombinedPromptData([mk(1)], null, null, blankRoles).fromMember, false);
  assert.equal(blankRoles[1].note, '   '); // source object NOT mutated

  const typedRoles = { 1: { role: 'dev', name: 'Y', note: { a: 1 } } };
  assert.equal('note' in buildCombinedPromptData([mk(1)], null, null, typedRoles).fromMember, false);

  // No note key at all → fromMember passes through untouched.
  const noNote = { 1: { role: 'dev', name: 'Z' } };
  assert.equal('note' in buildCombinedPromptData([mk(1)], null, null, noNote).fromMember, false);
});
