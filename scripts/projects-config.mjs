// Per-project config (RFC 02): central `teleport/projects.json` maps a project
// code → its forum group + roles. Committed (not secret); the bot token stays
// in teleport/.env.
//
// Schema (`projects.json`):
//   {
//     "<code>": {
//       "chatId": "-1001234567890",        // dedicated forum group for this project
//       "roles":  { "<userId>": "admin" }   // advisory roles (enforcement agent-side)
//     },
//     ...
//   }
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

/**
 * Resolve `{ chatId, dedicated, roles }` for a project code.
 * - `dedicated: true`  → chatId came from projects.json (project's OWN group);
 *   topic titles omit the project suffix.
 * - `dedicated: false` → chatId is the shared catch-all (`fallbackChatId`, may be
 *   null); topic titles include `· <code>` to disambiguate projects in one group.
 * `roles` always comes from the json entry (may be {}).
 */
export function resolveProjectConfig(code, { config = {}, fallbackChatId = null } = {}) {
  const entry = (code && config[code]) || null; // truthy: '' code never matches a config[''] key
  const roles = (entry && entry.roles && typeof entry.roles === 'object') ? entry.roles : {};
  // Trim so a whitespace-only chatId ("   ") is treated as absent, not as a
  // bogus dedicated target that would bypass the empty-adminIds fail-fast.
  const dedicatedChatId = entry?.chatId == null ? '' : String(entry.chatId).trim();
  if (dedicatedChatId) {
    return { chatId: dedicatedChatId, dedicated: true, roles };
  }
  const fallback = fallbackChatId == null ? '' : String(fallbackChatId).trim();
  return { chatId: fallback || null, dedicated: false, roles };
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

/**
 * Look up a user's advisory role. Unmapped users default to `DEFAULT_ROLE`
 * ('member' — least privilege; cannot authorize sensitive actions). Returns
 * null only when there's no user id at all (e.g. a channel post with no sender).
 */
export const DEFAULT_ROLE = 'member';
export function roleFor(roles, userId) {
  if (userId == null) return null;
  return (roles && roles[String(userId)]) ?? DEFAULT_ROLE;
}
