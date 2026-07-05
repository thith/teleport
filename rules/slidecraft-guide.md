# Slidecraft Guide — building pitch/slide decks

> How to turn a proposal/document (or a brief) into a **premium presentation deck**. Output is a **landscape PDF** (16:9, one slide per page); the HTML is only the build source. Lives in teleport so any project gets it with zero setup (only Google Chrome required).
>
> **Trigger:** the user asks to "tạo/làm slide", "convert proposal to slides", "pitch deck", "make a deck/presentation". The global agent config routes those requests here.

## Tooling (zero-dep, in teleport)
- **Render:** `node ../teleport/scripts/render-slides.mjs <deck-dir> [out.pdf]` — HTML deck dir → landscape PDF. Node built-ins + headless Google Chrome only (no npm install). Deck must set print CSS `@page{size:1280px 720px;margin:0}` + `.slide{...;break-after:page}`. Env: `SLIDE_VTB` = Chrome virtual-time-budget in ms (default 12000; raise if CDN fonts/mermaid need longer); `CHROME_PATH` = Chrome binary; `SLIDE_CHROME_NO_SANDBOX=1` only for CI/containers (sandbox is on by default).
- **Illustrations:** `node ../teleport/scripts/gen-image.mjs "<prompt>" --aspect-ratio 16:9 --out <path>` (Gemini, key from teleport/.env). **Billable** — each call spends. Outline approval is **not** approval to spend: get an explicit OK before generating images.
- **Verify:** rasterize and actually look at the pages (needs **ImageMagick**; if absent, open the PDF or take a Chrome screenshot) — one page `magick -density 96 "out.pdf[0]" /tmp/s.png` (0-based) or **all pages at once** `magick -density 96 "out.pdf" /tmp/slide-%02d.png` (then read /tmp/slide-*.png).

## Core principles (learned the hard way)
- **PDF is the deliverable.** HTML is a styled draft used to render the PDF. Host the HTML only if asked.
- **Fewer words, sharper copy.** Slides ≠ paragraphs: one headline + a few high-impact lines per slide. Cut clutter but **never overclaim** (esp. AI capability/outcome/financial claims — keep "helps/likely/may"; state what AI *delivers* as quality, not guarantees).
- **Varied layouts — never all 2-column.** Adjacent slides must not share a structure. Some slides intentionally have **no image** so the deck breathes.
- **Image sizes vary** (full-bleed / large plate / framed figure / faint background / small seal / none). Not every slide needs one.
- **Debate the layout before building, review after — both with 3 AIs** (built-in subagent + Gemini CLI + Codex CLI). Mandatory.

## Workflow (in order)
1. **Outline + plan gate.** Distill the source into ~10–12 slides, one headline/idea each (cover → problem → stakes → approach → architecture/how → proof/AI → comparison → demo → roadmap → close). Confirm the outline with the user before building.
2. **Debate per-slide LAYOUT with 3 AIs.** Give each reviewer the per-slide content + available image assets; ask for a **distinct layout per slide** from the vocabulary below, no two adjacent the same, not every slide imaged. Synthesize into one final per-slide table; resolve disagreements decisively.
3. **Build the HTML deck.** Fixed `.slide{width:1280px;height:720px}`, stacked; print CSS `@media print{@page{size:1280px 720px;margin:0} .slide{break-after:page}}`. Editorial style by default (tokens below) or match the client brand/logo. Each slide: small letterspaced eyebrow + hairline rule + serif headline + minimal content + footer (brand · NN/TT). ~80px margins. Add ←/→ nav + a `.hint` pill hidden in `@media print`.
4. **Generate cohesive illustrations** only where the layout needs them, with one consistent style prefix. **Full-bleed backgrounds MUST be borderless** — flat editorial illustrations carry cream margins that show as ugly edges; for cover/close full-bleed use a **cinematic/photographic** image ("full frame edge-to-edge, NO border, NO margin") and check the corner pixels aren't the bg colour. Use bordered illustrations only **framed** (figure-plates).
5. **Render to PDF:** `node ../teleport/scripts/render-slides.mjs <deck-dir> <out.pdf>`.
6. **Review content + visuals with 3 AIs.** Gemini + Codex (CLI) read the deck HTML for copy/accuracy/no-overclaim/terminology, fixing between rounds. The **subagent must rasterize all slides to PNG and READ the images** for real visual judgement (overflow, cramped/illegible screenshots, dark-slide contrast, alignment) plus a copy pass — this catches what text-only reviewers miss. If a CLI reviewer (Gemini/Codex) is not installed in the env, substitute it with an extra built-in subagent pass and **say so** — never silently drop a reviewer.
7. **Verify every slide** (rasterize + look), then **deliver the PDF**.

