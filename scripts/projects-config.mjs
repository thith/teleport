// Per-project config (RFC 02): central `teleport/projects.json` maps a project
// code → its forum group + roles. Committed (not secret); the bot token stays
// in teleport/.env.
//
// Schema (`projects.json`):
//   {
//     "<code>": {
//       "chatId": "-1001234567890",        // dedicated forum group for this project
//       "description": "Backend của app",  // optional: what this project IS — surfaced
//                                            //   to the agent as prompt `projectDescription`
//       "roles":  {                         // advisory member profiles (enforcement agent-side)
//         "<userId>": "admin",              //   string shorthand: role only
//         "<userId>": {                     //   OR full profile object:
//           "role":     "admin",            //     admin|maintainer|dev|member (gate uses THIS only)
//           "username": "alice_nguyen",     //     Telegram @username (no @)
//           "title":    "anh",              //     xưng hô: anh|chị|em
//           "name":     "Alice",            //     tên thường gọi
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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lookupAllocationByConvo } from './convo-registry.mjs';

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
//   `_config`  — pure global CONFIG (not a group): `{ daemonUserId, quietHours, sendOnly }`.
export const GLOBAL_CONFIG_KEY = '_config';
export const DEFAULT_GROUP_KEY = '_default';

// The `_config` block, or {}. `{ daemonUserId?, quietHours?, ... }`.
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

// Daemon owner USER id: projects.json `_config.daemonUserId` — the single user
// authorized to drive the supervisor daemon, whether by private DM or by
// `/dm <cmd>` typed in a group topic (RFC 08). Falls back to the older
// `_config.daemonChatId` and the DEPRECATED env `DAEMON_CHAT_ID`: in a private DM
// the chat id IS the user id, so the legacy value migrates verbatim.
export function resolveDaemonUserId(config, { env = process.env, envFile = {} } = {}) {
  const cfg = readGlobalConfig(config);
  const fromJson = cfg.daemonUserId ?? cfg.daemonChatId;
  if (fromJson != null && String(fromJson).trim() !== '') return String(fromJson).trim();
  const fromEnv = env.DAEMON_CHAT_ID || envFile.DAEMON_CHAT_ID;
  if (fromEnv) {
    if (!_warnedDaemonEnv) { _warnedDaemonEnv = true; console.error('[config] DEPRECATED: DAEMON_CHAT_ID in .env — move it to projects.json `_config.daemonUserId`.'); }
    return String(fromEnv).trim();
  }
  return null;
}

