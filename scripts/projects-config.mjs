// Per-project config (RFC 02): central `teleport/projects.json` maps a project
// code → its forum group + roles. Committed (not secret); the bot token stays
// in teleport/.env.
//
// Schema (`projects.json`):
//   {
//     "<code>": {
//       "chatId": "-1001234567890",        // dedicated forum group for this project
//       "description": "Backend của Luni",  // optional: what this project IS — surfaced
//                                            //   to the agent as prompt `projectDescription`
//       "roles":  {                         // advisory member profiles (enforcement agent-side)
//         "<userId>": "admin",              //   string shorthand: role only
//         "<userId>": {                     //   OR full profile object:
//           "role":     "admin",            //     admin|maintainer|dev|member (gate uses THIS only)
//           "username": "thi_truong",       //     Telegram @username (no @)
//           "title":    "anh",              //     xưng hô: anh|chị|em
//           "name":     "Thi",              //     tên thường gọi
//           "position": "founder / dev",    //     vai trò trong dự án (mô tả, KHÔNG phải quyền)
//           "note":     "hay vội, cần rõ"   //     optional free-form note about this member —
//                                            //       reaches the agent via `fromMember.note`
//         }
//       }
//     },
//     ...
//   }
// `title`/`name`/`position`/`username`/`note` (member) and `description`
// (project) are descriptive only — they never widen privilege. The
// sensitive-action gate keys on `role` exclusively.
//
// A row may be PRE-CREATED keyed by `@username` (or `username`) before the
// numeric id is known; the listener's passive harvest (roster-upsert.mjs)
// fills in the id (rekeying the row) the first time that member speaks. Rows
// the harvest appends on its own default to `role: member` (least privilege).
//
// Resolution:
// - chatId: projects.json[code].chatId (DEDICATED) → fallback chatId (the env
//   TELEGRAM_ADMIN_CHAT_ID, a SHARED catch-all) → null (caller fail-fasts).
// - roles:  projects.json[code].roles ONLY (no env). Empty {} when absent.
// Leaf module: only node:fs/path, so any script can import it freely.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECTS_FILE = path.join(__dirname, '..', 'projects.json');

