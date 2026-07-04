import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageArgs, buildImageRequest, previewBody, ASPECT_RATIOS } from './gen-image.mjs';
import { parseMusicArgs, buildMusicRequest, MUSIC_MODEL_FOR_KIND } from './gen-music.mjs';
import {
  parseVideoArgs, buildVideoRequest, operationUrl, videoUriFromOperation, pollOperation,
} from './gen-video.mjs';
import {
  parseTtsArgs, buildTtsRequest, ttsAudioFrom, canonicalVoice, TTS_VOICES,
} from './gen-tts.mjs';

// ---- gen-image ----
test('gen-image: defaults (aspect 1:1, default model) + request shape', () => {
  const a = parseImageArgs(['a cat']);
  assert.equal(a.prompt, 'a cat');
  assert.equal(a.aspectRatio, '1:1');
  assert.deepEqual(a.errors, []);
  const { url, body } = buildImageRequest(a);
  assert.match(url, /:generateContent$/);
  assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE']);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '1:1');
  assert.equal(body.contents[0].parts[0].text, 'a cat');
});

test('gen-image: invalid aspect ratio + missing prompt + send-needs-convo', () => {
  assert.ok(parseImageArgs(['p', '--aspect-ratio', '7:7']).errors.some((e) => /aspect-ratio/.test(e)));
  assert.ok(parseImageArgs([]).errors.some((e) => /missing <prompt>/.test(e)));
  assert.ok(parseImageArgs(['p', '--send']).errors.some((e) => /--send requires --convo/.test(e)));
  assert.ok(ASPECT_RATIOS.includes('16:9'));
  assert.deepEqual(parseImageArgs(['p', '--aspect-ratio', '16:9', '--send', '--convo', '9']).errors, []);
});

// ---- gen-image EDIT (input images) ----
test('gen-image edit: --image (repeatable) + --ref alias collect into images[]', () => {
  const a = parseImageArgs(['add a hat', '--image', 'a.png', '--image', 'b.png', '--ref', 'c.png']);
  assert.deepEqual(a.images, ['a.png', 'b.png', 'c.png']);
  assert.deepEqual(a.errors, []);
});

test('gen-image edit: --ref alias preserves interleaved CLI order (not image-then-ref)', () => {
  // --ref canonicalizes to --image IN PLACE, so order follows the command line.
  assert.deepEqual(parseImageArgs(['x', '--ref', 'a.png', '--image', 'b.png']).images, ['a.png', 'b.png']);
});

test('gen-image: previewBody redacts inlineData base64 without mutating the source', () => {
  const body = { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'QUJDRA==' } }, { text: 'hi' }] }], generationConfig: {} };
  const preview = previewBody(body);
  assert.match(preview.contents[0].parts[0].inlineData.data, /^<base64 \d+ chars>$/);
  assert.equal(preview.contents[0].parts[1].text, 'hi');
  // original untouched (the real API request must still carry full bytes)
  assert.equal(body.contents[0].parts[0].inlineData.data, 'QUJDRA==');
});

test('gen-image edit: aspect preserved (null) unless --aspect-ratio given', () => {
  // editing without explicit ratio → aspectRatio null → NO imageConfig in body
  const edit = parseImageArgs(['x', '--image', 'a.png']);
  assert.equal(edit.aspectRatio, null);
  const b1 = buildImageRequest({ ...edit, images: [{ inlineData: { mimeType: 'image/png', data: 'ZZ' } }] });
  assert.equal(b1.body.generationConfig.imageConfig, undefined);
  assert.deepEqual(b1.body.generationConfig.responseModalities, ['IMAGE']);
  // explicit ratio while editing → honored
  const edit2 = parseImageArgs(['x', '--image', 'a.png', '--aspect-ratio', '4:5']);
  assert.equal(edit2.aspectRatio, '4:5');
  // pure text-gen still defaults 1:1
  assert.equal(parseImageArgs(['x']).aspectRatio, '1:1');
});

test('gen-image edit: buildImageRequest prepends inlineData parts before text', () => {
  const images = [
    { inlineData: { mimeType: 'image/png', data: 'AA' } },
    { inlineData: { mimeType: 'image/jpeg', data: 'BB' } },
  ];
  const { body } = buildImageRequest({ prompt: 'merge them', model: 'm', aspectRatio: null, images });
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.equal(parts[0].inlineData.mimeType, 'image/png');
  assert.equal(parts[1].inlineData.mimeType, 'image/jpeg');
  assert.equal(parts[2].text, 'merge them'); // text part last
});

