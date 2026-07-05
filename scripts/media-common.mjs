// Shared helpers for the media-generation scripts (RFC 06): gen-image / gen-music
// / gen-video. ZERO-DEPENDENCY — node builtins + global `fetch` only (no SDK).
//
// All Gemini REST calls hit https://generativelanguage.googleapis.com/v1beta and
// authenticate with the `x-goog-api-key` HEADER — the key is NEVER placed in a URL
// query param, logged, or printed (see redact + the scripts' --debug handling).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnvFromFile } from './send-telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve from import.meta.url, NOT cwd: these scripts run from another project's
// cwd (`node ../teleport/scripts/gen-image.mjs …`), so cwd is not teleport.
export const TELEPORT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(TELEPORT_ROOT, '.env');
export const MEDIA_DIR = path.join(TELEPORT_ROOT, 'tmp', 'tele-media'); // gitignored via tmp/
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** GEMINI_API_KEY: process.env wins, then teleport/.env file (same precedence as
 *  send-telegram's token resolution). Throws if absent. */
export function loadGeminiKey({ env = process.env, envFile } = {}) {
  const fromFile = (envFile ?? loadEnvFromFile(ENV_FILE)).GEMINI_API_KEY;
  const key = (env.GEMINI_API_KEY || fromFile || '').toString().trim();
  if (!key) throw new Error('Missing GEMINI_API_KEY — set it in teleport/.env (or the environment).');
  return key;
}

/** Auth headers. `x-goog-api-key` always; Content-Type only for JSON POST bodies
 *  (NOT for the binary video-download GET). */
export function authHeaders(key, { json = true } = {}) {
  const h = { 'x-goog-api-key': key };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** First part bearing inline binary data (image). Iterates — a model may put a
 *  text part before the image, so never hardcode parts[0]. */
export function firstInlineData(parts) {
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    const d = p?.inlineData ?? p?.inline_data;
    if (d?.data) return { data: d.data, mimeType: d.mimeType ?? d.mime_type ?? null };
  }
  return null;
}

/** Lyria Interactions API response: a `model_output` step → content[] audio part. */
export function firstAudioData(response) {
  const steps = response?.steps;
  if (!Array.isArray(steps)) return null;
  for (const s of steps) {
    if (s?.type && s.type !== 'model_output') continue;
    if (!Array.isArray(s?.content)) continue;
    for (const c of s.content) {
      if (c?.type === 'audio' && c?.data) return { data: c.data, mimeType: c.mimeType ?? c.mime_type ?? 'audio/mpeg' };
    }
  }
  return null;
}

/** Collect text parts (used to surface a refusal reason when there's no media). */
export function collectText(partsOrSteps) {
  const out = [];
  const visit = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) {
      if (typeof x?.text === 'string') out.push(x.text);
      if (Array.isArray(x?.content)) visit(x.content);
      if (Array.isArray(x?.parts)) visit(x.parts);
    }
  };
  visit(partsOrSteps);
  return out.join('\n').trim();
}

const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'video/mp4': '.mp4',
};
/** mime → canonical extension (hardcoded; zero-dep). Unknown → fallback + warn. */
export function extFromMime(mime, fallback = '.bin') {
  const k = (mime || '').toString().toLowerCase().split(';')[0].trim();
  if (MIME_EXT[k]) return MIME_EXT[k];
  process.stderr.write(`[media] unknown mime ${JSON.stringify(mime)} → ${fallback}\n`);
  return fallback;
}

// path extension → image mime, for INPUT images passed to an edit request. The
// reverse of MIME_EXT (which is output-side); canonical choice per ext so
// `.jpg`/`.jpeg` both → image/jpeg. Unknown ext → image/jpeg (Gemini sniffs the
// bytes anyway; the declared mime is a hint).
const IMAGE_MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
export function mimeFromPath(p) {
  return IMAGE_MIME_BY_EXT[path.extname(String(p || '')).toLowerCase()] || 'image/jpeg';
}

