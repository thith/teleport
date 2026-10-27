import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCommandsFile, loadCommands, resolveCommand, roleMeets, tokenizeArgs, splitAtBlocks } from './commands.mjs';

function tmpJson(obj) {
  const f = path.join(os.tmpdir(), `commands-${process.pid}-${Math.abs(JSON.stringify(obj).length)}-${obj.__n || ''}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('readCommandsFile: parses object, swallows missing/invalid → {}', () => {
  const f = tmpJson({ a: { run: 'x.mjs' }, __n: 'read' });
  assert.deepEqual(readCommandsFile(f).a, { run: 'x.mjs' });
  fs.rmSync(f);
  assert.deepEqual(readCommandsFile('/no/such/file.json'), {}); // missing → {}
});

test('loadCommands: merges base file with projects.json._commands (custom wins)', () => {
  const f = tmpJson({ spawn: { run: 'spawn.mjs', minRole: 'maintainer' }, ls: { run: 'spawn.mjs', args: ['--list'] }, __n: 'merge' });
  const reg = loadCommands({
    commandsFile: f,
    projectsConfig: { _commands: { deploy: { run: 'run.mjs', needsProject: true }, ls: { run: 'spawn.mjs', args: ['--list', '--all'] } } },
  });
  assert.ok(reg.spawn);              // from base
  assert.ok(reg.deploy);             // from custom
  assert.deepEqual(reg.ls.args, ['--list', '--all']); // custom override wins
  fs.rmSync(f);
});

test('resolveCommand: normalises defaults (args/needsProject/minRole)', () => {
  const c = resolveCommand('x', { x: { run: 'run.mjs' } });
  assert.deepEqual(c, { run: 'run.mjs', args: [], needsProject: false, minRole: 'public', wantsReplyText: false, splitBlocks: false, desc: '' });
  const d = resolveCommand('y', { y: { run: 'spawn.mjs', args: ['--list'], needsProject: true, minRole: 'admin', desc: 'hi' } });
  assert.deepEqual(d, { run: 'spawn.mjs', args: ['--list'], needsProject: true, minRole: 'admin', wantsReplyText: false, splitBlocks: false, desc: 'hi' });
  assert.equal(resolveCommand('ls', { ls: { run: 'spawn.mjs', splitBlocks: true } }).splitBlocks, true);
  assert.equal(resolveCommand('l', { l: { alias: 'ls' }, ls: { run: 'spawn.mjs', splitBlocks: true } }).splitBlocks, true, 'through an alias');
  // opt-in capability surfaces on the normalised spec
  assert.equal(resolveCommand('w', { w: { run: 'whisper.mjs', wantsReplyText: true } }).wantsReplyText, true);
});

test('resolveCommand: alias resolves to the target spec (one hop)', () => {
  const reg = {
    whisper: { run: 'whisper.mjs', minRole: 'admin', wantsReplyText: true, desc: 'real' },
    w: { alias: 'whisper' },
    i: { alias: 'instruct' },                 // dangling → target missing
    loop: { alias: 'loop' },                  // self-reference
    chain: { alias: 'w' },                    // alias→alias (w has no run)
  };
  // /w resolves to whisper's normalised spec, verbatim (short name contributes nothing)
  assert.deepEqual(resolveCommand('w', reg), resolveCommand('whisper', reg));
  assert.equal(resolveCommand('w', reg).run, 'whisper.mjs');
  assert.equal(resolveCommand('w', reg).minRole, 'admin');
  assert.equal(resolveCommand('w', reg).wantsReplyText, true);
  // safety: dangling / cyclic / chained aliases never resolve (and never loop)
  assert.equal(resolveCommand('i', reg), null);       // target 'instruct' absent
  assert.equal(resolveCommand('loop', reg), null);    // self-alias → target has no run
  assert.equal(resolveCommand('chain', reg), null);   // alias→alias rejected (one hop only)
});

test('resolveCommand: an entry carrying BOTH alias+run cannot recurse forever', () => {
  // The dangerous shape: the target has a `run` (so a run-only guard would pass)
  // AND an `alias` (so it re-enters the alias branch). Must resolve to null, never
  // throw RangeError. (Threat model: a malicious/misconfigured _commands override.)
  assert.equal(resolveCommand('a', { a: { alias: 'a', run: 'x.mjs' } }), null);           // self-loop
  assert.equal(resolveCommand('a', { a: { alias: 'b', run: 'x.mjs' }, b: { alias: 'a', run: 'x.mjs' } }), null); // 2-cycle
  assert.equal(resolveCommand('a', {                                                       // 3-cycle
    a: { alias: 'b', run: 'x.mjs' }, b: { alias: 'c', run: 'x.mjs' }, c: { alias: 'a', run: 'x.mjs' },
  }), null);
  // a real command that merely HAPPENS to be pointed at still resolves fine
  assert.deepEqual(
    resolveCommand('w', { w: { alias: 'real' }, real: { run: 'real.mjs' } }),
    resolveCommand('real', { real: { run: 'real.mjs' } }),
  );
});

test('resolveCommand: shipped commands.json wires /w→whisper and /i→instruct', () => {
  const reg = readCommandsFile(); // default = the shipped commands.json
  assert.equal(resolveCommand('w', reg).run, 'whisper.mjs');
  assert.equal(resolveCommand('i', reg).run, 'instruct.mjs');
  assert.equal(resolveCommand('i', reg).wantsReplyText, true);   // inherits instruct's opt-in
  assert.equal(resolveCommand('i', reg).minRole, 'admin');
});

test('resolveCommand: rejects non-.mjs, path separators, traversal, unknown', () => {
  assert.equal(resolveCommand('x', { x: { run: 'evil.sh' } }), null);         // not .mjs
  assert.equal(resolveCommand('x', { x: { run: '../evil.mjs' } }), null);     // traversal
  assert.equal(resolveCommand('x', { x: { run: 'sub/evil.mjs' } }), null);    // separator
  assert.equal(resolveCommand('x', { x: { run: 123 } }), null);               // non-string
  assert.equal(resolveCommand('missing', { x: { run: 'a.mjs' } }), null);     // unknown name
  assert.equal(resolveCommand('x', {}), null);
});

test('resolveCommand: coerces non-array args to []', () => {
  assert.deepEqual(resolveCommand('x', { x: { run: 'a.mjs', args: 'oops' } }).args, []);
});

test('resolveCommand: an inherited prototype name never resolves to a command', () => {
  // `/constructor` / `/toString` parse as command names (all letters) and resolve
  // to functions → already rejected by the typeof-object check. But a prototype
  // polluted with a command-SHAPED value would slip through WITHOUT the
  // own-property guard — assert it doesn't. try/finally so it can't leak.
  assert.equal(resolveCommand('constructor', {}), null);
  assert.equal(resolveCommand('toString', {}), null);
  try {
    // eslint-disable-next-line no-extend-native
    Object.prototype.evilcmd = { run: 'spawn.mjs', args: ['--kill', 'x'], minRole: 'public' };
    assert.equal(resolveCommand('evilcmd', {}), null);                     // inherited → ignored
    assert.deepEqual(resolveCommand('evilcmd', { evilcmd: { run: 'a.mjs' } }).run, 'a.mjs'); // own still works
  } finally {
    delete Object.prototype.evilcmd;
  }
});

test('tokenizeArgs: splits on whitespace but keeps quoted spans as one token', () => {
  assert.deepEqual(tokenizeArgs('acmebot dev --port 3000'), ['acmebot', 'dev', '--port', '3000']);
  assert.deepEqual(tokenizeArgs('app test --grep "a b c"'), ['app', 'test', '--grep', 'a b c']);
  assert.deepEqual(tokenizeArgs("x --msg 'hello world'"), ['x', '--msg', 'hello world']);
  assert.deepEqual(tokenizeArgs('  spaced   out  '), ['spaced', 'out']); // collapses runs
  assert.deepEqual(tokenizeArgs(''), []);
  assert.deepEqual(tokenizeArgs(null), []);
  assert.deepEqual(tokenizeArgs('a"b c"d'), ['ab cd']);        // adjacent quote inside a token
  assert.deepEqual(tokenizeArgs('empty ""'), ['empty', '']);  // an explicit empty quoted arg
  assert.deepEqual(tokenizeArgs('"unterminated rest'), ['unterminated rest']); // lenient
});

test('roleMeets: rank gate, public/unset always passes, unknown roles lose', () => {
  assert.equal(roleMeets('admin', 'maintainer'), true);
  assert.equal(roleMeets('member', 'maintainer'), false);
  assert.equal(roleMeets('maintainer', 'maintainer'), true);
  assert.equal(roleMeets('member', 'public'), true);
  assert.equal(roleMeets('member', undefined), true);   // unset → no gate
  assert.equal(roleMeets('member', 'member'), true);
  assert.equal(roleMeets('bogus', 'member'), false);    // unknown role → -1, below member
});

test('splitAtBlocks: packs whole blocks ≤ limit, cuts at empty lines; an oversized block by lines; a huge line hard', () => {
  assert.deepEqual(splitAtBlocks('a\n\nb', 100), ['a\n\nb']);
  assert.deepEqual(splitAtBlocks('aaaa\n\nbbbb\n\ncc', 10), ['aaaa\n\nbbbb', 'cc']);
  assert.deepEqual(splitAtBlocks('x\n\n' + '1234\n5678\n90', 9), ['x', '1234\n5678', '90']);
  assert.deepEqual(splitAtBlocks('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(splitAtBlocks('a\n\n\n\nb', 1), ['a', 'b'], 'runs of empty lines collapse');
  const big = Array.from({ length: 40 }, (_, i) => `🪼 #${i}\n${'x'.repeat(200)}`).join('\n\n');
  const parts = splitAtBlocks(big);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 3800));
  assert.equal(parts.join('\n\n'), big, 'nothing lost, block order kept');
});
