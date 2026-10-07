// RFC 15 — convo-anchored routing. Unit tests for the pure resolver, the
// routing wrapper, the git-root helper (execFn injected), and the allocation
// lookup. No real fs/git/registry — everything is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { recordConvoSend } from './send-telegram.mjs';
import {
  resolveLookupKey,
  resolveProjectRouting,
  firstNonBareWorktree,
  gitMainWorktreeDir,
  hasGitAncestor,
} from './projects-config.mjs';
import { lookupAllocationByConvo, argConvoFromArgv } from './convo-registry.mjs';

test('argConvoFromArgv: extracts validated --convo, else null', () => {
  assert.equal(argConvoFromArgv(['node', 's', '--convo', '12345']), 12345);
  assert.equal(argConvoFromArgv(['node', 's', '--convo', '  678 ']), 678);
  assert.equal(argConvoFromArgv(['node', 's']), null);
  assert.equal(argConvoFromArgv(['node', 's', '--convo']), null); // no value
  assert.equal(argConvoFromArgv(['node', 's', '--convo', 'abc']), null); // non-numeric
  assert.equal(argConvoFromArgv(['node', 's', '--convo', '-5']), null); // negative rejected
});

// --- shared fixtures ---------------------------------------------------------
const CFG = {
  acme: { chatId: '-1001001', code: 'd_web' },
  'acme-frontend': { chatId: '-1001001', code: 'd_fe' },
  'acme-frontend-help': { chatId: '-1001001', code: 'd_fe_help' }, // longer prefix key
  acmebot: { chatId: '-1002002', code: 'lu' },
  _default: { chatId: '-1009009', roles: {} },
  _config: { daemonUserId: '1' },
};
const alloc = (convoId, botId, chatId, extra = {}) => ({
  v: 1, convoId, messageId: convoId, chatId, botId, ts: 1000, ...extra,
});

// --- lookupAllocationByConvo -------------------------------------------------
test('lookupAllocationByConvo: allocation-only, botId filter, oldest-ts-wins', () => {
  const rows = [
    { v: 1, convoId: 5, messageId: 9, chatId: '-1001001', botId: 7, ts: 500 }, // not alloc (msg!=convo)
    alloc(5, 7, '-1002002', { ts: 3000, projectKey: 'acmebot' }), // newer alloc
    alloc(5, 7, '-1001001', { ts: 1000, projectKey: 'acme' }), // older alloc → wins
    alloc(5, 8, '-1001001', { ts: 100 }), // different botId
  ];
  const got = lookupAllocationByConvo(rows, 5, 7);
  assert.equal(got.chatId, '-1001001');
  assert.equal(got.projectKey, 'acme'); // oldest ts=1000 wins, not the field-richer newer one
  assert.equal(lookupAllocationByConvo(rows, 5, 8).ts, 100);
  assert.equal(lookupAllocationByConvo(rows, 99, 7), null);
});

// --- Tier 0: override (cold-start select only; anchor wins) -----------------
test('resolveLookupKey: override selects at cold-start; anchor BEATS override', () => {
  // cold-start (no anchor) + valid override → override wins
  const r = resolveLookupKey({
    cwd: '/x', convoId: 5, botId: 7, env: { TELE_LOOKUP_KEY: 'acmebot' },
    registryRows: [], projectsConfig: CFG, gitRootFn: () => '/repos/acme',
  });
  assert.equal(r.lookupKey, 'acmebot');
  assert.equal(r.resolvedBy, 'override');

  // invalid override (reserved/non-key) → ignored → git cold-start
  const r2 = resolveLookupKey({
    cwd: '/x', convoId: 5, botId: 7, env: { TELE_LOOKUP_KEY: '_default' },
    registryRows: [], projectsConfig: CFG, gitRootFn: () => '/repos/acme',
  });
  assert.equal(r2.resolvedBy, 'git');
  assert.equal(r2.lookupKey, 'acme');

  // anchor present → anchor beats override (immutable topic can't be moved by env)
  const r3 = resolveLookupKey({
    cwd: '/x', convoId: 5, botId: 7, env: { TELE_LOOKUP_KEY: 'acmebot' },
    registryRows: [alloc(5, 7, '-1001001', { projectKey: 'acme' })],
    projectsConfig: CFG, gitRootFn: () => null,
  });
  assert.equal(r3.lookupKey, 'acme');
  assert.equal(r3.resolvedBy, 'anchor');
});

