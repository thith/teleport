import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, validCode, extractLoginUrl, loginEnv, acquireLock, runLogin, shq } from './login.mjs';

const HC = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=t\nrue&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_u\nri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreat\ne_api_key+user%3Aprofile&code_challenge=abc&code_challenge_method=S256&state=xyz\nPaste code here if prompted >";
const URL_OK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=abc&code_challenge_method=S256&state=xyz';
const CODE = 'abcDEF123_-#stateXYZ_-9';

test('extractLoginUrl: joins the 80-col wrapped URL', () => {
  assert.equal(extractLoginUrl(HC), URL_OK);
  assert.equal(extractLoginUrl(HC.replace(/\n/g, '   \n')), URL_OK, 'trailing spaces trimmed');
  assert.equal(extractLoginUrl('\x1b[1m' + HC), URL_OK, 'ANSI stripped');
});
test('extractLoginUrl: no URL / foreign host / wrong path → null', () => {
  assert.equal(extractLoginUrl('Starting…\nPaste code here if prompted >'), null);
  assert.equal(extractLoginUrl('visit: https://evil.example/cai/oauth/authorize?x=1\nPaste code'), null);
  assert.equal(extractLoginUrl('visit: https://claude.com.evil.io/oauth/authorize?x=1\nPaste code'), null);
  assert.equal(extractLoginUrl('visit: https://claude.com/other?x=1\nPaste code'), null);
  assert.equal(extractLoginUrl(''), null);
});
test('parseArgs / validCode', () => {
  assert.deepEqual(parseArgs(''), { kind: 'start' });
  assert.deepEqual(parseArgs(undefined), { kind: 'start' });
  assert.deepEqual(parseArgs(' cancel '), { kind: 'cancel' });
  assert.deepEqual(parseArgs(CODE), { kind: 'submit', code: CODE });
  assert.equal(parseArgs('hello world').kind, 'other');
  assert.equal(parseArgs('abc#def; rm -rf').kind, 'other');
  assert.equal(validCode('a'.repeat(600) + '#b'), false);
  assert.equal(validCode('nohash'), false);
  assert.equal(shq("a'b"), `'a'\\''b'`);
});
test('loginEnv: forces both config vars, drops tokens', () => {
  const e = loginEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'a', PATH: '/bin' }, '/x/config');
  assert.equal(e.CLAUDE_CONFIG_DIR, '/x/config');
  assert.equal(e.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/x/config');
  assert.equal(e.PATH, '/bin');
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) assert.ok(!(k in e));
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'login-test-'));

test('lock: O_EXCL, live pid blocks, dead pid reclaimed, old lock reclaimed', () => {
  const root = tmp();
  let t = 1000;
  const r1 = acquireLock(root, { now: () => t, alive: () => true });
  assert.ok(r1);
  assert.equal(acquireLock(root, { now: () => t, alive: () => true }), null, 'second start loses');
  assert.ok(acquireLock(root, { now: () => t, alive: () => false })?.call, 'dead pid → reclaimed at once');
  fs.writeFileSync(path.join(root, 'lock'), JSON.stringify({ pid: 1, token: 'zz', at: t }));
  assert.equal(acquireLock(root, { now: () => t + 60_000, alive: () => true }), null);
  const r4 = acquireLock(root, { now: () => t + 4 * 60_000, alive: () => true });
  assert.ok(r4, 'alive but >3 min → reclaimed');
  r1(); // not the owner any more → must leave the new lock
  assert.ok(fs.existsSync(path.join(root, 'lock')), 'release by a non-owner leaves the lock');
  r4();
  assert.ok(!fs.existsSync(path.join(root, 'lock')));
  assert.deepEqual(fs.readdirSync(root), [], 'no tmp/grave files left');
  fs.rmSync(root, { recursive: true, force: true });
});

