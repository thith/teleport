import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseScaffoldArgs, validateProjectName, validateType, applyPlaceholders,
  isTextFile, planScaffold, scaffold, PROFILES,
} from './scaffold.mjs';

test('parseScaffoldArgs: positional project + --type (space and =), flags', () => {
  assert.deepEqual(parseScaffoldArgs(['luni', '--type', 'code-bot']), { project: 'luni', type: 'code-bot', dryRun: false, git: true, into: null });
  assert.deepEqual(parseScaffoldArgs(['--type=code-web', 'shop', '--dry-run', '--no-git']), { project: 'shop', type: 'code-web', dryRun: true, git: false, into: null });
  assert.equal(parseScaffoldArgs(['x', '--into', '/tmp/z']).into, '/tmp/z');
});

test('validateProjectName: rejects traversal/bad chars, accepts safe names', () => {
  assert.equal(validateProjectName('my-bot_2'), null);
  assert.match(validateProjectName('..'), /invalid/);
  assert.match(validateProjectName('a/b'), /invalid/);
  assert.match(validateProjectName(''), /usage/);
});

test('validateType: only the 4 profiles pass', () => {
  for (const p of PROFILES) assert.equal(validateType(p), null);
  assert.match(validateType('webby'), /unknown/);
  assert.match(validateType(''), /missing/);
});

test('applyPlaceholders: substitutes PROJECT, profile, and the long type placeholder', () => {
  const src = '# <PROJECT>\nwith the **<profile>** overlay\nProfile: `<code-bot | code-web | monorepo | content>`';
  const out = applyPlaceholders(src, { project: 'luni', type: 'code-bot' });
  assert.match(out, /# luni/);
  assert.match(out, /\*\*code-bot\*\* overlay/);
  assert.match(out, /Profile: `code-bot`/);
  assert.ok(!out.includes('<PROJECT>') && !out.includes('<profile>') && !out.includes('<code-bot |'));
});

test('applyPlaceholders: leaves <one-line description> for the human', () => {
  assert.match(applyPlaceholders('x <one-line description>', { project: 'p', type: 'content' }), /<one-line description>/);
});

test('isTextFile: dotfiles + md/txt/json are text; binaries are not', () => {
  for (const f of ['.gitignore', '.gitkeep', 'a.md', 'b.json']) assert.equal(isTextFile(f), true, f);
  for (const f of ['x.png', 'y.mp4']) assert.equal(isTextFile(f), false, f);
});

test('planScaffold: refuses a non-empty destination', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scaf-'));
  fs.writeFileSync(path.join(tmp, 'existing.txt'), 'x');
  const plan = planScaffold({ project: 'p', type: 'code-bot', into: tmp });
  assert.ok(plan.errors.some((e) => /not empty/.test(e)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scaffold (integration, --no-git): copies core + overlay, substitutes placeholders, no leftover tokens', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scaf-'));
  const dest = path.join(tmp, 'newbot');
  const res = scaffold({ project: 'newbot', type: 'code-bot', into: dest, git: false });
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  // Key files exist. process.md/review-guide.md are intentionally NOT here — they're
  // shared at ../teleport-docs/guides/ (not copied per-project) to avoid drift.
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'teleport-conventions.md', '.gitignore', 'overlay.md', 'rfc/_template.md', 'specs/_template.md', 'docs/project_overview.md', 'sessions/.gitkeep']) {
    assert.ok(fs.existsSync(path.join(dest, f)), `missing ${f}`);
  }
  for (const f of ['process.md', 'review-guide.md']) {
    assert.ok(!fs.existsSync(path.join(dest, f)), `${f} should not be copied — shared at ../teleport-docs/guides/`);
  }
  // Placeholders substituted in CLAUDE.md
  const claude = fs.readFileSync(path.join(dest, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /# Claude Code Project Rules — newbot/);
  assert.ok(!claude.includes('<PROJECT>') && !claude.includes('<profile>'));
  // overlay is the code-bot one
  assert.match(fs.readFileSync(path.join(dest, 'overlay.md'), 'utf8'), /code-bot/);
  // No leftover known tokens anywhere except the intentional <one-line description>
  for (const rel of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'docs/project_overview.md']) {
    const c = fs.readFileSync(path.join(dest, rel), 'utf8');
    assert.ok(!c.includes('<PROJECT>'), `<PROJECT> left in ${rel}`);
    assert.ok(!c.includes('<code-bot | code-web'), `long token left in ${rel}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scaffold (dry-run): lists files, writes nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scaf-'));
  const dest = path.join(tmp, 'dryproj');
  const res = scaffold({ project: 'dryproj', type: 'content', into: dest, dryRun: true, git: false });
  assert.equal(res.ok, true);
  assert.ok(res.files.includes('overlay.md'));
  assert.ok(res.files.includes('CLAUDE.md'));
  assert.equal(fs.existsSync(dest), false, 'dry-run must not create the destination');
  fs.rmSync(tmp, { recursive: true, force: true });
});
