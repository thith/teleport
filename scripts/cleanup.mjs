// RFC 18 §E (v2 §9 "E" + "C"): daily cleanup of finished worktrees and
// abandoned cargo `target/` dirs. THIS DELETES DATA, so every rule below is a
// KEEP-unless-proven-safe rule, and any error for a worktree means KEEP.
//
//   E1  remove a LINKED worktree (never a main checkout) when ALL hold:
//       inside the workspace · not locked · on a branch (not detached) ·
//       a MERGED PR on exactly that branch whose headRefOid === HEAD, and no
//       OPEN PR on it · no tracked change · untracked/ignored entries only under
//       build dirs (target/, node_modules/, …) · no process cwd inside · no
//       non-build file modified in 24h · not the cwd of a Claude transcript
//       touched in 7 days. Then `git worktree remove --force` (single --force:
//       git refuses a locked tree). The branch is kept. At most 30 per run.
//   E2  for linked worktrees that stay: `rm -rf` each `target/` that sits next
//       to a Cargo.toml, has no file modified in 3 days, while no process has
//       its cwd in the worktree. Plus the shared cache (§C)
//       `~/.cache/teleport/cargo-target/*`: subdirs untouched for 14 days, only
//       while the `build` machine lock is free (held during the prune).
//
// CLI: node scripts/cleanup.mjs [--dry-run] [--report-to-owner]
// Runs under the machine lock `cleanup` (busy → "already running", exit 0).
// The daemon launches it detached (see cleanup-launch.mjs); it never runs
// inside the daemon's poll loop.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { recordDryRunReported, CLEANUP_STATE_FILE } from './cleanup-launch.mjs';
import { isMainModule } from './is-direct-run.mjs';
import { acquireLock, LOCK_DIR } from './machine-lock.mjs';
import { PARENT_DIR } from './workspace.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BUILD_DIRS = new Set(['target', 'node_modules', 'build', '.gradle', '.kotlin', 'dist', '.idea', '__pycache__']);
export const MAX_REMOVALS = 30;
const HOUR = 3600_000, DAY = 24 * HOUR;
export const RECENT_EDIT_MS = DAY;
export const TRANSCRIPT_WINDOW_MS = 7 * DAY;
export const TARGET_IDLE_MS = 3 * DAY;
export const CACHE_IDLE_MS = 14 * DAY;
export const WALK_MAX_ENTRIES = 300_000;
export const CARGO_CACHE_DIR = path.join(os.homedir(), '.cache', 'teleport', 'cargo-target');
export const TRANSCRIPTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** `git worktree list --porcelain` → [{ path, head, branch, detached, locked, bare, prunable }]. First = main. */
export function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null, detached: false, locked: false, bare: false, prunable: false }; out.push(cur); continue; }
    if (!cur || !line) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim();
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return out;
}

/** GitHub `owner/repo` from a remote URL, or null for anything else. */
export function githubSlug(url) {
  const m = String(url || '').trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A status path is allowed when one of its DIRECTORY components is a build dir (`server/target/`, `app/build/x`). */
export function isBuildPath(p) {
  const segs = String(p).split('/');
  return segs.slice(0, -1).some((s) => BUILD_DIRS.has(s));
}

/** `git status --porcelain=v1 -z …` → { tracked, untracked, ignored } path lists. */
export function parseStatusZ(out) {
  const toks = String(out).split('\0');
  const tracked = [], untracked = [], ignored = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const xy = t.slice(0, 2), p = t.slice(3);
    if (xy === '??') untracked.push(p);
    else if (xy === '!!') ignored.push(p);
    else { tracked.push(p); if (xy[0] === 'R' || xy[0] === 'C') i++; } // rename/copy: next token = source path
  }
  return { tracked, untracked, ignored };
}

/**
 * Entries that are NOT disposable build output. An untracked-but-not-ignored
 * file is always stray, even under a build-named dir (tracked `build/ci.sh` +
 * new `build/new.sh`); only IGNORED entries may match the build allowlist.
 */
