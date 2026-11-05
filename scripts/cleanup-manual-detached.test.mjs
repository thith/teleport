// RFC 39 — manual cleanup of a DETACHED-HEAD worktree: no hard block, a keep-ref for the commit, the table, restore, the backup sweep.
// Real temp git repos only; nothing destructive is real, no Telegram, no daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { probeManual, manualRemove, buildRestoreScript, manualCommand } from './cleanup-manual.mjs';
import { handleCleanupButton, startCleanupList, formatManualTable, manualDigest, manualEntryMatchesMessage } from './cleanup-inbox.mjs';
import { pruneBackups, refName } from './cleanup.mjs';

const execFileP = promisify(execFile);
const tmp = (p = 'tp-det-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gOk = (cwd, ...args) => { try { return g(cwd, ...args); } catch { return null; } };
const write = (f, s = 'x') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

function world({ name = 'repo' } = {}) {
  const parent = tmp();
  const main = path.join(parent, name);
  fs.mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main');
  write(path.join(main, 'a.txt'), 'a');
  g(main, 'add', '.');
  g(main, 'commit', '-q', '-m', 'init');
  g(main, 'remote', 'add', 'origin', 'git@github.com:acme/repo.git');
  const backups = path.join(parent, '.backups');
  const lockDir = path.join(parent, '.locks');
  /** A detached worktree at main's HEAD, plus `n` commits of its own. */
  const det = (topic, n = 0) => {
    const p = path.join(parent, `${name}-${topic}`);
    g(main, 'worktree', 'add', '-q', '--detach', p);
    for (let i = 0; i < n; i++) g(p, 'commit', '-q', '--allow-empty', '-m', `det ${topic} ${i}`);
    return { path: p, head: g(p, 'rev-parse', 'HEAD') };
  };
  const add = (topic) => {
    const p = path.join(parent, `${name}-${topic}`);
    g(main, 'worktree', 'add', '-q', '-b', topic, p);
    g(p, 'commit', '-q', '--allow-empty', '-m', `work on ${topic}`);
    return { path: p, branch: topic, head: g(p, 'rev-parse', 'HEAD') };
  };
  return { parent, main, backups, lockDir, det, add, procs: [] };
}
function deps(w, { fail = null } = {}) {
  return {
    exec: async (cmd, args, opts) => {
      if (cmd === 'gh') return '[]';
      if (fail && fail(cmd, args)) throw new Error('injected failure');
      return (await execFileP(cmd, args, opts)).stdout;
    },
    procCwds: () => w.procs, procComm: () => 'node', transcriptCwds: () => new Set(), log: () => {},
  };
}
const probe = (w, p, extra = {}) => probeManual(p, { parentDir: w.parent, deps: deps(w), ...extra });
const remove = async (w, p, extra = {}) => {
  const pr = await probe(w, p);
  assert.equal(pr.ok, true, pr.reason);
  return manualRemove(p, { parentDir: w.parent, deps: deps(w), expectFingerprint: pr.fingerprint, backupDir: w.backups, ...extra });
};
const refs = (w) => g(w.main, 'for-each-ref', '--format=%(refname)', 'refs/teleport-backup');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

test('table: HEAD on main · only on a tag · 2 orphan commits · only on origin/main (not "origin") — detached lines and the validator', async () => {
  const w = world();
  const onMain = w.det('onmain');
  const p1 = await probe(w, onMain.path);
  assert.equal(p1.ok, true, p1.reason);
  assert.equal(p1.detached, true);
  assert.equal(p1.branch, null);
  assert.equal(p1.orphanCommits, 0);
  assert.equal(p1.containedIn, 'main');
  const e1 = { mode: 'manual', stage: 'confirm', path: p1.path, commonDir: p1.commonDir, branch: p1.branch, head: p1.head, fingerprint: p1.fingerprint, createdAt: 1 };
  const t1 = formatManualTable(p1, e1);
  assert.match(t1, new RegExp(`^🗑 Xoá tay ${p1.path} \\(detached ở ${p1.head.slice(0, 7)}\\)\\n• commit: đã nằm trên main · vẫn giữ bằng ref refs/teleport-backup/… \\(7 ngày\\)`));
  assert.doesNotMatch(t1, /PR/);
  assert.equal(manualEntryMatchesMessage(e1, t1), true, 'the validator takes the detached first line');
  assert.equal(manualEntryMatchesMessage(e1, t1.replace('detached ở', 'nhánh x ở')), false);

  const onTag = w.det('ontag', 1);
  g(w.main, 'tag', 'v1', onTag.head);
  const p2 = await probe(w, onTag.path);
  assert.equal(p2.orphanCommits, 0);
  assert.match(formatManualTable(p2, { ...e1, path: p2.path, head: p2.head }), /• commit: đã nằm trên v1 /);

  const orphan = w.det('orphan', 2);
  const p3 = await probe(w, orphan.path);
  assert.equal(p3.orphanCommits, 2);
  assert.match(formatManualTable(p3, { ...e1, path: p3.path, head: p3.head }), /• commit: 2 commit không nằm trên nhánh\/tag nào → giữ bằng ref refs\/teleport-backup\/… \(7 ngày\)/);

  const remote = w.det('remote', 1);
  g(w.main, 'update-ref', 'refs/remotes/origin/main', remote.head);
  g(w.main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const p4 = await probe(w, remote.path);
  assert.equal(p4.orphanCommits, 0);
  assert.equal(p4.containedIn, 'origin/main');
});

test('an old refs/teleport-backup/x holding HEAD does not hide the work: still counted as orphan', async () => {
  const w = world();
  const a = w.det('old', 1);
  g(w.main, 'update-ref', 'refs/teleport-backup/x', a.head);
  const p = await probe(w, a.path);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.orphanCommits, 1);
});

test('remove a detached worktree with orphan commits: ref points at head, survives gc, restore.sh rebuilds the detached worktree with all changes', async () => {
  const w = world();
  const a = w.det('audit', 2);
  write(path.join(a.path, 'a.txt'), 'edited');
  write(path.join(a.path, 'notes.txt'), 'untracked');
  const res = await remove(w, a.path);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.detached, true);
  assert.equal(res.branch, null);
  assert.equal(res.head, a.head);
  assert.match(path.basename(res.backupDir), new RegExp(`^repo-detached-${a.head.slice(0, 7)}-`));
  assert.equal(res.keepRef, `refs/teleport-backup/${refName(path.basename(res.backupDir))}`);
  assert.equal(g(w.main, 'rev-parse', res.keepRef), a.head);
  assert.equal(g(w.main, 'branch', '--list').includes('detached'), false, 'not a branch');
  assert.equal(fs.existsSync(a.path), false);
  const info = JSON.parse(fs.readFileSync(path.join(res.backupDir, 'info.json'), 'utf8'));
  assert.deepEqual({ v: info.v, detached: info.detached, orphanCommits: info.orphanCommits, keepRef: info.keepRef, branch: info.branch }, { v: 1, detached: true, orphanCommits: 2, keepRef: res.keepRef, branch: null });
  const sh = fs.readFileSync(path.join(res.backupDir, 'restore.sh'), 'utf8');
  assert.match(sh, /worktree add --detach/);
  assert.doesNotMatch(sh, /refs\/heads/);
  g(w.main, 'reflog', 'expire', '--expire=now', '--all');
  g(w.main, 'gc', '-q', '--prune=now');
  assert.equal(g(w.main, 'cat-file', '-t', a.head), 'commit', 'the commit survived gc');
  await execFileP('bash', [path.join(res.backupDir, 'restore.sh')]);
  assert.equal(g(a.path, 'rev-parse', 'HEAD'), a.head);
  assert.equal(g(a.path, 'branch', '--show-current'), '');
  assert.equal(fs.readFileSync(path.join(a.path, 'a.txt'), 'utf8'), 'edited');
  assert.equal(fs.readFileSync(path.join(a.path, 'notes.txt'), 'utf8'), 'untracked');
});

