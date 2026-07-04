import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  authHeaders, firstInlineData, firstAudioData, collectText, extFromMime,
  resolveOutPath, writeMediaFile, redact, debugDump, callGemini, parseMediaArgs, validateSend, loadGeminiKey,
  mimeFromPath, encodeInlineImage, pcmToWav, sampleRateFromMime, isEncodedAudioMime,
  ffmpegAvailable, wavToMp3,
} from './media-common.mjs';

test('extFromMime: known mimes + unknown → .bin', () => {
  assert.equal(extFromMime('image/png'), '.png');
  assert.equal(extFromMime('image/jpeg'), '.jpg');
  assert.equal(extFromMime('audio/mpeg'), '.mp3');
  assert.equal(extFromMime('audio/wav'), '.wav');
  assert.equal(extFromMime('video/mp4'), '.mp4');
  assert.equal(extFromMime('audio/mpeg; codecs=mp3'), '.mp3'); // strips params
  assert.equal(extFromMime('application/x-weird'), '.bin');
  assert.equal(extFromMime(null), '.bin');
});

test('firstInlineData: iterates past a leading text part', () => {
  const parts = [{ text: 'Here is your image:' }, { inlineData: { data: 'B64', mimeType: 'image/png' } }];
  assert.deepEqual(firstInlineData(parts), { data: 'B64', mimeType: 'image/png' });
  assert.equal(firstInlineData([{ text: 'no media' }]), null);
  assert.equal(firstInlineData(undefined), null);
  // snake_case variant also accepted — assert the FULL contract (mimeType defaults null)
  assert.deepEqual(firstInlineData([{ inline_data: { data: 'X' } }]), { data: 'X', mimeType: null });
  assert.deepEqual(firstInlineData([{ inline_data: { data: 'Y', mime_type: 'image/jpeg' } }]), { data: 'Y', mimeType: 'image/jpeg' });
});

test('firstAudioData: pulls audio from a model_output step', () => {
  const resp = { steps: [{ type: 'thinking', content: [{ type: 'text', text: 'hm' }] },
                         { type: 'model_output', content: [{ type: 'audio', data: 'AUD', mimeType: 'audio/wav' }] }] };
  assert.deepEqual(firstAudioData(resp), { data: 'AUD', mimeType: 'audio/wav' });
  assert.equal(firstAudioData({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'refused' }] }] }), null);
  assert.equal(firstAudioData({}), null);
});

test('collectText: gathers text for refusal surfacing', () => {
  assert.equal(collectText([{ text: 'a' }, { text: 'b' }]), 'a\nb');
  assert.equal(collectText([{ type: 'model_output', content: [{ type: 'text', text: 'policy' }] }]), 'policy');
});

test('authHeaders: x-goog-api-key always; Content-Type only for json', () => {
  assert.deepEqual(authHeaders('K'), { 'x-goog-api-key': 'K', 'Content-Type': 'application/json' });
  assert.deepEqual(authHeaders('K', { json: false }), { 'x-goog-api-key': 'K' }); // download GET
});

test('redact: strips the api key from a string', () => {
  assert.equal(redact('url?x=SEKRET&y=1 SEKRET', 'SEKRET'), 'url?x=***&y=1 ***');
  assert.equal(redact('nothing', 'SEKRET'), 'nothing');
  // Bearer-like media URIs are credentials too — masked even in --debug dumps (RFC §3).
  assert.equal(redact('{"video":{"uri":"https://x/dl?token=abc"}}', 'SEKRET'), '{"video":{"uri":"***"}}');
  assert.doesNotMatch(redact(JSON.stringify({ response: { uri: 'https://x/secret-dl' } }), null), /secret-dl/);
  // snake_case uri keys are masked too (codebase tolerates snake_case from the API).
  assert.doesNotMatch(redact('{"video_uri":"https://x/snake-secret"}', null), /snake-secret/);
  assert.doesNotMatch(redact('{"download_uri":"https://x/dl-secret"}', null), /dl-secret/);
});

test('debugDump: redacts BEFORE truncating + strips base64 data (no leak past the cut)', () => {
  // A long URI whose closing quote falls past the 2000-char limit must STILL be masked
  // (redact runs on the full string, not the truncated one) — the C-fix from review.
  const longUri = 'https://x/dl?token=' + 's'.repeat(3000);
  const op = { padding: 'p'.repeat(100), response: { generateVideoResponse: { generatedSamples: [{ video: { uri: longUri } }] } } };
  const out = debugDump(op, 'SEKRET');
  assert.doesNotMatch(out, /token=ssss/);          // URI prefix not leaked despite truncation
  // Base64 media bytes are stripped to a length note, not dumped.
  const dumped = debugDump({ inlineData: { data: 'QUJD'.repeat(50), mimeType: 'image/png' } }, null);
  assert.doesNotMatch(dumped, /QUJDQUJD/);
  assert.match(dumped, /b64 chars/);
  // Key still masked.
  assert.doesNotMatch(debugDump({ k: 'SEKRET' }, 'SEKRET'), /SEKRET/);
});

