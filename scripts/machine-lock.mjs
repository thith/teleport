// Machine-wide exclusive locks (RFC 17): at most one heavy build, one merge.
//
// The lock is flock(2) on `~/.local/state/teleport/locks/<name>.lock`, HELD BY
// THIS NODE PROCESS: we open the file (Node opens with O_CLOEXEC, so nothing we
// spawn inherits it) and run `flock -n 3` as a short-lived child on that fd. The
// lock belongs to our open file description, so it outlives the helper and is
// released by the kernel the moment we exit — normally, by signal, or SIGKILL.
// No TTL, no pid liveness guessing, nothing to clean up.
//
// Why not `flock <file> <cmd>`: cmd inherits the fd, so anything it backgrounds
// (`… &`, emulator, adb server) holds the lock forever; signals stop at flock
// (the cmd is orphaned, still locked); and a daemon timeout that kills only the
// direct child leaves a waiting merge to merge later, unreported. All measured.
//
// `<name>.holder.json` is for DISPLAY only ("waiting for 🧛 Ma — ./gradlew …");
// it never decides who holds the lock.
//
// RFC 21 — FIFO ticket queue in `<name>.queue/`. flock still decides who
// HOLDS the lock; the queue only decides who may TRY (a queue mistake costs
// fairness, never exclusion). Only the oldest live, non-stalled ticket tries
// `flock -n`. Dead tickets (pid gone / zombie / start time changed) are deleted
// by anyone; stalled ones (no heartbeat 30 s, or stopped) are only skipped;
// `lock-queue.mjs leave` strikes a ticket by renaming it to `.left`; a waiter
// that wins flock claims its ticket by renaming it to `.acq`. Exactly one of the
// two renames succeeds, so a struck waiter can never run (it gives the lock
// back), and a waiter that claimed first can no longer be struck. A try-once caller
// (waitSec 0) only tries with nobody queued. `lock-queue.mjs` lists / leaves.
//
// RFC 23 — the `build` lock may have N = 1..MAX_SLOTS slots: slot 0 is
// `build.lock` (unchanged), slot k ≥ 1 is `build.<k>.lock`, each with its own
// holder file. N is one value for the whole machine (resolveBuildSlots: MemTotal,
// lowered by `<LOCK_DIR>/build.slots`; any doubt → 1). N only limits which slots
// are GRANTED; everything that reads or locks "the whole lock" (exclusive,
// holders, display, leave) covers all MAX_SLOTS, so changing N mid-build is safe.
// Every other lock always has one slot.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveConvoIdFromEnv } from './convo-registry.mjs';
import { peekPersona } from './persona-store.mjs';
import { formatPersona } from './persona.mjs';
import { shortConvoHash } from './convo-hash.mjs';

// $HOME, not $XDG_STATE_HOME: the daemon and the agents must agree on one file.
export const LOCK_DIR = process.env.TELEPORT_LOCK_DIR || path.join(os.homedir(), '.local', 'state', 'teleport', 'locks');
export const LOCK_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const BUSY = 75; // flock -E: "lock is held" (helper runs no command, so 75 is unambiguous)

export function lockPaths(name, dir = LOCK_DIR, slot = 0) {
  if (!LOCK_NAME_RE.test(String(name))) throw new Error(`bad lock name: ${name}`);
  if (!(Number.isSafeInteger(slot) && slot >= 0 && slot < MAX_SLOTS)) throw new Error(`bad lock slot: ${slot}`);
  const base = slot ? `${name}.${slot}` : name;
  return { lock: path.join(dir, `${base}.lock`), holder: path.join(dir, `${base}.holder.json`), queue: path.join(dir, `${name}.queue`) };
}

// ── RFC 23: slots of the build lock ──

export const MAX_SLOTS = 2;
const GiB = 1024 ** 3;
export const TWO_SLOT_MIN_RAM = 28 * GiB;
const DEFAULT_LOCK_DIR = path.join(os.homedir(), '.local', 'state', 'teleport', 'locks');

/** Total RAM in bytes — the one source for both N and the build's MemoryMax. */
export const memTotal = () => os.totalmem();

/** How many slots lock `name` may have at most (files 0..n−1 exist / are read). */
export const slotFiles = (name) => (name === 'build' ? MAX_SLOTS : 1);

/**
 * N for the build lock: MemTotal ≥ 28 GiB → 2, else 1; `<dir>/build.slots`
 * containing `1` lowers it (never raises). Unreadable / odd file → 1. A lock dir
 * other than the real default one (tests) → 1 unless the caller passes `slots`.
 */
