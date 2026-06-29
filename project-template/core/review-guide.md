# Review Guide — Agent Execution Instructions & Protocol

This document defines the standard procedure for performing and orchestrating reviews of
source code, specs (`specs/`), RFCs (`rfc/`), and project documentation. **All agents
(Claude, Codex, Gemini) MUST follow it verbatim whenever a review is requested or when
spawning an external reviewer.**

## 1. Core Mandate: "Plan-First & Read-Only"

Keep two roles distinct — never conflate them:
- **Reviewer (spawned subagent / external CLI):** PLAN / READ-ONLY. **MUST NOT** modify files. Returns findings only. "Review and fix" in a single invocation is strictly forbidden.
- **Orchestrator (the main running agent):** **may and must** fix after receiving findings — per the mode rules in §1.1.

### 1.1 Two orchestration modes

Whether to auto-fix or wait for confirmation depends on *the context in which the user asked for the review*:

| Context | Mode | Orchestrator behavior |
|---|---|---|
| Review is a **gate in the process** (after implement, spec, or RFC) | **Auto-fix mode** | Fix findings immediately, no asking, log the action. Proceed to the next reviewer (§3). |
| User asked for a **standalone review** ("review this", "review what I just wrote"), not continuing an implementation | **Report-then-confirm mode** | Present findings, propose actions, **wait for user OK** before fixing. |

When the context is unclear, default to **report-then-confirm** and ask the user.

## 2. Review Output Protocol

When asked to "review", produce a list of issues, each with a severity and a concrete remediation. Do **not** do anything else.

> **Format depends on artifact:** this section defines the default (Critical/Major/Minor) for **code** and **spec** reviews. Other artifacts (e.g. RFC debate mode) use a different format — see the overlay. The reviewer **MUST** pick the right format and not mix them.

- **Categorization:** classify each issue Critical / Major / Minor. Give a specific fix proposal for each.
- **No filler:**
  - **DO NOT** summarize source code or explain features.
  - **DO NOT** give compliments or list "good points".
- **Cross-reference specs:**
  - Compare code against the relevant documents in `specs/` (and `guides/`/`rfc/` when applicable).
  - Any code/spec mismatch **must be reported as an issue** — but do **not** assume the spec is the stale side. Analyze: code bug, or outdated spec? Recommend fixing whichever is wrong.
- **Five-pillar framework:** focus exclusively on the five pillars in §5. Bugs, regressions, perf issues, and maintenance risk only.

## 3. Orchestration & Verification

- **Subagent vs external CLI — pick the right route:**
  - User says review **"by a subagent"** (or equivalent) → use the orchestrator's **built-in subagent** (Claude `Agent` tool with `subagent_type: "general-purpose"`, Codex subagent, Gemini "generalist" subagent). Do **not** shell out to an external CLI.
  - User says review **"by <other agent>"** (e.g. "let codex review", "have gemini review"), or just "external review" → use the CLI contract in §4.
  - Default when the user says only "review": spawn the **other** agents externally via §4 (e.g. running as Claude → call codex + gemini), so a second pair of eyes sees the work, plus the built-in subagent where the tier calls for it. Default mode = report-then-confirm (§1.1): run sequentially, **do not fix between reviewers**, aggregate findings, then present once.
  - **Worked example — bare "review X" (standalone):** report-then-confirm. Spawn reviewer A read-only → spawn reviewer B read-only → aggregate into one report → present → wait for OK → **only then** fix. Do NOT auto-fix between A and B.
  - **Worked example — review inside a process gate:** auto-fix mode. Spawn A → fix A's findings immediately → spawn B (sees A's fixes) → fix B's findings → continue.
  - **Fallback when a reviewer CLI fails unexpectedly mid-run** (auth drops / error / sandbox blocks): **MUST** report it clearly ("couldn't call X because <reason>"), then propose one of: (a) run a built-in subagent instead, (b) run 1 reviewer instead of 2, (c) skip review (small task + user agrees). Do **NOT** silently reduce the reviewer count.
- **Sequential only — never parallel:** run one reviewer at a time, always. **MUST NOT** spawn multiple reviewers in parallel, even within one round.
  - **Auto-fix mode (process gate):** after each reviewer reports, **MUST** fix findings before the next reviewer (so the next one sees the fixes).
  - **Report-then-confirm mode (standalone):** run reviewers in order, **no fixing between them**, aggregate, present once, wait for OK.
- **Reviewer is read-only:** never instruct the reviewer to fix. The orchestrator fixes.
- **Verify reviewer AND fixer claims:** on "fixed" / "not a bug" / "already handled":
  - **DO NOT** accept at face value.
  - **MUST** open the specific file + line and verify directly.
  - **Quote** the verified `file:line` and the relevant excerpt in your reply (audit trail).
- **Self-verify before saying "fixed":** re-Read the edited file to confirm the change landed (the Edit tool can no-op silently if `old_string` did not match).
- **Post-review git check:** some CLIs (e.g. `gemini --yolo`) can edit files even when told "report only". After every external reviewer round, run `git status` to confirm no unintended writes.

