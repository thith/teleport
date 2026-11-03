// RFC 30 — manual cleanup: probe, backup, restore, the hard blocks, the button flow and the `/cleanup` list.
// Everything runs on temp git repos / worktrees these tests create; nothing destructive is real, no Telegram, no daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLock } from './machine-lock.mjs';
import { probeManual, manualRemove, writeBackup, verifyBackup, readTgz, buildRestoreScript, manualCommand, listKept, findNestedRepo } from './cleanup-manual.mjs';
import {
  handleCleanupButton, startCleanupList, startManualFor, parseCleanupCommand, formatManualTable, renderCleanupList, manualDigest, manualEntryMatchesMessage,
  baseOf, manualInFlight, CLEANUP_BUTTON_RE, childManual,
} from './cleanup-inbox.mjs';
import { pruneBackups, runCleanup, formatReport, BUILD_DIRS } from './cleanup.mjs';
import { takeMergeButton } from './daemon.mjs';
import { defaultDeps } from './cleanup.mjs';

const execFileP = promisify(execFile);
const tmp = (p = 'tp-man-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (f, s = 'x', mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); if (mode) fs.chmodSync(f, mode); };

function world({ name = 'repo' } = {}) {
  const parent = tmp();
  const main = path.join(parent, name);
  fs.mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main');
  write(path.join(main, '.gitignore'), '.env\ntarget/\nnode_modules/\nbuild/\n');
  write(path.join(main, 'README.md'), 'hi');
  write(path.join(main, 'a.txt'), 'a');
  write(path.join(main, 'b.txt'), 'b');
  g(main, 'add', '.');
  g(main, 'commit', '-q', '-m', 'init');
  g(main, 'remote', 'add', 'origin', 'git@github.com:acme/repo.git');
  const backups = path.join(parent, '.backups');
  const lockDir = path.join(parent, '.locks');
  const add = (topic, base = {}) => {
    const p = path.join(parent, `${name}-${topic}`);
    g(main, 'worktree', 'add', '-q', '-b', topic, p);
    g(p, 'commit', '-q', '--allow-empty', '-m', `work on ${topic}`);
    return { path: p, branch: topic, head: g(p, 'rev-parse', 'HEAD') };
  };
  return { parent, main, backups, lockDir, add };
}
function deps({ prs = {}, procs = [], comm = () => 'node' } = {}) {
  return {
    exec: async (cmd, args, opts) => {
      if (cmd === 'gh') return JSON.stringify(prs[args[args.indexOf('--head') + 1]] || []);
      return (await execFileP(cmd, args, opts)).stdout;
    },
    procCwds: () => procs, procComm: comm, transcriptCwds: () => new Set(), log: () => {},
  };
}
const probe = (w, p, extra = {}) => probeManual(p, { parentDir: w.parent, deps: deps(), ...extra });
const readAll = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !(e.parentPath ?? e.path).includes('.git')).map((e) => { const f = path.join(e.parentPath ?? e.path, e.name); return [path.relative(dir, f), fs.readFileSync(f, 'utf8')]; }));

// ── the probe / table ───────────────────────────────────────────────────────

test('probe: lists tracked changes (staged apart), untracked, small ignored, skipped build dirs, unpushed commits; fingerprint is stable', async () => {
  const w = world();
  const a = w.add('feat-auth');
  write(path.join(a.path, 'a.txt'), 'a2'); g(a.path, 'add', 'a.txt');           // staged
  write(path.join(a.path, 'b.txt'), 'b2');                                       // unstaged
  write(path.join(a.path, 'src', 'new.rs'), 'fn main(){}');                      // untracked
  write(path.join(a.path, '.env'), 'K=v');                                       // ignored, small → backed up
  write(path.join(a.path, 'target', 'debug', 'x'), 'bin');                       // ignored build dir → skipped
  write(path.join(a.path, 'evil\nname.txt'), 'x');                               // control char in a name
  const p = await probe(w, a.path);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.branch, 'feat-auth');
  assert.equal(p.tracked.count, 2);
  assert.equal(p.tracked.staged, 1);
  assert.deepEqual(p.entries.map((e) => e.name).sort(), ['.env', 'evil\nname.txt', 'src/new.rs']);
  assert.deepEqual(p.skipped.map((s) => s.name), ['target/']);
  assert.equal(p.aheadCommits, 2, 'no upstream: the commits that exist on no remote (the base commit + the worktree commit)');
  assert.equal(p.upstream, null);
  assert.match(p.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await probe(w, a.path)).fingerprint, p.fingerprint, 'a read-only probe changes nothing');
  const entry = { mode: 'manual', stage: 'confirm', path: p.path, commonDir: p.commonDir, branch: p.branch, head: p.head, fingerprint: p.fingerprint, convoId: '5', createdAt: 1 };
  const t = formatManualTable(p, entry);
  assert.match(t, /^🗑 Xoá tay .*repo-feat-auth \(nhánh feat-auth — nhánh GIỮ NGUYÊN\)\n/);
  assert.match(t, /• PR: không xác định|• PR: không có/);
  assert.match(t, /nhánh chưa push \(2 commit chỉ có ở máy này — vẫn nằm trong nhánh\)/);
  assert.match(t, /• 2 file đã track bị sửa \(1 đã stage\): a\.txt, b\.txt/);
  assert.match(t, /• 3 mục ngoài git: .*evil\\nname\.txt/);
  assert.doesNotMatch(t, /evil\nname/);
  assert.match(t, /• bỏ qua không sao lưu: target\/ .*file build bị ignore/);
  assert.match(t, new RegExp(`💾 Trước khi xoá sẽ sao lưu .* \\(giữ 7 ngày\\)\\.  🔑 ${manualDigest(entry)}$`));
  assert.ok(t.length < 3500);
  // a file edited afterwards → another fingerprint
  write(path.join(a.path, 'src', 'new.rs'), 'fn main(){ 1 }');
  assert.notEqual((await probe(w, a.path)).fingerprint, p.fingerprint);
  fs.writeFileSync(path.join(a.path, 'src', 'new.rs'), 'fn main(){}');
  write(path.join(a.path, 'b.txt'), 'b3'); // a tracked file edited again (same `status`)
  assert.notEqual((await probe(w, a.path)).fingerprint, p.fingerprint);
});

test('probe: a clean tree says "không mất gì"; more than 5 entries show the rest as a count', async () => {
  const w = world();
  const a = w.add('feat-a');
  const clean = await probe(w, a.path);
  assert.match(formatManualTable(clean, { mode: 'manual', stage: 'confirm', path: clean.path, branch: 'feat-a', createdAt: 1 }), /• không mất gì/);
  for (let i = 0; i < 8; i++) write(path.join(a.path, `n${i}.txt`));
  const p = await probe(w, a.path);
  const t = formatManualTable(p, { mode: 'manual', stage: 'confirm', path: p.path, branch: 'feat-a', createdAt: 1 });
  assert.match(t, /• 8 mục ngoài git: n0\.txt, n1\.txt, n2\.txt, n3\.txt, n4\.txt, … \(\+3\)/);
});

test('probe: over 2 GiB / over 20 000 files → no ✅ (limit); the probe stops early', async () => {
  const w = world();
  const a = w.add('feat-a');
  write(path.join(a.path, 'big.bin'), 'x'.repeat(5000));
  const big = await probe(w, a.path, { maxBytes: 4000 });
  assert.equal(big.ok, false);
  assert.equal(big.limit, true);
  assert.match(big.reason, /quá lớn .* xử lý tay/);
  for (let i = 0; i < 12; i++) write(path.join(a.path, 'many', `f${i}`));
  const many = await probe(w, a.path, { maxFiles: 10 });
  assert.equal(many.limit, true);
  assert.match(many.reason, /quá lớn/);
});

// ── the hard blocks (§2.4) — each one alone, and together ────────────────────

const blocked = async (w, p, re, extra) => { const r = await probe(w, p, extra); assert.equal(r.ok, false, `should be blocked: ${re}`); assert.equal(r.hard, true); assert.match(r.reason, re); return r; };

test('hard blocks: detached HEAD · git worktree lock', async () => {
  const w = world();
  const d = path.join(w.parent, 'repo-det');
  g(w.main, 'worktree', 'add', '-q', '--detach', d);
  await blocked(w, d, /detached HEAD/);
  const a = w.add('feat-lock');
  g(w.main, 'worktree', 'lock', a.path);
  await blocked(w, a.path, /bị khoá/);
});

test('hard blocks: a process inside (pid + comm, no persona) · conflict · mid-merge · skip-worktree', async () => {
  const w = world();
  const a = w.add('feat-p');
  const r = await blocked(w, a.path, /pid 4242 \(sleep\).*tắt tiến trình rồi gửi lại/, { deps: deps({ procs: [{ pid: 4242, cwd: path.join(a.path, 'sub') }], comm: () => 'sleep' }) });
  assert.equal(r.blocks.length, 1, 'only this block');
  const c = w.add('feat-c');
  g(w.main, 'checkout', '-q', '-b', 'other'); write(path.join(w.main, 'a.txt'), 'main side'); g(w.main, 'commit', '-qam', 'm');
  write(path.join(c.path, 'a.txt'), 'wt side'); g(c.path, 'commit', '-qam', 'w');
  try { g(c.path, 'merge', 'other'); } catch { /* conflict expected */ }
  await blocked(w, c.path, /xung đột|merge/);
  const s = w.add('feat-s');
  g(s.path, 'update-index', '--skip-worktree', 'b.txt');
  await blocked(w, s.path, /skip-worktree/);
});

