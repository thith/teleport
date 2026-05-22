// Convo hashtag encoding shared by send-telegram (outgoing message prefix)
// and pending-store (admin-facing `/pending` list). Kept in a leaf module
// with no imports from either consumer to avoid circular dependencies.
//
// Telegram requires hashtags to contain at least one letter — pure-numeric
// `#1234` is NOT rendered as clickable. Scheme:
//
// - Long convoId (≥ 8 chars, e.g. Claude/Codex 16-digit env hash):
//   take last 8 chars; convert first digit to letter (0→a, 1→b, ..., 9→j).
//   Result: 8 chars (1 letter + 7 digits). Example: `2205483045424020` →
//   last 8 `45424020` → first `4` → `e` → `e5424020`.
//
// - Short convoId (< 8 chars, Gemini's 4-char id): prepend literal `t`.
//   Result: original + 1. Example: `1234` → `t1234`.

export const CONVO_HASH_LONG_LEN = 8;
const DIGIT_TO_LETTER = 'abcdefghij';

export function shortConvoHash(convoId) {
  const s = String(convoId);
  if (s.length < CONVO_HASH_LONG_LEN) return 't' + s;
  const tail = s.slice(-CONVO_HASH_LONG_LEN);
  const first = tail.charCodeAt(0) - 48; // '0'..'9' → 0..9
  const letter = first >= 0 && first <= 9 ? DIGIT_TO_LETTER[first] : 't';
  return letter + tail.slice(1);
}