test('even a detached HEAD already on main gets a keep-ref; a repo name with "." and ".." still makes a valid ref', async () => {
  const w = world({ name: '.my..repo' });
  const a = w.det('x');
  const res = await remove(w, a.path);
  assert.equal(res.ok, true, res.reason);
  assert.equal(g(w.main, 'rev-parse', res.keepRef), a.head);
  execFileSync('git', ['check-ref-format', res.keepRef]);
  assert.ok(!res.keepRef.includes('.'), 'refName turns every character outside [A-Za-z0-9_-] into _');
});

test('buildRestoreScript: branch null → straight to worktree add --detach (no branch attempt)', () => {
  const sh = buildRestoreScript({ main: '/m', wtPath: '/w', branch: null, head: 'a'.repeat(40), hasStaged: false, hasUnstaged: false, hasTar: false });
  assert.match(sh, /worktree add --detach '\/w' "\$HEAD_SHA"/);
  assert.doesNotMatch(sh, /BR=|refs\/heads/);
});

test('reflog with a commit reset away (not on any branch) blocks', async () => {
  const w = world();
  const a = w.det('reset', 1);
  g(a.path, 'reset', '-q', '--hard', 'HEAD~1');
  const r = await probe(w, a.path);
  assert.equal(r.ok, false);
  assert.equal(r.hard, true);
  assert.match(r.reason, /reflog có 1 commit đã bị reset bỏ, không nằm trên nhánh nào — xử lý tay/);
});

