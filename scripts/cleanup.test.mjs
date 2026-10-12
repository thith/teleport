import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runCleanup, parseWorktreePorcelain, githubSlug, isBuildPath, parseStatusZ, judgePrs, formatReport,
  findRecentFile, readTranscriptCwds, parseCleanupArgs, MAX_REMOVALS,
} from './cleanup.mjs';
import { decideScheduledRun, cleanupTick, readCleanupState, launchCleanup } from './cleanup-launch.mjs';
import { acquireLock } from './machine-lock.mjs';

const execFileP = promisify(execFile);
const DAY = 24 * 3600_000;
// Everything created by the test is ~30 days old relative to this "now".
const NOW = Date.now() + 30 * DAY;
const tmp = (p = 'tp-clean-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (f, s = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const touchAt = (f, t) => fs.utimesSync(f, new Date(t), new Date(t));

function world() {
  const parent = tmp();
  const main = path.join(parent, 'repo');
  fs.mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main');
  write(path.join(main, '.gitignore'), '.env\ntarget/\nlocal.properties\n');
  write(path.join(main, 'README.md'), 'hi');
  g(main, 'add', '.');
  g(main, 'commit', '-q', '-m', 'init');
  g(main, 'remote', 'add', 'origin', 'git@github.com:acme/repo.git');
  const lockDir = path.join(parent, '.locks');
  const add = (name, { detached = false } = {}) => {
    const p = path.join(main, '.claude', 'worktrees', name);
    if (detached) g(main, 'worktree', 'add', '-q', '--detach', p);
    else g(main, 'worktree', 'add', '-q', '-b', name, p);
    g(p, 'commit', '-q', '--allow-empty', '-m', `work on ${name}`);
    return { path: p, branch: name, head: g(p, 'rev-parse', 'HEAD') };
  };
  return { parent, main, lockDir, add };
}

const merged = (wt, n = 1) => [{ number: n, state: 'MERGED', headRefOid: wt.head, headRefName: wt.branch }];

function deps({ prs = {}, procs = [], transcripts = [], ghError = new Set(), calls = [] } = {}) {
  return {
    exec: async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh') {
        const b = args[args.indexOf('--head') + 1];
        if (ghError.has(b)) throw new Error('gh: HTTP 502');
        return JSON.stringify(prs[b] || []);
      }
      return (await execFileP(cmd, args, opts)).stdout;
    },
    procCwds: () => procs,
    transcriptCwds: () => new Set(transcripts),
    log: () => {},
  };
}

const run = (w, d, extra = {}) => runCleanup({ parentDir: w.parent, now: NOW, lockDir: w.lockDir, cargoCacheDir: path.join(w.parent, 'no-cache'), deps: d, ...extra });
const exists = (p) => fs.existsSync(p);
const keptReason = (r, wt) => r.kept.find((k) => k.path === wt.path)?.reason;

// ── pure helpers ─────────────────────────────────────────────────────────────

test('parseWorktreePorcelain: main first; branch/detached/locked/prunable', () => {
  const l = parseWorktreePorcelain('worktree /a\nHEAD aaa\nbranch refs/heads/main\n\nworktree /b\nHEAD bbb\ndetached\n\nworktree /c\nHEAD ccc\nbranch refs/heads/x\nlocked reason here\n\nworktree /d\nHEAD ddd\nbranch refs/heads/y\nprunable gitdir file points to non-existent location\n');
  assert.equal(l.length, 4);
  assert.equal(l[0].branch, 'refs/heads/main');
  assert.equal(l[1].detached, true);
  assert.equal(l[2].locked, true);
  assert.equal(l[3].prunable, true);
});

test('githubSlug: ssh/https forms; non-GitHub → null', () => {
  assert.equal(githubSlug('git@github.com:acme/repo.git'), 'acme/repo');
  assert.equal(githubSlug('https://github.com/acme/re.po\n'), 'acme/re.po');
  assert.equal(githubSlug('ssh://git@github.com/acme/repo.git'), 'acme/repo');
  assert.equal(githubSlug('https://gitlab.com/acme/repo.git'), null);
  assert.equal(githubSlug(''), null);
});

test('isBuildPath: build dir as a directory segment only', () => {
  for (const p of ['target/', 'server/target/', 'android/app/build/', 'node_modules/', 'a/__pycache__/x.pyc', '.gradle/', 'web/dist/']) assert.ok(isBuildPath(p), p);
  for (const p of ['.env', 'build', 'local.properties', '.claude/', 'tmp/', 'app/release.jks', 'targets/', '.claude/settings.local.json']) assert.ok(!isBuildPath(p), p);
});

