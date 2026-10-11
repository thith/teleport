import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readAutoMerge, writeAutoMerge, repoFromRemote, allowedRepos, decideRequest, validRequest,
  claimRequests, buildMergeResultPrompt, chatOfConvo, deliverResult,
} from './merge-inbox.mjs';
import { parseRequestArgs, writeRequest } from './merge-request.mjs';

const L1 = 'https://github.com/icetea-labs/umipay-hub/pull/5';
const L2 = 'https://github.com/someone/else/pull/1';

test('automerge switch: default OFF, on/off persisted, garbage → off', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-')), 'state.json');
  assert.equal(readAutoMerge(f), false);
  writeAutoMerge(true, f); assert.equal(readAutoMerge(f), true);
  writeAutoMerge(false, f); assert.equal(readAutoMerge(f), false);
  fs.writeFileSync(f, '{"enabled":"yes"}'); assert.equal(readAutoMerge(f), false, 'only a real true enables');
});

test('repoFromRemote: https / ssh / .git / case', () => {
  assert.equal(repoFromRemote('https://github.com/icetea-labs/umipay-hub.git\n'), 'icetea-labs/umipay-hub');
  assert.equal(repoFromRemote('git@github.com:Thith/Teleport.git'), 'thith/teleport');
  assert.equal(repoFromRemote('https://gitlab.com/a/b.git'), null);
  assert.equal(repoFromRemote(''), null);
});

test('allowedRepos: repos of projects.json keys whose folders exist (never _ keys / bad names)', () => {
  const cfg = { _default: { chatId: '-1' }, 'umipay-hub': {}, teleport: {}, ghost: {}, '../x': {} };
  const remotes = { '/w/umipay-hub': 'https://github.com/icetea-labs/umipay-hub.git', '/w/teleport': 'git@github.com:thith/teleport.git' };
  const set = allowedRepos(cfg, { parentDir: '/w', exists: (d) => d in remotes, remoteOf: (d) => remotes[d] });
  assert.deepEqual([...set].sort(), ['icetea-labs/umipay-hub', 'thith/teleport']);
});

test('decideRequest: auto only when switch on AND every repo allowed', () => {
  const allowed = new Set(['icetea-labs/umipay-hub']);
  assert.deepEqual(decideRequest([L1], { autoEnabled: true, allowed }), { mode: 'auto' });
  assert.equal(decideRequest([L1], { autoEnabled: false, allowed }).mode, 'ask');
  const mixed = decideRequest([L1, L2], { autoEnabled: true, allowed });
  assert.equal(mixed.mode, 'ask');
  assert.match(mixed.reason, /someone\/else/);
  assert.equal(decideRequest(['https://github.com/ICETEA-LABS/Umipay-Hub/pull/5'], { autoEnabled: true, allowed }).mode, 'auto', 'case-insensitive');
});

test('validRequest: links must be PR URLs, convoId numeric, not stale, ≤20', () => {
  const now = 10_000_000;
  assert.deepEqual(validRequest({ links: [L1, L1], convoId: '123', createdAt: now }, { now }), { links: [L1], convoId: '123' });
  assert.equal(validRequest({ links: ['https://evil/pull/1'], convoId: '1' }, { now }), null);
  assert.equal(validRequest({ links: [L1], convoId: '../x' }, { now }), null);
  assert.equal(validRequest({ links: [L1], convoId: '1', createdAt: 0 }, { now, maxAgeMs: 1000 }), null);
  assert.equal(validRequest({ links: Array(21).fill(L1), convoId: '1' }, { now }), null);
  assert.equal(validRequest(null), null);
});

test('merge-request → claimRequests round trip; claimed once; junk names ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  assert.deepEqual(parseRequestArgs([L1, L1]), { links: [L1] });
  assert.match(parseRequestArgs(['nope']).error, /not a GitHub PR URL/);
  assert.match(parseRequestArgs([]).error, /usage/);
  writeRequest({ links: [L1], convoId: '42', dir, now: 1 });
  fs.writeFileSync(path.join(dir, 'random.txt'), 'x');
  const c = claimRequests(dir);
  assert.equal(c.length, 1);
  assert.deepEqual({ links: c[0].body.links, convoId: c[0].body.convoId }, { links: [L1], convoId: '42' });
  assert.ok(c[0].file.endsWith('.processing'));
  assert.equal(claimRequests(dir).length, 0, 'a claimed request is not handed out twice');
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.')), false, 'no temp file left');
});

test('result delivery: prompt into the requester queue, routed to its chat, non-privileged', async () => {
  const p = buildMergeResultPrompt({ convoId: '42', chatId: '-100', text: '✅ merged', mode: 'auto' });
  assert.equal(p.fromRole, 'daemon');
  assert.equal(p.fromMember, null);
  assert.deepEqual(p.mergeResult, { mode: 'auto', text: '✅ merged' });
  assert.match(p.text, /tự merge[\s\S]*✅ merged/);
  assert.equal(chatOfConvo('42', { '-100': { 42: 7, _ts: {} } }), '-100');
  assert.equal(chatOfConvo('9', { '-100': { 42: 7 } }), null);
  const writes = [];
  await deliverResult({ convoId: '42', text: 'x', mode: 'ask' }, { store: { '-100': { 42: 7 } }, tmpDir: '/q', write: async (o, f) => writes.push({ o, f }) });
  assert.equal(writes[0].f, '/q/prompt-convo-42.json');
  assert.equal(writes[0].o.chatId, '-100');
  assert.equal(writes[0].o.convoId, 42);
});