export function strayEntries({ untracked, ignored }) {
  return [...untracked, ...ignored.filter((p) => !isBuildPath(p))];
}

/** `git ls-files -v -z` → paths flagged skip-worktree (S/s) or assume-unchanged (lowercase tag): edits git status cannot see. */
export function hiddenEdits(out) {
  return String(out).split('\0').filter(Boolean)
    .filter((t) => { const tag = t[0]; return tag === 'S' || (tag >= 'a' && tag <= 'z'); })
    .map((t) => t.slice(2));
}

/** PR verdict for a branch at `head` → { ok } | { ok:false, reason, notable }. */
export function judgePrs(prs, branch, head) {
  if (!Array.isArray(prs)) throw new Error('gh: unexpected output');
  const mine = prs.filter((p) => p && p.headRefName === branch);
  const merged = mine.filter((p) => p.state === 'MERGED');
  const open = mine.filter((p) => p.state === 'OPEN');
  if (open.length) return { ok: false, reason: `có PR đang mở #${open.map((p) => p.number).join(', #')}`, notable: merged.length > 0 };
  if (!merged.length) return { ok: false, reason: 'chưa có PR merged', notable: false };
  if (!merged.some((p) => p.headRefOid === head)) return { ok: false, reason: `PR #${merged[0].number} đã merge nhưng HEAD có commit mới sau đó`, notable: true };
  return { ok: true, pr: merged.find((p) => p.headRefOid === head).number };
}

export function isInside(child, parent) {
  if (!child || !parent) return false;
  const p = parent.endsWith('/') ? parent : parent + '/';
  return child === parent || child.startsWith(p);
}

export function fmtGB(bytes) {
  if (bytes == null) return '? GB';
  return `${(bytes / 2 ** 30).toFixed(bytes < 2 ** 30 ? 2 : 1)} GB`;
}

// ── Filesystem probes ────────────────────────────────────────────────────────

/**
 * Bounded walk under `root` (lstat, never follows symlinks; skips `.git` and
 * any dir named in `skipNames`). → { recent: path|null, truncated }.
 * Read errors THROW so the caller keeps the tree.
 */
export function findRecentFile(root, { since, skipNames = BUILD_DIRS, maxEntries = WALK_MAX_ENTRIES } = {}) {
  const stack = [root];
  let n = 0;
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++n > maxEntries) return { recent: null, truncated: true };
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skipNames.has(e.name)) stack.push(p); continue; }
      if (fs.lstatSync(p).mtimeMs >= since) return { recent: p, truncated: false };
    }
  }
  return { recent: null, truncated: false };
}

/** `target/` dirs that sit next to a Cargo.toml (bounded; never descends into build dirs). */
export function findCargoTargets(root, { maxEntries = WALK_MAX_ENTRIES } = {}) {
  const found = [];
  const stack = [root];
  let n = 0;
  while (stack.length) {
    const dir = stack.pop();
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    const hasCargo = ents.some((e) => e.name === 'Cargo.toml' && e.isFile());
    for (const e of ents) {
      if (++n > maxEntries) return { targets: found, truncated: true };
      if (!e.isDirectory() || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.name === 'target' && hasCargo) { found.push(p); continue; }
      if (!BUILD_DIRS.has(e.name)) stack.push(p);
    }
  }
  return { targets: found, truncated: false };
}

/** Every live process's cwd from /proc. Throws if /proc itself is unreadable. */
export function readProcCwds(procDir = '/proc') {
  const out = [];
  for (const d of fs.readdirSync(procDir)) {
    if (!/^\d+$/.test(d)) continue;
    try { out.push({ pid: Number(d), cwd: fs.readlinkSync(path.join(procDir, d, 'cwd')).replace(/ \(deleted\)$/, '') }); } catch {}
  }
  return out;
}

