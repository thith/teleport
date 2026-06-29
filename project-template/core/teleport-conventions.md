# Teleport conventions (core)

> Folder structure, terminology, and the session-archive rule that **every** teleport
> project follows. Canonical source & rationale: `../teleport-docs/rfc/09-project-structure-and-process.md`.
> The agent-facing operating rules live in `CLAUDE.md` (always loaded); this file is the
> reference it points at.

## Terminology (three distinct layers — do NOT conflate)

- **convo** (`convoId`) — the conversation's identity in code/runtime (assigned by teleport). Used everywhere in the tooling.
- **topic** — the Telegram forum topic (what a human sees and refers to). `convo` ↔ `topic` are two faces of the **same live channel**.
- **session** — the **durable archive** of one work session (`sessions/<…>/`). *"You don't archive a convo; you write a session."*

## Folder structure

```
<project>/
  sessions/<YYYY-MM-DD-slug-cXXXX>/   # per-session archive; cXXXX = short convo hash (collision-safe)
    session.md        # DEFAULT single file: metadata + compact summary + minutes inline
    minutes.md        # split out ONLY for long/output-heavy sessions
    drafts/           # in-progress session outputs — GITIGNORED
  docs/
    <topic>-decisions-log.md   # decision log PER FEATURE, aggregated across many sessions (anti handover-leak)
    project_overview.md        # onboarding map: "what we have" + links (no spec content)
  # CANONICAL outputs (official, used for real) — top-level, created LAZILY on first need:
  templates/  samples/  prompts/  marketing/  pm/  data/  reports/  assets/
  # standard code/doc dirs (per profile):
  rfc/  specs/  src/  tests/  docs/  guides/
  tmp/                 # scratch — gitignored, ephemeral, NOT auto-deleted
```

- **Canonical dirs are lazy** — create one only when you first have something official to put in it. Don't pre-create empty ones. `assets/` = media / miscellaneous files, **not** a dumping ground (criteria/specs live in `docs/`/`specs/`, structured data in `data/`, reports in `reports/`).
- **`decisions-log` lives in `docs/`, not under `sessions/`** — it aggregates decisions for a feature across many sessions; sharding it per session date would defeat its anti-leak purpose.

## Gitignore + secrets (MUST)

- Commit **only `.md` knowledge** (`session.md`, `<topic>-decisions-log.md`, docs). The core `.gitignore` excludes `sessions/**/drafts/`, binary/media, `tmp/`, and `.env*`.
- **Scrub secrets** (tokens, pasted `.env`) **before** writing `session.md`/decisions-log and before any commit. A pre-commit secret scan (e.g. gitleaks) is recommended.

## PRESERVE before close / handover (MUST)

Before winding a topic down or handing it over, run these steps (save is non-blocking; commit is opt-in):

1. **Write knowledge** (always, non-blocking): `sessions/<date-slug-cXXXX>/session.md` (summary + minutes). Scrub secrets first.
2. **Append decisions** made in chat to `docs/<topic>-decisions-log.md` (aggregated; don't create a new file per session).
3. **Audit un-digested output** — *"what did this session produce that is NOT yet in spec/src/rfc?"* Keep the worthwhile ones in the right canonical dir; when torn between two, pick one and prioritize **not losing it**.
4. **Promote official output** (official + approved) → **MOVE** to its canonical dir and leave a provenance stub (relative link + one line of what/when) in the session.
5. **Commit — opt-in, non-blocking:** if the user is active, list what/where/message, confirm, then commit (sensitive — admin/maintainer). If the user has gone silent, **still save to disk (steps 1–4); do not block on commit.** Never `push` unless asked.

> A silent user must never cause knowledge loss — step 1 always writes to disk, and `tmp/` is not auto-deleted, so an abrupt close still leaves drafts to recover.
