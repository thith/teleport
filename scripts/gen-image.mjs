#!/usr/bin/env node
// gen-image.mjs (RFC 06) — generate an image via the Gemini API and save a PNG.
//
//   node ../teleport/scripts/gen-image.mjs "<prompt>" [--aspect-ratio 16:9]
//        [--out <path>] [--model <id>] [--send] [--convo <N>] [--dry-run] [--debug]
//
// Zero-dep: node builtins + fetch. Auth via x-goog-api-key header (never in URL/log).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  GEMINI_BASE, loadGeminiKey, callGemini, firstInlineData, collectText, extFromMime,
  resolveOutPath, writeMediaFile, redact, debugDump, deliverToTelegram, parseMediaArgs, validateSend,
} from './media-common.mjs';

export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export const DEFAULT_IMAGE_MODEL = process.env.GEN_IMAGE_MODEL || 'gemini-3.1-flash-image';

export function parseImageArgs(argv) {
  const { prompt, flags, errors } = parseMediaArgs(argv, {
    valueFlags: ['aspect-ratio', 'out', 'model', 'convo'],
    boolFlags: ['send', 'dry-run', 'debug'],
  });
  const out = {
    prompt,
    aspectRatio: flags['aspect-ratio'] || '1:1',
    model: flags.model || DEFAULT_IMAGE_MODEL,
    outPath: flags.out || null,
    send: !!flags.send,
    convo: flags.convo || null,
    dryRun: !!flags['dry-run'],
    debug: !!flags.debug,
    errors: [...errors],
  };
  if (!prompt) out.errors.push('missing <prompt>');
  if (!ASPECT_RATIOS.includes(out.aspectRatio)) out.errors.push(`--aspect-ratio must be one of ${ASPECT_RATIOS.join(', ')}`);
  const sendErr = validateSend({ send: out.send, convo: out.convo });
  if (sendErr) out.errors.push(sendErr);
  return out;
}

export function buildImageRequest({ prompt, aspectRatio, model }) {
  return {
    url: `${GEMINI_BASE}/models/${model}:generateContent`,
    body: {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } },
    },
  };
}

async function main(argv) {
  const a = parseImageArgs(argv);
  if (a.errors.length) { console.error('[gen-image] ' + a.errors.join('; ')); process.exit(2); }

  const { url, body } = buildImageRequest(a);
  if (a.dryRun) {
    console.log(JSON.stringify({ tool: 'gen-image', model: a.model, url, body, out: a.outPath || '(auto tmp/tele-media)' }, null, 2));
    return;
  }

  const key = loadGeminiKey();
  const res = await callGemini(url, { body, key });
  const json = await res.json();
  if (a.debug) console.error(debugDump(json, key));

  const parts = json?.candidates?.[0]?.content?.parts;
  const inline = firstInlineData(parts);
  if (!inline) {
    const why = collectText(parts) || 'no image part in response (model refused or returned text only)';
    console.error(`[gen-image] no image returned: ${redact(why, key).slice(0, 500)}`);
    process.exit(1);
  }
  const outPath = resolveOutPath('image', extFromMime(inline.mimeType || 'image/png'), a.outPath);
  writeMediaFile(outPath, Buffer.from(inline.data, 'base64'));
  console.log(outPath);
  if (a.send) deliverToTelegram(outPath, a.convo, `🖼️ ${a.prompt}`.slice(0, 1000));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).catch((e) => { console.error('[gen-image] ' + (e?.message ?? e)); process.exit(1); });
}
