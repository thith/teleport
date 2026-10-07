import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProjectsConfig, resolveProjectConfig, resolveProjectKey, roleFor, memberFor, adminIdsFrom, isGroupChatId, isPrivateChatId, assertChatIdKind, readGlobalConfig, readDefaultGroup, projectEntries, resolveDefaultChatId, resolveDaemonChatId, resolveQuietHours } from './projects-config.mjs';

test('readGlobalConfig/readDefaultGroup + projectEntries: reserved keys separated from projects', () => {
  const cfg = { _config: { daemonChatId: '42' }, _default: { chatId: '-100', roles: { '1': 'admin' } }, acmebot: { chatId: '-1' }, md: { chatId: '-2' } };
  assert.deepEqual(readGlobalConfig(cfg), { daemonChatId: '42' });
  assert.deepEqual(readDefaultGroup(cfg), { chatId: '-100', roles: { '1': 'admin' } });
  assert.deepEqual(projectEntries(cfg).map(([k]) => k), ['acmebot', 'md']); // _config + _default skipped
  assert.deepEqual(readGlobalConfig({}), {});
});

test('resolveDefaultChatId (from _default.chatId) / resolveDaemonChatId (from _config); env deprecated fallback', () => {
  const cfg = { _default: { chatId: '-100' }, _config: { daemonChatId: '42' } };
  assert.equal(resolveDefaultChatId(cfg, { env: { TELEGRAM_ADMIN_CHAT_ID: '-999' }, envFile: {} }), '-100'); // json wins
  assert.equal(resolveDaemonChatId(cfg, { env: {}, envFile: {} }), '42');
  // fallback to env when reserved blocks absent
  assert.equal(resolveDefaultChatId({}, { env: { TELEGRAM_ADMIN_CHAT_ID: '-7' }, envFile: {} }), '-7');
  assert.equal(resolveDaemonChatId({}, { env: { DAEMON_CHAT_ID: '8' }, envFile: {} }), '8');
  assert.equal(resolveDefaultChatId({}, { env: {}, envFile: {} }), null);
});

test('resolveQuietHours: _config.quietHours wins; env fallback; invalid → null', () => {
  assert.deepEqual(resolveQuietHours({ _config: { quietHours: { start: 22, end: 8 } } }, { env: {}, envFile: {} }), { start: 22, end: 8 });
  assert.deepEqual(resolveQuietHours({}, { env: { QUIET_HOURS_START: '21', QUIET_HOURS_END: '7' }, envFile: {} }), { start: 21, end: 7 });
  assert.deepEqual(resolveQuietHours({ _config: { quietHours: { start: 99, end: 'x' } } }, { env: {}, envFile: {} }), { start: null, end: null });
  assert.deepEqual(resolveQuietHours({}, { env: {}, envFile: {} }), { start: null, end: null });
  // empty quietHours object must NOT shadow the env fallback
  assert.deepEqual(resolveQuietHours({ _config: { quietHours: {} } }, { env: { QUIET_HOURS_START: '22', QUIET_HOURS_END: '8' }, envFile: {} }), { start: 22, end: 8 });
});

test('resolveProjectConfig: shared project inherits _default.roles', () => {
  const cfg = { _default: { chatId: '-100', roles: { '100000001': { role: 'admin' } } }, ded: { chatId: '-200', roles: { '999': { role: 'dev' } } } };
  const shared = resolveProjectConfig('some-shared-proj', { config: cfg, fallbackChatId: '-100' });
  assert.equal(shared.dedicated, false);
  assert.deepEqual(shared.roles, { '100000001': { role: 'admin' } }); // from _default
  const dedicated = resolveProjectConfig('ded', { config: cfg, fallbackChatId: '-100' });
  assert.equal(dedicated.dedicated, true);
  assert.deepEqual(dedicated.roles, { '999': { role: 'dev' } }); // own entry
  // A shared project's OWN roles are dead config: no `_default.roles` → {} (NOT entryRoles)
  const noDefault = resolveProjectConfig('sharedproj', { config: { sharedproj: { roles: { '5': { role: 'admin' } } } }, fallbackChatId: '-100' });
  assert.deepEqual(noDefault.roles, {}); // never inherits a shared project's own roles
});

test('resolveProjectKey: worktree folder → longest matching project key (boundary-safe)', () => {
  const cfg = {
    _config: { daemonUserId: '1' }, _default: { chatId: '-100' },
    acme: { chatId: '-999' }, 'acme-frontend': { chatId: '-999' }, 'acme-worker': { chatId: '-999' },
  };
  // exact key wins, unchanged
  assert.equal(resolveProjectKey('acme', cfg), 'acme');
  assert.equal(resolveProjectKey('acme-frontend', cfg), 'acme-frontend');
  // worktree suffix → LONGEST prefix key (not the shorter `acme`)
  assert.equal(resolveProjectKey('acme-frontend-uifix', cfg), 'acme-frontend');
  assert.equal(resolveProjectKey('acme-x', cfg), 'acme');
  // boundary safety: bare substring never matches (no `-` boundary)
  assert.equal(resolveProjectKey('acm', cfg), 'acm');
  assert.equal(resolveProjectKey('acmefrontend', cfg), 'acmefrontend');
  // unrelated folder → unchanged (default fallback stands)
  assert.equal(resolveProjectKey('some-other-repo', cfg), 'some-other-repo');
  // reserved `_`-keys are never matched
  assert.equal(resolveProjectKey('_default-x', cfg), '_default-x');
  assert.equal(resolveProjectKey('', cfg), '');
});

