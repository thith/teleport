#!/usr/bin/env node
// md-to-html.mjs (teleport, SHARED) — chuyển tài liệu .md → HTML self-contained để
// gửi qua Telegram. Quy ước chung MỌI dự án (xem rules/telegram-guide.md): khi gửi
// FILE tài liệu cho người nhận trên Telegram, mặc định đính kèm .html (mọi người,
// kể cả dev — telegram hiển thị .md thô/bảng vỡ). Markdown vẫn là SOURCE OF TRUTH
// trong repo; HTML chỉ là artifact build ra để chia sẻ — KHÔNG commit (xuất ra tmp/).
//
// Chạy theo CWD của repo gọi nó (không phải vị trí script):
//   node ../teleport/scripts/md-to-html.mjs <file.md|dir...>  # build từng file/thư mục (resolve theo cwd)
//   node ../teleport/scripts/md-to-html.mjs                   # build mọi .md trong repo (cwd), skip tmp/node_modules/.git
//
// Output: <cwd>/tmp/tele-html/<đường-dẫn-tương-đối>.html  (nhớ gitignore tmp/).
// Gửi: send-telegram.mjs --file <...>.html (KHÔNG gửi path/.md dạng text).
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tmp/tele-html');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** HTML artifact để gửi qua Telegram. Render markdown bằng marked (CDN); nếu CDN bị chặn/offline
 *  → hiển thị RAW markdown ngay (luôn đọc được, KHÔNG kẹt "đang tải"). KHÔNG phải self-contained
 *  tuyệt đối (cần mạng để render đẹp) — trên điện thoại / Telegram webview có mạng nên OK. */
const tpl = (title, md) => `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:0 auto;padding:16px;line-height:1.6;color:#222}
h1,h2,h3{line-height:1.3}h1{font-size:1.5rem}h2{font-size:1.25rem;border-bottom:1px solid #eee;padding-bottom:4px}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:.9rem}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f5f5f7}code{background:#f0f0f0;padding:1px 4px;border-radius:3px}
blockquote{border-left:3px solid #c9a9ff;margin:0;padding:4px 12px;background:#faf7ff;color:#555}
#r{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;margin:0}
</style></head><body>
<div id="c"><pre id="r"></pre></div>
<script>const md=${JSON.stringify(md).replace(/</g, '\\u003c')};
document.getElementById('r').textContent=md;</script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>try{if(window.marked)document.getElementById('c').innerHTML=marked.parse(md);}catch(e){}</script>
</body></html>`;

/** Tiêu đề: H1 đầu tiên trong md, fallback tên file. */
function titleOf(md, file) {
  const h1 = md.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : path.basename(file, '.md');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'dist', '.next']);
/** Liệt kê mọi .md dưới dir (đệ quy), bỏ qua node_modules/.git/tmp… */
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory() && SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function convert(srcAbs) {
  const md = fs.readFileSync(srcAbs, 'utf8');
  // Đường dẫn output mirror theo vị trí tương đối so với cwd. File ngoài cwd → nest dưới
  // _external/<full-path> để KHÔNG trùng tên (tránh ghi đè khi nhiều file cùng basename).
  let rel = path.relative(ROOT, srcAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    rel = path.join('_external', path.relative(path.parse(srcAbs).root, srcAbs));
  }
  const outAbs = path.join(OUT_DIR, rel.replace(/\.md$/, '.html'));
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, tpl(titleOf(md, srcAbs), md));
  console.log('wrote', path.relative(ROOT, outAbs), fs.statSync(outAbs).size, 'bytes');
  return outAbs;
}

const args = process.argv.slice(2);
let files;
if (args.length) {
  // Mỗi arg: file .md → dùng thẳng; thư mục → walk lấy mọi .md bên trong.
  files = args.flatMap((a) => {
    const abs = path.resolve(ROOT, a);
    const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
    if (!st) { console.error('Bỏ qua (không tồn tại):', a); return []; }
    if (st.isDirectory()) return walk(abs);
    if (!abs.endsWith('.md')) { console.error('Bỏ qua (không phải .md):', a); return []; }
    return [abs];
  });
} else {
  // Không tham số: build mọi .md trong repo (cwd), bỏ qua tmp/node_modules/.git…
  files = walk(ROOT);
}

if (!files.length) {
  console.error('Không có file .md để chuyển. Truyền đường dẫn file/thư mục, hoặc chạy trong repo có .md.');
  process.exit(1);
}
for (const f of files) convert(f);
console.log(`\nXong ${files.length} file → ${path.relative(ROOT, OUT_DIR)}/  (đính kèm .html khi gửi, KHÔNG gửi path)`);
