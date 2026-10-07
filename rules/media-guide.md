# Media Guide — generating & editing image / music / video / speech (TTS)

> How to create media with teleport's centralized scripts (Gemini REST, zero-dep). Agents don't produce media natively, so **always** go through these scripts; any project gets them with zero setup (only `../teleport/.env` with `GEMINI_API_KEY`).
>
> **Trigger:** the user asks to "vẽ ảnh / sửa ảnh", "tạo nhạc", "làm video", "đọc/lồng tiếng / TTS", "draw/generate/edit an image", "make a song/clip/video", "text-to-speech / read this aloud" — or any similar phrasing in any language. The global agent config routes those requests here.

## Tooling (zero-dep, in teleport)
- **Image:** `node ../teleport/scripts/gen-image.mjs "<prompt>" [--aspect-ratio 1:1]` — text→image, **or edit** an existing image with `--image <path>` (repeatable; `--ref` is an alias).
- **Music:** `node ../teleport/scripts/gen-music.mjs "<prompt>" [--kind pro|clip]`.
- **Speech (TTS):** `node ../teleport/scripts/gen-tts.mjs "<text>" [--voice Kore]` — read text aloud; single or multi-speaker (see Speech).
- **Video:** `node ../teleport/scripts/gen-video.mjs "<prompt>" [--aspect-ratio 16:9]` — long-running; **run in background + `--send`** (see Video).

**Billable — MUST.** Every call spends real money (video most of all). Only run on the **user's explicit request**; use `--dry-run` to preview the built request without calling the API. Never batch-generate speculatively. Approval of the *task* is **not** approval to spend on every tweak — re-confirm before re-running.

## Common flags (all four scripts)
| Flag | Meaning | Default |
|---|---|---|
| `--out <path>` | output file | `tmp/tele-media/<kind>-<rand>.<ext>` (auto) |
| `--model <id>` | override model | per-script default |
| `--send` | deliver straight to Telegram (via send-telegram) | off (just prints the path) |
| `--convo <N>` | convo so `--send` lands in the right topic | none (**required with `--send`**) |
| `--dry-run` | print the built request, do NOT call the API (free) | off |
| `--debug` | print raw response (key/URI still redacted) | off |

## Image — `gen-image.mjs`
- **Generate:** `"<prompt>" [--aspect-ratio <r>]`. Default `1:1`; accepts `1:1,2:3,3:2,3:4,4:3,4:5,5:4,9:16,16:9,21:9`. Model `gemini-3.1-flash-image` (env `GEN_IMAGE_MODEL`). Output `.png`.
- **Edit (image→image):** pass one or more input images with `--image <path>` (repeatable; `--ref` alias). The `<prompt>` becomes the **edit instruction**. The image(s) are sent as `inlineData` parts before the prompt.
  ```bash
  node ../teleport/scripts/gen-image.mjs "add a red hat, keep the face" --image char.png
  node ../teleport/scripts/gen-image.mjs "merge these two characters" --image a.png --ref b.png
  ```
  - **Source dimensions are preserved** on edit — an aspect ratio is only sent when you pass `--aspect-ratio` explicitly (so an edit doesn't get cropped to 1:1).
  - Missing input file → clean `exit 2`. Input images: png / jpg / jpeg / webp (other extensions default to `image/jpeg`).
- Output extension follows the returned mime (usually `.png`). Model refusal (only text, no image part) → surfaces the reason and exits non-zero; never writes an empty file.

## Music — `gen-music.mjs`
- `--kind pro` (**default**, `lyria-3-pro-preview`, full song) or `--kind clip` (`lyria-3-clip-preview`, ~30s, cheaper/faster). `--wav` → WAV (pro only); default MP3. `--model` (env `GEN_MUSIC_MODEL`) overrides `--kind`.
- **Safety:** do **not** name real artists; **declare the vocal language** in the prompt (the Lyria safety filter is stricter). Refusal → reason + exit non-zero, no empty file.

## Speech (TTS) — `gen-tts.mjs`
Reads text aloud. Model `gemini-3.1-flash-tts-preview` (env `GEN_TTS_MODEL`); Interactions API. Output is a **WAV** (the API returns raw 24kHz mono PCM, framed into a RIFF container for you).
- **Single-speaker:** `--voice <name>` (default `Kore`). Case-insensitive.
  ```bash
  node ../teleport/scripts/gen-tts.mjs "Say cheerfully: have a wonderful day!" --voice Puck
  ```
- **Multi-speaker (≤ 2):** label each line in the text with a speaker name, then map each name to a voice with `--speaker "Name:Voice"` (repeatable). Mutually exclusive with `--voice`.
  ```bash
  node ../teleport/scripts/gen-tts.mjs "Joe: How's it going? Jane: Not bad!" --speaker "Joe:Kore" --speaker "Jane:Puck"
  ```
- **Style / tone / pace live in the TEXT**, not a flag: prefix directorial notes (`Say slowly and warmly: …`) or inline cues like `[whispers]`, `[laughs]`. **Language is auto-detected** (100+) — for Vietnamese just write Vietnamese **with diacritics**; no language flag.
- **`--mp3`** (opt-in) — output MP3 instead of WAV. Needs **`ffmpeg` on PATH** (teleport is zero-dep, so it's not bundled — an optional external tool, like Chrome for slides): if ffmpeg is missing **or the conversion fails**, the script keeps the WAV and prints a one-line install hint — it never fails and never auto-installs. Default stays WAV (universal, no deps; fine for short clips — reach for `--mp3` mainly for longer audio where size matters).
- **30 prebuilt voices:** Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat. Unknown voice / bad `--speaker` format → `exit 2`. Refusal (no audio) → reason + exit non-zero.

## Video — `gen-video.mjs`
- **Prompt convention (MUST):** write the **description** (scene, action, camera, style) in **English** (the model follows it best), but keep **character dialogue in the requested language** — Vietnamese must have **diacritics**, don't translate or strip accents (so lip-sync/voicing is right). Example: `the sheriff shouts to Willy "Đưa súng cho tao!"`. Dialogue language follows the user's request; default to the convo's language.
- `--aspect-ratio` / `--resolution` are **only sent when you pass them** — `veo-3.1-generate-preview` returns **400** if a default `aspectRatio` is sent. Accepts `16:9`/`9:16`; resolution `720p`/`1080p`/`4k`. Model env `GEN_VIDEO_MODEL`.
- **Long-running:** polls every 10s up to `--max-wait` (default 300s). **Run the script in the background + use `--send`** so it doesn't block/kill your turn.
- **Over `--max-wait` = unrecoverable** (the URI is intentionally never printed for security) → re-run or raise `--max-wait`. Don't promise a background video you can't recover.
- If the operation finishes but returns no video (safety refusal / FAILED) → the script surfaces the reason and exits non-zero; treat it as not-produced, don't claim success.

## Delivery & safety
- **Deliver:** add `--send --convo <N>` to push the result into the Telegram topic (`--convo` **required**; you stay the topic owner). Without `--send`, the script just prints the output path — attach it yourself with `send-telegram --file` if needed.
- **Output** goes to `tmp/tele-media/<kind>-<rand>.<ext>` (gitignored). Large binary → never inline into stdout/prompt; only the path is printed.
- **Secrets:** the API key travels only in the `x-goog-api-key` header, never in a URL/log; the scripts redact the key and the video download URI. Don't echo them.

---

Design rationale lives in the maintainers' notes (not published) — this guide is the runtime source of truth agents follow.
