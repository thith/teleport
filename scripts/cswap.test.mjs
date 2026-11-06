import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { planCswap, runCswap, exitCodeFor } from './cswap.mjs';

test('planCswap: no args → --list', () => {
  assert.deepEqual(planCswap([]), { argv: ['--list', '--json'], format: 'list' });
});

test('planCswap: numeric target → --switch-to <n>', () => {
  assert.deepEqual(planCswap(['2']), { argv: ['--switch-to', '2', '--json'], format: 'switch' });
});

test('planCswap: email target passes through verbatim (cswap itself validates NUM|EMAIL)', () => {
  assert.deepEqual(planCswap(['a@b.com']), { argv: ['--switch-to', 'a@b.com', '--json'], format: 'switch' });
});

test('planCswap: only the first token is used as target', () => {
  assert.deepEqual(planCswap(['2', 'extra']), { argv: ['--switch-to', '2', '--json'], format: 'switch' });
});

test('planCswap: add', () => {
  assert.deepEqual(planCswap(['add']), { argv: ['add'] });
});

test('planCswap: rm/remove <target> → remove with "y" on stdin', () => {
  assert.deepEqual(planCswap(['rm', '2']), { argv: ['remove', '2'], input: 'y\n' });
  assert.deepEqual(planCswap(['remove', 'a@b.com']), { argv: ['remove', 'a@b.com'], input: 'y\n' });
});

test('planCswap: rm without target → usage error, no argv', () => {
  assert.deepEqual(planCswap(['rm']), { error: 'cách dùng: /cs rm <số|email>' });
  assert.equal(planCswap(['remove']).argv, undefined);
});

test('planCswap: auto → auto --once --strategy consume-first', () => {
  assert.deepEqual(planCswap(['auto']), { argv: ['auto', '--once', '--strategy', 'consume-first'] });
});

test('planCswap: upgrade/update → upgrade with a long timeout', () => {
  assert.deepEqual(planCswap(['upgrade']), { argv: ['upgrade'], timeoutMs: 180000 });
  assert.deepEqual(planCswap(['update']), { argv: ['upgrade'], timeoutMs: 180000 });
});

test('planCswap: keywords are case-insensitive; target keeps its case', () => {
  assert.deepEqual(planCswap(['ADD']), { argv: ['add'] });
  assert.deepEqual(planCswap(['Rm', 'A@B.com']), { argv: ['remove', 'A@B.com'], input: 'y\n' });
  assert.deepEqual(planCswap(['Auto']), { argv: ['auto', '--once', '--strategy', 'consume-first'] });
});

test('/cs is an alias of /cswap in commands.json', async () => {
  const fs = await import('node:fs');
  const { resolveCommand } = await import('./commands.mjs');
  const reg = JSON.parse(fs.readFileSync(new URL('../commands.json', import.meta.url), 'utf8'));
  assert.equal(resolveCommand('cs', reg).run, 'cswap.mjs');
  assert.deepEqual(resolveCommand('cs', reg), resolveCommand('cswap', reg));
});

test('planCswap: switch <x> forces a switch, even for reserved words', () => {
  assert.deepEqual(planCswap(['switch', 'auto']), { argv: ['--switch-to', 'auto', '--json'], format: 'switch' });
  assert.deepEqual(planCswap(['SWITCH', '2']), { argv: ['--switch-to', '2', '--json'], format: 'switch' });
  assert.deepEqual(planCswap(['switch']), { error: 'cách dùng: /cs switch <số|email|alias>' });
});

test('planCswap: blank targets count as missing', () => {
  assert.deepEqual(planCswap(['']), { argv: ['--list', '--json'], format: 'list' });
  assert.deepEqual(planCswap(['  ']), { argv: ['--list', '--json'], format: 'list' });
  assert.deepEqual(planCswap(['rm', '']), { error: 'cách dùng: /cs rm <số|email>' });
  assert.deepEqual(planCswap(['rm', ' ']), { error: 'cách dùng: /cs rm <số|email>' });
  assert.deepEqual(planCswap(['switch', '']), { error: 'cách dùng: /cs switch <số|email|alias>' });
});

test('runCswap: feeds stdin, collects stdout/stderr, returns exit status', async () => {
  const r = await runCswap(process.execPath, { argv: ['-e', 'process.stdin.on("data",d=>{process.stdout.write("got:"+d);console.error("e");process.exit(3)})'], input: 'y\n' });
  assert.equal(r.stdout, 'got:y\n'); assert.equal(r.stderr, 'e\n'); assert.equal(r.status, 3); assert.equal(r.signal, null);
});

