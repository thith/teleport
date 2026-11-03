// cleanup-manual.mjs — RFC 30: remove ONE worktree by the owner's hand, with a backup first.
//
// Runs inside cleanup-child.mjs, under the machine lock `cleanup` (the daemon takes it). Three commands:
//   manual-probe   read-only: the "what will be lost" table data + a content fingerprint (§2.2)
//   manual-remove  re-probe → back up what would be lost → verify the backup → probe again → remove (§2.3)
//   manual-list    the worktrees the daily run keeps (cheap judge), for `/cleanup` (§2.6)
//
// The probe is its OWN function (not judgeWorktree, which stops at the first reason): every hard block of §2.4
// is checked independently. Only the worktree is removed — the branch is never touched.
// Every git call here is `--no-optional-locks`, so `git status` can't rewrite the index and shift the fingerprint.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import {
  defaultDeps, locateWorktree, listLinkedWorktrees, judgeWorktree, parseWorktreePorcelain, hiddenEdits, isBuildPath, looksLikeRepo,
  procsInside, duBytes, fmtGB, WALK_MAX_ENTRIES, MANUAL_BACKUP_DIR, TRANSCRIPT_WINDOW_MS,
} from './cleanup.mjs';
import { acquireLock } from './machine-lock.mjs';
import { PARENT_DIR } from './workspace.mjs';

export const MANUAL_MAX_BYTES = 2 * 2 ** 30;   // more to back up than this → no ✅
export const MANUAL_MAX_FILES = 20_000;
const DIFF_FLAGS = ['--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const firstLine = (e) => String(e?.message || e).split('\n')[0].slice(0, 160);

// ── helpers ──────────────────────────────────────────────────────────────────

/** `git --no-optional-locks -C <cwd> …` through the injectable exec. */
const gitIn = (deps, cwd, args, opts) => deps.exec('git', ['--no-optional-locks', '-C', cwd, ...args], opts);

/** Run git and stream stdout through a hash (and into a file). → { sha256, bytes }. Rejects when over maxBytes. */
function streamGit(cwd, args, { env = process.env, toFile = null, maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0, err = '', over = false;
    const out = toFile ? fs.createWriteStream(toFile, { mode: 0o600 }) : null;
    const child = spawn('git', ['--no-optional-locks', '-C', cwd, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    child.stdout.on('data', (d) => {
      hash.update(d); bytes += d.length;
      if (bytes > maxBytes) { over = true; child.kill(); return; }
      if (out) out.write(d);
    });
    child.on('error', (e) => { out?.destroy(); reject(e); });
    child.on('close', (code) => {
      const done = () => {
        if (over) return reject(Object.assign(new Error('diff quá lớn'), { tooBig: true }));
        if (code !== 0) return reject(new Error(`git ${args[0]} lỗi: ${err.trim().split('\n')[0]}`));
        resolve({ sha256: hash.digest('hex'), bytes });
      };
      if (out) out.end(done); else done();
    });
  });
}

/** sha256 of a file's bytes, read in chunks (null if it doesn't exist). */
function hashFile(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const h = crypto.createHash('sha256'), buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
    return h.digest('hex');
  } finally { fs.closeSync(fd); }
}

const badName = (rel) => !rel || path.isAbsolute(rel) || rel.split('/').includes('..') || rel.includes('�') || rel.includes('\0');

/** `git status --porcelain=v1 -z …` → { tracked: [{ xy, p }], untracked, ignored }. */
export function parseStatusEntries(out) {
  const toks = String(out).split('\0');
  const tracked = [], untracked = [], ignored = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const xy = t.slice(0, 2), p = t.slice(3);
    if (xy === '??') untracked.push(p);
    else if (xy === '!!') ignored.push(p);
    else { tracked.push({ xy, p }); if (xy[0] === 'R' || xy[0] === 'C') i++; }
  }
  return { tracked, untracked, ignored };
}

/** Workspace repos (direct children with a `.git` directory) → Set of realpaths of their `.git`. */
function managedCommonDirs(realParent) {
  const set = new Set();
  let ents = [];
  try { ents = fs.readdirSync(realParent, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    try { const g = path.join(realParent, e.name, '.git'); if (fs.lstatSync(g).isDirectory()) set.add(fs.realpathSync(g)); } catch {}
  }
  return set;
}

/** A git repo anywhere inside `root` (a `.git` dir OR file, or a bare repo), even in tmp/ or build dirs. Bounded, never follows symlinks. */
export function findNestedRepo(root, { maxEntries = WALK_MAX_ENTRIES } = {}) {
  const stack = [{ dir: root, top: null }];
  let seen = 0;
  while (stack.length) {
    const { dir, top } = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { error: `không đọc được ${path.relative(root, dir) || '.'}: ${e.code || e.message}` }; }
    if (dir !== root && looksLikeRepo(ents)) return { found: path.relative(root, dir) };
    for (const e of ents) {
      if (++seen > maxEntries) return { truncated: top || e.name };
      if (dir === root && e.name === '.git') continue; // the worktree's own gitfile
      if (e.name.includes('�')) return { error: `tên không phải UTF-8 trong ${path.relative(root, dir) || '.'}` };
      if (e.isDirectory()) stack.push({ dir: path.join(dir, e.name), top: top || e.name });
    }
  }
  return {};
}