/** Read a local image → a Gemini `inlineData` request part (base64 + mime). Used
 *  to pass input images into an edit request (gen-image --image). */
export function encodeInlineImage(p) {
  const data = fs.readFileSync(p).toString('base64');
  return { inlineData: { mimeType: mimeFromPath(p), data } };
}

/** Wrap raw PCM audio in a minimal WAV (RIFF) container. Gemini TTS returns raw
 *  little-endian PCM (default 24kHz mono 16-bit) that has no container, so it
 *  must be framed before it plays. Zero-dep (Buffer only). */
export function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitDepth = 16 } = {}) {
  const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const blockAlign = (channels * bitDepth) >> 3;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes.length, 4); // file size - 8
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20);           // audio format = 1 (PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

/** Parse `rate=NNNN` from an audio mime (e.g. `audio/L16;rate=24000`); else default. */
export function sampleRateFromMime(mime, def = 24000) {
  const m = /rate=(\d+)/i.exec(String(mime || ''));
  return m ? Number(m[1]) : def;
}
/** True if a mime is an already-framed/encoded audio container (mp3/ogg/wav) — i.e.
 *  NOT raw PCM. Raw PCM (or missing/L16/pcm) → false → caller wraps in WAV. */
export function isEncodedAudioMime(mime) {
  return /audio\/(mpeg|mp3|ogg|wav|x-wav|aac|opus|flac|mp4)/i.test(String(mime || ''));
}

/** Is `ffmpeg` on PATH? Used to gate the OPT-IN wav→mp3 conversion — teleport is
 *  zero-dep, so ffmpeg is never bundled; if absent we keep the WAV and tell the
 *  user to install it. `runner` is injectable for tests. */
export function ffmpegAvailable({ runner = execFileSync } = {}) {
  try { runner('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
/** Transcode `src` → `dst` with ffmpeg (caller must have checked ffmpegAvailable).
 *  Throws if ffmpeg fails. `runner` injectable for tests. */
export function wavToMp3(src, dst, { bitrate = '128k', runner = execFileSync } = {}) {
  // `-y` = overwrite without an interactive prompt (ffmpeg would otherwise hang or
  // auto-answer inconsistently on a non-tty). The never-clobber policy is enforced
  // by the CALLER (an existsSync check before calling), not by ffmpeg.
  runner('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-b:a', bitrate, dst], { stdio: 'ignore' });
  return dst;
}

/** Output path: honors --out, else tmp/tele-media/<kind>-<random><ext>. The random
 *  suffix (not a timestamp) avoids collisions between concurrent calls. */
export function resolveOutPath(kind, ext, outFlag, { dir = MEDIA_DIR, rand = () => crypto.randomBytes(5).toString('hex') } = {}) {
  if (outFlag) return outFlag;
  return path.join(dir, `${kind}-${rand()}${ext}`);
}

/** Write exclusively ('wx') so two callers never clobber the same file. */
export function writeMediaFile(outPath, buf) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf, { flag: 'wx' });
  return outPath;
}

/** Strip credentials from any string before it could be printed: the api key AND
 *  any bearer-like media `uri` (the video download URI is a credential too — it must
 *  never reach logs/--debug, RFC 06 §3). Applied to --debug dumps and error bodies. */
