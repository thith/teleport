import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAskArgs, buildAskPrompt, buildReplyPrompt, readText, planAsk,
  inactivityNote,
} from './ask.mjs';
import { EXIT } from './handover.mjs';

test('parseAskArgs: --to + --reply + --from-convo (space/=) + inline text', () => {
  assert.deepEqual(parseAskArgs(['--to', 'Cú', '--from-convo', '111']), { to: 'Cú', reply: false, fromConvo: '111', text: null, error: null });
  const r = parseAskArgs(['--reply', '--to=222', 'the answer']);
  assert.equal(r.reply, true); assert.equal(r.to, '222'); assert.equal(r.text, 'the answer');
});

test('parseAskArgs: errors on missing --to and bad --from-convo', () => {
  assert.match(parseAskArgs(['hello']).error, /missing --to/);
  assert.match(parseAskArgs(['--to', 'X', '--from-convo', 'abc']).error, /positive integer/);
});

test('readText: inline arg wins; else stdin via injected reader', () => {
  assert.equal(readText({ text: 'inline q' }), 'inline q');
  assert.equal(readText({ text: null }, { stdinIsTTY: false, readFileSync: () => 'piped q' }), 'piped q');
  assert.equal(readText({ text: '   ' }, { stdinIsTTY: true }), ''); // blank inline + TTY → empty (usage error)
});

test('buildAskPrompt: shape — ask field, non-privileged role, no real message', () => {
  const p = buildAskPrompt({ targetConvoId: '111', targetChatId: '-100', sourceConvoId: '999', question: '  tone?  ', nowSec: 1 });
  assert.equal(p.fromRole, 'agent-ask');
  assert.equal(p.messageId, null);
  assert.equal(p.fromMember, null);
  assert.equal(p.fromUserId, null);
  assert.deepEqual(p.attachments, []);
  assert.equal(p.ask.question, 'tone?');               // trimmed
  assert.equal(p.ask.replyTo, '999');                  // answer goes back to the asker
  assert.equal(p.ask.from.convoId, '999');
  assert.ok(!('askReply' in p));
  assert.match(p.text, /hỏi bạn/);
  assert.match(p.text, /--reply --to 999/);            // tells B how to answer
});

test('buildReplyPrompt: shape — askReply field, the answer', () => {
  const p = buildReplyPrompt({ targetConvoId: '999', targetChatId: '-100', sourceConvoId: '111', answer: 'ấm, thẳng', nowSec: 1 });
  assert.equal(p.fromRole, 'agent-ask');
  assert.equal(p.messageId, null);
  assert.equal(p.askReply.answer, 'ấm, thẳng');
  assert.equal(p.askReply.from.convoId, '111');
  assert.ok(!('ask' in p));
});

// Scope guard: target resolved ONLY within the asker's own group.
const STORE = { 'G1': { '111': 55, _ts: { '111': 100 } }, 'G2': { '222': 66, _ts: { '222': 100 } } };
const depsInGroup = (chatIds) => ({ readTopicsStore: () => STORE, resolveChatIds: () => ({ chatIds }) });

test('planAsk: cross-group target is NOT_FOUND (security scope guard)', () => {
  // Asker is in G1; tries to ask convo 222 which lives in G2 → forbidden.
  const r = planAsk({ args: { to: 'convo:222', reply: false }, sourceConvoId: '111', text: 'q', nowSec: 1, deps: depsInGroup(['G1']) });
  assert.equal(r.code, EXIT.NOT_FOUND);
  assert.match(r.message, /cross-group ask is forbidden/);
});

test('planAsk: same-group target resolves and builds an ASK prompt', () => {
  // Asker (convo 999, group G1) asks convo 111 (also G1).
  const r = planAsk({ args: { to: 'convo:111', reply: false }, sourceConvoId: '999', text: 'tone?', nowSec: 1, deps: depsInGroup(['G1']) });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.match.convoId, '111');
  assert.match(r.promptFile, /prompt-convo-111\.json$/);
  assert.equal(r.promptObj.ask.question, 'tone?');
});