// --- Tier 1: anchor ----------------------------------------------------------
test('resolveLookupKey Tier 1: anchor with projectKey wins over cwd/git', () => {
  const r = resolveLookupKey({
    cwd: '/repos/acme-frontend-uifix', convoId: 5, botId: 7,
    env: {},
    registryRows: [alloc(5, 7, '-1001001', { projectKey: 'acme' })],
    projectsConfig: CFG,
    gitRootFn: () => '/repos/acme-frontend', // would say acme-frontend, but anchor wins
  });
  assert.equal(r.lookupKey, 'acme');
  assert.equal(r.resolvedBy, 'anchor');
});

test('resolveLookupKey Tier 1: unregistered projectKey still used as-is (label preserved)', () => {
  const r = resolveLookupKey({
    cwd: '/x', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1009009', { projectKey: 'some-unregistered' })],
    projectsConfig: CFG, gitRootFn: () => null,
  });
  assert.equal(r.lookupKey, 'some-unregistered');
  assert.equal(r.resolvedBy, 'anchor');
});

test('resolveLookupKey Tier 1: legacy row (no projectKey) → chatIdHint, anchor-legacy', () => {
  const r = resolveLookupKey({
    cwd: '/x', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1001001')], // no projectKey
    projectsConfig: CFG, gitRootFn: () => '/repos/acmebot',
  });
  assert.equal(r.lookupKey, null);
  assert.equal(r.chatIdHint, '-1001001');
  assert.equal(r.resolvedBy, 'anchor-legacy');
});

// --- Tier 2: cold-start git --------------------------------------------------
test('resolveLookupKey Tier 2: git root basename → registered key (worktree/subdir safe)', () => {
  // worktree named acme-frontend-uifix → git root acme-frontend (a key)
  const r = resolveLookupKey({
    cwd: '/repos/acme-frontend-uifix', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG,
    gitRootFn: () => '/repos/acme-frontend',
  });
  assert.equal(r.lookupKey, 'acme-frontend');
  assert.equal(r.resolvedBy, 'git');
});

test('resolveLookupKey Tier 2: git root prefix → longest matching key via resolveProjectKey', () => {
  // arbitrary worktree, git root = acme-frontend-help-x → prefix → acme-frontend-help
  const r = resolveLookupKey({
    cwd: '/repos/wt', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG,
    gitRootFn: () => '/repos/acme-frontend-help-x',
  });
  assert.equal(r.lookupKey, 'acme-frontend-help');
  assert.equal(r.resolvedBy, 'git');
});

test('resolveLookupKey Tier 2: git root unregistered → basename kept but resolvedBy=default', () => {
  const r = resolveLookupKey({
    cwd: '/repos/wt', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG,
    gitRootFn: () => '/repos/random-repo',
  });
  assert.equal(r.lookupKey, 'random-repo'); // label preserved for _default catch-all
  assert.equal(r.resolvedBy, 'default');
});

test('resolveLookupKey Tier 2: subdir does NOT hijack via basename (git runs first)', () => {
  // cwd basename == acmebot (a key) but we are a subdir of acme; git root = acme
  const r = resolveLookupKey({
    cwd: '/repos/acme/acmebot', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG,
    gitRootFn: () => '/repos/acme',
  });
  assert.equal(r.lookupKey, 'acme'); // NOT 'acmebot'
  assert.equal(r.resolvedBy, 'git');
});

// --- git unavailable → Tier 3 _default (NO cwd-basename fallback) ------------
test('resolveLookupKey: git unavailable INSIDE a repo → _default, no cwd-basename hijack', () => {
  // even when cwd basename IS a key, git-fail inside a repo must NOT route by it
  // (would let a git-hang inside a colliding subdir hijack) → _default.
  const reg = resolveLookupKey({
    cwd: '/repos/acmebot', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG, gitRootFn: () => null, gitTreeFn: () => true,
  });
  assert.equal(reg.lookupKey, null);
  assert.equal(reg.resolvedBy, 'default-unresolved');
});

