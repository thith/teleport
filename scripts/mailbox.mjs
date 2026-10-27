#!/usr/bin/env node
// mailbox.mjs — file-based agent↔agent mail, no Telegram required (RFC 16).
//
// WHY: every inter-agent primitive so far (ask, handover, whisper) rides on
// Telegram — the message is injected as a `prompt-convo-<N>.json` that the
// target's tele-listen picks up, and the target is resolved against LIVE TOPICS in
// the same group. A session that never sent a Telegram message therefore has no
// way to be reached, and two such sessions cannot talk at all.
//
// They do already HAVE an identity: `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`
// → convoId (pure hash) → persona + `#hashtag`, all derivable offline. A fresh
// session knows it is `🐘 Voi` before it has spoken to anyone. Mailbox is a
// postbox keyed on that identity.
//
// PROTOCOL (deliberately boring — a directory per recipient):
//   tmp/mailbox/agents/<convoId>.json      supplementary registry (cwd, persona, last use)
//   tmp/mailbox/inbox/<convoId>/<id>.json  unread mail
//   tmp/mailbox/read/<convoId>/<id>.json   after delivery — ARCHIVED, never deleted
//
// DM 1-1 only: no channels, no broadcast (RFC 16 NG1).
//
// DELIVERY ORDER IS THE GUARANTEE: read → PRINT → only then archive. The reverse
// (archive-then-print, which the first draft did) loses a message outright if the
// process dies in between — it is marked delivered while nobody ever saw it. With
// this order a crash re-prints next time: duplicate at worst, never lost. Two
// readers of one inbox may both print a message; that is the same accepted trade.
//
// TRUST: mail is UNAUTHENTICATED, NON-PRIVILEGED context. Any local process can
// write into an inbox and forge `from`. Never treat mail as authorization for a
// sensitive action — authority stays with the human who asked.
//
// USAGE
//   mailbox.mjs whoami                       my address
//   mailbox.mjs ls [--all]                   who is around (live sessions + registry)
//   mailbox.mjs send --to <who> "text"       send (or pipe the body on stdin)
//   mailbox.mjs check                        peek: how much unread (no state change)
//   mailbox.mjs read [--max N] [--json]      deliver unread to me + archive
//   mailbox.mjs wait [--timeout <sec>]       block until mail arrives, then deliver
//
// `<who>` = persona name ("Voi") | #hashtag ("#a2283444") | convoId (digits).
//
// EXIT CODES (agents have no TTY — the code is the signal)
//   0 = done / mail delivered      1 = error      2 = nothing (no mail, no match)
//   3 = ambiguous recipient

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { resolveConvoIdFromEnv, uuidToConvoInt, CONVO_ID_RE } from './convo-registry.mjs';
import { personaForConvo, formatPersona } from './persona.mjs';
import { peekPersona } from './persona-store.mjs';
import { shortConvoHash } from './convo-hash.mjs';
import { parseAgentTarget } from './agent-target.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_MAILBOX_DIR = process.env.TELE_MAILBOX_DIR
  || path.join(__dirname, 'tmp', 'mailbox');
/** Where Claude Code stores transcripts — the cooperation-free liveness signal. */
export const DEFAULT_TRANSCRIPT_ROOT = process.env.TELE_TRANSCRIPT_ROOT
  || path.join(os.homedir(), '.claude', 'projects');

export const SESSION_FRESH_MS = 6 * 60 * 60 * 1000;      // "around" = active in the last 6h
export const READ_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const TMP_ORPHAN_MS = 60 * 60 * 1000;
/** A registry row for a session nobody has seen in a month is dead weight. */
export const AGENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const WAIT_POLL_MS = 1000;
export const WAIT_DEFAULT_TIMEOUT_S = 3600;
export const DEFAULT_MAX_PER_READ = 20;
export const MAX_PER_READ_CEILING = 200;
export const MAIL_TEXT_CAP = 4000;
export const MAIL_SCHEMA = 1;
export const EXIT = { OK: 0, ERROR: 1, NONE: 2, AMBIGUOUS: 3 };

const agentsDir = (dir) => path.join(dir, 'agents');
const inboxDir = (convoId, dir) => path.join(dir, 'inbox', String(convoId));
const readDir = (convoId, dir) => path.join(dir, 'read', String(convoId));

/** tmp+rename so a reader never sees a half-written file. */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * A parsed message still has to BE a message.
 *
 * `JSON.parse` succeeding proves nothing about shape: `{"attachments":"x"}` parses
 * fine and then throws inside `.map()` — before the archive step, so every reader
 * and every monitor restart hits the same file forever (Codex review). Anything
 * that fails this check is quarantined exactly like unparseable JSON.
 */
