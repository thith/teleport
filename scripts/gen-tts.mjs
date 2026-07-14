#!/usr/bin/env node
// gen-tts.mjs (RFC 06) — text-to-speech via Gemini TTS (Interactions API).
//
//   node ../teleport/scripts/gen-tts.mjs "<text to speak>" [--voice Kore]
//        [--speaker "Name:Voice"]...   (multi-speaker; mutually exclusive with --voice)
//        [--mp3]   (opt-in; needs ffmpeg on PATH, else keeps WAV)
//        [--out <path>] [--model <id>] [--send] [--convo <N>] [--dry-run] [--debug]
//
// Style/tone/pace come from the text itself (e.g. "Say cheerfully: …", "[whispers]");
// the model auto-detects the input language. Output is WAV (the API returns raw
// 24kHz mono 16-bit PCM which we frame into a RIFF/WAV container). Zero-dep;
// --mp3 shells out to ffmpeg only if it's installed (never bundled/auto-installed).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import path from 'node:path';
import {
  GEMINI_BASE, loadGeminiKey, callGemini, collectText, extFromMime,
  resolveOutPath, writeMediaFile, redact, debugDump, deliverToTelegram, parseMediaArgs, validateSend,
  pcmToWav, sampleRateFromMime, isEncodedAudioMime, ffmpegAvailable, wavToMp3,
} from './media-common.mjs';

// The 30 prebuilt Gemini TTS voices (https://ai.google.dev/gemini-api/docs/speech-generation).
export const TTS_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];
export const DEFAULT_TTS_MODEL = process.env.GEN_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
export const DEFAULT_TTS_VOICE = 'Kore';
export const MAX_TTS_SPEAKERS = 2; // Gemini multi-speaker supports at most 2 speakers.

// Case-insensitive → canonical voice name ('kore' → 'Kore'); null if unknown.
const VOICE_BY_LC = new Map(TTS_VOICES.map((v) => [v.toLowerCase(), v]));
export function canonicalVoice(v) {
  return VOICE_BY_LC.get(String(v ?? '').trim().toLowerCase()) || null;
}

export function parseTtsArgs(argv) {
  const { prompt, flags, errors } = parseMediaArgs(argv, {
    valueFlags: ['voice', 'out', 'model', 'convo'],
    boolFlags: ['mp3', 'send', 'dry-run', 'debug'],
    multiFlags: ['speaker'],
  });
  // --speaker "Name:Voice" → { name, voice }. First ':' splits (names have no ':').
  const speakers = [];
  for (const spec of flags.speaker || []) {
    const idx = String(spec).indexOf(':');
    const name = idx === -1 ? '' : spec.slice(0, idx).trim();
    const rawVoice = idx === -1 ? '' : spec.slice(idx + 1).trim();
    if (!name || !rawVoice) { errors.push(`--speaker must be "Name:Voice" (got ${JSON.stringify(spec)})`); continue; }
    speakers.push({ name, voice: canonicalVoice(rawVoice) || rawVoice, ok: canonicalVoice(rawVoice) != null });
  }
  const out = {
    prompt,
    voice: flags.voice != null ? (canonicalVoice(flags.voice) || flags.voice) : DEFAULT_TTS_VOICE,
    speakers: speakers.map(({ name, voice }) => ({ name, voice })),
    model: flags.model || DEFAULT_TTS_MODEL,
    outPath: flags.out || null,
    mp3: !!flags.mp3,
    send: !!flags.send,
    convo: flags.convo || null,
    dryRun: !!flags['dry-run'],
    debug: !!flags.debug,
    errors: [...errors],
  };
  if (!prompt) out.errors.push('missing <prompt>');
  if (flags.voice != null && speakers.length) out.errors.push('--voice and --speaker are mutually exclusive (single vs multi-speaker)');
  if (speakers.length > MAX_TTS_SPEAKERS) out.errors.push(`multi-speaker supports at most ${MAX_TTS_SPEAKERS} speakers (got ${speakers.length})`);
  // Validate voices against the prebuilt set (case-insensitive; canonicalized above).
  const bad = speakers.length
    ? speakers.filter((s) => !s.ok).map((s) => s.voice)
    : (canonicalVoice(out.voice) ? [] : [out.voice]);
  if (bad.length) out.errors.push(`unknown voice: ${[...new Set(bad)].join(', ')} — see rules/media-guide.md for the ${TTS_VOICES.length} voices`);
  const sendErr = validateSend({ send: out.send, convo: out.convo });
  if (sendErr) out.errors.push(sendErr);
  return out;
}

export function buildTtsRequest({ prompt, model, voice, speakers = [] }) {
  // Interactions API (like Lyria music), NOT :generateContent. Single-speaker →
  // one { voice } entry; multi-speaker → one { speaker, voice } per speaker.
  const speech_config = speakers.length
    ? speakers.map((s) => ({ speaker: s.name, voice: s.voice }))
    : [{ voice }];
  return {
    url: `${GEMINI_BASE}/interactions`,
    body: { model, input: prompt, response_format: { type: 'audio' }, generation_config: { speech_config } },
  };
}

