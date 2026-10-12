import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runCleanup, parseWorktreePorcelain, githubSlug, isBuildPath, parseStatusZ, judgePrs, formatReport,
  findRecentFile, readTranscriptCwds, parseCleanupArgs, MAX_REMOVALS, strayEntries, hiddenEdits, scanFileCwds, cli,
} from './cleanup.mjs';
import { decideScheduledRun, cleanupTick, readCleanupState, launchCleanup, parseLaunchArgs, recordDryRunReported } from './cleanup-launch.mjs';
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
  assert.deepEqual(s.untracked, ['tmp/']);
  assert.deepEqual(s.ignored, ['server/target/']);
});

test('strayEntries: untracked is always stray (even under build/); ignored only outside build dirs', () => {
  assert.deepEqual(strayEntries({ untracked: ['build/new.sh', 'dist/notes.md'], ignored: ['server/target/', '.env'] }), ['build/new.sh', 'dist/notes.md', '.env']);
  assert.deepEqual(strayEntries({ untracked: [], ignored: ['target/', 'app/build/', 'node_modules/'] }), []);
});

test('hiddenEdits: skip-worktree (S/s) and assume-unchanged (lowercase) flagged', () => {
  assert.deepEqual(hiddenEdits('H a\0S b\0h c\0s d\0H e\0'), ['b', 'c', 'd']);
  assert.deepEqual(hiddenEdits('H a\0H b\0'), []);
});

test('scanFileCwds: whole file, cwd lines spanning chunk boundaries, past the first 512 KB', () => {
  const f = path.join(tmp(), 't.jsonl');
  const filler = `{"type":"assistant","text":"${'é'.repeat(300_000)}"}\n`; // ~600 KB of multibyte text
  fs.writeFileSync(f, `{"cwd":"/w/first"}\n${filler}{"type":"user","cwd":"/w/late \\"q\\""}\n${filler}{"cwd":"/w/last"}`);
  assert.deepEqual([...scanFileCwds(f, new Set(), 4096)].sort(), ['/w/first', '/w/last', '/w/late "q"']);
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
  const cache = path.join(w.parent, 'cache');
  write(path.join(cache, 'old-abc123', 'debug', 'x'));
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }), { dryRun: true, cargoCacheDir: cache });
  assert.equal(r.removed.length, 1);
  assert.equal(r.targets.length, 1);
  assert.equal(r.cache.length, 1);
  assert.ok(exists(a.path));
  assert.ok(exists(path.join(b.path, 'crate', 'target', 'debug', 'big')));
  assert.ok(exists(path.join(cache, 'old-abc123', 'debug', 'x')));
  assert.match(formatReport(r), /DRY-RUN/);
});

test('E1: skip-worktree / assume-unchanged local edits (invisible to git status) → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  g(a.path, 'update-index', '--skip-worktree', 'README.md');
  write(path.join(a.path, 'README.md'), 'local secret edit');
  touchAt(path.join(a.path, 'README.md'), Date.now() - 40 * DAY);
  const b = w.add('feat-b');
  g(b.path, 'update-index', '--assume-unchanged', '.gitignore');
  write(path.join(b.path, '.gitignore'), 'changed\n');
  touchAt(path.join(b.path, '.gitignore'), Date.now() - 40 * DAY);
  assert.equal(g(a.path, 'status', '--porcelain'), ''); // what makes this dangerous
  const r = await run(w, deps({ prs: { 'feat-a': merged(a), 'feat-b': merged(b, 2) } }));
  assert.ok(exists(a.path) && exists(b.path));
  assert.match(keptReason(r, a), /skip-worktree.*README\.md/);
  assert.match(keptReason(r, b), /\.gitignore/);
});

test('E1: untracked file under a TRACKED build-named dir → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, 'build', 'ci.sh'), 'echo ci');
  g(a.path, 'add', 'build/ci.sh');
  g(a.path, 'commit', '-q', '-m', 'ci');
  a.head = g(a.path, 'rev-parse', 'HEAD');
  write(path.join(a.path, 'build', 'new.sh'), 'echo new');
  const r = await run(w, deps({ prs: { 'feat-a': merged(a) } }));
  assert.ok(exists(path.join(a.path, 'build', 'new.sh')));
  assert.match(keptReason(r, a), /build\/new\.sh/);
});