export function resolveBuildSlots(dir = LOCK_DIR, { total = memTotal(), read = (f) => fs.readFileSync(f, 'utf8'), defaultDir = DEFAULT_LOCK_DIR } = {}) {
  if (path.resolve(dir) !== path.resolve(defaultDir)) return 1;
  const auto = total >= TWO_SLOT_MIN_RAM ? 2 : 1;
  let text;
  try { text = read(path.join(dir, 'build.slots')); } catch (e) { return e.code === 'ENOENT' ? auto : 1; }
  void text; // the file only ever lowers, and 1 is the only lower value: whatever it holds means 1
  return 1;
}

/** N actually used for `name`: build → opts.slots ?? resolveBuildSlots(dir); others 1. Clamped to 1..MAX. */
export function slotsFor(name, { slots = null, dir = LOCK_DIR } = {}) {
  if (name !== 'build') return 1;
  const n = Number(slots ?? resolveBuildSlots(dir));
  return Number.isSafeInteger(n) ? Math.min(MAX_SLOTS, Math.max(1, n)) : 1;
}

/** Live holders of every slot of `name` (all MAX for build, whatever N is): [{ slot, ...holder }]. */
export function readHolders(name, { dir = LOCK_DIR, holderOf = readHolder } = {}) {
  const out = [];
  for (let k = 0; k < slotFiles(name); k++) {
    const h = holderOf(lockPaths(name, dir, k).holder);
    if (h?.alive) out.push({ ...h, slot: h.slot ?? k });
  }
  return out;
}

// ── RFC 21: the ticket queue ──

export const TICKET_STALL_MS = 30_000;
export const TICKET_RE = /^\d{15}-\d+-[a-z0-9]+\.json$/;

