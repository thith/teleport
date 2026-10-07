import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMessage, editMarker, buildPromptData, buildCombinedPromptData, filterAdminMessages } from './tele-listen.mjs';

// Telegram delivers an edit as its OWN update type (`edited_message`, same
// message_id + `edit_date`), and it arrives by default — but every intake site
// read `u.message` only, so an edit was silently ignored: the admin fixed a typo
// or added a sentence and the agent never learned.

const edited = (over = {}) => ({
  message_id: 1630, date: 1786900000, edit_date: 1786900500, message_thread_id: 1565,
  chat: { id: -1001234567890, type: 'supergroup', is_forum: true },
  from: { id: 100000001, first_name: 'Alice' },
  text: 'bản đã sửa', ...over,
});

test('updateMessage: message, edited_message, or nothing', () => {
  assert.equal(updateMessage({ message: { message_id: 1 } }).message_id, 1);
  assert.equal(updateMessage({ edited_message: { message_id: 2 } }).message_id, 2);
  assert.equal(updateMessage({ message_reaction: {} }), null);
  assert.equal(updateMessage(null), null);
});

test('THE GAP: an edited_message now survives the topic filter', () => {
  const kept = filterAdminMessages(
    [{ update_id: 1, edited_message: edited() }],
    ['-1001234567890'], null, 'convo', new Map([['-1001234567890', 1565]]),
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].msg.message_id, 1630);
});

test('an edit is unmissable in the TEXT, not just in a field', () => {
  // The agent may already have acted on the previous wording, so the marker has to
  // survive into the prose it reads — a field alone can be skimmed past.
  const d = buildPromptData(edited(), null, null, null);
  assert.equal(d.text, '✏️ (đã sửa) bản đã sửa');
  assert.equal(d.edited, true);
  assert.equal(d.editedAt, 1786900500);
  assert.equal(d.messages[0].edited, true);
  assert.equal(d.messages[0].messageId, 1630, 'same message id as the original — it replaces it');
  // A normal message is untouched.
  const plain = buildPromptData(edited({ edit_date: undefined, text: 'bản gốc' }), null, null, null);
  assert.equal(plain.text, 'bản gốc');
  assert.equal(plain.edited, false);
  assert.equal(plain.editedAt, null);
  assert.equal(editMarker({}), '');
});

test('in a batch, only the edited segment is marked and the batch flags it', () => {
  const batch = buildCombinedPromptData([
    { msg: edited({ message_id: 1, edit_date: undefined, text: 'tin thường' }) },
    { msg: edited({ message_id: 2, text: 'tin đã sửa' }) },
  ], null, null, null);
  assert.match(batch.text, /tin thường/);
  assert.match(batch.text, /✏️ \(đã sửa\) tin đã sửa/);
  assert.doesNotMatch(batch.text.split('\n\n')[0], /đã sửa/);   // the plain one stays plain
  assert.equal(batch.edited, true);
  assert.deepEqual(batch.messages.map((m) => m.edited), [false, true]);
});

test('an edited RICH message keeps both the marker and the flattened blocks', () => {
  const d = buildPromptData(edited({
    text: undefined,
    rich_message: { blocks: [{ type: 'paragraph', text: ['sửa ', { type: 'bold', text: 'đậm' }] }] },
  }), null, null, null);
  assert.equal(d.text, '✏️ (đã sửa) sửa đậm');
});

test('editedAt is present at the TOP level too, and is the most recent edit in the batch', () => {
  // A live edit arrived as `edited: true, editedAt: null` because only the segment
  // carried the timestamp — the single-message path goes through the batch builder.
  const one = buildCombinedPromptData([{ msg: edited() }], null, null, null);
  assert.equal(one.edited, true);
  assert.equal(one.editedAt, 1786900500);
  const two = buildCombinedPromptData([
    { msg: edited({ message_id: 1, edit_date: 1786900500 }) },
    { msg: edited({ message_id: 2, edit_date: 1786900900 }) },
  ], null, null, null);
  assert.equal(two.editedAt, 1786900900, 'the most recent edit');
  const none = buildCombinedPromptData([{ msg: edited({ edit_date: undefined }) }], null, null, null);
  assert.equal(none.edited, false);
  assert.equal(none.editedAt, null);
});
