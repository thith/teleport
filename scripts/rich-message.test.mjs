import { test } from 'node:test';
import assert from 'node:assert/strict';
import { richMessageText, richInlineText, richBlocksText, messageText, buildPromptData, buildCombinedPromptData, filterAdminMessages } from './tele-listen.mjs';

// Telegram's EXPANDED editor sends `rich_message.blocks[]` and NO `text`/`caption`.
// Everything used to read `text ?? caption`, so such a message looked empty:
// hasUserContent rejected it → no 👍, never delivered, and the poll offset advanced
// past it → lost for good. This fixture keeps the exact SHAPE of a real payload captured from the
// updates cache (message 1613), not an invented shape.
const REAL_RICH_MSG = {
  message_id: 1613,
  from: { id: 100000001, is_bot: false, first_name: 'Alice', username: 'alice_admin' },
  chat: { id: -1001234567890, title: 'Team Chat', is_forum: true, type: 'supergroup' },
  date: 1786901754,
  message_thread_id: 1349,
  rich_message: {
    blocks: [
      { type: 'paragraph', text: 'Drop the ' },
      { type: 'heading', text: 'Concrete numbers', size: 3 },
      { type: 'paragraph', text: '' },
      { type: 'paragraph', text: 'Resend without commentary' },
    ],
  },
  is_topic_message: true,
};

test('richMessageText: blocks flattened, empty spacers dropped, heading level kept', () => {
  assert.equal(
    richMessageText(REAL_RICH_MSG.rich_message),
    'Drop the\n\n### Concrete numbers\n\nResend without commentary',
  );
  assert.equal(richMessageText(null), null);
  assert.equal(richMessageText({ blocks: [] }), null);
  assert.equal(richMessageText({ blocks: [{ type: 'paragraph', text: '   ' }] }), null);
  assert.equal(richMessageText({ blocks: [{ type: 'list', items: ['a', 'b'] }] }), '- a\n- b');
  assert.equal(richMessageText({ blocks: [{ type: 'code', text: 'x=1' }] }), '```\nx=1\n```');
});

test('messageText: text and caption still win; rich_message is the fallback', () => {
  assert.equal(messageText({ text: 'plain' }), 'plain');
  assert.equal(messageText({ caption: 'cap' }), 'cap');
  assert.match(messageText(REAL_RICH_MSG), /^Drop the/);
  assert.equal(messageText({}), '');
});

test('THE BUG: a rich-text message is no longer filtered out as empty', () => {
  const updates = [{ update_id: 1, message: REAL_RICH_MSG }];
  const kept = filterAdminMessages(updates, ['-1001234567890'], null, 'convo', new Map([['-1001234567890', 1349]]));
  assert.equal(kept.length, 1, 'must survive the filter — otherwise: no 👍, never delivered, offset advances, lost');
});

test('a rich-text message reaches the prompt with its text intact', () => {
  const d = buildPromptData(REAL_RICH_MSG, null, null, null);
  assert.match(d.text, /Concrete numbers/);
  assert.equal(d.messages[0].text, d.text);
  const batch = buildCombinedPromptData([{ msg: REAL_RICH_MSG }, { msg: { ...REAL_RICH_MSG, message_id: 1614 } }], null, null, null);
  assert.equal((batch.text.match(/Concrete numbers/g) || []).length, 2);
});

// The SECOND real payload the owner sent (message 1620) — dropped again by the
// first fix, because a block's `text` is not always a string: it can be an ARRAY
// mixing strings with nested `{type:'bold'|'underline'|…, text}` nodes, nested
// arbitrarily deep. Two real samples, two different shapes of the same field.
const REAL_NESTED_MSG = {
  message_id: 1620,
  from: { id: 100000001, is_bot: false, first_name: 'Alice' },
  chat: { id: -1001234567890, is_forum: true, type: 'supergroup' },
  date: 1786905000,
  message_thread_id: 1565,
  rich_message: {
    blocks: [{
      type: 'paragraph',
      text: [
        'Ok nhưng ',
        { type: 'bold', text: { type: 'underline', text: 'câu này lồng sâu nhiều lớp ' } },
        'đấy? ',
      ],
    }],
  },
  is_topic_message: true,
};

