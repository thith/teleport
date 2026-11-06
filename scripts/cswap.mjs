// `/cswap` (alias `/cs`) — wraps the `cswap` CLI (https://github.com/realiti4/claude-swap),
// the multi-account switcher for Claude Code, so it can be driven from Telegram:
//   /cswap          → cswap --list --json    (rendered as a plain-text list, 🟢 = active account)
//   /cswap <n>      → cswap --switch-to <n> --json, then --list --json (header line + the same list)
//   /cswap add      → cswap add              (add the current login as an account)
//   /cswap rm <n>   → cswap remove <n>       (confirmation "y" is piped in; typing it is the consent)
//   /cswap auto     → cswap auto --once --strategy consume-first  (one check; if near the limit, switch to the account whose weekly window resets soonest)
//   /cswap upgrade  → cswap upgrade          (download the latest cswap)
//   /cswap switch <x> → cswap --switch-to <x> --json (same as <n>; force a switch; add/rm/remove/auto/upgrade/update
//                       are reserved words, so an account with such a name needs `switch`)
// Only list and switch are re-rendered (plan.format = 'list' | 'switch'); add/rm/auto/upgrade
// pass cswap's raw stdout through. stderr, [killed: ...] and the footer are always passed through.
// `cswap` must already be installed and on PATH (it is on this host). Switching
// accounts is host-wide — it affects every agent sharing this machine's Claude
// Code login — so the command is gated to maintainer in commands.json.
import { isMainModule } from './is-direct-run.mjs';
import { spawn } from 'node:child_process';

export const CSWAP_TIMEOUT_MS = 30 * 1000;

export const CSWAP_UPGRADE_TIMEOUT_MS = 180 * 1000;

// Build the cswap invocation for `/cswap [sub|target] ...`. Pure (no I/O), so
// it's directly testable. Returns { argv, input?, timeoutMs? } or { error }.
// `input` is always fed to stdin ('' by default) so nothing can hang on a prompt.
export function planCswap(args) {
  const first = args[0];
  const blank = (x) => x == null || !String(x).trim();
  if (blank(first)) return { argv: ['--list', '--json'], format: 'list' };
  switch (String(first).trim().toLowerCase()) {
    case 'add': return { argv: ['add'] };
    case 'switch':
      if (blank(args[1])) return { error: 'cách dùng: /cs switch <số|email|alias>' };
      return { argv: ['--switch-to', String(args[1]).trim(), '--json'], format: 'switch' };
    case 'rm':
    case 'remove':
      if (blank(args[1])) return { error: 'cách dùng: /cs rm <số|email>' };
      return { argv: ['remove', String(args[1]).trim()], input: 'y\n' };
    case 'auto': return { argv: ['auto', '--once', '--strategy', 'consume-first'] };
    case 'upgrade':
    case 'update': return { argv: ['upgrade'], timeoutMs: CSWAP_UPGRADE_TIMEOUT_MS };
    default: return { argv: ['--switch-to', String(first).trim(), '--json'], format: 'switch' };
  }
}

// Run `cmd` with the plan; resolves { stdout, stderr, status, signal, error }. The child is its own
// process group so on timeout the whole tree (e.g. `uv tool upgrade`) is killed: SIGTERM, then
// SIGKILL after killGraceMs.
export function runCswap(cmd, plan, { timeoutMs = CSWAP_TIMEOUT_MS, killGraceMs = 5000, maxBytes = 1024 * 1024, env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, plan.argv, { detached: true, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }); }
    catch (error) { return resolve({ stdout: '', stderr: '', status: null, signal: null, error }); }
    let stdout = '', stderr = '', timedOut = false, done = false, hardKill = null;
    const grp = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const add = (cur, d) => (cur.length >= maxBytes ? cur : (cur + d).slice(0, maxBytes));
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout = add(stdout, d); });
    child.stderr.on('data', (d) => { stderr = add(stderr, d); });
    child.stdin.on('error', () => {});
    child.stdin.end(plan.input ?? '');
    const timer = setTimeout(() => { timedOut = true; grp('SIGTERM'); hardKill = setTimeout(() => grp('SIGKILL'), killGraceMs); }, timeoutMs);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(hardKill); if (timedOut) grp('SIGKILL'); resolve({ stdout, stderr, ...r }); };
    child.on('error', (error) => finish({ status: null, signal: null, error }));
    child.on('close', (status, signal) => finish({ status, signal: timedOut ? 'timeout' : signal, error: null }));
  });
}

