# Claude Code Project Rules — <PROJECT>

> Strength markers: **MUST**, **MUST NOT**, **SHOULD**.
> `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` are kept in sync — same body, different heading. Edit all three together.

## Project Context

<One paragraph: what this project is, how it runs, who uses it. Applies to every agent (Claude / Codex / Gemini).>

This project follows the teleport conventions and the **core process** with the **<profile>** overlay
(`code-bot` / `code-web` / `monorepo` / `content`).

## Core Mandates

- **Follow the Process (MUST):** every feature goes through `../teleport-docs/guides/process.md` (Brainstorm → RFC → Spec → Implement → Test), with a review at each gate. Don't skip a step until its gate passes. This project's profile **`overlay.md`** (sitting next to these files) supplies branch/deploy policy, the test gate, and the spec schema.
- **Always Test (MUST):** every code change ships with a test (new or updated). Run the verification gate from `overlay.md` before "close".
- **Review Protocol (MUST):** review per `../teleport-docs/guides/review-guide.md` (core) + the artifact-specific modes in `overlay.md`.
- **PRESERVE before close/handover (MUST):** before winding a topic down or handing off, run the PRESERVE steps in `teleport-conventions.md` — write `sessions/<date-slug-cXXXX>/session.md`, append `docs/<topic>-decisions-log.md`, promote official output to its canonical dir. Save is non-blocking; commit is opt-in; **never push unless asked**. A silent user must not cause knowledge loss.
- **Scrub secrets (MUST):** never write or commit tokens / `.env` content (e.g. pasted into chat) into `session.md`, decisions-log, or anywhere in the repo.

## Folder conventions (discovery — full detail in `teleport-conventions.md`)

- **Session archive:** `sessions/<YYYY-MM-DD-slug-cXXXX>/session.md` (one file by default).
- **Decisions log:** `docs/<topic>-decisions-log.md` (per feature, aggregated across sessions).
- **Canonical output dirs (create lazily, only when first needed):**
  `templates/` · `samples/` · `prompts/` · `marketing/` · `pm/` · `data/` · `reports/` · `assets/`.
  `assets/` is media/misc — **not** a dumping ground; criteria/specs go in `docs/`/`specs/`, structured data in `data/`, reports in `reports/`.
- **`tmp/`** is scratch (gitignored, not auto-deleted) — never a final home.

## Sibling projects

Other repos live as siblings under the workspace parent. **Read-only for reference / reuse — do not edit or cross-commit.** teleport tooling + this template live in `../teleport` (+ `../teleport-docs` for RFCs).