// TTS audio lives at Interactions `output_audio` (raw base64 PCM); fall back to the
// steps[].content[] audio shape. Returns null mimeType when absent (→ treated as PCM).
export function ttsAudioFrom(json) {
  const oa = json?.interaction?.output_audio ?? json?.output_audio;
  if (oa?.data) return { data: oa.data, mimeType: oa.mimeType ?? oa.mime_type ?? null };
  const steps = json?.steps;
  if (Array.isArray(steps)) {
    for (const s of steps) {
      if (s?.type && s.type !== 'model_output') continue;
      for (const c of s?.content || []) {
        if (c?.type === 'audio' && c?.data) return { data: c.data, mimeType: c.mimeType ?? c.mime_type ?? null };
      }
    }
  }
  return null;
}

async function main(argv) {
  const a = parseTtsArgs(argv);
  if (a.errors.length) { console.error('[gen-tts] ' + a.errors.join('; ')); process.exit(2); }

  const { url, body } = buildTtsRequest(a);
  if (a.dryRun) {
    console.log(JSON.stringify({ tool: 'gen-tts', model: a.model, url, body, out: a.outPath || '(auto tmp/tele-media)' }, null, 2));
    return;
  }

  const key = loadGeminiKey();
  const res = await callGemini(url, { body, key });
  const json = await res.json();
  if (a.debug) console.error(debugDump(json, key));

  const audio = ttsAudioFrom(json);
  if (!audio) {
    // Refusal text may live in steps[] or at the interaction level — check both.
    const why = collectText(json?.steps) || collectText(json?.interaction ? [json.interaction] : [])
      || 'no audio in response (TTS refused or returned text only)';
    console.error(`[gen-tts] no audio returned: ${redact(why, key).slice(0, 500)}`);
    process.exit(1);
  }
  const raw = Buffer.from(audio.data, 'base64');
  // Gemini TTS returns raw PCM (no container) → frame into WAV. If the API ever
  // returns an already-encoded container (mp3/ogg/wav), write it through as-is.
  let outBuf, ext;
  if (isEncodedAudioMime(audio.mimeType)) {
    outBuf = raw;
    ext = extFromMime(audio.mimeType, '.wav');
  } else {
    outBuf = pcmToWav(raw, { sampleRate: sampleRateFromMime(audio.mimeType) });
    ext = '.wav';
  }
  // --mp3 is OPT-IN and needs ffmpeg (teleport ships zero-dep, so it's never
  // bundled). Only the real PCM→WAV case is convertible; write the WAV first,
  // then transcode only if ffmpeg is present. On ANY fallback (no ffmpeg, or the
  // transcode fails) keep the WAV — never fail (the audio, the paid part, already
  // succeeded) and never auto-install.
  const willConvert = a.mp3 && ext === '.wav';
  let outPath = resolveOutPath('tts', ext, willConvert ? null : a.outPath);
  writeMediaFile(outPath, outBuf);
  if (willConvert) {
    // Fallback: keep the WAV; if the user gave --out, honor it as a .wav sibling
    // (rename off the tmp path) so the file still lands where they asked.
    const keepWav = (msg) => {
      if (a.outPath) {
        const wavDst = a.outPath.replace(/\.(wav|mp3)$/i, '') + '.wav';
        if (wavDst !== outPath) { try { fs.renameSync(outPath, wavDst); outPath = wavDst; } catch {} }
      }
      console.error(`${msg} — keeping WAV ${outPath}.`);
    };
    // Honor --out for the mp3 (swap any .wav/.mp3 suffix to .mp3), else auto.
    const mp3Path = a.outPath ? a.outPath.replace(/\.(wav|mp3)$/i, '') + '.mp3' : resolveOutPath('tts', '.mp3', null);
    if (!ffmpegAvailable()) {
      keepWav('[gen-tts] --mp3: ffmpeg not found on PATH; install it (macOS: `brew install ffmpeg`, Debian/Ubuntu: `apt install ffmpeg`)');
    } else if (fs.existsSync(mp3Path)) {
      // Never clobber an existing target (mirrors writeMediaFile's wx guarantee).
      keepWav(`[gen-tts] --mp3: ${mp3Path} already exists (not overwriting)`);
    } else {
      try {
        wavToMp3(outPath, mp3Path);
        try { fs.unlinkSync(outPath); } catch {} // drop the intermediate WAV
        outPath = mp3Path;
      } catch (e) {
        try { fs.unlinkSync(mp3Path); } catch {} // remove any partial mp3 ffmpeg left
        keepWav(`[gen-tts] --mp3: ffmpeg conversion failed (${e?.message ?? e})`);
      }
    }
  }
  console.log(outPath);
  if (a.send) deliverToTelegram(outPath, a.convo, `🗣️ ${a.prompt}`.slice(0, 1000));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error('[gen-tts] ' + (e?.message ?? e)); process.exit(1); });
}
