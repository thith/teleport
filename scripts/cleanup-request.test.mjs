import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTarget, writeRequest } from './cleanup-request.mjs';
import {
  validCleanupRequest, formatCleanupResult, buildCleanupResultPrompt, processCleanupRequests, unclaim,
} from './cleanup-inbox.mjs';
import { cleanupRequested, runCleanup } from './cleanup.mjs';
import { claimRequests, deliverResult } from './merge-inbox.mjs';
import { acquireLock } from './machine-lock.mjs';

const execFileP = promisify(execFile);
const DAY = 24 * 3600_000;
const OLD_NOW = Date.now() + 30 * DAY; // everything the test creates is "30 days old"
const tmp = (p = 'tp-creq-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (f, s = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// Same temp-git-repo harness as cleanup.test.mjs.
function world() {
  const parent = tmp();
  const main = path.join(parent, 'repo');
  fs.mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main');
  write(path.join(main, '.gitignore'), '.env\ntarget/\n');
  write(path.join(main, 'README.md'), 'hi');
  g(main, 'add', '.');
  g(main, 'commit', '-q', '-m', 'init');
  g(main, 'remote', 'add', 'origin', 'git@github.com:acme/repo.git');
  const lockDir = path.join(parent, '.locks');
  const add = (name, { detached = false, where = null } = {}) => {
    const p = where || path.join(parent, `repo-${name}`); // the workspace convention: a sibling
    if (detached) g(main, 'worktree', 'add', '-q', '--detach', p);
    else g(main, 'worktree', 'add', '-q', '-b', name, p);
    g(p, 'commit', '-q', '--allow-empty', '-m', `work on ${name}`);
    return { path: p, branch: name, head: g(p, 'rev-parse', 'HEAD') };
  };
  return { parent, main, lockDir, add };
}
const merged = (wt, n = 1) => [{ number: n, state: 'MERGED', headRefOid: wt.head, headRefName: wt.branch }];
function deps({ prs = {}, procs = [], transcripts = [], calls = [] } = {}) {
  return {
    exec: async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh') return JSON.stringify(prs[args[args.indexOf('--head') + 1]] || []);
      return (await execFileP(cmd, args, opts)).stdout;
    },
    procCwds: () => procs,
    transcriptCwds: () => new Set(transcripts),
    log: () => {},
  };
}
const req = (w, target, d, now = Date.now()) => cleanupRequested(target, { parentDir: w.parent, now, deps: d });
const daily = (w, d, now) => runCleanup({ parentDir: w.parent, now, lockDir: w.lockDir, cargoCacheDir: path.join(w.parent, 'no-cache'), deps: d });

// ── request file ─────────────────────────────────────────────────────────────

test('validCleanupRequest: shape {path, convoId, createdAt}; junk/stale → null', () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(validCleanupRequest({ path: '/w/a/', convoId: '42', createdAt: now }, { now }), { path: '/w/a/', convoId: '42' });
  assert.deepEqual(validCleanupRequest({ path: '/w/x/../a', convoId: 7, createdAt: now }, { now }).path, '/w/a');
  for (const bad of [
    null, [], 'x', { convoId: '1', createdAt: now }, { path: 'rel/a', convoId: '1', createdAt: now },
    { path: '/a\0b', convoId: '1', createdAt: now }, { path: '/a\nb', convoId: '1', createdAt: now },
    { path: '/a', convoId: '-1', createdAt: now }, { path: '/a', convoId: 'abc', createdAt: now },
    { path: '/a', convoId: '1' }, { path: '/a', convoId: '1', createdAt: '1' },
    { path: '/a', convoId: '1', createdAt: now - 25 * 3600_000 }, { path: `/${'a'.repeat(5000)}`, convoId: '1', createdAt: now },
  ]) assert.equal(validCleanupRequest(bad, { now }), null, JSON.stringify(bad)?.slice(0, 80));
});

