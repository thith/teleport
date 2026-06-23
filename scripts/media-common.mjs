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
export function parseMediaArgs(argv, { valueFlags = [], boolFlags = [] } = {}) {
  const vf = new Set(valueFlags), bf = new Set(boolFlags);
  const flags = {}; let prompt = null; const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      let name = tok.slice(2), val;
      const eq = name.indexOf('=');
      if (eq !== -1) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (bf.has(name)) {
        // A bool flag takes NO value; reject `--send=false` rather than silently
        // treating it as true (which would surprise the caller).
        if (val !== undefined) { errors.push(`--${name} takes no value (got --${name}=${val})`); continue; }
        flags[name] = true; continue;
      }
      if (vf.has(name)) {
        if (val === undefined) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) { errors.push(`--${name} needs a value`); continue; }
          val = next; i++;
        }
        flags[name] = val; continue;
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