test('parseStatusZ: tracked vs untracked/ignored; rename consumes the source token', () => {
  const s = parseStatusZ(' M a.txt\0R  new\0old\0?? tmp/\0!! server/target/\0');
  assert.deepEqual(s.tracked, ['a.txt', 'new']);
  assert.deepEqual(s.extra, ['tmp/', 'server/target/']);
});

test('judgePrs: merged at HEAD ok; moved HEAD / open / none / other branch name → keep', () => {
  const h = 'a'.repeat(40);
  assert.equal(judgePrs([{ number: 1, state: 'MERGED', headRefOid: h, headRefName: 'b' }], 'b', h).ok, true);
  assert.match(judgePrs([{ number: 1, state: 'MERGED', headRefOid: 'f'.repeat(40), headRefName: 'b' }], 'b', h).reason, /commit mới/);
  assert.match(judgePrs([{ number: 1, state: 'MERGED', headRefOid: h, headRefName: 'b' }, { number: 2, state: 'OPEN', headRefOid: h, headRefName: 'b' }], 'b', h).reason, /đang mở #2/);
  assert.equal(judgePrs([{ number: 1, state: 'MERGED', headRefOid: h, headRefName: 'b-2' }], 'b', h).ok, false);
  assert.equal(judgePrs([{ number: 1, state: 'CLOSED', headRefOid: h, headRefName: 'b' }], 'b', h).ok, false);
  assert.throws(() => judgePrs({}, 'b', h));
});

test('parseCleanupArgs: only --dry-run / --report-to-owner', () => {
  assert.deepEqual(parseCleanupArgs(['--dry-run']), { dryRun: true, reportToOwner: false });
  assert.throws(() => parseCleanupArgs(['--force']), /unknown argument/);
});

test('readTranscriptCwds: recent transcripts only, cwd from the head of the file', () => {
  const root = tmp();
  write(path.join(root, 'p1', 'a.jsonl'), '{"type":"mode"}\n{"type":"user","cwd":"/w/one","x":1}\n');
  write(path.join(root, 'p2', 'b.jsonl'), '{"type":"user","cwd":"/w/old"}\n');
  touchAt(path.join(root, 'p2', 'b.jsonl'), Date.now() - 10 * DAY);
  const s = readTranscriptCwds({ root, since: Date.now() - 7 * DAY });
  assert.deepEqual([...s], ['/w/one']);
  assert.equal(readTranscriptCwds({ root: path.join(root, 'nope'), since: 0 }).size, 0);
});

test('findRecentFile: skips build dirs and .git; bounded', () => {
  const d = tmp();
  write(path.join(d, 'a', 'old.txt'));
  write(path.join(d, 'target', 'new.o'));
  write(path.join(d, '.git', 'index'));
  touchAt(path.join(d, 'a', 'old.txt'), Date.now() - 2 * DAY);
  assert.equal(findRecentFile(d, { since: Date.now() - DAY }).recent, null);
  write(path.join(d, 'a', 'new.txt'));
  assert.ok(findRecentFile(d, { since: Date.now() - DAY }).recent.endsWith('new.txt'));
  assert.equal(findRecentFile(d, { since: 0, maxEntries: 1 }).truncated, true);
});

// ── E1 on a real git repo ────────────────────────────────────────────────────

test('E1: merged + clean + old → removed (branch kept); main checkout untouched', async () => {
  const w = world();
  const a = w.add('feat-a');
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }));
  assert.deepEqual(r.removed.map((x) => x.path), [a.path]);
  assert.equal(exists(a.path), false, JSON.stringify(r.kept));
  assert.ok(exists(path.join(w.main, 'README.md')));
  assert.match(g(w.main, 'branch', '--list', 'feat-a'), /feat-a/);
  assert.ok(r.removed[0].bytes > 0);
  assert.match(formatReport(r), /đã xoá \(1/);
});

test('E1: main checkout is never a candidate, even with a merged PR for main', async () => {
  const w = world();
  const head = g(w.main, 'rev-parse', 'HEAD');
  const calls = [];
  const r = await run(w, deps({ calls, prs: { main: [{ number: 9, state: 'MERGED', headRefOid: head, headRefName: 'main' }] } }));
  assert.equal(r.removed.length, 0);
  assert.equal(r.kept.length, 0);
  assert.ok(!calls.some((c) => c[0] === 'gh'));
  assert.ok(exists(path.join(w.main, '.git')));
});