test('planAsk: reply mode builds an askReply prompt back to the asker', () => {
  // B (convo 111) replies to A (convo 222) — but A must be in B's group; put A in G1.
  const store = { 'G1': { '111': 55, '222': 77, _ts: {} } };
  const r = planAsk({ args: { to: 'convo:222', reply: true }, sourceConvoId: '111', text: 'answer', nowSec: 1,
    deps: { readTopicsStore: () => store, resolveChatIds: () => ({ chatIds: ['G1'] }) } });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.promptObj.askReply.answer, 'answer');
  assert.match(r.promptFile, /prompt-convo-222\.json$/);
});

test('planAsk: asking yourself → USAGE (no self-inject)', () => {
  const store = { 'G1': { '111': 55, _ts: {} } };
  const r = planAsk({ args: { to: 'convo:111', reply: false }, sourceConvoId: '111', text: 'q', nowSec: 1,
    deps: { readTopicsStore: () => store, resolveChatIds: () => ({ chatIds: ['G1'] }) } });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.message, /cannot ask yourself/);
});

test('planAsk: no admin chat configured → USAGE', () => {
  const r = planAsk({ args: { to: 'X', reply: false }, sourceConvoId: '1', text: 'q', nowSec: 1,
    deps: { readTopicsStore: () => ({}), resolveChatIds: () => ({ chatIds: [] }) } });
  assert.equal(r.code, EXIT.USAGE);
});

// RFC 03 §5.1: T1 auto-retry + T3 RETRY-LATER removed — ask now coalesces via
// mergeOrSpoolPrompt (durable, non-blocking), so a busy target never bounces.
// The merge/spool behavior is covered by p3-append.test.mjs (mergeOrSpoolPrompt).

// ── T2: non-gating liveness advisory (kept) ───────────────────────────────────

test('inactivityNote: fresh heartbeat → null (no advisory)', () => {
  const now = 1_000_000;
  const note = inactivityNote({ convoId: '111', hashtag: 'abcd', now, freshMs: 30 * 60 * 1000,
    deps: { getLastAliveMs: () => now - 60 * 1000 } }); // touched 1 min ago
  assert.equal(note, null);
});

test('inactivityNote: stale heartbeat → advisory with minutes', () => {
  const now = 100 * 60 * 1000;
  const note = inactivityNote({ convoId: '111', hashtag: 'abcd', now, freshMs: 30 * 60 * 1000,
    deps: { getLastAliveMs: () => now - 45 * 60 * 1000 } }); // touched 45 min ago
  assert.match(note, /#abcd/);
  assert.match(note, /~45 phút/);
  assert.match(note, /không active/);
});

test('inactivityNote: no heartbeat at all → advisory names absent listener', () => {
  const note = inactivityNote({ convoId: '111', hashtag: 'abcd', now: 1_000_000, freshMs: 30 * 60 * 1000,
    deps: { getLastAliveMs: () => null } });
  assert.match(note, /không thấy listener/);
});

test('planAsk: routes with the SAME (numeric) convo it attributes to', () => {
  let seen;
  const deps = { ...depsInGroup(['G1']), resolveChatIds: (o) => { seen = o; return { chatIds: ['G1'] }; } };
  planAsk({ args: { to: 'convo:111', reply: false }, sourceConvoId: '999', text: 'q', nowSec: 1, deps });
  assert.strictEqual(seen.convoId, 999);
});

test('planAsk (RFC 28): a 3-digit tail resolves inside the asker\'s own group only; a tail of another group is NOT_FOUND', () => {
  const ok = planAsk({ args: { to: '111', reply: false }, sourceConvoId: '999', text: 'q', nowSec: 1, deps: depsInGroup(['G1']) });
  assert.equal(ok.code, EXIT.OK); assert.equal(ok.match.convoId, '111');
  const far = planAsk({ args: { to: '222', reply: false }, sourceConvoId: '999', text: 'q', nowSec: 1, deps: depsInGroup(['G1']) });
  assert.equal(far.code, EXIT.NOT_FOUND);
  const store = { G1: { '3552300954451780': 5, '1111111112222780': 6 } };
  const amb = planAsk({ args: { to: '780', reply: false }, sourceConvoId: '999', text: 'q', nowSec: 1, deps: { readTopicsStore: () => store, resolveChatIds: () => ({ chatIds: ['G1'] }) } });
  assert.equal(amb.code, EXIT.AMBIGUOUS);
});