// A fake world: screen/claude/cswap behind the injected runner.
function world({ stuff = 'ok', noUrl = false, cswapFail = false, loggedIn = true } = {}) {
  const w = { calls: [], alive: false, text: '', reg: '', dir: null, clock: 1_000_000, stuffMode: stuff, deletedCodeFile: false };
  const root = tmp();
  w.root = root;
  w.run = async (cmd, argv, o = {}) => {
    w.calls.push({ cmd, argv, o });
    const ok = (stdout = '') => ({ stdout, stderr: '', status: 0, signal: null, error: null });
    if (cmd === 'screen') {
      if (argv[0] === '-ls') return ok(w.alive ? `There is a screen on:\n\t123.tele-login-${path.basename(w.dir)}\t(Detached)\n` : 'No Sockets found.\n');
      if (argv[0] === '-dmS') { w.alive = true; w.dir = o.cwd; w.env = o.env; w.text = noUrl ? 'booting…' : HC; return ok(); }
      const x = argv.indexOf('-X');
      const op = argv[x + 1];
      if (op === 'hardcopy') { fs.writeFileSync(argv[x + 2], w.text); return ok(); }
      if (op === 'readreg') { w.reg = fs.readFileSync(argv[x + 3], 'utf8'); w.regFileMode = fs.statSync(argv[x + 3]).mode & 0o777; return ok(); }
      if (op === 'paste') { w.pasted = w.reg; return ok(); }
      if (op === 'stuff') {
        if (w.stuffMode === 'ok') { fs.writeFileSync(path.join(w.dir, 'exit'), '0\n'); w.alive = false; }
        else if (w.stuffMode === 'fail') { fs.writeFileSync(path.join(w.dir, 'exit'), '1\n'); w.alive = false; }
        else if (w.stuffMode === 'wrong') w.text += '\nError: Invalid code. Please make sure the full code was copied';
        return ok();
      }
      if (op === 'quit') { w.alive = false; w.quit = true; return ok(); }
    }
    if (cmd === 'claude') { w.statusEnv = o.env; return ok(JSON.stringify({ loggedIn, email: 'new@x.io', orgName: 'Acme' })); }
    if (cmd === 'cswap' && argv[0] === 'add') { w.addEnv = o.env; w.addInput = o.input; return cswapFail ? { stdout: '', stderr: 'boom https://secret/url', status: 1, signal: null, error: null } : ok('Added Account 4: new@x.io\n'); }
    if (cmd === 'cswap' && argv[0] === 'status') { w.statusDefaultEnv = o.env; return ok(JSON.stringify({ active: { email: 'old@x.io' } })); }
    throw new Error('unexpected ' + cmd + argv);
  };
  w.deps = (extra = {}) => ({
    root, platform: 'linux', which: () => true, randomId: () => 'abc123', now: () => w.clock,
    sleep: async (ms) => { w.clock += ms; }, run: w.run,
    env: { PATH: '/bin', CLAUDE_SECURESTORAGE_CONFIG_DIR: '', CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k' },
    ...extra,
  });
  return w;
}
const cleanup = (w) => fs.rmSync(w.root, { recursive: true, force: true });

test('flow: start → URL; env forced; session.json 0600 before screen; dir 0700', async () => {
  const w = world();
  const out = await runLogin('', w.deps());
  assert.equal(out, `🔑 Mở link này, chọn account, rồi gửi lại: /login <mã>\n${URL_OK}\n⏳ Hết hạn sau 10 phút · /login cancel để huỷ`);
  const dir = path.join(w.root, 'abc123');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'session.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'hc.txt')).mode & 0o777, 0o600);
  const cfg = path.join(dir, 'config');
  assert.equal(w.env.CLAUDE_CONFIG_DIR, cfg);
  assert.equal(w.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, cfg, 'forced even though parent env has ""');
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in w.env) && !('ANTHROPIC_API_KEY' in w.env));
  const start = w.calls.find((c) => c.argv[0] === '-dmS');
  assert.equal(start.o.cwd, dir);
  assert.match(start.argv[start.argv.length - 1], /^timeout --foreground 600 claude auth login --claudeai; echo \$\? > '.*exit\.tmp' && mv '.*exit\.tmp' '.*exit'$/);
  assert.ok(!fs.existsSync(path.join(w.root, 'lock')), 'lock released');
  cleanup(w);
});

