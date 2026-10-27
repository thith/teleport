// `/ls` listener status: for an agent with a Telegram convo, is its listener
// alive, how many messages are waiting that it has not read yet, and is it busy
// with a claimed batch. READ ONLY — never writes or locks anything.
//
// Every signal reuses the listener's own logic (tele-listen.mjs) so `/ls` can't
// drift from what the listener will actually deliver:
//   - alive   = a listener-registry row for the convo that passes isLiveEntry
//               (pid alive AND start identity matches → pid reuse = dead). The
//               listener-alive heartbeat file is NOT used: it stays fresh for
//               30 min after the listener dies.
//   - unread  = updates in the bot's shared cache that collectMessagesToProcess
//               routes to this convo (its topic per chat; /dm control, service
//               messages and other chats/topics excluded) with
//               update_id >= convo-N-offset.txt (the file holds the NEXT id).
//   - pending = prompt-convo-N.json exists (fetched, not yet claimed by the agent).
//   - busy    = prompt-convo-N.processing.json exists (agent claimed a batch);
//               age from its mtime (the claim touches it).
//
// Routing caveat: the listener's chat whitelist comes from projects.json for the
// agent's project; here the chats are the ones where topics.json maps this convo
// to a topic. A topic only exists where the convo has sent, so the two agree in
// practice.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TMP_DIR, REGISTRY_FILE, readRegistry, readCache, readOffset, isLiveEntry,
  collectMessagesToProcess, promptSegments, botScopedFiles,
} from './tele-listen.mjs';
import { readTopicsStore, getThreadId } from './topics-store.mjs';
import { loadEnvFromFile, extractBotId } from './send-telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

/** Seconds → compact Vietnamese duration ("45 giây", "7 phút", "2 giờ", "3 ngày"). */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} giây`;
  if (s < 3600) return `${Math.floor(s / 60)} phút`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ`;
  return `${Math.floor(s / 86400)} ngày`;
}

/**
 * The ONE cache file to read. update_id sequences are per bot, so a convo
 * offset may only be compared against its own bot's updates — never mix bots:
 *   - botId known   → updates-cache.<botId>.jsonl only (what the live listener
 *                     reads); missing → null (no unread shown).
 *   - botId unknown → the legacy single updates-cache.jsonl; missing → null.
 */
export function resolveCacheFile({ tmpDir = DEFAULT_TMP_DIR, botId = null } = {}) {
  const f = botId != null ? botScopedFiles(botId, tmpDir).cacheFile : path.join(tmpDir, 'updates-cache.jsonl');
  return fs.existsSync(f) ? f : null;
}

function configuredBotId(env = process.env) {
  try {
    const token = env.REPORT_BOT_TOKEN || loadEnvFromFile(ENV_FILE).REPORT_BOT_TOKEN;
    return token ? extractBotId(token) : null;
  } catch { return null; }
}

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/**
 * Build `statusOf(convoId) → string | null`. All shared files (registry, cache,
 * topics) are read ONCE here; per-convo work is a filter over memory plus a few
 * small file stats. Every input is injectable for tests. Never throws: a failed
 * read degrades to "no status" (null) for the affected part / convo.
 */