test('hard blocks: submodule/gitlink · nested repo (also inside target/ and as a .git FILE) · walk too big → its own reason', async () => {
  const w = world();
  const sub = w.add('feat-sub');
  g(sub.path, 'update-index', '--add', '--cacheinfo', `160000,${sub.head},vendor/lib`);
  await blocked(w, sub.path, /submodule|gitlink/);
  const n = w.add('feat-n');
  fs.mkdirSync(path.join(n.path, 'target', 'deep', 'clone'), { recursive: true });
  g(path.join(n.path, 'target', 'deep', 'clone'), 'init', '-q');
  await blocked(w, n.path, /repo git lồng bên trong \(target\/deep\/clone\)/);
  const f = w.add('feat-f');
  write(path.join(f.path, 'vendor', 'x', '.git'), 'gitdir: /elsewhere');
  await blocked(w, f.path, /repo git lồng bên trong \(vendor\/x\)/);
  const t = w.add('feat-t');
  for (let i = 0; i < 30; i++) write(path.join(t.path, 'target', `f${i}`));
  const r = await blocked(w, t.path, /không kiểm hết target\/ \(quá 20 mục\) — dọn file build \(vd cargo clean\) rồi thử lại/, { maxEntries: 20 });
  assert.doesNotMatch(r.reason, /repo git/, 'not mistaken for "has a repo"');
  assert.deepEqual(findNestedRepo(t.path, { maxEntries: 1000 }), {});
});

test('hard blocks: a clean/process filter on a changed tracked file (LFS-like) · repo outside the managed set · the main checkout', async () => {
  const w = world();
  const a = w.add('feat-lfs');
  write(path.join(a.path, '.gitattributes'), 'big.dat filter=lfs\n');
  write(path.join(a.path, 'big.dat'), 'v1');
  g(a.path, 'add', '-f', '.gitattributes', 'big.dat'); g(a.path, 'commit', '-qm', 'attrs');
  g(a.path, 'config', 'filter.lfs.clean', 'cat'); // a clean filter is configured
  write(path.join(a.path, 'big.dat'), 'v2');
  await blocked(w, a.path, /filter "lfs"/);
  await blocked(w, w.main, /checkout chính/);
  const other = world({ name: 'other' }); // a repo in a different workspace (not under w.parent)
  const o = other.add('x');
  await blocked(w, o.path, /ngoài workspace|không thuộc tập repo/);
  // a repo inside the workspace but nested one level down is not "managed" either
  const deep = path.join(w.parent, 'group', 'deeprepo');
  fs.mkdirSync(deep, { recursive: true }); g(deep, 'init', '-q', '-b', 'main'); write(path.join(deep, 'f'), 'f'); g(deep, 'add', '.'); g(deep, 'commit', '-qm', 'i');
  const dw = path.join(w.parent, 'group', 'deeprepo-wt'); g(deep, 'worktree', 'add', '-q', '-b', 'zz', dw);
  await blocked(w, dw, /không thuộc tập repo/);
});

test('hard blocks are checked independently: several at once are all reported', async () => {
  const w = world();
  const a = w.add('feat-multi');
  g(a.path, 'update-index', '--skip-worktree', 'b.txt');
  g(w.main, 'worktree', 'lock', a.path);
  const r = await blocked(w, a.path, /bị khoá/, { deps: deps({ procs: [{ pid: 7, cwd: a.path }] }) });
  assert.match(r.reason, /skip-worktree/);
  assert.match(r.reason, /pid 7/);
  assert.equal(r.blocks.length, 3);
});

// ── backup → remove → restore, end to end ───────────────────────────────────

async function dirty(w, name = 'feat-e2e') {
  const a = w.add(name);
  write(path.join(a.path, 'a.txt'), 'staged-version'); g(a.path, 'add', 'a.txt');
  write(path.join(a.path, 'a.txt'), 'staged-version\nplus unstaged');     // staged ≠ unstaged on the same file
  write(path.join(a.path, 'b.txt'), 'b changed');
  write(path.join(a.path, 'dist', 'gen.sh'), '#!/bin/sh\necho hi\n', 0o755);    // untracked (not ignored) inside a dir NAMED like a build dir
  write(path.join(a.path, 'tmp', 'notes.md'), 'scratch');
  write(path.join(a.path, '.env'), 'SECRET=1');
  write(path.join(a.path, '-dash.txt'), 'starts with a dash');
  write(path.join(a.path, 'new\nline.txt'), 'newline in the name');
  write(path.join(a.path, 'run.sh'), '#!/bin/sh\n', 0o755);
  write(path.join(a.path, 'deep', 'x'.repeat(120), 'y'.repeat(120), 'long-path.txt'), 'long'); // > 100 chars: a pax header
  fs.symlinkSync('/etc/hostname', path.join(a.path, 'link-out'));
  write(path.join(a.path, 'intent.txt'), 'intent to add'); g(a.path, 'add', '-N', 'intent.txt');
  write(path.join(a.path, 'target', 'debug', 'junk'), 'junk');
  return a;
}
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || (d === dir && e.name === 'target')) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else { const s = fs.lstatSync(f); out[path.relative(dir, f)] = s.isSymbolicLink() ? `->${fs.readlinkSync(f)}` : `${fs.readFileSync(f, 'utf8')}|${(s.mode & 0o777).toString(8)}`; }
  } };
  walk(dir);
  return out;
};

test('end to end: remove backs up everything, keeps the branch, restore.sh brings back contents, modes, staged vs unstaged, add -N', async () => {
  const w = world();
  const a = await dirty(w);
  const before = snapshot(a.path);
  const idxBefore = g(a.path, 'diff', '--cached', '--stat');
  const p = await probe(w, a.path);
  assert.equal(p.ok, true, p.reason);
  assert.ok(p.entries.some((e) => e.name === 'dist/gen.sh'), 'an untracked file inside dist/ is backed up (only IGNORED build paths are skipped)');
  const res = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups });
  assert.equal(res.ok, true, res.reason);
  assert.equal(fs.existsSync(a.path), false, 'worktree gone');
  assert.match(g(w.main, 'branch', '--list', 'feat-e2e'), /feat-e2e/, 'branch kept');
  assert.equal(g(w.main, 'rev-parse', 'feat-e2e'), a.head);
  assert.equal(path.dirname(res.backupDir), w.backups);
  assert.equal(fs.statSync(res.backupDir).mode & 0o777, 0o700);
  const names = fs.readdirSync(res.backupDir).sort();
  assert.deepEqual(names, ['info.json', 'restore.sh', 'staged.patch', 'unstaged.patch', 'untracked.tgz']);
  const info = JSON.parse(fs.readFileSync(path.join(res.backupDir, 'info.json'), 'utf8'));
  assert.equal(info.complete, true);
  assert.equal(info.v, 1);
  assert.ok(info.files.every((f) => !f.path.startsWith('target/')), 'ignored build output is not backed up');
  assert.ok(info.files.some((f) => f.path === 'link-out' && f.type === 'symlink'));
  assert.ok(!info.files.some((f) => f.path === 'intent.txt'), 'add -N goes into the patch, not the tar');
  // restore
  await execFileP('bash', [path.join(res.backupDir, 'restore.sh')]);
  const after = snapshot(a.path);
  assert.deepEqual(after, before, 'every file, content and mode (incl. +x, symlink, dash/newline names, long path) is back');
  assert.equal(g(a.path, 'diff', '--cached', '--stat'), idxBefore, 'the staged part is staged again');
  assert.equal(g(a.path, 'rev-parse', 'HEAD'), a.head);
  assert.equal(g(a.path, 'branch', '--show-current'), 'feat-e2e');
  assert.match(g(a.path, 'status', '--porcelain'), /^MM a\.txt$/m, 'staged and unstaged edits of one file come back as two layers');
  assert.equal(fs.readFileSync(path.join(a.path, 'intent.txt'), 'utf8'), 'intent to add', 'the add -N file comes back with its content (as a plain new file)');
});

test('restore.sh when the branch moved on: a detached worktree at the OLD commit with all the changes; refuses nothing silently', async () => {
  const w = world();
  const a = await dirty(w, 'feat-moved');
  const p = await probe(w, a.path);
  const res = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups });
  assert.equal(res.ok, true, res.reason);
  g(w.main, 'update-ref', 'refs/heads/feat-moved', g(w.main, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'moved on'));
  const { stdout } = await execFileP('bash', [path.join(res.backupDir, 'restore.sh')]);
  assert.match(stdout, /nhánh feat-moved đã đổi — đang ở đúng commit cũ \(detached\)/);
  assert.equal(g(a.path, 'rev-parse', 'HEAD'), a.head);
  assert.equal(g(a.path, 'branch', '--show-current'), '');
  assert.equal(fs.readFileSync(path.join(a.path, 'b.txt'), 'utf8'), 'b changed');
  assert.equal(fs.readFileSync(path.join(a.path, '-dash.txt'), 'utf8'), 'starts with a dash');
});