> [overlay] Default rounds per artifact × tier (how many Gemini/Codex/subagent passes), and CLI-missing substitution rules — see the profile `overlay.md`. The number of rounds is **independent** of the fix mode (§1.1).

## 4. Invoking External Reviewers (CLI Contract)

This section applies **only** when the chosen route is an external CLI reviewer (see §3). For built-in subagent reviews, use the native subagent mechanism and skip this section.

### 4.1 Always invoke the binary directly with read-only flags

Call the `claude` / `codex` / `gemini` binary directly with the read-only / plan flags in §4.3.

**MUST NOT** invoke these write-mode flags during a review — they break the read-only contract and can silently edit files:
- `gemini --yolo` (or `-y`) — auto-approves all tool actions, including edits.
- `codex exec --full-auto` (or `--dangerously-bypass-approvals-and-sandbox`) — workspace-write, auto-approves edits.
- `claude --dangerously-skip-permissions` — bypasses all permission checks.

If such a flag is needed for a *non-review* workflow (e.g. committing fixes after review), do not call it "review" — and `git status` immediately after to confirm what changed.

### 4.2 Prompt delivery: temp file is mandatory

Write the full prompt to a temp file. **Always.** Review prompts are never simple in practice; inline forms (`-p "..."`, `echo`, env vars) eventually hit shell-quoting bugs with embedded `"` / `` ` `` / `$` / `\` / newlines.

- **Default (review in a process flow, orchestrator may edit the repo):** `./tmp/` (gitignored, easy to re-inspect).
- **Strict read-only (user explicitly "MUST NOT edit any file"):** use `$(mktemp …)` outside the repo. Do not create a file in the repo even if `./tmp/` is gitignored.

Always clean up afterward: `rm -f "$PROMPT_FILE"`.

```bash
mkdir -p ./tmp
PROMPT_FILE="./tmp/review_$(date +%s).md"
cat > "$PROMPT_FILE" <<'EOF'
... full prompt ...
EOF
```

Prompt injection differs per CLI (exact commands in §4.3):
- **Claude / Codex:** pipe via STDIN: `cat "$PROMPT_FILE" | <reviewer-command>`.
- **Gemini:** use `-p "$(cat "$PROMPT_FILE")"` — Gemini headless does not inject piped stdin into model context. `"$(cat …)"` runs command substitution once, so backticks/`$` in the file are not re-evaluated — shell-safe.

### 4.3 Standard read-only invocations

| Reviewer | Read-only command |
| :--- | :--- |
| **Claude** | `cat ./tmp/your_file.md \| claude --permission-mode plan -p` |
| **Codex**  | `cat ./tmp/your_file.md \| codex exec --sandbox read-only -` |
| **Gemini** | `gemini --approval-mode=plan -p "$(cat ./tmp/your_file.md)"` |

Notes:
- **Claude `--permission-mode plan`** is the only mode that guarantees no writes for an external Claude review (needs a recent CLI).
- **Codex (`codex exec --sandbox read-only -`):** the trailing `-` makes "read prompt from stdin" explicit. Do **not** use `codex review` unless the scope is genuinely a git diff/branch/commit. Always pipe via STDIN — `codex exec "prompt"` can hang on stdin; if you see `Reading additional input from stdin...`, kill it.
- **Gemini `--approval-mode=plan`** is read-only; no built-in `review` subcommand. Prompt MUST go via `-p` (not stdin). If you ever fall back to `--yolo`, `git status` immediately after — yolo can edit regardless of the prompt. Gemini downgrades plan mode to `default` if the folder is untrusted; trust the folder first or accept the degrade and always `git status`.

## 5. The Five Pillars

Code review focuses exclusively on these five pillars. They are fixed — do not add extra pillars (UX/aesthetics are settled at spec stage).
- **Logic** — correctness; does the code do what the spec says, for all stated cases?
- **Reliability** — error handling, edge cases, failure modes, retries, concurrency, idempotency.
- **Performance** — unnecessary work, hot-path cost, allocations, N+1, re-computation.
- **Maintainability** — clarity, structure, dead code, duplication, naming, future-change risk.
- **Verification** — do tests exist and cover the spec's edge cases? Would they catch a regression?

Every finding **MUST** point to a concrete `file:line`. Any code/spec mismatch is reported as "spec mismatch" for the orchestrator to resolve — a code reviewer does **not** propose re-design (that belongs to RFC/spec review).

> [overlay] Artifact-specific review modes — see the profile `overlay.md`.
> Each profile defines the modes for its artifacts: RFC debate mode (Blockers/Discussion/Nits),
> Spec completeness mode, Code mode (5 pillars + type-specific checks, e.g. secret/whitelist for
> bots, SSR/hydration/a11y/XSS for web), Bug-fix mode (5 pillars + a "Regression Coverage" pillar
> where a missing regression test is Critical), and Docs/framework review.