test('reflog check is repeated at the late probe: a commit reset away DURING the backup aborts and rolls the ref back', async () => {
  const w = world();
  const a = w.det('late', 1);
  const r = await remove(w, a.path, { hooks: { afterBackup: () => { g(a.path, 'reset', '-q', '--hard', 'HEAD~1'); } } });
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(a.path));
  assert.equal(refs(w), '');
  assert.deepEqual(fs.existsSync(w.backups) ? fs.readdirSync(w.backups) : [], []);
});

test('abort paths remove the backup dir AND the ref this run created: verify fails · late fingerprint · late process · hook throws', async () => {
  const cases = {
    'verify fails': (w) => ({ deps: deps(w, { fail: (c, a2) => c === 'git' && a2.includes('read-tree') }) }),
    'late fingerprint': (w, a) => ({ hooks: { afterBackup: () => write(path.join(a.path, 'new.txt'), 'late') } }),
    'late process': (w, a) => ({ hooks: { afterBackup: () => { w.procs.push({ pid: 4242, cwd: a.path }); } } }),
    'hook throws': () => ({ hooks: { afterBackup: () => { throw new Error('boom'); } } }),
  };
  for (const [name, mk] of Object.entries(cases)) {
    const w = world();
    const a = w.det('abort', 1);
    write(path.join(a.path, 'n.txt'), 'n');
    const extra = mk(w, a);
    const r = await remove(w, a.path, extra);
    assert.equal(r.ok, false, name);
    assert.ok(fs.existsSync(a.path), `${name}: worktree stays`);
    assert.equal(refs(w), '', `${name}: ref rolled back`);
    assert.deepEqual(fs.existsSync(w.backups) ? fs.readdirSync(w.backups) : [], [], `${name}: no backup dir`);
  }
});