test('restore.sh: every argument is shell-quoted (a path with a quote and spaces)', () => {
  const s = buildRestoreScript({ main: "/p/it's here", wtPath: "/p/wt $(x)", branch: 'b;rm -rf', head: 'a'.repeat(40), hasStaged: true, hasUnstaged: false, hasTar: true });
  assert.match(s, /MAIN='\/p\/it'\\''s here'/);
  assert.match(s, /BR='b;rm -rf'/);
  assert.match(s, /worktree add '\/p\/wt \$\(x\)' "\$BR"/);
  assert.match(s, /apply --index "\$D\/staged\.patch" \|\| fail/);
  assert.doesNotMatch(s, /unstaged\.patch/);
});

test('a different fingerprint → nothing removed, a fresh table comes back; a late change (during the backup) → backup dir deleted, nothing removed', async () => {
  const w = world();
  const a = w.add('feat-fp');
  write(path.join(a.path, 'notes.txt'), 'v1');
  const p = await probe(w, a.path);
  write(path.join(a.path, 'later.txt'), 'new');
  const r1 = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups });
  assert.equal(r1.ok, false);
  assert.equal(r1.changed, true);
  assert.match(r1.note, /đã thay đổi — xem lại/);
  assert.equal(r1.probe.ok, true);
  assert.notEqual(r1.probe.fingerprint, p.fingerprint);
  assert.ok(fs.existsSync(a.path));
  assert.equal(fs.existsSync(w.backups), false, 'no backup was started');
  const r2 = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: r1.probe.fingerprint, backupDir: w.backups,
    hooks: { afterBackup: () => write(path.join(a.path, 'notes.txt'), 'v2 — written during the backup') } });
  assert.equal(r2.changed, true);
  assert.match(r2.note, /trong lúc sao lưu/);
  assert.ok(fs.existsSync(a.path));
  assert.deepEqual(fs.readdirSync(w.backups), [], 'the half-made backup is gone');
  // a process walking in during the backup is caught by the late probe too
  const procs = [];
  const r3 = await manualRemove(a.path, { parentDir: w.parent, deps: { ...deps(), procCwds: () => procs }, expectFingerprint: r2.probe.fingerprint, backupDir: w.backups,
    hooks: { afterBackup: () => procs.push({ pid: 99, cwd: a.path }) } });
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /pid 99/);
  assert.ok(fs.existsSync(a.path));
  assert.deepEqual(fs.readdirSync(w.backups), []);
});

test('a backup that can not be written or verified → the worktree stays', async () => {
  const w = world();
  const a = w.add('feat-bad');
  write(path.join(a.path, 'notes.txt'), 'v1');
  const p = await probe(w, a.path);
  const blockedRoot = path.join(w.parent, 'file-not-dir');
  fs.writeFileSync(blockedRoot, 'x');
  const r = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: path.join(blockedRoot, 'sub') });
  assert.equal(r.ok, false);
  assert.equal(r.backupFailed, true);
  assert.match(r.reason, /sao lưu lỗi, chưa xoá gì/);
  assert.ok(fs.existsSync(a.path));
  // tamper with the tar after it is written → verify throws
  const pr = await probe(w, a.path);
  const dir = await writeBackup(pr, { root: w.backups });
  await verifyBackup(dir, pr, deps());
  const tgz = path.join(dir, 'untracked.tgz');
  const raw = zlib.gunzipSync(fs.readFileSync(tgz));
  const i = raw.indexOf('v1');
  raw[i] = 'X'.charCodeAt(0);
  fs.writeFileSync(tgz, zlib.gzipSync(raw));
  await assert.rejects(verifyBackup(dir, pr, deps()), /tar không khớp/);
  // a missing patch that must exist
  const dir2 = await writeBackup(pr, { root: w.backups });
  write(path.join(a.path, 'README.md'), 'edited');
  const pr2 = await probe(w, a.path);
  await assert.rejects(verifyBackup(dir2, pr2, deps()), /unstaged\.patch thiếu/);
});

test('repo with diff.noprefix + a textconv driver that WOULD run: the patch is raw, still valid, restores, and the converter never runs', async () => {
  const w = world();
  const a = w.add('feat-cfg');
  const marker = path.join(w.parent, 'textconv-ran');
  const conv = path.join(w.parent, 'conv.sh');
  fs.writeFileSync(conv, `#!/bin/sh\necho ran >> '${marker}'\ncat "$1" | tr a-z A-Z\n`, { mode: 0o755 });
  g(w.main, 'config', 'diff.noprefix', 'true');
  g(w.main, 'config', 'diff.mnemonicPrefix', 'true');
  g(w.main, 'config', 'diff.hex.textconv', conv);
  write(path.join(a.path, '.gitattributes'), '*.dat diff=hex\n');
  write(path.join(a.path, 'x.dat'), 'v1\n');
  g(a.path, 'add', '.gitattributes', 'x.dat'); g(a.path, 'commit', '-qm', 'dat');
  write(path.join(a.path, 'x.dat'), 'v2 lower\n');                       // a changed file the driver matches
  write(path.join(a.path, 'a.txt'), 'changed under noprefix');
  fs.writeFileSync(path.join(a.path, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]));
  g(a.path, 'add', 'blob.bin');
  // proof the converter would have run for a plain `git diff`
  g(a.path, 'diff', 'x.dat');
  assert.ok(fs.existsSync(marker), 'a plain git diff runs the textconv driver');
  fs.rmSync(marker);
  const p = await probe(w, a.path);
  assert.equal(p.ok, true, p.reason);
  const res = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups });
  assert.equal(res.ok, true, res.reason);
  assert.equal(fs.existsSync(marker), false, 'neither the probe, the backup, the verification nor the late probe ran the converter');
  const patch = fs.readFileSync(path.join(res.backupDir, 'unstaged.patch'), 'utf8');
  assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt/m);
  assert.match(patch, /\+v2 lower/, 'raw content, not the converter output (upper case)');
  await execFileP('bash', [path.join(res.backupDir, 'restore.sh')]);
  assert.equal(fs.readFileSync(path.join(a.path, 'a.txt'), 'utf8'), 'changed under noprefix');
  assert.equal(fs.readFileSync(path.join(a.path, 'x.dat'), 'utf8'), 'v2 lower\n');
  assert.deepEqual([...fs.readFileSync(path.join(a.path, 'blob.bin'))], [0, 1, 2, 3, 255], 'binary content restored byte for byte');
});

test('a tracked file added with -f inside an ignored build/ dir is in the patch; ignored neighbours in build/ are build output (skipped)', async () => {
  const w = world();
  const a = w.add('feat-bf');
  write(path.join(a.path, 'build', 'tracked.txt'), 't1'); g(a.path, 'add', '-f', 'build/tracked.txt'); g(a.path, 'commit', '-qm', 'add -f');
  write(path.join(a.path, 'build', 'tracked.txt'), 't2');
  write(path.join(a.path, 'build', 'out.o'), 'obj');
  write(path.join(a.path, '.env'), 'K=v');
  const p = await probe(w, a.path);
  assert.deepEqual(p.entries.map((e) => e.name), ['.env']);
  assert.ok(p.skipped.some((s) => s.name === 'build/out.o'));
  assert.equal(p.tracked.count, 1);
  const res = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups });
  assert.equal(res.ok, true, res.reason);
  assert.match(fs.readFileSync(path.join(res.backupDir, 'unstaged.patch'), 'utf8'), /build\/tracked\.txt/);
});

test('readTgz: pax long names, symlinks and exact hashes (not parsing `tar t`)', async () => {
  const dir = tmp();
  const long = path.join('d'.repeat(110), 'e'.repeat(110), 'f.txt');
  write(path.join(dir, long), 'L');
  write(path.join(dir, 'x\ny'), 'N', 0o700);
  fs.symlinkSync('../out', path.join(dir, 'sl'));
  const names = [long, 'x\ny', 'sl'];
  await new Promise((res, rej) => {
    const c = spawn('tar', ['--null', '--verbatim-files-from', '--no-recursion', '--force-local', '--format=posix', '-C', dir, '-T', '-', '-czf', path.join(dir, 'o.tgz')], { stdio: ['pipe', 'ignore', 'inherit'] });
    c.on('close', (code) => (code === 0 ? res() : rej(new Error('tar'))));
    c.stdin.end(`${names.join('\0')}\0`);
  });
  const got = Object.fromEntries((await readTgz(path.join(dir, 'o.tgz'))).map((e) => [e.path, e]));
  assert.equal(got[long].type, 'file');
  assert.equal(got[long].size, 1);
  assert.equal(got['x\ny'].mode, 0o700);
  assert.equal(got.sl.type, 'symlink');
  assert.equal(got.sl.size, '../out'.length);
});

// ── the button flow ─────────────────────────────────────────────────────────