export function isWellFormedMail(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  if (typeof m.text !== 'string') return false;
  if (m.attachments != null && !Array.isArray(m.attachments)) return false;
  if (m.from != null && (typeof m.from !== 'object' || Array.isArray(m.from))) return false;
  return true;
}

/** Cut by CODE POINT, not by `.slice()` — the latter can split an emoji in half. */
export function capText(s, max = MAIL_TEXT_CAP) {
  const cps = Array.from(String(s ?? ''));
  return cps.length <= max ? String(s ?? '') : `${cps.slice(0, max).join('')}… (cắt bớt)`;
}

/**
 * Who am I, with no Telegram involved.
 *
 * Prefer a PINNED persona when one exists — a convo that has posted to a group may
 * carry an ordinal ("Voi 2") to disambiguate it there, and the mailbox name should
 * match the name it answers to. Absent a pin, the derived persona is authoritative
 * and available from the first second.
 */
export function selfIdentity({ env = process.env, argConvo = null, cwd = process.cwd() } = {}) {
  // An explicit --from-convo wins over the session env: a subagent shares its
  // parent's session id, so the flag is the only way it can pick its own inbox.
  const convoId = argConvo != null && String(argConvo).trim() !== ''
    ? String(argConvo).trim()
    : resolveConvoIdFromEnv({ env }).convoId;
  if (convoId == null) return null;
  // The convoId becomes a PATH SEGMENT (inbox/<id>/…), and `--from-convo` is
  // user-supplied, so `../../x` would read and write outside the mailbox entirely
  // (Codex round 2). Every legitimate id is a positive integer.
  if (!CONVO_ID_RE.test(String(convoId))) return null;
  const persona = peekPersona(convoId) ?? personaForConvo(convoId);
  return {
    convoId: String(convoId),
    persona,
    name: persona ? formatPersona(persona) : null,
    hashtag: shortConvoHash(convoId),
    project: path.basename(cwd),
    cwd,
  };
}

/**
 * Every Claude session that has been active recently — WITHOUT its cooperation.
 *
 * A registry of "agents that ran a mailbox command" is not enough: a session that
 * has done nothing yet is invisible, so you cannot address it without going to
 * that agent and asking who it is. But the identity is already on disk —
 * `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, where the FILENAME is the
 * session id and mtime is the last activity. Everything else (convoId, persona,
 * hashtag) derives from that with the existing pure functions.
 *
 * Requires transcripts to be saved: an agent spawned with an inherited
 * `CLAUDE_CODE_CHILD_SESSION` marker has them OFF and stays invisible here.
 */