export function redact(s, key) {
  if (typeof s !== 'string') return s;
  let out = key ? s.split(key).join('***') : s;
  // Mask ANY key ending in "uri" (camelCase OR snake_case: uri, videoUri, video_uri,
  // download_uri, signedUri…) — the rest of this codebase tolerates snake_case from the
  // Gemini API, so the redactor must too, else a `video_uri` field leaks under --debug.
  out = out.replace(/"([a-z_]*uri)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
  return out;
}

/** Safe `--debug` rendering of a response object. ORDER MATTERS: strip large base64
 *  `data` payloads (image/audio bytes — noisy, no need in logs), redact key + bearer
 *  uris on the FULL string, THEN truncate. Truncating FIRST could cut a uri's closing
 *  quote so redact's regex misses it and leaks the prefix (review C). */
export function debugDump(obj, key, { limit = 2000 } = {}) {
  let s;
  try { s = JSON.stringify(obj); } catch { s = String(obj); }
  s = s.replace(/"data"\s*:\s*"([^"]*)"/g, (_m, b64) => `"data":"<${b64.length} b64 chars>"`);
  s = redact(s, key);
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

/** One Gemini REST call. Throws a sanitized Error on non-2xx (never leaks the key).
 *  Returns the Response; caller reads .json() or .arrayBuffer(). fetchFn injectable. */
export async function callGemini(url, { method = 'POST', body, key, json = true } = {}, { fetchFn = fetch } = {}) {
  const res = await fetchFn(url, {
    method,
    headers: authHeaders(key, { json }),
    body: body != null ? (json ? JSON.stringify(body) : body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = redact((await res.text()) ?? '', key); } catch {}
    const hint = res.status === 404 ? ' (model not found — try --model or GEN_*_MODEL env)' : '';
    throw new Error(`Gemini API ${res.status} ${res.statusText || ''}${hint}: ${detail.slice(0, 500)}`.trim());
  }
  return res;
}

/** Deliver a produced file to Telegram via send-telegram.mjs. Runs in the CALLER's
 *  cwd so project resolution + the --convo pin stay correct (RFC: agent owns the topic). */
export function deliverToTelegram(filePath, convo, caption = '') {
  const script = path.join(TELEPORT_ROOT, 'scripts', 'send-telegram.mjs');
  const args = [script, '--file', filePath, '--convo', String(convo)];
  if (caption) args.push(caption);
  execFileSync('node', args, { stdio: 'inherit' });
}

/**
 * Minimal, PURE flag parser. Positional = the first non-flag token (the prompt).
 * Supports `--flag value` and `--flag=value`. Returns { prompt, flags, errors }.
 * boolFlags take no value; valueFlags require one (missing/flag-looking → error).
 */
export function parseMediaArgs(argv, { valueFlags = [], boolFlags = [], multiFlags = [], aliases = {} } = {}) {
  const vf = new Set(valueFlags), bf = new Set(boolFlags), mf = new Set(multiFlags);
  const flags = {}; let prompt = null; const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      let name = tok.slice(2), val;
      const eq = name.indexOf('=');
      if (eq !== -1) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      // Canonicalize aliases BEFORE dispatch so an alias writes into its target's
      // slot — a repeatable alias (e.g. --ref → --image) then preserves CLI order.
      if (Object.prototype.hasOwnProperty.call(aliases, name)) name = aliases[name];
      if (bf.has(name)) {
        // A bool flag takes NO value; reject `--send=false` rather than silently
        // treating it as true (which would surprise the caller).
        if (val !== undefined) { errors.push(`--${name} takes no value (got --${name}=${val})`); continue; }
        flags[name] = true; continue;
      }
      if (vf.has(name) || mf.has(name)) {
        if (val === undefined) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) { errors.push(`--${name} needs a value`); continue; }
          val = next; i++;
        }
        // multiFlags accumulate into an array (repeatable, e.g. --image a --image b);
        // valueFlags keep last-wins single-value semantics.
        if (mf.has(name)) { (flags[name] ??= []).push(val); } else { flags[name] = val; }
        continue;
      }
      errors.push(`unknown flag --${name}`); continue;
    }
    if (prompt === null) prompt = tok;
    else errors.push(`unexpected argument ${JSON.stringify(tok)}`);
  }
  return { prompt, flags, errors };
}

/** Validate `--send`/`--convo` coupling shared by all three scripts. */
export function validateSend(flags) {
  if (flags.send && !flags.convo) return '--send requires --convo <N> (won\'t guess the topic).';
  return null;
}