function harness(w) {
  const store = new Map(), sent = [], edits = [], answers = [], dms = [], delivered = [], audits = [];
  const ctx = {
    daemonUserId: '1', buttonStore: store, secretEnvKeys: [],
    sendText: async (c, t) => { dms.push(t); },
    sendButtons: async (c, t, b) => { sent.push({ t, rows: [b] }); return { message_id: 50 + sent.length }; },
    sendButtonRows: async (c, t, rows) => { sent.push({ t, rows }); return { message_id: 50 + sent.length }; },
    answerButton: async (id, t) => { answers.push(t); },
    editButtonsMessage: async (c, m, t) => { edits.push({ t, rows: [] }); },
    editButtonRowsStrict: async (c, m, t, rows) => { edits.push({ t, rows }); },
  };
  const o = {
    parentDir: w.parent, deps: deps(), lockDir: w.lockDir, waitSec: 0, backupDir: w.backups,
    deliver: async (r, opt) => { delivered.push(opt.build(r)); }, audit: (e) => audits.push(e),
  };
  return { store, sent, edits, answers, dms, delivered, audits, ctx, o };
}
const press = (data, text, extra = {}) => ({ id: 'q', data, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 9, text, ...extra } });
const cmEntry = (a, over = {}) => ({ kind: 'cleanup', mode: 'manual', path: a.path, head: a.head, convoId: '5', who: 'Giun #5', createdAt: Date.now(), ...over });
function seedCm(h, a, tok = 'c'.repeat(16), over = {}) {
  const e = cmEntry(a, over);
  h.store.set(tok, e);
  return { tok, e, text: `🧹 cleanup-request của Giun #5: ❌ giữ lại ${a.path}: có thay đổi chưa commit\n🔑 ${manualDigest(e)}` };
}

test('button cm: lock busy → the message gets a NEW token and "⌛ đang bận — bấm lại"; the old press path stays closed; never a message without a button', async () => {
  const w = world();
  const a = w.add('feat-busy');
  const h = harness(w);
  const { tok, e, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, { ...h.o, acquire: async () => ({ timeout: true }) });
  const last = h.edits.at(-1);
  assert.match(last.t, /⌛ đang bận — bấm lại$/);
  assert.equal(last.rows.length, 1);
  const tok2 = last.rows[0][0].callback_data.slice(3);
  assert.notEqual(tok2, tok);
  assert.equal(h.store.has(tok), false);
  assert.deepEqual(h.store.get(tok2), e, 'same content under the new token');
  // the retried text still validates (the digest line is intact) and works once the lock is free
  await handleCleanupButton(press(`cm:${tok2}`, last.t), h.ctx, h.o);
  assert.match(h.edits.at(-1).t, /^🗑 Xoá tay /);
  assert.equal(manualInFlight.size, 0);
});

test('button cm: a failing child → "bấm lại" with a new token; an edit that fails keeps the OLD token', async () => {
  const w = world();
  const a = w.add('feat-ch');
  const h = harness(w);
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, { ...h.o, runManual: async () => ({ ok: false, childError: true, reason: 'lỗi tiến trình con' }) });
  assert.match(h.edits.at(-1).t, /bấm lại/);
  assert.equal(h.store.size, 1);
  const tok2 = [...h.store.keys()][0];
  assert.notEqual(tok2, tok);
  h.ctx.editButtonRowsStrict = async () => { throw new Error('network'); };
  await handleCleanupButton(press(`cm:${tok2}`, h.edits.at(-1).t), h.ctx, { ...h.o, runManual: async () => ({ ok: false, childError: true }) });
  assert.deepEqual([...h.store.keys()], [tok2], 'the edit failed: only the old token remains, nothing was lost');
});

test('button cy: a double tap is "đã xử lý"; a tapped-but-unfinished step re-offers ✅ ✖ with a new token', async () => {
  const w = world();
  const a = w.add('feat-dbl');
  write(path.join(a.path, 'n.txt'));
  const h = harness(w);
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  const table = h.edits.at(-1);
  const cy = table.rows[0][0].callback_data;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (cmd, t, opts) => { await gate; return manualCommand(cmd, t, { ...opts, deps: deps() }); };
  const first = handleCleanupButton(press(cy, table.t), h.ctx, { ...h.o, runManual: slow });
  await new Promise((r) => setTimeout(r, 20));
  await handleCleanupButton(press(cy, table.t), h.ctx, { ...h.o, runManual: slow });
  assert.match(h.answers.at(-1), /đã xử lý/);
  release();
  await first;
  assert.equal(fs.existsSync(a.path), false);
  assert.match(h.edits.at(-1).t, /^✅ đã xoá /);
  // lock busy on ✅ → the confirm buttons come back
  const b = w.add('feat-dbl2');
  write(path.join(b.path, 'n.txt'));
  const s2 = seedCm(h, b, 'd'.repeat(16));
  await handleCleanupButton(press(`cm:${s2.tok}`, s2.text), h.ctx, h.o);
  const t2 = h.edits.at(-1);
  await handleCleanupButton(press(t2.rows[0][0].callback_data, t2.t), h.ctx, { ...h.o, acquire: async () => ({ timeout: true }) });
  const again = h.edits.at(-1);
  assert.match(again.t, /⌛ đang bận — bấm lại$/);
  assert.deepEqual(again.rows[0].map((x) => x.text), ['✅ Xoá', '✖']);
  assert.ok(fs.existsSync(b.path));
});

test('button cy: the worktree changed since the table → NOTHING removed, a new table (new token) with the warning', async () => {
  const w = world();
  const a = w.add('feat-chg');
  write(path.join(a.path, 'n.txt'), 'one');
  const h = harness(w);
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  const t1 = h.edits.at(-1);
  write(path.join(a.path, 'n2.txt'), 'two');
  await handleCleanupButton(press(t1.rows[0][0].callback_data, t1.t), h.ctx, h.o);
  assert.ok(fs.existsSync(a.path));
  const t2 = h.edits.at(-1);
  assert.match(t2.t, /• 2 mục ngoài git: n\.txt, n2\.txt/);
  assert.match(t2.t, /⚠️ worktree đã thay đổi — xem lại$/);
  assert.deepEqual(t2.rows[0].map((x) => x.text), ['✅ Xoá', '✖']);
  assert.equal(h.store.size, 1, 'old token spent, new one stored');
  assert.equal(fs.existsSync(w.backups), false);
});

test('button cn: ✖ keeps it, tells the agent, audits manual-keep', async () => {
  const w = world();
  const a = w.add('feat-no');
  const h = harness(w);
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  const t1 = h.edits.at(-1);
  await handleCleanupButton(press(t1.rows[0][1].callback_data, t1.t), h.ctx, h.o);
  assert.match(h.edits.at(-1).t, /✋ giữ lại$/);
  assert.deepEqual(h.edits.at(-1).rows, []);
  assert.ok(fs.existsSync(a.path));
  assert.equal(h.audits.at(-1).mode, 'manual-keep');
  assert.match(h.delivered.at(-1).cleanupResult.text, /owner chọn giữ lại/);
  assert.equal(h.store.size, 0);
});

test('button: a hard block at press time → the message says why, no buttons; a store edited by hand (path / fingerprint / stage) → 🔑 mismatch, ignored', async () => {
  const w = world();
  const a = w.add('feat-hb');
  g(w.main, 'worktree', 'lock', a.path);
  const h = harness(w);
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  assert.match(h.edits.at(-1).t, /🚫 không xoá tay được: bị khoá/);
  assert.deepEqual(h.edits.at(-1).rows, []);
  g(w.main, 'worktree', 'unlock', a.path);
  // tampering
  const b = w.add('feat-tamper');
  const s = seedCm(h, b, 'e'.repeat(16));
  await handleCleanupButton(press(`cm:${s.tok}`, s.text), h.ctx, h.o);
  const t = h.edits.at(-1);
  const cyTok = t.rows[0][0].callback_data.slice(3);
  const good = h.store.get(cyTok);
  for (const bad of [{ path: a.path }, { fingerprint: 'f'.repeat(64) }, { stage: undefined }, { branch: 'other' }, { head: 'f'.repeat(40) }, { convoId: '99' }, { createdAt: Date.now() - 1000 }]) {
    h.store.set(cyTok, { ...good, ...bad });
    const before = h.edits.length;
    await handleCleanupButton(press(`cy:${cyTok}`, t.t), h.ctx, { ...h.o, runManual: async () => { throw new Error('must not run'); } });
    assert.match(h.answers.at(-1), /không khớp/, JSON.stringify(bad));
    assert.ok(fs.existsSync(b.path));
    assert.ok(h.edits.length >= before);
  }
  // cm only takes entries without a stage, cy only confirm entries
  h.store.set('1'.repeat(16), { ...good });
  await handleCleanupButton(press(`cm:${'1'.repeat(16)}`, t.t), h.ctx, h.o);
  assert.match(h.answers.at(-1), /Nút không khớp/);
});

test('buttons: CLEANUP_BUTTON_RE takes the RFC 30 callbacks and NOT the merge ones; kind cleanup is never taken by the merge handler', () => {
  for (const ok of ['cx', 'ck', 'cm', 'cy', 'cn', 'cr'].map((p) => `${p}:${'a'.repeat(16)}`).concat([`cw:${'a'.repeat(16)}:3`, `cp:${'a'.repeat(16)}:1`])) assert.match(ok, CLEANUP_BUTTON_RE);
  for (const no of [`cl:${'a'.repeat(16)}`, `mg:${'a'.repeat(16)}`, `mc:${'a'.repeat(16)}`, `cm:${'a'.repeat(15)}`, `cm:${'a'.repeat(16)}:x`]) assert.doesNotMatch(no, CLEANUP_BUTTON_RE);
  const store = new Map([['t', { kind: 'cleanup', mode: 'list', createdAt: Date.now() }]]);
  assert.equal(takeMergeButton('t', { store }), null);
  assert.ok(store.has('t'));
});

