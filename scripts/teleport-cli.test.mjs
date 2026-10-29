import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, install, HELP } from './teleport-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'teleport.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tele-cli-'));

test('parse: each subcommand builds the right spawn.mjs argv', () => {
  assert.deepEqual(parse(['ls']), { script: 'spawn', args: ['--list'] });
  assert.deepEqual(parse(['ls', 'full']), { script: 'spawn', args: ['--list', 'full'] });
  assert.deepEqual(parse(['attach']), { script: 'spawn', args: ['--attach'] });
  assert.deepEqual(parse(['a', '116']), { script: 'spawn', args: ['--attach', '116'] });
  assert.deepEqual(parse(['attach', '#c8630116']), { script: 'spawn', args: ['--attach', '#c8630116'] });
  assert.deepEqual(parse(['kill', 'd1331668']), { script: 'spawn', args: ['--kill', 'tele-d1331668'] });
  assert.deepEqual(parse(['k', '#d1331668']), { script: 'spawn', args: ['--kill', 'tele-d1331668'] });
  assert.deepEqual(parse(['kill', 'tele-D1331668']), { script: 'spawn', args: ['--kill', 'tele-D1331668'] });
  assert.deepEqual(parse(['install']), { install: true });
});

test('parse (RFC 28): ls off → resume.mjs --list-stopped; resume / r keep "#", join words, pass "--" onward verbatim', () => {
  assert.deepEqual(parse(['ls', 'off']), { script: 'resume', args: ['--list-stopped'] });
  assert.deepEqual(parse(['resume', '780']), { script: 'resume', args: ['780'] });
  assert.deepEqual(parse(['r', 'Robot', '2']), { script: 'resume', args: ['Robot 2'] });
  assert.deepEqual(parse(['resume', 'Sứa']), { script: 'resume', args: ['Sứa'] });
  assert.deepEqual(parse(['resume', '#f4451780']), { script: 'resume', args: ['#f4451780'] }, 'the "#" is kept: an exact address, never a name');
  assert.deepEqual(parse(['resume', 'f4451780']), { script: 'resume', args: ['f4451780'] });
  assert.deepEqual(parse(['resume', '780', '--', '--model', 'x']), { script: 'resume', args: ['780', '--', '--model', 'x'] });
  assert.deepEqual(parse(['resume', '780', '--']), { script: 'resume', args: ['780', '--'] });
  // "--help" after "--" belongs to claude; before it, it is ours
  assert.deepEqual(parse(['resume', 'foo', '--', '--help']), { script: 'resume', args: ['foo', '--', '--help'] });
  assert.deepEqual(parse(['r', '-h']), { help: true });
  assert.deepEqual(parse(['resume', '--help']), { help: true });
  assert.deepEqual(parse(['attach', 'Robot', '2']), { script: 'spawn', args: ['--attach', 'Robot 2'] });
  assert.deepEqual(parse(['attach', '#Ong']), { script: 'spawn', args: ['--attach', '#Ong'] });
  assert.deepEqual(parse(['a', 'tele-giun']), { script: 'spawn', args: ['--attach', 'tele-giun'] });
  for (const argv of [['resume', '--foo'], ['resume', '#--help'], ['resume', 'a', '-x'], ['resume', '—'], ['resume', '#'], ['attach', 'a', '--x'], ['attach', '#']]) {
    assert.ok(parse(argv).error, argv.join(' '));
  }
});

test('parse: spawn is interactive by default, --headless drops it', () => {
  assert.deepEqual(parse(['spawn']), { script: 'spawn', args: ['--interactive'] });
  assert.deepEqual(parse(['spawn', '--headless']), { script: 'spawn', args: [] });
  assert.deepEqual(parse(['spawn', '--mode', 'plan']), { script: 'spawn', args: ['--interactive', '--mode', 'plan'] });
  assert.deepEqual(parse(['spawn', '--mode=plan', '--headless']), { script: 'spawn', args: ['--mode', 'plan'] });
  assert.deepEqual(parse(['spawn', '--', '--model', 'opus']), { script: 'spawn', args: ['--interactive', '--', '--model', 'opus'] });
  // "--help" after "--" belongs to claude, not to us.
  assert.deepEqual(parse(['spawn', '--', '--help']), { script: 'spawn', args: ['--interactive', '--', '--help'] });
});