test('richInlineText: nested inline formatting is flattened, not dropped', () => {
  assert.equal(richInlineText('plain'), 'plain');
  assert.equal(richInlineText(['a', 'b']), 'ab');
  assert.equal(richInlineText({ type: 'bold', text: { type: 'underline', text: 'deep' } }), 'deep');
  assert.equal(richInlineText(null), '');
  assert.equal(richInlineText({ type: 'list', items: ['x'] }), '');   // no `text` → nothing to take
});

test('THE SECOND BUG: a formatted (bold/underline) rich message survives too', () => {
  assert.equal(messageText(REAL_NESTED_MSG), 'Ok nhưng câu này lồng sâu nhiều lớp đấy?');
  const kept = filterAdminMessages([{ update_id: 2, message: REAL_NESTED_MSG }], ['-1001234567890'], null, 'convo', new Map([['-1001234567890', 1565]]));
  assert.equal(kept.length, 1);
  assert.match(buildPromptData(REAL_NESTED_MSG, null, null, null).text, /lồng sâu nhiều lớp đấy/);
});

test('nested inline text inside a heading / list item', () => {
  assert.equal(richMessageText({ blocks: [{ type: 'heading', size: 2, text: [{ type: 'bold', text: 'Tiêu đề' }] }] }), '## Tiêu đề');
  assert.equal(richMessageText({ blocks: [{ type: 'list', items: [['a ', { type: 'bold', text: 'b' }]] }] }), '- a b');
});

// The owner's third real payload (message 1623) — a deliberate stress test that
// exercised every block type at once. The previous fix silently dropped ALL of it
// except the paragraphs: list `items[]` are OBJECTS (`{label, blocks[],
// has_checkbox, is_checked}`), and `details`/`table` carry their content in
// `blocks[]`/`cells[][]` rather than `text`. Blocks nest, so flattening must
// recurse over blocks, not just over inline nodes.
const REAL_STRESS = {
  blocks: [
    { type: 'paragraph', text: ['Tôi buồn 🪊 tôi hát giữa 🌃 ', { type: 'bold', text: { type: 'italic', text: { type: 'underline', text: 'khuya' } } }, '. '] },
    { type: 'paragraph', text: '' },
    { type: 'paragraph', text: { type: 'bold', text: 'Tôi tự vấn! ' } },
    { type: 'paragraph', text: 'Tôi chat với: ' },
    { type: 'list', items: [
      { label: '1.', blocks: [{ type: 'paragraph', text: 'Claude' }], type: '1', value: 1 },
      { label: '2.', blocks: [{ type: 'paragraph', text: 'Âm bản của hồn' }], type: '1', value: 2 },
    ] },
    { type: 'list', items: [
      { label: '•', blocks: [{ type: 'paragraph', text: 'Ánh trăng' }], has_checkbox: true },
      { label: '•', blocks: [{ type: 'paragraph', text: 'Heo sữa' }], has_checkbox: true, is_checked: true },
    ] },
    { type: 'details', summary: 'Thế nào? ', is_open: true, blocks: [
      { type: 'paragraph', text: 'Thật ra là vậy' },
      { type: 'table', is_bordered: true, cells: [
        [{ text: 'Có' }, { text: 'Không' }],
        [{ text: 'Như' }, { text: 'Là' }],
      ] },
    ] },
  ],
};

test('the stress payload keeps EVERYTHING: nested inline, ordered list, checklist, details, table', () => {
  const out = richMessageText(REAL_STRESS);
  assert.match(out, /Tôi buồn 🪊 tôi hát giữa 🌃 khuya\./);   // 3-deep inline formatting flattened
  assert.match(out, /^1\. Claude$/m);                          // ordered list keeps its label
  assert.match(out, /^2\. Âm bản của hồn$/m);
  assert.match(out, /^- \[ \] Ánh trăng$/m);                    // unchecked box
  assert.match(out, /^- \[x\] Heo sữa$/m);                      // checked box survives
  assert.match(out, /▸ Thế nào\?/);                            // details summary
  assert.match(out, /Thật ra là vậy/);                         // …and its nested blocks
  assert.match(out, /^\| Có \| Không \|$/m);                    // table header
  assert.match(out, /^\| --- \| --- \|$/m);
  assert.match(out, /^\| Như \| Là \|$/m);
});