test('update-ref fails / the ref name already exists → worktree stays, no backup dir, the OLD ref is untouched', async () => {
  const w = world();
  const a = w.det('clash', 1);
  const now = Date.parse('2026-11-05T10:00:00Z');
  const dirName = `repo-detached-${a.head.slice(0, 7)}-${stamp(now)}-abcd`;
  const ref = `refs/teleport-backup/${refName(dirName)}`;
  const other = g(w.main, 'rev-parse', 'HEAD');
  g(w.main, 'update-ref', ref, other);
  const r = await remove(w, a.path, { now, rand: () => 'abcd' });
  assert.equal(r.ok, false);
  assert.equal(r.backupFailed, true);
  assert.ok(fs.existsSync(a.path));
  assert.equal(g(w.main, 'rev-parse', ref), other, 'a ref this run did not create is left alone');
  assert.deepEqual(fs.readdirSync(w.backups), []);
  // a plain update-ref failure
  const w2 = world();
  const b = w2.det('uf', 1);
  const r2 = await remove(w2, b.path, { deps: deps(w2, { fail: (c, a2) => a2.includes('update-ref') }) });
  assert.equal(r2.backupFailed, true);
  assert.ok(fs.existsSync(b.path));
  assert.equal(refs(w2), '');
  assert.deepEqual(fs.readdirSync(w2.backups), []);
});

test('once the removal started (removeFailed) the backup dir AND the ref are kept', async () => {
  const w = world();
  const a = w.det('rf', 1);
  const r = await remove(w, a.path, { deps: deps(w, { fail: (c, a2) => a2.includes('worktree') && a2.includes('remove') }) });
  assert.equal(r.removeFailed, true);
  assert.ok(fs.existsSync(r.backupDir));
  assert.equal(g(w.main, 'rev-parse', `refs/teleport-backup/${refName(path.basename(r.backupDir))}`), a.head);
});

test('a branch worktree is unchanged: no ref, branch name in the dir, info.detached false', async () => {
  const w = world();
  const a = w.add('feat-x');
  const res = await remove(w, a.path);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.keepRef, null);
  assert.equal(refs(w), '');
  const info = JSON.parse(fs.readFileSync(path.join(res.backupDir, 'info.json'), 'utf8'));
  assert.equal(info.detached, false);
  assert.equal(info.keepRef, undefined);
  assert.match(path.basename(res.backupDir), /^repo-feat-x-/);
});

// ── the backup sweep ─────────────────────────────────────────────────────────

test('pruneBackups: the keep-ref goes with the directory; a bad prefix is odd and untouched; a moved ref is not deleted; a symref never deletes main', async () => {
  const w = world();
  const day = 24 * 3600_000;
  const mk = async (topic) => {
    const a = w.det(topic, 1);
    const r = await remove(w, a.path);
    assert.equal(r.ok, true, r.reason);
    return { ...r, name: path.basename(r.backupDir), info: path.join(r.backupDir, 'info.json') };
  };
  const age = (x, patch = {}) => { const i = JSON.parse(fs.readFileSync(x.info, 'utf8')); fs.writeFileSync(x.info, JSON.stringify({ ...i, createdAt: Date.now() - 8 * day, ...patch })); };
  const good = await mk('good'), badPrefix = await mk('badprefix'), moved = await mk('moved'), sym = await mk('sym'), fresh = await mk('fresh');
  age(good); age(badPrefix, { keepRef: 'refs/heads/main' }); age(moved); age(sym);
  g(w.main, 'update-ref', moved.keepRef, g(w.main, 'rev-parse', 'HEAD'));       // now points elsewhere
  g(w.main, 'update-ref', '-d', sym.keepRef);
  g(w.main, 'symbolic-ref', sym.keepRef, 'refs/heads/main');                    // a symref to main
  const mainBefore = g(w.main, 'rev-parse', 'refs/heads/main');
  const dry = pruneBackups({ dir: w.backups, dryRun: true, parentDir: w.parent });
  assert.ok(dry.removed.includes(good.name));
  assert.equal(gOk(w.main, 'rev-parse', '--verify', good.keepRef) != null, true, '--dry-run touches nothing');
  const r = pruneBackups({ dir: w.backups, parentDir: w.parent });
  assert.deepEqual(r.odd, [badPrefix.name]);
  assert.ok(fs.existsSync(badPrefix.backupDir), 'an odd backup keeps its directory');
  assert.equal(g(w.main, 'rev-parse', 'refs/heads/main'), mainBefore, 'main is intact');
  assert.equal(gOk(w.main, 'rev-parse', '--verify', '-q', good.keepRef), null, 'the ref is gone with the directory');
  assert.equal(fs.existsSync(good.backupDir), false);
  assert.equal(g(w.main, 'rev-parse', moved.keepRef), g(w.main, 'rev-parse', 'HEAD'), 'a ref that moved is not deleted');
  assert.equal(fs.existsSync(moved.backupDir), false, 'the directory still goes');
  assert.ok(r.refErrors.some((l) => l.includes(moved.keepRef)), 'one line in the report');
  assert.equal(fs.existsSync(sym.backupDir), false);
  assert.equal(fs.existsSync(fresh.backupDir), true);
  // head / commonDir are checked too
  const w2 = world();
  const a = w2.det('hd', 1);
  const res = await remove(w2, a.path);
  const f = path.join(res.backupDir, 'info.json');
  const info = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const patch of [{ head: 'zzz' }, { commonDir: tmp('tp-notmanaged-') }]) {
    fs.writeFileSync(f, JSON.stringify({ ...info, createdAt: Date.now() - 8 * day, ...patch }));
    const rr = pruneBackups({ dir: w2.backups, parentDir: w2.parent });
    assert.deepEqual(rr.odd, [path.basename(res.backupDir)]);
    assert.ok(fs.existsSync(res.backupDir));
    assert.equal(g(w2.main, 'rev-parse', res.keepRef), a.head);
  }
});

