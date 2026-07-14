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
import { isMainModule } from './is-direct-run.mjs';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tmp/tele-html');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// URL an toàn cho href/src: bỏ control char → chặn scheme nguy hiểm (javascript:/data:/vbscript:…) chỉ cho
// http(s)/mailto/tel + path tương đối/fragment → esc cho ngữ cảnh attribute. KHÔNG encodeURI (tránh throw
// lone-surrogate + double-encode `%20`→`%2520`). Output mở trên browser/webview người nhận nên BẮT BUỘC sạch XSS.
function safeUrl(u) {
  const t = String(u).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (/^[a-z][a-z0-9+.\-]*:/i.test(t) && !/^(?:https?|mailto|tel):/i.test(t)) return '#';
  return esc(t);
}

// ===== Markdown → HTML renderer (zero-dep, render NGAY trong Node) =====
// Vì sao server-side: Telegram quickview trên iOS chặn <script> + ko fetch CDN → bản cũ
// (render bằng marked qua CDN trên client) hiện TRANG TRẮNG trên iOS (Android chạy JS nên OK).
// → xuất HTML TĨNH, KHÔNG script, KHÔNG CDN: mở được trên MỌI nền (iOS/Android/desktop).
// Phủ cú pháp dùng trong specs/RFC/docs: heading, bold/italic, code (span + fence), link, ảnh,
// list (lồng), bảng, blockquote, hr, đoạn. Input = .md TIN CẬY trong repo (ko phải user ngoài).
// Giới hạn ĐÃ BIẾT (chấp nhận, vì docs nội bộ): không nest emphasis sâu (vd `**a *b* c**`), list
// "loose" (item cách nhau dòng trống) bị tách, `\|` escaped trong bảng chưa unescape. Đủ cho tài liệu.

const EMPH_CAP = 5000; // chặn độ dài 1 nhịp emphasis: đủ rộng cho MỌI câu doc thực, vẫn chặn O(n²) backtracking (ReDoS)
/** Bold rồi italic (chỉ trên text thường, sau khi đã esc + stash code/link/ảnh). */
function emph(s) {
  return s
    .replace(new RegExp(`\\*\\*([^*]{1,${EMPH_CAP}})\\*\\*`, 'g'), '<strong>$1</strong>')
    .replace(new RegExp(`__([^_]{1,${EMPH_CAP}})__`, 'g'), '<strong>$1</strong>')
    .replace(new RegExp(`(^|[^*])\\*([^*\\s][^*]{0,${EMPH_CAP}}?)\\*`, 'g'), '$1<em>$2</em>')
    .replace(new RegExp(`(^|[^_\\w])_([^\\s_](?:[^_]|_(?=\\w)){0,${EMPH_CAP}}?)_(?!\\w)`, 'g'), '$1<em>$2</em>');
}
/** Inline: STASH code/ảnh/link thành placeholder (SEN<idx>SEN, miễn nhiễm emphasis) → esc+emph phần
 *  text còn lại → khôi phục. Tránh gạch-dưới trong URL (vd `target="_blank"`) bị emphasis biến thành <em>. */
function inlineMd(s) {
  const slots = [];
  const SEN = '\x01'; // sentinel control-char NGOÀI bộ ký tự markdown — sống sót qua esc + emphasis,
  //                       ko đụng chữ số tài liệu (KHÔNG để rỗng — rỗng thì regex khôi phục nuốt mọi số)
  const stash = (html) => { slots.push(html); return SEN + (slots.length - 1) + SEN; };
  s = String(s)
    .replace(/\x01/g, '') // tước SEN thô từ input → ko thể giả mạo placeholder (vd doc tự nói về sentinel này)
    .replace(/`([^`]+)`/g, (_m, c) => stash(`<code>${esc(c)}</code>`))
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, a, u) => stash(`<img alt="${esc(a)}" src="${safeUrl(u)}">`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, t, u) => stash(`<a href="${safeUrl(u)}" target="_blank" rel="noopener">${emph(esc(t))}</a>`));
  s = emph(esc(s));
  // guard slot tồn tại → kể cả nếu lọt placeholder lạ, giữ nguyên thay vì splice undefined
  return s.replace(new RegExp(SEN + '(\\d+)' + SEN, 'g'), (_m, n) => (slots[n] !== undefined ? slots[n] : _m));
}
// Tách cell bảng theo `|` KHÔNG escaped (`\|` là pipe literal trong cell) rồi unescape.
const ROW = (l) => l.replace(/^\s*\|?/, '').replace(/(?<!\\)\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
function isBlockStart(l) {
  return /^\s*(#{1,6}\s|>|`{3,}|([-*+]|\d+[.)])\s|([-*_])(\s*\3){2,}\s*$)/.test(l);
}
/** List (ordered/unordered) có lồng theo thụt lề; trả [html, nextIndex]. */
function parseList(lines, start) {
  const base = lines[start].match(/^(\s*)/)[1].length;
  const tag = /^\s*\d+[.)]\s+/.test(lines[start]) ? 'ol' : 'ul';
  let html = `<${tag}>`, i = start;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!m) break;
    const indent = m[1].length;
    if (indent < base) break;
    if (indent > base) { // sub-list lồng → gắn vào <li> trước; nếu chưa có <li> (item đầu thụt sâu) → bọc 1 <li>
      const [sub, ni] = parseList(lines, i);
      html = /<\/li>$/.test(html) ? html.replace(/<\/li>$/, sub + '</li>') : html + '<li>' + sub + '</li>';
      i = ni; continue;
    }
    html += `<li>${inlineMd(m[3])}</li>`; i++;
  }
  return [html + `</${tag}>`, i];
}
function mdToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*`{3,}/.test(line)) { // code fence
      const buf = []; i++;
      while (i < lines.length && !/^\s*`{3,}\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>'); continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inlineMd(h[2].trim().replace(/\s+#+\s*$/, ''))}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:]*-{1,}/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      const header = ROW(line); i += 2; const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) { rows.push(ROW(lines[i])); i++; }
      let t = '<table><thead><tr>' + header.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of rows) t += '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>';
      out.push(t + '</tbody></table>'); continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + mdToHtml(buf.join('\n')) + '</blockquote>'); continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { const [html, ni] = parseList(lines, i); out.push(html); i = ni; continue; }
    const buf = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
    out.push('<p>' + inlineMd(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
  }
  return out.join('\n');
}

/** HTML artifact TĨNH (KHÔNG script, KHÔNG CDN) → mở được trên iOS/Android/desktop offline. */
const tpl = (title, md) => `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src * data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:0 auto;padding:16px;line-height:1.6;color:#222}
h1,h2,h3,h4,h5,h6{line-height:1.3}h1{font-size:1.5rem}h2{font-size:1.25rem;border-bottom:1px solid #eee;padding-bottom:4px}h3{font-size:1.1rem}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:.9rem}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f5f5f7}code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:.9em}
pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow-x:auto}pre code{background:none;padding:0}
blockquote{border-left:3px solid #c9a9ff;margin:0 0 12px;padding:4px 12px;background:#faf7ff;color:#555}
a{color:#0969da}img{max-width:100%}ul,ol{padding-left:24px}hr{border:none;border-top:1px solid #ddd;margin:16px 0}
</style></head><body>
${mdToHtml(md)}
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

function main() {
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
}

// Chỉ chạy CLI khi gọi trực tiếp (node md-to-html.mjs …) — import từ test KHÔNG kích hoạt side-effect.
if (isMainModule(import.meta.url)) main();

export { esc, safeUrl, emph, inlineMd, ROW, isBlockStart, parseList, mdToHtml, titleOf, tpl };
