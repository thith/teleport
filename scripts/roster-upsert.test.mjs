import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertMember, harvestMembers, normUsername } from './roster-upsert.mjs';

function tmpJson(obj) {
  const f = path.join(os.tmpdir(), `roster-${process.pid}-${Math.floor(performance.now() * 1000)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj), 'utf8');
  return f;
}

test('normUsername: strips @, lowercases, empty → null', () => {
  assert.equal(normUsername('@Thi_Truong'), 'thi_truong');
  assert.equal(normUsername('lan'), 'lan');
  assert.equal(normUsername(''), null);
  assert.equal(normUsername(null), null);
});

// --- Rule 1: row already keyed by id → SKIP, never overwrite ---------------

test('upsertMember: id already present → unchanged (object preserved)', () => {
  const roles = { '144242180': { role: 'admin', title: 'anh', name: 'Thi' } };
  const r = upsertMember(roles, { id: 144242180, username: 'newhandle', first_name: 'X' });
  assert.equal(r.changed, false);
  assert.equal(r.roles, roles); // same ref, nothing rewritten
  assert.deepEqual(r.roles['144242180'], { role: 'admin', title: 'anh', name: 'Thi' });
});

test('upsertMember: id present even as string shorthand → unchanged', () => {
  const roles = { '999': 'dev' };
  const r = upsertMember(roles, { id: 999, username: 'someone' });
  assert.equal(r.changed, false);
  assert.equal(r.roles['999'], 'dev');
});

// --- Rule 2: pending username row → fill id only, keep other fields ---------

test('upsertMember: username-keyed pending row → rekey to id, fields kept', () => {
  const roles = { '@lan': { role: 'member', title: 'chị', name: 'Lan', position: 'designer' } };
  const r = upsertMember(roles, { id: 555, username: 'Lan', first_name: 'Ignored' });
  assert.equal(r.changed, true);
  assert.equal(r.roles['@lan'], undefined); // old username key removed
  assert.deepEqual(r.roles['555'], {
    role: 'member',
    title: 'chị',
    name: 'Lan', // NOT overwritten by Telegram first_name
    position: 'designer',
    username: 'lan', // anchored
  });
});

test('upsertMember: matched via .username field (id-less object), key arbitrary', () => {
  const roles = { pending1: { username: 'lan', title: 'chị', position: 'PM' } };
  const r = upsertMember(roles, { id: 777, username: '@LAN' });
  assert.equal(r.changed, true);
  assert.equal(r.roles.pending1, undefined);
  assert.deepEqual(r.roles['777'], { username: 'lan', title: 'chị', position: 'PM' });
});

test('upsertMember: pending row keeps existing username, does not clobber', () => {
  const roles = { '@lan': { username: 'lan_official', name: 'Lan' } };
  const r = upsertMember(roles, { id: 555, username: 'lan_official' });
  assert.equal(r.roles['555'].username, 'lan_official');
});

// --- Rule 3: brand-new → append skeleton, least-privilege ------------------

test('upsertMember: unknown member → skeleton with member role + empty PO fields', () => {
  const r = upsertMember({}, { id: 42, username: '@Newbie', first_name: 'New', last_name: 'Bie' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.roles['42'], {
    role: 'member',
    username: 'newbie',
    title: '',
    name: 'New Bie',
    position: '',
  });
});

test('upsertMember: unknown member without username → row still added, no username field', () => {
  const r = upsertMember({}, { id: 42, first_name: 'Anon' });
  assert.equal(r.changed, true);
  assert.equal('username' in r.roles['42'], false);
  assert.equal(r.roles['42'].name, 'Anon');
  assert.equal(r.roles['42'].role, 'member'); // never elevated
});

test('upsertMember: no id → unchanged (cannot anchor)', () => {
  const r = upsertMember({}, { username: 'ghost' });
  assert.equal(r.changed, false);
});

test('upsertMember: different username does NOT match an id-keyed row (no false rekey)', () => {
  const roles = { '111': { role: 'admin', username: 'boss' } };
  const r = upsertMember(roles, { id: 222, username: 'boss' });
  // id 222 unknown; the only `boss` row is id-keyed (111) so rule 2 must skip it
  assert.equal(r.changed, true);
  assert.ok(r.roles['222']); // appended as new, did not touch 111
  assert.deepEqual(r.roles['111'], { role: 'admin', username: 'boss' });
});

// --- harvestMembers persistence -------------------------------------------

test('harvestMembers: writes new rows into [code].roles atomically', () => {
  const f = tmpJson({ luni: { chatId: '-100', roles: { '1': 'admin' } } });
  const n = harvestMembers([{ id: 2, username: 'lan', first_name: 'Lan' }], { projectCode: 'luni', file: f });
  assert.equal(n, 1);
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(after.luni.roles['1'], 'admin'); // untouched
  assert.equal(after.luni.roles['2'].username, 'lan');
  fs.unlinkSync(f);
});

test('harvestMembers: de-dupes batch + skips bots & known ids → may write 0', () => {
  const f = tmpJson({ luni: { chatId: '-100', roles: { '1': 'admin' } } });
  const n = harvestMembers(
    [
      { id: 1, username: 'admin' }, // known → skip
      { id: 9, is_bot: true }, // bot → skip
      { id: 5, username: 'a' },
      { id: 5, username: 'a' }, // dup in batch → once
    ],
    { projectCode: 'luni', file: f },
  );
  assert.equal(n, 1);
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(after.luni.roles['5']);
  assert.equal(after.luni.roles['9'], undefined);
  fs.unlinkSync(f);
});

test('harvestMembers: no project entry → no write, returns 0', () => {
  const f = tmpJson({ other: { chatId: '-1', roles: {} } });
  const before = fs.readFileSync(f, 'utf8');
  const n = harvestMembers([{ id: 2, username: 'x' }], { projectCode: 'luni', file: f });
  assert.equal(n, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), before); // untouched
  fs.unlinkSync(f);
});

test('harvestMembers: nothing changed → file untouched (returns 0)', () => {
  const f = tmpJson({ luni: { chatId: '-100', roles: { '1': 'admin' } } });
  const before = fs.readFileSync(f, 'utf8');
  const n = harvestMembers([{ id: 1, username: 'admin' }], { projectCode: 'luni', file: f });
  assert.equal(n, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
  fs.unlinkSync(f);
});

test('harvestMembers: missing/corrupt file → 0, no throw', () => {
  assert.equal(harvestMembers([{ id: 1 }], { projectCode: 'luni', file: '/no/such/file.json' }), 0);
});
