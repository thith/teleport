// agent-target.mjs — how a typed agent target is read, shared by /kill, /resume,
// handover --to, mailbox --to and session-name.mjs. Leaf module (no imports), pure.
//
// Order: `pid:<N>` → pid · `name:<x>` → x read the same way, minus pid · `#x` or a hashtag shape
// (shortConvoHash: `[a-j]` + 7 digits, or `t` + digits) → hashtag · all digits →
// convoId · anything else → name. Each caller decides which kinds it accepts, and a
// hashtag is an exact address: callers never fall back to name matching on it.

export const HASHTAG_RE = /^(?:[a-j]\d{7}|t\d+)$/i;

/** Name → comparable form: drop emoji/symbols, collapse spaces, lowercase. */
export function normalizeAgentName(s) {
  return String(s ?? '').normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Outer quotes (ASCII or a phone's curly ones) off a whole-rest target. Pure. */
export function unquoteTarget(s) {
  const q = String(s ?? '').trim();
  const m = q.match(/^(["'“‘])([\s\S]*)(["'”’])$/);
  const pair = { '"': '"', "'": "'", '“': '”', '‘': '’' };
  return m && pair[m[1]] === m[3] ? m[2].trim() : q;
}

/** Raw target → `{ kind: 'pid'|'name'|'hashtag'|'convoId', value }` (bad pid → `{ kind: 'pid', error }`). */
export function parseAgentTarget(raw) {
  const s = String(raw ?? '').trim();
  if (/^pid:/i.test(s)) {
    const m = s.match(/^pid:\s*(\d+)$/i);
    const n = m ? Number(m[1]) : NaN;
    return Number.isSafeInteger(n) && n > 1 ? { kind: 'pid', value: n } : { kind: 'pid', error: `bad pid target ${JSON.stringify(s)} — use pid:<PID>` };
  }
  // `name:` only rules out a pid: `name:#a7611284` (the documented /kill form) is still a hashtag.
  if (/^name:/i.test(s)) {
    const rest = s.slice(5).trim();
    const t = parseAgentTarget(rest);
    return t.kind === 'pid' ? { kind: 'name', value: rest } : t;
  }
  if (s.startsWith('#')) return { kind: 'hashtag', value: s.slice(1).toLowerCase() };
  if (HASHTAG_RE.test(s)) return { kind: 'hashtag', value: s.toLowerCase() };
  if (/^\d+$/.test(s)) return { kind: 'convoId', value: s };
  return { kind: 'name', value: s };
}