## Gotchas (real failures to avoid)
- **Full-bleed image not covering** → source had a built-in border/margin. Regenerate borderless/photographic; verify corner pixels.
- **Demo screenshots illegible** → don't cram 4–5 device shots into one image. Show **2–3 hero screens, large**, captioned.
- **Editing Vietnamese with `perl -e`** silently fails (byte vs char) — use the editor tool for VN strings, or `perl -CSD` with `use utf8`. ASCII edits are fine with perl.
- **No backticks in inline bash messages** — the shell runs them. Single-quote or escape.
- **`magick -format "%[pixel:p{50%,50%}]"`** errors on `%` — use absolute pixel coords.
- **Number formats:** Vietnamese decimal comma (5,2 cm); English decimal point (5.2 cm). Keep consistent per language.
- **Hosting a localized path** (e.g. `/en/`): use a real **301 redirect**, not a 200 rewrite — a rewrite keeps the URL so relative asset paths (`img/...`) resolve under `/en/` and 404. Or use root-absolute asset paths.
- Keep the `.hint`/nav UI out of the printed PDF (`@media print{display:none}`).

---

## Style system — editorial (default)

Default to this "premium editorial" look unless the user gives a brand.

**Typography:** headlines `Fraunces` (serif, opsz 9..144, wght 400–600), tight tracking (-.01em); body/labels `Inter`. Google Fonts: `family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700`. Eyebrow: 13px/600, letter-spacing .22em, uppercase, accent colour, above a 54×2px rule.

**Palette:** forest `#10231a` (dark bg / headlines on light) · green `#2f7d56` (accent/rules) · green-d `#1f5a3c` · sage `#7fa791` (accent on dark) · bg `#faf9f6` (warm cream) · ink `#1a2b22` · muted `#6b7d72` · line `#e4e7e2`. Dark slides: bg forest, text `#eaf2ec`, muted `#bcd2c4`, accent sage/`#9fe0bb`.

**Frame:** `.slide{width:1280px;height:720px;overflow:hidden}` · `.pad{inset:0;padding:74px 90px}`. Footer: brand left, `NN / TT` (tabular-nums) right, hairline top. Print with backgrounds on.

**Layout vocabulary (assign a DIFFERENT one to adjacent slides):**
1. Full-bleed cover — borderless cinematic image + directional dark scrim (text bottom-left). Cover/close.
2. Asymmetric plate — text ~45% one side, large image ~55% bleeding off the other edge.
3. Oversized typographic — one huge serif statement, NO image, lots of negative space (dark).
4. Card trio — 3 equal cards with serif index numbers; NO image.
5. Flow diagram — boxes + thin connectors + dashed optional node; NO image, no emoji icons.
6. Dark split + framed plate — text left, framed figure-plate image ~45% right on dark.
7. Table-as-hero — the comparison table IS the slide; muted "old" vs emphasised "new"; NO image.
8. Device triptych — 2–3 large phone screenshots, varied heights, slight bezel overlap, tallest centre.
9. Staggered timeline — P0/P1/P2 cascading diagonally + a faint full-bleed bg image at ≤12% opacity.
10. Typographic close + seal — big closing line; a small (~18%) image "seal" bottom-right.

**Rhythm:** alternate image-led → text-led → diagram-led → proof-led; large images only when they carry emotion or proof; 2–3 interior slides intentionally image-free.

**Wow, safely:** a dark "insight" card with a big number (e.g. a CO₂e figure) + a static SVG sparkline + a <1s count-up reads premium without hurting legibility. Avoid heavy blur/gradient on light slides and heavy animation (lags on live/projector demos).

## Document → PDF variant (proposals, not slides)
Same Chrome-render pattern but portrait with header/footer + page numbers. For "no header on the cover page", render twice (full header / blank header, same margins) and swap page 1 with ghostscript. (If a project needs this often, add a `render-doc.mjs` to teleport the same way.)
