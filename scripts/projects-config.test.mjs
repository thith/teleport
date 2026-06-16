import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectsConfig, resolveProjectConfig, roleFor, memberFor, adminIdsFrom } from './projects-config.mjs';

function tmpJson(obj) {
  const f = path.join(os.tmpdir(), `projects-${process.pid}-${Math.floor(performance.now() * 1000)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
  return f;
}

const CONFIG = {
  luni: { chatId: '-1003805278607', roles: { '144242180': 'admin', '555': 'dev' } },
  noChat: { roles: { '7': 'maintainer' } }, // entry with roles but no chatId
};

test('readProjectsConfig: parses a file', () => {
  const f = tmpJson(CONFIG);
  assert.deepEqual(readProjectsConfig(f), CONFIG);
  fs.unlinkSync(f);
});

test('readProjectsConfig: missing/corrupt → {}', () => {
  assert.deepEqual(readProjectsConfig('/no/such/file.json'), {});
  const bad = path.join(os.tmpdir(), `bad-${process.pid}.json`);
  fs.writeFileSync(bad, '{ not json', 'utf8');
  assert.deepEqual(readProjectsConfig(bad), {});
  fs.unlinkSync(bad);
});

test('resolveProjectConfig: json hit → dedicated, chatId + roles from json', () => {
  const r = resolveProjectConfig('luni', { config: CONFIG, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-1003805278607');
  assert.equal(r.dedicated, true);
  assert.equal(r.roles['144242180'], 'admin');
});

test('resolveProjectConfig: no entry → fallback chatId, NOT dedicated, empty roles', () => {
  const r = resolveProjectConfig('other', { config: CONFIG, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-999');
  assert.equal(r.dedicated, false);
  assert.deepEqual(r.roles, {});
});

test('resolveProjectConfig: entry with roles but no chatId → fallback chatId, NOT dedicated, roles kept', () => {
  const r = resolveProjectConfig('noChat', { config: CONFIG, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-999');
  assert.equal(r.dedicated, false);
  assert.equal(r.roles['7'], 'maintainer'); // roles still come from the entry
});

test('resolveProjectConfig: no entry + no fallback → chatId null (caller fail-fasts)', () => {
  const r = resolveProjectConfig('other', { config: CONFIG });
  assert.equal(r.chatId, null);
  assert.equal(r.dedicated, false);
});

test('resolveProjectConfig: empty/falsy code never matches a config[""] key', () => {
  const cfg = { '': { chatId: '-1', roles: { '9': 'admin' } } };
  const r = resolveProjectConfig('', { config: cfg, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-999');   // fell back, did NOT pick up config['']
  assert.equal(r.dedicated, false);
  assert.deepEqual(r.roles, {});
});

test('resolveProjectConfig: empty-string chatId in entry treated as absent', () => {
  const r = resolveProjectConfig('x', { config: { x: { chatId: '' } }, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-999');
  assert.equal(r.dedicated, false);
});

test('resolveProjectConfig: whitespace-only chatId is NOT dedicated (trimmed → absent)', () => {
  const r = resolveProjectConfig('x', { config: { x: { chatId: '   ' } }, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-999');
  assert.equal(r.dedicated, false);
});

test('resolveProjectConfig: trims a valid dedicated chatId', () => {
  const r = resolveProjectConfig('x', { config: { x: { chatId: ' -100 ' } } });
  assert.equal(r.chatId, '-100');
  assert.equal(r.dedicated, true);
});

test('adminIdsFrom: dedicated → [chatId]; shared → parseAdminChatIds(fallback)', () => {
  const fakeParse = (s) => (s == null ? [] : String(s).split(',').map((x) => x.trim()).filter(Boolean));
  assert.deepEqual(adminIdsFrom({ chatId: '-100', dedicated: true }, '-1,-2', fakeParse), ['-100']);
  assert.deepEqual(adminIdsFrom({ chatId: null, dedicated: false }, '-1,-2', fakeParse), ['-1', '-2']);
  assert.deepEqual(adminIdsFrom({ chatId: null, dedicated: false }, null, fakeParse), []);
});

test('roleFor: mapped → role; unmapped → member; no userId → null', () => {
  const roles = { '144242180': 'admin' };
  assert.equal(roleFor(roles, 144242180), 'admin');
  assert.equal(roleFor(roles, '144242180'), 'admin');
  assert.equal(roleFor(roles, 999), 'member');   // unmapped user → default member
  assert.equal(roleFor(null, 1), 'member');       // no roles map → member
  assert.equal(roleFor(roles, null), null);       // no sender → null (can't attribute)
});

test('roleFor: object profile → reads .role; missing .role → member', () => {
  const roles = {
    '1': { role: 'admin', title: 'anh', name: 'Thi', position: 'dev' },
    '2': { title: 'chị', name: 'Lan' }, // profile with no explicit role
  };
  assert.equal(roleFor(roles, 1), 'admin'); // pulls .role out of the object
  assert.equal(roleFor(roles, 2), 'member'); // object lacking role → least privilege
});

test('memberFor: object → profile; string shorthand/unmapped/no-userId → null', () => {
  const profile = { role: 'admin', title: 'anh', name: 'Thi', position: 'founder / dev' };
  const roles = { '1': profile, '2': 'dev' };
  assert.deepEqual(memberFor(roles, 1), profile); // full profile exposed
  assert.equal(memberFor(roles, '1'), profile);   // userId coerced to string
  assert.equal(memberFor(roles, 2), null);        // string shorthand → no profile object
  assert.equal(memberFor(roles, 999), null);      // unmapped → null
  assert.equal(memberFor(null, 1), null);         // no roles map → null
  assert.equal(memberFor(roles, null), null);     // no sender → null
});