test('planCswap: targets are trimmed', () => {
  assert.deepEqual(planCswap(['rm', ' 2 ']), { argv: ['remove', '2'], input: 'y\n' });
  assert.deepEqual(planCswap(['switch', ' 3 ']), { argv: ['--switch-to', '3', '--json'], format: 'switch' });
  assert.deepEqual(planCswap([' 4 ']), { argv: ['--switch-to', '4', '--json'], format: 'switch' });
});

const isDead = (pid) => {
  try { process.kill(pid, 0); } catch { return true; }
  try { return /^\d+ \([^)]*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
};

test('runCswap: timeout kills the whole process group (grandchild too)', async () => {
  // child prints the grandchild pid right away; generous timeout so Node startup can't eat it
  const code = 'const {spawn}=require("child_process");const c=spawn("sleep",["60"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)';
  const r = await runCswap(process.execPath, { argv: ['-e', code] }, { timeoutMs: 1500, killGraceMs: 300 });
  assert.equal(r.signal, 'timeout');
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0);
  const deadline = Date.now() + 3000;
  while (!isDead(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  assert.equal(isDead(pid), true, 'grandchild must be gone');
});

test('timeout is a failure exit even if the child traps SIGTERM and exits 0', async () => {
  const code = 'process.on("SIGTERM",()=>process.exit(0));console.log("up");setInterval(()=>{},1000)';
  const r = await runCswap(process.execPath, { argv: ['-e', code] }, { timeoutMs: 1500, killGraceMs: 300 });
  assert.equal(r.status, 0); assert.equal(r.signal, 'timeout');
  assert.equal(exitCodeFor(r), 124);
  assert.equal(exitCodeFor({ status: 0, signal: null }), 0);
  assert.equal(exitCodeFor({ status: 3, signal: null }), 3);
  assert.equal(exitCodeFor({ status: null, signal: 'SIGKILL' }), 1);
});

test('CS_FOOTER: tappable /health and /ls shortcuts', async () => {
  const { CS_FOOTER } = await import('./cswap.mjs');
  assert.match(CS_FOOTER, /\/health/);
  assert.match(CS_FOOTER, /\/ls/);
});

// ---- rendering ----
import { formatAccounts, renderListOutput, formatSwitchHeader } from './cswap.mjs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const acct = (o) => ({ number: 1, email: 'a@x.io', organizationName: `${o.email ?? 'a@x.io'}'s Organization`, active: false, usageStatus: 'ok', usage: { sevenDay: { pct: 10 } }, ...o });
const one = (o) => formatAccounts({ accounts: [acct(o)] });
const head = (o) => one(o).split('\n')[0];
const body = (o) => one(o).split('\n').slice(1).join('\n');

test('formatAccounts: exact sample', () => {
  const obj = { schemaVersion: 1, activeAccountNumber: 1, accounts: [
    acct({ number: 1, email: 'a@example.com', active: true, usage: { sevenDay: { pct: 71.0, countdown: '1d 20h', clock: 'Nov 8 06:00', aheadOfPace: false }, scoped: [{ name: 'Fable', pct: 0, countdown: '1d 20h', clock: 'Nov 8 06:00' }] }, usageAgeSeconds: 0 }),
    acct({ number: 2, email: 'b@example.com', organizationName: "b@example.com's Organization", usage: { fiveHour: { pct: 20, countdown: '2h 27m', clock: '12:19' }, sevenDay: { pct: 99, countdown: '13h 7m', clock: '22:59' }, scoped: [{ name: 'Fable', pct: 0, countdown: '13h 7m', clock: '23:00' }] }, usageAgeSeconds: 12 }),
    acct({ number: 3, email: 'c@example.com', usage: { sevenDay: { pct: 100, countdown: '2d 5h', clock: 'Nov 8 15:00', aheadOfPace: true }, scoped: [{ name: 'Fable', pct: 0, countdown: '2d 5h', clock: 'Nov 8 15:00' }] }, usageAgeSeconds: 360 }),
  ] };
  assert.equal(formatAccounts(obj), `🟢 1 · a@example.com
◦ 7d 71% · 1d 20h (Nov 8 06:00)
◦ Fable 0% · 1d 20h

⚪️ 2 · b@example.com
◦ 5h 20% · 2h 27m (12:19)
◦ 7d 99% · 13h 7m (22:59)
◦ Fable 0% · 13h 7m

⚪️ 3 · c@example.com
◦ 7d 100% · 2d 5h (Nov 8 15:00) · vượt nhịp
◦ Fable 0% · 2d 5h
◦ số liệu 6 phút trước`);
});

test('formatAccounts: org hidden when empty/default, shown otherwise', () => {
  assert.equal(head({ organizationName: '' }), '⚪️ 1 · a@x.io');
  assert.equal(head({ organizationName: undefined }), '⚪️ 1 · a@x.io');
  assert.equal(head({}), '⚪️ 1 · a@x.io');
  assert.equal(head({ organizationName: 'Acme' }), '⚪️ 1 · a@x.io · Acme');
});

test('formatAccounts: alias, disabled, header order', () => {
  assert.equal(head({ alias: 'work' }), '⚪️ 1 · a@x.io (work)');
  assert.equal(head({ disabled: true }), '⚪️ 1 · a@x.io · tắt');
  assert.equal(head({ alias: 'w', disabled: true, organizationName: 'Acme' }), '⚪️ 1 · a@x.io (w) · tắt · Acme');
});

test('formatAccounts: window parts omitted, rounding, pace only on 7d/scoped', () => {
  assert.equal(body({ usage: { fiveHour: { pct: 19.6 } } }), '◦ 5h 20%');
  assert.equal(body({ usage: { sevenDay: { pct: 5, clock: '10:00' } } }), '◦ 7d 5% (10:00)');
  assert.equal(body({ usage: { scoped: [{ name: 'Fable', pct: 1, countdown: '1h', clock: '9:00', aheadOfPace: true }] } }), '◦ Fable 1% · 1h · vượt nhịp');
  assert.equal(body({ usage: { fiveHour: { pct: 5, aheadOfPace: true } } }), '◦ 5h 5%');
});

test('formatAccounts: non-ok statuses', () => {
  assert.equal(body({ usageStatus: 'relogin_required' }), '◦ ⚠️ cần login lại');
  assert.equal(body({ usageStatus: 'no_credentials' }), '◦ ⚠️ cần login lại');
  assert.equal(body({ usageStatus: 'token_expired' }), '◦ ⚠️ token hết hạn');
  assert.equal(body({ usageStatus: 'api_key' }), '◦ API key');
  assert.equal(body({ usageStatus: 'keychain_unavailable' }), '◦ ⚠️ keychain ko đọc được');
  assert.equal(body({ usageStatus: 'foreign_credential' }), '◦ ⚠️ credential của account khác');
  assert.equal(body({ usageStatus: 'unavailable' }), '◦ ⚠️ chưa lấy được số liệu');
  assert.equal(body({ usageStatus: 'unavailable', usageError: 'HTTP 429' }), '◦ ⚠️ chưa lấy được số liệu (HTTP 429)');
  assert.equal(body({ usageStatus: 'weird' }), '◦ ⚠️ weird');
  assert.equal(body({ usageStatus: 'token_expired', usage: { sevenDay: { pct: 50 } } }), '◦ ⚠️ token hết hạn');
});

test('formatAccounts: lastGood appended', () => {
  const lg = { sevenDay: { pct: 62.4 } };
  assert.equal(body({ usageStatus: 'token_expired', lastGoodUsage: lg }), '◦ ⚠️ token hết hạn, lần cuối 62%');
  assert.equal(body({ usageStatus: 'token_expired', lastGoodUsage: lg, lastGoodAgeSeconds: 600 }), '◦ ⚠️ token hết hạn, lần cuối 62%, 10 phút trước');
  assert.equal(body({ usageStatus: 'unavailable', usageError: 'x', lastGoodUsage: lg, lastGoodAgeSeconds: 7300 }), '◦ ⚠️ chưa lấy được số liệu (x), lần cuối 62%, 2 giờ trước');
  assert.equal(body({ usageStatus: 'api_key', lastGoodUsage: {}, lastGoodAgeSeconds: 600 }), '◦ API key');
});

test('formatAccounts: ok without any window', () => {
  assert.equal(body({ usage: {} }), '◦ chưa có số liệu');
  assert.equal(body({ usage: undefined }), '◦ chưa có số liệu');
});

test('formatAccounts: age boundary 59/60s and hours', () => {
  const last = (s) => one({ usageAgeSeconds: s }).split('\n').pop();
  assert.equal(last(59.9), '◦ 7d 10%');
  assert.equal(last(60), '◦ số liệu 1 phút trước');
  assert.equal(last(3599), '◦ số liệu 59 phút trước');
  assert.equal(last(3600), '◦ số liệu 1 giờ trước');
  assert.equal(last(7260), '◦ số liệu 2 giờ trước');
});

test('formatAccounts: empty accounts; bad shapes throw', () => {
  assert.equal(formatAccounts({ accounts: [] }), 'Chưa có account nào');
  assert.throws(() => formatAccounts({ accounts: {} }));
  assert.throws(() => formatAccounts({ accounts: [1] }));
});

test('renderListOutput: passthrough, error envelope, odd shapes', () => {
  assert.equal(renderListOutput('plain text\n\n'), 'plain text');
  assert.equal(renderListOutput(''), '');
  assert.equal(renderListOutput(JSON.stringify({ error: { code: 'x', message: 'boom' } })), '❌ boom');
  assert.equal(renderListOutput(JSON.stringify({ accounts: 'nope' })), JSON.stringify({ accounts: 'nope' }, null, 2));
  assert.equal(renderListOutput(JSON.stringify({ accounts: [null] })), JSON.stringify({ accounts: [null] }, null, 2));
  assert.equal(renderListOutput('[1,2]'), JSON.stringify([1, 2], null, 2));
  assert.equal(renderListOutput(JSON.stringify({ accounts: [] })), 'Chưa có account nào');
});

test('formatAccounts: list warnings rendered after accounts (also when accounts is empty)', () => {
  const w = { duplicateAccountWarnings: ['dup A'], lockstepUsageWarnings: ['lock B', { x: 1 }], unclaimedCredentials: ['a', 'b'] };
  assert.equal(formatAccounts({ accounts: [acct({})], ...w }),
    '⚪️ 1 · a@x.io\n◦ 7d 10%\n\n⚠️ dup A\n⚠️ lock B\n⚠️ {"x":1}\n⚠️ credential ko thuộc account nào: a, b');
  assert.equal(formatAccounts({ accounts: [], unclaimedCredentials: ['z'] }), 'Chưa có account nào\n\n⚠️ credential ko thuộc account nào: z');
  assert.equal(formatAccounts({ accounts: [], duplicateAccountWarnings: [], unclaimedCredentials: [] }), 'Chưa có account nào');
});

test('formatAccounts: row validation → fallback to pretty JSON', () => {
  assert.throws(() => formatAccounts({ accounts: [{}] }));
  assert.throws(() => formatAccounts({ accounts: [acct({ number: undefined })] }));
  assert.throws(() => formatAccounts({ accounts: [acct({ email: '' })] }));
  assert.throws(() => formatAccounts({ accounts: [acct({ email: 5 })] }));
  assert.throws(() => formatAccounts({ accounts: [acct({ usageStatus: undefined })] }));
  assert.equal(renderListOutput('{"accounts":[{}]}'), JSON.stringify({ accounts: [{}] }, null, 2));
});

test('renderListOutput: empty error message keeps the error object', () => {
  assert.equal(renderListOutput(JSON.stringify({ error: { code: 'x', message: '' } })), '❌ {"code":"x","message":""}');
});

test('e2e: switch with valid JSON but invalid payload → pretty JSON, no success claim', () => {
  const v = { foo: 1 };
  const r = e2e(['2'], { list: LIST, sw: JSON.stringify(v), swStatus: 0 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, JSON.stringify(v, null, 2) + '\n' + FOOT);
  const r2 = e2e(['2'], { list: LIST, sw: JSON.stringify(v), swStatus: 2 });
  assert.equal(r2.status, 2); assert.equal(r2.stdout, JSON.stringify(v, null, 2) + '\n' + FOOT);
});

test('formatSwitchHeader: never an empty header', () => {
  assert.equal(formatSwitchHeader({ switched: false, reason: 'weird' }), 'weird');
  assert.equal(formatSwitchHeader({ switched: false, message: '' }), '{"switched":false,"message":""}');
});

test('formatSwitchHeader variants', () => {
  const to = { number: 2, email: 'b@x' };
  assert.equal(formatSwitchHeader({ switched: true, from: { number: 1 }, to }), '✅ Đã chuyển 1 → 2');
  assert.equal(formatSwitchHeader({ switched: true, to }), '✅ Đã chuyển sang 2');
  assert.equal(formatSwitchHeader({ switched: true, from: {}, to }), '✅ Đã chuyển sang 2');
  assert.equal(formatSwitchHeader({ switched: false, reason: 'already-active', to }), 'Đang ở 2 rồi');
  assert.equal(formatSwitchHeader({ switched: false, reason: 'other', message: 'không được', to }), 'không được');
  assert.equal(formatSwitchHeader({ switched: true, from: { number: 1 }, to, warnings: ['a', 'b'] }), '✅ Đã chuyển 1 → 2\n⚠️ a\n⚠️ b');
});

// ---- end-to-end main block with a fake cswap on PATH (every spawn has a timeout) ----
const CSWAP_JS = new URL('./cswap.mjs', import.meta.url).pathname;

function e2e(args, { list = '', sw = '', swStatus = 0, listStatus = 0, swErr = '', listErr = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecswap-'));
  try {
    fs.writeFileSync(path.join(dir, 'list.json'), list);
    fs.writeFileSync(path.join(dir, 'sw.json'), sw);
    fs.writeFileSync(path.join(dir, 'cswap'), `#!/bin/sh
d="$(dirname "$0")"
case "$1" in
  --list) cat "$d/list.json"; printf '%s' '${listErr}' >&2; exit ${listStatus};;
  --switch-to) cat "$d/sw.json"; printf '%s' '${swErr}' >&2; exit ${swStatus};;
  *) echo "raw $*";;