// ---- gen-music ----
test('gen-music: default kind is pro + Interactions API url', () => {
  const a = parseMusicArgs(['lofi beat']);
  assert.equal(a.kind, 'pro');
  assert.equal(a.model, MUSIC_MODEL_FOR_KIND.pro);
  assert.deepEqual(a.errors, []);
  const { url, body } = buildMusicRequest(a);
  assert.match(url, /\/v1beta\/interactions$/);    // NOT :generateContent
  assert.equal(body.model, 'lyria-3-pro-preview');
  assert.equal(body.input, 'lofi beat');
  assert.equal(body.response_format, undefined);   // no --wav
});

test('gen-music: clip kind, --wav only on pro, --model override', () => {
  assert.equal(parseMusicArgs(['p', '--kind', 'clip']).model, MUSIC_MODEL_FOR_KIND.clip);
  assert.ok(parseMusicArgs(['p', '--kind', 'clip', '--wav']).errors.some((e) => /--wav is only supported with --kind pro/.test(e)));
  assert.equal(buildMusicRequest(parseMusicArgs(['p', '--wav'])).body.response_format.type, 'audio');
  assert.equal(parseMusicArgs(['p', '--model', 'custom-x']).model, 'custom-x');
  assert.ok(parseMusicArgs(['p', '--kind', 'bogus']).errors.some((e) => /--kind must be/.test(e)));
});

// ---- gen-video ----
test('gen-video: default request is MINIMAL (no aspectRatio/resolution — veo-3.1 rejects them)', () => {
  const a = parseVideoArgs(['a dog running']);
  assert.equal(a.aspectRatio, null);   // opt-in, not defaulted
  assert.equal(a.resolution, null);
  assert.equal(a.maxWaitSec, 300);
  assert.deepEqual(a.errors, []);
  const { url, body } = buildVideoRequest(a);
  assert.match(url, /:predictLongRunning$/);
  assert.equal(body.instances[0].prompt, 'a dog running');
  assert.equal('aspectRatio' in body.instances[0], false);   // NOT sent by default → no 400
  assert.deepEqual(body.parameters, {});                     // empty params by default
});

test('gen-video: aspectRatio/resolution included ONLY when explicitly passed', () => {
  const a = parseVideoArgs(['a dog', '--aspect-ratio', '9:16', '--resolution', '1080p']);
  assert.deepEqual(a.errors, []);
  const { body } = buildVideoRequest(a);
  assert.equal(body.instances[0].aspectRatio, '9:16');
  assert.equal(body.parameters.aspectRatio, '9:16');
  assert.equal(body.parameters.resolution, '1080p');
});

test('gen-video: validates aspect/resolution/max-wait', () => {
  assert.ok(parseVideoArgs(['p', '--aspect-ratio', '1:1']).errors.some((e) => /aspect-ratio/.test(e))); // veo only 16:9/9:16
  assert.ok(parseVideoArgs(['p', '--resolution', '8k']).errors.some((e) => /resolution/.test(e)));
  assert.ok(parseVideoArgs(['p', '--max-wait', '-5']).errors.some((e) => /max-wait/.test(e)));
});

