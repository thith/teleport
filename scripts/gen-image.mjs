#!/usr/bin/env node
// gen-image.mjs (RFC 06) — generate OR edit an image via the Gemini API, save a PNG.
//
//   node ../teleport/scripts/gen-image.mjs "<prompt>" [--aspect-ratio 16:9]
//        [--image <path>]...   (edit: pass input image(s); --ref is an alias)
//        [--out <path>] [--model <id>] [--send] [--convo <N>] [--dry-run] [--debug]
//
// With --image, the prompt is an EDIT instruction; source dimensions are kept
// unless --aspect-ratio is given.
//
// Zero-dep: node builtins + fetch. Auth via x-goog-api-key header (never in URL/log).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  GEMINI_BASE, loadGeminiKey, callGemini, firstInlineData, collectText, extFromMime,
  resolveOutPath, writeMediaFile, redact, debugDump, deliverToTelegram, parseMediaArgs, validateSend,
  encodeInlineImage,
} from './media-common.mjs';

export const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
export const DEFAULT_IMAGE_MODEL = process.env.GEN_IMAGE_MODEL || 'gemini-3.1-flash-image';

export function parseImageArgs(argv) {
  const { prompt, flags, errors } = parseMediaArgs(argv, {
    valueFlags: ['aspect-ratio', 'out', 'model', 'convo'],
    boolFlags: ['send', 'dry-run', 'debug'],
    multiFlags: ['image'], // repeatable INPUT images for editing
    aliases: { ref: 'image' }, // --ref is an alias; canonicalized so CLI order is kept
  });
  // Input images for editing, in the order given on the command line.
  const images = flags.image || [];
  const editing = images.length > 0;
  // Edit mode preserves the SOURCE dimensions: only pin an aspect ratio when the
  // user explicitly passed --aspect-ratio. Pure text-gen keeps the 1:1 default.
  const aspectExplicit = flags['aspect-ratio'] !== undefined;
  const out = {
    prompt,
    images,
    aspectRatio: aspectExplicit ? flags['aspect-ratio'] : (editing ? null : '1:1'),
    model: flags.model || DEFAULT_IMAGE_MODEL,
    outPath: flags.out || null,
    send: !!flags.send,
    convo: flags.convo || null,
    dryRun: !!flags['dry-run'],
    debug: !!flags.debug,
    errors: [...errors],
  };
  if (!prompt) out.errors.push('missing <prompt>');
  if (out.aspectRatio != null && !ASPECT_RATIOS.includes(out.aspectRatio)) out.errors.push(`--aspect-ratio must be one of ${ASPECT_RATIOS.join(', ')}`);
  const sendErr = validateSend({ send: out.send, convo: out.convo });
  if (sendErr) out.errors.push(sendErr);
  return out;
}

// `images` = already-encoded inlineData parts (from encodeInlineImage), prepended
// before the text part so the model edits them. imageConfig.aspectRatio is only
// set when aspectRatio is non-null (omitted on ratio-less edits → source dims).
export function buildImageRequest({ prompt, aspectRatio, model, images = [] }) {
  const generationConfig = { responseModalities: ['IMAGE'] };
  if (aspectRatio != null) generationConfig.imageConfig = { aspectRatio };
  return {
    url: `${GEMINI_BASE}/models/${model}:generateContent`,
    body: {
      contents: [{ parts: [...images, { text: prompt }] }],
      generationConfig,
    },
  };
}

// For --dry-run: never dump raw base64 image bytes — replace inlineData.data with
// a short placeholder so the printed body stays readable but still shows structure.
export function previewBody(body) {
  const parts = body?.contents?.[0]?.parts?.map((p) =>
    p?.inlineData?.data ? { inlineData: { mimeType: p.inlineData.mimeType, data: `<base64 ${p.inlineData.data.length} chars>` } } : p,
  );
  return parts ? { ...body, contents: [{ parts }] } : body;
}

async function main(argv) {
  const a = parseImageArgs(argv);
  if (a.errors.length) { console.error('[gen-image] ' + a.errors.join('; ')); process.exit(2); }

  // Validate input-image paths here (keeps parseImageArgs pure / fs-free).
  const missing = a.images.filter((p) => !fs.existsSync(p));
  if (missing.length) { console.error(`[gen-image] input image not found: ${missing.join(', ')}`); process.exit(2); }
  const imageParts = a.images.map(encodeInlineImage);

  const { url, body } = buildImageRequest({ ...a, images: imageParts });
  if (a.dryRun) {
    console.log(JSON.stringify({ tool: 'gen-image', model: a.model, url, body: previewBody(body), out: a.outPath || '(auto tmp/tele-media)' }, null, 2));
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
  if (a.send) deliverToTelegram(outPath, a.convo, `${a.images.length ? '✏️' : '🖼️'} ${a.prompt}`.slice(0, 1000));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).catch((e) => { console.error('[gen-image] ' + (e?.message ?? e)); process.exit(1); });
}