test('manualEntryMatchesMessage / baseOf: the digest must be on its own line (or the 💾 line), never inside a file-name bullet', () => {
  const e = { mode: 'manual', stage: 'confirm', path: '/p/wt', branch: 'b', createdAt: 1, fingerprint: 'f' };
  const d = manualDigest(e);
  const head = '🗑 Xoá tay /p/wt (nhánh b — nhánh GIỮ NGUYÊN)';
  assert.equal(manualEntryMatchesMessage(e, `${head}\n💾 sao lưu 1 B (giữ 7 ngày).  🔑 ${d}`), true);
  assert.equal(manualEntryMatchesMessage(e, `${head}\n• file  🔑 ${d}\n💾 x`), false);
  assert.equal(manualEntryMatchesMessage(e, `${head}\n• 🔑 ${d}`), false);
  assert.equal(manualEntryMatchesMessage({ ...e, path: '/p/other' }, `${head}\n🔑 ${d}`), false);
  assert.equal(baseOf(`${head}\n💾 y  🔑 ${d}\n\n⌛ đang bận — bấm lại`), `${head}\n💾 y  🔑 ${d}`);
});

// ── backups: retention (§2.5) ───────────────────────────────────────────────

test('pruneBackups: only complete, old, real child directories go; odd ones are reported and kept; --dry-run removes nothing', () => {
  const root = tmp('tp-bk-');
  const now = 100 * 24 * 3600_000;
  const mk = (name, info) => { const d = path.join(root, name); fs.mkdirSync(d); if (info) fs.writeFileSync(path.join(d, 'info.json'), typeof info === 'string' ? info : JSON.stringify(info)); return d; };
  mk('old', { v: 1, complete: true, createdAt: now - 8 * 24 * 3600_000 });
  mk('fresh', { v: 1, complete: true, createdAt: now - 2 * 24 * 3600_000 });
  mk('no-info', null);
  mk('broken', '{nope');
  mk('incomplete', { v: 1, complete: false, createdAt: now - 20 * 24 * 3600_000 });
  const outside = tmp('tp-out-');
  fs.writeFileSync(path.join(outside, 'info.json'), JSON.stringify({ v: 1, complete: true, createdAt: 0 }));
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  const dry = pruneBackups({ dir: root, now, dryRun: true });
  assert.deepEqual(dry.removed, ['old']);
  assert.ok(fs.existsSync(path.join(root, 'old')));
  const r = pruneBackups({ dir: root, now });
  assert.deepEqual(r.removed, ['old']);
  assert.deepEqual(r.odd.sort(), ['broken', 'incomplete', 'link', 'no-info', 'stray.txt']);
  assert.equal(fs.existsSync(path.join(root, 'old')), false);
  assert.ok(fs.existsSync(path.join(root, 'fresh')) && fs.existsSync(path.join(root, 'no-info')) && fs.existsSync(path.join(outside, 'info.json')));
  assert.deepEqual(pruneBackups({ dir: path.join(root, 'missing'), now }), { removed: [], odd: [] });
});

test('daily run: prunes old backups under the run, the report says so and mentions /cleanup for the kept worktrees', async () => {
  const w = world();
  const a = w.add('feat-kept'); // no merged PR → kept
  const d = path.join(w.backups, 'old'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'info.json'), JSON.stringify({ v: 1, complete: true, createdAt: 1 }));
  fs.mkdirSync(path.join(w.backups, 'weird'));
  const r = await runCleanup({ parentDir: w.parent, now: Date.now(), lockDir: w.lockDir, cargoCacheDir: path.join(w.parent, 'no-cache'), backupDir: w.backups, deps: deps() });
  assert.deepEqual(r.backups.removed, ['old']);
  const text = formatReport(r);
  assert.match(text, /còn giữ 1 worktree — \/cleanup để xoá tay/);
  assert.match(text, /Bản sao lưu xoá tay cũ hơn 7 ngày đã xoá \(1\)/);
  assert.match(text, /sao lưu lạ: weird/);
  assert.ok(fs.existsSync(a.path));
  assert.ok(BUILD_DIRS.has('.next'));
});

// ── /cleanup: the list, a target, the launcher ──────────────────────────────

test('parseCleanupCommand: none → list; run / --dry-run → the old launcher; anything else → a target', () => {
  assert.deepEqual(parseCleanupCommand(''), { kind: 'list' });
  assert.deepEqual(parseCleanupCommand('  '), { kind: 'list' });
  assert.deepEqual(parseCleanupCommand('run'), { kind: 'launch' });
  assert.deepEqual(parseCleanupCommand('--dry-run'), { kind: 'launch' });
  assert.deepEqual(parseCleanupCommand('feat/x'), { kind: 'search', word: 'feat/x' });
  assert.deepEqual(parseCleanupCommand(' sứa '), { kind: 'search', word: 'sứa' });
  assert.deepEqual(parseCleanupCommand(' /w/my dir/wt '), { kind: 'target', target: '/w/my dir/wt' });
  assert.deepEqual(parseCleanupCommand('~/p/wt'), { kind: 'target', target: '~/p/wt' });
});

test('/cleanup <word>: filters the kept list, renumbers 1..k, header names the word, 🗑 n points at the right path', async () => {
  const w = world();
  w.add('feat-alpha'); const b = w.add('feat-Beta-one'); const c = w.add('fix-beta-two'); w.add('feat-gamma');
  const h = harness(w);
  await startCleanupList(h.ctx, { ...h.o, search: '  BETA ' });
  assert.equal(h.sent.length, 1);
  const m = h.sent[0];
  assert.match(m.t, /^🧹 Worktree đang giữ, khớp "BETA" \(2\):/);
  assert.match(m.t, /\n1\. repo\/repo-feat-Beta-one/);
  assert.match(m.t, /\n2\. repo\/repo-fix-beta-two/);
  assert.ok(!/alpha|gamma/.test(m.t.split('\n').slice(0, 4).join('\n')));
  const [tok, entry] = [...h.store.entries()][0];
  assert.deepEqual(Object.keys(entry.rows), ['1', '2']);
  assert.equal(entry.rows[1].path, b.path);
  assert.equal(entry.rows[2].path, c.path);
  await handleCleanupButton(press(`cw:${tok}:2`, m.t), h.ctx, h.o);
  assert.match(h.sent[1].t, /^🗑 Xoá tay .*repo-fix-beta-two /);
});

test('/cleanup <word>: no match in the list → the old exact target; no match anywhere → "Không có worktree nào khớp"', async () => {
  const w = world();
  w.add('feat-alpha');
  const h = harness(w);
  await startCleanupList(h.ctx, { ...h.o, search: 'zzz' });
  assert.deepEqual(h.dms, ['🧹 Không có worktree nào khớp "zzz".']);
  assert.equal(h.sent.length, 0);
  // not in the kept list (stubbed list is empty) but an exact branch → the old table
  const x = w.add('feat-exact');
  const runManual = (c, t, o) => c === 'manual-list' ? Promise.resolve({ ok: true, rows: [], errors: [] }) : manualCommand(c, t, { ...o, deps: h.o.deps });
  await startCleanupList(h.ctx, { ...h.o, runManual, search: 'feat-exact' });
  assert.match(h.sent.at(-1).t, /^🗑 Xoá tay .*repo-feat-exact /);
  assert.equal(h.store.size, 1);
  assert.ok([...h.store.values()][0].path === x.path);
});

test('/cleanup list: the kept worktrees with their reason, §2.4 rows without a button, paging, [🧹 Dọn ngay]', async () => {
  const w = world();
  for (let i = 0; i < 9; i++) w.add(`feat-${i}`); // none has a merged PR → all kept
  const lk = w.add('feat-locked'); g(w.main, 'worktree', 'lock', lk.path);
  const h = harness(w);
  await startCleanupList(h.ctx, h.o);
  assert.equal(h.sent.length, 1);
  const m = h.sent[0];
  assert.match(m.t, /Worktree đang được giữ lại \(10\) — trang 1\/2/);
  assert.match(m.t, /1\. repo\/repo-feat-0 · feat-0 — chưa có PR merged/);
  const labels = m.rows.flat().map((b) => b.text);
  assert.ok(labels.includes('🗑 1') && labels.includes('🗑 8') && !labels.includes('🗑 9'));
  assert.deepEqual(m.rows.at(-2).map((b) => b.text), ['1/2', '›']);
  assert.deepEqual(m.rows.at(-1).map((b) => b.text), ['🧹 Dọn ngay']);
  const [tok, entry] = [...h.store.entries()][0];
  assert.equal(entry.mode, 'list');
  assert.equal(Object.keys(entry.rows).length, 10);
  assert.ok(entry.rows[1].path.endsWith('repo-feat-0') && entry.rows[1].head);
  // page 2: the locked one is listed, without a button
  const next = m.rows.at(-2)[1].callback_data;
  await handleCleanupButton(press(next, m.t), h.ctx, h.o);
  const p2 = h.edits.at(-1);
  assert.match(p2.t, /trang 2\/2/);
  const lockedLine = p2.t.split('\n').find((l) => l.includes('feat-locked'));
  assert.match(lockedLine, /🚫 không xoá tay được: bị khoá/);
  const lockedN = Object.entries(entry.info).find(([, v]) => v.branch === 'feat-locked')[0];
  assert.ok(!p2.rows.flat().some((b) => b.callback_data === `cw:${tok}:${lockedN}`));
  // pressing a normal row → a NEW message with the table, the list stays
  await handleCleanupButton(press(`cw:${tok}:2`, m.t), h.ctx, h.o);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].t, /^🗑 Xoá tay .*repo-feat-1 /);
  assert.deepEqual(h.sent[1].rows[0].map((b) => b.text), ['✅ Xoá', '✖']);
  assert.ok(h.store.has(tok), 'a list is not one-shot');
  // [🧹 Dọn ngay] → the real launcher
  let launched = null;
  await handleCleanupButton(press(`cr:${tok}`, m.t), h.ctx, { ...h.o, launch: (o) => { launched = o; } });
  assert.equal(launched.dryRun, false);
  // a list edited in the store (rows) no longer matches its 🔑
  h.store.set(tok, { ...entry, rows: { 1: { path: '/etc', head: 'x' } } });
  await handleCleanupButton(press(`cw:${tok}:1`, m.t), h.ctx, { ...h.o, runManual: async () => { throw new Error('must not run'); } });
  assert.match(h.answers.at(-1), /không khớp/);
});