test('resolveOutPath: honors --out, else random (collision-safe) name', () => {
  assert.equal(resolveOutPath('image', '.png', '/tmp/x.png'), '/tmp/x.png');
  const a = resolveOutPath('image', '.png', null);
  const b = resolveOutPath('image', '.png', null);
  assert.notEqual(a, b);                       // random suffix differs
  assert.match(path.basename(a), /^image-[0-9a-f]+\.png$/);
});

test('writeMediaFile: exclusive — never clobbers an existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  const p = path.join(dir, 'image-deadbeef.png');
  writeMediaFile(p, Buffer.from('one'));
  assert.equal(fs.readFileSync(p, 'utf8'), 'one');
  assert.throws(() => writeMediaFile(p, Buffer.from('two')), /EEXIST/); // wx
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseMediaArgs: prompt + value/bool flags, both --f v and --f=v', () => {
  const r = parseMediaArgs(['a prompt', '--model', 'm1', '--send', '--aspect-ratio=16:9'],
    { valueFlags: ['model', 'aspect-ratio'], boolFlags: ['send'] });
  assert.equal(r.prompt, 'a prompt');
  assert.equal(r.flags.model, 'm1');
  assert.equal(r.flags['aspect-ratio'], '16:9');
  assert.equal(r.flags.send, true);
  assert.deepEqual(r.errors, []);
});

test('parseMediaArgs: missing value + unknown flag → errors', () => {
  const r = parseMediaArgs(['p', '--model', '--send'], { valueFlags: ['model'], boolFlags: ['send'] });
  assert.ok(r.errors.some((e) => /--model needs a value/.test(e)));
  const u = parseMediaArgs(['p', '--bogus'], {});
  assert.ok(u.errors.some((e) => /unknown flag --bogus/.test(e)));
  // A bool flag must NOT accept `=value` — `--send=false` would otherwise become true.
  const b = parseMediaArgs(['p', '--send=false'], { boolFlags: ['send'] });
  assert.ok(b.errors.some((e) => /--send takes no value/.test(e)));
  assert.equal(b.flags.send, undefined);
});

test('parseMediaArgs: multiFlags accumulate (repeatable), value/bool unaffected', () => {
  const r = parseMediaArgs(['edit it', '--image', 'a.png', '--image', 'b.png', '--model', 'm'],
    { valueFlags: ['model'], multiFlags: ['image'] });
  assert.equal(r.prompt, 'edit it');
  assert.deepEqual(r.flags.image, ['a.png', 'b.png']);
  assert.equal(r.flags.model, 'm');
  assert.deepEqual(r.errors, []);
  // absent multiFlag → undefined (caller defaults to []), single use → 1-elem array
  assert.equal(parseMediaArgs(['p'], { multiFlags: ['image'] }).flags.image, undefined);
  assert.deepEqual(parseMediaArgs(['p', '--image=x.png'], { multiFlags: ['image'] }).flags.image, ['x.png']);
  // a multiFlag still errors when its value is missing
  assert.ok(parseMediaArgs(['p', '--image'], { multiFlags: ['image'] }).errors.some((e) => /--image needs a value/.test(e)));
});

test('parseMediaArgs: aliases canonicalize in place (order preserved for multiFlags)', () => {
  const r = parseMediaArgs(['p', '--ref', 'a', '--image', 'b'],
    { multiFlags: ['image'], aliases: { ref: 'image' } });
  assert.deepEqual(r.flags.image, ['a', 'b']); // CLI order, not image-then-ref
  assert.equal(r.flags.ref, undefined);
});

test('mimeFromPath: ext → image mime, canonical jpeg, default fallback', () => {
  assert.equal(mimeFromPath('a.png'), 'image/png');
  assert.equal(mimeFromPath('/x/y.JPG'), 'image/jpeg');
  assert.equal(mimeFromPath('z.jpeg'), 'image/jpeg');
  assert.equal(mimeFromPath('w.webp'), 'image/webp');
  assert.equal(mimeFromPath('noext'), 'image/jpeg'); // fallback
});

