import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHelp, COMMANDS_FILE } from './help.mjs';

const SAMPLE = {
  ls:       { run: 'spawn.mjs', args: ['--list'], minRole: 'member', desc: 'list running agents' },
  whisper:  { run: 'whisper.mjs', minRole: 'admin', desc: 'discreet steer: /whisper #<hash> <text>' },
  start:    { run: 'start.mjs', minRole: 'public', desc: 'onboarding help' },
  w:        { alias: 'whisper' },
};

test('renderHelp: lists real commands with /name + desc', () => {
  const out = renderHelp(SAMPLE);
  assert.match(out, /\/ls — list running agents/);
  assert.match(out, /\/whisper — discreet steer: \/whisper #<hash> <text>/);
});

test('renderHelp: tags non-public role, omits tag for public', () => {
  const out = renderHelp(SAMPLE);
  assert.match(out, /\/whisper —.*\[admin\]/);
  assert.match(out, /\/ls —.*\[member\]/);
  // public command has no role tag
  assert.ok(/\/start — onboarding help(?!.*\[)/.test(out));
});

test('renderHelp: renders aliases as /x = /target, not as commands', () => {
  const out = renderHelp(SAMPLE);
  assert.match(out, /Aliases:.*\/w = \/whisper/);
  assert.ok(!/• \/w —/.test(out)); // alias is not listed as a real command
});

test('renderHelp: stays in sync with the real commands.json (every command shown)', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(COMMANDS_FILE, path.join(__dirname, '..', 'commands.json'));
  const real = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8'));
  const out = renderHelp(real);
  for (const [name, spec] of Object.entries(real)) {
    if (spec.alias) assert.match(out, new RegExp(`/${name} = /${spec.alias}`));
    else assert.match(out, new RegExp(`• /${name} —`));
  }
});
