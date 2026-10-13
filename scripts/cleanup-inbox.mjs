// cleanup-inbox.mjs — the daemon side of agent cleanup requests (see cleanup-request.mjs).
//
// The daemon loop fires processCleanupRequests WITHOUT awaiting it (one pass at
// a time, like the merge inbox). Each pass claims request files from
// scripts/tmp/cleanup-requests/ (same atomic claim as merge-inbox), and for each:
//   • takes the machine lock `cleanup` (waits ~60 s; still busy → the request is
//     put back and retried on a later pass, never dropped);
//   • runs cleanup.mjs's own judge for that one worktree in "requested" mode
//     (cleanupRequested → judgeWorktree): every daily-cleanup gate except the two
//     "recently used" ones, then `git worktree remove --force`;
//   • injects the result into the requester's prompt queue (`cleanupResult`,
//     non-privileged fromRole 'daemon'), DMs the owner a one-line FYI, audits.
// Everything here is async (git/gh/du run as child processes), so the poll loop
// never blocks on it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimRequests, deliverResult } from './merge-inbox.mjs';
import { CLEANUP_REQUEST_DIR } from './cleanup-request.mjs';
import { cleanupRequested, defaultDeps, fmtGB } from './cleanup.mjs';
import { acquireLock, LOCK_DIR } from './machine-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLEANUP_REQUEST_AUDIT_FILE = path.join(__dirname, 'tmp', 'cleanup-request-audit.jsonl');
export const CLEANUP_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CLEANUP_LOCK_WAIT_SEC = 60;

/** Validate a parsed request body → { path, convoId } | null. Pure. */
export function validCleanupRequest(req, { now = Date.now(), maxAgeMs = CLEANUP_REQUEST_MAX_AGE_MS } = {}) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return null;
  const p = req.path;
  if (typeof p !== 'string' || !p || p.length > 4096 || !path.isAbsolute(p) || /[\0\n\r]/.test(p)) return null;
  if (!/^\d{1,20}$/.test(String(req.convoId ?? ''))) return null;
  if (!Number.isFinite(req.createdAt) || now - req.createdAt > maxAgeMs) return null;
  return { path: path.normalize(p), convoId: String(req.convoId) };
}

/** The one-line result shown to the requester and the owner. Pure. */
export function formatCleanupResult(r) {
  return r.ok
    ? `✅ đã xoá worktree ${r.path} (nhánh ${r.branch} giữ nguyên), lấy lại ${fmtGB(r.bytes)}`
    : `❌ giữ lại ${r.path}: ${r.reason}`;
}

/** The prompt injected into the requester's queue. Non-privileged (`fromRole: 'daemon'`). Pure. */
export function buildCleanupResultPrompt({ convoId, chatId, text, ok, path: wtPath }) {
  // The text is daemon-written but may quote file names from the worktree.
  const data = String(text).slice(0, 2000);
  const body = '🤖 Teleport daemon — kết quả cleanup-request.\n'
    + `${data}\n`
    + '→ Nếu bạn có gửi cleanup-request này: tự kể NGẮN cho user trong topic. Nếu không phải của bạn: bỏ qua.';
  return {
    text: body, messageId: null, chatId: chatId == null ? null : String(chatId),
    fromUserId: null, fromName: 'teleport daemon', fromRole: 'daemon', fromMember: null,
    replyToMessageId: null, replyToText: null, quotedText: null,
    timestamp: Math.floor(Date.now() / 1000), attachments: [], convoId: Number(convoId),
    cleanupResult: { ok: !!ok, path: wtPath, text },
  };
}

export function auditCleanupRequest(entry, file = CLEANUP_REQUEST_AUDIT_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* audit is best-effort */ }
}

/** Put a claimed `<n>.json.processing` back as `<n>.json` (retried on a later pass). */
export function unclaim(file) {
  try { fs.renameSync(file, file.replace(/\.processing$/, '')); } catch {}
}

/**
 * Handle pending cleanup requests once. Claimed files are always removed after
 * handling, EXCEPT when the `cleanup` lock stays busy: then the file is put back
 * and the pass stops (the rest stays queued, unclaimed).
 */
export async function processCleanupRequests({ daemonUserId, sendText, secretEnvKeys = [] }, {
  claim = () => claimRequests(CLEANUP_REQUEST_DIR), run = cleanupRequested, acquire = acquireLock,
  lockDir = LOCK_DIR, waitSec = CLEANUP_LOCK_WAIT_SEC, deliver = deliverResult, audit = auditCleanupRequest,
  remove = (f) => { try { fs.unlinkSync(f); } catch {} }, putBack = unclaim, label = (c) => `#${c}`,
  parentDir, deps,
} = {}) {
  // git/gh/du without the daemon's secrets in their env.
  const env = { ...process.env };
  for (const k of secretEnvKeys) delete env[k];
  const base = defaultDeps();
  const runDeps = deps ?? { ...base, exec: (cmd, args, opts = {}) => base.exec(cmd, args, { env, ...opts }) };
  for (const { file, body } of claim()) {
    let keepFile = false;
    try {
      const req = validCleanupRequest(body);
      if (!req) { console.error(`[daemon] dropped malformed/stale cleanup request ${path.basename(file)}`); continue; }
      const who = label(req.convoId);
      let lock;
      try {
        lock = await acquire('cleanup', { waitSec, dir: lockDir, label: `teleport daemon (cleanup-request ${who})`, cmd: `cleanup-request ${req.path}` });
      } catch (e) { lock = { error: e }; }
      if (lock.timeout) { keepFile = true; putBack(file); break; } // daily cleanup running → retry later
      let r;
      if (lock.error) r = { ok: false, path: req.path, reason: `không lấy được lock cleanup: ${lock.error?.message ?? lock.error}` };
      else {
        try { r = await run(req.path, { ...(parentDir ? { parentDir } : {}), deps: runDeps }); }
        finally { lock.release(); }
      }
      const text = formatCleanupResult(r);
      audit({ requester: req.convoId, path: req.path, ok: r.ok, ...(r.ok ? { branch: r.branch, pr: r.pr, bytes: r.bytes } : { reason: r.reason }) });
      try { await deliver({ convoId: req.convoId, text, ok: r.ok, path: r.path }, { build: buildCleanupResultPrompt }); }
      catch (e) { await sendText(daemonUserId, `⚠️ Không gửi được kết quả cleanup-request về ${who}: ${e?.message ?? e}`).catch(() => {}); }
      await Promise.resolve(sendText(daemonUserId, `🧹 cleanup-request của ${who}: ${text}`)).catch(() => {});
    } catch (e) {
      console.error(`[daemon] cleanup request ${path.basename(file)}: ${e?.message ?? e}`);
    } finally {
      if (!keepFile) remove(file);
    }
  }
}