/** Read + parse projects.json. Missing/corrupt → {} (caller falls back to env). */
export function readProjectsConfig(file = DEFAULT_PROJECTS_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Two reserved top-level keys in projects.json (underscore-prefixed so they are
// never mistaken for a project entry). Config lives here; .env holds secrets only.
//   `_default` — the catch-all GROUP, shaped like a project: `{ chatId, roles }`.
//                Projects without their own group fall back to it (chat + roster).
//   `_config`  — pure global CONFIG (not a group): `{ daemonChatId, quietHours }`.
export const GLOBAL_CONFIG_KEY = '_config';
export const DEFAULT_GROUP_KEY = '_default';

// The `_config` block, or {}. `{ daemonChatId?, quietHours?, ... }`.
export function readGlobalConfig(config = {}) {
  const g = config && config[GLOBAL_CONFIG_KEY];
  return (g && typeof g === 'object') ? g : {};
}
// The `_default` catch-all group block, or {}. `{ chatId?, roles? }`.
export function readDefaultGroup(config = {}) {
  const d = config && config[DEFAULT_GROUP_KEY];
  return (d && typeof d === 'object') ? d : {};
}

// Project entries only — skips `_config`, `_default`, and any other reserved
// underscore-prefixed key. Use this everywhere code iterates "all projects".
export function projectEntries(config = {}) {
  return Object.entries(config || {}).filter(([k]) => !k.startsWith('_'));
}

let _warnedDefaultEnv = false;
let _warnedDaemonEnv = false;
// Catch-all default GROUP chat id: projects.json `_default.chatId` is the source
// of truth; falls back to the DEPRECATED env `TELEGRAM_ADMIN_CHAT_ID` (warned
// once) so existing .env setups keep working during migration.
export function resolveDefaultChatId(config, { env = process.env, envFile = {} } = {}) {
  const fromJson = readDefaultGroup(config).chatId;
  if (fromJson != null && String(fromJson).trim() !== '') return String(fromJson).trim();
  const fromEnv = env.TELEGRAM_ADMIN_CHAT_ID || envFile.TELEGRAM_ADMIN_CHAT_ID;
  if (fromEnv) {
    if (!_warnedDefaultEnv) { _warnedDefaultEnv = true; console.error('[config] DEPRECATED: TELEGRAM_ADMIN_CHAT_ID in .env — move it to projects.json `_default.chatId`.'); }
    return String(fromEnv).trim();
  }
  return null;
}

// Daemon control-DM chat id: projects.json `_config.daemonChatId`, falling back
// to the DEPRECATED env `DAEMON_CHAT_ID`.
export function resolveDaemonChatId(config, { env = process.env, envFile = {} } = {}) {
  const fromJson = readGlobalConfig(config).daemonChatId;
  if (fromJson != null && String(fromJson).trim() !== '') return String(fromJson).trim();
  const fromEnv = env.DAEMON_CHAT_ID || envFile.DAEMON_CHAT_ID;
  if (fromEnv) {
    if (!_warnedDaemonEnv) { _warnedDaemonEnv = true; console.error('[config] DEPRECATED: DAEMON_CHAT_ID in .env — move it to projects.json `_config.daemonChatId`.'); }
    return String(fromEnv).trim();
  }
  return null;
}

// Quiet-hours window for auto-reminders: projects.json `_config.quietHours`
// `{ start, end }` (0–23), falling back to the DEPRECATED env QUIET_HOURS_*.
// Returns `{ start, end }` with null when unset/invalid (caller treats as 24/7).
export function resolveQuietHours(config, { env = process.env, envFile = {} } = {}) {
  const parseHr = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  };
  const qh = readGlobalConfig(config).quietHours;
  // Only treat `_config.quietHours` as set when it actually has a bound — an
  // empty `{}` must fall through to the env fallback, not silently disable it.
  if (qh && typeof qh === 'object' && (qh.start != null || qh.end != null)) {
    return { start: parseHr(qh.start), end: parseHr(qh.end) };
  }
  return { start: parseHr(env.QUIET_HOURS_START ?? envFile.QUIET_HOURS_START), end: parseHr(env.QUIET_HOURS_END ?? envFile.QUIET_HOURS_END) };
}

/**
 * Resolve `{ chatId, dedicated, roles, code, topicIcon, description }` for a project.
 * `lookupKey` is the projects.json key (= `basename(cwd)`); it is NOT shown to
 * users and is also the roster-harvest target — keep it folder-stable.
 * - `dedicated: true`  → chatId came from projects.json (project's OWN group);
 *   no `[<code>]` message prefix and a persona-only topic title ("Heo 🐷") —
 *   projects sharing the group are told apart by their per-project `topicIcon`.
 * - `dedicated: false` → chatId is the shared catch-all (`fallbackChatId`, may be
 *   null); each message carries a `[<code>]` prefix AND the topic title is
 *   code-first ("md · 🐉 Rồng") so the catch-all group is scannable by project.
 * - `roles` → a DEDICATED project's own entry roles; a SHARED project inherits
 *   the catch-all group's roster from `_default.roles` (all shared projects live
 *   in the same group, so they share its members).
 * - `code`  → the DISPLAY/canonical project code: entry.code (a short alias, e.g.
 *   "d_be") when set, else `lookupKey`. Lets a repo folder ("digesty-worker")
 *   carry a short code without the old `TELE_PROJECT_CODE` env var. Used only for
 *   display (topic title prefix / message prefix), never for lookup/roster.
 * - `topicIcon` → optional `{ emoji?, color? }` forum-topic icon (or null);
 *   passed through to createForumTopic. Absent → Telegram's default icon.
 * - `description` → optional human description of what the project IS (string),
 *   or null. Descriptive only (never affects routing/privilege); the listener
 *   forwards it to the agent as the prompt's `projectDescription` so a fresh
 *   agent has project context. A SHARED project (no own entry) has none.
 */
export function resolveProjectConfig(lookupKey, { config = {}, fallbackChatId = null } = {}) {
  // Never resolve a reserved `_`-key (`_default`/`_config`) as a project — a repo
  // folder named `_default` must NOT hijack the catch-all/global config.
  const entry = (lookupKey && !String(lookupKey).startsWith('_') && config[lookupKey]) || null;
  const entryRoles = (entry && entry.roles && typeof entry.roles === 'object') ? entry.roles : {};
  const code = (entry && typeof entry.code === 'string' && entry.code.trim()) ? entry.code.trim() : lookupKey;
  const topicIcon = (entry && entry.topicIcon && typeof entry.topicIcon === 'object' && !Array.isArray(entry.topicIcon)) ? entry.topicIcon : null;
  // Trim so a whitespace-only description is treated as absent (null), not an
  // empty string the agent would see as a meaningless blank field.
  const description = (entry && typeof entry.description === 'string' && entry.description.trim()) ? entry.description.trim() : null;
  // Trim so a whitespace-only chatId ("   ") is treated as absent, not as a
  // bogus dedicated target that would bypass the empty-adminIds fail-fast.
  const dedicatedChatId = entry?.chatId == null ? '' : String(entry.chatId).trim();
  if (dedicatedChatId) {
    return { chatId: dedicatedChatId, dedicated: true, roles: entryRoles, code, topicIcon, description };
  }
  // Shared → inherit the catch-all group's roster (`_default.roles`) ONLY. A
  // shared project's OWN `roles` block is dead config and must NEVER grant
  // privilege (it would contradict resolveSenderRole's dedicated-only scan), so
  // when `_default.roles` is absent/malformed we fall to `{}`, not `entryRoles`.
  const defaultRoles = readDefaultGroup(config).roles;
  const roles = (defaultRoles && typeof defaultRoles === 'object') ? defaultRoles : {};
  const fallback = fallbackChatId == null ? '' : String(fallbackChatId).trim();
  // `description` carries through if the entry set one (harmless descriptive
  // context); a truly unmapped shared project has no entry → null.
  return { chatId: fallback || null, dedicated: false, roles, code, topicIcon, description };
}

/**
 * The single rule for turning a resolved project config into the admin chat-id
 * list: a DEDICATED project targets exactly its one group; a SHARED project
 * uses the (possibly multi-id) catch-all. Centralized so the send path, listen
 * path, and supervisor fail-fast can never disagree (review S2-Minor).
 * `parseAdminChatIds` is injected to keep this module dependency-free.
 */
export function adminIdsFrom(projCfg, fallbackChatId, parseAdminChatIds) {
  return projCfg.dedicated ? [projCfg.chatId] : parseAdminChatIds(fallbackChatId);
}

// Telegram chat-id sign convention: groups/supergroups/channels are NEGATIVE
// (e.g. -100…); a private chat (DM) id is the user's POSITIVE id. Teleport's
// agent↔topic model lives in GROUPS; the supervisor daemon's control channel is
// a PRIVATE DM. These helpers let callers enforce that split (a project or
// catch-all chat MUST be a group; DAEMON_CHAT_ID MUST be private).
export function isGroupChatId(id) {
  const s = String(id ?? '').trim();
  return /^-\d+$/.test(s);
}
export function isPrivateChatId(id) {
  const s = String(id ?? '').trim();
  return /^\d+$/.test(s); // positive integer, no leading '-'
}
/**
 * Assert a chat id is of the expected kind ('group' | 'private'); throws a clear
 * Error otherwise. `label` names the source (e.g. "DAEMON_CHAT_ID", "project
 * 'd_be' chatId") so misconfiguration is caught early with a useful message.
 */
export function assertChatIdKind(id, kind, label) {
  const ok = kind === 'group' ? isGroupChatId(id) : isPrivateChatId(id);
  if (!ok) {
    const got = isGroupChatId(id) ? 'a group id (negative)' : isPrivateChatId(id) ? 'a private id (positive)' : `invalid (${JSON.stringify(id)})`;
    throw new Error(`${label} must be ${kind === 'group' ? 'a GROUP chat id (negative, e.g. -100…)' : 'a PRIVATE chat id (positive user id)'} but got ${got}`);
  }
}

/**
 * Look up a user's advisory role. Unmapped users default to `DEFAULT_ROLE`
 * ('member' — least privilege; cannot authorize sensitive actions). Returns
 * null only when there's no user id at all (e.g. a channel post with no sender).
 * Accepts both the string shorthand (`"admin"`) and the full profile object
 * (`{ role, username, ... }`); only `.role` drives privilege.
 */
export const DEFAULT_ROLE = 'member';
// `ownProp` reads a key only if it's the object's OWN property — so a roles map
// can never grant privilege via an inherited prototype member (e.g. a user id
// that collides with `toString`/`constructor`). Defense-in-depth: Telegram ids
// are numeric so this can't trigger today, but the role gate must not depend on
// that staying true.
function ownProp(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
export function roleFor(roles, userId) {
  if (userId == null) return null;
  const v = ownProp(roles, String(userId));
  if (v == null) return DEFAULT_ROLE;
  if (typeof v === 'string') return v;
  return v.role ?? DEFAULT_ROLE;
}

/**
 * Look up a user's full member profile object. Returns null when the user is
 * unmapped OR mapped via the string shorthand (no descriptive fields to expose).
 * The whole object is returned verbatim, so any descriptive field set on it —
 * `title`/`name`/`position`/`username` and the free-form `note` — reaches the
 * agent as-is via `fromMember`. Descriptive only: none widen privilege; the
 * sensitive-action gate keys on `roleFor()` alone.
 */
export function memberFor(roles, userId) {
  if (userId == null) return null;
  const v = ownProp(roles, String(userId));
  if (v == null || typeof v === 'string') return null;
  return v;
}