test('gen-video: operationUrl + videoUriFromOperation', () => {
  assert.equal(operationUrl('operations/abc'), 'https://generativelanguage.googleapis.com/v1beta/operations/abc');
  assert.equal(operationUrl('/models/v/operations/abc').endsWith('/v1beta/models/v/operations/abc'), true);
  const op = { response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://dl/v.mp4' } }] } } };
  assert.equal(videoUriFromOperation(op), 'https://dl/v.mp4');
  assert.equal(videoUriFromOperation({ response: {} }), null);
  // snake_case variant from the API must NOT be dropped (would waste a paid generation).
  const snake = { response: { generate_video_response: { generated_samples: [{ video: { video_uri: 'https://dl/s.mp4' } }] } } };
  assert.equal(videoUriFromOperation(snake), 'https://dl/s.mp4');
});

test('pollOperation: returns when done; throws on timeout — all mocked, no network/no real sleep', async () => {
  // done on the 2nd poll
  const queue = [{ done: false }, { done: true, response: { ok: 1 } }];
  const fetchFn = async () => ({ ok: true, json: async () => queue.shift() });
  const op = await pollOperation('operations/x', { key: 'K', maxWaitMs: 100000, intervalMs: 0, fetchFn, sleepFn: async () => {}, nowFn: () => 0 });
  assert.equal(op.done, true);

  // never done → timeout (nowFn advances past maxWait)
  let t = 0;
  const fetchNeverDone = async () => ({ ok: true, json: async () => ({ done: false }) });
  await assert.rejects(
    () => pollOperation('operations/y', { key: 'K', maxWaitMs: 50, intervalMs: 0, fetchFn: fetchNeverDone, sleepFn: async () => {}, nowFn: () => (t += 100) }),
    /timed out .* operations\/y .* unrecoverable/s,
  );
});

// ---- gen-tts (text-to-speech) ----
test('gen-tts: default voice Kore, model, single-speaker request shape', () => {
  const a = parseTtsArgs(['Say hi cheerfully']);
  assert.equal(a.prompt, 'Say hi cheerfully');
  assert.equal(a.voice, 'Kore');
  assert.equal(a.model, 'gemini-3.1-flash-tts-preview');
  assert.deepEqual(a.errors, []);
  const { url, body } = buildTtsRequest(a);
  assert.match(url, /\/interactions$/);
  assert.equal(body.input, 'Say hi cheerfully');
  assert.deepEqual(body.response_format, { type: 'audio' });
  assert.deepEqual(body.generation_config.speech_config, [{ voice: 'Kore' }]);
});

test('gen-tts: --voice is case-insensitive → canonical', () => {
  assert.equal(canonicalVoice('kore'), 'Kore');
  assert.equal(canonicalVoice('PUCK'), 'Puck');
  assert.equal(canonicalVoice('nope'), null);
  assert.equal(parseTtsArgs(['hi', '--voice', 'puck']).voice, 'Puck');
  assert.equal(TTS_VOICES.length, 30);
});

test('gen-tts: multi-speaker → speech_config with speaker+voice per speaker', () => {
  const a = parseTtsArgs(['Joe: hi Jane: hey', '--speaker', 'Joe:Kore', '--speaker', 'Jane:Puck']);
  assert.deepEqual(a.speakers, [{ name: 'Joe', voice: 'Kore' }, { name: 'Jane', voice: 'Puck' }]);
  assert.deepEqual(a.errors, []);
  const { body } = buildTtsRequest(a);
  assert.deepEqual(body.generation_config.speech_config, [
    { speaker: 'Joe', voice: 'Kore' },
    { speaker: 'Jane', voice: 'Puck' },
  ]);
});

test('gen-tts: --mp3 is an opt-in bool flag (default off)', () => {
  assert.equal(parseTtsArgs(['hi']).mp3, false);
  assert.equal(parseTtsArgs(['hi', '--mp3']).mp3, true);
  assert.deepEqual(parseTtsArgs(['hi', '--mp3']).errors, []);
});

test('gen-tts: validation — bad voice, both modes, >2 speakers, bad speaker format', () => {
  assert.ok(parseTtsArgs(['hi', '--voice', 'Nope']).errors.some((e) => /unknown voice/.test(e)));
  assert.ok(parseTtsArgs(['hi', '--voice', 'Kore', '--speaker', 'A:Puck']).errors.some((e) => /mutually exclusive/.test(e)));
  assert.ok(parseTtsArgs(['hi', '--speaker', 'A:Kore', '--speaker', 'B:Puck', '--speaker', 'C:Leda']).errors.some((e) => /at most 2/.test(e)));
  assert.ok(parseTtsArgs(['hi', '--speaker', 'NoColon']).errors.some((e) => /Name:Voice/.test(e)));
  assert.ok(parseTtsArgs(['hi', '--speaker', 'A:Bogus']).errors.some((e) => /unknown voice/.test(e)));
  assert.ok(parseTtsArgs([]).errors.some((e) => /missing <prompt>/.test(e)));
});

test('gen-tts: ttsAudioFrom reads output_audio, then steps; null when absent', () => {
  assert.deepEqual(ttsAudioFrom({ interaction: { output_audio: { data: 'AA', mimeType: 'audio/L16;rate=24000' } } }),
    { data: 'AA', mimeType: 'audio/L16;rate=24000' });
  assert.deepEqual(ttsAudioFrom({ output_audio: { data: 'BB' } }), { data: 'BB', mimeType: null });
  assert.deepEqual(ttsAudioFrom({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'CC' }] }] }),
    { data: 'CC', mimeType: null });
  assert.equal(ttsAudioFrom({ steps: [{ content: [{ type: 'text', text: 'refused' }] }] }), null);
  assert.equal(ttsAudioFrom({}), null);
});