test('parse: flags of other subcommands and stray args are rejected', () => {
  for (const argv of [
    ['attach', '--kill', 'tele-x'], ['attach', '--list'], ['attach', 'a', '--x'], ['attach', '#'],
    ['spawn', '--kill', 'x'], ['spawn', 'luni'], ['spawn', '--mode'], ['spawn', '--mode', '--headless'],
    ['ls', '--kill', 'x'], ['ls', 'full', 'x'], ['ls', 'foo'], ['ls', 'full', 'off'], ['ls', 'off', 'x'],
    ['resume'], ['resume', '#'], ['resume', '--foo'], ['resume', '#--help'], ['resume', 'a', '-x'], ['resume', '—'], ['resume', '#–'], ['r', '--list-stopped'], ['resume', '--', '--model', 'x'], ['install', 'x'], ['frobnicate'],
    ['kill'], ['kill', 'a', 'b'], ['kill', '--list'],
    // Codex review: a duplicate --mode must not let the last one win; unknown modes and a
    // quoted '#--help' id are refused here, not by spawn.mjs.
    ['spawn', '--mode', 'plan', '--mode', 'bypassPermissions'], ['spawn', '--mode', 'yolo'],
    ['spawn', '--mode=plan', '--mode', 'auto'], ['attach', '#--help'], ['a', '#-x'], ['attach', '—'], ['attach', '–'],
  ]) {
    const r = parse(argv);
    assert.ok(r.error, `expected error for ${argv.join(' ')}`);
    assert.equal(r.args, undefined);
  }
});

test('parse: kill refuses 3-char tails, names, pid:, bad shapes', () => {
  for (const id of ['116', 'luni', 'pid:123', 't1331668', 'd133166', 'd13316689', 'k1331668']) {
    const r = parse(['kill', id]);
    assert.match(r.error ?? '', /full hashtag/, id);
  }
});

test('parse: every help form', () => {
  for (const argv of [[], ['help'], ['-h'], ['-help'], ['--help'], ['ls', '--help'], ['kill', '-h'], ['spawn', '--help'], ['attach', '-help']]) {
    assert.deepEqual(parse(argv), { help: true }, argv.join(' '));
  }
  for (const word of ['teleport ls', 'teleport resume', 'ls [full|off]', '<name>', 'teleport attach', 'teleport kill', 'teleport spawn', '--headless', 'Ctrl-A', 'install']) {
    assert.ok(HELP.includes(word), `HELP missing ${word}`);
  }
});

function fixture() {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'teleport.mjs'), '');
  const home = tmp();
  return { root, home, link: path.join(home, '.local', 'bin', 'teleport') };
}
const inst = (f, extra = {}) => install({ root: f.root, home: f.home, env: { PATH: '/usr/bin' }, isWorktree: () => false, ...extra });

test('install: fresh install creates the symlink and hints PATH', () => {
  const f = fixture();
  const r = inst(f);
  assert.equal(r.code, 0);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(path.join(f.root, 'bin', 'teleport.mjs')));
  assert.ok(r.out.join('\n').includes('export PATH'));
});

test('install: no PATH hint when ~/.local/bin is already on PATH (trailing slash ok)', () => {
  const f = fixture();
  const r = inst(f, { env: { PATH: `/usr/bin:${path.join(f.home, '.local', 'bin')}/` } });
  assert.equal(r.code, 0);
  assert.ok(!r.out.join('\n').includes('export PATH'));
});

test('install: already installed (absolute and relative symlink) is exit 0', () => {
  const f = fixture();
  assert.equal(inst(f).code, 0);
  assert.match(inst(f).out[0], /already installed/);
  fs.rmSync(f.link);
  fs.symlinkSync(path.relative(path.dirname(f.link), path.join(f.root, 'bin', 'teleport.mjs')), f.link);
  assert.equal(inst(f).code, 0);
});

test('install: re-running when already installed still reports PATH and shadowing problems', () => {
  const f = fixture();
  inst(f);
  const shadow = tmp();
  fs.writeFileSync(path.join(shadow, 'teleport'), '');
  const r = inst(f, { env: { PATH: shadow }, isWorktree: () => true });
  assert.equal(r.code, 0);
  assert.match(r.out[0], /already installed/);
  assert.ok(r.out.join('\n').includes('export PATH'));
  assert.ok(r.err.some((l) => l.includes('shadow')));
  assert.ok(r.err.some((l) => l.includes('worktree')));
});

test('install: refuses (and never touches) a foreign file, dir, other symlink, dangling link', () => {
  const makers = {
    file: (l) => fs.writeFileSync(l, 'x'),
    dir: (l) => fs.mkdirSync(l),
    other: (l) => { const o = path.join(path.dirname(l), 'other'); fs.writeFileSync(o, ''); fs.symlinkSync(o, l); },
    dangling: (l) => fs.symlinkSync(path.join(path.dirname(l), 'nope'), l),
  };
  for (const [name, make] of Object.entries(makers)) {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.link), { recursive: true });
    make(f.link);
    const before = fs.readlinkSync.bind(fs);
    const was = (() => { try { return before(f.link); } catch { return null; } })();
    const r = inst(f);
    assert.equal(r.code, 1, name);
    assert.ok(r.err[0].includes(f.link), name);
    const now = (() => { try { return before(f.link); } catch { return null; } })();
    assert.equal(now, was, `${name} untouched`);
  }
});