test('/cleanup <branch>: straight to the table; the same branch in two repos → asks for a path; unknown → says so; an absolute path works', async () => {
  const w = world();
  const a = w.add('feat-direct');
  write(path.join(a.path, 'n.txt'));
  const h = harness(w);
  await startManualFor('feat-direct', h.ctx, h.o);
  assert.match(h.sent.at(-1).t, /^🗑 Xoá tay .*repo-feat-direct /);
  await startManualFor(a.path, h.ctx, h.o);
  assert.equal(h.sent.length, 2);
  await startManualFor('nope', h.ctx, h.o);
  assert.match(h.dms.at(-1), /không thấy nhánh "nope"/);
  // a second managed repo with a worktree on the same branch name
  const main2 = path.join(w.parent, 'second');
  fs.mkdirSync(main2); g(main2, 'init', '-q', '-b', 'main'); write(path.join(main2, 'f'), 'f'); g(main2, 'add', '.'); g(main2, 'commit', '-qm', 'i');
  g(main2, 'worktree', 'add', '-q', '-b', 'feat-direct', path.join(w.parent, 'second-feat-direct'));
  await startManualFor('feat-direct', h.ctx, h.o);
  assert.match(h.dms.at(-1), /nhánh có ở nhiều repo — gõ đường dẫn/);
  assert.match(h.dms.at(-1), /repo-feat-direct/);
  assert.match(h.dms.at(-1), /second-feat-direct/);
  assert.equal(h.sent.length, 2, 'no table for an ambiguous name');
  // a path that is not a linked worktree of a managed repo → refused, no button
  await startManualFor(w.main, h.ctx, h.o);
  assert.match(h.dms.at(-1), /không xoá tay được: .*checkout chính/);
});

test('/cleanup with the lock busy → a plain "đang bận" (nothing run)', async () => {
  const w = world();
  const h = harness(w);
  await startCleanupList(h.ctx, { ...h.o, acquire: async () => ({ timeout: true }), runManual: async () => { throw new Error('must not run'); } });
  assert.match(h.dms.at(-1), /đang bận/);
  await startManualFor('x', h.ctx, { ...h.o, acquire: async () => ({ timeout: true }), runManual: async () => { throw new Error('must not run'); } });
  assert.match(h.dms.at(-1), /đang bận/);
});

test('listKept: no transcript scan — a row that passes every cheap gate is shown with a note; childManual runs the same probe in a real child', async () => {
  const w = world();
  const a = w.add('feat-ok');
  const b = w.add('feat-dirty');
  write(path.join(b.path, 'a.txt'), 'dirty');
  const prs = { 'feat-ok': [{ number: 1, state: 'MERGED', headRefOid: a.head, headRefName: 'feat-ok' }], 'feat-dirty': [{ number: 2, state: 'MERGED', headRefOid: b.head, headRefName: 'feat-dirty' }] };
  const r = await listKept({ parentDir: w.parent, deps: { ...deps({ prs }), transcriptCwds: () => { throw new Error('the list must not scan transcripts'); } }, now: Date.now() + 30 * 24 * 3600_000 });
  assert.deepEqual(r.rows.map((x) => x.branch), ['feat-dirty', 'feat-ok']);
  assert.match(r.rows[0].reason, /thay đổi chưa commit/);
  assert.match(r.rows[1].reason, /qua mọi điều kiện dọn tự động.*không quét transcript/);
  assert.equal(r.rows[0].blocked, null);
  const viaChild = await childManual([])('manual-probe', b.path, { quick: true, parentDir: w.parent });
  assert.equal(viaChild.ok, true, viaChild.reason);
  assert.equal(viaChild.branch, 'feat-dirty');
  assert.equal(viaChild.files, undefined);
  const bad = await childManual([], { script: path.join(w.parent, 'missing.mjs') })('manual-probe', b.path, {});
  assert.equal(bad.childError, true);
});

test('renderCleanupList: an empty list still offers [🧹 Dọn ngay]; the digest line is intact', () => {
  const e = { kind: 'cleanup', mode: 'list', rows: {}, info: {}, page: 0, createdAt: 5 };
  const r = renderCleanupList(e, 'a'.repeat(16));
  assert.match(r.text, /Không có worktree nào/);
  assert.deepEqual(r.rows, [[{ text: '🧹 Dọn ngay', callback_data: `cr:${'a'.repeat(16)}` }]]);
  assert.equal(manualEntryMatchesMessage(e, r.text), true);
});

test('manualCommand: unknown command / a thrown error never escape', async () => {
  assert.equal((await manualCommand('nope', '/x', {})).ok, false);
  assert.equal((await manualCommand('manual-probe', '/definitely/not/here', { parentDir: tmp() })).hard, true);
});

// ── the daemon's dispatch of /cleanup ───────────────────────────────────────

test('dispatchCommand /cleanup: the list and <target> are owner-only; run / --dry-run still go to the registry launcher', async () => {
  const { dispatchCommand } = await import('./daemon.mjs');
  const w = world();
  w.add('feat-d');
  const h = harness(w);
  const registry = { cleanup: { run: 'cleanup-launch.mjs', args: [], needsProject: false, minRole: 'admin' } };
  const base = { daemonUserId: '1', projectsConfig: { _default: { roles: { 2: { role: 'admin' } } } }, registry, sendText: h.ctx.sendText, sendButtonRows: h.ctx.sendButtonRows,
    buttonStore: h.store, parentDir: w.parent, cleanupOpts: { deps: h.o.deps, lockDir: w.lockDir, waitSec: 0 } };
  const ran = [];
  const runner = async (_n, argv) => { ran.push(argv.slice(1)); return { stdout: 'ok', stderr: '' }; };
  await dispatchCommand({ cmd: 'cleanup', rest: '' }, { id: 2 }, { ...base, runner });       // an admin who is not the owner
  assert.match(h.dms.at(-1), /chỉ owner dùng được/);
  assert.equal(h.sent.length, 0);
  await dispatchCommand({ cmd: 'cleanup', rest: 'feat-d' }, { id: 2 }, { ...base, runner });
  assert.match(h.dms.at(-1), /chỉ owner dùng được/);
  await dispatchCommand({ cmd: 'cleanup', rest: '' }, { id: 1 }, { ...base, runner });       // the owner → the list
  assert.match(h.sent.at(-1).t, /Worktree đang được giữ lại/);
  await dispatchCommand({ cmd: 'cleanup', rest: 'feat-d' }, { id: 1 }, { ...base, runner });  // the owner, a word → the filtered list
  assert.match(h.sent.at(-1).t, /giữ, khớp "feat-d" \(1\)/);
  await dispatchCommand({ cmd: 'cleanup', rest: path.join(w.parent, 'repo-feat-d') }, { id: 1 }, { ...base, runner });  // a path → the table
  assert.match(h.sent.at(-1).t, /^🗑 Xoá tay /);
  assert.deepEqual(ran, []);
  await dispatchCommand({ cmd: 'cleanup', rest: 'run' }, { id: 2 }, { ...base, runner });     // the old launcher, any admin
  await dispatchCommand({ cmd: 'cleanup', rest: '--dry-run' }, { id: 2 }, { ...base, runner });
  assert.deepEqual(ran, [['run'], ['--dry-run']]);
});

// ── code review round 1 ─────────────────────────────────────────────────────

test('R1: filter=set / unset / unspecified are looked up as driver names too (fail closed)', async () => {
  const w = world();
  const a = w.add('feat-fset');
  write(path.join(a.path, '.gitattributes'), 'big.dat filter=set\n');
  write(path.join(a.path, 'big.dat'), 'v1');
  g(a.path, 'add', '-f', '.gitattributes', 'big.dat'); g(a.path, 'commit', '-qm', 'attrs');
  write(path.join(a.path, 'big.dat'), 'v2');
  assert.equal((await probe(w, a.path)).ok, true, 'filter=set with no driver configured is harmless');
  g(a.path, 'config', 'filter.set.clean', 'cat');
  await blocked(w, a.path, /filter "set"/);
});

