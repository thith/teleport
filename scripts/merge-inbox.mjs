// merge-inbox.mjs — the daemon side of agent merge requests (see merge-request.mjs).
//
// Each daemon loop claims request files from scripts/tmp/merge-requests/ and:
//   • AUTO   — auto-merge is ON (owner's /automerge switch) and every PR's repo
//              belongs to a project in projects.json → merge.mjs runs right away;
//   • ASK    — otherwise → the owner gets the usual preview + [Merge] [Close] [Huỷ];
// then the result is injected into the requesting agent's prompt queue
// (`mergeResult`) and the owner gets a one-line FYI for auto merges.
//
// Pure helpers live here (unit-tested); daemon.mjs wires them into its loop.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePrUrl } from './merge.mjs';
import { projectEntries } from './projects-config.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { durableWrite } from './steer.mjs';
import { DEFAULT_TMP_DIR } from './tele-listen.mjs';
import { MERGE_REQUEST_DIR } from './merge-request.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUTOMERGE_STATE_FILE = path.join(__dirname, 'tmp', 'automerge-state.json');
export const AUTOMERGE_AUDIT_FILE = path.join(__dirname, 'tmp', 'automerge-audit.jsonl');
export const REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── Auto-merge switch (default OFF; the owner turns it on with /automerge on) ──

export function readAutoMerge(file = AUTOMERGE_STATE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).enabled === true; } catch { return false; }
}
export function writeAutoMerge(enabled, file = AUTOMERGE_STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ enabled: !!enabled, at: new Date().toISOString() }) + '\n');
}

// ── Allowlist: the GitHub repos of the projects in projects.json ──────────────

/** `owner/name` (lower-case) from a git remote URL (https or ssh), else null. Pure. */
export function repoFromRemote(url) {
  const m = String(url ?? '').trim().match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * Repos of every project key in projects.json whose folder exists under the
 * workspace root (its `origin` remote). `remoteOf(dir)` is injectable.
 */
export function allowedRepos(projectsConfig, {
  parentDir, exists = (d) => fs.existsSync(path.join(d, '.git')),
  remoteOf = (d) => String(execFileSync('git', ['-C', d, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })),
} = {}) {
  const out = new Set();
  for (const [key] of projectEntries(projectsConfig || {})) {
    if (!/^[A-Za-z0-9._-]+$/.test(key) || key === '.' || key === '..') continue;
    const dir = path.join(parentDir, key);
    if (!exists(dir)) continue;
    let repo = null;
    try { repo = repoFromRemote(remoteOf(dir)); } catch { /* no remote */ }
    if (repo) out.add(repo);
  }
  return out;
}

/** 'auto' when the switch is on and EVERY link's repo is allowed; else 'ask'. Pure. */
export function decideRequest(links, { autoEnabled, allowed }) {
  if (!autoEnabled) return { mode: 'ask', reason: 'auto-merge is off' };
  const outside = links.map((l) => parsePrUrl(l)?.repo?.toLowerCase()).filter((r) => !r || !allowed.has(r));
  if (outside.length) return { mode: 'ask', reason: `not a projects.json repo: ${[...new Set(outside.map((r) => r || '?'))].join(', ')}` };
  return { mode: 'auto' };
}

/** Validate a parsed request body → { links, convoId } | null. Pure. */
export function validRequest(req, { now = Date.now(), maxAgeMs = REQUEST_MAX_AGE_MS } = {}) {
  if (!req || typeof req !== 'object' || !Array.isArray(req.links) || !req.links.length || req.links.length > 20) return null;
  if (!req.links.every((l) => typeof l === 'string' && parsePrUrl(l))) return null;
  if (!/^\d{1,20}$/.test(String(req.convoId ?? ''))) return null;
  if (typeof req.createdAt === 'number' && now - req.createdAt > maxAgeMs) return null;
  return { links: [...new Set(req.links)], convoId: String(req.convoId) };
}

/**
 * Claim pending requests: atomic rename `<n>.json` → `<n>.json.processing` (a
 * second daemon or a re-run can't take the same file). Returns [{ file, body }]
 * with body = parsed JSON or null if unreadable. Caller deletes when done.
 */
export function claimRequests(dir = MERGE_REQUEST_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d+-[0-9a-f]+\.json$/.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const src = path.join(dir, n), dst = `${src}.processing`;
    try { fs.renameSync(src, dst); } catch { continue; }
    let body = null;
    try { body = JSON.parse(fs.readFileSync(dst, 'utf8')); } catch { /* unreadable → body null */ }
    out.push({ file: dst, body });
  }
  return out;
}

// ── Delivering the result to the requesting agent ─────────────────────────────

/** The prompt injected into the requester's queue. Non-privileged (`fromRole: 'daemon'`). Pure. */
export function buildMergeResultPrompt({ convoId, chatId, text, mode }) {
  const body = `🤖 Teleport daemon — kết quả merge-request của bạn (${mode === 'auto' ? 'tự merge' : 'owner đã bấm nút'}):\n\n${text}\n\n→ Tự kể NGẮN cho user trong topic của bạn (không cần nhờ user làm gì thêm).`;
  return {
    text: body, messageId: null, chatId: chatId == null ? null : String(chatId),
    fromUserId: null, fromName: 'teleport daemon', fromRole: 'daemon', fromMember: null,
    replyToMessageId: null, replyToText: null, quotedText: null,
    timestamp: Math.floor(Date.now() / 1000), attachments: [], convoId: Number(convoId),
    mergeResult: { mode, text },
  };
}

/** The group chat a convo's topic lives in (topics store), or null. Pure. */
export function chatOfConvo(convoId, store) {
  for (const [chatId, entry] of Object.entries(store || {})) {
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, String(convoId))) return chatId;
  }
  return null;
}

export async function deliverResult({ convoId, text, mode }, {
  store = readTopicsStore(), tmpDir = DEFAULT_TMP_DIR, write = durableWrite,
} = {}) {
  const chatId = chatOfConvo(convoId, store);
  const prompt = buildMergeResultPrompt({ convoId, chatId, text, mode });
  await write(prompt, path.join(tmpDir, `prompt-convo-${convoId}.json`));
  return { chatId };
}

export function auditAutoMerge(entry, file = AUTOMERGE_AUDIT_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* audit is best-effort */ }
}
