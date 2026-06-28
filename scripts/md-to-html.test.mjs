import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, inlineMd, mdToHtml, tpl } from './md-to-html.mjs';

// ===== Security: XSS / URL scheme =====
test('XSS: javascript: link scheme bị vô hiệu hoá', () => {
  const h = inlineMd('[x](javascript:alert(1))');
  assert.ok(!/javascript:/i.test(h), h);
  assert.match(h, /href="#"/);
});
test('XSS: data: image scheme bị vô hiệu hoá', () => {
  const h = inlineMd('![x](data:text/html,<script>alert(1)</script>)');
  assert.ok(!/data:text\/html/i.test(h), h);
});
test('XSS: scheme có control-char chèn (java\\x01script:) vẫn chặn', () => {
  assert.equal(safeUrl('java\x01script:alert(1)'), '#');
});
test('XSS: html trong text bị escape', () => {
  assert.match(inlineMd('a <script>b</script> c'), /&lt;script&gt;/);
});
test('XSS: code fence escape, KHÔNG để lọt <script>', () => {
  const h = mdToHtml('```\n<script>x</script>\n```');
  assert.ok(!/<script>/.test(h), h);
  assert.match(h, /<pre><code>&lt;script&gt;/);
});
test('XSS: ko thẻ <script> nào trong output của renderer', () => {
  const h = mdToHtml('# Hi\n\n```\nalert(1)\n```\n\n[x](javascript:bad) **b** _i_');
  assert.ok(!/<script/i.test(h), h);
});

// ===== safeUrl behaviour =====
test('safeUrl: cho phép path tương đối + http; & được esc', () => {
  assert.equal(safeUrl('../a/b.md'), '../a/b.md');
  assert.equal(safeUrl('#frag'), '#frag');
  assert.equal(safeUrl('https://x.com?a=1&b=2'), 'https://x.com?a=1&amp;b=2');
  assert.equal(safeUrl('mailto:a@b.com'), 'mailto:a@b.com');
});
test('safeUrl: URL lone-surrogate KHÔNG throw (chống C2 crash)', () => {
  assert.doesNotThrow(() => safeUrl('\uD800'));
  assert.doesNotThrow(() => inlineMd('[x](\uD800)'));
});

// ===== Correctness: inline =====
test('intraword underscore KHÔNG bị italic (snake_case, 307_2)', () => {
  assert.equal(inlineMd('snake_case_id and 307_2'), 'snake_case_id and 307_2');
});
test('italic + bold render đúng', () => {
  assert.match(inlineMd('_a_ and **b**'), /<em>a<\/em> and <strong>b<\/strong>/);
  assert.match(inlineMd('*x* and __y__'), /<em>x<\/em> and <strong>y<\/strong>/);
});
test('italic span CÓ underscore intraword bên trong (307_2) vẫn full italic', () => {
  assert.match(inlineMd('_TBD 307_2 hết_'), /<em>TBD 307_2 hết<\/em>/);
});
test('code span được escape', () => {
  assert.match(inlineMd('`<b>`'), /<code>&lt;b&gt;<\/code>/);
});
test('chữ số tài liệu KHÔNG bị stash-sentinel nuốt', () => {
  const h = inlineMd('see [a](http://x) and `c` then 0 1 2');
  assert.match(h, /then 0 1 2/);
});
test('link giữ target="_blank" (ko bị emphasis phá _blank)', () => {
  assert.match(inlineMd('[a](../x.md) [b](../y.md)'), /target="_blank"/);
  assert.ok(!/<em>blank/.test(inlineMd('[a](../x.md) [b](../y.md)')));
});

// ===== Correctness: block =====
test('heading + hr', () => {
  assert.match(mdToHtml('# Title'), /<h1>Title<\/h1>/);
  assert.match(mdToHtml('---'), /<hr>/);
});
test('nested list', () => {
  assert.match(mdToHtml('- a\n  - b\n- c'), /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li>c<\/li><\/ul>/);
});
test('ordered list', () => {
  assert.match(mdToHtml('1. a\n2. b'), /<ol><li>a<\/li><li>b<\/li><\/ol>/);
});
test('table render header + rows', () => {
  const h = mdToHtml('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(h, /<table><thead><tr><th>A<\/th><th>B<\/th>/);
  assert.match(h, /<tbody><tr><td>1<\/td><td>2<\/td>/);
});
test('blockquote', () => {
  assert.match(mdToHtml('> hi\n> there'), /<blockquote>.*hi<br>there.*<\/blockquote>/);
});

// ===== Reliability: ReDoS guard =====
test('ReDoS: chuỗi underscore bệnh lý hoàn tất nhanh (<500ms)', () => {
  const evil = '_' + 'a_'.repeat(8000);
  const t0 = process.hrtime.bigint();
  inlineMd(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `mất ${ms}ms`);
});
test('ReDoS: chuỗi sao bệnh lý hoàn tất nhanh', () => {
  const evil = '*' + 'a*'.repeat(8000);
  const t0 = process.hrtime.bigint();
  inlineMd(evil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `mất ${ms}ms`);
});

// ===== Round-2 review fixes =====
test('SEN: \\x01 thô trong input KHÔNG giả mạo được placeholder', () => {
  // doc chứa \x01 + số → ko được splice slot; phải ra text trơn (đã tước \x01)
  const h = inlineMd('lorem \x010\x01 ipsum');
  assert.ok(!/undefined/.test(h), h);
  assert.match(h, /lorem 0 ipsum/);
});
test('emphasis dài (>600, <5000) VẪN render (chống M2 truncate)', () => {
  const long = 'x'.repeat(1200);
  assert.match(inlineMd(`**${long}**`), new RegExp(`<strong>${long}</strong>`));
  assert.match(inlineMd(`_${long}_`), new RegExp(`<em>${long}</em>`));
});
test('scheme UPPERCASE/mixed + vbscript bị chặn (khoá /i + allowlist)', () => {
  assert.equal(safeUrl('JAVASCRIPT:alert(1)'), '#');
  assert.equal(safeUrl('JaVaScRiPt:alert(1)'), '#');
  assert.equal(safeUrl('vbscript:msgbox(1)'), '#');
  assert.equal(safeUrl('VBScript:x'), '#');
});
test('bảng: cell có pipe escaped \\| KHÔNG bị tách', () => {
  const h = mdToHtml('| A | B |\n|---|---|\n| x \\| y | z |');
  assert.match(h, /<td>x \| y<\/td><td>z<\/td>/);
});
test('tpl: artifact có CSP meta (default-src none) + ko <script>', () => {
  const html = tpl('Tiêu đề', '# H\n\n[a](javascript:x) `<b>`');
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  assert.ok(!/<script/i.test(html), html);
  assert.ok(!/javascript:/i.test(html), html);
});