test('E1: HEAD moved after the merge → kept (notable)', async () => {
  const w = world();
  const a = w.add('feat-a');
  const prs = { 'feat-a': merged(a) };
  g(a.path, 'commit', '-q', '--allow-empty', '-m', 'after merge');
  const r = await run(w, deps({ prs }));
  assert.equal(r.removed.length, 0);
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /commit mới/);
  assert.ok(r.kept[0].notable);
});

test('E1: an OPEN PR on the branch → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  const r = await run(w, deps({ prs: { 'feat-a': [...merged(a), { number: 2, state: 'OPEN', headRefOid: a.head, headRefName: 'feat-a' }] } }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /đang mở/);
});

test('E1: no PR / closed PR → kept, not notable', async () => {
  const w = world();
  const a = w.add('feat-a');
  const r = await run(w, deps());
  assert.ok(exists(a.path));
  assert.equal(r.kept[0].notable, false);
});

test('E1: dirty tracked file → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, 'README.md'), 'changed');
  touchAt(path.join(a.path, 'README.md'), Date.now() - 40 * DAY);
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /chưa commit/);
});

test('E1: ignored .env (a secret) → kept and reported', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, '.env'), 'TOKEN=1');
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /ngoài git: \.env/);
  assert.match(formatReport(r), /\.env/);
});

test('E1: untracked non-build dir (tmp/) → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, 'tmp', 'notes.txt'));
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /tmp\//);
});

test('E1: untracked .claude/settings.local.json / ignored local.properties → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, '.claude', 'settings.local.json'), '{}');
  const b = w.add('feat-b');
  write(path.join(b.path, 'android', 'local.properties'), 'sdk.dir=/x');
  const r = await run(w, deps({ prs: { 'feat-a': merged(a), 'feat-b': merged(b, 2) } }));
  assert.ok(exists(a.path) && exists(b.path));
  assert.match(keptReason(r, a), /settings\.local\.json/);
  assert.match(keptReason(r, b), /local\.properties/);
});

test('E1: only ignored server/target/x → removed', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, 'server', 'target', 'x'));
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }));
  assert.equal(exists(a.path), false, JSON.stringify(r.kept));
  assert.equal(r.removed.length, 1);
});

test('E1: a process cwd inside → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) }, procs: [{ pid: 4242, cwd: path.join(fs.realpathSync(a.path), 'sub') }] }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /pid 4242/);
});

test('E1: a file modified within 24h → kept; same in a build dir does not count', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, 'server', 'target', 'fresh.o'));
  touchAt(path.join(a.path, 'server', 'target', 'fresh.o'), NOW - 3600_000);
  const b = w.add('feat-b');
  touchAt(path.join(b.path, 'README.md'), NOW - 3600_000);
  const r = await run(w, deps({ prs: { 'feat-a': merged(a), 'feat-b': merged(b, 2) } }));
  assert.equal(exists(a.path), false, JSON.stringify(r.kept));
  assert.ok(exists(b.path));
  assert.match(keptReason(r, b), /24h \(README\.md\)/);
});

test('E1: locked worktree → kept (and git itself would refuse a single --force)', async () => {
  const w = world();
  const a = w.add('feat-a');
  g(w.main, 'worktree', 'lock', a.path);
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /khoá/);
  assert.throws(() => g(w.main, 'worktree', 'remove', '--force', a.path));
});

test('E1: detached HEAD → kept', async () => {
  const w = world();
  const a = w.add('det', { detached: true });
  const r = await run(w, deps({ prs: {} }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /detached/);
});

test('E1: gh error → kept, nothing removed', async () => {
  const w = world();
  const a = w.add('feat-a');
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) }, ghError: new Set(['feat-a']) }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /lỗi: gh: HTTP 502/);
});

test('E1: garbage gh output → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  const d = deps();
  const exec0 = d.exec;
  d.exec = async (cmd, args, o) => (cmd === 'gh' ? 'not json' : exec0(cmd, args, o));
  const r = await run(w, d);
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /lỗi/);
});