/** { state, start } of a pid from /proc/<pid>/stat (parsed after the LAST ')'), or null if gone. */
export function procStat(pid, { read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  try {
    const t = read(`/proc/${pid}/stat`);
    const rest = t.slice(t.lastIndexOf(')') + 2).split(' ');
    return { state: rest[0], start: rest[19] }; // field 3 = state, field 22 = starttime
  } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * A ticket's status: 'dead' (anyone may delete) | 'stopped' (ctrl-Z / traced)
 * | 'stalled' (alive, no heartbeat 30 s) — both skipped, kept | 'live'. (Struck tickets are `.left`
 * files, not in the queue at all.) Pure given stat.
 */
export function ticketStatus(t, mtimeMs, { now = Date.now(), stat = procStat, stallMs = TICKET_STALL_MS } = {}) {
  if (!t || !Number.isSafeInteger(t.pid)) return 'dead';
  const st = stat(t.pid);
  if (!st || st.state === 'Z' || st.state === 'X' || (t.procStart != null && String(st.start) !== String(t.procStart))) return 'dead';
  if (st.state === 'T' || st.state === 't') return 'stopped';
  if (now - mtimeMs > stallMs) return 'stalled';
  return 'live';
}

/**
 * The queue of lock `name`, oldest first: [{ file, name, status, mtimeMs, ...ticket }].
 * `prune`: delete DEAD tickets only (never stalled ones of a live owner).
 */
export function readQueue(name, { dir = LOCK_DIR, now = Date.now(), stat = procStat, prune = false } = {}) {
  const q = lockPaths(name, dir).queue;
  let files = [];
  try { files = fs.readdirSync(q).filter((f) => TICKET_RE.test(f)).sort(); } catch { return []; }
  if (prune) { pruneLeft(q, stat); pruneHolderTmp(dir); }
  const out = [];
  for (const f of files) {
    const file = path.join(q, f);
    let t = null, mtimeMs = 0;
    try { t = JSON.parse(fs.readFileSync(file, 'utf8')); mtimeMs = fs.statSync(file).mtimeMs; } catch (e) { continue; } // vanished, or unreadable right now (EMFILE…): skip this round, never judge it dead
    const status = ticketStatus(t, mtimeMs, { now, stat });
    if (status === 'dead' && prune) { try { fs.unlinkSync(file); } catch {} continue; }
    out.push({ ...(t || {}), file, name: f, status, mtimeMs });
  }
  return out;
}

/**
 * Strike matching tickets of waiting processes: rename `<t>.json` → `<t>.left`.
 * Atomic against the owner claiming it (`.json` → `.acq`): whoever renames
 * first wins. A struck ticket can never run; its waiter exits on its next poll.
 * → the tickets struck (each one definitely will not run).
 */
export function cancelTickets(name, match, { dir = LOCK_DIR, stat = procStat } = {}) {
  const struck = [];
  for (const t of readQueue(name, { dir, stat })) {
    if (t.status === 'dead' || !match(t)) continue;
    try { fs.renameSync(t.file, t.file.replace(/\.json$/, '.left')); struck.push(t); } catch {}
  }
  return struck;
}

/** Struck tickets still waiting for their owner to notice (`.left` of a live process), oldest first. */
export function readStruck(name, { dir = LOCK_DIR, stat = procStat } = {}) {
  const q = lockPaths(name, dir).queue;
  let files = [];
  try { files = fs.readdirSync(q).filter((f) => /^\d{15}-\d+-[a-z0-9]+\.left$/.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { const t = JSON.parse(fs.readFileSync(path.join(q, f), 'utf8')); if (ticketStatus(t, Date.now(), { stat }) !== 'dead') out.push({ ...t, name: f }); } catch {}
  }
  return out;
}

/** Tickets just claimed (`.acq`: won flock, holder file not written yet) of live processes. */
export function readClaimed(name, { dir = LOCK_DIR, stat = procStat } = {}) {
  const q = lockPaths(name, dir).queue;
  let files = [];
  try { files = fs.readdirSync(q).filter((f) => /^\d{15}-\d+-[a-z0-9]+\.acq$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) { try { const t = JSON.parse(fs.readFileSync(path.join(q, f), 'utf8')); if (ticketStatus(t, Date.now(), { stat }) !== 'dead') out.push({ ...t, ticket: f.replace(/\.acq$/, '.json') }); } catch {} } // dead rule: pid reuse too
  return out;
}

/** A holder.json temp file left by a writer that died mid-write (older than a minute). */
function pruneHolderTmp(dir, now = Date.now()) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.holder\.json\.\d+\.[a-z0-9]+\.tmp$/.test(f)); } catch { return; }
  for (const f of files) { try { const file = path.join(dir, f); if (now - fs.statSync(file).mtimeMs > 60_000) fs.unlinkSync(file); } catch {} }
}

/** Housekeeping: `.left` / `.acq` files of dead owners, and `.tmp` files older than a minute (writer died mid-write). */
function pruneLeft(q, stat, now = Date.now()) {
  let files = [];
  try { files = fs.readdirSync(q); } catch { return; }
  for (const f of files) {
    const file = path.join(q, f);
    if (/^\d{15}-(\d+)-[a-z0-9]+\.(left|acq)$/.test(f)) {
      let t = null;
      try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      // same "dead" rule as tickets: gone, zombie, or the pid now belongs to another process
      if (ticketStatus(t || { pid: Number(f.split('-')[1]) }, now, { now, stat }) === 'dead') { try { fs.unlinkSync(file); } catch {} }
    } else if (f.endsWith('.tmp')) {
      try { if (now - fs.statSync(file).mtimeMs > 60_000) fs.unlinkSync(file); } catch {}
    }
  }
}

/** This process's convoId for tickets: null for the daemon (TELE_FROM_NAME) — agents' `leave` never matches it. */
export function selfConvoId(env = process.env) {
  if (env.TELE_FROM_NAME) return null;
  try { const c = resolveConvoIdFromEnv({ env }).convoId; return c == null ? null : String(c); } catch { return null; }
}

/** One non-blocking try on `fd` → 'acquired' | 'busy'; throws on flock errors (missing binary, 66…). */
function tryFlock(fd) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('flock', ['-n', '-E', String(BUSY), '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] }); }
    catch (e) { reject(e); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject); // ENOENT: no flock binary
    child.on('close', (code) => {
      if (code === 0) resolve('acquired');
      else if (code === BUSY) resolve('busy');
      else reject(new Error(`flock exited ${code}${err ? `: ${err.trim()}` : ''}`));
    });
  });
}

/** Holder info for display; null if absent/garbled. `alive` = its pid still exists. Pure-ish. */
export function readHolder(file) {
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try { process.kill(h.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive && h.procStart != null) { const st = procStat(h.pid); alive = !!st && String(st.start) === String(h.procStart); } // pid reused?
    return { ...h, alive };
  } catch { return null; }
}