// Deprecated alias (pre-RFC-08 name). The daemon's control-DM chat id and the
// owner user id are identical in a private DM, so this returns the same value.
export function resolveDaemonChatId(config, opts) {
  return resolveDaemonUserId(config, opts);
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

// Send-only machine: projects.json `_config.sendOnly: true`, overridable per
// process by env TELE_SEND_ONLY (1/true/yes/on vs 0/false/no/off). Such a machine
// may send, DM and generate media, but must NEVER poll getUpdates: Telegram
// keeps one update queue per bot, so a second consumer (listener/daemon) on
// another machine silently acks — and steals — the owning machine's messages.
// An unrecognised env value warns and falls through to the JSON flag. A present
// but non-boolean `_config.sendOnly` (e.g. "true", 1) fails CLOSED (send-only)
// with a warning: wrongly listening steals another machine's replies, wrongly
// not listening is visible and harmless. `.env` is NOT consulted (secrets only).
const TRUTHY = /^(1|true|yes|on)$/i;
const FALSY = /^(0|false|no|off)$/i;
export function resolveSendOnly(config, { env = process.env, warn = (m) => console.error(m) } = {}) {
  const raw = String(env.TELE_SEND_ONLY ?? '').trim();
  if (TRUTHY.test(raw)) return true;
  if (FALSY.test(raw)) return false;
  if (raw !== '') warn(`[config] TELE_SEND_ONLY="${raw}" not recognised (use 1/0) — ignored.`);
  const v = readGlobalConfig(config).sendOnly;
  if (v === undefined || v === false) return false;
  if (v !== true) warn(`[config] projects.json _config.sendOnly should be true/false, got ${JSON.stringify(v)} — treating as send-only.`);
  return true;
}

// One stderr line for a listener/daemon refused on a send-only machine. Says
// what to do instead so an agent following "always start a listener" stops
// there rather than retrying.
export const SEND_ONLY_LISTEN_REFUSAL =
  'send-only machine (projects.json `_config.sendOnly` / TELE_SEND_ONLY): this machine does not poll Telegram — '
  + 'another machine owns this bot\'s updates. Do NOT start or re-arm a listener/daemon here; sending, --dm and media still work. '
  + 'Delivery from here is one-way: replies will not reach a session on this machine.';

/**
 * Map a repo folder (`basename(cwd)`) to a projects.json project key. Exact keys
 * win; otherwise a git-worktree folder like `acme-frontend-uifix` (absent from
 * projects.json) resolves to the LONGEST existing key K where `folder === K` or
 * `folder.startsWith(K + '-')` — so `acme-frontend-uifix` → `acme-frontend`
 * (not the shorter `acme`), and a bare substring like `acm` never matches
 * `acme` (the boundary is a literal `-`, or exact). Reserved `_`-keys are
 * skipped. No prefix match → returns `folder` unchanged (default fallback stands).
 */
export function resolveProjectKey(folder, config = {}) {
  const f = String(folder || '');
  if (!f) return f;
  // Exact key (non-reserved) — keep as-is; also short-circuits the prefix scan.
  if (!f.startsWith('_') && config && Object.prototype.hasOwnProperty.call(config, f)) return f;
  let best = null;
  for (const [k] of projectEntries(config)) {
    if (f === k || f.startsWith(k + '-')) {
      if (best == null || k.length > best.length) best = k;
    }
  }
  return best ?? f;
}

/**
 * Parse `git worktree list --porcelain` output; return the path of the FIRST
 * worktree block that is NOT marked `bare` (a bare-origin setup lists the bare
 * repo first — it has no usable checkout). Returns null when none. Pure.
 */
export function firstNonBareWorktree(porcelain) {
  const blocks = String(porcelain || '').split('\n\n');
  for (const block of blocks) {
    let wt = null;
    let bare = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt = line.slice('worktree '.length).trim();
      else if (line.trim() === 'bare') bare = true;
    }
    if (wt && !bare) return wt;
  }
  return null;
}

/**
 * Resolve the MAIN worktree directory (absolute, symlink-canonical) of `cwd`,
 * independent of folder naming — so a git worktree or a deep subdir both map
 * back to the project's real checkout root (RFC 15 §5.2). Returns null when: not
 * git, inside a submodule, git hangs/errors, or the layout can't be resolved
 * cleanly — the caller then falls to `_default`. MUST never throw / never block
 * (bounded, SIGKILL-capped per-call — reuses readGitContext's hardened pattern).
 * Order is mandatory: submodule-check FIRST, then worktree-list (reject bare),
 * then git-common-dir fallback.
 */
