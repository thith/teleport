#!/usr/bin/env node
/**
 * stitch-clip.mjs — nối ảnh tĩnh thành clip dọc (9:16) với Ken Burns + crossfade +
 * burn phụ đề karaoke (ASS) + voice-over (TTS) + nhạc nền. Zero-dep, chỉ cần `ffmpeg`/`ffprobe`.
 *
 * KHÔNG dùng model sinh chữ (Gemini/veo hay lỗi karaoke) — chữ do ffmpeg burn từ ASS
 * ta tự canh, nên có karaoke `\k` chuẩn theo mốc thời gian voice.
 *
 * Dùng:
 *   node stitch-clip.mjs <manifest.json> [--out clip.mp4]
 *
 * Manifest (JSON):
 * {
 *   "aspect": "9:16",            // 1080x1920 (mặc định) — hiện chỉ hỗ trợ dọc
 *   "fps": 30,
 *   "xfade": 0.6,               // thời lượng crossfade giữa 2 cảnh (giây)
 *   "font": "Arial Unicode.ttf", // font có dấu tiếng Việt
 *   "music": "bg.mp3",          // nhạc nền (tùy chọn), sẽ hạ nhỏ + fade
 *   "musicVol": 0.18,
 *   "scenes": [
 *     { "img": "s1.png", "audio": "s1.wav", "sub": "DÒNG CHỮ", "isTitle": true },
 *     ...
 *   ]
 * }
 * Mỗi cảnh dài = độ dài audio cảnh đó (+ đuôi tối thiểu). Karaoke chia đều theo số "token" của sub.
 *
 * Lối tiếp cận: render TỪNG cảnh ra 1 mp4 (Ken Burns + burn sub của riêng nó), rồi
 * dùng xfade nối chuỗi. Tách bạch nên dễ debug + mỗi cảnh giữ đúng sub của mình.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';

function die(msg, code = 1) { console.error(`[stitch-clip] ${msg}`); process.exit(code); }
function sh(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { die(`${cmd} failed: ${e.stderr || e.message}`); }
}
function probeDur(file) {
  const out = sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(out.trim());
  return Number.isFinite(d) ? d : 0;
}

// ---- args ----
const args = process.argv.slice(2);
if (!args.length) die('cần <manifest.json>', 2);
let manifestPath = null, outPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i];
  else if (!manifestPath) manifestPath = args[i];
}
manifestPath = resolve(manifestPath);
if (!existsSync(manifestPath)) die(`không thấy manifest ${manifestPath}`, 2);
const M = JSON.parse(sh('cat', [manifestPath]));
const base = dirname(manifestPath);
const rel = (p) => (p && !p.startsWith('/') ? join(base, p) : p);

const W = 1080, H = 1920;               // 9:16
const FPS = M.fps || 30;
const XF = M.xfade ?? 0.6;
const FONT = M.font || 'Arial Unicode.ttf';
const fontsDir = M.fontsDir || '/System/Library/Fonts/Supplemental';
outPath = resolve(outPath || rel(M.out || 'clip.mp4'));

const scenes = M.scenes || [];
if (!scenes.length) die('manifest không có scenes', 2);

const work = join(base, '_stitch_work');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// ---- ASS builder (karaoke) ----
function assColor() { return '&H00FFFFFF'; } // trắng
function esc(s) { return String(s).replace(/\n/g, '\\N'); }
function buildAss(sub, dur, isTitle) {
  // chia token theo khoảng trắng, phân bổ thời lượng đều → \k centiseconds
  const tokens = String(sub).trim().split(/\s+/);
  const totalCs = Math.max(1, Math.round(dur * 100));
  const per = Math.floor(totalCs / tokens.length);
  let acc = 0;
  const parts = tokens.map((t, i) => {
    let cs = i === tokens.length - 1 ? totalCs - acc : per;
    acc += cs;
    return `{\\kf${cs}}${esc(t)} `;
  });
  // cỡ chữ co theo độ dài subtitle (câu dài nguyên văn → nhỏ lại cho khỏi tràn)
  const len = String(sub).trim().length;
  let fontSize;
  if (isTitle) fontSize = 78;
  else if (len <= 42) fontSize = 56;
  else if (len <= 90) fontSize = 50;
  else if (len <= 150) fontSize = 44;
  else fontSize = 40;
  // câu càng dài → đẩy khối chữ lên cao hơn để nhiều dòng không đụng mép dưới
  const marginV = isTitle ? Math.round(H * 0.42) : (len > 150 ? Math.round(H * 0.08) : Math.round(H * 0.10));
  const marginLR = 70;   // lề 2 bên → ffmpeg tự wrap trong khung
  const outline = 4, shadow = 2;
  // primary = màu chưa hát (mờ), secondary(dùng làm màu đã hát) = gold
  const style = [
    `Style: Karaoke,${FONT},${fontSize}`,
    `&H60FFFFFF`,           // PrimaryColour (chưa hát) — trắng mờ
    `&H0069C0E8`,           // SecondaryColour (đã hát) — GOLD #e8c069 (BGR)
    `&H00000000`,           // OutlineColour
    `&H80000000`,           // BackColour
    `0,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginLR},${marginLR},${marginV},1`,
  ].join(',');
  const dcs = (t) => {
    const cs = Math.round(t * 100);
    const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  };
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
${style}

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,${dcs(0)},${dcs(dur)},Karaoke,,0,0,0,,{\\fad(250,250)}${parts.join('')}
`;
}

// ---- render mỗi cảnh ----
const sceneMp4s = [];
scenes.forEach((sc, idx) => {
  const img = rel(sc.img);
  if (!existsSync(img)) die(`cảnh ${idx + 1}: thiếu ảnh ${img}`, 2);
  const audio = sc.audio ? rel(sc.audio) : null;
  if (audio && !existsSync(audio)) die(`cảnh ${idx + 1}: thiếu audio ${audio}`, 2);
  const adur = audio ? probeDur(audio) : (sc.dur || 3);
  const pad = M.pad ?? 0.5;              // đuôi lặng nhẹ sau mỗi câu (manifest chỉnh được)
  const dur = Math.max(2.0, adur + pad);
  const still = !!(sc.isCover || sc.isChart); // cover & chart: giữ tĩnh/zoom rất nhẹ cho chữ sắc nét

  // ASS
  const assPath = join(work, `s${idx + 1}.ass`);
  writeFileSync(assPath, buildAss(sc.sub || '', dur, !!sc.isTitle));

  // Ken Burns: zoompan. Cảnh ảnh zoom rõ hơn; cover/chart zoom rất nhẹ (chữ sắc nét).
  const dir = idx % 2 === 0 ? 'in' : 'out';
  const spd = still ? 0.0002 : 0.0007;   // tốc độ zoom
  const zmax = still ? 1.04 : 1.14;
  const zExpr = dir === 'in'
    ? `min(zoom+${spd},${zmax})`
    : `if(eq(on,0),${zmax},max(zoom-${spd},1.0))`;
  const frames = Math.round(dur * FPS);
  const vf = [
    `scale=${W}*1.15:${H}*1.15:force_original_aspect_ratio=increase`,
    `crop=${W}*1.15:${H}*1.15`,
    `zoompan=z='${zExpr}':d=${frames}:s=${W}x${H}:fps=${FPS}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `subtitles='${assPath.replace(/'/g, "\\'")}':fontsdir='${fontsDir}'`,
    `format=yuv420p`,
  ].join(',');

  const out = join(work, `scene${idx + 1}.mp4`);
  const a = [];
  a.push('-y', '-loop', '1', '-i', img);
  if (audio) a.push('-i', audio);
  // luôn có 1 audio track: cảnh không voice (cover/chart) → silent, để amix về sau không lỗi "matches no streams"
  else a.push('-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`);
  a.push('-t', String(dur.toFixed(3)));
  a.push('-vf', vf, '-r', String(FPS));
  a.push('-c:a', 'aac', '-b:a', '192k', '-shortest', '-map', '0:v', '-map', '1:a');
  a.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', out);
  sh('ffmpeg', a);
  sceneMp4s.push({ path: out, dur });
  console.error(`[stitch-clip] cảnh ${idx + 1}/${scenes.length} ok (${dur.toFixed(2)}s)`);
});

// ---- nối bằng xfade (video) + acrossfade-ish (audio nối tiếp) ----
// Cách chắc ăn: dùng filter_complex xfade chuỗi + concat audio với delay theo offset.
const inputs = [];
sceneMp4s.forEach((s) => inputs.push('-i', s.path));

// video xfade dây chuyền
let vLast = '0:v';
let offset = sceneMp4s[0].dur - XF;
const fc = [];
for (let i = 1; i < sceneMp4s.length; i++) {
  const lbl = `vx${i}`;
  fc.push(`[${vLast}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[${lbl}]`);
  vLast = lbl;
  offset += sceneMp4s[i].dur - XF;
}

// audio: mỗi cảnh delay = tổng (dur trước - XF). Dùng adelay rồi amix.
const aParts = [];
let aoff = 0;
for (let i = 0; i < sceneMp4s.length; i++) {
  const ms = Math.round(aoff * 1000);
  aParts.push(`[${i}:a]adelay=${ms}|${ms}[a${i}]`);
  aoff += sceneMp4s[i].dur - XF;
}
const amixIn = sceneMp4s.map((_, i) => `[a${i}]`).join('');
fc.push(...aParts);
fc.push(`${amixIn}amix=inputs=${sceneMp4s.length}:dropout_transition=0:normalize=0[voice]`);

const totalDur = sceneMp4s.reduce((s, x) => s + x.dur, 0) - XF * (sceneMp4s.length - 1);

// đuôi: giữ thêm tailHold giây (khỏi "ngắt giữa chừng") + fade-out video/audio endFade giây.
const tailHold = M.tailHold ?? 1.2;
const endFade = M.endFade ?? 1.0;
const finalDur = totalDur + tailHold;
const fadeStart = Math.max(0, finalDur - endFade);

// video: kéo dài frame cuối (tpad) rồi fade-out.
fc.push(`[${vLast}]tpad=stop_mode=clone:stop_duration=${tailHold.toFixed(2)},fade=t=out:st=${fadeStart.toFixed(2)}:d=${endFade}:color=black[vout]`);

// nhạc nền (tùy chọn) — fade-out theo finalDur mới
let finalA = 'voice';
const music = M.music ? rel(M.music) : null;
if (music && existsSync(music)) {
  inputs.push('-i', music);
  const mi = sceneMp4s.length;
  const vol = M.musicVol ?? 0.18;
  fc.push(`[${mi}:a]aloop=loop=-1:size=2e9,volume=${vol},afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeStart.toFixed(2)}:d=${endFade}[bg]`);
  fc.push(`[voice][bg]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[amixed]`);
  finalA = 'amixed';
}
// fade-out audio cuối (áp cho cả trường hợp có/không nhạc)
fc.push(`[${finalA}]afade=t=out:st=${fadeStart.toFixed(2)}:d=${endFade}[aout]`);

const finalArgs = ['-y', ...inputs, '-filter_complex', fc.join(';'),
  '-map', '[vout]', '-map', '[aout]',
  '-t', finalDur.toFixed(3),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath];
sh('ffmpeg', finalArgs);

console.error(`[stitch-clip] ✅ ${outPath} (${totalDur.toFixed(1)}s, ${scenes.length} cảnh)`);
console.log(outPath);
