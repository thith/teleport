import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { formatGitFooter, isFirstConvoMessage, readGitContext } from './send-telegram.mjs';

test('formatGitFooter: clean tree → folder · branch · clean, leading blank line', () => {
  const out = formatGitFooter({ folder: 'acmebot', branch: 'main', dirty: 0 });
  assert.equal(out, '\n\n📁 acmebot · 🌿 main · clean');
});

test('formatGitFooter: dirty tree shows change count', () => {
  const out = formatGitFooter({ folder: 'acmebot', branch: 'main', dirty: 3 });
  assert.equal(out, '\n\n📁 acmebot · 🌿 main · dirty (3)');
});

test('formatGitFooter: null ctx (not a git repo) → empty string', () => {
  assert.equal(formatGitFooter(null), '');
  assert.equal(formatGitFooter(null, { raw: true }), '');
});

test('formatGitFooter: raw mode escapes MdV2 specials in folder/branch/count', () => {
  const out = formatGitFooter({ folder: 'my.app', branch: 'fix-bug', dirty: 2 }, { raw: true });
  // dots, hyphens and the (N) parens are MdV2 specials → backslash-escaped.
  assert.equal(out, '\n\n📁 my\\.app · 🌿 fix\\-bug · dirty \\(2\\)');
});

test('formatGitFooter: default mode leaves specials literal (escaped downstream)', () => {
  const out = formatGitFooter({ folder: 'my.app', branch: 'fix-bug', dirty: 2 });
  assert.equal(out, '\n\n📁 my.app · 🌿 fix-bug · dirty (2)');
});

test('formatGitFooter: plain mode is literal too (no MdV2 escaping)', () => {
  // --plain sends verbatim, so the footer must stay unescaped just like default.
  const out = formatGitFooter({ folder: 'my.app', branch: 'fix-bug', dirty: 2 }, { plain: true });
  assert.equal(out, '\n\n📁 my.app · 🌿 fix-bug · dirty (2)');
});

test('readGitContext: returns folder name only, never a full path', () => {
  // This repo IS a git work tree → ctx is non-null and folder has no separators.
  const ctx = readGitContext(process.cwd());
  assert.ok(ctx, 'expected a git context in the teleport repo');
  assert.ok(!ctx.folder.includes(path.sep), 'folder must be a basename, not a path');
  assert.equal(typeof ctx.branch, 'string');
  assert.equal(typeof ctx.dirty, 'number');
});

test('readGitContext: non-git dir → null (no throw, footer omitted)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
  try {
    assert.equal(readGitContext(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isFirstConvoMessage: true when registry empty, false once an allocation row exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convo-reg-'));
  const reg = path.join(dir, 'convo-registry.ndjson');
  try {
    const args = { convoId: 12345, botId: 42, chatId: '999' };
    // No file yet → first message.
    assert.equal(isFirstConvoMessage(args, reg), true);
    // Write the allocation row recordConvoSend would write on first send
    // (allocation row is keyed by messageId === convoId; botId is an integer).
    fs.writeFileSync(
      reg,
      JSON.stringify({ v: 1, convoId: 12345, messageId: 12345, chatId: '999', botId: 42, ts: 1 }) + '\n',
    );
    assert.equal(isFirstConvoMessage(args, reg), false);
    // A different chat is still on its first message.
    assert.equal(isFirstConvoMessage({ ...args, chatId: '888' }, reg), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
