# project-template — layered scaffold for new teleport projects

> **Note:** this template assumes a sibling **`teleport-docs/`** folder holding your shared
> `guides/process.md` and `guides/review-guide.md` (and design notes it links to). That repo is the
> maintainer's own and is **not published** — create your own `../teleport-docs/guides/` with your
> team's process and review guides, or edit the paths in the scaffolded `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`.

A new project is **core + one profile**, not a fixed tree (project shapes differ too much —
bot vs web vs monorepo vs content). See `../../teleport-docs/rfc/09-project-structure-and-process.md`.

## Layout

```
project-template/
  core/                 # COPIED into every new project
    CLAUDE.md AGENTS.md GEMINI.md   # synced agent rules; point at ../teleport-docs/guides/{process,review-guide}.md
    teleport-conventions.md         # folder structure + terminology + PRESERVE rule
    README.md  .gitignore  sessions/
  profiles/             # pick ONE; its overlay fills the core's [overlay] hooks
    code-bot/   code-web/   monorepo/   content/
```

**Not copied — shared instead:** `process.md` and `review-guide.md` used to live in `core/` (one
copy per scaffolded project, prone to drift). They now live once at
[`teleport-docs/guides/process.md`](../../teleport-docs/guides/process.md) and
[`teleport-docs/guides/review-guide.md`](../../teleport-docs/guides/review-guide.md) — every
project (this template's `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` included) references them as
`../teleport-docs/guides/{process,review-guide}.md`, relative to the *project root* (one level up
from this file, which sits two levels under `Projects/`) — instead of keeping a local copy.

## How to scaffold

**Recommended — one command** (`scripts/scaffold.mjs`, hand-run; the daemon-driven `/setup` is deferred, see RFC 08):

```bash
node ../teleport/scripts/scaffold.mjs <project> --type <code-bot|code-web|monorepo|content>
#   [--dry-run]  preview the file list, write nothing
#   [--no-git]   skip git init + first commit
#   [--into <dir>]  scaffold somewhere other than ../<project>
```

It creates `../<project>/`, copies `core/` + the profile's `overlay.md`, substitutes the
template placeholders (`<PROJECT>`, `<profile>`, …), and does `git init` + the first commit.
Then fill `<one-line description>`, the `CLAUDE.md` project context, and `docs/project_overview.md`.

**Manual equivalent** (if you'd rather):
1. `cp -r project-template/core/. <workspace>/<project>/` then `git init`.
2. `cp project-template/profiles/<type>/overlay.md <project>/overlay.md` (core docs reference it by name).
3. Replace `<PROJECT>` / `<profile>` placeholders in `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`README.md`/`docs/project_overview.md`.

Canonical output dirs (`templates/ samples/ prompts/ marketing/ pm/ data/ reports/ assets/`) are
created **lazily** — only when first needed.

## Core vs overlay

The **core** process/review is type-neutral and marks three things as `> [overlay]` hooks —
**branch/deploy policy**, **test gate**, **spec schema** — plus artifact-specific review modes.
Each **profile** supplies those. This keeps the shared backbone in one place while letting a web
project require `PR→staging→prod` and a bot project commit to main.