// Exit code for a finished run: any signal (incl. our 'timeout') is a failure, even if the child exited 0.
export function exitCodeFor(r) { return r.signal ? (r.signal === 'timeout' ? 124 : 1) : (r.status == null ? 1 : r.status); }

// ---- rendering (pure) ----

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

function ago(sec) {
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} giờ trước` : `${m} phút trước`;
}

function windowLine(label, w, { clock = false, pace = false } = {}) {
  const pct = typeof w.pct === 'number' && Number.isFinite(w.pct) ? `${Math.round(w.pct)}%` : '?';
  let line = `◦ ${label} ${pct}`;
  if (w.countdown) line += ` · ${w.countdown}`;
  if (clock && w.clock) line += ` (${w.clock})`;
  if (pace && w.aheadOfPace === true) line += ' · vượt nhịp';
  return line;
}

const STATUS_TEXT = {
  relogin_required: '⚠️ cần login lại',
  no_credentials: '⚠️ cần login lại',
  token_expired: '⚠️ token hết hạn',
  api_key: 'API key',
  keychain_unavailable: '⚠️ keychain ko đọc được',
  foreign_credential: '⚠️ credential của account khác',
};

function formatAccount(a) {
  if (!isObj(a)) throw new TypeError('account row is not an object');
  if (a.number == null || typeof a.email !== 'string' || !a.email || typeof a.usageStatus !== 'string') throw new TypeError('account row is missing number/email/usageStatus');
  let head = `${a.active ? '🟢' : '⚪️'} ${a.number} · ${a.email}`;
  if (a.alias) head += ` (${a.alias})`;
  if (a.disabled) head += ' · tắt';
  const org = a.organizationName;
  if (org && org !== `${a.email}'s Organization`) head += ` · ${org}`;
  const lines = [head];
  const status = a.usageStatus;
  if (status !== 'ok') {
    let t = status === 'unavailable'
      ? `⚠️ chưa lấy được số liệu${a.usageError ? ` (${a.usageError})` : ''}`
      : (STATUS_TEXT[status] ?? `⚠️ ${status}`);
    const p = a.lastGoodUsage?.sevenDay?.pct;
    if (typeof p === 'number') {
      t += `, lần cuối ${Math.round(p)}%`;
      if (typeof a.lastGoodAgeSeconds === 'number') t += `, ${ago(a.lastGoodAgeSeconds)}`;
    }
    lines.push(`◦ ${t}`);
    return lines.join('\n');
  }
  const u = isObj(a.usage) ? a.usage : {};
  const before = lines.length;
  if (isObj(u.fiveHour)) lines.push(windowLine('5h', u.fiveHour, { clock: true }));
  if (isObj(u.sevenDay)) lines.push(windowLine('7d', u.sevenDay, { clock: true, pace: true }));
  if (Array.isArray(u.scoped)) for (const w of u.scoped) if (isObj(w)) lines.push(windowLine(String(w.name ?? '?'), w, { pace: true }));
  if (lines.length === before) lines.push('◦ chưa có số liệu');
  if (typeof a.usageAgeSeconds === 'number' && a.usageAgeSeconds >= 60) lines.push(`◦ số liệu ${ago(a.usageAgeSeconds)}`);
  return lines.join('\n');
}