test('resolveLookupKey Tier 3a: outside any repo → registered basename(cwd), else _default', () => {
  const reg = resolveLookupKey({
    cwd: '/work/acmebot', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG, gitRootFn: () => null, gitTreeFn: () => false,
  });
  assert.equal(reg.lookupKey, 'acmebot');
  assert.equal(reg.resolvedBy, 'cwd');
  const unreg = resolveLookupKey({
    cwd: '/work/nope', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG, gitRootFn: () => null, gitTreeFn: () => false,
  });
  assert.equal(unreg.lookupKey, 'nope');        // keeps its label; routes to _default
  assert.equal(unreg.resolvedBy, 'default');
  // a throwing probe fails closed (treated as inside a repo)
  const thrown = resolveLookupKey({
    cwd: '/work/acmebot', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG, gitRootFn: () => null, gitTreeFn: () => { throw new Error('x'); },
  });
  assert.equal(thrown.resolvedBy, 'default-unresolved');
});

test('Tier 3a + hasGitAncestor use the PHYSICAL path (symlinked cwd)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tl-sym-')));
  try {
    fs.mkdirSync(nodePath.join(tmp, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(nodePath.join(tmp, 'outside', 'luckyproj'), { recursive: true });
    fs.symlinkSync(nodePath.join(tmp, 'repo'), nodePath.join(tmp, 'outside', 'link-into-repo'));
    fs.symlinkSync(nodePath.join(tmp, 'outside', 'luckyproj'), nodePath.join(tmp, 'alias'));
    // a symlink OUTSIDE the repo that points INTO it still counts as inside
    assert.equal(hasGitAncestor(nodePath.join(tmp, 'outside', 'link-into-repo')), true);
    // non-git folder reached through an alias routes by its REAL name
    const r = resolveLookupKey({
      cwd: nodePath.join(tmp, 'alias'), convoId: null, botId: null, env: {}, registryRows: [],
      projectsConfig: { luckyproj: { chatId: '-1007' } }, gitRootFn: () => null,
    });
    assert.equal(r.lookupKey, 'luckyproj');
    assert.equal(r.resolvedBy, 'cwd');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('hasGitAncestor: finds .git in cwd or any ancestor; false at filesystem root', () => {
  const at = (hit) => (p) => p === hit;
  assert.equal(hasGitAncestor('/a/b/c', { existsFn: at('/a/.git') }), true);
  assert.equal(hasGitAncestor('/a/b/c', { existsFn: at('/a/b/c/.git') }), true);
  assert.equal(hasGitAncestor('/a/b/c', { existsFn: () => false }), false);
});

// --- RFC-15 default-routed anchor (no projectKey, has resolvedBy) -----------
test('resolveProjectRouting: default-routed RFC-15 anchor follows the CURRENT _default with its roles', () => {
  const cfg = { ...CFG, _default: { chatId: '-1008008', roles: { '100000001': { role: 'admin' } } } };
  const out = resolveProjectRouting({
    cwd: '/x', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1009009', { resolvedBy: 'default' })], // anchored when _default was -1009009
    projectsConfig: cfg, fallbackChatId: '-1008008', gitRootFn: () => null, gitTreeFn: () => true,
  });
  assert.equal(out.resolvedBy, 'anchor-default');
  assert.equal(out.projCfg.chatId, '-1008008');                         // moved with _default
  assert.equal(out.projCfg.roles['100000001']?.role, 'admin');          // roles kept, not stripped
});

test('resolveProjectRouting: legacy hint in a multi-id catch-all ("A,B") resolves via the shared path', () => {
  const cfg = { ...CFG, _default: { chatId: '-1001111,-1002222', roles: { '100000001': { role: 'admin' } } } };
  const out = resolveProjectRouting({
    cwd: '/x', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1002222')], // pre-RFC row: no projectKey, no resolvedBy
    projectsConfig: cfg, fallbackChatId: '-1001111,-1002222', gitRootFn: () => null, gitTreeFn: () => true,
  });
  assert.equal(out.projCfg.roles['100000001']?.role, 'admin');
});

test('resolveLookupKey: a git hiccup at first send does NOT pin — next send re-tries git', () => {
  const r = resolveLookupKey({
    cwd: '/repos/acme/sub', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1009009', { resolvedBy: 'default-unresolved' })],
    projectsConfig: CFG, gitRootFn: () => '/repos/acme', gitTreeFn: () => true,
  });
  assert.equal(r.lookupKey, 'acme');
  assert.equal(r.resolvedBy, 'git');
});

test('resolveProjectRouting: shared catch-all keeps a [project] label (folder name) when there is no key', () => {
  const out = resolveProjectRouting({
    cwd: '/repos/acme/notes', convoId: null, botId: null, env: {}, registryRows: [],
    projectsConfig: CFG, fallbackChatId: '-1009009', gitRootFn: () => null, gitTreeFn: () => true,
  });
  assert.equal(out.projCfg.chatId, '-1009009');
  assert.equal(out.projCfg.code, 'notes');
  const legacy = resolveProjectRouting({
    cwd: '/work/notes', convoId: 5, botId: 7, env: {}, registryRows: [alloc(5, 7, '-1009009')],
    projectsConfig: CFG, fallbackChatId: '-1009009', gitRootFn: () => null, gitTreeFn: () => true,
  });
  assert.equal(legacy.projCfg.code, 'notes');
});

// --- resolveProjectRouting: legacy reverse-map ------------------------------
test('resolveProjectRouting: legacy chatIdHint uniquely maps → full projCfg', () => {
  const out = resolveProjectRouting({
    cwd: '/x', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1002002')], // legacy, chatId of acmebot (unique)
    projectsConfig: CFG, fallbackChatId: '-1009009', gitRootFn: () => null,
  });
  assert.equal(out.lookupKey, 'acmebot');
  assert.equal(out.projCfg.chatId, '-1002002');
  assert.equal(out.projCfg.code, 'lu');
  assert.equal(out.resolvedBy, 'anchor-legacy');
});

test('resolveProjectRouting: legacy chatIdHint ambiguous (shared chatId) → group only, least-privilege roles', () => {
  const out = resolveProjectRouting({
    cwd: '/x', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1001001')], // shared by acme + acme-frontend(+help)
    projectsConfig: CFG, fallbackChatId: '-1009009', gitRootFn: () => null,
  });
  assert.equal(out.lookupKey, null);
  assert.equal(out.projCfg.chatId, '-1001001');
  assert.deepEqual(out.projCfg.roles, {}); // no borrowed roles
  assert.equal(out.projCfg.dedicated, true); // group id (negative) → dedicated form
});

test('resolveProjectRouting: legacy row in the CATCH-ALL group recovers _default roles (not least-priv)', () => {
  // Regression: an unregistered project (e.g. the teleport repo) whose legacy
  // allocation row points at the _default group must keep _default.roles — else
  // admins get silently downgraded to member.
  const cfgWithDefaultRoles = {
    ...CFG,
    _default: { chatId: '-1009009', roles: { '100000001': { role: 'admin' } } },
  };
  const out = resolveProjectRouting({
    cwd: '/x', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1009009')], // legacy, chatId == _default/fallback
    projectsConfig: cfgWithDefaultRoles, fallbackChatId: '-1009009', gitRootFn: () => null,
  });
  assert.equal(out.projCfg.chatId, '-1009009');
  assert.equal(out.projCfg.roles['100000001']?.role, 'admin'); // NOT dropped
  assert.equal(out.projCfg.dedicated, false); // shared catch-all
});

test('resolveProjectRouting: no anchor, git default → _default projCfg', () => {
  const out = resolveProjectRouting({
    cwd: '/repos/random', convoId: null, botId: null, env: {},
    registryRows: [], projectsConfig: CFG, fallbackChatId: '-1009009',
    gitRootFn: () => '/repos/random',
  });
  // unregistered basename 'random' → resolveProjectConfig('random') → _default group, code=random
  assert.equal(out.projCfg.chatId, '-1009009');
  assert.equal(out.projCfg.dedicated, false);
  assert.equal(out.projCfg.code, 'random');
});

// --- firstNonBareWorktree ----------------------------------------------------
test('firstNonBareWorktree: picks first block, skips bare', () => {
  const normal = 'worktree /repos/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /repos/wt\nHEAD def\n';
  assert.equal(firstNonBareWorktree(normal), '/repos/main');

  const bareFirst = 'worktree /repos/bare\nbare\n\nworktree /repos/checkout\nHEAD abc\n';
  assert.equal(firstNonBareWorktree(bareFirst), '/repos/checkout');

  assert.equal(firstNonBareWorktree(''), null);
  assert.equal(firstNonBareWorktree('bare\n'), null);
});

// --- gitMainWorktreeDir (execFn injected) -----------------------------------
test('gitMainWorktreeDir: submodule (superproject non-empty) → null, short-circuits BEFORE worktree-list', () => {
  // worktree-list returns a REAL-looking (wrong) submodule path; if the
  // submodule short-circuit did NOT fire first, the helper would return that
  // path instead of null. Asserting null proves the ordering (a mere throw
  // here would be caught → null regardless, hiding an ordering regression).
  const execFn = (bin, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-superproject-working-tree') return '/repos/super\n';
    if (args[0] === 'worktree') return 'worktree /repos/super-sub-wrong\nHEAD abc\n';
    throw new Error('unexpected git call');
  };
  assert.equal(gitMainWorktreeDir('/repos/super/sub', { execFn }), null);
});

test('gitMainWorktreeDir: linked worktree → main via worktree list', () => {
  const execFn = (bin, args) => {
    if (args[1] === '--show-superproject-working-tree') return '\n'; // not a submodule
    if (args[0] === 'worktree') return 'worktree /repos/acme-frontend\nHEAD abc\nbranch refs/heads/main\n';
    throw new Error('unexpected git call');
  };
  // realpath may fail on a fake path → helper returns the path as-is (caught)
  const got = gitMainWorktreeDir('/repos/acme-frontend-uifix', { execFn });
  assert.equal(got, '/repos/acme-frontend');
});

test('gitMainWorktreeDir: worktree-list throws → git-common-dir fallback', () => {
  const execFn = (bin, args) => {
    if (args[1] === '--show-superproject-working-tree') return '\n'; // not a submodule
    if (args[0] === 'worktree') throw new Error('worktree list unsupported');
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return '/repos/acme-frontend/.git\n';
    throw new Error('unexpected git call');
  };
  // realpath will fail on the fake path → falls back to the raw path; endsWith
  // /.git → dirname = main root.
  assert.equal(gitMainWorktreeDir('/repos/acme-frontend-uifix', { execFn }), '/repos/acme-frontend');
});

test('gitMainWorktreeDir: common-dir under /.git/modules/ → null (submodule via fallback)', () => {
  const execFn = (bin, args) => {
    if (args[1] === '--show-superproject-working-tree') return '\n';
    if (args[0] === 'worktree') throw new Error('no worktree list');
    if (args[1] === '--git-common-dir') return '/repos/super/.git/modules/sub\n';
    throw new Error('unexpected');
  };
  assert.equal(gitMainWorktreeDir('/repos/super/sub', { execFn }), null);
});

test('gitMainWorktreeDir: non-git (git throws) → null, never throws', () => {
  const execFn = () => { throw new Error('not a git repository'); };
  assert.equal(gitMainWorktreeDir('/tmp/plain', { execFn }), null);
});

// --- recordConvoSend adopt-existing gate ((convoId,botId), not chatId) -------
test('recordConvoSend: one allocation per (convoId,botId) across chats; first projectKey preserved', async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'convo-reg-'));
  const reg = nodePath.join(dir, 'reg.jsonl');
  const lock = nodePath.join(dir, 'reg.lock');
  try {
    // First send anchors convo 5 to chat A / acme.
    await recordConvoSend({ convoId: 5, messageId: 5, chatId: '-1001001', botId: 7, projectKey: 'acme', resolvedBy: 'git' }, reg, lock);
    // A racing/split send to a DIFFERENT chat must NOT write a second allocation.
    await recordConvoSend({ convoId: 5, messageId: 6, chatId: '-1002002', botId: 7, projectKey: 'acmebot', resolvedBy: 'git' }, reg, lock);
    const rows = fs.readFileSync(reg, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const allocs = rows.filter((r) => r.convoId === 5 && r.botId === 7 && r.messageId === r.convoId);
    assert.equal(allocs.length, 1); // adopt-existing: exactly one anchor
    assert.equal(allocs[0].chatId, '-1001001'); // first writer wins
    assert.equal(allocs[0].projectKey, 'acme'); // not overwritten by 'acmebot'
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecycle: git failure → recovery PROMOTES the anchor → a later cd cannot drift the convo', async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'convo-promo-'));
  const reg = nodePath.join(dir, 'reg.jsonl');
  const lock = nodePath.join(dir, 'reg.lock');
  const rows = () => fs.readFileSync(reg, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const route = (gitRoot) => resolveLookupKey({
    cwd: '/x', convoId: 5, botId: 7, env: {}, registryRows: rows(), projectsConfig: CFG,
    gitRootFn: () => gitRoot, gitTreeFn: () => true,
  });
  try {
    // 1st send: git failing → unresolved anchor in _default
    await recordConvoSend({ convoId: 5, messageId: 5, chatId: '-1009009', botId: 7, projectKey: null, resolvedBy: 'default-unresolved' }, reg, lock);
    // 2nd send: git works again → resolves acme, and the anchor is promoted
    const r2 = route('/repos/acme');
    assert.equal(r2.lookupKey, 'acme');
    await recordConvoSend({ convoId: 5, messageId: 51, chatId: '-1001001', botId: 7, projectKey: r2.lookupKey, resolvedBy: r2.resolvedBy }, reg, lock);
    assert.equal(lookupAllocationByConvo(rows(), 5, 7).projectKey, 'acme');
    // later the session cd's into another repo: the anchor holds
    const r3 = route('/repos/acmebot');
    assert.equal(r3.lookupKey, 'acme');
    assert.equal(r3.resolvedBy, 'anchor');
    // a further send does not write yet another anchor
    await recordConvoSend({ convoId: 5, messageId: 52, chatId: '-1001001', botId: 7, projectKey: 'acme', resolvedBy: 'anchor' }, reg, lock);
    assert.equal(rows().filter((r) => r.convoId === 5 && r.messageId === 5).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProjectRouting: legacy anchor whose chat no project owns any more → follows CURRENT config (cold start)', () => {
  const cfg = { ...CFG, acme: { chatId: '-1003003', code: 'd_web', roles: { '100000001': { role: 'admin' } } } };
  const out = resolveProjectRouting({
    cwd: '/x', convoId: 5, botId: 7, env: {},
    registryRows: [alloc(5, 7, '-1001001')],   // pre-upgrade row: acme USED to be -1001001 (now -1003003)
    projectsConfig: { ...cfg, 'acme-frontend': { chatId: '-1004004' }, 'acme-frontend-help': { chatId: '-1004004' } },
    fallbackChatId: '-1009009', gitRootFn: () => '/repos/acme', gitTreeFn: () => true,
  });
  assert.equal(out.projCfg.chatId, '-1003003');
  assert.equal(out.projCfg.roles['100000001']?.role, 'admin');
});

test('lifecycle: a stale LEGACY anchor (chat no longer owned) gets promoted on the first cold-start send, then holds', async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'convo-legacy-'));
  const reg = nodePath.join(dir, 'reg.jsonl');
  const lock = nodePath.join(dir, 'reg.lock');
  const rows = () => fs.readFileSync(reg, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const cfg = { ...CFG, acme: { chatId: '-1003003', code: 'd_web' }, 'acme-frontend': { chatId: '-1004004' }, 'acme-frontend-help': { chatId: '-1004004' } };
  const route = (gitRoot) => resolveProjectRouting({
    cwd: '/x', convoId: 5, botId: 7, env: {}, registryRows: rows(), projectsConfig: cfg,
    fallbackChatId: '-1009009', gitRootFn: () => gitRoot, gitTreeFn: () => true,
  });
  try {
    fs.writeFileSync(reg, JSON.stringify(alloc(5, 7, '-1001001')) + '\n'); // pre-upgrade row, chat now unowned
    const r1 = route('/repos/acme');
    assert.equal(r1.projCfg.chatId, '-1003003');
    await recordConvoSend({ convoId: 5, messageId: 61, chatId: r1.projCfg.chatId, botId: 7, projectKey: r1.lookupKey, resolvedBy: r1.resolvedBy }, reg, lock);
    const r2 = route('/repos/acmebot');               // cd elsewhere: the promoted anchor holds
    assert.equal(r2.projCfg.chatId, '-1003003');
    assert.equal(r2.resolvedBy, 'anchor');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