export function discoverSessions({ root = DEFAULT_TRANSCRIPT_ROOT, now = Date.now() } = {}) {
  let slugs;
  try { slugs = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const slug of slugs) {
    let names;
    try { names = fs.readdirSync(path.join(root, slug)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const uuid = n.slice(0, -'.jsonl'.length);
      const convoId = uuidToConvoInt(uuid);
      if (convoId == null) continue;
      let mtime;
      try { mtime = fs.statSync(path.join(root, slug, n)).mtimeMs; } catch { continue; }
      const persona = peekPersona(convoId) ?? personaForConvo(convoId);
      out.push({
        convoId: String(convoId),
        persona,
        name: persona ? formatPersona(persona) : null,
        hashtag: shortConvoHash(convoId),
        // The slug is a lossy encoding of the cwd (separators become dashes); good
        // enough to tell two sessions apart on screen, not a path to compute with.
        cwd: slug.replace(/^-/, '/').replace(/-/g, '/'),
        project: slug.split('-').filter(Boolean).pop() ?? null,
        lastActive: mtime,
        source: 'transcript',
      });
    }
  }
  return out.sort((a, b) => b.lastActive - a.lastActive);
}

/** Announce/refresh my registration. Presence is a side effect of use — no daemon. */
export function registerSelf(self, { dir = DEFAULT_MAILBOX_DIR, now = Date.now() } = {}) {
  if (!self) return null;
  // NB: no pid. The only pid available here belongs to this short-lived CLI, which
  // exits seconds later — recording it would imply a liveness it cannot support.
  const row = { ...self, lastMailboxUse: now };
  writeJsonAtomic(path.join(agentsDir(dir), `${self.convoId}.json`), row);
  return row;
}

function readRegistry(dir) {
  let names;
  try { names = fs.readdirSync(agentsDir(dir)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const row = readJson(path.join(agentsDir(dir), n));
    // Rows are unauthenticated files: a convoId becomes a PATH SEGMENT (inbox
    // dir), so validate it like selfIdentity does; clamp lastMailboxUse so a
    // forged far-future stamp can't always win nickname resolution.
    if (!row?.convoId || !CONVO_ID_RE.test(String(row.convoId))) continue;
    const last = Number(row.lastMailboxUse);
    // Identity (name/hashtag/persona) is a pure function of convoId — recompute
    // it, so a forged row can't borrow another agent's #hashtag or name. Only
    // the descriptive cwd/project and the activity stamp come from the file.
    const convoId = String(row.convoId);
    const persona = peekPersona(convoId) ?? personaForConvo(convoId);
    out.push({
      convoId,
      persona,
      name: persona ? formatPersona(persona) : null,
      hashtag: shortConvoHash(convoId),
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      project: typeof row.project === 'string' ? row.project : null,
      lastMailboxUse: Number.isFinite(last) ? Math.min(last, Date.now()) : 0,
      source: 'registry',
    });
  }
  return out;
}

/**
 * Everyone addressable, merging the two sources.
 *
 * Transcript scan is the liveness signal (it sees sessions that never touched
 * mailbox); the registry adds what a transcript cannot know — the exact cwd, the
 * pinned persona, and when the agent last used mailbox. `lastActive` therefore
 * takes the freshest evidence from either side.
 */
export function listAgents({ dir = DEFAULT_MAILBOX_DIR, root = DEFAULT_TRANSCRIPT_ROOT, now = Date.now() } = {}) {
  const byConvo = new Map();
  for (const s of discoverSessions({ root, now })) byConvo.set(s.convoId, { ...s });
  for (const r of readRegistry(dir)) {
    const prev = byConvo.get(r.convoId);
    byConvo.set(r.convoId, {
      ...prev,
      ...r,
      cwd: r.cwd ?? prev?.cwd ?? null,
      // The registry's project is exact; the transcript slug can't tell `my-app` from `my/app`.
      project: r.project ?? prev?.project ?? null,
      lastActive: Math.max(prev?.lastActive ?? 0, r.lastMailboxUse ?? 0),
      source: prev ? 'both' : 'registry',
    });
  }
  return [...byConvo.values()]
    .map((a) => ({ ...a, fresh: now - (a.lastActive ?? 0) < SESSION_FRESH_MS, unread: countUnread(a.convoId, dir) }))
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
}

/**
 * Resolve `--to`, distinguishing a NICKNAME from an EXACT ADDRESS.
 *
 * A persona NAME is a nickname: the pool is 110 names, so several live sessions
 * routinely share one, and "send to Giun" means the Giun you are working with —
 * the most recently active. Same convention as handover.mjs matchTarget (RFC 05):
 * pick the freshest, report the others as `shadowed` so a wrong pick is visible
 * immediately and can be redone by convoId.
 *
 * A `#hashtag` or convoId is an exact address — whoever typed it meant that one
 * convo. `shortConvoHash` keeps only the last 8 digits, so hashtags CAN collide;
 * when they do we refuse rather than guess, because guessing an exact address is
 * silent misdelivery. (Collisions need a 7-digit tail match, so refusing costs
 * nothing in practice.)
 */
export function resolveRecipient(target, agents, { self = null } = {}) {
  const raw = String(target ?? '').trim();
  if (!raw) return { error: 'no recipient: pass --to <persona|#hashtag|convoId>' };

  const t = parseAgentTarget(raw); // the shared reading (agent-target.mjs); `name:<convoId>` is still a convoId
  if (t.kind === 'convoId' && CONVO_ID_RE.test(t.value)) {
    const known = agents.find((a) => String(a.convoId) === t.value);
    // An unknown convoId is still deliverable — the inbox is keyed by id, so mail
    // simply waits for a session that has not shown itself yet.
    return { convoId: t.value, agent: known ?? null, unregistered: !known };
  }

  const isHashtag = t.kind === 'hashtag';
  const want = String(t.kind === 'pid' ? raw : t.value).toLowerCase();
  // A display name is `<emoji> <name>` ("🪱 Giun"); humans type the name alone, so
  // compare against both forms rather than depending on the `persona` object being
  // present on every row (registry rows carry it, transcript rows may not).
  const nameForms = (a) => [a.name, String(a.name ?? '').replace(/^\S+\s+/, ''), a.persona?.name]
    .filter(Boolean).map((v) => String(v).toLowerCase());
  const hits = isHashtag
    ? agents.filter((a) => String(a.hashtag ?? '').toLowerCase() === want)
    : agents.filter((a) => nameForms(a).includes(want));

  if (hits.length === 0) {
    return { error: `no agent ${isHashtag ? `with hashtag ${raw}` : `named "${raw}"`} — run \`mailbox.mjs ls\` to see who is around` };
  }
  if (hits.length === 1) return { convoId: String(hits[0].convoId), agent: hits[0] };
  if (isHashtag) return { ambiguous: hits };

  // Nobody addresses themselves by name: in a straight two-way tie with self, the
  // other one is meant.
  const pool = self ? hits.filter((a) => String(a.convoId) !== self.convoId) : hits;
  if (pool.length === 1) return { convoId: String(pool[0].convoId), agent: pool[0] };
  const sorted = [...pool].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  if ((sorted[0]?.lastActive ?? 0) > (sorted[1]?.lastActive ?? 0)) {
    return { convoId: String(sorted[0].convoId), agent: sorted[0], shadowed: sorted.slice(1) };
  }
  return { ambiguous: sorted };
}

// Filenames sort lexicographically and that IS the delivery order, so two messages
// sent inside the same millisecond must not be ordered by their random suffix. A
// per-process counter makes order exact for one sender; two DIFFERENT processes
// writing in the same millisecond are concurrent by definition and their relative
// order is not meaningful (documented rather than faked).
let ID_SEQ = 0;
export function newMessageId(now = Date.now()) {
  const seq = String(ID_SEQ++ % 1_000_000).padStart(6, '0');
  return `${now}-${seq}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Attachments travel BY REFERENCE (an absolute path), not as copied bytes: same
 * machine, same filesystem, and a copy would only drift from the original. The
 * `{size, mtime}` stamp lets the reader notice the file changed since it was sent.
 */
export function stampRefs(paths) {
  return paths.map((p) => {
    const abs = path.resolve(p);
    let size = null;
    let mtime = null;
    try { const st = fs.statSync(abs); size = st.size; mtime = Math.round(st.mtimeMs); } catch { /* missing → caller warned */ }
    return { path: abs, size, mtime };
  });
}

/** A single message that dwarfs the recipient's context is a denial of service, not mail. */
export const MAIL_BODY_LIMIT = 100_000;

export function sendMail({ to, text, from, attachments = [], replyTo = null, dir = DEFAULT_MAILBOX_DIR, now = Date.now() }) {
  if (String(text ?? '').length > MAIL_BODY_LIMIT) {
    throw new Error(`body too large (${String(text).length} chars, limit ${MAIL_BODY_LIMIT}) — attach a file with --file instead`);
  }
  const id = newMessageId(now);
  const msg = {
    v: MAIL_SCHEMA,
    id,
    to: String(to),
    from: from ? { convoId: from.convoId, name: from.name, hashtag: from.hashtag, project: from.project, cwd: from.cwd } : null,
    text: String(text ?? ''),
    attachments: stampRefs(attachments),
    replyTo: replyTo ?? null,
    sentAt: now,
  };
  writeJsonAtomic(path.join(inboxDir(to, dir), `${id}.json`), msg);
  return msg;
}

function unreadFiles(convoId, dir) {
  try {
    return fs.readdirSync(inboxDir(convoId, dir)).filter((n) => n.endsWith('.json')).sort();
  } catch { return []; }
}

export function countUnread(convoId, dir = DEFAULT_MAILBOX_DIR) {
  return unreadFiles(convoId, dir).length;
}

/** Peek WITHOUT changing state — `check` must be safe to run any number of times. */
export function peekMail(convoId, { dir = DEFAULT_MAILBOX_DIR } = {}) {
  return unreadFiles(convoId, dir)
    .map((n) => readJson(path.join(inboxDir(convoId, dir), n)))
    .filter(Boolean);
}

/**
 * Deliver: read → hand each message to `emit` → ONLY THEN archive it.
 *
 * The order is the at-least-once guarantee. Archiving first (what the first draft
 * did) means a crash between the rename and the print marks a message delivered
 * that nobody ever saw — silent loss at exactly the boundary that matters. Here a
 * crash leaves the message in `inbox/`, so the next read prints it again.
 *
 * Corrupt JSON is quarantined loudly rather than archived silently: a message we
 * cannot parse is exactly the one a human needs to hear about.
 */
export function deliverMail(convoId, { dir = DEFAULT_MAILBOX_DIR, max = DEFAULT_MAX_PER_READ, emit = () => {}, onCorrupt = () => {} } = {}) {
  const names = unreadFiles(convoId, dir);
  const delivered = [];
  let corrupt = 0;
  for (const name of names.slice(0, max)) {
    const src = path.join(inboxDir(convoId, dir), name);
    const parsed = readJson(src);
    const msg = isWellFormedMail(parsed) ? parsed : null;
    if (!msg) {
      let dest = `${src}.corrupt`;
      for (let n = 1; fs.existsSync(dest); n++) dest = `${src}.corrupt.${n}`;
      try {
        fs.renameSync(src, dest);
        corrupt++;
        onCorrupt(dest);
      } catch (e) {
        // Same rule as the archive rename: ENOENT means a peer got there first;
        // anything else (EACCES/EROFS) would leave the bad file in place while we
        // report zero corrupt, so `wait` rediscovers it forever and the monitor
        // spins with no exit-1 backoff (Codex round 3).
        if (e?.code !== 'ENOENT') throw e;
      }
      continue;
    }
    emit(msg);                                   // ← seen by the agent BEFORE any state change
    try {
      fs.mkdirSync(readDir(convoId, dir), { recursive: true });
      fs.renameSync(src, path.join(readDir(convoId, dir), name));
    } catch (e) {
      // ENOENT means a peer archived it first — it WAS delivered, carry on. Any
      // other failure (permissions, read-only fs) means the message stays unread
      // and would be re-printed on every poll: a monitor would spin at full speed
      // re-delivering the same mail forever. Surface it so the CLI exits 1 and the
      // monitor's error branch backs off (Codex round 2).
      if (e?.code !== 'ENOENT') throw e;
    }
    delivered.push(msg);
  }
  // `names.length - delivered.length` would count a quarantined corrupt file as
  // still waiting, so the CLI says "1 more waiting" and the next read finds
  // nothing (Gemini review). What actually remains is what the slice left behind.
  return { delivered, corrupt, remaining: Math.max(0, names.length - max) };
}

/** Opportunistic housekeeping: archived mail is kept, but not forever; orphan tmp goes too. */
export function pruneMailbox({ dir = DEFAULT_MAILBOX_DIR, now = Date.now(), maxAgeMs = READ_RETENTION_MS, tmpAgeMs = TMP_ORPHAN_MS, agentRetentionMs = AGENT_RETENTION_MS, agents = null } = {}) {
  let removed = 0;
  const sweep = (base, age) => {
    let convos;
    try { convos = fs.readdirSync(base); } catch { return; }
    for (const c of convos) {
      const d = path.join(base, c);
      let names;
      try { names = fs.readdirSync(d); } catch { continue; }
      for (const n of names) {
        const f = path.join(d, n);
        const isTmp = n.endsWith('.tmp');
        try {
          if (now - fs.statSync(f).mtimeMs > (isTmp ? tmpAgeMs : age)) { fs.rmSync(f, { force: true }); removed++; }
        } catch { /* raced away */ }
      }
    }
  };
  sweep(path.join(dir, 'read'), maxAgeMs);
  // `agents/` is flat, so sweep it directly. Two things live here: `.tmp` orphans
  // from a registerSelf killed mid-write, and the rows themselves. Rows must expire
  // too — every new session creates one, `listAgents` parses ALL of them on nearly
  // every command, so an unbounded registry makes mailbox quietly slower forever
  // (Gemini round 3). A row is only supplementary data (exact cwd, pinned persona);
  // dropping a long-dead one costs nothing, and the transcript scan still finds any
  // session that is actually alive.
  try {
    for (const n of fs.readdirSync(agentsDir(dir))) {
      const f = path.join(agentsDir(dir), n);
      const ttl = n.endsWith('.tmp') ? tmpAgeMs : agentRetentionMs;
      if (!n.endsWith('.tmp') && !n.endsWith('.json')) continue;
      try { if (now - fs.statSync(f).mtimeMs > ttl) { fs.rmSync(f, { force: true }); removed++; } } catch { /* raced */ }
    }
  } catch { /* no agents dir yet */ }

  // An emptied per-convo directory is pure litter. Only rmdir when it reads empty,
  // and ignore any failure: a sender may be writing into it at this very moment.
  for (const base of [path.join(dir, 'inbox'), path.join(dir, 'read')]) {
    let convos;
    try { convos = fs.readdirSync(base); } catch { continue; }
    for (const c of convos) {
      try { if (fs.readdirSync(path.join(base, c)).length === 0) fs.rmdirSync(path.join(base, c)); } catch { /* in use or raced */ }
    }
  }
  // A sender that died mid-write leaves `<id>.json.<pid>.<ts>.tmp` in the inbox.
  // Durability starts at the rename, so such a file was never sent — but it must
  // not accumulate.
  // Unread mail for an agent that never came back would otherwise accumulate
  // forever — but "old" is NOT "abandoned": a busy agent may leave a month-old
  // message unread while reading newer ones, and deleting it is real loss (Codex
  // round 2). So sweep a recipient's inbox only when the RECIPIENT ITSELF has been
  // silent for the whole TTL; an active recipient's mail is never expired.
  const inboxTtl = maxAgeMs * 2;
  const activity = new Map((agents ?? listAgents({ dir, now })).map((a) => [String(a.convoId), a.lastActive ?? 0]));
  let convos;
  try { convos = fs.readdirSync(path.join(dir, 'inbox')); } catch { convos = []; }
  for (const convoId of convos) {
    const d = path.join(dir, 'inbox', convoId);
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    const recipientSilentFor = now - (activity.get(String(convoId)) ?? 0);
    for (const n of names) {
      const f = path.join(d, n);
      const isTmp = n.endsWith('.tmp');
      try {
        const age = now - fs.statSync(f).mtimeMs;
        if (isTmp ? age > tmpAgeMs : (age > inboxTtl && recipientSilentFor > inboxTtl)) {
          fs.rmSync(f, { force: true });
          removed++;
        }
      } catch { /* raced away */ }
    }
  }
  return removed;
}

/**
 * ONE LINE per message, body JSON-encoded.
 *
 * A mailbox monitor is consumed LINE BY LINE (Claude's Monitor turns each stdout
 * line into its own event), so a body with newlines would split one message across
 * several events and strand the trailer — the same way a multi-line Telegram
 * announce once stranded its `[claim: …]` tag.
 */
/** Flatten anything that could break the line, without quoting it into noise. */
export function oneLine(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

export function formatMailLine(msg, { drifted = [] } = {}) {
  // EVERY field here comes from another process and can contain newlines — a
  // forged `from.name` or an attachment path with a `\n` would break the one-line
  // framing just as a multi-line body would. Identity fields are FLATTENED (control
  // characters → space) rather than JSON-quoted, so the line stays readable
  // (`from 🐘 Voi #a2283444`, not `from "🐘 Voi" #"a2283444"`); only the body is
  // quoted, where escaping is what a reader expects.
  const enc = oneLine;
  const from = msg.from?.name
    ? `${enc(msg.from.name)} #${enc(msg.from.hashtag ?? '')}`
    : enc(msg.from?.convoId ?? 'unknown');
  const files = (msg.attachments ?? []).map((a) => {
    const p = a?.path ?? a;
    return `${enc(p)}${drifted.includes(p) ? ' (ĐÃ ĐỔI kể từ lúc gửi)' : ''}`;
  });
  const att = files.length ? ` [files: ${files.join(', ')}]` : '';
  const re = msg.replyTo ? ` [replyTo: ${enc(msg.replyTo)}]` : '';
  return `[mailbox] mail from ${from}: ${JSON.stringify(capText(msg.text))}${att}${re} [id: ${enc(msg.id)}]`;
}

/**
 * Which referenced files no longer match the stamp taken at send time.
 *
 * Attachments travel by PATH, so the sender can change or delete the file before
 * the recipient looks. The guide promises the recipient can detect that; without
 * this the stamp was stored and never used.
 */
export function driftedRefs(msg) {
  const out = [];
  for (const a of msg?.attachments ?? []) {
    if (!a || typeof a !== 'object' || !a.path) continue;
    try {
      const st = fs.statSync(a.path);
      if ((a.size != null && st.size !== a.size) || (a.mtime != null && Math.round(st.mtimeMs) !== a.mtime)) out.push(a.path);
    } catch { out.push(a.path); }        // gone entirely counts as drift
  }
  return out;
}

/**
 * Write every byte, or throw.
 *
 * `fs.writeSync` on a PIPE may perform a SHORT WRITE — it returns the number of
 * bytes actually written and does not throw — which for anything past PIPE_BUF
 * (4096 chars of multibyte text easily exceeds it) means a partially emitted
 * message that we would then archive as delivered: real loss, and exactly the
 * failure the read→print→archive order exists to prevent (Codex round 3).
 */
export function writeAllSync(fd, text, { write = fs.writeSync } = {}) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`short write: wrote ${off}/${buf.length} bytes`);
    off += n;
  }
  return off;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Block until this convo has mail (or the deadline passes), then deliver it. */
