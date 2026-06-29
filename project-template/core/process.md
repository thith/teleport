# Feature Process — Lifecycle for New Work

> This document is the single source of truth for the lifecycle of every feature in
> this project. When the user asks to "add feature X" / "make Y do Z" / "build W",
> the agent **MUST** follow this file.

## 0. Purpose

Avoid two recurring failure modes:
- **Implement-first:** code first, discover a missing use case or edge state later, rework from scratch.
- **Spec-rotting:** the spec says one thing, the code does another; months later nobody knows which is correct.

This process forces thinking before coding, forces code to match the spec, and places a
**review gate** at every stage transition to catch problems early — a fix at RFC stage is
~100× cheaper than a fix in shipped code.

> **Project deviations:** project-specific process/review tweaks live in the project's
> own docs (`CLAUDE.md`, `docs/<topic>-decisions-log.md`). Entries there
> **override the defaults** in this file, but **MUST NOT** break a safety MUST. The agent
> **MUST** read those conventions during onboarding.

## 1. Lifecycle Overview

```
  Brainstorm  →  RFC  →  Spec  →  Implement  →  Test  →  Close
      ▲          ▲        ▲          ▲           ▲
    debate    RFC rev  spec rev   code rev    QA rev
```

Each arrow is a **gate**. If a gate does not pass, you **MUST NOT** advance to the next step.

> [overlay] Branch/deploy policy after Test — see the profile `overlay.md`.

## 1.5 Plan Gate (mode-agnostic, MUST)

Before **two** moments the agent **MUST** post a **short plan** for the user to approve before continuing:
1. **Before writing an RFC** (entering §3) — plan the RFC approach: what to investigate/decide, which modules are touched, which open questions must be settled.
2. **Before implementing each phase** (P0/P1/… in §5) — plan the concrete coding steps of that phase.

**Why "mode-agnostic":** some agents (e.g. Claude) have a dedicated "plan mode" UI; others (Codex/Gemini) do not. This rule encodes the plan as a **mandatory process step** independent of any agent UI — every agent does it.

**A plan contains (minimum):**
- **Goal** of the step/phase (1–2 sentences).
- **Files to be touched** (concrete paths, including new files).
- **Order of steps.**
- **Tests to add/change** (which test file, which cases).
- **Risks / unknowns** the user should be aware of.

**Form — ephemeral, do NOT create a new file:** the plan lives as a **message to the user** plus (for agents with a todo tool) a todo list. Do **NOT** spawn a persistent `plan.md` — phase rollout is tracked in the RFC, history is in git. For a complex phase, a short `## Plan` section inside the relevant RFC is optional, not required.

**Gate — Plan Review:**
- **Pass:** user says "ok" / "go ahead" / equivalent.
- **Fail:** user adjusts scope → revise the plan, repost.
- **MUST NOT** start writing an RFC or coding a phase while the plan is unapproved. (Override: §9 — the user may waive planning; state the risk once, then comply and log a note.)

## 2. Step 1 — Brainstorm & Debate

**When:** the moment the user floats a feature idea, before opening any `rfc/` file.

**Goal:** understand the *problem*, not the *solution*. Find at least 2 alternatives.

**Output:** a message/thread (no file yet) answering:
1. **Problem statement** — the concrete user pain ("user struggles with Y, currently works around it via Z", not "user wants X").
2. **Goals** — 2–4 bullets.
3. **Non-goals** — 2–4 bullets to lock scope.
4. **Alternatives considered** — at least 2 genuinely different approaches with tradeoffs. **Short-path exception (§8):** replace with one sentence on why no alternative is worth weighing — do not invent a fake alternative to tick a box.
5. **Recommended approach** — pick one, give the reason.