test('writeRequest: atomic 0600 file with exactly {path, convoId, createdAt}; claimable once', () => {
  const dir = path.join(tmp(), 'inbox');
  const f = writeRequest({ path: '/w/repo-x', convoId: 42, dir, now: 123 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { path: '/w/repo-x', convoId: '42', createdAt: 123 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.')), false, 'no temp file left');
  const c = [...claimRequests(dir)];
  assert.equal(c.length, 1);
  assert.equal(c[0].body.path, '/w/repo-x');
  assert.equal([...claimRequests(dir)].length, 0);
  unclaim(c[0].file);
  assert.equal([...claimRequests(dir)].length, 1, 'a put-back request is claimable again');
});

test('resolveTarget: path → realpath of the worktree root; branch → its worktree; unknown → error', () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, 'sub', 'f.txt'));
  assert.deepEqual(resolveTarget(path.join(a.path, 'sub'), { cwd: w.parent }), { path: a.path });
  assert.deepEqual(resolveTarget('repo-feat-a', { cwd: w.parent }), { path: a.path }, 'relative path resolved against cwd');
  const link = path.join(w.parent, 'lnk');
  fs.symlinkSync(a.path, link);
  assert.deepEqual(resolveTarget(link, { cwd: '/' }), { path: a.path }, 'symlink realpathed');
  assert.deepEqual(resolveTarget('feat-a', { cwd: w.main }), { path: a.path });
  assert.deepEqual(resolveTarget('refs/heads/feat-a', { cwd: w.main }), { path: a.path });
  assert.match(resolveTarget('nope', { cwd: w.main }).error, /no worktree/);
  assert.match(resolveTarget('feat-a', { cwd: tmp() }).error, /not in a git repo/);
  assert.match(resolveTarget(tmp(), { cwd: '/' }).error, /not inside a git worktree/);
  // An existing path wins over a branch of the same name.
  fs.mkdirSync(path.join(w.main, 'feat-a'));
  write(path.join(w.main, 'feat-a', 'k'));
  assert.deepEqual(resolveTarget('feat-a', { cwd: w.main }), { path: w.main });
});

// ── requested-mode judge ─────────────────────────────────────────────────────

test('requested: SKIPS the 24h-edit gate — fresh files, merged + clean → removed (daily keeps it)', async () => {
  const w = world();
  const a = w.add('feat-a');
  const prs = { 'feat-a': merged(a) };
  const now = Date.now(); // files were just written → "modified within 24h"
  const d0 = await daily(w, deps({ prs }), now);
  assert.match(d0.kept.find((k) => k.path === a.path)?.reason || '', /24h/, 'the daily run keeps it');
  const r = await req(w, a.path, deps({ prs }), now);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(a.path), false);
  assert.match(g(w.main, 'branch', '--list', 'feat-a'), /feat-a/, 'branch kept');
  assert.ok(r.bytes > 0);
  assert.equal(r.pr, 1);
  assert.match(formatCleanupResult(r), /^✅ đã xoá worktree .*repo-feat-a \(nhánh feat-a giữ nguyên\), lấy lại [\d.]+ GB$/);
});

test('requested: SKIPS the 7-day-transcript gate (daily keeps it)', async () => {
  const w = world();
  const a = w.add('feat-a');
  const prs = { 'feat-a': merged(a) };
  const d0 = await daily(w, deps({ prs, transcripts: [a.path] }), OLD_NOW);
  assert.match(d0.kept.find((k) => k.path === a.path)?.reason || '', /phiên Claude/);
  const r = await req(w, a.path, deps({ prs, transcripts: [a.path] }), OLD_NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('requested: a process cwd inside → kept (the requester must cd out first)', async () => {
  const w = world();
  const a = w.add('feat-a');
  const r = await req(w, a.path, deps({ prs: { 'feat-a': merged(a) }, procs: [{ pid: 4242, cwd: path.join(a.path, 'sub') }] }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /tiến trình .*4242/);
  assert.ok(fs.existsSync(a.path));
  assert.match(formatCleanupResult(r), /^❌ giữ lại .*repo-feat-a: có tiến trình/);
});

test('requested: a process enters between the judge and the removal → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  const d = deps({ prs: { 'feat-a': merged(a) } });
  let n = 0;
  d.procCwds = () => (++n > 1 ? [{ pid: 7, cwd: a.path }] : []);
  const r = await req(w, a.path, d);
  assert.equal(r.ok, false);
  assert.match(r.reason, /vừa vào/);
  assert.ok(fs.existsSync(a.path));
});

test('requested: no PR / closed PR / open PR / HEAD moved after merge → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  for (const [prs, re] of [
    [[], /chưa có PR merged/],
    [[{ number: 1, state: 'CLOSED', headRefOid: a.head, headRefName: 'feat-a' }], /chưa có PR merged/],
    [[...merged(a), { number: 2, state: 'OPEN', headRefOid: a.head, headRefName: 'feat-a' }], /đang mở/],
    [[{ number: 1, state: 'MERGED', headRefOid: 'f'.repeat(40), headRefName: 'feat-a' }], /commit mới/],
  ]) {
    const r = await req(w, a.path, deps({ prs: { 'feat-a': prs } }));
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  }
  assert.ok(fs.existsSync(a.path));
});

