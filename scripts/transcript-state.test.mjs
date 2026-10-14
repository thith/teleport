import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  turnEnded, contextUsage, formatContext, contextWindowFor, fmtTokens, parseJsonl, readTail, compactAfter, findTranscript,
} from './transcript-state.mjs';

// Line shapes as Claude Code 2.1.300 writes them (RFC 22 §1.1 / real transcripts).
const user = (content, extra = {}) => ({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...extra });
const asst = (usage = { input_tokens: 10, cache_read_input_tokens: 700000, cache_creation_input_tokens: 33000 }, extra = {}) =>
  ({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', usage, content: [] }, ...extra });
const sys = (subtype, extra = {}) => ({ type: 'system', subtype, isSidechain: false, ...extra });
const q = (operation) => ({ type: 'queue-operation', operation });
const toolResult = user([{ type: 'tool_result', content: 'ok' }]);
const noise = [{ type: 'attachment' }, { type: 'mode' }, { type: 'ai-title' }, { type: 'pr-link' }, { type: 'cost-state' }, sys('away_summary'), sys('informational'), { type: 'some-future-type' }];

test('turnEnded: a finished turn (turn_duration / stop_hook_summary), with unknown/meta lines after it', () => {
  assert.equal(turnEnded([user('hi'), asst(), sys('stop_hook_summary'), sys('turn_duration')]), true);
  assert.equal(turnEnded([user('hi'), asst(), sys('turn_duration'), ...noise]), true);
  assert.equal(turnEnded([user('hi'), asst(), sys('stop_hook_summary')]), true);
});

test('turnEnded: mid-turn — assistant / tool_result / a fresh prompt last', () => {
  assert.equal(turnEnded([user('hi'), asst()]), false);
  assert.equal(turnEnded([user('hi'), asst(), toolResult, ...noise]), false);
  assert.equal(turnEnded([sys('turn_duration'), user('next prompt')]), false);
});

test('turnEnded: an Esc interrupt ends the turn (no turn_duration follows)', () => {
  assert.equal(turnEnded([user('go'), asst(), user([{ type: 'text', text: '[Request interrupted by user]' }])]), true);
  assert.equal(turnEnded([user('go'), asst(), user('[Request interrupted by user for tool use]'), { type: 'attachment' }]), true);
});

test('turnEnded: local-command OUTPUT and a compact end the turn; caveat / bare command-name / isMeta prompts do NOT', () => {
  const compactTail = [sys('compact_boundary', { compactMetadata: { trigger: 'manual', postTokens: 8000 } }),
    user('summary…', { isCompactSummary: true }),
    user('<local-command-caveat>Caveat…</local-command-caveat>', { isMeta: true }),
    user('<command-name>/compact</command-name>'),
    user('<local-command-stdout>Compacted</local-command-stdout>'), { type: 'attachment' }];
  assert.equal(turnEnded(compactTail), true);
  assert.equal(turnEnded([sys('turn_duration'), user('<local-command-stderr>x</local-command-stderr>')]), true);
  assert.equal(turnEnded([sys('compact_boundary')]), true);
  assert.equal(turnEnded([sys('turn_duration'), user('<command-name>/review</command-name>')]), false); // prompt-type command: a turn follows
  assert.equal(turnEnded([sys('turn_duration'), user('<local-command-caveat>…</local-command-caveat>', { isMeta: true })]), false);
  assert.equal(turnEnded([sys('turn_duration'), user('Another Claude session sent a message: <agent-message …>', { isMeta: true })]), false);
  assert.equal(turnEnded([sys('turn_duration'), user('BÁO CÁO 8:00 SÁNG…', { isMeta: true })]), false); // cron prompt
});

test('turnEnded: queue — enqueue cancelled by a later dequeue/remove is not pending; a lone enqueue is', () => {
  assert.equal(turnEnded([sys('turn_duration'), q('enqueue'), q('dequeue')]), true);
  assert.equal(turnEnded([sys('turn_duration'), q('enqueue'), q('remove')]), true);
  assert.equal(turnEnded([sys('turn_duration'), q('enqueue')]), false);
  assert.equal(turnEnded([q('enqueue'), sys('turn_duration'), q('dequeue')]), true); // dequeue whose enqueue is earlier
  assert.equal(turnEnded([sys('turn_duration'), q('dequeue')]), true); // a dequeue never decides
});

test('turnEnded: sidechain lines ignored; no evidence → null', () => {
  assert.equal(turnEnded([sys('turn_duration'), { ...asst(), isSidechain: true }]), true);
  assert.equal(turnEnded([{ type: 'attachment' }, { type: 'mode' }]), null);
  assert.equal(turnEnded([]), null);
});

test('contextUsage: last main-chain call with real usage; skips sidechain / <synthetic> / zero; compact after it wins', () => {
  assert.deepEqual(contextUsage([asst(), sys('turn_duration')]), { compacted: false, tokens: 733010, model: 'claude-opus-5-5' });
  const small = asst({ input_tokens: 5, cache_read_input_tokens: 100 });
  assert.equal(contextUsage([asst(), { ...small, isSidechain: true }]).tokens, 733010);
  assert.equal(contextUsage([asst(), { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0 } } }]).tokens, 733010);
  assert.equal(contextUsage([asst(), asst({ input_tokens: 0 })]).tokens, 733010);
  assert.deepEqual(contextUsage([asst(), sys('compact_boundary', { compactMetadata: { postTokens: 8080 } }), user('x', { isCompactSummary: true })]),
    { compacted: true, tokens: 8080, model: null });
  assert.equal(contextUsage([user('x')]), null);
});

