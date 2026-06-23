import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageArgs, buildImageRequest, ASPECT_RATIOS } from './gen-image.mjs';
import { parseMusicArgs, buildMusicRequest, MUSIC_MODEL_FOR_KIND } from './gen-music.mjs';
import {
  parseVideoArgs, buildVideoRequest, operationUrl, videoUriFromOperation, pollOperation,
} from './gen-video.mjs';

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
test('gen-video: defaults (16:9, 720p, max-wait 300) + predictLongRunning shape', () => {
  const a = parseVideoArgs(['a dog running']);
  assert.equal(a.aspectRatio, '16:9');
  assert.equal(a.resolution, '720p');
  assert.equal(a.maxWaitSec, 300);
  assert.deepEqual(a.errors, []);
  const { url, body } = buildVideoRequest(a);
  assert.match(url, /:predictLongRunning$/);
  assert.equal(body.instances[0].prompt, 'a dog running');
  assert.equal(body.instances[0].aspectRatio, '16:9');
  assert.equal(body.parameters.resolution, '720p');
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