test('E1: cwd of a recent Claude transcript → kept; unreadable transcripts → keep all', async () => {
  const w = world();
  const a = w.add('feat-a');
  let r = await run(w, deps({ prs: { 'feat-a': merged(a) }, transcripts: [a.path] }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /phiên Claude/);
  const d = deps({ prs: { 'feat-a': merged(a) } });
  d.transcriptCwds = () => { throw new Error('EACCES'); };
  r = await run(w, d);
  assert.ok(exists(a.path));
  assert.equal(r.removed.length, 0);
  assert.match(keptReason(r, a), /không đọc được transcript/);
});

test('E1: /proc unreadable → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  const d = deps({ prs: { 'feat-a': merged(a) } });
  d.procCwds = () => { throw new Error('no /proc'); };
  const r = await run(w, d);
  assert.ok(exists(a.path));
});

test('E1: non-GitHub origin → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  g(w.main, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/repo.git');
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }));
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /GitHub/);
});

test('E1: worktree outside the workspace → kept', async () => {
  const w = world();
  const outside = path.join(tmp('tp-out-'), 'wt');
  g(w.main, 'worktree', 'add', '-q', '-b', 'far', outside);
  const head = g(outside, 'rev-parse', 'HEAD');
  const r = await run(w, deps({ prs: { far: [{ number: 1, state: 'MERGED', headRefOid: head, headRefName: 'far' }] } }));
  assert.ok(exists(outside));
  assert.equal(r.removed.length, 0);
});

test(`E1: at most ${MAX_REMOVALS} removals per run`, async () => {
  const w = world();
  const prs = {};
  const wts = [];
  for (let i = 0; i < MAX_REMOVALS + 2; i++) { const t = w.add(`b${String(i).padStart(2, '0')}`); prs[t.branch] = merged(t, i + 1); wts.push(t); }
  const r = await run(w, deps({ prs }));
  assert.equal(r.removed.length, MAX_REMOVALS);
  assert.equal(wts.filter((t) => exists(t.path)).length, 2);
  assert.ok(r.errors.some((e) => /giới hạn 30/.test(e)));
});

test('E1+E2: --dry-run decides but deletes nothing', async () => {
  const w = world();
  const a = w.add('feat-a');
  const b = w.add('feat-b');
  write(path.join(b.path, 'crate', 'Cargo.toml'), '[package]');
  write(path.join(b.path, 'crate', 'target', 'debug', 'big'), 'x'.repeat(1000));
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }), { dryRun: true });
  assert.equal(r.removed.length, 1);
  assert.equal(r.targets.length, 1);
  assert.ok(exists(a.path));
  assert.ok(exists(path.join(b.path, 'crate', 'target', 'debug', 'big')));
  assert.match(formatReport(r), /DRY-RUN/);
});

// ── E2 ───────────────────────────────────────────────────────────────────────

test('E2: idle target/ next to Cargo.toml in a kept worktree → removed; worktree stays', async () => {
  const w = world();
  const b = w.add('feat-b');
  write(path.join(b.path, 'crate', 'Cargo.toml'), '[package]');
  write(path.join(b.path, 'crate', 'target', 'debug', 'big'), 'x'.repeat(1000));
  write(path.join(b.path, 'other', 'target', 'keep.txt')); // no Cargo.toml beside it
  const r = await run(w, deps());
  assert.ok(exists(b.path));
  assert.equal(exists(path.join(b.path, 'crate', 'target')), false);
  assert.ok(exists(path.join(b.path, 'other', 'target', 'keep.txt')));
  assert.deepEqual(r.targets.map((t) => t.path), [path.join(fs.realpathSync(b.path), 'crate', 'target')]);
});

test('E2: target/ with a file modified within 3 days → kept', async () => {
  const w = world();
  const b = w.add('feat-b');
  write(path.join(b.path, 'Cargo.toml'), '[package]');
  write(path.join(b.path, 'target', 'debug', 'old'));
  write(path.join(b.path, 'target', 'debug', 'fresh'));
  touchAt(path.join(b.path, 'target', 'debug', 'fresh'), NOW - 2 * DAY);
  const r = await run(w, deps());
  assert.ok(exists(path.join(b.path, 'target', 'debug', 'old')));
  assert.equal(r.targets.length, 0);
});

test('E2: a process inside the worktree → target/ kept', async () => {
  const w = world();
  const b = w.add('feat-b');
  write(path.join(b.path, 'Cargo.toml'), '[package]');
  write(path.join(b.path, 'target', 'x'));
  const r = await run(w, deps({ procs: [{ pid: 7, cwd: fs.realpathSync(b.path) }] }));
  assert.ok(exists(path.join(b.path, 'target', 'x')));
  assert.equal(r.targets.length, 0);
});

