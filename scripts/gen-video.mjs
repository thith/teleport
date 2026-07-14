#!/usr/bin/env node
// gen-video.mjs (RFC 06) — generate a video via Veo (async long-running) and save MP4.
//
//   node ../teleport/scripts/gen-video.mjs "<prompt>" [--aspect-ratio 16:9]
//        [--resolution 720p] [--out <path>] [--model <id>] [--max-wait 300]
//        [--send] [--convo <N>] [--dry-run] [--debug]
//
// Veo is long-running: submit → poll the operation → download a URI (with the api
// key header). RUN THIS IN THE BACKGROUND + use --send (it can take minutes).
// Zero-dep: builtins + fetch. Auth via x-goog-api-key header (never in URL/log).

import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import path from 'node:path';
import {
  GEMINI_BASE, loadGeminiKey, callGemini, authHeaders, redact, debugDump,
  resolveOutPath, writeMediaFile, deliverToTelegram, parseMediaArgs, validateSend,
} from './media-common.mjs';

export const VIDEO_ASPECT_RATIOS = ['16:9', '9:16'];
export const VIDEO_RESOLUTIONS = ['720p', '1080p', '4k'];
export const DEFAULT_VIDEO_MODEL = process.env.GEN_VIDEO_MODEL || 'veo-3.1-generate-preview';
export const POLL_INTERVAL_MS = 10_000;

export function parseVideoArgs(argv) {
  const { prompt, flags, errors } = parseMediaArgs(argv, {
    valueFlags: ['aspect-ratio', 'resolution', 'out', 'model', 'max-wait', 'convo'],
    boolFlags: ['send', 'dry-run', 'debug'],
  });
  const maxWaitRaw = flags['max-wait'] ?? '300';
  const out = {
    prompt,
    // OPT-IN, not defaulted: veo-3.1-generate-preview rejects `aspectRatio` with a
    // 400 ("aspectRatio isn't supported by this model"), and a picky preview model
    // may reject `resolution` too. So omit both unless the user explicitly passes
    // them — the default request carries only the prompt. (Validated only if set.)
    aspectRatio: flags['aspect-ratio'] || null,
    resolution: flags.resolution || null,
    model: flags.model || DEFAULT_VIDEO_MODEL,
    maxWaitSec: Number(maxWaitRaw),
    outPath: flags.out || null,
    send: !!flags.send,
    convo: flags.convo || null,
    dryRun: !!flags['dry-run'],
    debug: !!flags.debug,
    errors: [...errors],
  };
  if (!prompt) out.errors.push('missing <prompt>');
  if (out.aspectRatio && !VIDEO_ASPECT_RATIOS.includes(out.aspectRatio)) out.errors.push(`--aspect-ratio must be one of ${VIDEO_ASPECT_RATIOS.join(', ')}`);
  if (out.resolution && !VIDEO_RESOLUTIONS.includes(out.resolution)) out.errors.push(`--resolution must be one of ${VIDEO_RESOLUTIONS.join(', ')}`);
  if (!Number.isFinite(out.maxWaitSec) || out.maxWaitSec <= 0) out.errors.push('--max-wait must be a positive number of seconds');
  const sendErr = validateSend({ send: out.send, convo: out.convo });
  if (sendErr) out.errors.push(sendErr);
  return out;
}

export function buildVideoRequest({ prompt, aspectRatio, resolution, model }) {
  // Only include aspectRatio/resolution when explicitly set — see parseVideoArgs.
  // Default request is minimal: { instances:[{prompt}], parameters:{} }.
  const instance = { prompt };
  const parameters = {};
  if (aspectRatio) { instance.aspectRatio = aspectRatio; parameters.aspectRatio = aspectRatio; }
  if (resolution) parameters.resolution = resolution;
  return {
    url: `${GEMINI_BASE}/models/${model}:predictLongRunning`,
    body: { instances: [instance], parameters },
  };
}

export function operationUrl(name) {
  return `${GEMINI_BASE}/${String(name).replace(/^\/+/, '')}`;
}