test('E1: a linked worktree that is a top-level folder of the workspace → kept (notable), no E2 either', async () => {
  const w = world();
  const side = path.join(w.parent, 'repo-side');
  g(w.main, 'worktree', 'add', '-q', '-b', 'side', side);
  write(path.join(side, 'Cargo.toml'), '[package]');
  write(path.join(side, 'target', 'x'));
  const head = g(side, 'rev-parse', 'HEAD');
  const r = await run(w, deps({ prs: { side: [{ number: 1, state: 'MERGED', headRefOid: head, headRefName: 'side' }] } }));
  assert.ok(exists(path.join(side, 'target', 'x')));
  const k = r.kept.find((x) => x.path === side);
  assert.match(k.reason, /cấp cao nhất/);
  assert.equal(k.notable, true);
});

test('E1: HEAD re-read differs from `worktree list` → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  const d = deps({ prs: { 'feat-a': merged(a) } });
  const exec0 = d.exec;
  d.exec = async (cmd, args, o) => (cmd === 'git' && args.includes('rev-parse') ? 'f'.repeat(40) + '\n' : exec0(cmd, args, o));
  const r = await run(w, d);
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /HEAD vừa đổi/);
});

test('E1: a process enters between the checks and the removal → kept', async () => {
  const w = world();
  const a = w.add('feat-a');
  const d = deps({ prs: { 'feat-a': merged(a) } });
  let n = 0;
  d.procCwds = () => (++n >= 2 ? [{ pid: 99, cwd: fs.realpathSync(a.path) }] : []);
  const r = await run(w, d);
  assert.ok(exists(a.path));
  assert.match(keptReason(r, a), /vừa vào/);
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

test('E2: a target/ with TRACKED content is not a build dir → kept', async () => {
  const w = world();
  const b = w.add('feat-b');
  write(path.join(b.path, 'crate', 'Cargo.toml'), '[package]');
  write(path.join(b.path, 'crate', 'target', 'README.md'), 'docs');
  g(b.path, 'add', '-f', 'crate');
  g(b.path, 'commit', '-q', '-m', 'tracked target');
  write(path.join(b.path, 'crate', 'target', 'debug', 'x'));
  const r = await run(w, deps());
  assert.ok(exists(path.join(b.path, 'crate', 'target', 'README.md')));
  assert.equal(r.targets.length, 0);
});

test('E2: a worktree outside the workspace → its target/ is not touched', async () => {
  const w = world();
  const outside = path.join(tmp('tp-out-'), 'wt');
  g(w.main, 'worktree', 'add', '-q', '-b', 'far', outside);
  write(path.join(outside, 'Cargo.toml'), '[package]');
  write(path.join(outside, 'target', 'x'));
  const r = await run(w, deps());
  assert.ok(exists(path.join(outside, 'target', 'x')));
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

test('decideScheduledRun: dry until a dry-run report was delivered; <24h → no; ≥24h → run', () => {
  const now = 1e12;
  const rep = { dryRunReportedAt: now - 2 * DAY };
  assert.deepEqual(decideScheduledRun(null, now), { run: true, dryRun: true });
  assert.deepEqual(decideScheduledRun({ lastCleanupAt: now - 3600_000, ...rep }, now), { run: false });
  assert.deepEqual(decideScheduledRun({ lastCleanupAt: now - DAY }, now), { run: true, dryRun: true });
  assert.deepEqual(decideScheduledRun({ lastCleanupAt: now - DAY, ...rep }, now), { run: true, dryRun: false });
  assert.deepEqual(decideScheduledRun({ lastCleanupAt: now + 5 * DAY, ...rep }, now), { run: true, dryRun: false });
  assert.deepEqual(decideScheduledRun({ lastCleanupAt: null, ...rep }, now), { run: true, dryRun: false });
});

test('readCleanupState: valid JSON with non-numeric fields → nulls (→ dry run); array/garbled → null', () => {
  const f = path.join(tmp(), 's.json');
  fs.writeFileSync(f, JSON.stringify({ lastCleanupAt: 'yesterday', dryRunReportedAt: '1' }));
  assert.deepEqual(readCleanupState(f), { lastCleanupAt: null, dryRunReportedAt: null });
  assert.deepEqual(decideScheduledRun(readCleanupState(f), 1e12), { run: true, dryRun: true });
  fs.writeFileSync(f, '[1]');
  assert.equal(readCleanupState(f), null);
  fs.writeFileSync(f, '{nope');
  assert.equal(readCleanupState(f), null);
});

test('cleanupTick: stays dry until dryRunReportedAt is recorded; waits 24h; keeps the record; garbled → dry', () => {
  const d = tmp();
  const stateFile = path.join(d, 'cleanup-state.json');
  const launches = [];
  const launch = (o) => launches.push(o);
  cleanupTick({ stateFile, launch, now: 1000 });
  assert.deepEqual(launches, [{ dryRun: true }]);
  assert.equal(readCleanupState(stateFile).lastCleanupAt, 1000);
  cleanupTick({ stateFile, launch, now: 1000 + DAY - 1 });
  assert.equal(launches.length, 1);
  // the first dry run crashed / was never delivered → the next one is dry again
  cleanupTick({ stateFile, launch, now: 1000 + DAY });
  assert.deepEqual(launches[1], { dryRun: true });
  recordDryRunReported(stateFile, 2000 + DAY);
  assert.equal(readCleanupState(stateFile).lastCleanupAt, 1000 + DAY); // merge, not overwrite
  cleanupTick({ stateFile, launch, now: 1000 + 2 * DAY });
  assert.deepEqual(launches[2], { dryRun: false });
  assert.equal(readCleanupState(stateFile).dryRunReportedAt, 2000 + DAY); // tick keeps the record
  fs.writeFileSync(stateFile, '{garbled');
  cleanupTick({ stateFile, launch, now: 9 * DAY });
  assert.deepEqual(launches[3], { dryRun: true });
  assert.deepEqual(fs.readdirSync(d), ['cleanup-state.json']);
});

test('cli: dry-run report delivered → dryRunReportedAt recorded; undelivered / failed run / no --report-to-owner / real run → not', async () => {
  const d = tmp();
  const lockDir = path.join(d, 'locks');
  const stateFile = path.join(d, 'state.json');
  const ok = async () => ({ dryRun: true, removed: [], kept: [], targets: [], cache: [], cacheSkipped: null, errors: [] });
  const sent = [];
  const send = (t, toOwner) => sent.push([t, toOwner]);
  const quiet = console.log; console.log = () => {};
  const err = console.error; console.error = () => {};
  try {
    assert.equal(await cli(['--dry-run', '--report-to-owner'], { run: ok, send: () => { throw new Error('403'); }, stateFile, lockDir }), 1);
    assert.equal(readCleanupState(stateFile), null);
    assert.equal(await cli(['--dry-run', '--report-to-owner'], { run: async () => { throw new Error('boom'); }, send, stateFile, lockDir }), 0);
    assert.equal(readCleanupState(stateFile), null);
    assert.match(sent.at(-1)[0], /lỗi/);
    assert.equal(await cli(['--dry-run'], { run: ok, send, stateFile, lockDir }), 0);
    assert.equal(readCleanupState(stateFile), null);
    assert.equal(await cli(['--report-to-owner'], { run: ok, send, stateFile, lockDir }), 0);
    assert.equal(readCleanupState(stateFile), null);
    assert.equal(await cli(['--dry-run', '--report-to-owner'], { run: ok, send, stateFile, lockDir, now: () => 777 }), 0);
    assert.equal(readCleanupState(stateFile).dryRunReportedAt, 777);
    // a busy cleanup lock: no run, nothing recorded
    const held = await acquireLock('cleanup', { dir: lockDir, waitSec: 0 });
    let ran = false;
    assert.equal(await cli(['--report-to-owner'], { run: async () => { ran = true; return ok(); }, send, stateFile, lockDir }), 0);
    held.release();
    assert.equal(ran, false);
    assert.match(sent.at(-1)[0], /đang có một lượt khác/);
  } finally { console.log = quiet; console.error = err; }
});

test('parseLaunchArgs: [] / --dry-run only; anything else (incl. em-dash) → error', () => {
  assert.deepEqual(parseLaunchArgs([]), { dryRun: false });
  assert.deepEqual(parseLaunchArgs(['--dry-run']), { dryRun: true });
  assert.throws(() => parseLaunchArgs(['—dry-run']), /không hiểu/);
  assert.throws(() => parseLaunchArgs(['--force']), /không hiểu/);
  assert.throws(() => parseLaunchArgs(['--dry-run', 'x']), /không hiểu/);
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