/** "🧛 Ma #c2383556 — ./gradlew assembleDebug — từ 12:40 (3 phút)". Pure. */
export function describeHolder(h, now = Date.now()) {
  if (!h) return '(chưa rõ ai giữ)';
  if (!h.alive) return '(không rõ ai giữ — tiến trình ghi tên đã chết)';
  const mins = Math.max(0, Math.round((now - h.startedAt) / 60000));
  const at = new Date(h.startedAt).toTimeString().slice(0, 5);
  return `${h.label || `pid ${h.pid}`}${h.cmd ? ` — ${h.cmd}` : ''} — từ ${at} (${mins} phút)`;
}

/** Best-effort label for whoever runs this: daemon sender, else the agent ("🧛 Ma #c2383556"). */
export function selfLabel(env = process.env) {
  if (env.TELE_FROM_NAME) return `${env.TELE_FROM_NAME} (daemon)`;
  try {
    const { convoId } = resolveConvoIdFromEnv({ env });
    if (convoId != null) {
      const p = peekPersona(convoId);
      return `${p ? `${formatPersona(p)} ` : ''}#${shortConvoHash(convoId)}`;
    }
  } catch {}
  return `pid ${process.pid}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One process-wide 'exit' handler removes every ticket still open (the daemon
// may wait on several at once — no listener per waiter).
const EXIT_TICKETS = new Set();
let exitArmed = false;
function armExitHandler() {
  if (exitArmed) return;
  exitArmed = true;
  process.on('exit', () => { for (const f of EXIT_TICKETS) { try { f(); } catch {} } });
}

/**
 * Take lock `name`, waiting up to `waitSec` (Infinity = forever) in FIFO order
 * (RFC 21). While waiting, `onWait(holder, waitedMs, { position, ahead, holders, slots })`
 * is called at once, then every `noticeMs` or when a holder / the position changes.
 * Never blocks the event loop.
 * RFC 23: the build lock has `slots` (default slotsFor) slots; position 0 always
 * tries every granted slot, position i ≥ 1 only while i < N − busy. `exclusive`
 * (try-once only) takes ALL slots files or none. `pending` marks the holder as
 * not yet having declared its memory (heavy then calls update()).
 * → { release(), update(fields), waitedMs, slot, slots, startedAt }
 *   | { timeout: true, holder, holders, slots } | { timeout: true, left: true, holder }
 * (left = struck via lock-queue.mjs leave; `timeout` stays set so old callers just stop;
 * `holder` = the first live holder, for old callers).
 * Throws if flock can't run.
 */
export async function acquireLock(name, {
  waitSec = Infinity, label = selfLabel(), cmd = '', onWait = () => {}, pollMs = 1000, noticeMs = 60000, dir = LOCK_DIR, now = Date.now,
  convoId = selfConvoId(), warn = (m) => console.error(m), stat = procStat, beforeClaim = null,
  slots = null, exclusive = false, pending = false,
} = {}) {
  let N = slotsFor(name, { slots, dir }); // re-read every poll while waiting: `lock-queue slots 1` applies to queued waiters too
  const nFiles = slotFiles(name);
  const P = Array.from({ length: nFiles }, (_, k) => lockPaths(name, dir, k));
  const p = P[0];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // O_RDONLY is enough for flock and works even where the file isn't writable. One fd per slot, opened on first try.
  const fds = new Array(nFiles).fill(null);
  const fdOf = (k) => (fds[k] ??= fs.openSync(P[k].lock, fs.constants.O_RDONLY | fs.constants.O_CREAT, 0o600));
  const won = new Set(); // slots whose flock we hold
  const start = now();
  const close = (keep = null) => { for (let k = 0; k < nFiles; k++) if (fds[k] != null && !(keep && keep.has(k))) { try { fs.closeSync(fds[k]); } catch {} fds[k] = null; won.delete(k); } };
  const holders = () => readHolders(name, { dir });
  const first = (hs = holders()) => hs[0] || readHolder(p.holder);
  // Try slots 0..n−1 in order; → the slot won, or −1. Waiters retry a slot once after 100 ms when its holder is
  // dead (a try-once caller just gave it back) — not while an exclusive holder (cleanup) has every slot.
  const trySlots = async (n, retry = true) => {
    const excl = retry && n > 1 && readHolder(P[0].holder);
    for (let k = 0; k < n; k++) {
      let r = await tryFlock(fdOf(k));
      if (retry && r !== 'acquired' && !(excl?.alive && excl.exclusive) && !readHolder(P[k].holder)?.alive) { await sleep(100); r = await tryFlock(fdOf(k)); }
      if (r === 'acquired') { won.add(k); return k; }
    }
    return -1;
  };
  if (exclusive && waitSec > 0) throw new Error('exclusive is try-once only (waitSec 0)');
  const queued = (mine = null) => readQueue(name, { dir, prune: true, stat }).filter((t) => t.file !== mine && t.status !== 'dead');
  let ticket = null;
  const dropTicket = () => { if (ticket) { for (const ext of ['.json', '.left', '.acq']) { try { fs.unlinkSync(ticket.replace(/\.(json|acq)$/, ext)); } catch {} } } };
  const done = () => { dropTicket(); EXIT_TICKETS.delete(dropTicket); };
  let slot = -1;
  try {
    if (!(waitSec > 0)) {
      // Try-once: never jump the queue (stalled / leaving waiters still count), and never write a holder we give back.
      // (only LIVE waiters count: a stopped / stalled one must not block try-once callers forever)
      const live = () => queued().filter((t) => t.status === 'live').length;
      const busyOut = () => { close(); const hs = holders(); return { timeout: true, holder: first(hs), holders: hs, slots: N }; };
      if (live()) return busyOut();
      if (exclusive) {
        // every slot file (not just 0..N−1: a build may still run in a slot N no longer grants)
        for (let k = 0; k < nFiles; k++) { if (await tryFlock(fdOf(k)) !== 'acquired') return busyOut(); won.add(k); }
        slot = 0;
      } else if ((slot = await trySlots(N, false)) < 0) return busyOut();
      if (live()) return busyOut();
    } else {
      // Ticket FIRST (before any try); deleted only AFTER the holder file names us.
      const body = { pid: process.pid, procStart: stat(process.pid)?.start ?? null, label, cmd, convoId: convoId == null ? null : String(convoId), createdAt: now() };
      try {
        fs.mkdirSync(p.queue, { recursive: true, mode: 0o700 });
        const file = path.join(p.queue, `${String(Date.now()).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeJsonAtomic(file, body);
        ticket = file;
        armExitHandler();
        EXIT_TICKETS.add(dropTicket);
      } catch (e) { warn(`⚠️ lock ${name}: không ghi được vé hàng đợi (${e.message}) — chờ kiểu cũ, không theo thứ tự.`); }
      let lastNotice = -Infinity, lastKey = null;
      // Read every poll (not only at the head): struck (renamed to .left) = leave. Vanished WITHOUT a
      // .left (e.g. pruned by a process that misjudged us dead) = not a leave: put it back, same place.
      const mineState = () => {
        if (!ticket) return 'ok';
        try { fs.accessSync(ticket); return 'ok'; } catch (e) { if (e.code !== 'ENOENT') return 'ok'; }
        if (fs.existsSync(ticket.replace(/\.json$/, '.left'))) return 'left';
        try { writeJsonAtomic(ticket, body); warn(`⚠️ lock ${name}: vé hàng đợi bị xoá (không phải leave) — đã ghi lại đúng chỗ cũ.`); } catch {}
        return 'ok';
      };
      for (;;) {
        const ms = mineState();
        if (ms !== 'ok') { done(); close(); return { timeout: true, left: true, holder: readHolder(p.holder) }; } // struck (.left) — a vanished ticket without .left was put back by mineState
        if (ticket) { try { const tt = new Date(); fs.utimesSync(ticket, tt, tt); } catch {} }
        const others = ticket ? queued(ticket) : [];
        const ahead = ticket ? others.filter((t) => t.name < path.basename(ticket) && t.status === 'live') : [];
        // Position 0 always tries (never gated by holder files, which may be stale). Position i ≥ 1
        // only while i < N − busy, busy = live holders of every slot + claimed (.acq) tickets that have
        // no holder yet. A wrong count costs order, never exclusion (flock decides).
        if (slots == null && name === 'build') N = slotsFor(name, { dir });
        let mayTry = !ahead.length;
        if (!mayTry && N > 1) {
          const hs = holders();
          const named = new Set(hs.map((h) => h.ticket).filter(Boolean));
          const claimedOnly = readClaimed(name, { dir, stat }).filter((c) => !named.has(c.ticket)).length;
          mayTry = ahead.length < N - (hs.length + claimedOnly);
        }
        if (mayTry && (slot = await trySlots(N)) >= 0) {
          // The atomic hand-off: WE rename our ticket to .acq, or `leave` renamed it to .left —
          // exactly one rename succeeds. Lost → give the slot straight back.
          if (!ticket) break;
          if (beforeClaim) await beforeClaim(ticket); // (test seam: strike right here)
          try { fs.renameSync(ticket, ticket.replace(/\.json$/, '.acq')); ticket = ticket.replace(/\.json$/, '.acq'); break; }
          catch (e) {
            if (e.code !== 'ENOENT') throw e;
            if (fs.existsSync(ticket.replace(/\.json$/, '.left'))) { done(); close(); return { timeout: true, left: true, holder: null }; }
            break; // vanished without a .left (a pruner misjudged us dead): we won flock fair and square — keep it
          }
        }
        const t = now(), hs = holders(), holder = first(hs);
        const key = `${hs.map((h) => `${h.slot}:${h.pid}:${h.startedAt}`).join(',') || (holder ? `${holder.pid}:${holder.startedAt}` : '')}|${ahead.length}`;
        if (key !== lastKey || t - lastNotice >= noticeMs) {
          onWait(holder, t - start, { position: ahead.length + 1, ahead: ahead.map((x) => x.label || `pid ${x.pid}`), holders: hs, slots: N });
          lastNotice = t; lastKey = key;
        }
        if (t - start >= waitSec * 1000) { done(); close(); return { timeout: true, holder, holders: hs, slots: N }; }
        await sleep(pollMs);
      }
    }
  } catch (e) { done(); close(); throw e; }
  close(won); // fds of slots we tried but did not win
  const hp = P[slot].holder;
  // `ticket`: which of possibly several tickets of this process (daemon) holds the lock.
  let me = { pid: process.pid, procStart: stat(process.pid)?.start ?? null, convoId: convoId == null ? null : String(convoId), ticket: ticket ? path.basename(ticket).replace(/\.acq$/, '.json') : null, label, cmd, cwd: process.cwd(), startedAt: now(),
    ...(name === 'build' ? { slot, slots: N } : {}), ...(exclusive ? { exclusive: true } : {}), ...(pending ? { pending: true } : {}) };
  try { // atomic, so a waiter never reads half a file
    writeJsonAtomic(hp, me);
  } catch (e) {
    // Display only — except on a machine that may run 2 builds (now, or after `slots auto`), where the other
    // build budgets RAM from our holder: no holder, no run.
    if (name === 'build' && (N > 1 || memTotal() >= TWO_SLOT_MIN_RAM)) { done(); close(); throw new Error(`không ghi được holder ${path.basename(hp)} (${e.message}) — không chạy (build kia cần nó để tính RAM)`); }
  }
  done(); // holder names us → leave the queue
  let released = false;
  const ours = () => { const h = readHolder(hp); return h?.pid === process.pid && h.startedAt === me.startedAt && h.ticket === me.ticket; };
  // Rewrite our holder (e.g. heavy declaring memMax / unbounded): atomic, only while we hold it. → written?
  const update = (fields) => {
    if (released) return false;
    const next = { ...me, ...fields };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    try { writeJsonAtomic(hp, next); me = next; return true; } catch { return false; }
  };
  const release = () => {
    if (released) return;
    released = true;
    // Holder file first, while we still hold the lock — no race with the next holder.
    // (match this acquisition, not just our pid: the daemon may hold several in turn)
    try { if (ours()) fs.unlinkSync(hp); } catch {}
    close();
  };
  return { release, update, waitedMs: me.startedAt - start, slot, slots: N, startedAt: me.startedAt };
}

/**
 * A short helper lock (RFC 23: `build.sweep.lock`, around the orphan-scope sweep):
 * wait up to `waitMs` for flock on `<dir>/<name>.lock` → release() | null on timeout.
 */
export async function acquireHelperLock(name, { dir = LOCK_DIR, waitMs = 60_000, pollMs = 500, now = Date.now } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(dir, `${name}.lock`), fs.constants.O_RDONLY | fs.constants.O_CREAT, 0o600);
  const start = now();
  try {
    for (;;) {
      if (await tryFlock(fd) === 'acquired') return () => { try { fs.closeSync(fd); } catch {} };
      if (now() - start >= waitMs) break;
      await sleep(pollMs);
    }
  } catch (e) { try { fs.closeSync(fd); } catch {} throw e; }
  try { fs.closeSync(fd); } catch {}
  return null;
}