/** Every `"cwd":"…"` in a file, read WHOLE in chunks (a line may span chunks). */
export function scanFileCwds(file, into = new Set(), chunkBytes = 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  const dec = new StringDecoder('utf8');
  const buf = Buffer.alloc(chunkBytes);
  let carry = '';
  const scan = (text) => {
    if (!text.includes('"cwd":"')) return;
    for (const m of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) { try { into.add(JSON.parse(`"${m[1]}"`)); } catch {} }
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (n <= 0) break;
      const text = carry + dec.write(buf.subarray(0, n));
      const nl = text.lastIndexOf('\n');
      if (nl < 0) { carry = text; continue; }
      scan(text.slice(0, nl));
      carry = text.slice(nl + 1);
    }
    scan(carry + dec.end());
  } finally { fs.closeSync(fd); }
  return into;
}

/** cwds named ANYWHERE in Claude transcripts (~/.claude/projects/*\/*.jsonl) modified since `since`. */
export function readTranscriptCwds({ root = TRANSCRIPTS_DIR, since } = {}) {
  const cwds = new Set();
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return cwds; throw e; }
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.mtimeMs < since) continue;
      try { scanFileCwds(file, cwds); } catch (e) { if (e.code !== 'ENOENT') throw e; } // vanished mid-scan: fine; else keep everything
    }
  }
  return cwds;
}

// ── Default effects ──────────────────────────────────────────────────────────

const defaultDeps = () => ({
  exec: async (cmd, args, opts = {}) => (await execFileP(cmd, args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, ...opts })).stdout,
  procCwds: () => readProcCwds(),
  transcriptCwds: (since) => readTranscriptCwds({ since }),
  rm: (p) => fs.rmSync(p, { recursive: true, force: true }),
  log: (m) => console.error(`[cleanup] ${m}`),
});

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * Decide (and unless dryRun, do) the cleanup. Never throws for a single
 * worktree — its error becomes a KEEP with the reason.
 * → { dryRun, removed, kept, targets, cache, cacheSkipped, errors }
 */
