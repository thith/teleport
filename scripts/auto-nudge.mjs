// Automatic nudge on the daemon's 60 s heartbeat (RFC 26 §3.11, Thi 11271/11274/11278). An agent is
// nudged only for something NEW it has not read:
//   - mailbox mail sent in the last WINDOW_MS                     → "Check your mailbox, …"
//   - listener OFF and a Telegram item (topic message or queued
//     prompt: ask / whisper / delivery) newer than WINDOW_MS      → "Restart Telegram monitor, …"
//   - both → the combined line.
// A listener that is off with nothing waiting is left alone (turning it off can be intentional — fewer pings).
// WINDOW_MS > the heartbeat, so every item is seen at least once; `seen` (in RAM, convo → newest stamps
// already reminded, set once the line was typed) keeps two ticks from nudging twice for the same item;
// a refused nudge is retried on the next tick while the item is still inside the window. Nothing is posted to Telegram:
// the TypeRunner audits, and the agent posts its own status.

import { typeTargets, pinTarget, observe, NUDGE_LINES } from './type-cmd.mjs';
import { uuidToConvoInt } from './convo-registry.mjs';

export const AUTO_NUDGE_WINDOW_MS = 80_000;
const NUDGED = '👋 đã nudge'; // TypeRunner.nudge success text

/**
 * What to remind `convo` of now. `mailAt` / `tgAt` = newest unread stamps (ms | null), `listener` 'on'|'off'|null,
 * `prev` = { mail, tg } already reminded. → { line, mark } | null. Pure.
 */
export function autoNudgeNeed({ mailAt, tgAt, listener, prev = {}, now, windowMs = AUTO_NUDGE_WINDOW_MS }) {
  const fresh = (at, before) => at != null && now - at <= windowMs && !(before != null && at <= before);
  const mail = fresh(mailAt, prev.mail);
  const tg = listener === 'off' && fresh(tgAt, prev.tg);
  if (!mail && !tg) return null;
  return { line: mail && tg ? NUDGE_LINES.both : mail ? NUDGE_LINES.mail : NUDGE_LINES.listener, mark: { mail: mail ? mailAt : prev.mail ?? null, tg: tg ? tgAt : prev.tg ?? null } };
}

/**
 * One heartbeat pass. deps: list() rows, io (observe), runner (TypeRunner), mailAt(convo), tgAt(convo),
 * listener(convo), personaOf(hashtag), now, seen (Map), log. → [{ hashtag, line, text }] of the nudges tried.
 */
export async function autoNudgeTick({ list, io, runner, mailAt, tgAt, listener, personaOf = () => null, now = Date.now(), seen, log = () => {} }) {
  const rows = list();
  const count = new Map();
  for (const r of rows) if (r.hashtag) count.set(r.hashtag, (count.get(r.hashtag) || 0) + 1);
  const out = [];
  for (const r of typeTargets(rows)) {
    if (count.get(r.hashtag) > 1) continue; // a twin: never guess which one
    const convo = uuidToConvoInt(r.sessionId);
    if (convo == null) continue;
    const need = autoNudgeNeed({ mailAt: mailAt(convo), tgAt: tgAt(convo), listener: listener(convo), prev: seen.get(convo), now });
    if (!need) continue;
    const t = pinTarget(r);
    if (observe(t, io).mismatch) continue;
    const res = await runner.run('n', t, 'auto', { persona: personaOf(t.hashtag), line: need.line }).catch((e) => ({ text: `❌ ${e?.message ?? e}` }));
    // Marked only once typed: a refusal (lock, cool-down, dialog) is retried next tick while still in the window.
    if (String(res.text).startsWith(NUDGED)) seen.set(convo, need.mark);
    log(`[auto-nudge] #${t.hashtag}: ${res.text}`);
    out.push({ hashtag: t.hashtag, line: need.line, text: res.text });
  }
  return out;
}
