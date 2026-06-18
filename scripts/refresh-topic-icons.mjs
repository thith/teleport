#!/usr/bin/env node
// refresh-topic-icons.mjs — làm mới danh sách custom emoji hợp lệ cho forum topic icon
// (Bot API getForumTopicIconStickers — KHÔNG cần premium). Ghi vào ../topic-icon-stickers.json
// để khỏi phải gọi API mỗi lần thêm project mới vào projects.json (topicIcon.emoji).
//
//   node scripts/refresh-topic-icons.mjs
//
// Token đọc từ teleport/.env (REPORT_BOT_TOKEN) — KHÔNG in token ra.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(dir, '..', '.env');
const outPath = path.join(dir, '..', 'topic-icon-stickers.json');

const env = fs.readFileSync(envPath, 'utf8');
const m = env.match(/^REPORT_BOT_TOKEN=(.*)$/m);
const token = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
if (!token) {
  console.error('Không tìm thấy REPORT_BOT_TOKEN trong .env');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getForumTopicIconStickers`);
const data = await res.json();
if (!data.ok) {
  console.error('API lỗi:', JSON.stringify(data).slice(0, 200));
  process.exit(1);
}

// Giữ lại _assigned cũ nếu file đã tồn tại.
let assigned = { luni: '🤖', 'digesty-frontend': '🎨', 'digesty-worker': '⚡️', 'digesty-hub': '📚' };
try { assigned = JSON.parse(fs.readFileSync(outPath, 'utf8'))._assigned ?? assigned; } catch {}

const emojiToId = Object.fromEntries(data.result.map((s) => [s.emoji, s.custom_emoji_id]));
const out = {
  _note: 'Custom emoji IDs hợp lệ cho topicIcon.emoji (forum topic icon) — Bot API getForumTopicIconStickers, KHÔNG cần premium. Refresh: node scripts/refresh-topic-icons.mjs',
  _assigned: assigned,
  emojiToId,
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('saved topic-icon-stickers.json —', Object.keys(emojiToId).length, 'emoji');