export async function waitForMail(convoId, { dir = DEFAULT_MAILBOX_DIR, timeoutMs = WAIT_DEFAULT_TIMEOUT_S * 1000, pollMs = WAIT_POLL_MS, max = DEFAULT_MAX_PER_READ, emit, onCorrupt, sleepFn = sleep, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (unreadFiles(convoId, dir).length) return deliverMail(convoId, { dir, max, emit, onCorrupt });
    if (now() >= deadline) return { delivered: [], corrupt: 0, remaining: 0 };
    await sleepFn(pollMs);
  }
}

export function parseMailboxArgs(argv) {
  const out = { cmd: null, to: null, text: null, attachments: [], replyTo: null, timeout: WAIT_DEFAULT_TIMEOUT_S, convo: null, json: false, all: false, max: DEFAULT_MAX_PER_READ };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') { out.to = argv[++i] ?? null; continue; }
    if (a === '--file') { const v = argv[++i]; if (v) out.attachments.push(v); continue; }
    if (a === '--reply-to') { out.replyTo = argv[++i] ?? null; continue; }
    if (a === '--timeout') { out.timeout = Number(argv[++i]); continue; }
    if (a === '--max') { out.max = Number(argv[++i]); continue; }
    if (a === '--from-convo') { out.convo = argv[++i] ?? null; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--all') { out.all = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    // Everything after a bare `--` is body, so a message that starts with dashes
    // is not silently eaten as an unknown flag (Fable review).
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    // Unknown flags are an error, not silently set to `true` (which turned a
    // mistyped `--text` into a mail body of "true").
    if (a.startsWith('--')) { out.error = `unknown flag ${a}`; continue; }
    if (out.cmd == null) { out.cmd = a; continue; }
    rest.push(a);
  }
  if (rest.length) out.text = rest.join(' ');
  return out;
}

