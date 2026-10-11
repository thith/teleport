// merge-request.mjs — an AGENT asks the teleport daemon to merge its PR(s).
//
//   node ../teleport/scripts/merge-request.mjs <PR URL> [<PR URL> …]
//
// Writes a request into the daemon's file inbox (scripts/tmp/merge-requests/).
// The daemon then either merges it right away (auto-merge ON and every PR's repo
// is in the owner's explicit auto-merge list) or asks the owner with [Merge] [Close]
// [Huỷ] buttons. Either way the RESULT comes back to the requesting agent's own
// topic as a prompt (field `mergeResult`) — the agent never posts the PR to the
// user and waits for a typed command.
//
// Authority: this script grants nothing. The requester's convo is taken from the
// session env and is used ONLY to route the result back; whether a merge happens
// is decided by the daemon (owner's auto-merge switch + repo allowlist, or the
// owner's button tap) and every /merge check still applies.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { resolveConvoIdFromEnv } from './convo-registry.mjs';
import { parsePrUrl } from './merge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MERGE_REQUEST_DIR = path.join(__dirname, 'tmp', 'merge-requests');
export const USAGE = 'usage: node ../teleport/scripts/merge-request.mjs <PR URL> [<PR URL> …]   (run inside your agent session)';

/** argv → { links } | { error }. Pure. */
export function parseRequestArgs(argv) {
  const links = [];
  for (const a of argv) {
    if (!parsePrUrl(a)) return { error: `not a GitHub PR URL: ${JSON.stringify(a)}\n${USAGE}` };
    if (!links.includes(a)) links.push(a);
  }
  if (!links.length) return { error: USAGE };
  return { links };
}

/** Atomically drop one request file (write temp, then rename) → its path. */
export function writeRequest({ links, convoId, dir = MERGE_REQUEST_DIR, now = Date.now() }) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${now}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = path.join(dir, `.${name}.tmp`);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ links, convoId: String(convoId), createdAt: now }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

if (isMainModule(import.meta.url)) {
  const args = parseRequestArgs(process.argv.slice(2));
  if (args.error) { console.error(`[merge-request] ${args.error}`); process.exit(2); }
  const { convoId } = resolveConvoIdFromEnv({ argConvo: null });
  if (convoId == null) { console.error('[merge-request] no session convo (run inside your agent session) — the result could not be routed back.'); process.exit(2); }
  writeRequest({ links: args.links, convoId });
  console.log(`[merge-request] queued ${args.links.length} PR(s). The daemon merges it (auto-merge) or asks the owner with buttons; the result comes back to your topic as a prompt (mergeResult). Don't ask the user to type /merge.`);
}