test('flow: second /login resends the same URL with minutes left', async () => {
  const w = world();
  await runLogin('', w.deps());
  w.clock += 4 * 60_000;
  const out = await runLogin('', w.deps());
  assert.ok(out.includes(URL_OK));
  assert.match(out, /Hết hạn sau 6 phút/);
  assert.equal(w.calls.filter((c) => c.argv[0] === '-dmS').length, 1, 'no second screen');
  cleanup(w);
});

test('flow: URL not found → cleanup + message; screen content never printed', async () => {
  const w = world({ noUrl: true });
  const out = await runLogin('', w.deps());
  assert.equal(out, '❌ không lấy được URL login (output của claude auth login có thể đã đổi)');
  assert.ok(w.quit);
  assert.deepEqual(fs.readdirSync(w.root), []);
  cleanup(w);
});

test('flow: code → cswap add with forced env → report → cleanup', async () => {
  const w = world();
  await runLogin('', w.deps());
  const out = await runLogin(CODE, w.deps());
  assert.equal(w.pasted, CODE);
  assert.equal(w.regFileMode, 0o600);
  assert.ok(!fs.existsSync(path.join(w.root, 'abc123')), 'session dir removed');
  const cfg = path.join(w.root, 'abc123', 'config');
  for (const e of [w.statusEnv, w.addEnv]) { assert.equal(e.CLAUDE_CONFIG_DIR, cfg); assert.equal(e.CLAUDE_SECURESTORAGE_CONFIG_DIR, cfg); }
  assert.equal(w.addInput, '');
  assert.ok(!('CLAUDE_CONFIG_DIR' in w.statusDefaultEnv), 'cswap status uses the default env');
  assert.match(out, /new@x\.io · Acme/);
  assert.match(out, /Added Account 4: new@x\.io/);
  assert.match(out, /đang dùng vẫn là: old@x\.io/);
  assert.ok(!w.calls.some((c) => c.argv.some((a) => String(a).includes(CODE))), 'code never on any argv');
  cleanup(w);
});

test('flow: no exit within 60 s → "maybe wrong code", session kept; a screen line with "error" does not abort', async () => {
  const w = world({ stuff: 'wrong' }); // screen shows "Error: Invalid code" but nothing exits
  await runLogin('', w.deps());
  const t0 = w.clock;
  const out = await runLogin(CODE, w.deps());
  assert.equal(out, '⏳ chưa xong — có thể mã sai. Gửi lại /login <mã> hoặc /login cancel');
  assert.ok(w.clock - t0 >= 60_000, 'waited the full 60 s');
  assert.ok(fs.existsSync(path.join(w.root, 'abc123', 'session.json')));
  assert.ok(!fs.existsSync(path.join(w.root, 'abc123', 'code')), 'code file removed');
  w.stuffMode = 'ok';
  assert.match(await runLogin(CODE, w.deps()), /✅ đã thêm account/);
  cleanup(w);
});

test('flow: bad format keeps the session; stray text with no session → hint', async () => {
  const w = world();
  assert.equal(await runLogin('hello', w.deps()), 'chưa có phiên login nào, gõ /login trước');
  await runLogin('', w.deps());
  assert.match(await runLogin('hello', w.deps()), /không đúng định dạng/);
  assert.ok(fs.existsSync(path.join(w.root, 'abc123', 'session.json')));
  cleanup(w);
});

test('flow: exit code ≠ 0 → cleanup', async () => {
  const w = world({ stuff: 'fail' });
  await runLogin('', w.deps());
  assert.match(await runLogin(CODE, w.deps()), /login thất bại \(mã thoát 1\)/);
  assert.deepEqual(fs.readdirSync(w.root), []);
  cleanup(w);
});