// ── the hard blocks (§2.4) ───────────────────────────────────────────────────

/**
 * Every §2.4 block that applies to `L` (from locateWorktree), each checked on its own → [string]. `nested: false`
 * skips the (slow) nested-repo walk — the `/cleanup` list and the refusal DM only need the cheap ones.
 */
export async function hardBlocks(L, deps, { realParent, nested = true, maxEntries = WALK_MAX_ENTRIES, trackedPaths = null } = {}) {
  const { wt, real } = L;
  const blocks = [];
  const attempt = async (fn) => { try { await fn(); } catch (e) { blocks.push(`lỗi probe: ${firstLine(e)}`); } };
  if (wt.locked) blocks.push('bị khoá (git worktree lock)');
  if (wt.detached || !wt.branch || !wt.branch.startsWith('refs/heads/')) blocks.push('detached HEAD (commit có thể không nằm trên nhánh nào)');
  await attempt(async () => {
    const procs = procsInside(deps, real);
    if (procs.length) {
      const comm = (pid) => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return '?'; } };
      blocks.push(`có tiến trình đang ở trong worktree: ${procs.slice(0, 5).map((p) => `pid ${p.pid} (${(deps.procComm || comm)(p.pid)})`).join(', ')}${procs.length > 5 ? ', …' : ''} — tắt tiến trình rồi gửi lại`);
    }
  });
  await attempt(async () => {
    const hidden = hiddenEdits(await gitIn(deps, real, ['ls-files', '-v', '-z']));
    if (hidden.length) blocks.push(`có file skip-worktree/assume-unchanged (${hidden.slice(0, 3).join(', ')}${hidden.length > 3 ? ', …' : ''})`);
  });
  await attempt(async () => {
    const unmerged = String(await gitIn(deps, real, ['ls-files', '-u', '-z'])).split('\0').filter(Boolean);
    const gitDir = path.resolve(real, String(await gitIn(deps, real, ['rev-parse', '--git-dir'])).trim());
    const midOp = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].filter((n) => fs.existsSync(path.join(gitDir, n)));
    if (unmerged.length || midOp.length) blocks.push(`đang có xung đột hoặc giữa merge/rebase/cherry-pick${midOp.length ? ` (${midOp.join(', ')})` : ''}`);
  });
  await attempt(async () => {
    const gitlinks = String(await gitIn(deps, real, ['ls-files', '-s', '-z'])).split('\0').filter((l) => l.startsWith('160000 '));
    if (gitlinks.length) blocks.push(`có submodule/gitlink (${gitlinks.slice(0, 3).map((l) => l.split('\t').slice(1).join('\t')).join(', ')}${gitlinks.length > 3 ? ', …' : ''}) — patch không khôi phục được nội dung submodule`);
  });
  if (trackedPaths?.length) {
    await attempt(async () => {
      const names = new Set();
      for (let i = 0; i < trackedPaths.length; i += 200) {
        const toks = String(await gitIn(deps, real, ['check-attr', '-z', 'filter', '--', ...trackedPaths.slice(i, i + 200)])).split('\0');
        // `set` / `unset` / `unspecified` can also be literal driver names (`filter=set`): look every value up as a driver, fail closed.
        for (let j = 0; j + 2 < toks.length; j += 3) { const v = toks[j + 2]; if (v) names.add(v); }
      }
      for (const n of names) {
        for (const kind of ['clean', 'process']) {
          let val = '';
          try { val = String(await gitIn(deps, real, ['config', '--get', `filter.${n}.${kind}`])).trim(); } catch (e) { if (e?.code !== 1) val = '?'; } // exit 1 = not configured; any other failure = unknown → block
          if (val) { blocks.push(`file đã track đổi mà dùng filter "${n}" (${kind}) — patch có thể thiếu nội dung thật`); return; }
        }
      }
    });
  }
  if (nested) {
    await attempt(async () => {
      const r = findNestedRepo(real, { maxEntries });
      if (r.found) blocks.push(`có repo git lồng bên trong (${r.found}) — có thể chứa commit chưa push`);
      else if (r.truncated) blocks.push(`không kiểm hết ${r.truncated}/ (quá ${maxEntries} mục) — dọn file build (vd cargo clean) rồi thử lại`);
      else if (r.error) blocks.push(`lỗi probe: ${r.error}`);
    });
  }
  return blocks;
}

// ── the probe (§2.2) ─────────────────────────────────────────────────────────