test('resolveProjectKey → resolveProjectConfig: worktree resolves to project group, not _default', () => {
  const cfg = { _default: { chatId: '-100' }, 'acme-frontend': { chatId: '-1004444444444' }, acme: { chatId: '-1004444444444' } };
  const key = resolveProjectKey('acme-frontend-uifix', cfg);
  const proj = resolveProjectConfig(key, { config: cfg, fallbackChatId: '-100' });
  assert.equal(proj.chatId, '-1004444444444'); // real project group, NOT -100
  assert.equal(proj.dedicated, true);
  // unrelated worktree keeps default fallback
  const other = resolveProjectConfig(resolveProjectKey('unrelated-repo', cfg), { config: cfg, fallbackChatId: '-100' });
  assert.equal(other.chatId, '-100');
  assert.equal(other.dedicated, false);
});

test('isGroupChatId / isPrivateChatId: sign convention', () => {
  assert.equal(isGroupChatId('-1001234567890'), true);
  assert.equal(isGroupChatId('-100'), true);
  assert.equal(isGroupChatId('100000001'), false);  // private user id
  assert.equal(isGroupChatId('abc'), false);
  assert.equal(isPrivateChatId('100000001'), true);
  assert.equal(isPrivateChatId('-1001234567890'), false);
  assert.equal(isPrivateChatId(''), false);
  assert.equal(isGroupChatId(-100), true);          // number input too
  assert.equal(isPrivateChatId(100000001), true);
});

test('assertChatIdKind: passes the right kind, throws on the wrong one', () => {
  assert.doesNotThrow(() => assertChatIdKind('-100', 'group', 'project chatId'));
  assert.doesNotThrow(() => assertChatIdKind('100000001', 'private', 'DAEMON_CHAT_ID'));
  assert.throws(() => assertChatIdKind('100000001', 'group', "project 'd_be' chatId"), /must be a GROUP/);
  assert.throws(() => assertChatIdKind('-100', 'private', 'DAEMON_CHAT_ID'), /must be a PRIVATE/);
  assert.throws(() => assertChatIdKind('xyz', 'group', 'catch-all'), /must be a GROUP/);
});