test('requested: every other gate stays — dirty, stray file, ignored secret, skip-worktree, locked, detached', async () => {
  const w = world();
  const cases = [
    ['dirty', (p) => write(path.join(p, 'README.md'), 'changed'), /chưa commit/],
    ['stray', (p) => write(path.join(p, 'notes.txt')), /ngoài git/],
    ['secret', (p) => write(path.join(p, '.env'), 'K=v'), /ngoài git: \.env/],
    ['skipwt', (p) => g(p, 'update-index', '--skip-worktree', 'README.md'), /skip-worktree/],
    ['locked', (p) => g(w.main, 'worktree', 'lock', p), /khoá/],
  ];
  for (const [name, mutate, re] of cases) {
    const wt = w.add(name);
    mutate(wt.path);
    const r = await req(w, wt.path, deps({ prs: { [name]: merged(wt) } }));
    assert.equal(r.ok, false, name);
    assert.match(r.reason, re, name);
    assert.ok(fs.existsSync(wt.path), name);
  }
  const det = w.add('det', { detached: true });
  const r = await req(w, det.path, deps());
  assert.match(r.reason, /detached/);
});

test('requested: only build output untracked → removed', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, 'target', 'debug', 'x.o'));
  const r = await req(w, a.path, deps({ prs: { 'feat-a': merged(a) } }));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('requested: main checkout never; subdir (not a root) / outside workspace / missing → kept, no gh call', async () => {
  const w = world();
  const a = w.add('feat-a');
  const calls = [];
  const head = g(w.main, 'rev-parse', 'HEAD');
  const d = deps({ calls, prs: { main: [{ number: 9, state: 'MERGED', headRefOid: head, headRefName: 'main' }] } });
  assert.match((await req(w, w.main, d)).reason, /checkout chính/);
  fs.mkdirSync(path.join(a.path, 'sub'));
  assert.match((await req(w, path.join(a.path, 'sub'), d)).reason, /không phải gốc/);
  const outside = world();
  const o = outside.add('feat-o');
  assert.match((await req(w, o.path, d)).reason, /ngoài workspace/);
  assert.match((await req(w, w.parent, d)).reason, /ngoài workspace/);
  assert.match((await req(w, path.join(w.parent, 'gone'), d)).reason, /không tìm thấy/);
  assert.ok(!calls.some((c) => c[0] === 'gh'));
  assert.ok(!calls.some((c) => c.includes(o.path)), 'no git on a path outside the workspace');
  assert.ok(fs.existsSync(path.join(w.main, '.git')) && fs.existsSync(a.path) && fs.existsSync(o.path));
});

test('requested: a worktree nested in the main checkout (.claude/worktrees/x) works too', async () => {
  const w = world();
  const a = w.add('feat-n', { where: path.join(w.main, '.claude', 'worktrees', 'feat-n') });
  const r = await req(w, a.path, deps({ prs: { 'feat-n': merged(a) } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(w.main, 'README.md')));
});

// ── delivery ─────────────────────────────────────────────────────────────────

test('buildCleanupResultPrompt: non-privileged daemon prompt carrying cleanupResult', async () => {
  const p = buildCleanupResultPrompt({ convoId: '42', chatId: '-100', text: '✅ đã xoá worktree /w/x (nhánh b giữ nguyên), lấy lại 1.2 GB', ok: true, path: '/w/x' });
  assert.equal(p.fromRole, 'daemon');
  assert.equal(p.fromMember, null);
  assert.equal(p.fromUserId, null);
  assert.equal(p.convoId, 42);
  assert.equal(p.chatId, '-100');
  assert.deepEqual(p.cleanupResult, { ok: true, path: '/w/x', text: '✅ đã xoá worktree /w/x (nhánh b giữ nguyên), lấy lại 1.2 GB' });
  assert.match(p.text, /kết quả cleanup-request\.\n✅ đã xoá worktree \/w\/x[\s\S]*Nếu không phải của bạn: bỏ qua/);
  assert.equal(p.mergeResult, undefined);
  const writes = [];
  await deliverResult({ convoId: '42', text: '❌ giữ lại /w/x: y', ok: false, path: '/w/x' },
    { build: buildCleanupResultPrompt, store: { '-100': { 42: 7 } }, tmpDir: '/q', write: async (o, f) => writes.push({ o, f }) });
  assert.equal(writes[0].f, '/q/prompt-convo-42.json');
  assert.equal(writes[0].o.chatId, '-100');
  assert.equal(writes[0].o.cleanupResult.ok, false);
});

function inboxHarness() {
  const dir = path.join(tmp(), 'inbox');
  const delivered = [], dms = [], audits = [], ran = [];
  const opts = {
    claim: () => claimRequests(dir),
    deliver: async (r, o) => { delivered.push(o.build(r)); },
    audit: (e) => audits.push(e),
    lockDir: path.join(path.dirname(dir), 'locks'),
    waitSec: 0,
  };
  const ctx = { daemonUserId: '1', sendText: async (c, t) => { dms.push([c, t]); } };
  return { dir, delivered, dms, audits, ran, opts, ctx };
}

test('processCleanupRequests: runs, delivers cleanupResult, DMs owner one line, audits, removes the file', async () => {
  const h = inboxHarness();
  writeRequest({ path: '/w/repo-x', convoId: 42, dir: h.dir });
  await processCleanupRequests(h.ctx, { ...h.opts, label: () => 'Giun #42', run: async (p) => { h.ran.push(p); return { ok: true, path: p, branch: 'b', pr: 3, bytes: 2 ** 30 }; } });
  assert.deepEqual(h.ran, ['/w/repo-x']);
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].convoId, 42);
  assert.deepEqual(h.delivered[0].cleanupResult, { ok: true, path: '/w/repo-x', text: '✅ đã xoá worktree /w/repo-x (nhánh b giữ nguyên), lấy lại 1.0 GB' });
  assert.deepEqual(h.dms, [['1', '🧹 cleanup-request của Giun #42: ✅ đã xoá worktree /w/repo-x (nhánh b giữ nguyên), lấy lại 1.0 GB']]);
  assert.equal(h.audits[0].ok, true);
  assert.equal(h.audits[0].requester, '42');
  assert.deepEqual(fs.readdirSync(h.dir), [], 'request removed');
});