/** Locate the worktree for `target` AND require it to be a linked worktree of a managed repo. → { L } | { reason } */
export async function locateManaged(target, { deps, realParent }) {
  const loc = await locateWorktree(target, { deps, realParent });
  if (!loc.L) return { reason: loc.reason };
  let common;
  try { common = fs.realpathSync(path.join(loc.L.main, '.git')); } catch { return { reason: 'không đọc được git-common-dir' }; }
  if (!managedCommonDirs(realParent).has(common)) return { reason: 'repo không thuộc tập repo daemon quản lý' };
  return { L: loc.L, commonDir: common };
}

/**
 * Probe one worktree, read-only. → { ok:true, … table data + fingerprint + files … }
 *   | { ok:false, hard:true, reason, path }   a §2.4 block (or a probe error)
 *   | { ok:false, limit:true, reason, path }  too much to back up
 * `quick`: the blocks only, no file inventory (is a button worth offering at all?).
 */
export async function probeManual(target, {
  parentDir = PARENT_DIR, deps: injected = {}, quick = false, fast = false, maxEntries = WALK_MAX_ENTRIES, maxBytes = MANUAL_MAX_BYTES, maxFiles = MANUAL_MAX_FILES,
} = {}) {
  const deps = { ...defaultDeps(), ...injected };
  let shown = target;
  try {
    const realParent = fs.realpathSync(parentDir);
    const loc = await locateManaged(target, { deps, realParent });
    if (!loc.L) return { ok: false, hard: true, path: shown, reason: loc.reason };
    const { L, commonDir } = loc;
    const { wt, real } = L;
    shown = wt.path;
    const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : null;
    const git = (args, opts) => gitIn(deps, real, args, opts);

    const headNow = String(await git(['rev-parse', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(headNow)) return { ok: false, hard: true, path: shown, reason: 'lỗi probe: không đọc được HEAD' };
    const statusV1 = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames']);
    const st = parseStatusEntries(statusV1);
    const trackedPaths = [...new Set(st.tracked.map((t) => t.p))];
    if (trackedPaths.length > maxFiles) return { ok: false, limit: true, path: shown, reason: `phần cần sao lưu quá lớn (${trackedPaths.length} file đã track bị sửa) — xử lý tay` };
    const blocks = await hardBlocks(L, deps, { realParent, nested: true, maxEntries, trackedPaths });
    if (headNow !== wt.head) blocks.push('HEAD vừa đổi');
    if (blocks.length) return { ok: false, hard: true, path: shown, reason: blocks.join('; '), blocks };
    if (quick) return { ok: true, quick: true, path: shown, head: headNow, branch, commonDir };

    // ── the inventory: what a removal would lose ──
    const skipped = st.ignored.filter(isBuildPath);
    const entries = [...st.untracked, ...st.ignored.filter((p) => !isBuildPath(p))];
    const files = [];
    let bytes = 0;
    const tooBig = (why) => ({ ok: false, limit: true, path: shown, reason: `phần cần sao lưu quá lớn (${why}) — xử lý tay` });
    const addFile = (rel) => {
      if (badName(rel)) throw new Error(`đường dẫn lạ: ${JSON.stringify(rel).slice(0, 80)}`);
      const abs = path.join(real, rel);
      const s = fs.lstatSync(abs);
      let rec;
      if (s.isSymbolicLink()) {
        const target2 = fs.readlinkSync(abs, { encoding: 'buffer' });
        if (target2.toString('utf8').includes('�')) throw new Error(`đích symlink không phải UTF-8: ${rel}`);
        rec = { path: rel, type: 'symlink', mode: s.mode & 0o777, size: target2.length, sha256: sha(target2) };
      } else if (s.isFile()) {
        const h = hashFile(abs);
        if (h == null) throw new Error(`file biến mất: ${rel}`);
        rec = { path: rel, type: 'file', mode: s.mode & 0o777, size: s.size, sha256: h };
      } else throw new Error(`loại file lạ (socket/fifo/device): ${rel}`);
      files.push(rec);
      bytes += rec.size;
      if (bytes > maxBytes) throw Object.assign(new Error('big'), { big: fmtGB(bytes) });
      // patch-backed (tracked) and tar-backed paths are disjoint (checked below): the union is their sum
      if (files.length + trackedPaths.length > maxFiles) throw Object.assign(new Error('many'), { big: `${files.length + trackedPaths.length}+ file` });
    };
    const display = [];
    try {
      for (const e of entries) {
        if (e.endsWith('/')) { // an ignored / untracked DIRECTORY: every file under it, symlinks not followed
          const before = files.length;
          const stack = [e.replace(/\/+$/, '')];
          while (stack.length) {
            const rel = stack.pop();
            if (badName(rel)) throw new Error(`đường dẫn lạ: ${JSON.stringify(rel).slice(0, 80)}`);
            const ents = fs.readdirSync(path.join(real, rel), { withFileTypes: true });
            for (const d of ents) {
              const child = `${rel}/${d.name}`;
              if (d.isDirectory()) stack.push(child); else addFile(child);
            }
          }
          display.push({ name: e, files: files.length - before });
        } else { addFile(e); display.push({ name: e }); }
      }
    } catch (err) {
      if (err.big) return tooBig(err.big);
      return { ok: false, hard: true, path: shown, reason: `lỗi probe: ${firstLine(err)}` };
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // patches: hashed (and sized) now; written at backup time
    const patchIn = {};
    let patchBytes = 0;
    for (const [name, extra] of [['staged', ['--cached']], ['unstaged', []]]) {
      try {
        patchIn[name] = await streamGit(real, ['diff', ...extra, ...DIFF_FLAGS], { maxBytes: maxBytes - bytes - patchBytes });
        patchBytes += patchIn[name].bytes;
      } catch (e) { if (e.tooBig) return tooBig('patch'); throw e; }
    }
    const tarPaths = new Set(files.map((f) => f.path));
    const dup = trackedPaths.find((p) => tarPaths.has(p));
    if (dup) return { ok: false, hard: true, path: shown, reason: `lỗi probe: ${dup} nằm ở cả patch lẫn tar` };

    // the fingerprint (§2.2) — plus the two patch hashes: a tracked file edited again has the same `status`
    const gitDir = path.resolve(real, String(await git(['rev-parse', '--git-dir'])).trim());
    const statusV2 = await git(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames']);
    const fp = crypto.createHash('sha256');
    fp.update(JSON.stringify([headNow, branch, hashFile(path.join(gitDir, 'index')), sha(statusV2), patchIn.staged.sha256, patchIn.unstaged.sha256]));
    for (const f of files) fp.update(`\n${JSON.stringify([f.path, f.type, f.mode, f.sha256])}`);
    const fingerprint = fp.digest('hex');

    // `fast` (the late re-probe right before the removal): only the volatile safety facts above — no PR query, no du, no table extras
    if (fast) return { ok: true, fast: true, path: shown, real, main: L.main, repo: L.repo, commonDir, branch, head: headNow, files, patches: patchIn, fingerprint };

    // table extras: upstream / unpushed, PR, sizes of the skipped build dirs (best effort)
    let upstream = null, aheadCommits = 0;
    try {
      upstream = String(await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim() || null;
      aheadCommits = Number(String(await git(['rev-list', '--count', '@{u}..HEAD'])).trim()) || 0;
    } catch {
      upstream = null;
      try { aheadCommits = Number(String(await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim()) || 0; } catch { aheadCommits = 0; }
    }
    let pr = null;
    if (L.slug && branch) {
      try {
        const prs = JSON.parse(await deps.exec('gh', ['pr', 'list', '-R', L.slug, '--head', branch, '--state', 'all', '--json', 'number,state,headRefName', '--limit', '20'], { timeout: 30_000 }));
        const mine = prs.filter((x) => x && x.headRefName === branch);
        const open = mine.find((x) => x.state === 'OPEN'), merged = mine.find((x) => x.state === 'MERGED');
        pr = open ? `PR #${open.number} đang mở` : merged ? `PR #${merged.number} đã merge` : 'PR: không có';
      } catch { pr = 'PR: không xác định'; }
    }
    const skippedInfo = [];
    for (const n of skipped.slice(0, 5)) skippedInfo.push({ name: n, bytes: await duBytes(deps, path.join(real, n)) });
    const staged = st.tracked.filter((t) => t.xy[0] !== ' ' && t.xy[0] !== '?').map((t) => t.p);

    return {
      ok: true, path: shown, real, main: L.main, repo: L.repo, commonDir, branch, head: headNow, upstream, aheadCommits, pr,
      tracked: { count: trackedPaths.length, staged: staged.length, names: trackedPaths.slice(0, 6) },
      entries: display.slice(0, 6), entryCount: display.length, skipped: skippedInfo, skippedMore: Math.max(0, skipped.length - 5),
      fileCount: files.length, bytes: bytes + patchBytes, files, patches: patchIn, fingerprint,
    };
  } catch (e) {
    return { ok: false, hard: true, path: shown, reason: `lỗi probe: ${firstLine(e)}` };
  }
}

/** The probe without the (big) file list — what crosses the child's stdout. */
const slim = (p) => { if (!p?.files) return p; const { files, real, patches, ...rest } = p; return rest; };

// ── tar reader (verifies the backup without parsing `tar t` output) ─────────

/**
 * Read a .tgz → [{ path, type: 'file'|'symlink'|'other:<t>', mode, size, sha256 }]. Hand-rolled ustar/pax/GNU-long-name
 * header reader; a symlink's sha256 / size are those of its target path.
 */
export async function readTgz(file) {
  const out = [];
  let buf = Buffer.alloc(0);
  let cur = null, pad = 0, ended = false;
  let pax = {}, gnuName = null, gnuLink = null;
  const cstr = (b) => { const i = b.indexOf(0); return (i < 0 ? b : b.subarray(0, i)).toString('utf8'); };
  const oct = (b) => { const s = cstr(b).trim(); return s ? parseInt(s, 8) : 0; };
  const size = (b) => { if (b[0] & 0x80) { let n = 0; for (let i = 1; i < b.length; i++) n = n * 256 + b[i]; return n; } return oct(b); };
  const parsePax = (data) => {
    const r = {};
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(0x20, i);
      if (sp < 0) break;
      const len = parseInt(data.subarray(i, sp).toString('latin1'), 10);
      if (!(len > 0)) break;
      const rec = data.subarray(sp + 1, i + len - 1).toString('utf8'); // minus the trailing \n
      const eq = rec.indexOf('=');
      if (eq > 0) r[rec.slice(0, eq)] = rec.slice(eq + 1);
      i += len;
    }
    return r;
  };
  const gz = fs.createReadStream(file).pipe(zlib.createGunzip());
  for await (const chunk of gz) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (ended) { buf = Buffer.alloc(0); break; }
      if (!cur) {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((x) => x === 0)) { ended = true; continue; }
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
        if (sum !== oct(h.subarray(148, 156))) throw new Error('tar: checksum header sai');
        const t = String.fromCharCode(h[156] || 48);
        const name = cstr(h.subarray(0, 100));
        const prefix = h.toString('latin1', 257, 262) === 'ustar' ? cstr(h.subarray(345, 500)) : '';
        const isMeta = ['x', 'g', 'L', 'K'].includes(t);
        const sz = size(h.subarray(124, 136));
        cur = {
          t, path: gnuName ?? pax.path ?? (prefix ? `${prefix}/${name}` : name), link: gnuLink ?? pax.linkpath ?? cstr(h.subarray(157, 257)),
          mode: oct(h.subarray(100, 108)) & 0o777, size: !isMeta && pax.size != null ? Number(pax.size) : sz, left: 0, hash: crypto.createHash('sha256'), meta: [],
        };
        cur.left = cur.size;
        pad = (512 - (cur.size % 512)) % 512;
        if (!isMeta) { pax = {}; gnuName = gnuLink = null; } // (cur already carries the overrides)
      }
      if (cur.left > 0) {
        if (!buf.length) break;
        const take = Math.min(cur.left, buf.length);
        const part = buf.subarray(0, take);
        if (['x', 'g', 'L', 'K'].includes(cur.t)) cur.meta.push(part); else cur.hash.update(part);
        cur.left -= take;
        buf = buf.subarray(take);
        if (cur.left > 0) break;
      }
      if (pad) { if (buf.length < pad) break; buf = buf.subarray(pad); pad = 0; }
      // entry complete
      if (cur.t === 'x') pax = { ...pax, ...parsePax(Buffer.concat(cur.meta)) };
      else if (cur.t === 'L') gnuName = cstr(Buffer.concat(cur.meta));
      else if (cur.t === 'K') gnuLink = cstr(Buffer.concat(cur.meta));
      else if (cur.t === 'g') { /* global header: nothing we use */ }
      else if (cur.t === '0') out.push({ path: cur.path, type: 'file', mode: cur.mode, size: cur.size, sha256: cur.hash.digest('hex') });
      else if (cur.t === '2') { const lb = Buffer.from(cur.link, 'utf8'); out.push({ path: cur.path, type: 'symlink', mode: cur.mode, size: lb.length, sha256: sha(lb) }); }
      else out.push({ path: cur.path, type: `other:${cur.t}`, mode: cur.mode, size: cur.size, sha256: null });
      cur = null;
    }
  }
  return out;
}

// ── backup (§2.3 step 2) ─────────────────────────────────────────────────────

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const safeName = (s, max = 60) => String(s ?? 'x').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, max) || 'x';

/** The restore script: re-create the worktree, then re-apply staged / unstaged / untracked. Every argument shell-quoted. Pure. */
export function buildRestoreScript({ main, wtPath, branch, head, hasStaged, hasUnstaged, hasTar }) {
  const steps = [];
  if (hasStaged) steps.push(`git -C ${shq(wtPath)} apply --index "$D/staged.patch"`);
  if (hasUnstaged) steps.push(`git -C ${shq(wtPath)} apply "$D/unstaged.patch"`);
  if (hasTar) steps.push(`tar -xzpf "$D/untracked.tgz" -C ${shq(wtPath)}`);
  const L = [
    '#!/bin/bash',
    '# Khôi phục worktree đã xoá tay (RFC 30). Chạy: bash restore.sh',
    'D="$(cd "$(dirname "$0")" && pwd)"',
    'fail() { echo "lỗi ở bước: $1" >&2; shift; echo "làm tiếp tay các bước còn lại:" >&2; for c in "$@"; do echo "  $c" >&2; done; exit 1; }',
    `MAIN=${shq(main)}`, `BR=${shq(branch)}`, `HEAD_SHA=${shq(head)}`,
    `if [ "$(git -C "$MAIN" rev-parse --verify -q "refs/heads/$BR")" = "$HEAD_SHA" ] && ! git -C "$MAIN" worktree list --porcelain | grep -qxF "branch refs/heads/$BR"; then`,
    `  git -C "$MAIN" worktree add ${shq(wtPath)} "$BR" || fail 'git worktree add' ${steps.map(shq).join(' ')}`,
    'else',
    '  echo "nhánh $BR đã đổi — đang ở đúng commit cũ (detached)"',
    `  git -C "$MAIN" worktree add --detach ${shq(wtPath)} "$HEAD_SHA" || fail 'git worktree add --detach' ${steps.map(shq).join(' ')}`,
    'fi',
  ];
  steps.forEach((s, i) => L.push(`${s} || fail ${shq(s)} ${steps.slice(i + 1).map(shq).join(' ')}`.trimEnd()));
  L.push('echo "đã khôi phục"', '');
  return L.join('\n');
}

/**
 * Write the backup for probe `p` → its directory. Throws on any error (the caller deletes the directory).
 * `info.json` is written LAST: no `info.json` = an unfinished backup.
 */
export async function writeBackup(p, { root = MANUAL_BACKUP_DIR, now = Date.now(), rand = () => crypto.randomBytes(2).toString('hex') } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, `${safeName(p.repo)}-${safeName(p.branch, 80)}-${stamp(now)}-${rand()}`);
  if (path.dirname(path.resolve(dir)) !== path.resolve(root)) throw new Error('thư mục sao lưu không nằm ngay dưới thư mục gốc');
  fs.mkdirSync(dir, { mode: 0o700 }); // not recursive: EEXIST is an error
  const made = { dir };
  try {
    const staged = path.join(dir, 'staged.patch'), unstaged = path.join(dir, 'unstaged.patch');
    // The patches written must be byte-for-byte the ones the owner confirmed (a file A→B→A during the backup would pass the late fingerprint otherwise).
    for (const [name, file, args] of [['staged', staged, ['--cached']], ['unstaged', unstaged, []]]) {
      const w = await streamGit(p.real, ['diff', ...args, ...DIFF_FLAGS], { toFile: file });
      const want = p.patches?.[name];
      if (!want || w.sha256 !== want.sha256 || w.bytes !== want.bytes) throw new Error(`${name}.patch khác bản đã xác nhận (worktree đổi trong lúc sao lưu)`);
      if (w.bytes === 0) fs.unlinkSync(file);
    }
    const hasTar = p.files.length > 0;
    if (hasTar) {
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['--null', '--verbatim-files-from', '--no-recursion', '--force-local', '--hard-dereference', '--format=posix',
          '--pax-option=delete=atime,delete=ctime', '-C', p.real, '-T', '-', '-czf', path.join(dir, 'untracked.tgz')], { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar lỗi (${code}): ${err.trim().split('\n')[0]}`))));
        child.stdin.on('error', () => {});
        child.stdin.end(`${p.files.map((f) => f.path).join('\0')}\0`);
      });
    }
    fs.writeFileSync(path.join(dir, 'restore.sh'), buildRestoreScript({
      main: p.main, wtPath: p.path, branch: p.branch, head: p.head, hasStaged: fs.existsSync(staged), hasUnstaged: fs.existsSync(unstaged), hasTar,
    }), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({
      v: 1, complete: true, path: p.path, commonDir: p.commonDir, branch: p.branch, head: p.head, upstream: p.upstream, aheadCommits: p.aheadCommits,
      files: p.files, bytes: p.bytes, createdAt: now,
    }), { mode: 0o600 });
    return made.dir;
  } catch (e) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} throw e; }
}

/** §2.3 step 3: the tar has exactly the planned files; the patches exist iff there is a diff and apply cleanly to a scratch index. Throws. */
export async function verifyBackup(dir, p, deps) {
  const tgz = path.join(dir, 'untracked.tgz');
  if (p.files.length) {
    const got = (await readTgz(tgz)).sort((a, b) => (a.path < b.path ? -1 : 1));
    if (got.length !== p.files.length) throw new Error(`tar có ${got.length} mục, cần ${p.files.length}`);
    p.files.forEach((f, i) => {
      const g = got[i];
      if (g.path !== f.path || g.type !== f.type || g.mode !== f.mode || g.size !== f.size || g.sha256 !== f.sha256) throw new Error(`tar không khớp ở ${JSON.stringify(f.path).slice(0, 100)}`);
    });
  } else if (fs.existsSync(tgz)) throw new Error('tar không nên tồn tại');
  const tmp = fs.mkdtempSync(path.join(dir, '.verify-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    const run = (args) => deps.exec('git', ['--no-optional-locks', '-C', p.real, ...args], { env });
    const real = (args) => deps.exec('git', ['--no-optional-locks', '-C', p.real, ...args]); // the real index: does a diff exist?
    await run(['read-tree', p.head]);
    for (const [name, cachedFlag] of [['staged', '--cached'], ['unstaged', null]]) {
      const f = path.join(dir, `${name}.patch`);
      const hasDiff = await real(['diff', ...(cachedFlag ? [cachedFlag] : []), '--quiet', ...DIFF_FLAGS]).then(() => false, (e) => { if (e.code === 1) return true; throw e; });
      if (hasDiff !== fs.existsSync(f)) throw new Error(`${name}.patch ${hasDiff ? 'thiếu' : 'thừa'}`);
    }
    for (const name of ['staged', 'unstaged']) {
      const f = path.join(dir, `${name}.patch`);
      if (!fs.existsSync(f)) continue;
      await run(['apply', '--cached', '--check', f]);
      await run(['apply', '--cached', f]);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── remove (§2.3) ────────────────────────────────────────────────────────────

export const REMOVING_MARKER = 'removing.json';
/** The backup dir (under `root`) whose removal of `wtPath` — THIS press (`runId`) — started but never reported → its path, or null. */
export function findRemovingBackup(root, wtPath, runId) {
  if (!runId) return null;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try { const m = JSON.parse(fs.readFileSync(path.join(root, e.name, REMOVING_MARKER), 'utf8')); if (m?.path === wtPath && m.runId === runId) return path.join(root, e.name); } catch {}
    }
  } catch {}
  return null;
}
/** Delete every removing.json under `root` that names `wtPath` (stale markers of older crashed runs). */
function clearMarkers(root, wtPath) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const f = path.join(root, e.name, REMOVING_MARKER);
    try { if (JSON.parse(fs.readFileSync(f, 'utf8'))?.path === wtPath) fs.rmSync(f, { force: true }); } catch {}
  }
}

const rmDir = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

/**
 * Probe again → fingerprint must equal `expectFingerprint` → back up → verify → probe once more → remove the worktree
 * (never the branch). Never throws. A changed fingerprint returns { changed: true, probe, note } and removes nothing.
 */
export async function manualRemove(target, { expectFingerprint, backupDir = MANUAL_BACKUP_DIR, now = Date.now(), rand, hooks = {}, runId = null, ...probeOpts } = {}) {
  const deps = { ...defaultDeps(), ...(probeOpts.deps || {}) };
  const p1 = await probeManual(target, { ...probeOpts, deps });
  if (!p1.ok) return slim(p1);
  if (!expectFingerprint || p1.fingerprint !== expectFingerprint) return { ok: false, changed: true, path: p1.path, probe: slim(p1), note: '⚠️ worktree đã thay đổi — xem lại' };
  let dir = null;
  try {
    if (hooks.beforeBackup) await hooks.beforeBackup();
    dir = await writeBackup(p1, { root: backupDir, now, ...(rand ? { rand } : {}) });
    await verifyBackup(dir, p1, deps);
    if (hooks.afterBackup) await hooks.afterBackup();
    // the late probe: fast (no gh / du), immediately before the removal
    const p2 = await probeManual(target, { ...probeOpts, deps, fast: true });
    if (!p2.ok) { rmDir(dir); return slim(p2); }
    if (p2.fingerprint !== p1.fingerprint) {
      rmDir(dir); dir = null;
      // the fast probe has no inventory: the table the owner sees again must come from a FULL probe
      const full = await probeManual(target, { ...probeOpts, deps });
      if (!full.ok) return slim(full);
      return { ok: false, changed: true, path: full.path, probe: slim(full), note: '⚠️ worktree đã thay đổi trong lúc sao lưu' };
    }
  } catch (e) {
    if (dir) rmDir(dir);
    return { ok: false, path: p1.path, backupFailed: true, reason: `sao lưu lỗi, chưa xoá gì: ${firstLine(e)}` };
  }
  // If this process is killed mid-removal, this marker tells the daemon which backup belongs to the half-removed tree.
  const marker = path.join(dir, REMOVING_MARKER);
  try {
    clearMarkers(backupDir, p1.path); // older crashed runs for the same path
    (hooks.writeMarker ?? ((f, body) => fs.writeFileSync(f, body, { mode: 0o600 })))(marker, JSON.stringify({ path: p1.path, runId, at: Date.now() }));
  } catch (e) { // without the marker a kill mid-removal could not be explained: do not start
    try { fs.rmSync(marker, { force: true }); } catch {}
    return { ok: false, notStarted: true, path: p1.path, backupDir: dir, reason: `không ghi được dấu hiệu xoá (${firstLine(e)}) — chưa xoá gì` };
  }
  try {
    await deps.exec('git', ['-C', p1.main, 'worktree', 'remove', '--force', p1.path]);
    try { await deps.exec('git', ['-C', p1.main, 'worktree', 'prune']); } catch {}
  } catch (e) { try { fs.rmSync(marker, { force: true }); } catch {} return { ok: false, removeFailed: true, path: p1.path, backupDir: dir, reason: `git worktree remove lỗi: ${firstLine(e)}` }; }
  try { fs.rmSync(marker, { force: true }); } catch {}
  deps.log(`removed ${p1.path} (manual, backup ${dir})`);
  return { ok: true, path: p1.path, branch: p1.branch, backupDir: dir, bytes: p1.bytes };
}

// ── target resolution + list (§2.6) ──────────────────────────────────────────

/**
 * `/cleanup <path | branch>` → { path } | { reason } | { ambiguous: [path] }. A branch is looked up in EVERY managed repo
 * (not via the daemon's cwd). Does not use cleanup-request's resolveTarget.
 */
export async function resolveManualTarget(text, { parentDir = PARENT_DIR, deps: injected = {} } = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const t = String(text || '').trim();
  if (!t) return { reason: 'thiếu đường dẫn hoặc tên nhánh' };
  if (path.isAbsolute(t)) return { path: t };
  const linked = await listLinkedWorktrees(parentDir, deps);
  const hits = linked.filter((L) => L.wt.branch === `refs/heads/${t}`);
  if (!hits.length) return { reason: `không thấy nhánh "${t}" trong worktree nào của các repo được quản lý` };
  if (hits.length > 1) return { ambiguous: hits.map((L) => L.wt.path) };
  return { path: hits[0].wt.path };
}

/** The worktrees the daily run KEEPS, each with its reason and whether §2.4 (cheap checks) forbids a manual removal. */
export async function listKept({ parentDir = PARENT_DIR, deps: injected = {}, now = Date.now() } = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const realParent = fs.realpathSync(parentDir);
  const errors = [];
  const linked = await listLinkedWorktrees(parentDir, deps, errors);
  // RFC 30 §2.6: one light judge per worktree — no transcript scan (an empty set), no du, no target/ scan.
  const rows = [];
  for (const L of linked) {
    let v;
    try { v = await judgeWorktree(L, { deps, realParent, now, transcriptCwds: [] }); } catch (e) { v = { ok: false, reason: `lỗi: ${firstLine(e)}` }; }
    // Passed every cheap gate: the daily run removes it unless a Claude session used it in the last 7 days — which is not scanned here.
    if (v.ok) v = { ok: false, reason: 'qua mọi điều kiện dọn tự động; còn đây có thể vì phiên Claude dùng trong 7 ngày (không quét transcript ở đây)' };
    let blocked = null;
    try {
      const loc = await locateManaged(L.wt.path, { deps, realParent });
      if (!loc.L) blocked = loc.reason;
      else {
        const st = parseStatusEntries(await gitIn(deps, loc.L.real, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames']));
        // the cheap hard blocks incl. the filter check; the nested-repo walk waits for the press (which re-probes in full)
        const b = await hardBlocks(loc.L, deps, { realParent, nested: false, trackedPaths: [...new Set(st.tracked.map((t) => t.p))] });
        if (b.length) blocked = b.join('; ');
      }
    } catch (e) { blocked = `lỗi probe: ${firstLine(e)}`; }
    rows.push({ repo: L.repo, name: path.basename(L.wt.path), path: L.wt.path, branch: L.wt.branch ? L.wt.branch.replace(/^refs\/heads\//, '') : null, head: L.wt.head, reason: v.reason, blocked });
  }
  return { ok: true, rows, errors: errors.slice(0, 5) };
}

// ── the child's entry point (also called in-process by tests) ────────────────

/** cleanup-child.mjs `{ cmd, target, opts }` → one result object. Never throws. */
export async function manualCommand(cmd, target, opts = {}) {
  try {
    if (cmd === 'manual-list') return await listKept(opts);
    let t = target;
    if (opts.resolve) {
      const r = await resolveManualTarget(target, opts);
      if (r.ambiguous) return { ok: false, ambiguous: r.ambiguous, reason: 'nhánh có ở nhiều repo — gõ đường dẫn' };
      if (!r.path) return { ok: false, hard: true, path: target, reason: r.reason };
      t = r.path;
    }
    if (cmd === 'manual-probe') return slim(await probeManual(t, opts));
    if (cmd === 'manual-remove') {
      // The destructive worker holds the `cleanup` lock ITSELF for the whole operation: if the daemon dies, a new daemon can't take it under us.
      const { lock: lk, acquire = acquireLock, ...rest } = opts;
      if (!lk) return await manualRemove(t, rest);
      let lock;
      try { lock = await acquire('cleanup', { waitSec: lk.waitSec, dir: lk.dir, label: lk.label, convoId: null, cmd: lk.cmd }); } catch (e) { lock = { error: e }; }
      if (lock.left || lock.timeout || lock.error) return { ok: false, busy: true, path: t, reason: 'đợt dọn khác đang giữ lock cleanup' };
      try { return await manualRemove(t, rest); } finally { lock.release(); }
    }
    return { ok: false, path: target, reason: `lệnh lạ: ${cmd}` };
  } catch (e) { return { ok: false, path: target, reason: `lỗi: ${firstLine(e)}` }; }
}