export function createListenerStatus({
  tmpDir = DEFAULT_TMP_DIR,
  registryFile = tmpDir === DEFAULT_TMP_DIR ? REGISTRY_FILE : path.join(tmpDir, 'listener-registry.jsonl'),
  cacheFile,
  topics,
  isLive = isLiveEntry,
  now = Date.now(),
  botId,
} = {}) {
  let registry = null;
  let updates = null;
  let store = null;
  try { registry = readRegistry(registryFile); } catch { registry = null; }
  try {
    const file = cacheFile !== undefined
      ? cacheFile
      : resolveCacheFile({ tmpDir, botId: botId === undefined ? configuredBotId() : botId });
    // One bot's file only; readCache dedupes by update_id within it.
    // Missing file → null → no unread shown (not "0 unread").
    updates = file && fs.existsSync(file) ? readCache(file) : null;
  } catch { updates = null; }
  try { store = topics ?? readTopicsStore(); } catch { store = null; }

  // Each signal once, structured: null = unknown / nothing to show. The two renderers below share them.
  function listenerOn(convo) {
    if (!Array.isArray(registry)) return null;
    const rows = registry.filter((e) => e && Number(e.convoId) === convo);
    for (const e of rows) {
      try { if (isLive(e)) return true; } catch { /* treat as dead */ }
    }
    return false;
  }

  function unreadInfo(convo) {
    if (!Array.isArray(updates) || !store || typeof store !== 'object') return null;
    const offsetFile = path.join(tmpDir, `convo-${convo}-offset.txt`);
    const offset = readOffset(offsetFile); // 0 when missing = never listened → no baseline
    if (!(offset > 0)) return null;
    const threadByChat = new Map();
    for (const chatId of Object.keys(store)) {
      const tid = getThreadId(store, chatId, String(convo));
      if (tid != null) threadByChat.set(String(chatId), tid);
    }
    if (threadByChat.size === 0) return null;
    const fresh = updates.filter((u) => u.update_id >= offset);
    const msgs = collectMessagesToProcess(fresh, [...threadByChat.keys()], null, 'convo', threadByChat);
    if (!msgs.length) return null;
    const dates = msgs.map((m) => m.msg?.date).filter((d) => Number.isFinite(d));
    return { n: msgs.length, age: dates.length ? formatAge(now - Math.min(...dates) * 1000) : null };
  }

  function promptInfo(convo) {
    const file = path.join(tmpDir, `prompt-convo-${convo}.json`);
    const m = mtimeMs(file);
    if (m == null) return null;
    let n = null;
    try { n = promptSegments(JSON.parse(fs.readFileSync(file, 'utf8'))).length; } catch { /* count unknown */ }
    return { n, age: formatAge(now - m) };
  }

  function processingAge(convo) {
    const m = mtimeMs(path.join(tmpDir, `prompt-convo-${convo}.processing.json`));
    return m == null ? null : formatAge(now - m);
  }

  // [listener, unread, prompt, processing] → one renderer each; a failing signal is omitted.
  const RENDER = {
    inline: [
      (on) => (on ? '🎧 đang nghe' : '🔇 listener tắt'),
      (u) => `📨 ${u.n} tin chưa đọc${u.age ? ` (cũ nhất ${u.age})` : ''}`,
      (p) => `📥 ${p.n ? `${p.n} tin ` : ''}chờ agent nhận (${p.age})`,
      (age) => `⏳ đang xử lý ${age}`,
    ],
    // One `<emoji> <name>: <value>` line each, for the /ls blocks (RFC 26 §3.10).
    lines: [
      (on) => (on ? '🎧 Listener: đang nghe' : '🔇 Listener: tắt'),
      (u) => `📨 Telegram: ${u.n} tin chưa đọc${u.age ? ` (cũ nhất ${u.age})` : ''}`,
      (p) => `📥 Hàng đợi: ${p.n ? `${p.n} tin ` : ''}chờ agent nhận (${p.age})`,
      (age) => `⏳ Đang xử lý: ${age}`,
    ],
  };
  const render = (convoId, kind) => {
    const convo = Number(convoId);
    if (!Number.isSafeInteger(convo) || convo <= 0) return [];
    const out = [];
    for (const [i, sig] of [listenerOn, unreadInfo, promptInfo, processingAge].entries()) {
      try {
        const v = sig(convo);
        if (v != null) out.push(RENDER[kind][i](v));
      } catch { /* omit this part */ }
    }
    return out;
  };

  // Structured listener signal for callers that decide on it (RFC 26 /nudge): 'on' | 'off' | null (unknown).
  statusOf.listener = (convoId) => {
    const convo = Number(convoId);
    if (!Number.isSafeInteger(convo) || convo <= 0) return null;
    try { const on = listenerOn(convo); return on == null ? null : on ? 'on' : 'off'; } catch { return null; }
  };
  // The same status as separate labelled lines (the /ls blocks) → string[].
  statusOf.lines = (convoId) => render(convoId, 'lines');
  return statusOf;
  function statusOf(convoId) {
    const parts = render(convoId, 'inline');
    return parts.length ? parts.join(' · ') : null;
  }
}