esac
`, { mode: 0o755 });
    return spawnSync(process.execPath, [CSWAP_JS, ...args], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const LIST = JSON.stringify({ accounts: [acct({ number: 2, email: 'b@x', active: true })] });
const FOOT = '\n/health · /ls\n';

test('e2e: list renders, stderr raw, footer last', () => {
  const r = e2e([], { list: LIST, listErr: 'warn!' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `🟢 2 · b@x\n◦ 7d 10%\n\n[stderr]\nwarn!${FOOT}`);
});

test('e2e: list non-JSON passes through; empty prints only stderr+footer; error envelope keeps exit', () => {
  assert.equal(e2e([], { list: 'old text\n' }).stdout, 'old text\n' + FOOT);
  assert.equal(e2e([], { list: '', listErr: 'why' }).stdout, `\n[stderr]\nwhy${FOOT}`);
  const r = e2e([], { list: JSON.stringify({ error: { message: 'bad' } }), listStatus: 3 });
  assert.equal(r.stdout, '❌ bad\n' + FOOT); assert.equal(r.status, 3);
});

test('e2e: successful switch → header, blank line, list; footer last', () => {
  const sw = JSON.stringify({ switched: true, from: { number: 1, email: 'a' }, to: { number: 2, email: 'b@x' }, warnings: ['w1'] });
  const r = e2e(['2'], { list: LIST, sw });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `✅ Đã chuyển 1 → 2\n⚠️ w1\n\n🟢 2 · b@x\n◦ 7d 10%\n${FOOT}`);
  const r2 = e2e(['switch', '2'], { list: LIST, sw, swErr: 'e' });
  assert.equal(r2.stdout, `✅ Đã chuyển 1 → 2\n⚠️ w1\n\n[stderr]\ne\n🟢 2 · b@x\n◦ 7d 10%\n${FOOT}`);
});

test('e2e: already-active is a no-op header; bad follow-up list does not fail the switch', () => {
  const sw = JSON.stringify({ switched: false, reason: 'already-active', to: { number: 2 } });
  const r = e2e(['2'], { list: 'garbage', sw });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `Đang ở 2 rồi\n\ngarbage\n${FOOT}`);
});

test('e2e: failed switch keeps exit code, never claims success, no list', () => {
  const r = e2e(['9'], { list: LIST, sw: JSON.stringify({ error: { message: 'no such account' } }), swStatus: 4, swErr: 'bad' });
  assert.equal(r.status, 4);
  assert.equal(r.stdout, `❌ no such account\n\n[stderr]\nbad${FOOT}`);
  const r2 = e2e(['9'], { list: LIST, sw: 'Account not found\n', swStatus: 1 });
  assert.equal(r2.status, 1); assert.equal(r2.stdout, 'Account not found\n' + FOOT);
  const r3 = e2e(['2'], { list: LIST, sw: JSON.stringify({ switched: true, to: { number: 2 } }), swStatus: 5 });
  assert.equal(r3.status, 5); assert.doesNotMatch(r3.stdout, /Đã chuyển/);
});

test('e2e: add stays raw', () => {
  assert.equal(e2e(['add']).stdout, 'raw add\n' + FOOT);
});