export const USAGE = `mailbox.mjs — file-based agent↔agent mail (no Telegram needed, RFC 16)

  node ../teleport/scripts/mailbox.mjs whoami
  node ../teleport/scripts/mailbox.mjs ls [--all]
  node ../teleport/scripts/mailbox.mjs send --to <persona|#hashtag|convoId> "text"
  node ../teleport/scripts/mailbox.mjs send --to Voi --file ./report.md "kèm file"
  node ../teleport/scripts/mailbox.mjs check
  node ../teleport/scripts/mailbox.mjs read [--max N] [--json]
  node ../teleport/scripts/mailbox.mjs wait [--timeout <sec>] [--max N]

Exit: 0 ok/mail delivered · 1 error · 2 nothing · 3 ambiguous address
Body may also be piped on stdin. Mail is 1-1; nothing is deleted on read (delivered
mail is archived under tmp/mailbox/read/). Attachments travel as PATHS, not copies.`;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

if (isMainModule(import.meta.url)) {
  const args = parseMailboxArgs(process.argv.slice(2));
  if (args.error) { console.error(`[mailbox] ${args.error}\n${USAGE}`); process.exit(EXIT.ERROR); }
  if (args.help || args.cmd == null || args.cmd === 'help') {
    console.log(USAGE);
    process.exit(args.cmd == null && !args.help ? EXIT.ERROR : EXIT.OK);
  }
  const self = selfIdentity({ argConvo: args.convo });
  if (!self) {
    console.error('[mailbox] no session identity (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID) — pass --from-convo <N>.');
    process.exit(EXIT.ERROR);
  }
  registerSelf(self);
  pruneMailbox();

  // fs.writeSync, NOT console.log: when stdout is a PIPE (exactly the monitor case)
  // console.log queues the write and returns, so a kill between the print and the
  // archive would archive a message the reader never actually received — the very
  // loss the read→print→archive order exists to prevent (Codex review). A
  // synchronous write to fd 1 has really landed before we move the file.
  // No fallback to console.log on failure: that is buffered, so "printed" would
  // again mean "queued", and delivery would archive a message the reader never got
  // (Codex round 2). Let the error propagate — the mail stays unread and the next
  // run re-delivers it, which is the whole point of the ordering.
  const emitLine = (line) => writeAllSync(1, `${line}\n`);
  const emit = (m) => {
    const drifted = driftedRefs(m);
    // The guide promises drift detection unconditionally, so --json carries it as
    // a field rather than making a JSON consumer recompute it (Fable round 2).
    emitLine(args.json ? JSON.stringify({ ...m, drifted }) : formatMailLine(m, { drifted }));
  };
  const onCorrupt = (dest) => console.error(`[mailbox] a message was unreadable — quarantined as ${path.basename(dest)} (NOT deleted); inspect it manually`);

  if (args.cmd === 'whoami') {
    console.log(`${self.name} #${self.hashtag} (convo ${self.convoId}, project ${self.project})`);
    process.exit(EXIT.OK);
  }

  if (args.cmd === 'ls') {
    const agents = listAgents().filter((a) => args.all || a.fresh);
    if (!agents.length) { console.log('[mailbox] no agents seen recently (try --all).'); process.exit(EXIT.NONE); }
    for (const a of agents) {
      const me = String(a.convoId) === self.convoId ? '  ← you' : '';
      const age = Math.round((Date.now() - (a.lastActive ?? 0)) / 60000);
      console.log(`  ${a.name ?? '?'} #${a.hashtag ?? ''}  convo ${a.convoId}  ${a.project ?? '?'}  ${age}m ago${a.fresh ? '' : ' (stale)'}${a.unread ? `  unread ${a.unread}` : ''}${me}`);
    }
    process.exit(EXIT.OK);
  }

  if (args.cmd === 'send') {
    const body = args.text ?? await readStdin();
    if (!body && !args.attachments.length) {
      console.error('[mailbox] nothing to send: pass a body argument, pipe it on stdin, or attach --file.');
      process.exit(EXIT.ERROR);
    }
    for (const f of args.attachments) {
      if (!fs.existsSync(f)) { console.error(`[mailbox] attachment not found: ${f}`); process.exit(EXIT.ERROR); }
    }
    const r = resolveRecipient(args.to, listAgents(), { self });
    if (r.ambiguous) {
      console.error(`[mailbox] "${args.to}" matches ${r.ambiguous.length} agents — say which by convoId:`);
      for (const a of r.ambiguous) console.error(`    ${a.name} #${a.hashtag} (convo ${a.convoId}, ${a.project})`);
      process.exit(EXIT.AMBIGUOUS);
    }
    if (r.error) { console.error(`[mailbox] ${r.error}`); process.exit(EXIT.NONE); }
    let msg;
    try {
      msg = sendMail({ to: r.convoId, text: body, from: self, attachments: args.attachments, replyTo: args.replyTo });
    } catch (e) {
      console.error(`[mailbox] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(EXIT.ERROR);
    }
    const who = r.agent ? `${r.agent.name} #${r.agent.hashtag}` : `convo ${r.convoId}`;
    console.log(`[mailbox] sent to ${who} (id ${msg.id})`);
    if (r.shadowed?.length) {
      console.log(`[mailbox] note: ${r.shadowed.length} other agent(s) share that name and were shadowed by recency — redirect with --to <convoId> if you meant one of:`);
      for (const a of r.shadowed) console.log(`    ${a.name} #${a.hashtag} (convo ${a.convoId}, ${a.project})`);
    }
    if (r.unregistered) console.log('[mailbox] note: that convo has not shown up yet — the mail waits in its inbox.');
    // A name whose only holder died weeks ago resolves cleanly and the mail then
    // sits in an inbox nobody will ever open. Delivering is still right (mail
    // waits, per the guide) but silence about it is not (Fable review).
    if (r.agent && r.agent.fresh === false) {
      const days = Math.floor((Date.now() - (r.agent.lastActive ?? 0)) / 86400000);
      console.log(`[mailbox] WARNING: ${r.agent.name} was last active ${days >= 1 ? `${days}d` : '>6h'} ago — this mail may never be read.`);
    }
    process.exit(EXIT.OK);
  }

  if (args.cmd === 'check') {
    const mail = peekMail(self.convoId);
    if (!mail.length) { console.log('[mailbox] no unread mail.'); process.exit(EXIT.NONE); }
    console.log(`[mailbox] ${mail.length} unread — read them with \`mailbox.mjs read\`:`);
    for (const m of mail.slice(0, args.max)) console.log(`  from ${m.from?.name ?? m.from?.convoId ?? '?'}: ${JSON.stringify(capText(m.text, 80))}`);
    process.exit(EXIT.OK);
  }

  if (args.cmd === 'read' || args.cmd === 'wait') {
    // Clamp: `--max Infinity` (or 1e9) would defeat the bound that exists to keep a
    // flood out of the reader's context.
    const asked = Number(args.max);
    const max = Number.isFinite(asked) ? Math.min(Math.max(1, Math.floor(asked)), MAX_PER_READ_CEILING) : DEFAULT_MAX_PER_READ;
    const { delivered, remaining, corrupt } = args.cmd === 'read'
      ? deliverMail(self.convoId, { max, emit, onCorrupt })
      : await waitForMail(self.convoId, { timeoutMs: Math.max(1, Number(args.timeout) || WAIT_DEFAULT_TIMEOUT_S) * 1000, max, emit, onCorrupt });
    if (!delivered.length) {
      if (corrupt > 0) {
        console.error(`[mailbox] ${corrupt} message(s) were unreadable and quarantined — nothing deliverable.`);
        process.exit(EXIT.ERROR);
      }
      console.log(args.cmd === 'read' ? '[mailbox] no unread mail.' : '[mailbox] no mail within the timeout.');
      process.exit(EXIT.NONE);
    }
    if (remaining > 0) console.log(`[mailbox] ${remaining} more waiting — run read again.`);
    process.exit(EXIT.OK);
  }

  console.error(`[mailbox] unknown command "${args.cmd}".\n\n${USAGE}`);
  process.exit(EXIT.ERROR);
}