test('encodeInlineImage: reads file → inlineData part (base64 + mime)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-'));
  const p = path.join(dir, 'pic.png');
  fs.writeFileSync(p, Buffer.from('hello'));
  const part = encodeInlineImage(p);
  assert.equal(part.inlineData.mimeType, 'image/png');
  assert.equal(Buffer.from(part.inlineData.data, 'base64').toString(), 'hello');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pcmToWav: valid 44-byte RIFF/WAVE header + correct sizes for 24kHz mono 16-bit', () => {
  const pcm = Buffer.alloc(100, 7);
  const wav = pcmToWav(pcm, { sampleRate: 24000, channels: 1, bitDepth: 16 });
  assert.equal(wav.length, 44 + 100);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(4), 36 + 100);   // RIFF size = 36 + dataLen
  assert.equal(wav.readUInt16LE(20), 1);          // PCM
  assert.equal(wav.readUInt16LE(22), 1);          // channels
  assert.equal(wav.readUInt32LE(24), 24000);      // sample rate
  assert.equal(wav.readUInt32LE(28), 48000);      // byteRate = 24000 * 1 * 2
  assert.equal(wav.readUInt16LE(32), 2);          // blockAlign = 1 * 16/8
  assert.equal(wav.readUInt16LE(34), 16);         // bitDepth
  assert.equal(wav.readUInt32LE(40), 100);        // data size
  assert.equal(wav.readUInt8(44), 7);             // payload follows header
});

test('sampleRateFromMime / isEncodedAudioMime', () => {
  assert.equal(sampleRateFromMime('audio/L16;rate=24000'), 24000);
  assert.equal(sampleRateFromMime('audio/L16;rate=48000'), 48000);
  assert.equal(sampleRateFromMime('audio/pcm'), 24000);       // default
  assert.equal(sampleRateFromMime(null), 24000);
  assert.equal(isEncodedAudioMime('audio/mpeg'), true);
  assert.equal(isEncodedAudioMime('audio/wav'), true);
  assert.equal(isEncodedAudioMime('audio/L16;rate=24000'), false); // raw PCM → wrap
  assert.equal(isEncodedAudioMime(null), false);
});

test('ffmpegAvailable: true when runner succeeds, false when it throws (ENOENT)', () => {
  assert.equal(ffmpegAvailable({ runner: () => undefined }), true);
  assert.equal(ffmpegAvailable({ runner: () => { const e = new Error('spawn ffmpeg ENOENT'); e.code = 'ENOENT'; throw e; } }), false);
});

test('wavToMp3: builds the expected ffmpeg command (injected runner)', () => {
  let call;
  const dst = wavToMp3('/tmp/a.wav', '/tmp/a.mp3', { bitrate: '192k', runner: (cmd, args) => { call = { cmd, args }; } });
  assert.equal(dst, '/tmp/a.mp3');
  assert.equal(call.cmd, 'ffmpeg');
  assert.deepEqual(call.args, ['-y', '-loglevel', 'error', '-i', '/tmp/a.wav', '-b:a', '192k', '/tmp/a.mp3']);
});

test('wavToMp3: propagates a runner failure (caller keeps the WAV)', () => {
  assert.throws(() => wavToMp3('/tmp/a.wav', '/tmp/a.mp3', { runner: () => { throw new Error('ffmpeg exit 1'); } }), /ffmpeg exit 1/);
});

test('validateSend: --send requires --convo', () => {
  assert.match(validateSend({ send: true, convo: null }), /--send requires --convo/);
  assert.equal(validateSend({ send: true, convo: '123' }), null);
  assert.equal(validateSend({ send: false }), null);
});

test('callGemini: non-2xx throws a SANITIZED error (no key leak) + 404 hint', async () => {
  const fetchFn = async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'boom for key=SEKRET' });
  await assert.rejects(
    () => callGemini('https://x/y', { body: {}, key: 'SEKRET' }, { fetchFn }),
    (e) => {
      assert.match(e.message, /404/);
      assert.match(e.message, /model not found/);     // 404 hint
      assert.doesNotMatch(e.message, /SEKRET/);        // key redacted
      return true;
    },
  );
});

test('callGemini: 2xx returns the Response (caller parses); fetchFn injected, no network', async () => {
  let sawHeaders = null;
  const fetchFn = async (url, opts) => { sawHeaders = opts.headers; return { ok: true, json: async () => ({ ok: 1 }) }; };
  const res = await callGemini('https://x/y', { body: { a: 1 }, key: 'K' }, { fetchFn });
  assert.deepEqual(await res.json(), { ok: 1 });
  assert.equal(sawHeaders['x-goog-api-key'], 'K');
});

test('loadGeminiKey: throws clearly when absent', () => {
  assert.throws(() => loadGeminiKey({ env: {}, envFile: {} }), /Missing GEMINI_API_KEY/);
  assert.equal(loadGeminiKey({ env: { GEMINI_API_KEY: ' k ' }, envFile: {} }), 'k');
});
