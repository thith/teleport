// Passive roster harvest (RFC 02 follow-up): Telegram has NO API to list a
// group's full membership, but every incoming message carries `msg.from`
// ({ id, username, first_name, last_name }). So we learn members lazily — the
// first time someone speaks in the project group, we record their id/username
// into `teleport/projects.json` under `[code].roles`, leaving the descriptive
// fields (title / name / position) for the PO to fill by hand.
//
// Upsert rules (exactly as specified by the PO):
//   1. A row already keyed by this numeric id  → SKIP entirely. Never
//      overwrite/fill — the id-keyed row is the PO's source of truth.
//   2. A pending row matched by username (PO pre-created it keyed by @username,
//      no id yet) → fill in the id ONLY (rekey username-key → id-key). Other
//      fields stay exactly as the PO wrote them.
//   3. Neither id nor username matched → append a fresh skeleton row keyed by
//      id, seeded with whatever Telegram gave us, with empty title/position for
//      the PO and a least-privilege `role: member`.
//
// SECURITY: harvest NEVER elevates privilege. New rows default to `member`;
// existing rows' `role` is never touched. The sensitive-action gate keys on
// `role` alone (see projects-config.roleFor), so a harvested member can never
// gain admin/maintainer rights without the PO editing the file by hand.

import fs from 'node:fs';
import { DEFAULT_PROJECTS_FILE } from './projects-config.mjs';

const ID_KEY = /^\d+$/;

/** Normalize a Telegram username: strip a leading '@', lowercase (usernames are
 *  case-insensitive). Returns null for empty/missing. */
export function normUsername(u) {
  if (u == null) return null;
  const s = String(u).replace(/^@/, '').trim().toLowerCase();
  return s || null;
}

/**
 * The username a roles entry represents, or null. An object entry's explicit
 * `.username` field wins; otherwise a NON-numeric key is itself treated as the
 * username (PO keyed the pending row by @handle before knowing the id).
 */
function entryUsername(key, val) {
  if (val && typeof val === 'object' && val.username) return normUsername(val.username);
  if (!ID_KEY.test(key)) return normUsername(key);
  return null;
}

/**
 * Pure upsert of one Telegram `from` into a `roles` map. Returns
 * `{ roles, changed }`; `roles` is a NEW object when changed, the same
 * reference when not. See the three rules in the file header.
 */
export function upsertMember(roles, from) {
  const base = roles && typeof roles === 'object' ? roles : {};
  const id = from && from.id != null ? String(from.id) : null;
  if (!id) return { roles: base, changed: false }; // no id → nothing to anchor on

  // (1) Already known by id → never touch.
  if (Object.prototype.hasOwnProperty.call(base, id)) {
    return { roles: base, changed: false };
  }

  const uname = normUsername(from.username);

  // (2) Pending row matched by username → fill the id only (rekey), keep the
  //     PO's other fields verbatim.
  if (uname) {
    for (const key of Object.keys(base)) {
      if (ID_KEY.test(key)) continue; // an id-keyed row is a different person
      if (entryUsername(key, base[key]) === uname) {
        const val = base[key];
        const obj = typeof val === 'string' ? { role: val } : { ...val };
        if (!obj.username) obj.username = uname; // anchor the handle we matched on
        const next = { ...base };
        delete next[key];
        next[id] = obj;
        return { roles: next, changed: true };
      }
    }
  }

  // (3) Brand-new member → append skeleton for the PO to flesh out.
  const name = `${from.first_name || ''} ${from.last_name || ''}`.trim();
  const row = { role: 'member' };
  if (uname) row.username = uname;
  row.title = '';
  row.name = name || '';
  row.position = '';
  return { roles: { ...base, [id]: row }, changed: true };
}

/**
 * Best-effort: harvest a batch of `from` objects into projects.json under
 * `[projectCode].roles`. Only writes into an EXISTING project entry (a
 * dedicated group); a shared/absent entry is left untouched so we never create
 * a chatless project stub. Atomic write (tmp + rename). Returns the number of
 * rows changed. Swallows all I/O errors — harvest must never block the listener.
 */
export function harvestMembers(froms, { projectCode, file = DEFAULT_PROJECTS_FILE } = {}) {
  if (!projectCode || !Array.isArray(froms) || froms.length === 0) return 0;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
  if (!config || typeof config !== 'object') return 0;
  const entry = config[projectCode];
  if (!entry || typeof entry !== 'object') return 0; // only harvest into a real (dedicated) entry

  let roles = entry.roles && typeof entry.roles === 'object' ? entry.roles : {};
  let changed = 0;
  const seen = new Set();
  for (const from of froms) {
    if (!from || from.id == null || from.is_bot) continue; // skip bots & sender-less posts
    const id = String(from.id);
    if (seen.has(id)) continue; // de-dupe within the batch
    seen.add(id);
    const res = upsertMember(roles, from);
    if (res.changed) {
      roles = res.roles;
      changed++;
    }
  }
  if (!changed) return 0;

  entry.roles = roles;
  try {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    return 0;
  }
  return changed;
}