// ── buttons: the owner flow and the /cleanup list ────────────────────────────

function harness(w) {
  const store = new Map(), sent = [], edits = [], answers = [], delivered = [], audits = [];
  const ctx = {
    daemonUserId: '1', buttonStore: store, secretEnvKeys: [],
    sendText: async () => {}, sendButtons: async (c, t, b) => { sent.push({ t, rows: [b] }); return { message_id: 50 }; },
    sendButtonRows: async (c, t, rows) => { sent.push({ t, rows }); return { message_id: 50 + sent.length }; },
    answerButton: async (id, t) => { answers.push(t); },
    editButtonsMessage: async (c, m, t) => { edits.push({ t, rows: [] }); },
    editButtonRowsStrict: async (c, m, t, rows) => { edits.push({ t, rows }); },
  };
  const o = { parentDir: w.parent, deps: deps(w), lockDir: w.lockDir, waitSec: 0, backupDir: w.backups, deliver: async (r, opt) => { delivered.push(opt.build(r)); }, audit: (e) => audits.push(e) };
  return { store, sent, edits, answers, delivered, audits, ctx, o };
}
const press = (data, text) => ({ id: 'q', data, from: { id: 1 }, message: { chat: { id: 1 }, message_id: 9, text } });

test('buttons: cm on a detached worktree → table → ✅ removes, owner and agent texts name the keep-ref; ✖ on a detached table is accepted by the validator', async () => {
  const w = world();
  const a = w.det('btn', 1);
  const h = harness(w);
  const seed = (tok) => {
    const e = { kind: 'cleanup', mode: 'manual', path: a.path, head: a.head, convoId: '5', who: 'Giun #5', createdAt: Date.now() };
    h.store.set(tok, e);
    return `🧹 cleanup-request của Giun #5: ❌ giữ lại ${a.path}: detached HEAD\n🔑 ${manualDigest(e)}`;
  };
  const t1 = seed('a'.repeat(16));
  await handleCleanupButton(press(`cm:${'a'.repeat(16)}`, t1), h.ctx, h.o);
  const table = h.edits.at(-1);
  assert.match(table.t, /^🗑 Xoá tay .* \(detached ở [0-9a-f]{7}\)\n• commit: 1 commit không nằm trên nhánh\/tag nào/);
  assert.deepEqual(table.rows[0].map((b) => b.text), ['✅ Xoá', '✖']);
  // ✖ first (a second table for the same worktree): not "Nút không khớp"
  const t2 = seed('b'.repeat(16));
  await handleCleanupButton(press(`cm:${'b'.repeat(16)}`, t2), h.ctx, h.o);
  const table2 = h.edits.at(-1);
  await handleCleanupButton(press(table2.rows[0][1].callback_data, table2.t), h.ctx, h.o);
  assert.doesNotMatch(String(h.answers.at(-1)), /không khớp/);
  assert.ok(h.audits.some((x) => x.mode === 'manual-keep'));
  assert.ok(fs.existsSync(a.path));
  // ✅ on the first table
  await handleCleanupButton(press(table.rows[0][0].callback_data, table.t), h.ctx, h.o);
  assert.equal(fs.existsSync(a.path), false);
  const keepRef = refs(w).split('\n')[0];
  assert.match(keepRef, /^refs\/teleport-backup\/repo-detached-/);
  assert.match(h.edits.at(-1).t, new RegExp(`^✅ đã xoá ${a.path} \\(detached ở ${a.head.slice(0, 7)}\\) · sao lưu: .* · commit giữ ở ${keepRef} · khôi phục: bash .*restore\\.sh`));
  assert.match(h.delivered.at(-1).cleanupResult.text, new RegExp(`owner xoá tay ${a.path} \\(detached ở ${a.head.slice(0, 7)}, commit giữ ở ${keepRef}\\)`));
});