test('flow: exit 0 but auth status not loggedIn → cleanup, no cswap add', async () => {
  const w = world({ loggedIn: false });
  await runLogin('', w.deps());
  assert.match(await runLogin(CODE, w.deps()), /login thất bại/);
  assert.ok(!w.addEnv);
  assert.deepEqual(fs.readdirSync(w.root), []);
  cleanup(w);
});

test('flow: cswap add error → message (URLs masked), cleanup', async () => {
  const w = world({ cswapFail: true });
  await runLogin('', w.deps());
  const out = await runLogin(CODE, w.deps());
  assert.match(out, /cswap add lỗi: boom <url>/);
  assert.deepEqual(fs.readdirSync(w.root), []);
  cleanup(w);
});

test('flow: expired session → cleanup; screen gone → cleanup; cancel', async () => {
  let w = world();
  await runLogin('', w.deps());
  w.clock += 11 * 60_000;
  assert.equal(await runLogin(CODE, w.deps()), 'phiên login đã hết hạn, gõ /login lại');
  assert.deepEqual(fs.readdirSync(w.root), []);
  cleanup(w);
  w = world();
  await runLogin('', w.deps());
  w.alive = false;
  assert.equal(await runLogin(CODE, w.deps()), 'phiên login đã hết hạn, gõ /login lại');
  cleanup(w);
  w = world();
  await runLogin('', w.deps());
  assert.match(await runLogin('cancel', w.deps()), /đã huỷ/);
  assert.ok(w.quit);
  assert.deepEqual(fs.readdirSync(w.root), []);
  assert.match(await runLogin('cancel', w.deps()), /không có phiên/);
  cleanup(w);
});

test('non-linux refused; missing tool reported; held lock → busy', async () => {
  const w = world();
  assert.equal(await runLogin('', w.deps({ platform: 'darwin' })), '❌ /login chưa hỗ trợ trên darwin');
  assert.match(await runLogin('', w.deps({ which: (n) => n !== 'screen' })), /thiếu trong PATH: screen/);
  fs.writeFileSync(path.join(w.root, 'lock'), JSON.stringify({ pid: process.pid, token: 'held', at: w.clock }));
  assert.match(await runLogin('', w.deps()), /đang xử lý/);
  cleanup(w);
});

test('lock: concurrent real processes → exactly one wins', async () => {
  const root = tmp();
  const mod = fileURLToPath(new URL('./login.mjs', import.meta.url));
  const code = `import(${JSON.stringify(mod)}).then(async (m) => { const r = m.acquireLock(${JSON.stringify(root)}); console.log(r ? 'won' : 'lost'); await new Promise((x) => setTimeout(x, 1500)); });`;
  const outs = await Promise.all(Array.from({ length: 4 }, () => new Promise((res) => {
    let o = ''; const c = spawn(process.execPath, ['--input-type=module', '-e', code]);
    c.stdout.on('data', (b) => { o += b; }); c.on('close', () => res(o.trim()));
  })));
  assert.equal(outs.filter((x) => x === 'won').length, 1, outs.join(','));
  fs.rmSync(root, { recursive: true, force: true });
});