export function gitMainWorktreeDir(cwd = process.cwd(), { execFn = execFileSync } = {}) {
  const run = (args) =>
    execFn('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000, // generous: a timeout at a convo's first send decides its group
      killSignal: 'SIGKILL',
      maxBuffer: 1 << 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  const MODULES = `${path.sep}.git${path.sep}modules${path.sep}`;
  try {
    // 1. Submodule FIRST: inside a submodule → give up (route via _default). Must
    // precede worktree-list, which could otherwise return a submodule path.
    let superproject = '';
    try { superproject = run(['rev-parse', '--show-superproject-working-tree']); } catch { /* not a submodule */ }
    if (superproject) return null;
    // 2. Main worktree = first NON-bare row of `git worktree list --porcelain`.
    try {
      const mainPath = firstNonBareWorktree(run(['worktree', 'list', '--porcelain']));
      if (mainPath) {
        try { return fs.realpathSync(mainPath); } catch { return mainPath; }
      }
    } catch { /* fall through to common-dir */ }
    // 3. Fallback: git-common-dir → dirname of the main `.git`.
    let commonDir = run(['rev-parse', '--git-common-dir']);
    if (!commonDir) return null;
    if (!path.isAbsolute(commonDir)) commonDir = path.resolve(cwd, commonDir);
    let real;
    try { real = fs.realpathSync(commonDir); } catch { real = commonDir; }
    if (real.includes(MODULES) || real.endsWith(`${path.sep}.git${path.sep}modules`)) return null;
    if (path.basename(real) === '.git') return path.dirname(real);
    return null;
  } catch {
    return null;
  }
}

/**
 * True when `cwd` or any ancestor holds a `.git` entry (repo dir or worktree
 * file). Pure filesystem — unlike a git subprocess it cannot hang — so a false
 * result means we are genuinely outside any repo.
 */
export function hasGitAncestor(cwd = process.cwd(), { existsFn = fs.existsSync } = {}) {
  // Physical path: a symlinked cwd pointing INTO a repo must still see its .git.
  let dir;
  try { dir = fs.realpathSync(cwd); } catch { dir = path.resolve(cwd); }
  for (;;) {
    if (existsFn(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** True when `k` is a real, non-reserved project key present in `config`. */
function projectKeyExists(k, config) {
  return !!k && !String(k).startsWith('_')
    && Object.prototype.hasOwnProperty.call(config, k);
}

/**
 * PURE routing resolver (RFC 15). Decide which projects.json lookupKey a send/
 * listen should use, given cwd + convo identity + snapshots. All I/O is done by
 * the caller and injected: `registryRows` (from readRows), `projectsConfig`,
 * `gitRootFn` (defaults to gitMainWorktreeDir but injectable for tests).
 *
 * Tier order: 1 convo anchor → 0 override (env/flag, cold-start only) →
 * 2 cold-start git → 3a non-git registered basename(cwd) → 3 `_default`. Anchor is checked BEFORE override so an
 * (often inherited) TELE_LOOKUP_KEY can't move an already-anchored convo; git
 * failure/hang INSIDE a repo falls to `_default` (no cwd-basename fallback). Returns
 * `{ lookupKey, chatIdHint, resolvedBy }`:
 *  - `lookupKey` → a real key (caller: resolveProjectConfig) or null.
 *  - `chatIdHint` → set ONLY for legacy anchor rows (no projectKey): the group
 *    is authoritative but the project key is unknown; caller keeps this chatId
 *    and derives metadata best-effort (least-privilege).
 *  - `resolvedBy` → 'anchor'|'anchor-default'|'anchor-legacy'|'override'|'git'|'cwd'|'default'|'default-unresolved' (diagnostic).
 */
export function resolveLookupKey({
  cwd = process.cwd(),
  convoId = null,
  botId = null,
  env = process.env,
  registryRows = [],
  projectsConfig = {},
  gitRootFn = gitMainWorktreeDir,
  gitTreeFn = hasGitAncestor,
  allocLookup = lookupAllocationByConvo,
} = {}) {
  // Tier 1 — convo anchor (durable) — checked FIRST, before override. Once a
  // convo has a topic in group X it's IMMUTABLE (topic key = chatId+convoId), so
  // even an explicit override cannot MOVE it — honoring an (often inherited)
  // TELE_LOOKUP_KEY over a live anchor would SPLIT the convo (the very bug). So
  // override only SELECTS a project at cold-start (no anchor yet), never reroutes
  // an anchored one. (Refines RFC R1 per implementation-review — Codex Major.)
  if (convoId != null && botId != null) {
    const alloc = allocLookup(registryRows, convoId, botId);
    if (alloc) {
      // A stored projectKey wins as-is — registered OR not — and is resolved
      // against the CURRENT config: the convo keeps its PROJECT, while the group
      // follows config (editing that project's chatId, or registering a key that
      // was unregistered, moves the convo to the new group / a new topic).
      if (alloc.projectKey) {
        return { lookupKey: alloc.projectKey, chatIdHint: alloc.chatId ?? null, resolvedBy: 'anchor' };
      }
      // An RFC-15 row (carries resolvedBy) without projectKey was routed to the
      // shared catch-all at cold start → keep it on the CURRENT `_default` (same
      // group + roles as before; follows a `_default.chatId` change like project
      // anchors follow theirs). Not legacy: legacy would pin the old chat and
      // strip every role.
      // ('default-unresolved' = git failed at that send → not an anchor; fall
      // through and re-run cold-start.)
      if (alloc.resolvedBy && alloc.resolvedBy !== 'default-unresolved') return { lookupKey: null, chatIdHint: null, resolvedBy: 'anchor-default' };
      if (alloc.resolvedBy !== 'default-unresolved') {
        // LEGACY row (pre-RFC — no projectKey field at all): group authoritative
        // via chatId, project metadata recovered best-effort by the caller.
        return { lookupKey: null, chatIdHint: alloc.chatId ?? null, resolvedBy: 'anchor-legacy' };
      }
    }
  }
  // Tier 0 — explicit override (env TELE_LOOKUP_KEY / --project) at COLD-START.
  // Only a real key; only when there's no anchor (handled above).
  const override = ((env && env.TELE_LOOKUP_KEY) || '').trim();
  if (override && projectKeyExists(override, projectsConfig)) {
    return { lookupKey: override, chatIdHint: null, resolvedBy: 'override' };
  }
  // Tier 2 — cold-start. Git FIRST (worktree + subdir safe); no cwd fast-path
  // (a subdir basename colliding with another key must not hijack). The basename
  // is used as lookupKey whether or not it's registered — an unregistered one
  // still routes to _default via resolveProjectConfig while keeping its label;
  // resolvedBy distinguishes a real key ('git') from a fall-through ('default').
  let gitRoot = null;
  try { gitRoot = gitRootFn ? gitRootFn(cwd) : null; } catch { gitRoot = null; }
  if (gitRoot) {
    const key = resolveProjectKey(path.basename(gitRoot), projectsConfig);
    return { lookupKey: key, chatIdHint: null, resolvedBy: projectKeyExists(key, projectsConfig) ? 'git' : 'default' };
  }
  // Tier 3a — genuinely outside any repo (no `.git` up the tree, checked on the
  // filesystem so a HUNG git can never land here): route by a REGISTERED
  // basename(cwd), as before RFC 15, so non-git project folders keep their own
  // group. The subdir-collision hijack only exists inside a repo, which this
  // excludes. (Upgrade-compat: without it non-git projects silently moved to
  // `_default`.)
  let inGitTree = true;
  try { inGitTree = gitTreeFn ? gitTreeFn(cwd) : true; } catch { inGitTree = true; }
  if (!inGitTree) {
    let real;
    try { real = fs.realpathSync(cwd); } catch { real = path.resolve(cwd); }
    const key = resolveProjectKey(path.basename(real), projectsConfig);
    // Registered → its group. Unregistered → still the key (like Tier 2): it
    // routes to `_default` but keeps its `[code]` label, and the anchor stores
    // it, so registering the folder later moves the convo.
    return { lookupKey: key, chatIdHint: null, resolvedBy: projectKeyExists(key, projectsConfig) ? 'cwd' : 'default' };
  }
  // Tier 3 — inside a repo but git unavailable (hung / submodule / unresolvable)
  // → `_default`. No basename fallback inside a repo: it would re-introduce the
  // subdir-collision hijack (Codex Major). Marked 'default-unresolved' so the
  // anchor does NOT pin it: the next send re-tries git (a one-off git hiccup
  // must not exile the session to the catch-all forever).
  return { lookupKey: null, chatIdHint: null, resolvedBy: 'default-unresolved' };
}

/**
 * Turn a resolveLookupKey() result into the concrete `{ lookupKey, projCfg,
 * resolvedBy }` a send/listen path needs — the SINGLE shared entry point so
 * sender and listener can never disagree (RFC 15 G4). Handles the legacy-anchor
 * chatIdHint branch: group authoritative, metadata best-effort, roles
 * least-privilege ({}) when the project key can't be uniquely recovered.
 */
export function resolveProjectRouting(opts = {}) {
  const { projectsConfig = {}, fallbackChatId = null } = opts;
  const r = resolveLookupKey(opts);
  if (r.lookupKey) {
    const projCfg = resolveProjectConfig(r.lookupKey, { config: projectsConfig, fallbackChatId });
    return { lookupKey: r.lookupKey, projCfg, resolvedBy: r.resolvedBy };
  }
  // Legacy anchor: keep the row's chatId as group; recover metadata best-effort.
  if (r.chatIdHint != null && String(r.chatIdHint).trim() !== '') {
    const hint = String(r.chatIdHint).trim();
    // The shared catch-all group (`_default.chatId` == fallbackChatId): resolve
    // via the NORMAL shared path so `_default.roles` are recovered. Without this,
    // a legacy convo in the catch-all (e.g. an unregistered project like the
    // `teleport` repo itself) would lose its admins → everyone downgraded to
    // member (least-privilege was too aggressive for the catch-all case).
    // `_default.chatId` may list several groups ("A,B") — membership, not equality.
    const fbIds = fallbackChatId == null ? [] : String(fallbackChatId).split(',').map((x) => x.trim()).filter(Boolean);
    if (fbIds.includes(hint)) {
      const projCfg = withCatchAllLabel(resolveProjectConfig('', { config: projectsConfig, fallbackChatId }), opts.cwd);
      return { lookupKey: null, projCfg, resolvedBy: r.resolvedBy };
    }
    const matches = projectEntries(projectsConfig).filter(
      ([, v]) => v && String(v.chatId ?? '').trim() === hint,
    );
    if (matches.length === 1) {
      // Uniquely recoverable → full projCfg (safe: one dedicated project owns it).
      const projCfg = resolveProjectConfig(matches[0][0], { config: projectsConfig, fallbackChatId });
      return { lookupKey: matches[0][0], projCfg, resolvedBy: r.resolvedBy };
    }
    // 0 projects own this chatId any more (the project's chatId was changed or
    // the project removed): don't pin a group the config no longer knows —
    // resolve as a cold start from the current config (pre-upgrade behaviour:
    // routing followed config on every send).
    if (matches.length === 0) {
      return resolveProjectRouting({ ...opts, convoId: null });
    }
    // >1 projects share this chatId → group only, least-privilege roles.
    return {
      lookupKey: null,
      projCfg: { chatId: hint, dedicated: isGroupChatId(hint), roles: {}, code: '', topicIcon: null, description: null },
      resolvedBy: r.resolvedBy,
    };
  }
  // Tier 3 default: no lookupKey, no hint → the shared catch-all.
  const projCfg = withCatchAllLabel(resolveProjectConfig('', { config: projectsConfig, fallbackChatId }), opts.cwd);
  return { lookupKey: null, projCfg, resolvedBy: r.resolvedBy };
}

// In the SHARED catch-all every message needs its `[project]` prefix so agents
// can tell whose message is whose (the guide relies on it). When routing has no
// project key, label by the folder name — display only, never used to route.
function withCatchAllLabel(projCfg, cwd = process.cwd()) {
  if (projCfg.dedicated || projCfg.code) return projCfg;
  let real;
  try { real = fs.realpathSync(cwd); } catch { real = path.resolve(cwd || '.'); }
  return { ...projCfg, code: path.basename(real) };
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
 *   "d_be") when set, else `lookupKey`. Lets a repo folder ("acme-worker")
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