test('/cleanup list: a detached row is shown as "detached" and has a 🗑 button (not blocked)', async () => {
  const w = world();
  w.det('listed', 1);
  const h = harness(w);
  await startCleanupList(h.ctx, h.o);
  const m = h.sent[0];
  assert.match(m.t, /1\. repo\/repo-listed · detached — detached HEAD/);
  assert.doesNotMatch(m.t, /không xoá tay được/);
  assert.ok(m.rows.flat().some((b) => b.text === '🗑 1'));
});

test('manualCommand manual-probe on a detached worktree returns the slim table data', async () => {
  const w = world();
  const a = w.det('mc', 2);
  const r = await manualCommand('manual-probe', a.path, { parentDir: w.parent, deps: deps(w) });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual({ d: r.detached, o: r.orphanCommits, b: r.branch }, { d: true, o: 2, b: null });
});

// ── review round 1 ───────────────────────────────────────────────────────────

const noBackups = (w) => assert.deepEqual(fs.existsSync(w.backups) ? fs.readdirSync(w.backups) : [], []);

test('HEAD only on a tag: removal still creates the keep-ref', async () => {
  const w = world();
  const a = w.det('tagonly', 1);
  g(w.main, 'tag', 'v9', a.head);
  const r = await remove(w, a.path);
  assert.equal(r.ok, true, r.reason);
  assert.equal(g(w.main, 'rev-parse', r.keepRef), a.head);
});

test('the keep-ref fails verification after creation → ref rolled back, worktree kept, no backup dir', async () => {
  const w = world();
  const a = w.det('vf', 1);
  const base = deps(w);
  const d = { ...base, exec: async (c, args, o) => (c === 'git' && args.includes('rev-parse') && args.includes('--verify') && args.some((x) => x.startsWith('refs/teleport-backup/')) && !args.includes('-q') ? 'deadbeef' : base.exec(c, args, o)) };
  const r = await remove(w, a.path, { deps: d });
  assert.equal(r.backupFailed, true);
  assert.ok(fs.existsSync(a.path));
  assert.equal(refs(w), '');
  noBackups(w);
});