// `cswap --list --json` object → plain-text list. Throws on an unexpected shape (renderListOutput catches).
export function formatAccounts(obj) {
  if (!isObj(obj) || !Array.isArray(obj.accounts)) throw new TypeError('unexpected shape');
  const text = obj.accounts.length ? obj.accounts.map(formatAccount).join('\n\n') : 'Chưa có account nào';
  const warn = (x) => `⚠️ ${typeof x === 'string' ? x : JSON.stringify(x)}`;
  const extra = [];
  for (const k of ['duplicateAccountWarnings', 'lockstepUsageWarnings']) if (Array.isArray(obj[k])) extra.push(...obj[k].map(warn));
  if (Array.isArray(obj.unclaimedCredentials) && obj.unclaimedCredentials.length) {
    extra.push(`⚠️ credential ko thuộc account nào: ${obj.unclaimedCredentials.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')}`);
  }
  return extra.length ? `${text}\n\n${extra.join('\n')}` : text;
}

function tryParse(stdout) {
  try { return { ok: true, value: JSON.parse(stdout) }; } catch { return { ok: false }; }
}

const errorText = (e) => `❌ ${isObj(e) ? (e.message || JSON.stringify(e)) : String(e)}`;

// Render a list-path stdout. Never throws: non-JSON → unchanged, error envelope → ❌, odd shape → pretty JSON.
export function renderListOutput(stdout) {
  const raw = String(stdout ?? '');
  const p = tryParse(raw);
  if (!p.ok) return raw.trimEnd();
  const obj = p.value;
  if (isObj(obj) && obj.error) return errorText(obj.error);
  try { return formatAccounts(obj); } catch { return JSON.stringify(obj, null, 2); }
}

// `cswap --switch-to --json` payload → header lines (outcome + warnings).
export function formatSwitchHeader(payload) {
  const p = isObj(payload) ? payload : {};
  const lines = [];
  const to = p.to?.number;
  const from = p.from?.number;
  if (p.switched === true) lines.push(from != null ? `✅ Đã chuyển ${from} → ${to}` : `✅ Đã chuyển sang ${to}`);
  else if (p.reason === 'already-active') lines.push(`Đang ở ${to} rồi`);
  else lines.push(String(p.message || p.reason || JSON.stringify(p)));
  if (Array.isArray(p.warnings)) for (const w of p.warnings) lines.push(`⚠️ ${w}`);
  return lines.join('\n');
}

// Tappable shortcuts appended to every /cs result (Telegram links /commands).
export const CS_FOOTER = "\n/health · /ls";

if (isMainModule(import.meta.url)) {
  const plan = planCswap(process.argv.slice(2));
  if (plan.error) { process.stdout.write(`${plan.error}\n`); process.exit(2); }
  const out = (t) => process.stdout.write(t);
  const tail = (r) => {
    if (r.stderr) out(`\n[stderr]\n${r.stderr}`);
    if (r.signal) out(`\n[killed: ${r.signal}]\n`);
  };
  const run = (p) => runCswap('cswap', p, { timeoutMs: p.timeoutMs ?? CSWAP_TIMEOUT_MS });
  const missing = (r) => `❌ ${r.error.code === 'ENOENT' ? 'cswap not found on PATH' : r.error.message}\n`;
  const r = await run(plan);
  let code = exitCodeFor(r);
  if (r.error) { out(missing(r)); process.exit(1); }
  if (plan.format === 'list') {
    const text = renderListOutput(r.stdout);
    if (text) out(text + '\n');
    tail(r);
  } else if (plan.format === 'switch') {
    const p = tryParse(r.stdout);
    const okPayload = code === 0 && p.ok && isObj(p.value) && !p.value.error && typeof p.value.switched === 'boolean';
    if (!okPayload) {
      // failed switch: never claim success; show the failure per the fallback rules
      const text = !p.ok ? r.stdout.trimEnd()
        : isObj(p.value) && p.value.error ? errorText(p.value.error)
        : JSON.stringify(p.value, null, 2);
      if (text) out(text + '\n');
      tail(r);
    } else {
      out(formatSwitchHeader(p.value) + '\n');
      tail(r);
      const l = await run({ argv: ['--list', '--json'] });
      if (l.error) out(`\n${missing(l)}`);
      else {
        const text = renderListOutput(l.stdout);
        if (text) out('\n' + text + '\n');
        tail(l);
      }
    }
  } else {
    if (r.stdout) out(r.stdout.trimEnd() + "\n");
    tail(r);
  }
  out(CS_FOOTER + '\n');
  process.exit(code);
}
