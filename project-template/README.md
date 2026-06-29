# project-template — layered scaffold for new teleport projects

A new project is **core + one profile**, not a fixed tree (project shapes differ too much —
bot vs web vs monorepo vs content). See `../../teleport-docs/rfc/09-project-structure-and-process.md`.

## Layout

```
project-template/
  core/                 # COPIED into every new project
    CLAUDE.md AGENTS.md GEMINI.md   # synced agent rules; point at core process/review
    process.md  review-guide.md     # type-neutral CORE workflow (English)
    teleport-conventions.md         # folder structure + terminology + PRESERVE rule
    README.md  .gitignore  sessions/
  profiles/             # pick ONE; its overlay fills the core's [overlay] hooks
    code-bot/   code-web/   monorepo/   content/
```

## How to scaffold (manual for now — `/setup --init` later, see RFC 08)

1. `cp -r project-template/core/. <workspace>/<project>/` then `git init`.
2. Copy the chosen profile's `overlay.md` into the project root next to `process.md`
   (`cp project-template/profiles/<type>/overlay.md <project>/overlay.md`). The core docs and
   `CLAUDE.md` reference it by name — it supplies branch/deploy policy, test gate, spec schema,
   and artifact-specific review modes for that project type.
3. Fill the stubs: `CLAUDE.md` project context, `docs/project_overview.md`.
4. Canonical output dirs (`templates/ samples/ prompts/ marketing/ pm/ data/ reports/ assets/`)
   are created **lazily** — only when first needed.

## Core vs overlay

The **core** process/review is type-neutral and marks three things as `> [overlay]` hooks —
**branch/deploy policy**, **test gate**, **spec schema** — plus artifact-specific review modes.
Each **profile** supplies those. This keeps the shared backbone in one place while letting a web
project require `PR→staging→prod` and a bot project commit to main.
