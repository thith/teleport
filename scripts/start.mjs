// `/start` — Telegram bot onboarding help. A daemon command: prints the help
// text to stdout; the daemon relays it to the chat. Public (no role gate).
export const START_BODY = [
  '👋 Teleport bot — it bridges you and your AI coding agents (Claude / Codex / Gemini …) over Telegram.',
  '',
  'How it works:',
  '• Tell your agent “tele me” / “report on Telegram when done” before you step away.',
  '• When it finishes — or needs a decision — it posts in its own topic (one per conversation, named after a persona).',
  '• Just type in that topic to steer it — the agent reads whatever lands in its topic on the next poll.',
  '',
  'Quick setup:',
  '1. Create a group and enable Topics (this turns it into a forum supergroup).',
  '2. Add this bot, make it an admin, then turn OFF every admin permission except “Manage Topics”.',
  '3. Add your teammates too if you want a shared team group.',
  '4. Then configure the group + .env — details: https://github.com/thith/teleport',
  '',
  '— Created by digesty.vn team and agents',
].join('\n');

import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(START_BODY + '\n');
}
