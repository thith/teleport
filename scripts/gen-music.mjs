#!/usr/bin/env node
// gen-music.mjs (RFC 06) — generate music via the Gemini Lyria 3 Interactions API.
//
//   node ../teleport/scripts/gen-music.mjs "<prompt>" [--kind pro|clip] [--wav]
//        [--out <path>] [--model <id>] [--send] [--convo <N>] [--dry-run] [--debug]
//
// Default --kind pro (full song). NOTE: Lyria uses the Interactions API
// (/v1beta/interactions), NOT :generateContent. Zero-dep: builtins + fetch.

import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import path from 'node:path';
import {
  GEMINI_BASE, loadGeminiKey, callGemini, firstAudioData, collectText, extFromMime,
  resolveOutPath, writeMediaFile, redact, debugDump, deliverToTelegram, parseMediaArgs, validateSend,
} from './media-common.mjs';

export const MUSIC_MODEL_FOR_KIND = { pro: 'lyria-3-pro-preview', clip: 'lyria-3-clip-preview' };
export const DEFAULT_MUSIC_KIND = 'pro';

export function parseMusicArgs(argv) {
  const { prompt, flags, errors } = parseMediaArgs(argv, {
    valueFlags: ['kind', 'out', 'model', 'convo'],
    boolFlags: ['wav', 'send', 'dry-run', 'debug'],
  });
  const kind = flags.kind || DEFAULT_MUSIC_KIND;
  const out = {
    prompt,
    kind,
    // env GEN_MUSIC_MODEL overrides; explicit --model wins over both.
    model: flags.model || process.env.GEN_MUSIC_MODEL || MUSIC_MODEL_FOR_KIND[kind],
    wav: !!flags.wav,
    outPath: flags.out || null,
    send: !!flags.send,
    convo: flags.convo || null,
    dryRun: !!flags['dry-run'],
    debug: !!flags.debug,
    errors: [...errors],
  };
  if (!prompt) out.errors.push('missing <prompt>');
  if (!MUSIC_MODEL_FOR_KIND[kind]) out.errors.push("--kind must be 'pro' or 'clip'");
  if (out.wav && kind !== 'pro') out.errors.push('--wav is only supported with --kind pro');
  const sendErr = validateSend({ send: out.send, convo: out.convo });
  if (sendErr) out.errors.push(sendErr);
  return out;
}

export function buildMusicRequest({ prompt, model, wav }) {
  const body = { model, input: prompt };
  if (wav) body.response_format = { type: 'audio' };
  return { url: `${GEMINI_BASE}/interactions`, body };
}

async function main(argv) {
  const a = parseMusicArgs(argv);
  if (a.errors.length) { console.error('[gen-music] ' + a.errors.join('; ')); process.exit(2); }

  const { url, body } = buildMusicRequest(a);
  if (a.dryRun) {
    console.log(JSON.stringify({ tool: 'gen-music', kind: a.kind, model: a.model, url, body, out: a.outPath || '(auto tmp/tele-media)' }, null, 2));
    return;
  }

  const key = loadGeminiKey();
  const res = await callGemini(url, { body, key });
  const json = await res.json();
  if (a.debug) console.error(debugDump(json, key));

  const audio = firstAudioData(json);
  if (!audio) {
    const why = collectText(json?.steps) || 'no audio part in response (Lyria refused — avoid naming real artists; declare vocal language)';
    console.error(`[gen-music] no audio returned: ${redact(why, key).slice(0, 500)}`);
    process.exit(1);
  }
  const outPath = resolveOutPath('music', extFromMime(audio.mimeType || 'audio/mpeg'), a.outPath);
  writeMediaFile(outPath, Buffer.from(audio.data, 'base64'));
  console.log(outPath);
  if (a.send) deliverToTelegram(outPath, a.convo, `🎵 ${a.prompt}`.slice(0, 1000));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error('[gen-music] ' + (e?.message ?? e)); process.exit(1); });
}
