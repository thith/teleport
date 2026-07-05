#!/usr/bin/env node
// render-slides.mjs (teleport, SHARED) — HTML slide deck → landscape PDF (1 slide / page).
// ZERO-DEPENDENCY: Node built-ins + headless Google Chrome only (no puppeteer / no npm install).
// The deck's index.html must set, in print CSS:
//   @page{size:1280px 720px;margin:0}   .slide{width:1280px;height:720px;break-after:page}
// so each fixed-size slide maps to one landscape page.
//
//   node ../teleport/scripts/render-slides.mjs <deck-dir> [out.pdf]
//
// Needs Google Chrome (or Chromium) installed; override path with CHROME_PATH.
// Env: SLIDE_VTB = Chrome virtual-time-budget in ms (default 12000; raise if CDN fonts/mermaid
//      need longer to render). SLIDE_CHROME_NO_SANDBOX=1 opts into --no-sandbox (CI/containers
//      only; off by default so an arbitrary deck keeps full browser isolation).
// See rules/slidecraft-guide.md for the full deck-building workflow.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const dirArg = process.argv[2];
if (!dirArg) { console.error('Usage: node render-slides.mjs <deck-dir> [out.pdf]'); process.exit(1); }
const SDIR = path.resolve(ROOT, dirArg);
if (!fs.existsSync(path.join(SDIR, 'index.html'))) { console.error('No index.html in', dirArg); process.exit(1); }
const outArg = process.argv[3] || path.join('tmp', `${path.basename(SDIR.replace(/\/+$/, ''))}.pdf`);
const outAbs = path.resolve(ROOT, outArg);

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Google Chrome/Chromium not found — install it or set CHROME_PATH.'); process.exit(1); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.gif': 'image/gif' };
const SDIR_REAL = fs.realpathSync(SDIR);
const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const fp = path.join(SDIR, rel);
  const within = path.relative(SDIR, fp);
  if (within.startsWith('..') || path.isAbsolute(within) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end(); }
  // resolve symlinks: the served file must stay inside the deck dir
  try { if (!(fs.realpathSync(fp) + '').startsWith(SDIR_REAL + path.sep)) { res.writeHead(403); return res.end(); } } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); // localhost only
const PORT = server.address().port;
fs.mkdirSync(path.dirname(outAbs), { recursive: true });

const args = [
  '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
  '--run-all-compositor-stages-before-draw', `--virtual-time-budget=${process.env.SLIDE_VTB || 12000}`,
  `--print-to-pdf=${outAbs}`, `http://127.0.0.1:${PORT}/index.html`,
];
if (process.env.SLIDE_CHROME_NO_SANDBOX) args.splice(1, 0, '--no-sandbox');

let code = -1;
try {
  code = await new Promise((resolve) => {
    const c = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    c.on('error', (e) => { console.error('Chrome spawn error:', e.message); resolve(-1); });
    c.on('exit', resolve);
  });
} finally {
  server.close();
}
if (code !== 0 || !fs.existsSync(outAbs)) { console.error('Chrome print-to-pdf failed (code', code + ')'); process.exit(1); }
console.log('wrote', path.relative(ROOT, outAbs), fs.statSync(outAbs).size, 'bytes');
