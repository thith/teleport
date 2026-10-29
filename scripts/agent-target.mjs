// agent-target.mjs — how a typed agent target is read, shared by /kill, /resume,
// handover --to, mailbox --to and session-name.mjs. Leaf module (no imports), pure.
//
// Order: `pid:<N>` → pid · `convo:<digits>` → convoId · `name:<x>` → x read the same way, minus pid ·
// `#x` or a hashtag shape (shortConvoHash: `[a-j]` + 7 digits, or `t` + digits) → hashtag · exactly 3
// digits → tail (RFC 28: shorthand for a hashtag, see resolveTail) · other all-digit strings →
// convoId · anything else → name. Each caller decides which kinds it accepts, and a hashtag is an
// exact address: callers never fall back to name matching on it. Real convoIds are ~16 digits, so a
// bare 3-digit string is always a tail; `convo:780` names a short convoId explicitly.

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

/** Raw target → `{ kind: 'pid'|'name'|'hashtag'|'tail'|'convoId', value }` (bad pid → `{ kind: 'pid', error }`; bad `convo:` → `{ kind: 'convoId', value: '', error }`). */
export function parseAgentTarget(raw) {
  const s = String(raw ?? '').trim();
  if (/^pid:/i.test(s)) {
    const m = s.match(/^pid:\s*(\d+)$/i);
    const n = m ? Number(m[1]) : NaN;
    return Number.isSafeInteger(n) && n > 1 ? { kind: 'pid', value: n } : { kind: 'pid', error: `bad pid target ${JSON.stringify(s)} — use pid:<PID>` };
  }
  if (/^convo:/i.test(s)) {
    const v = s.slice(6).trim();
    return /^[1-9]\d{0,18}$/.test(v) ? { kind: 'convoId', value: v } : { kind: 'convoId', value: '', error: `bad convo target ${JSON.stringify(s)} — use convo:<convoId>` };
  }
  // `name:` only rules out a pid: `name:#a7611284` (the documented /kill form) is still a hashtag.
  if (/^name:/i.test(s)) {
    const rest = s.slice(5).trim();
    const t = parseAgentTarget(rest);
    return t.kind === 'pid' ? { kind: 'name', value: rest } : t;
  }
  if (s.startsWith('#')) return { kind: 'hashtag', value: s.slice(1).toLowerCase() };
  if (HASHTAG_RE.test(s)) return { kind: 'hashtag', value: s.toLowerCase() };
  if (/^\d{3}$/.test(s)) return { kind: 'tail', value: s };
  if (/^\d+$/.test(s)) return { kind: 'convoId', value: s };
  return { kind: 'name', value: s };
}

/**
 * A 3-digit tail → the one hashtag it stands for, over ALL identities the caller knows (each has a
 * `hashtag`; never pre-filter them by alive/dead/reachable — a hidden twin is the bug this prevents).
 * → `{ none: true }` | `{ hashtag }` | `{ error }` (several different hashtags: lists `label(x)`). Pure.
 */
export function resolveTail(value, identities, label = (x) => `#${x.hashtag}`) {
  const v = String(value).toLowerCase();
  const hits = (identities || []).filter((x) => x?.hashtag && String(x.hashtag).toLowerCase().endsWith(v));
  const tags = [...new Set(hits.map((x) => String(x.hashtag).toLowerCase()))];
  if (!tags.length) return { none: true };
  if (tags.length === 1) return { hashtag: tags[0] };
  const names = [...new Set(hits.map(label))];
  return { error: `"${value}" khớp ${tags.length} agent: ${names.join(', ')} — gõ hashtag đầy đủ.` };
}