test('late completion: exit 0 already there → next /login finishes (cswap add) instead of deleting', async () => {
  const w = world();
  await runLogin('', w.deps());
  fs.writeFileSync(path.join(w.root, 'abc123', 'exit'), '0\n');
  const out = await runLogin('', w.deps());
  assert.match(out, /✅ đã thêm account: new@x\.io · Acme/);
  assert.deepEqual(fs.readdirSync(w.root), []);
  cleanup(w);
});
test('late completion: a code sent after completion says it was not needed', async () => {
  const w = world();
  await runLogin('', w.deps());
  fs.writeFileSync(path.join(w.root, 'abc123', 'exit'), '0\n');
  const out = await runLogin(CODE, w.deps());
  assert.match(out, /không cần mã nữa/);
  assert.match(out, /✅ đã thêm account/);
  assert.ok(!w.pasted);
  cleanup(w);
});
test('late completion: exit ≠ 0 on disk → cleanup, then /login starts fresh', async () => {
  const w = world();
  await runLogin('', w.deps());
  fs.writeFileSync(path.join(w.root, 'abc123', 'exit'), '1\n');
  w.alive = false;
  const out = await runLogin('', w.deps());
  assert.ok(out.includes(URL_OK));
  assert.equal(w.calls.filter((c) => c.argv[0] === '-dmS').length, 2);
  cleanup(w);
});
test('restart recovery: session.json without url (died mid-start) → cleaned, fresh start', async () => {
  const w = world();
  const dir = path.join(w.root, 'dead01');
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: 'dead01', screen: 'tele-login-dead01', startedAt: w.clock, expiresAt: w.clock + 600000 }));
  w.dir = dir; w.alive = true; // pretend its screen is up
  const out = await runLogin('', w.deps());
  assert.ok(out.includes(URL_OK));
  assert.ok(!fs.existsSync(dir), 'incomplete session removed');
  assert.deepEqual(fs.readdirSync(w.root), ['abc123']);
  cleanup(w);
});

test('lock: reclaim race (two reclaimers + a third acquirer) never yields two owners', () => {
  const root = tmp();
  const t = 5_000_000;
  fs.writeFileSync(path.join(root, 'lock'), JSON.stringify({ pid: 1, token: 'old', at: t - 10 * 60_000 }));
  const opts = { now: () => t, alive: (p) => p === process.pid };
  let b = null, c = null;
  // A judged the lock stale; before it can reclaim, B reclaims AND acquires; C then tries too.
  const a = acquireLock(root, { ...opts, onStale: () => { b = acquireLock(root, opts); c = acquireLock(root, opts); } });
  assert.ok(b, 'B owns the lock');
  assert.equal(c, null);
  assert.equal(a, null, 'A must not take over (and must not delete B\'s lock)');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'lock'), 'utf8')).pid, process.pid);
  b();
  assert.ok(!fs.existsSync(path.join(root, 'lock')));
  fs.rmSync(root, { recursive: true, force: true });
});
test('lock: a live reclaim mutex → busy; an old one is cleared', () => {
  const root = tmp();
  const t = Date.now();
  fs.writeFileSync(path.join(root, 'lock'), JSON.stringify({ pid: 1, token: 'old', at: t - 10 * 60_000 }));
  fs.writeFileSync(path.join(root, 'lock.reclaim'), '');
  const opts = { now: () => t, alive: () => false };
  assert.equal(acquireLock(root, opts), null);
  const old = new Date(t - 60_000);
  fs.utimesSync(path.join(root, 'lock.reclaim'), old, old);
  assert.ok(acquireLock(root, opts));
  fs.rmSync(root, { recursive: true, force: true });
});

test('completion race: exit appears while checking the screen → finish, not delete (submit, start, cancel)', async () => {
  for (const kind of ['submit', 'start', 'cancel']) {
    const w = world();
    await runLogin('', w.deps());
    const orig = w.run; let armed = true;
    const deps = w.deps({ run: async (cmd, argv, o) => {
      if (armed && cmd === 'screen' && argv[0] === '-ls') { armed = false; fs.writeFileSync(path.join(w.dir, 'exit'), '0\n'); w.alive = false; }
      return orig(cmd, argv, o);
    } });
    const out = await runLogin(kind === 'submit' ? CODE : kind === 'cancel' ? 'cancel' : '', deps);
    assert.match(out, /✅ đã thêm account/, kind);
    if (kind === 'cancel') assert.match(out, /xong trước khi huỷ/);
    assert.deepEqual(fs.readdirSync(w.root), [], kind);
    cleanup(w);
  }
});
