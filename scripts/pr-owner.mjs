// pr-owner.mjs — who owns a PR (RFC 31): the first convo that explicitly sent its
// link (a merge-request, or a message in its own topic). Used only to choose where
// the daemon delivers a merge/close result after the owner's /m — never for access.
//
// Ledger tmp/pr-owners.json = { "<lowercased PR url>": { convoId, src, ts } }.
// First record per URL wins and is never overwritten; no eviction (a cap would let
// a later re-poster take over an old PR). Read-modify-write under a flock helper
// lock; best-effort (a busy lock or any error just skips the record).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireHelperLock } from './machine-lock.mjs';
import { readTopicsStore } from './topics-store.mjs';
import { chatOfConvo } from './merge-inbox.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PR_OWNERS_FILE = path.join(__dirname, 'tmp', 'pr-owners.json');
export const PR_OWNERS_LOCK = 'pr-owners';
export const PR_OWNERS_LOCK_WAIT_MS = 2000;
const PR_URL_RE = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/gi;

/** Ledger key: lowercased, always https (GitHub's own pr.url is https; a typed http:// link is the same PR). Pure. */
export const prKey = (u) => String(u).toLowerCase().replace(/^http:\/\//, 'https://');

/** Every PR URL in `text` (up to the PR number), keyed by prKey, de-duplicated. MarkdownV2 escapes (`--raw`: `github\.com`, `my\-repo`) are undone first. Pure. */
export function extractPrUrls(text) {
  return [...new Set((String(text ?? '').replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1').match(PR_URL_RE) || []).map(prKey))];
}

const readLedger = (file) => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
};

/**
 * Record `convoId` as the owner of every URL in `urls` that has none yet.
 * → number of new records (0 on a busy lock / any error). Never throws.
 */
export async function recordPrOwners(urls, convoId, src, {
  file = PR_OWNERS_FILE, lockDir, now = Date.now, waitMs = PR_OWNERS_LOCK_WAIT_MS,
} = {}) {
  let release = null;
  try {
    const list = [...new Set((urls || []).map(prKey))];
    if (!list.length || !/^\d{1,20}$/.test(String(convoId ?? ''))) return 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    release = await acquireHelperLock(PR_OWNERS_LOCK, { ...(lockDir ? { dir: lockDir } : {}), waitMs, pollMs: 50 });
    if (!release) return 0;
    const ledger = readLedger(file);
    let added = 0;
    for (const u of list) {
      if (Object.prototype.hasOwnProperty.call(ledger, u)) continue;
      ledger[u] = { convoId: String(convoId), src, ts: now() };
      added++;
    }
    if (!added) return 0;
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    fs.renameSync(tmp, file);
    return added;
  } catch { return 0; } finally { try { release?.(); } catch {} }
}

/** → { convoId, src } for the PR's recorded owner, only if that convo still has a topic; else null. */
export function findPrOwner(url, { store, file = PR_OWNERS_FILE } = {}) {
  try {
    const rec = readLedger(file)[prKey(url)];
    if (!rec || !/^\d{1,20}$/.test(String(rec.convoId ?? ''))) return null;
    if (chatOfConvo(rec.convoId, store ?? readTopicsStore()) == null) return null;
    return { convoId: String(rec.convoId), src: rec.src };
  } catch { return null; }
}

/** Record the PR links found in `text` for `convoId`. Best-effort, never throws. */
export async function recordPrOwnersFromText(text, convoId, src, opts = {}) {
  try { return await recordPrOwners(extractPrUrls(text), convoId, src, opts); } catch { return 0; }
}