test('R2: a file going A→B during the backup and back to A before the late probe → the backup is rejected, nothing removed', async () => {
  const w = world();
  const a = w.add('feat-aba');
  write(path.join(a.path, 'b.txt'), 'A');
  const p = await probe(w, a.path);
  const r = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups,
    hooks: { beforeBackup: () => write(path.join(a.path, 'b.txt'), 'B'), afterBackup: () => write(path.join(a.path, 'b.txt'), 'A') } });
  assert.equal(r.ok, false);
  assert.equal(r.backupFailed, true);
  assert.match(r.reason, /khác bản đã xác nhận/);
  assert.ok(fs.existsSync(a.path));
  assert.deepEqual(fs.readdirSync(w.backups), []);
  // straight at the writer too
  const pr = await probe(w, a.path);
  write(path.join(a.path, 'b.txt'), 'C');
  await assert.rejects(writeBackup(pr, { root: w.backups }), /unstaged\.patch khác bản đã xác nhận/);
  assert.deepEqual(fs.readdirSync(w.backups), []);
});

test('R3: the late probe does no PR query and no du; the first probe does both once', async () => {
  const w = world();
  const a = w.add('feat-fast');
  write(path.join(a.path, 'target', 'x'), 'junk');
  write(path.join(a.path, 'n.txt'));
  const calls = [];
  const d = deps();
  const rec = { ...d, exec: async (cmd, args, o) => { calls.push(cmd); return d.exec(cmd, args, o); } };
  const p = await probeManual(a.path, { parentDir: w.parent, deps: rec });
  const base = { gh: calls.filter((c) => c === 'gh').length, du: calls.filter((c) => c === 'du').length };
  assert.deepEqual(base, { gh: 1, du: 1 });
  calls.length = 0;
  const r = await manualRemove(a.path, { parentDir: w.parent, deps: rec, expectFingerprint: p.fingerprint, backupDir: w.backups });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual({ gh: calls.filter((c) => c === 'gh').length, du: calls.filter((c) => c === 'du').length }, { gh: 1, du: 1 }, 'two probes in the remove, one gh + one du in total (not three)');
});

test('R4: manual-remove holds the cleanup lock itself for the whole operation; a busy lock → busy, nothing run; the group kill outlives nothing', async () => {
  const w = world();
  const a = w.add('feat-lock4');
  write(path.join(a.path, 'n.txt'));
  const p = await probe(w, a.path);
  const lk = { dir: w.lockDir, waitSec: 0, label: 't', cmd: 'test' };
  const held = await acquireLock('cleanup', { waitSec: 0, dir: w.lockDir, cmd: 'other' });
  const busy = await manualCommand('manual-remove', a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups, lock: lk });
  held.release();
  assert.equal(busy.busy, true);
  assert.ok(fs.existsSync(a.path));
  let heldDuring = null;
  const r = await manualCommand('manual-remove', a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups, lock: lk,
    hooks: { afterBackup: async () => { heldDuring = !!(await acquireLock('cleanup', { waitSec: 0, dir: w.lockDir })).timeout; } } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(heldDuring, true, 'the lock is held while the backup / removal runs');
  const after = await acquireLock('cleanup', { waitSec: 0, dir: w.lockDir });
  assert.ok(!after.timeout, 'released afterwards');
  after.release();
  // timeout → the whole process group is killed, and the answer comes only after it is gone
  const dir = tmp('tp-grp-');
  const script = path.join(dir, 'hang.mjs');
  fs.writeFileSync(script, `import { spawn } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
const c = spawn('sleep', ['60'], { stdio: 'ignore' }); fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'pid'), String(c.pid)); setInterval(() => {}, 1000);`);
  const res = await childManual([], { script, timeout: 800 })('manual-remove', '/x', {});
  assert.equal(res.childError, true);
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the grandchild died with the group before we answered');
});

test('R5: a mode change on a backed-up file (0644 → 0755) changes the fingerprint', async () => {
  const w = world();
  const a = w.add('feat-mode');
  write(path.join(a.path, 'run.sh'), 'echo', 0o644);
  const p = await probe(w, a.path);
  fs.chmodSync(path.join(a.path, 'run.sh'), 0o755);
  assert.notEqual((await probe(w, a.path)).fingerprint, p.fingerprint);
});

test('R6/R10: a delayed press of a consumed token answers only and never edits; a legacy ck is guarded by the in-flight set', async () => {
  const w = world();
  const a = w.add('feat-stale');
  write(path.join(a.path, 'n.txt'));
  const h = harness(w);
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  const table = h.edits.at(-1);
  const edits = h.edits.length;
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, { ...h.o, runManual: async () => { throw new Error('must not run'); } }); // the old, consumed token
  assert.equal(h.edits.length, edits, 'no edit: the newer confirm keyboard stays');
  assert.match(h.answers.at(-1), /Hết hạn hoặc đã xử lý/);
  await handleCleanupButton(press(`ck:${'9'.repeat(16)}`, 'x'), h.ctx, h.o);
  assert.equal(h.edits.length, edits, 'a stale ck answers only too');
  // ck vs an in-flight press of the same token
  h.store.set('f'.repeat(16), { kind: 'cleanup', path: a.path, convoId: null, head: a.head, stray: ['n.txt'], strayHash: 'h', createdAt: Date.now() });
  manualInFlight.add('f'.repeat(16));
  try { await handleCleanupButton(press(`ck:${'f'.repeat(16)}`, 'x'), h.ctx, h.o); } finally { manualInFlight.delete('f'.repeat(16)); }
  assert.match(h.answers.at(-1), /đang xử lý/);
  assert.ok(h.store.has('f'.repeat(16)), 'the in-flight token was not consumed by ck');
  assert.ok(table.rows.length);
});

test('R7: the 20 000-file limit counts patch-backed + tar-backed paths together (checked in the probe, before any backup)', async () => {
  const w = world();
  const a = w.add('feat-union');
  for (let i = 0; i < 6; i++) write(path.join(a.path, `u${i}.txt`));
  write(path.join(a.path, 'a.txt'), 'x'); write(path.join(a.path, 'b.txt'), 'y'); write(path.join(a.path, 'README.md'), 'z');
  assert.equal((await probe(w, a.path, { maxFiles: 9 })).ok, true, '6 untracked + 3 tracked = 9');
  const r = await probe(w, a.path, { maxFiles: 8 });
  assert.equal(r.limit, true);
  assert.equal(fs.existsSync(w.backups), false);
});

test('R8/R13: the /cleanup list gives a hard-blocked row (incl. the filter check) no delete button; errors are shown; expired tokens are swept', async () => {
  const w = world();
  const a = w.add('feat-listf');
  write(path.join(a.path, '.gitattributes'), 'big.dat filter=lfs\n');
  write(path.join(a.path, 'big.dat'), 'v1');
  g(a.path, 'add', '-f', '.gitattributes', 'big.dat'); g(a.path, 'commit', '-qm', 'attrs');
  g(a.path, 'config', 'filter.lfs.clean', 'cat');
  write(path.join(a.path, 'big.dat'), 'v2');
  w.add('feat-plain');
  fs.mkdirSync(path.join(w.parent, 'broken', '.git'), { recursive: true }); // a repo whose `worktree list` fails → an error line
  const h = harness(w);
  h.store.set('e'.repeat(16), { kind: 'cleanup', mode: 'list', rows: {}, createdAt: 1 }); // long expired
  await startCleanupList(h.ctx, h.o);
  assert.equal(h.store.has('e'.repeat(16)), false, 'expired cleanup entries are swept');
  const m = h.sent.at(-1);
  const lines = m.t.split('\n');
  assert.match(lines.find((l) => l.includes('feat-listf')), /🚫 không xoá tay được: .*filter "lfs"/);
  const labels = m.rows.flat().map((b) => b.text);
  assert.equal(labels.filter((l) => /^🗑 \d/.test(l)).length, 1, 'only the plain row has a button');
  assert.ok(lines.some((l) => l.startsWith('⚠️ ') && /broken/.test(l)), 'list errors are shown');
  // an expired token that is pressed is deleted, without touching the message
  h.store.set('d'.repeat(16), { kind: 'cleanup', mode: 'manual', path: a.path, createdAt: 1 });
  const n = h.edits.length;
  await handleCleanupButton(press(`cm:${'d'.repeat(16)}`, 'x'), h.ctx, h.o);
  assert.equal(h.store.has('d'.repeat(16)), false);
  assert.equal(h.edits.length, n);
});