test('restore.sh / info.json can not be written after the ref was created → same rollback', async () => {
  const w = world();
  const a = w.det('wf', 1);
  const base = deps(w);
  const d = { ...base, exec: async (c, args, o) => {
    const out = await base.exec(c, args, o);
    if (c === 'git' && args.includes('rev-parse') && args.includes('--verify') && !args.includes('-q') && args.some((x) => x.startsWith('refs/teleport-backup/'))) {
      for (const e of fs.readdirSync(w.backups)) fs.mkdirSync(path.join(w.backups, e, 'restore.sh')); // writeFileSync → EISDIR
    }
    return out;
  } };
  const r = await remove(w, a.path, { deps: d });
  assert.equal(r.backupFailed, true);
  assert.ok(fs.existsSync(a.path));
  assert.equal(refs(w), '');
  noBackups(w);
});

test('pre-existing ref collision: the old ref is untouched (and nothing is left behind)', async () => {
  const w = world();
  const a = w.det('coll', 1);
  const now = Date.parse('2026-11-05T11:00:00Z');
  const ref = `refs/teleport-backup/${refName(`repo-detached-${a.head.slice(0, 7)}-${stamp(now)}-beef`)}`;
  const old = g(w.main, 'rev-parse', 'main');
  g(w.main, 'update-ref', ref, old);
  const r = await remove(w, a.path, { now, rand: () => 'beef' });
  assert.equal(r.backupFailed, true);
  assert.equal(g(w.main, 'rev-parse', ref), old);
  noBackups(w);
});

test('a ref that can not be dropped on abort: the backup dir stays with a minimal info.json, the reason says so, and the sweep deletes ref + dir later', async () => {
  const w = world();
  const a = w.det('stuck', 1);
  const base = deps(w);
  const d = { ...base, exec: async (c, args, o) => {
    if (c === 'git' && args.includes('read-tree')) throw new Error('verify boom');
    if (c === 'git' && args.includes('update-ref') && args.includes('-d')) throw new Error('cannot lock');
    return base.exec(c, args, o);
  } };
  const r = await remove(w, a.path, { deps: d });
  assert.equal(r.backupFailed, true);
  assert.match(r.reason, /không gỡ được ref refs\/teleport-backup\/.*: cannot lock — sẽ dọn sau 7 ngày/);
  assert.ok(fs.existsSync(a.path));
  const [name] = fs.readdirSync(w.backups);
  const infoF = path.join(w.backups, name, 'info.json');
  const info = JSON.parse(fs.readFileSync(infoF, 'utf8'));
  assert.deepEqual({ v: info.v, complete: info.complete, aborted: info.aborted, head: info.head, files: info.files }, { v: 1, complete: true, aborted: true, head: a.head, files: [] });
  assert.equal(g(w.main, 'rev-parse', info.keepRef), a.head);
  fs.writeFileSync(infoF, JSON.stringify({ ...info, createdAt: Date.now() - 8 * 24 * 3600_000 }));
  const p = pruneBackups({ dir: w.backups, parentDir: w.parent });
  assert.deepEqual(p.removed, [name]);
  assert.equal(refs(w), '');
  noBackups(w);
});

test('pruneBackups: malformed types (head as an array, keepRef as a number) → odd, dir and ref kept', async () => {
  const w = world();
  const a = w.det('types', 1);
  const res = await remove(w, a.path);
  const f = path.join(res.backupDir, 'info.json');
  const info = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const patch of [{ head: [a.head] }, { keepRef: 5 }, { commonDir: ['x'] }]) {
    fs.writeFileSync(f, JSON.stringify({ ...info, createdAt: Date.now() - 8 * 24 * 3600_000, ...patch }));
    const rr = pruneBackups({ dir: w.backups, parentDir: w.parent });
    assert.deepEqual(rr.odd, [path.basename(res.backupDir)]);
    assert.ok(fs.existsSync(res.backupDir));
    assert.equal(g(w.main, 'rev-parse', res.keepRef), a.head);
  }
});