test('formatContext / contextWindowFor: % only with a configured window (never guessed from the model id)', () => {
  const u = { compacted: false, tokens: 733010, model: 'claude-opus-5-5' };
  assert.equal(formatContext(u), 'ctx 733k');
  assert.equal(formatContext(u, 1_000_000), 'ctx 733k (73%)');
  assert.equal(formatContext({ compacted: true, tokens: 8080 }), 'vừa compact (~8k)');
  assert.equal(formatContext(null), null);
  assert.equal(fmtTokens(950), '950');
  const cfg = { _config: { contextWindows: { 'claude-opus-5-5': 1000000, '#abcd1234': 200000 } } };
  assert.equal(contextWindowFor(cfg, { hashtag: 'abcd1234', model: 'claude-opus-5-5' }), 200000); // per-agent first
  assert.equal(contextWindowFor(cfg, { hashtag: 'ffff0000', model: 'claude-opus-5-5' }), 1000000);
  assert.equal(contextWindowFor({}, { model: 'claude-opus-5-5' }), null);
});

test('parseJsonl / readTail: a cut first line and garbage are skipped; the window grows until it decides', () => {
  assert.deepEqual(parseJsonl('{"a":1}\nnot json\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonl('"a":1}\n{"b":2}', { dropFirst: true }), [{ b: 2 }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const f = path.join(dir, 't.jsonl');
  // the deciding line is far back, behind a huge line (a big tool result)
  fs.writeFileSync(f, [JSON.stringify(sys('turn_duration')), JSON.stringify({ type: 'attachment', big: 'x'.repeat(3000) }), ''].join('\n'));
  const r = readTail(f, turnEnded, { start: 1024, max: 1 << 20 });
  assert.equal(r.result, true);
  const capped = readTail(f, turnEnded, { start: 1024, max: 2048 });
  assert.equal(capped.result, null); // cap reached before the deciding line → unknown, not "busy"
  assert.deepEqual(readTail(path.join(dir, 'missing'), turnEnded), { lines: [], size: 0, result: null });
});

test('compactAfter: only a NEW manual boundary after the recorded offset; shrunk file → error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, JSON.stringify(sys('compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 1, postTokens: 2 } })) + '\n');
  const offset = fs.statSync(f).size; // an OLD compaction before we typed
  assert.equal(compactAfter(f, offset), null);
  fs.appendFileSync(f, JSON.stringify(sys('compact_boundary', { compactMetadata: { trigger: 'auto', preTokens: 5, postTokens: 6 } })) + '\n');
  assert.equal(compactAfter(f, offset), null); // auto ≠ ours
  fs.appendFileSync(f, JSON.stringify(sys('compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 763065, postTokens: 8080 } })) + '\n');
  assert.deepEqual(compactAfter(f, offset), { preTokens: 763065, postTokens: 8080 });
  fs.writeFileSync(f, '');
  assert.match(compactAfter(f, offset).error, /cắt ngắn/);
  assert.match(compactAfter(path.join(dir, 'gone'), 0).error, /biến mất/);
});

test('findTranscript: by cwd slug, else any project dir; bad id → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const id = '971e709e-2629-4d22-9943-40a52ee04a6b';
  fs.mkdirSync(path.join(dir, '-w-umipay'));
  fs.writeFileSync(path.join(dir, '-w-umipay', `${id}.jsonl`), '');
  assert.equal(findTranscript(id, '/w/umipay', { projectsDir: dir }), path.join(dir, '-w-umipay', `${id}.jsonl`));
  assert.equal(findTranscript(id, '/elsewhere', { projectsDir: dir }), path.join(dir, '-w-umipay', `${id}.jsonl`));
  assert.equal(findTranscript('../etc/passwd', '/w', { projectsDir: dir }), null);
});