test('R11: git worktree remove failing after the backup → the message names the backup + restore.sh and does NOT say the tree is intact', async () => {
  const w = world();
  const a = w.add('feat-rmfail');
  write(path.join(a.path, 'n.txt'));
  const h = harness(w);
  const d = deps();
  h.o.deps = { ...d, exec: async (cmd, args, o) => { if (cmd === 'git' && args.includes('remove')) throw new Error('fatal: cannot remove: Directory not empty'); return d.exec(cmd, args, o); } };
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  const t1 = h.edits.at(-1);
  await handleCleanupButton(press(t1.rows[0][0].callback_data, t1.t), h.ctx, h.o);
  const last = h.edits.at(-1);
  assert.match(last.t, /git worktree remove lỗi: .* — worktree có thể đã bị xoá một phần\. Sao lưu: .* · khôi phục: bash .*restore\.sh/);
  assert.doesNotMatch(last.t, /còn nguyên/);
  assert.deepEqual(last.rows, []);
  assert.ok(fs.readdirSync(w.backups).length === 1, 'the backup is kept');
  assert.match(h.delivered.at(-1).cleanupResult.text, /restore\.sh/);
});

// ── code review round 2 ─────────────────────────────────────────────────────

test('R2-1: a change after the backup re-offers a table with the REAL inventory (full probe, not the fast one)', async () => {
  const w = world();
  const a = w.add('feat-late');
  write(path.join(a.path, 'n.txt'), 'one');
  write(path.join(a.path, 'b.txt'), 'edited');
  const p = await probe(w, a.path);
  const r = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups,
    hooks: { afterBackup: () => write(path.join(a.path, 'n2.txt'), 'two') } });
  assert.equal(r.changed, true);
  assert.match(r.note, /trong lúc sao lưu/);
  assert.equal(r.probe.tracked.count, 1);
  assert.equal(r.probe.entryCount, 2);
  assert.ok(r.probe.bytes > 0);
  const t = formatManualTable(r.probe, { mode: 'manual', stage: 'confirm', path: r.probe.path, branch: 'feat-late', createdAt: 1 });
  assert.match(t, /• 1 file đã track bị sửa: b\.txt/);
  assert.match(t, /• 2 mục ngoài git: n\.txt, n2\.txt/);
  assert.doesNotMatch(t, /không mất gì|sao lưu 0 B/);
  assert.deepEqual(fs.readdirSync(w.backups), []);
});

test('R2-2: tracked changes alone over the limit → limit, no tar entries needed', async () => {
  const w = world();
  const a = w.add('feat-trk');
  write(path.join(a.path, 'a.txt'), 'x'); write(path.join(a.path, 'b.txt'), 'y'); write(path.join(a.path, 'README.md'), 'z');
  assert.equal((await probe(w, a.path, { maxFiles: 3 })).ok, true);
  const r = await probe(w, a.path, { maxFiles: 2 });
  assert.equal(r.limit, true);
  assert.match(r.reason, /quá lớn/);
});

test('R2-3: the child dies during git worktree remove → the owner is pointed at the backup + restore.sh, no buttons', async () => {
  const w = world();
  const a = w.add('feat-kill');
  write(path.join(a.path, 'n.txt'));
  const h = harness(w);
  const d = deps();
  let markerSeen = false;
  // the remove "hangs": the marker must already be on disk then; the injected runManual reports a watchdog kill afterwards
  const killing = { ...d, exec: async (cmd, args, o) => {
    if (cmd === 'git' && args.includes('remove')) { markerSeen = fs.readdirSync(w.backups).some((n) => fs.existsSync(path.join(w.backups, n, 'removing.json'))); throw Object.assign(new Error('killed'), { killed: true }); }
    return d.exec(cmd, args, o);
  } };
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  const t1 = h.edits.at(-1);
  // run the real manual-remove with the killing exec, but leave the marker in place and report a child error (as the watchdog does)
  const runner = async (cmd, target, opts) => {
    await manualCommand(cmd, target, { ...opts, deps: killing });
    const bk = path.join(w.backups, fs.readdirSync(w.backups)[0]);
    fs.writeFileSync(path.join(bk, 'removing.json'), JSON.stringify({ path: a.path, runId: opts.runId, at: Date.now() })); // the real run killed before it could delete it
    return { ok: false, childError: true, reason: 'quá thời gian, đã dừng tiến trình' };
  };
  await handleCleanupButton(press(t1.rows[0][0].callback_data, t1.t), h.ctx, { ...h.o, runManual: runner });
  assert.equal(markerSeen, true, 'removing.json is written before git worktree remove');
  const last = h.edits.at(-1);
  assert.match(last.t, /worktree có thể đã bị xoá một phần\. Sao lưu: .* · khôi phục: bash .*restore\.sh/);
  assert.deepEqual(last.rows, []);
  assert.doesNotMatch(last.t, /bấm lại/);
  // and on a normal success the marker is gone
  const b = w.add('feat-ok2');
  write(path.join(b.path, 'm.txt'));
  const pb = await probe(w, b.path);
  const ok = await manualRemove(b.path, { parentDir: w.parent, deps: deps(), expectFingerprint: pb.fingerprint, backupDir: w.backups });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(fs.existsSync(path.join(ok.backupDir, 'removing.json')), false);
});

// ── code review round 3 ─────────────────────────────────────────────────────

async function crashedPress(w, h, a, { marker }) {
  const { tok, text } = seedCm(h, a, undefined);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  const t1 = h.edits.at(-1);
  const runner = async (cmd, target, opts) => {
    if (marker) marker(opts);
    return { ok: false, childError: true, reason: 'quá thời gian, đã dừng tiến trình' };
  };
  await handleCleanupButton(press(t1.rows[0][0].callback_data, t1.t), h.ctx, { ...h.o, runManual: runner });
  return h.edits.at(-1);
}

test('R3-1: a stale marker (other runId) does not make a later childError look like a partial deletion; the matching run is picked', async () => {
  const w = world();
  const a = w.add('feat-stale-mk');
  write(path.join(a.path, 'n.txt'));
  const old = path.join(w.backups, 'old-run'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'removing.json'), JSON.stringify({ path: a.path, runId: 'deadbeefdeadbeef', at: 1 }));
  const h = harness(w);
  const last = await crashedPress(w, h, a, {});
  assert.match(last.t, /bấm lại/);
  assert.doesNotMatch(last.t, /xoá một phần/);
  assert.deepEqual(last.rows[0].map((x) => x.text), ['✅ Xoá', '✖']);
  // two crashed runs: the one with this press's runId wins, and its marker is unlinked once matched
  const h2 = harness(w);
  const mine = path.join(w.backups, 'mine'); fs.mkdirSync(mine, { recursive: true });
  const l2 = await crashedPress(w, h2, a, { marker: (opts) => fs.writeFileSync(path.join(mine, 'removing.json'), JSON.stringify({ path: a.path, runId: opts.runId, at: 2 })) });
  assert.match(l2.t, /xoá một phần\. Sao lưu: .*\/mine · khôi phục: bash .*\/mine\/restore\.sh/);
  assert.equal(fs.existsSync(path.join(mine, 'removing.json')), false, 'unlinked after matching');
  assert.equal(fs.existsSync(path.join(old, 'removing.json')), true, 'another run\'s marker is not touched by the daemon');
});

test('R3-1b: before writing its marker the child clears older markers for the same path', async () => {
  const w = world();
  const a = w.add('feat-clear');
  write(path.join(a.path, 'n.txt'));
  const old = path.join(w.backups, 'older'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'removing.json'), JSON.stringify({ path: a.path, runId: 'x', at: 1 }));
  const other = path.join(w.backups, 'other'); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'removing.json'), JSON.stringify({ path: '/some/other', runId: 'x', at: 1 }));
  const p = await probe(w, a.path);
  let during = null;
  const r = await manualRemove(a.path, { parentDir: w.parent, deps: deps(), expectFingerprint: p.fingerprint, backupDir: w.backups, runId: 'r1',
    hooks: { writeMarker: (f, body) => { during = fs.existsSync(path.join(old, 'removing.json')); fs.writeFileSync(f, body); } } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(during, false);
  assert.equal(fs.existsSync(path.join(other, 'removing.json')), true);
});

test('R3-2: a marker that can not be written → git worktree remove is NOT run; "chưa xoá gì", the backup stays', async () => {
  const w = world();
  const a = w.add('feat-nomark');
  write(path.join(a.path, 'n.txt'));
  const p = await probe(w, a.path);
  const d = deps();
  let removed = false;
  const dd = { ...d, exec: async (cmd, args, o) => { if (cmd === 'git' && args.includes('remove')) removed = true; return d.exec(cmd, args, o); } };
  const r = await manualRemove(a.path, { parentDir: w.parent, deps: dd, expectFingerprint: p.fingerprint, backupDir: w.backups, runId: 'r2',
    hooks: { writeMarker: () => { throw new Error('ENOSPC'); } } });
  assert.equal(r.ok, false);
  assert.equal(r.notStarted, true);
  assert.match(r.reason, /chưa xoá gì/);
  assert.equal(removed, false);
  assert.ok(fs.existsSync(a.path));
  assert.ok(fs.existsSync(path.join(r.backupDir, 'restore.sh')));
  // the daemon says so, without buttons
  const h = harness(w);
  const { tok, text } = seedCm(h, a);
  await handleCleanupButton(press(`cm:${tok}`, text), h.ctx, h.o);
  const t1 = h.edits.at(-1);
  await handleCleanupButton(press(t1.rows[0][0].callback_data, t1.t), h.ctx, { ...h.o, runManual: async () => r });
  assert.match(h.edits.at(-1).t, /Worktree còn nguyên; sao lưu vẫn còn ở/);
  assert.deepEqual(h.edits.at(-1).rows, []);
});
