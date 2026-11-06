// `/login` (RFC 40) — add a Claude account to cswap from Telegram (owner, DM only).
//   /login          → start a session: `claude auth login --claudeai` runs inside a detached `screen`
//                     against an ISOLATED profile (CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR);
//                     replies with the OAuth URL (or the existing one + minutes left)
//   /login <code>   → types the code into that screen, then `cswap add` (same isolated profile)
//   /login cancel   → tear the session down
// The machine's own credentials and the active cswap account are untouched, except when the logged-in account
// IS the active one: then its live credential is refreshed via `cswap --switch-to N --force` (same account,
// no switch). The daemon passes the
// text via TELE_RAW_ARGS only (secretArgs: nothing on argv) and deletes the Telegram message with the code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { runCswap } from './cswap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOGIN_ROOT = path.join(__dirname, 'tmp', 'login');
export const SESSION_MS = 10 * 60 * 1000;
export const LOCK_STALE_MS = 3 * 60 * 1000;
export const URL_WAIT_MS = 60 * 1000;
export const CODE_WAIT_MS = 60 * 1000;
const POLL_MS = 1000;
const CODE_RE = /^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;
const ENV_DROP = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

// ── pure helpers ──

/** '' → start · 'cancel' → cancel · valid code → submit · anything else → other (bad format / stray text). */
export function parseArgs(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return { kind: 'start' };
  if (t.toLowerCase() === 'cancel') return { kind: 'cancel' };
  if (validCode(t)) return { kind: 'submit', code: t };
  return { kind: 'other' };
}

export function validCode(s) { return typeof s === 'string' && s.length <= 512 && CODE_RE.test(s); }

/** The OAuth URL from a screen hardcopy (80-col wrapped), or null. Host must be claude.com / claude.ai (or subdomain). */
export function extractLoginUrl(text) {
  const clean = String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const i = clean.indexOf('visit: ');
  if (i < 0) return null;
  let seg = clean.slice(i + 'visit: '.length);
  const j = seg.indexOf('Paste code');
  if (j >= 0) seg = seg.slice(0, j);
  const joined = seg.split(/\r?\n/).map((l) => l.trimEnd()).join('');
  const m = /https:\/\/\S+/.exec(joined);
  if (!m) return null;
  let u;
  try { u = new URL(m[0]); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!(host === 'claude.com' || host === 'claude.ai' || host.endsWith('.claude.com') || host.endsWith('.claude.ai'))) return null;
  if (!u.pathname.includes('/oauth/authorize')) return null;
  return m[0];
}

/** Env for `claude`/`cswap` inside the isolated profile. */
export function loginEnv(baseEnv, configDir) {
  const env = { ...baseEnv };
  for (const k of ENV_DROP) delete env[k];
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDir;
  return env;
}

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Lock file created atomically complete (tmp file + link(2), which fails with EEXIST), content
 * {pid, token, at}. A stale lock (dead pid, no token, or older than LOCK_STALE_MS) is reclaimed under
 * a separate mutex file `lock.reclaim` (O_EXCL; a mutex older than 10 s is itself stale): while holding
 * it we re-read `lock` and unlink it only if it is still exactly the content we judged stale, so a
 * lock someone else acquired in between is never touched. Release removes only a lock with our token.
 * Returns a release fn, or null when someone else holds it. `onStale` is a test hook.
 */