test('processCleanupRequests: kept → ❌ delivered; malformed → dropped silently', async () => {
  const h = inboxHarness();
  writeRequest({ path: '/w/repo-y', convoId: 7, dir: h.dir, now: Date.now() - 1 });
  fs.writeFileSync(path.join(h.dir, `${Date.now()}-deadbeef.json`), JSON.stringify({ path: 'relative', convoId: '7', createdAt: Date.now() }));
  await processCleanupRequests(h.ctx, { ...h.opts, run: async (p) => ({ ok: false, path: p, reason: 'chưa có PR merged' }) });
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].cleanupResult.text, '❌ giữ lại /w/repo-y: chưa có PR merged');
  assert.equal(h.audits.length, 1);
  assert.deepEqual(fs.readdirSync(h.dir), []);
});

test('processCleanupRequests: `cleanup` lock busy → put back for a later pass, nothing run or delivered', async () => {
  const h = inboxHarness();
  writeRequest({ path: '/w/repo-z', convoId: 9, dir: h.dir });
  const held = await acquireLock('cleanup', { waitSec: 0, dir: h.opts.lockDir, cmd: 'test' });
  try {
    await processCleanupRequests(h.ctx, { ...h.opts, run: async () => { throw new Error('must not run'); } });
  } finally { held.release(); }
  assert.equal(h.delivered.length, 0);
  assert.equal(h.dms.length, 0);
  assert.deepEqual(fs.readdirSync(h.dir).filter((n) => n.endsWith('.json')).length, 1, 'request back in the queue (not .processing)');
  // Lock free now → handled on the next pass.
  await processCleanupRequests(h.ctx, { ...h.opts, run: async (p) => ({ ok: false, path: p, reason: 'x' }) });
  assert.equal(h.delivered.length, 1);
  assert.deepEqual(fs.readdirSync(h.dir), []);
});

test('processCleanupRequests: the run is done while holding the `cleanup` lock', async () => {
  const h = inboxHarness();
  writeRequest({ path: '/w/repo-l', convoId: 9, dir: h.dir });
  let busyDuringRun = null;
  await processCleanupRequests(h.ctx, { ...h.opts, run: async (p) => {
    busyDuringRun = !!(await acquireLock('cleanup', { waitSec: 0, dir: h.opts.lockDir })).timeout;
    return { ok: false, path: p, reason: 'x' };
  } });
  assert.equal(busyDuringRun, true);
});

test('processCleanupRequests end-to-end on a real repo: merged worktree removed, result delivered', async () => {
  const w = world();
  const a = w.add('feat-a');
  const h = inboxHarness();
  writeRequest({ path: a.path, convoId: 5, dir: h.dir });
  await processCleanupRequests(h.ctx, { ...h.opts, parentDir: w.parent, deps: deps({ prs: { 'feat-a': merged(a) } }) });
  assert.equal(fs.existsSync(a.path), false);
  assert.match(h.delivered[0].cleanupResult.text, /^✅ đã xoá worktree /);
});