export function videoUriFromOperation(op) {
  // Accept snake_case too (the API may return either; rest of the codebase tolerates
  // both) so a successful PAID generation isn't dropped as "no URI" on a casing diff.
  const r = op?.response;
  const gvr = r?.generateVideoResponse ?? r?.generate_video_response;
  const v = (gvr?.generatedSamples ?? gvr?.generated_samples)?.[0]?.video;
  return v?.uri ?? v?.video_uri ?? null;
}

/** Poll the operation until done or timeout. Returns the final operation object.
 *  Throws on timeout (caller treats result as unrecoverable). sleepFn/fetchFn/nowFn injectable. */
export async function pollOperation(name, {
  key, maxWaitMs, intervalMs = POLL_INTERVAL_MS,
  fetchFn = fetch, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  nowFn = Date.now, onProgress = () => {},
} = {}) {
  const start = nowFn();
  for (;;) {
    const res = await callGemini(operationUrl(name), { method: 'GET', key, json: false }, { fetchFn });
    const op = await res.json();
    if (op?.done) return op;
    const elapsed = nowFn() - start;
    if (elapsed >= maxWaitMs) {
      throw new Error(`timed out after ${Math.round(elapsed / 1000)}s — operation ${name} not done. Result is unrecoverable here (re-run or raise --max-wait).`);
    }
    onProgress(Math.round(elapsed / 1000));
    await sleepFn(intervalMs);
  }
}

async function main(argv) {
  const a = parseVideoArgs(argv);
  if (a.errors.length) { console.error('[gen-video] ' + a.errors.join('; ')); process.exit(2); }

  const { url, body } = buildVideoRequest(a);
  if (a.dryRun) {
    console.log(JSON.stringify({ tool: 'gen-video', model: a.model, url, body, maxWaitSec: a.maxWaitSec, out: a.outPath || '(auto tmp/tele-media)' }, null, 2));
    return;
  }

  const key = loadGeminiKey();
  const submit = await (await callGemini(url, { body, key })).json();
  const name = submit?.name;
  if (!name) { console.error('[gen-video] no operation name returned from submit'); process.exit(1); }
  console.error(`[gen-video] submitted operation; polling every ${POLL_INTERVAL_MS / 1000}s (max ${a.maxWaitSec}s)…`);

  let op;
  try {
    op = await pollOperation(name, { key, maxWaitMs: a.maxWaitSec * 1000, onProgress: (s) => console.error(`[gen-video] polling… ${s}s`) });
  } catch (e) {
    console.error('[gen-video] ' + (e?.message ?? e)); // operation name shown, URI deliberately not
    process.exit(1);
  }
  if (a.debug) console.error(debugDump(op, key));

  const uri = videoUriFromOperation(op);
  if (!uri) {
    // Operation can finish FAILED (e.g. safety refusal) with an `error` instead of a
    // sample — surface that reason (redacted) rather than a generic "no URI".
    const reason = op?.error?.message ? ` API error: ${redact(String(op.error.message), key)}` : '';
    console.error('[gen-video] operation done but no video URI in response.' + reason);
    process.exit(1);
  }
  // Download the bytes (URI is a bearer-like resource — NEVER print it). Wrap the
  // fetch: a thrown network error (e.g. ENOTFOUND) can embed the full URI in its
  // message, which would otherwise reach the top-level catch unredacted.
  let bytes;
  try {
    const dl = await fetch(uri, { headers: authHeaders(key, { json: false }) });
    if (!dl.ok) { console.error(`[gen-video] video download failed: ${dl.status} ${dl.statusText}`); process.exit(1); }
    bytes = Buffer.from(await dl.arrayBuffer());
  } catch {
    console.error('[gen-video] video download request failed (network error).'); // URI never echoed
    process.exit(1);
  }
  const outPath = resolveOutPath('video', '.mp4', a.outPath);
  writeMediaFile(outPath, bytes);
  console.log(outPath);
  if (a.send) deliverToTelegram(outPath, a.convo, `🎬 ${a.prompt}`.slice(0, 1000));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error('[gen-video] ' + (e?.message ?? e)); process.exit(1); });
}