export function acquireLock(root, { now = Date.now, alive = pidAlive, pid = process.pid, onStale = null } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'lock');
  const mutex = path.join(root, 'lock.reclaim');
  const token = crypto.randomBytes(8).toString('hex');
  const tmp = path.join(root, `lock.${pid}.${token}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ pid, token, at: now() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        fs.linkSync(tmp, file);
        return () => {
          try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file, { force: true }); } catch {}
        };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      let raw = null, held = null;
      try { raw = fs.readFileSync(file, 'utf8'); held = JSON.parse(raw); } catch {}
      if (raw === null) continue; // vanished meanwhile → retry
      const stale = !held || typeof held.token !== 'string' || !alive(held.pid) || now() - Number(held.at) > LOCK_STALE_MS;
      if (!stale) return null;
      if (onStale) onStale();
      let haveMutex = false;
      try { fs.closeSync(fs.openSync(mutex, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)); haveMutex = true; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let old = false;
        try { old = Date.now() - fs.statSync(mutex).mtimeMs > 10_000; } catch {}
        if (old) { try { fs.rmSync(mutex, { force: true }); } catch {} continue; }
        return null; // another reclaimer is working: busy
      }
      try {
        let again = null;
        try { again = fs.readFileSync(file, 'utf8'); } catch {}
        if (again === raw) { try { fs.rmSync(file, { force: true }); } catch {} }
      } finally { if (haveMutex) { try { fs.rmSync(mutex, { force: true }); } catch {} } }
    }
    return null;
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

// ── session storage ──

function readSessions(root) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const n of names) {
    const dir = path.join(root, n);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      out.push({ dir, session: JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) });
    } catch { out.push({ dir, session: null }); }
  }
  return out;
}

function defaultWhich(name) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}

const defaultDeps = () => ({
  root: LOGIN_ROOT,
  platform: process.platform,
  env: process.env,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  randomId: () => crypto.randomBytes(5).toString('hex'),
  which: defaultWhich,
  run: (cmd, argv, o = {}) => runCswap(cmd, { argv, input: o.input ?? '' }, { timeoutMs: o.timeoutMs ?? 30000, env: o.env, cwd: o.cwd }),
});

const tail = (s, n = 400) => String(s ?? '').replace(/https?:\/\/\S+/g, '<url>').trim().slice(-n);

// ── main logic (all I/O via deps) ──

export async function runLogin(rawArgs, depsIn = {}) {
  const d = { ...defaultDeps(), ...depsIn };
  if (d.platform !== 'linux') return `❌ /login chưa hỗ trợ trên ${d.platform}`;
  const cmd = parseArgs(rawArgs);
  const release = acquireLock(d.root, { now: d.now, alive: d.alive, pid: d.pid });
  if (!release) return '⏳ /login đang xử lý, thử lại sau ít phút';
  try { return await handle(cmd, d); } finally { release(); }
}

async function screenAlive(d, name) {
  const r = await d.run('screen', ['-ls'], {});
  return new RegExp(`\\.${name}(\\s|$)`, 'm').test(r.stdout || '');
}

async function cleanup(d, entry) {
  if (!entry) return;
  const name = entry.session?.screen;
  if (name && /^tele-login-[0-9a-f]+$/.test(name)) {
    try { if (await screenAlive(d, name)) await d.run('screen', ['-S', name, '-X', 'quit'], {}); } catch {}
  }
  try { fs.rmSync(entry.dir, { recursive: true, force: true }); } catch {}
}

async function current(d) {
  const all = readSessions(d.root);
  const valid = all.filter((e) => e.session && e.session.id && e.session.url).sort((a, b) => b.session.startedAt - a.session.startedAt);
  for (const e of all) if (e !== valid[0]) await cleanup(d, e);
  return valid[0] || null;
}

async function live(d, entry) {
  if (!entry) return false;
  if (d.now() >= entry.session.expiresAt) return false;
  return screenAlive(d, entry.session.screen);
}

async function handle(cmd, d) {
  let entry = await current(d);
  // A session whose `claude` already finished (exit file): complete it now (late completion) or drop it.
  if (entry && fs.existsSync(path.join(entry.dir, 'exit'))) {
    let ec = '';
    try { ec = fs.readFileSync(path.join(entry.dir, 'exit'), 'utf8').trim(); } catch {}
    if (ec === '0') {
      const r = await finishLogin(entry, d);
      return cmd.kind === 'submit' ? `ℹ️ login đã xong từ trước, không cần mã nữa.\n${r}` : r;
    }
    await cleanup(d, entry); entry = null;
  }
  if (cmd.kind === 'cancel') {
    if (!entry) return 'ℹ️ không có phiên login nào đang chờ';
    if (!(await screenAlive(d, entry.session.screen))) {
      const r = await settle(entry, d); // claude may have finished just now
      if (r) return `ℹ️ login đã xong trước khi huỷ.\n${r}`;
    }
    await cleanup(d, entry);
    return '🗑️ đã huỷ phiên login';
  }
  if (cmd.kind === 'other') {
    if (!entry) return 'chưa có phiên login nào, gõ /login trước';
    return '❌ mã không đúng định dạng (dạng <code>#<state>). Phiên vẫn giữ, gửi lại /login <mã>';
  }
  if (cmd.kind === 'submit') {
    if (!entry) return 'chưa có phiên login nào, gõ /login trước';
    if (!(await live(d, entry))) {
      const r = await settle(entry, d);
      if (r) return `ℹ️ login đã xong từ trước, không cần mã nữa.\n${r}`;
      await cleanup(d, entry); return 'phiên login đã hết hạn, gõ /login lại';
    }
    return submit(cmd.code, entry, d);
  }
  // start
  if (entry && (await live(d, entry))) {
    const mins = Math.max(1, Math.ceil((entry.session.expiresAt - d.now()) / 60000));
    return startMessage(entry.session.url, mins);
  }
  if (entry) {
    const r = await settle(entry, d);
    if (r) return r;
    await cleanup(d, entry); entry = null;
  }
  return start(d);
}

/** The screen is gone / the session expired: if `claude` exited 0 in the meantime, finish the login (returns its report); else null. */
async function settle(entry, d) {
  let ec = '';
  try { ec = fs.readFileSync(path.join(entry.dir, 'exit'), 'utf8').trim(); } catch {}
  return ec === '0' ? finishLogin(entry, d) : null;
}

const startMessage = (url, mins) => `🔑 Mở link này, chọn account, rồi gửi lại: /login <mã>\n${url}\n⏳ Hết hạn sau ${mins} phút · /login cancel để huỷ`;

async function start(d) {
  const missing = ['claude', 'cswap', 'screen', 'timeout'].filter((n) => !d.which(n));
  if (missing.length) return `❌ thiếu trong PATH: ${missing.join(', ')}`;
  const id = d.randomId();
  const dir = path.join(d.root, id);
  const name = `tele-login-${id}`;
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const sessionFile = path.join(dir, 'session.json');
  const startedAt = d.now();
  const session = { id, screen: name, startedAt, expiresAt: startedAt + SESSION_MS };
  fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
  const entry = { dir, session };
  const env = loginEnv(d.env, configDir);
  const wrapper = `timeout --foreground 600 claude auth login --claudeai; echo $? > ${shq(path.join(dir, 'exit.tmp'))} && mv ${shq(path.join(dir, 'exit.tmp'))} ${shq(path.join(dir, 'exit'))}`;
  const r = await d.run('screen', ['-dmS', name, 'sh', '-c', wrapper], { env, cwd: dir });
  if (r.error || (r.status != null && r.status !== 0)) { await cleanup(d, entry); return `❌ không mở được screen: ${tail(r.error?.message || r.stderr)}`; }
  const hc = path.join(dir, 'hc.txt');
  const deadline = d.now() + URL_WAIT_MS;
  let url = null;
  while (true) {
    await d.run('screen', ['-S', name, '-X', 'hardcopy', hc], {});
    try { fs.chmodSync(hc, 0o600); url = extractLoginUrl(fs.readFileSync(hc, 'utf8')); } catch {}
    if (url || d.now() >= deadline) break;
    await d.sleep(POLL_MS);
  }
  if (!url) { await cleanup(d, entry); return '❌ không lấy được URL login (output của claude auth login có thể đã đổi)'; }
  session.url = url;
  fs.writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 });
  return startMessage(url, Math.round(SESSION_MS / 60000));
}

async function submit(code, entry, d) {
  const { dir, session } = entry;
  const name = session.screen;
  const codeFile = path.join(dir, 'code');
  fs.writeFileSync(codeFile, code, { mode: 0o600 });
  try {
    await d.run('screen', ['-S', name, '-X', 'readreg', 'p', codeFile], {});
    await d.run('screen', ['-S', name, '-X', 'paste', 'p'], {});
    await d.run('screen', ['-S', name, '-X', 'stuff', '\r'], {});
  } finally { try { fs.rmSync(codeFile, { force: true }); } catch {} }
  const exitFile = path.join(dir, 'exit');
  const deadline = d.now() + CODE_WAIT_MS;
  let exitCode = null;
  while (true) {
    try { exitCode = fs.readFileSync(exitFile, 'utf8').trim(); } catch {}
    if (exitCode !== null) break;
    if (d.now() >= deadline) break;
    await d.sleep(POLL_MS);
  }
  if (exitCode === null) return '⏳ chưa xong — có thể mã sai. Gửi lại /login <mã> hoặc /login cancel';
  if (exitCode !== '0') { await cleanup(d, entry); return `❌ login thất bại (mã thoát ${exitCode}), gõ /login để thử lại`; }
  return finishLogin(entry, d);
}

/** claude exited 0: verify the isolated profile is logged in, `cswap add`, report, clean up. */
async function finishLogin(entry, d) {
  const { dir } = entry;
  const configDir = path.join(dir, 'config');
  const env = loginEnv(d.env, configDir);
  const st = await d.run('claude', ['auth', 'status', '--json'], { env, cwd: dir });
  let status = null;
  try { status = JSON.parse(st.stdout); } catch {}
  if (!status || status.loggedIn !== true) { await cleanup(d, entry); return '❌ login thất bại: claude auth status không báo đã đăng nhập'; }
  const add = await d.run('cswap', ['add'], { env, cwd: dir, input: '', timeoutMs: 60000 });
  if (add.error || add.signal || add.status !== 0) {
    const msg = tail(`${add.stdout || ''}\n${add.stderr || ''}\n${add.error?.message || ''}`);
    await cleanup(d, entry);
    return `❌ cswap add lỗi: ${msg || '(không có output)'}`;
  }
  const addLine = String(add.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  let activeLine = '';
  let refreshed = false;
  const addSlot = Number((/\bAccount[- ](\d+)\b/.exec(String(add.stdout || '')) || [])[1]);
  const act = await d.run('cswap', ['status', '--json'], { env: d.env, input: '' });
  let a = null;
  if (!act.error && !act.signal && act.status === 0) { try { a = JSON.parse(act.stdout)?.active || null; } catch {} }
  if (!a?.email) activeLine = '\n⚠️ không kiểm tra được account đang dùng';
  else {
    const n = Number(a.number);
    const same = Number.isInteger(n) && n > 0 && addSlot === n && a.email === status.email
      && (a.organizationUuid || '') === (status.orgId || '');
    if (!same) activeLine = `\nđang dùng vẫn là: ${a.email}`;
    else {
      // The active account is the one just stored: its live credential is stale, refresh it from the slot.
      const sw = await d.run('cswap', ['--switch-to', String(n), '--force'], { env: d.env, input: '', timeoutMs: 60000 });
      if (sw.error || sw.signal || sw.status !== 0) {
        const m = tail(`${sw.stdout || ''}\n${sw.stderr || ''}\n${sw.error?.message || ''}`);
        activeLine = `\n⚠️ chưa nạp được vào máy: ${m || '(không có output)'}; chạy /cs ${n} để thử lại`;
      } else { activeLine = '\nđã nạp credential mới vào máy (account đang dùng)'; refreshed = true; }
    }
  }
  await cleanup(d, entry);
  const who = [status.email, status.orgName].filter(Boolean).join(' · ');
  return `✅ đã thêm account${who ? `: ${who}` : ''}${addLine ? `\n${addLine}` : ''}${activeLine}${refreshed ? '' : '\nđổi sang account mới bằng /cs <số>'}`;
}

if (isMainModule(import.meta.url)) {
  try { process.stdout.write(`${await runLogin(process.env.TELE_RAW_ARGS ?? '')}\n`); }
  catch (e) { process.stdout.write(`❌ /login lỗi: ${e?.message ?? e}\n`); process.exit(1); }
}
