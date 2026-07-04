// `/instruct #<hash> <text>` — a daemon command (no project). Like `/whisper` but
// an OFFICIAL private channel (RFC 13): injects a prompt with `instruct:true` into
// a live topic (nothing in the group), and the target agent — unlike whisper —
// treats it as a real instruction it MAY/should answer, replying back to the owner
// via DM (`send-telegram.mjs --dm`), signing with its #hashtag so the owner can
// reply-to-continue. Use to steer an agent privately (e.g. at night) without
// spamming the group. Identity + reply-context come from the daemon via env
// (TELE_FROM_* / TELE_REPLY_TEXT). Prints a confirmation to stdout for the daemon
// to relay to the owner's DM.
//
// Same shared core as whisper (`steer.mjs`) — only the flag/usage/ack differ.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doSteer, buildSteerPrompt } from './steer.mjs';

const USAGE = 'usage: /instruct #<hash|persona|convoId> <text>  (hoặc reply tin bot/instruct trước rồi gõ /instruct <text>)';

// Exposed for tests: the instruct flavour of the shared core.
export const buildInstructPrompt = (args) => buildSteerPrompt({ ...args, flag: 'instruct' });
export const doInstruct = (argv, opts = {}) => doSteer(argv, {
  flag: 'instruct', usage: USAGE,
  ack: ({ label }) => `📩 instructed ${label} — trả lời sẽ về DM (không vào group).`,
}, opts);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const from = { id: process.env.TELE_FROM_ID, role: process.env.TELE_FROM_ROLE, name: process.env.TELE_FROM_NAME };
  const res = doInstruct(process.argv.slice(2), { from }); // replyText from TELE_REPLY_TEXT
  process.stdout.write((res.message || '') + '\n');
  process.exit(res.ok ? 0 : 1);
}