test('richBlocksText: nested list inside a list item is indented, not flattened away', () => {
  const out = richBlocksText([{ type: 'list', items: [
    { label: '1.', blocks: [
      { type: 'paragraph', text: 'ngoài' },
      { type: 'list', items: [{ label: '•', blocks: [{ type: 'paragraph', text: 'trong' }] }] },
    ] },
  ] }]);
  assert.match(out, /^1\. ngoài$/m);
  assert.match(out, /trong/);
  assert.notEqual(out.indexOf('trong'), -1);
});

test('a table cell containing a pipe is escaped so the row stays parseable', () => {
  const out = richMessageText({ blocks: [{ type: 'table', cells: [[{ text: 'a|b' }, { text: 'c' }]] }] });
  assert.match(out, /a\\\|b/);
});

// Bot API 10.1 documents block types the first three real payloads never used.
// Rendering them is cheap; NOT rendering them means silent loss, which is the
// failure mode this whole thread has been about.
test('documented block types: divider, quotation, preformatted, footer, math, thinking', () => {
  const out = richMessageText({ blocks: [
    { type: 'section_heading', size: 2, content: 'Tiêu đề' },     // outgoing spelling: `content`
    { type: 'block_quotation', content: 'trích dẫn' },
    { type: 'preformatted', content: 'x = 1' },
    { type: 'divider' },
    { type: 'mathematical_expression', mathematical_expression: 'E=mc^2' },
    { type: 'thinking', content: 'đang nghĩ' },
    { type: 'footer', content: 'chân trang' },
  ] });
  assert.match(out, /^## Tiêu đề$/m);
  assert.match(out, /^> trích dẫn$/m);
  assert.match(out, /```\nx = 1\n```/);
  assert.match(out, /^---$/m);
  assert.match(out, /\$E=mc\^2\$/);
  assert.match(out, /suy nghĩ.*đang nghĩ/);
  assert.match(out, /— chân trang/);
});

test('a link keeps its target; a spoiler/custom emoji keeps its text', () => {
  assert.equal(richInlineText({ type: 'url', url: 'https://x.dev', text: 'trang này' }), 'trang này (https://x.dev)');
  assert.equal(richInlineText({ type: 'url', url: 'https://x.dev' }), 'https://x.dev');
  assert.equal(richInlineText({ type: 'spoiler', text: 'bí mật' }), 'bí mật');
  assert.equal(richInlineText({ type: 'custom_emoji', custom_emoji_id: '5', text: '🐘' }), '🐘');
});

test('media inside a rich message becomes a real attachment (bytes were silently lost)', async () => {
  const { buildPromptData } = await import('./tele-listen.mjs');
  const msg = {
    message_id: 1, date: 1, chat: { id: -1 }, from: { id: 2, first_name: 'Alice' },
    rich_message: { blocks: [
      { type: 'paragraph', text: 'xem ảnh này' },
      { type: 'photo', photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 99 }] },
      { type: 'details', summary: 'thêm', blocks: [{ type: 'video', video: { file_id: 'vid', mime_type: 'video/mp4' } }] },
      { type: 'collage', media: [{ photo: [{ file_id: 'c1', file_size: 5 }] }] },
    ] },
  };
  const d = buildPromptData(msg, 7, 42, null);
  assert.deepEqual(d.attachments.map((a) => a.fileId), ['big', 'vid', 'c1']);   // largest photo, nested video, collage
  assert.equal(d.attachments[0].kind, 'photo');
  assert.equal(d.attachments[1].kind, 'video');
  assert.match(d.text, /\[ảnh\]/);          // the text keeps a marker so the agent knows
  assert.equal(d.messages[0].attachments[0], d.attachments[0]);  // same objects (in-place hydration)
});
