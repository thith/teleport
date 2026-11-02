import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PERSONA_POOL } from './persona.mjs';
import { normalizeAgentName, parseAgentTarget } from './agent-target.mjs';
import { normalizeTarget, matchTarget } from './handover.mjs';
import { resolveRecipient } from './mailbox.mjs';
import { matchSteerName, resolveSteerTargetRaw } from './steer.mjs';
import { findTypeTarget } from './type-cmd.mjs';
import { findResumeTarget } from './resume.mjs';
import { resolveAttachTarget, matchProcsByName } from './spawn.mjs';
import { resolveSessionNames } from './session-name.mjs';
import { parse } from './teleport-cli.mjs';

const aliases = JSON.parse(readFileSync(new URL('./persona-aliases.json', import.meta.url), 'utf8'));
const convoId = '12345678901780';
const hashtag = 'a1111780';
const sessionId = '00000000-0000-4000-8000-000000000001';
const screen = `tele-${hashtag}`;

test('all 110 aliases resolve through CLI, daemon and agent command name paths, including numbered personas', () => {
  assert.equal(Object.keys(aliases).length, PERSONA_POOL.length);
  assert.equal(new Set(Object.values(aliases)).size, PERSONA_POOL.length);
  assert.deepEqual(new Set(Object.values(aliases)), new Set(PERSONA_POOL.map(p => p.name)));
  for (const [alias, name] of Object.entries(aliases)) {
    assert.match(alias, /^[a-z ]+$/);
    for (const suffix of ['', ' 2']) {
      const query = alias.toUpperCase() + suffix;
      const persona = { name: name + suffix, emoji: '🐛' };
      const display = `${persona.emoji} ${persona.name}`;
      const personaOf = () => display;
      const topic = { convoId, hashtag, persona, ts: 1 };
      const proc = { pid: 20, ppid: 10, screenPid: 10, screen, sessionId, hashtag, name: 'worker', procStart: '1' };
      assert.equal(normalizeAgentName(query), normalizeAgentName(display), query);
      assert.equal(matchTarget(normalizeTarget(query), [topic]).match.convoId, convoId, `ask/handover ${query}`);
      assert.equal(resolveRecipient(query, [{ convoId, hashtag, name: display, persona }]).convoId, convoId, `mailbox ${query}`);
      assert.equal(matchSteerName(query, [topic]).match.convoId, convoId, `whisper/instruct ${query}`);
      assert.equal(resolveSteerTargetRaw(`"${query}" hello`, { live: [topic], usage: 'usage' }).match.convoId, convoId);
      assert.equal(findTypeTarget(query, [proc], personaOf).row.pid, 20, `type/compact/nudge ${query}`);
      assert.equal(findResumeTarget(query, [{ sessionId, hashtag, persona: display, mtimeMs: Date.now() }]).target.sessionId, sessionId, `resume ${query}`);
      assert.equal(resolveAttachTarget(query, [{ pid: '10', name: screen }], { procs: [proc], personaOf }).name, screen, `attach ${query}`);
      assert.equal(matchProcsByName(query, [proc], personaOf).pid, 20, `kill ${query}`);
      assert.equal(resolveSessionNames(query, [proc], personaOf)[0].pid, 20, `session-name ${query}`);
      assert.deepEqual(parse(['attach', ...query.split(' ')]).args, ['--attach', query]);
      assert.deepEqual(parse(['resume', ...query.split(' ')]).args, [query]);
    }
  }
});

test('aliases retain ambiguity, topic-only and exact-address rules', () => {
  const a = { convoId, hashtag, persona: { name: 'Sâu' }, ts: 1 };
  const b = { ...a, convoId: '99999999999999', hashtag: 'b2222780', ts: 2 };
  assert.equal(matchTarget(normalizeTarget('sau'), [a, b]).match.convoId, b.convoId);
  assert.equal(matchSteerName('sau', [a, b]).status, 'ambiguous');
  assert.equal(matchTarget(normalizeTarget('sau'), [{ ...a, source: 'alive' }]).status, 'not_found');
  assert.equal(matchSteerName('sau', [{ ...a, source: 'alive' }]).status, 'not_found');
  assert.equal(resolveRecipient('sau', [a, b]).ambiguous.length, 2);
  assert.equal(matchTarget(normalizeTarget('#sau'), [a]).status, 'not_found');
  assert.equal(matchTarget(normalizeTarget('780'), [a, b]).status, 'ambiguous');
  assert.deepEqual(parseAgentTarget('sau'), { kind: 'name', value: 'sau' });
  assert.deepEqual(parseAgentTarget('780'), { kind: 'tail', value: '780' });
  assert.deepEqual(parseAgentTarget('t12'), { kind: 'hashtag', value: 't12' });
  assert.ok(parse(['kill', 'sau']).error, 'terminal kill remains full-hashtag-only');
  assert.equal(normalizeAgentName('custom session'), 'custom session');
  assert.equal(normalizeAgentName('wolf'), 'wolf', 'English aliases are not added');
  assert.equal(normalizeAgentName('constructor'), 'constructor', 'object prototype keys are not aliases');
});
