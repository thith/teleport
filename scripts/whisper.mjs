// `/whisper #<hash> <text>` — a daemon command (no project). Injects a DISCREET
// steer into a live topic: nothing is posted in the group; the target agent
// picks it up as a prompt with `whisper:true` + the whisperer's real role (so its
// sensitive-action gate still applies) and acts on it WITHOUT announcing it (never
// replies out). Identity comes from the daemon via env (TELE_FROM_*). Prints a
// confirmation to stdout for the daemon to relay.
//
// The mode-agnostic core lives in `steer.mjs` (shared with `/instruct`, RFC 13);
// this file just declares whisper's flag/usage/ack and re-exports the helpers the
// existing `whisper.test.mjs` pins (proving the refactor kept behavior identical).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doSteer, buildSteerPrompt, projectLabelForChat, targetFromReply, REPLY_TEXT_MAX } from './steer.mjs';

export { projectLabelForChat, targetFromReply, REPLY_TEXT_MAX };

const USAGE = 'usage: /whisper #<hash|persona|convoId> <text>  (hoặc reply tin whisper trước rồi gõ /whisper <text>)';

// Back-compat shims for whisper.test.mjs (unchanged): the whisper flavour of the
// shared core.
export const buildWhisperPrompt = (args) => buildSteerPrompt({ ...args, flag: 'whisper' });
export const doWhisper = (argv, opts = {}) => doSteer(argv, {
  flag: 'whisper', usage: USAGE,
  ack: ({ label }) => `🤫 whispered to ${label} (kín, không hiện trong group).`,
}, opts);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const from = { id: process.env.TELE_FROM_ID, role: process.env.TELE_FROM_ROLE, name: process.env.TELE_FROM_NAME };
  const res = doWhisper(process.argv.slice(2), { from }); // replyText from TELE_REPLY_TEXT
  process.stdout.write((res.message || '') + '\n');
  process.exit(res.ok ? 0 : 1);
}