test('install: warns about worktree and about a shadowing teleport on PATH', () => {
  const f = fixture();
  const other = tmp();
  fs.writeFileSync(path.join(other, 'teleport'), '');
  const r = inst(f, { isWorktree: () => true, env: { PATH: `${other}:/usr/bin` } });
  assert.equal(r.code, 0);
  assert.ok(r.err.some((l) => /worktree/.test(l)));
  assert.ok(r.err.some((l) => l.includes(path.join(other, 'teleport'))));
});

test('install: does not warn about a teleport that comes AFTER ~/.local/bin', () => {
  const f = fixture();
  const other = tmp();
  fs.writeFileSync(path.join(other, 'teleport'), '');
  const r = inst(f, { env: { PATH: `${path.join(f.home, '.local', 'bin')}:${other}` } });
  assert.deepEqual(r.err, []);
});

// --- bin/teleport.mjs end to end, through a symlink, with a fake spawn.mjs ---
function run(args, fakeBody, opts = {}) {
  const dir = tmp();
  const link = path.join(dir, 'teleport');
  fs.symlinkSync(BIN, link);
  const fake = path.join(dir, 'fake-spawn.mjs');
  fs.writeFileSync(fake, fakeBody);
  return spawnSync(link, args, { encoding: 'utf8', env: { ...process.env, TELEPORT_CLI_SPAWN: fake }, ...opts });
}

test('bin: runs via symlink, forwards built argv and cwd, returns child exit code', () => {
  const cwd = fs.realpathSync(tmp());
  const r = run(['kill', 'd1331668'], 'console.log(JSON.stringify([process.argv.slice(2), process.cwd()])); process.exit(3);', { cwd });
  assert.equal(r.status, 3);
  assert.deepEqual(JSON.parse(r.stdout), [['--kill', 'tele-d1331668'], cwd]);
});

test('bin (RFC 28): resume / ls off run resume.mjs (TELEPORT_CLI_RESUME) with the argv as parsed, an empty "--" kept; exit code and signal as for spawn', () => {
  const dir = tmp();
  const fakeResume = path.join(dir, 'fake-resume.mjs');
  fs.writeFileSync(fakeResume, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.FAKE_EXIT ?? 0));');
  const go = (args, env = {}) => spawnSync(BIN, args, { encoding: 'utf8', env: { ...process.env, TELEPORT_CLI_RESUME: fakeResume, TELEPORT_CLI_SPAWN: '/nonexistent/spawn.mjs', ...env } });
  assert.deepEqual(JSON.parse(go(['resume', '780', '--model']).stdout || '[]'), [], 'a flag before "--" is refused, nothing runs');
  const r = go(['resume', 'Robot', '2', '--', '--model', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['Robot 2', '--', '--model', 'x']);
  assert.deepEqual(JSON.parse(go(['r', '#f4451780', '--']).stdout), ['#f4451780', '--']);
  assert.deepEqual(JSON.parse(go(['ls', 'off']).stdout), ['--list-stopped']);
  assert.equal(go(['resume', '780'], { FAKE_EXIT: '7' }).status, 7);
  const sig = path.join(dir, 'fake-sig.mjs');
  fs.writeFileSync(sig, "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);");
  assert.equal(go(['resume', '780'], { TELEPORT_CLI_RESUME: sig }).status, 143);
  assert.notEqual(go(['resume', '780'], { TELEPORT_CLI_RESUME: '/nonexistent/resume.mjs' }).status, 0);
});

test('bin: child killed by SIGTERM → 143', () => {
  const r = run(['ls'], "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);");
  assert.equal(r.status, 143);
});

test('bin: missing spawn script → child fails, nonzero exit', () => {
  const r = run(['ls'], 'process.exit(0);', { env: { ...process.env, TELEPORT_CLI_SPAWN: '/nonexistent/spawn.mjs' } });
  assert.notEqual(r.status, 0);
});

test('bin: bad args → exit 2, error line then help on stderr, nothing on stdout, spawn not run', () => {
  const r = run(['attach', '--kill'], 'console.log("RAN");');
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^teleport: attach: unknown option "--kill"\n\nteleport — /);
  assert.ok(r.stderr.includes('Usage:'));
});

test('bin: help → stdout, exit 0', () => {
  const r = run([], 'console.log("RAN");');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, HELP);
});

test('bin: install uses HOME', () => {
  const home = tmp();
  const r = run(['install'], '', { env: { ...process.env, HOME: home, TELEPORT_CLI_SPAWN: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.realpathSync(path.join(home, '.local', 'bin', 'teleport')), fs.realpathSync(BIN));
});