test('E2: the main checkout\'s target/ is not touched', async () => {
  const w = world();
  write(path.join(w.main, 'Cargo.toml'), '[package]');
  write(path.join(w.main, 'target', 'x'));
  const r = await run(w, deps());
  assert.ok(exists(path.join(w.main, 'target', 'x')));
  assert.equal(r.targets.length, 0);
});

test('C cache: idle subdir pruned, recent kept; skipped while the build lock is held', async () => {
  const w = world();
  const cache = path.join(w.parent, 'cache');
  write(path.join(cache, 'old-abc123', 'debug', 'x'));
  write(path.join(cache, 'new-def456', 'debug', 'x'));
  touchAt(path.join(cache, 'new-def456', 'debug', 'x'), NOW - 2 * DAY);
  const held = await acquireLock('build', { dir: w.lockDir, waitSec: 0 });
  let r = await run(w, deps(), { cargoCacheDir: cache });
  assert.match(r.cacheSkipped, /build/);
  assert.ok(exists(path.join(cache, 'old-abc123')));
  held.release();
  r = await run(w, deps(), { cargoCacheDir: cache });
  assert.equal(r.cacheSkipped, null);
  assert.equal(exists(path.join(cache, 'old-abc123')), false);
  assert.ok(exists(path.join(cache, 'new-def456')));
  assert.deepEqual(r.cache.map((c) => path.basename(c.path)), ['old-abc123']);
});

// ── scheduler / launcher ─────────────────────────────────────────────────────

test('decideScheduledRun: no state → dry run; <24h → no; ≥24h → real', () => {
  const now = 1e12;
  assert.deepEqual(decideScheduledRun(null, now), { run: true, dryRun: true });
  assert.deepEqual(decideScheduledRun({ lastCleanupAt: now - 3600_000 }, now), { run: false });
  assert.deepEqual(decideScheduledRun({ lastCleanupAt: now - DAY }, now), { run: true, dryRun: false });
  assert.deepEqual(decideScheduledRun({ lastCleanupAt: now + 5 * DAY }, now), { run: true, dryRun: false });
});

test('cleanupTick: first ever → dry run + state written atomically; then waits 24h; garbled state → dry run', () => {
  const d = tmp();
  const stateFile = path.join(d, 'cleanup-state.json');
  const launches = [];
  const launch = (o) => launches.push(o);
  cleanupTick({ stateFile, launch, now: 1000 });
  assert.deepEqual(launches, [{ dryRun: true }]);
  assert.equal(readCleanupState(stateFile).lastCleanupAt, 1000);
  cleanupTick({ stateFile, launch, now: 1000 + DAY - 1 });
  assert.equal(launches.length, 1);
  cleanupTick({ stateFile, launch, now: 1000 + DAY });
  assert.deepEqual(launches[1], { dryRun: false });
  fs.writeFileSync(stateFile, '{garbled');
  cleanupTick({ stateFile, launch, now: 5 * DAY });
  assert.deepEqual(launches[2], { dryRun: true });
  assert.deepEqual(fs.readdirSync(d), ['cleanup-state.json']);
});

test('cleanupTick: unwritable state → no launch', () => {
  const d = tmp();
  const launches = [];
  write(path.join(d, 'file'));
  const r = cleanupTick({ stateFile: path.join(d, 'file', 'x.json'), launch: (o) => launches.push(o), now: 1, log: () => {} });
  assert.equal(launches.length, 0);
  assert.equal(r.error, true);
});

test('launchCleanup: detached, stdio not piped, --report-to-owner (+ --dry-run), unref', () => {
  const seen = {};
  const fake = (cmd, args, opts) => { Object.assign(seen, { cmd, args, opts }); return { pid: 123, on() {}, unref() { seen.unref = true; } }; };
  const pid = launchCleanup({ dryRun: true, spawnFn: fake, logFile: path.join(tmp(), 'c.log') });
  assert.equal(pid, 123);
  assert.equal(seen.opts.detached, true);
  assert.equal(seen.opts.stdio[0], 'ignore');
  assert.ok(seen.args[0].endsWith('cleanup.mjs'));
  assert.deepEqual(seen.args.slice(1), ['--report-to-owner', '--dry-run']);
  assert.equal(seen.unref, true);
});

test('commands.json: /cleanup is admin-only and runs the detached launcher', async () => {
  const { readCommandsFile, resolveCommand } = await import('./commands.mjs');
  const spec = resolveCommand('cleanup', readCommandsFile());
  assert.equal(spec.run, 'cleanup-launch.mjs');
  assert.equal(spec.minRole, 'admin');
});