**Gate — Brainstorm Review:**
- User confirms the problem statement is right (not paraphrased off-target).
- There are ≥ 2 truly distinct alternatives ("X" vs "X but renamed" does not count).
- The recommended approach does not violate the agent rule file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` — identical content; read the running agent's file).
- **Pass:** user says "ok, write the RFC" or equivalent.
- **Fail:** return to brainstorm with feedback.

## 3. Step 2 — RFC

**When:** after the Brainstorm gate passes. Required for multi-phase features, features with real design debate, or features touching ≥ 2 modules.

**Action:**
0. **Plan Gate (§1.5):** post the RFC-approach plan for approval **before** opening the RFC file.
1. Copy `rfc/_template.md` → `rfc/NN-kebab-case-title.md` (NN increments).
2. Fill the skeleton; mirror existing RFCs for a consistent voice.
3. **Absolutely no coding** in this step.

**Scope check (MUST):** if a feature carries several loosely-related concerns (Goals from different domains, or parts that can ship/run **independently**), the agent **MUST** propose splitting it into multiple RFCs — one concern each — rather than one giant RFC. State how to split and **wait for the user to decide** before continuing.

**Output:** `rfc/NN-*.md` complete (every template section filled, no `TODO`/`TBD`). When an RFC adds or changes a feature/phase, update the corresponding line in the project overview doc.

**Gate — RFC Review** (format: review-guide §3 / debate mode):
- Spawn an external reviewer per `review-guide.md` (routing there is the single source of truth — do not duplicate it here).
- Reviewer checks: does the design cover all Goals? Any open question left dangling? Are phase dependencies (P0/P1/…) clear? Any conflict with an existing RFC/spec?
- Orchestrator fixes findings → user approves → **Pass:** "ok, go to spec".
- **Fail:** revise the RFC, or return to brainstorm if a design dead-end appears.

## 4. Step 3 — Spec

**When:** after the RFC gate passes, or directly after Brainstorm for a small feature (§8).

**Action:**
1. Copy `specs/_template.md` → `specs/NN-kebab-case-title.md`.
2. The spec MUST be **detailed enough to implement without further questions.**

   > [overlay] Spec schema/fields (what a complete spec must contain) — see the profile `overlay.md`.

3. Link to the RFC if any: `Ref: [RFC NN](../rfc/NN-*.md)`.

**Output:** `specs/NN-*.md` complete. When a spec adds or changes behavior, update the corresponding line in the project overview doc.

**Gate — Spec Review** (format: review-guide §3 / completeness mode):
- Spawn an external reviewer (as §3).
- Reviewer checks: is every behavior **testable** ("given X, when Y, then Z")? Are edge cases covered (empty input, max length, retry, concurrent, …)? Are user-facing messages/text decided? Any conflict with another spec?
- Orchestrator fixes → user approves → **Pass:** "ok, implement".
- **Fail:** revise the spec; if a design issue surfaces, return to the RFC.

## 5. Step 4 — Implement

**When:** after the Spec gate passes. (**Scaffold exception:** for the scaffold path in §8, RFC-pass replaces spec-pass as the entry condition — there is no spec for scaffold infra.)

**Action:**
0. **Plan Gate (§1.5):** for each phase (P0/P1/…), post the phase's coding-step plan for approval **before** coding it. A single-phase feature still plans once.
1. Re-read the spec right before coding (do not rely on memory from when you wrote it).
2. Code to the spec; do not silently "improve" or "simplify". If the spec is wrong/incomplete mid-code → **stop**, update the spec first (per Conflict Handling in the agent rule file), then resume.
   - **Large spec edit** (changed behavior, added/removed edge case, changed message text): MUST re-spawn the Spec Review gate (§4) on the updated spec before continuing.
   - **Small spec edit** (typo, wording clarification with no semantic change): note it in the spec's Changelog and continue; no re-review.
3. Write tests **alongside** code (every function/command has a matching test).
4. Run targeted tests at each step; do **NOT** run the full suite after every edit.

   > [overlay] Test gate / verification commands — see the profile `overlay.md`.

**Output:** complete diff, all targeted tests pass.

**Gate — Code Review** (format: review-guide §3, Critical/Major/Minor + 5 pillars):
- Spawn an external reviewer (as §3). Apply the 5 pillars in `review-guide.md`.
- Reviewer also checks: does the code match the spec (cross-reference `file:line` ↔ spec section)? Do tests cover the spec's edge cases?

  > [overlay] Artifact-specific review checks (e.g. secret/whitelist, SSR/a11y/XSS) — see `review-guide.md` overlay (filled by the profile `overlay.md`).

- Orchestrator fixes → re-run targeted tests → **Pass:** reviewer has no remaining Critical/Major.
- **Fail (Critical):** fix immediately; if the fix changes behavior, update the spec.

## 6. Step 5 — Test (Pre-Close)

**When:** after Code Review passes.

**Action:**
1. Run the **full verification once** after the final code edit.

   > [overlay] Test gate / verification commands — see the profile `overlay.md`.

2. If it fails → fix → re-run only **targeted** checks for the fix; run the full verification once more right before close.
3. **Manual smoke test** of the user-visible behavior in a realistic environment.

   > [overlay] Smoke-test target/environment — see the profile `overlay.md`.

**Gate — QA Review:**
- The pre-completion checklist in the agent rule file answers "yes" to every applicable item.
- For admin/destructive features: manually verify the "unauthorized caller is rejected" scenario.
- **Pass:** every checkbox ✓, full verification green.

## 7. Bug-Fix Flow (its own lifecycle, not a feature)

A bug fix has its own lifecycle — no RFC, but still gated.

```
Reproduce → Root Cause → Fix + Regression Test → Code Review → Pre-Close Test → Close
```

**1. Reproduce (MUST):** minimal steps to trigger the bug (concrete input, command, state). If you cannot reproduce → **stop**, ask the user for more info. Do not guess a fix.

**2. Root Cause:** identify the `file:line`. Classify: (a) **code bug** (code violates spec) → fix code; (b) **spec bug** (code follows a wrong/incomplete spec) → update the spec FIRST, then decide on the code; (c) **missing spec** (behavior was never defined) → this is actually a *feature* → return to §2 (Brainstorm).

**3. Fix + Regression Test:** surgical edit. **MUST** add a test that reproduces the bug (fails before the fix, passes after). No regression test ⇒ no close.

**4. Code Review:** same protocol as §5. The reviewer also checks that the regression test genuinely covers the bug (it must fail if the fix is reverted).

**5. Pre-Close Test:** same rule as §6 (full verification once + manual smoke test of the original bug scenario for user-visible bugs).

**Bug-fix anti-patterns:**
- ❌ Fixing without reproducing ("probably this line").
- ❌ Fixing without a regression test ("the old tests pass anyway").
- ❌ Changing the spec to match the code without discussing with the user — that is "code wins over spec" silently, a Conflict Handling violation.

## 8. Short Path for Small Features

Some small features genuinely do not need an RFC. Short-path criteria:
- Touches ≤ 1 module/file.
- No tradeoff debate (only one sensible approach).
- No new config / persistence / external dependency.
- Not an admin/destructive operation.

Qualifying examples: add an emoji to a reply, fix a typo in a help message, change the default value of an already-specced option.

**Short path:**
```
Brainstorm (1 paragraph) → Spec (update existing spec, no new file) → Implement + Test → Close
```

Spec updates in the short path follow the size rule in §5 step 2 (small → Changelog; large → re-spawn Spec Review). If you keep hitting large edits, the feature does not qualify — return to the long path.

**Scaffold step (infrastructure, not a feature):** creating the project skeleton, test runner, lint/build config, etc. is **infra scaffold**, not a feature — it does not get a spec from `specs/_template.md`. Instead create `rfc/NN-project-scaffold.md` describing the chosen stack/layout/config and pass it through RFC Review. The first file in `specs/` is the **first feature**. **The code review gate still applies** to scaffold — do not skip it.

**When unsure whether something is short-path → take the long path.** Time spent writing an RFC is cheaper than ripping out wrong-design code.

## 9. The Agent's Duty to Route the User into the Process (CRITICAL)

Users often float features **off the cuff** — "hey add this command", "make it also do Y for fun", "just code this part real quick". This is a **trigger to activate the process**, not a cue to comply blindly.

**Recognizing "off-the-cuff feature":**
- A sentence meaning "add/make/also have X" that has not been brainstormed.
- A pivot mid-discussion: "while we're at it, also do Y".
- "It's simple, just code it" / "no spec needed" / "RFC is a waste of time".

**Correct agent response (template — use the user's language):**
> *"This looks like a new feature. Per `process.md` we should start at Brainstorm before coding, to lock the problem statement + alternatives. OK if I open brainstorm for this?"*

Specifically:
1. **MUST** point out you are at Step 0 (not in the process yet) and propose the next step.
2. **MUST NOT** jump straight to implementation just because the user "seems" to want speed.
3. **MUST** check the §8 short-path criteria *before* agreeing to a shortcut; if it does not qualify, explain why and propose the long path.

**When the user pushes back ("just skip the process"):** the user may override, but the agent **MUST** state the consequences at least once before complying:
> *"If we skip RFC/spec: (a) edge case Z won't be thought through up front, (b) there'll be no doc for future debugging/handoff, (c) tests are hard to write when behavior isn't stated. Still want to skip?"*

If the user reaffirms → comply, but **MUST** log a note in the commit/PR: "Process bypassed per user request — no RFC/spec". **MUST NOT** silently skip without warning.

**No retroactive specs:** do not propose "code first, write the spec later". A retroactive spec only re-describes the code and misses the edge cases the code skipped. If asked, counter-propose: stop coding, write a mini spec, then continue.

**New feature inside an old conversation → propose a new thread (CRITICAL).** When the user raises a new feature (directly or by drifting off the current topic) inside a conversation busy with other work, the agent **MUST**:
1. **Point out the topic mixing:** "We're in the convo for feature X; Y is a new feature — it shouldn't be folded in here."
2. **Propose opening a new thread/conversation** for Y so context stays clean and §2–§6 can run from Brainstorm. If Y is not urgent, **PARK** it as a one-line `idea` in the backlog doc instead of opening a thread now.
3. **Ask whether the user wants a kickoff prompt** for the new thread, including: a 1–2 sentence summary of Y; links to the agent rule file and `process.md`; a reminder to start at Brainstorm; any context from the current convo the new thread must carry (e.g. Y must stay compatible with decision X just made here).

**When a new thread is NOT needed:** Y is a **small tweak directly tied** to feature X (a log line for an edge case just coded, the error text of the command just implemented, a typo found during review). Criterion: Y cannot stand alone — if you detach Y from X it becomes meaningless. When unsure → propose a new thread (safe default).

**MUST NOT** silently keep discussing Y inside convo X just because the user raised it "while we're at it". Silence = complicity in topic mixing. On push back, apply the override pattern above (state the risk once, await reaffirm, comply, log "Mixed-topic per user request").

## 10. Anti-Patterns (MUST NOT)

- ❌ Start coding before the Spec Review gate passes.
- ❌ "I'll write the spec after coding to match." — the spec drives the code, not the reverse.
- ❌ Spawn reviewers in parallel at one gate (see `review-guide.md` — sequential only).
- ❌ Fix a review finding then report "done" without re-Reading the file to verify the edit landed.
- ❌ "Small feature, skip the RFC" without checking the §8 criteria.
- ❌ Use the same agent (yourself) as both reviewer and implementer at every gate — always prefer a different agent for review (a second pair of eyes).

## 11. Summary — what each step answers

| Step | Core question | Output | Gate fail ⇒ |
|---|---|---|---|
| Brainstorm | "What's the real problem? Any other way?" | Message thread | Back to brainstorm |
| RFC | "What's the overall design? Which phase first?" | `rfc/NN-*.md` | Revise RFC or back to brainstorm |
| Spec | "Exactly what to implement? Which edge cases?" | `specs/NN-*.md` | Revise spec or back to RFC |
| Implement | "Does code match spec? Do tests cover it?" | Diff + tests | Fix code/spec |
| Test | "Does it actually work?" | Full verification green + smoke test | Fix → targeted re-run → full verification once before close |