function tmpJson(obj) {
  const f = path.join(os.tmpdir(), `projects-${process.pid}-${Math.floor(performance.now() * 1000)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
  return f;
}

const CONFIG = {
  acmebot: { chatId: '-1003333333333', roles: { '100000001': 'admin', '555': 'dev' } },
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
  const r = resolveProjectConfig('acmebot', { config: CONFIG, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-1003333333333');
  assert.equal(r.dedicated, true);
  assert.equal(r.roles['100000001'], 'admin');
});

test('resolveProjectConfig: no entry → fallback chatId, NOT dedicated, empty roles', () => {
  const r = resolveProjectConfig('other', { config: CONFIG, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-999');
  assert.equal(r.dedicated, false);
  assert.deepEqual(r.roles, {});
});

test('resolveProjectConfig: entry with roles but no chatId → shared, roles from _default (NOT own)', () => {
  const r = resolveProjectConfig('noChat', { config: CONFIG, fallbackChatId: '-999' });
  assert.equal(r.chatId, '-999');
  assert.equal(r.dedicated, false);
  // A shared project's OWN roles are dead config — roles come from `_default.roles`
  // (here absent in CONFIG) → {}, never the entry's own `7: maintainer`.
  assert.deepEqual(r.roles, {});
});

test('resolveProjectConfig: no entry + no fallback → chatId null (caller fail-fasts)', () => {
  const r = resolveProjectConfig('other', { config: CONFIG });
  assert.equal(r.chatId, null);
  assert.equal(r.dedicated, false);
});

test('resolveProjectConfig: entry.code → display code (short alias); roster lookup stays the key', () => {
  const cfg = { 'acme-worker': { code: 'd_be', chatId: '-100', roles: {} } };
  const r = resolveProjectConfig('acme-worker', { config: cfg, fallbackChatId: '-999' });
  assert.equal(r.code, 'd_be');
});

test('resolveProjectConfig: no entry.code → code falls back to the lookup key', () => {
  const r = resolveProjectConfig('acmebot', { config: CONFIG, fallbackChatId: '-999' });
  assert.equal(r.code, 'acmebot');
});

test('resolveProjectConfig: blank/non-string code is ignored → falls back to lookup key', () => {
  const cfg = { x: { code: '   ', chatId: '-100' }, y: { code: 42, chatId: '-100' } };
  assert.equal(resolveProjectConfig('x', { config: cfg }).code, 'x');
  assert.equal(resolveProjectConfig('y', { config: cfg }).code, 'y');
});

test('resolveProjectConfig: no entry → code is the (unmatched) lookup key', () => {
  const r = resolveProjectConfig('ghost', { config: CONFIG, fallbackChatId: '-999' });
  assert.equal(r.code, 'ghost');
});

test('resolveProjectConfig: topicIcon object passed through when present', () => {
  const cfg = { p: { chatId: '-100', topicIcon: { emoji: '123', color: 7322096 } } };
  const r = resolveProjectConfig('p', { config: cfg });
  assert.deepEqual(r.topicIcon, { emoji: '123', color: 7322096 });
});

test('resolveProjectConfig: topicIcon null when absent or not an object', () => {
  assert.equal(resolveProjectConfig('acmebot', { config: CONFIG }).topicIcon, null);
  const cfg = { p: { chatId: '-100', topicIcon: 'nope' } };
  assert.equal(resolveProjectConfig('p', { config: cfg }).topicIcon, null);
});

test('resolveProjectConfig: description passed through (trimmed) for dedicated + shared', () => {
  const ded = resolveProjectConfig('p', { config: { p: { chatId: '-100', description: '  Backend API  ' } } });
  assert.equal(ded.description, 'Backend API'); // surrounding whitespace trimmed
  // A shared entry (no chatId) may still carry a description — it's harmless context.
  const shared = resolveProjectConfig('s', { config: { s: { description: 'Shared svc' }, _default: { roles: {} } }, fallbackChatId: '-999' });
  assert.equal(shared.dedicated, false);
  assert.equal(shared.description, 'Shared svc');
});

test('resolveProjectConfig: description null when absent, blank, or non-string', () => {
  assert.equal(resolveProjectConfig('acmebot', { config: CONFIG }).description, null); // absent
  assert.equal(resolveProjectConfig('p', { config: { p: { chatId: '-100', description: '   ' } } }).description, null); // blank → null
  assert.equal(resolveProjectConfig('p', { config: { p: { chatId: '-100', description: 123 } } }).description, null); // non-string → null
  assert.equal(resolveProjectConfig('ghost', { config: CONFIG, fallbackChatId: '-999' }).description, null); // no entry
});

test('memberFor: free-form `note` field is exposed verbatim on the profile', () => {
  const roles = { 1: { role: 'maintainer', name: 'Bảo', note: 'review kỹ migration' } };
  assert.equal(memberFor(roles, 1).note, 'review kỹ migration');
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
  const roles = { '100000001': 'admin' };
  assert.equal(roleFor(roles, 100000001), 'admin');
  assert.equal(roleFor(roles, '100000001'), 'admin');
  assert.equal(roleFor(roles, 999), 'member');   // unmapped user → default member
  assert.equal(roleFor(null, 1), 'member');       // no roles map → member
  assert.equal(roleFor(roles, null), null);       // no sender → null (can't attribute)
});

test('roleFor: object profile → reads .role; missing .role → member', () => {
  const roles = {
    '1': { role: 'admin', title: 'anh', name: 'Alice', position: 'dev' },
    '2': { title: 'chị', name: 'Lan' }, // profile with no explicit role
  };
  assert.equal(roleFor(roles, 1), 'admin'); // pulls .role out of the object
  assert.equal(roleFor(roles, 2), 'member'); // object lacking role → least privilege
});

test('roleFor/memberFor: a polluted prototype never grants privilege (own-property guard)', () => {
  // Pollute Object.prototype with a role-shaped value at a key a lookup could hit,
  // then assert the guard ignores it. Without the own-property guard this FAILS
  // (roleFor would return 'admin'); with it, the default holds. try/finally so the
  // pollution never leaks to other tests.
  try {
    // eslint-disable-next-line no-extend-native
    Object.prototype['1337'] = { role: 'admin' };
    assert.equal(roleFor({}, '1337'), 'member');   // inherited → ignored
    assert.equal(memberFor({}, '1337'), null);
    assert.equal(roleFor({ '1337': 'dev' }, '1337'), 'dev'); // own property still works
  } finally {
    delete Object.prototype['1337'];
  }
});

test('memberFor: object → profile; string shorthand/unmapped/no-userId → null', () => {
  const profile = { role: 'admin', title: 'anh', name: 'Alice', position: 'founder / dev' };
  const roles = { '1': profile, '2': 'dev' };
  assert.deepEqual(memberFor(roles, 1), profile); // full profile exposed
  assert.equal(memberFor(roles, '1'), profile);   // userId coerced to string
  assert.equal(memberFor(roles, 2), null);        // string shorthand → no profile object
  assert.equal(memberFor(roles, 999), null);      // unmapped → null
  assert.equal(memberFor(null, 1), null);         // no roles map → null
  assert.equal(memberFor(roles, null), null);     // no sender → null
});