export async function runCleanup({
  parentDir = PARENT_DIR, dryRun = false, now = Date.now(), maxRemovals = MAX_REMOVALS,
  cargoCacheDir = CARGO_CACHE_DIR, lockDir = LOCK_DIR, deps: injected = {},
} = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const git = (args, opts) => deps.exec('git', args, opts);
  const du = async (p) => {
    try { const n = parseInt(String(await deps.exec('du', ['-sb', p], { timeout: 600_000 })).split(/\s/)[0], 10); return Number.isFinite(n) ? n : null; } catch { return null; }
  };
  const res = { dryRun, removed: [], kept: [], targets: [], cache: [], cacheSkipped: null, errors: [] };
  const realParent = fs.realpathSync(parentDir);

  // Global probes: if one fails, nothing can be proven safe → keep everything.
  let transcriptCwds;
  try { transcriptCwds = [...deps.transcriptCwds(now - TRANSCRIPT_WINDOW_MS)]; } catch (e) {
    res.errors.push(`đọc transcript lỗi: ${e.message} — không xoá worktree nào`);
    transcriptCwds = null;
  }
  const busyIn = (wt) => deps.procCwds().filter((p) => isInside(p.cwd, wt));

  const linked = []; // { repo, main, wt } for every linked worktree that exists
  let entries;
  try { entries = fs.readdirSync(parentDir, { withFileTypes: true }); } catch (e) { res.errors.push(`không đọc được ${parentDir}: ${e.message}`); return res; }
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isDirectory()) continue; // symlinks to elsewhere are not scanned
    const main = path.join(parentDir, ent.name);
    try { if (!fs.lstatSync(path.join(main, '.git')).isDirectory()) continue; } catch { continue; }
    let list, slug = null;
    try {
      list = parseWorktreePorcelain(await git(['-C', main, 'worktree', 'list', '--porcelain']));
    } catch (e) { res.errors.push(`${ent.name}: git worktree list lỗi: ${e.message}`); continue; }
    try { slug = githubSlug(await git(['-C', main, 'remote', 'get-url', 'origin'])); } catch {}
    const realMain = fs.realpathSync(main);
    // Index 0 is always the main checkout; also drop anything resolving to it.
    for (const wt of list.slice(1)) {
      if (wt.bare) continue;
      let real = null;
      try { real = fs.realpathSync(wt.path); } catch {}
      if (real === realMain || wt.path === main) continue;
      linked.push({ repo: ent.name, main, slug, wt, real });
    }
  }

  const keep = (L, reason, notable) => res.kept.push({ repo: L.repo, path: L.wt.path, branch: L.wt.branch?.replace(/^refs\/heads\//, '') ?? null, reason, notable });

  /** E1 verdict for one worktree → { ok:true, pr } | { ok:false, reason, notable }. */
  const judge = async (L) => {
    const { wt, real } = L;
    if (!real || wt.prunable) return { ok: false, reason: 'thư mục không còn', notable: false };
    if (!fs.lstatSync(wt.path).isDirectory()) return { ok: false, reason: 'không phải thư mục', notable: false };
    if (!isInside(real, realParent) || real === realParent) return { ok: false, reason: 'nằm ngoài workspace', notable: false };
    // A sibling project folder (~/Projects/repo-side) is visible work, not a scratch tree.
    if (path.dirname(real) === realParent) return { ok: false, reason: 'là thư mục dự án cấp cao nhất trong workspace — không tự xoá', notable: true };
    if (wt.locked) return { ok: false, reason: 'bị khoá (git worktree lock)', notable: false };
    if (wt.detached || !wt.branch || !wt.branch.startsWith('refs/heads/')) return { ok: false, reason: 'detached HEAD', notable: false };
    if (!/^[0-9a-f]{40,64}$/.test(wt.head || '')) return { ok: false, reason: 'không đọc được HEAD', notable: false };
    const branch = wt.branch.slice('refs/heads/'.length);
    if (!L.slug) return { ok: false, reason: 'remote origin không phải GitHub', notable: false };
    const prs = JSON.parse(await deps.exec('gh', ['pr', 'list', '-R', L.slug, '--head', branch, '--state', 'all',
      '--json', 'number,state,headRefOid,headRefName', '--limit', '100'], { timeout: 60_000 }));
    const pr = judgePrs(prs, branch, wt.head);
    if (!pr.ok) return pr;
    // HEAD may have moved since `worktree list` — re-read it right here.
    const headNow = String(await git(['-C', wt.path, 'rev-parse', 'HEAD'])).trim();
    if (headNow !== wt.head) return { ok: false, reason: 'HEAD vừa đổi', notable: true };
    const st = parseStatusZ(await git(['-C', wt.path, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']));
    if (st.tracked.length) return { ok: false, reason: `có thay đổi chưa commit (${st.tracked.slice(0, 3).join(', ')}${st.tracked.length > 3 ? ', …' : ''})`, notable: true };
    const stray = strayEntries(st);
    if (stray.length) return { ok: false, reason: `có file ngoài git: ${stray.slice(0, 5).join(', ')}${stray.length > 5 ? ', …' : ''}`, notable: true };
    const hidden = hiddenEdits(await git(['-C', wt.path, 'ls-files', '-v', '-z']));
    if (hidden.length) return { ok: false, reason: `có file skip-worktree/assume-unchanged (${hidden.slice(0, 3).join(', ')}${hidden.length > 3 ? ', …' : ''})`, notable: true };
    const procs = busyIn(real);
    if (procs.length) return { ok: false, reason: `có tiến trình đang ở trong (pid ${procs.slice(0, 3).map((p) => p.pid).join(', ')})`, notable: true };
    if (!transcriptCwds) return { ok: false, reason: 'không đọc được transcript', notable: false };
    if (transcriptCwds.some((c) => isInside(c, real) || isInside(c, wt.path))) return { ok: false, reason: 'có phiên Claude dùng trong 7 ngày qua', notable: true };
    const r = findRecentFile(real, { since: now - RECENT_EDIT_MS });
    if (r.truncated) return { ok: false, reason: 'quá nhiều file để quét', notable: true };
    if (r.recent) return { ok: false, reason: `có file sửa trong 24h (${path.relative(real, r.recent)})`, notable: true };
    return { ok: true, pr: pr.pr };
  };

  const stay = []; // linked worktrees that remain → E2
  let capHit = 0;
  for (const L of linked) {
    if (res.removed.length >= maxRemovals) { capHit++; stay.push(L); continue; }
    let v;
    try { v = await judge(L); } catch (e) { v = { ok: false, reason: `lỗi: ${String(e.message || e).split('\n')[0].slice(0, 160)}`, notable: true, error: true }; }
    if (!v.ok) { keep(L, v.reason, v.notable); stay.push(L); continue; }
    try {
      // Last-moment re-check: a process may have just cd'd in.
      if (busyIn(L.real).length) { keep(L, 'có tiến trình vừa vào', true); stay.push(L); continue; }
      const bytes = await du(L.real);
      if (!dryRun) {
        await git(['-C', L.main, 'worktree', 'remove', '--force', L.wt.path]);
        deps.log(`removed ${L.wt.path}`);
      }
      res.removed.push({ repo: L.repo, path: L.wt.path, branch: L.wt.branch.slice('refs/heads/'.length), pr: v.pr, bytes });
    } catch (e) {
      keep(L, `lỗi khi xoá: ${String(e.message || e).split('\n')[0].slice(0, 160)}`, true);
      stay.push(L);
    }
  }
  if (capHit) res.errors.push(`đã chạm giới hạn ${maxRemovals} worktree/lần — ${capHit} worktree chưa xét, để lần sau`);

  // E2: abandoned cargo target/ in worktrees that stay.
  for (const L of stay) {
    if (!L.real) continue;
    try {
      if (!isInside(L.real, realParent) || path.dirname(L.real) === realParent || !fs.lstatSync(L.real).isDirectory()) continue;
      const { targets } = findCargoTargets(L.real);
      for (const t of targets) {
        if (!fs.lstatSync(t).isDirectory()) continue;
        if (String(await git(['-C', L.real, 'ls-files', '-z', '--', path.relative(L.real, t)])).length) continue; // tracked content: not a build dir
        const r = findRecentFile(t, { since: now - TARGET_IDLE_MS, skipNames: new Set() });
        if (r.truncated || r.recent) continue;
        if (busyIn(L.real).length) break;
        const bytes = await du(t);
        if (!dryRun) { deps.rm(t); deps.log(`removed ${t}`); }
        res.targets.push({ repo: L.repo, path: t, bytes });
      }
    } catch (e) { res.errors.push(`target/ trong ${L.wt.path}: ${String(e.message || e).split('\n')[0]}`); }
  }

  // §C shared cargo cache: prune idle subdirs only while no build can start.
  let cacheDirs = [];
  try { cacheDirs = fs.readdirSync(cargoCacheDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  if (cacheDirs.length) {
    let lock;
    try { lock = await acquireLock('build', { waitSec: 0, dir: lockDir, cmd: 'cleanup: prune cargo cache' }); } catch (e) { res.cacheSkipped = `không lấy được lock build: ${e.message}`; }
    if (lock?.timeout) res.cacheSkipped = 'đang có build chạy (lock build bận)';
    else if (lock) {
      try {
        for (const d of cacheDirs) {
          const p = path.join(cargoCacheDir, d.name);
          try {
            const r = findRecentFile(p, { since: now - CACHE_IDLE_MS, skipNames: new Set() });
            if (r.truncated || r.recent) continue;
            const bytes = await du(p);
            if (!dryRun) { deps.rm(p); deps.log(`removed ${p}`); }
            res.cache.push({ path: p, bytes });
          } catch (e) { res.errors.push(`cache ${d.name}: ${e.message}`); }
        }
      } finally { lock.release(); }
    }
  }
  return res;
}

// ── Report ───────────────────────────────────────────────────────────────────

const sum = (xs) => xs.reduce((a, x) => a + (x.bytes || 0), 0);

/** Vietnamese summary for the owner. Pure. */
export function formatReport(r) {
  const verb = r.dryRun ? 'sẽ xoá' : 'đã xoá';
  const L = [`🧹 Dọn dẹp hằng ngày${r.dryRun ? ' (DRY-RUN — chưa xoá gì)' : ''}`];
  const total = sum(r.removed) + sum(r.targets) + sum(r.cache);
  L.push(`Tổng ${r.dryRun ? 'sẽ lấy lại' : 'lấy lại'}: ${fmtGB(total)}`);
  L.push('', `Worktree ${verb} (${r.removed.length}, ${fmtGB(sum(r.removed))}):`);
  if (!r.removed.length) L.push('  (không có)');
  for (const x of r.removed) L.push(`  • ${x.repo}: ${x.branch}${x.pr ? ` (PR #${x.pr})` : ''} — ${fmtGB(x.bytes)}`);
  const notable = r.kept.filter((k) => k.notable);
  if (notable.length) {
    L.push('', `Giữ lại — đáng chú ý (${notable.length}):`);
    for (const k of notable) L.push(`  • ${k.repo}: ${k.branch || path.basename(k.path)} — ${k.reason}`);
  }
  const quiet = r.kept.length - notable.length;
  if (quiet) L.push('', `Giữ lại ${quiet} worktree khác (PR chưa merge, detached, khoá…).`);
  if (r.targets.length) {
    L.push('', `target/ bỏ hoang ${verb} (${r.targets.length}, ${fmtGB(sum(r.targets))}):`);
    for (const t of r.targets) L.push(`  • ${t.path} — ${fmtGB(t.bytes)}`);
  }
  if (r.cache.length) {
    L.push('', `Cache cargo dùng chung ${verb} (${r.cache.length}, ${fmtGB(sum(r.cache))}):`);
    for (const c of r.cache) L.push(`  • ${path.basename(c.path)} — ${fmtGB(c.bytes)}`);
  }
  if (r.cacheSkipped) L.push('', `Cache cargo: bỏ qua — ${r.cacheSkipped}`);
  if (r.errors.length) { L.push('', '⚠️ Ghi chú:'); for (const e of r.errors) L.push(`  • ${e}`); }
  return L.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseCleanupArgs(argv) {
  const o = { dryRun: false, reportToOwner: false };
  for (const a of argv) {
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--report-to-owner') o.reportToOwner = true;
    else throw new Error(`unknown argument: ${a} (usage: cleanup.mjs [--dry-run] [--report-to-owner])`);
  }
  return o;
}

function deliver(text, toOwner) {
  console.log(text);
  if (!toOwner) return;
  execFileSync(process.execPath, [path.join(__dirname, 'send-telegram.mjs'), '--dm', '--plain'], {
    input: text, stdio: ['pipe', 'inherit', 'inherit'], timeout: 120_000,
  });
}

/**
 * The CLI body (effects injectable for tests). A dry run whose report reached
 * the owner is recorded (`dryRunReportedAt`); until then the daily scheduler
 * keeps choosing dry runs, so a crashed/undelivered first run never leads to a
 * real one.
 */
export async function cli(argv, {
  run = runCleanup, send = deliver, stateFile = CLEANUP_STATE_FILE, lockDir = LOCK_DIR, now = Date.now,
} = {}) {
  let opts;
  try { opts = parseCleanupArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const lock = await acquireLock('cleanup', { waitSec: 0, dir: lockDir, cmd: `cleanup.mjs ${argv.join(' ')}`.trim() });
  if (lock.timeout) {
    try { send('🧹 Dọn dẹp: đang có một lượt khác chạy (lock cleanup bận) — bỏ qua lượt này.', opts.reportToOwner); } catch {}
    return 0;
  }
  let text, ok = false;
  try { text = formatReport(await run({ dryRun: opts.dryRun })); ok = true; }
  catch (e) { text = `❌ Dọn dẹp lỗi, không xoá thêm gì: ${e instanceof Error ? e.message : e}`; }
  finally { lock.release(); }
  try { send(text, opts.reportToOwner); } catch (e) { console.error(`[cleanup] report failed: ${e.message}`); return 1; }
  if (ok && opts.dryRun && opts.reportToOwner) {
    try { recordDryRunReported(stateFile, now()); } catch (e) { console.error(`[cleanup] cannot record dry-run: ${e.message}`); return 1; }
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
