# Profile overlay — content (NO code lifecycle)

> For a content / docs / planning workspace (e.g. md). There is **no code** here, so the
> code-oriented stages of `../teleport-docs/guides/process.md` do **not** apply. This overlay re-themes them.

## Lifecycle (replaces process §3–§6)
- The lifecycle is **plan → contract → produce → review**: outline/brief → an agreed **content contract** → produce the piece → content review.
- RFC / Spec / Implement / Test code gates **do not apply**.
- **Keep** from core: Brainstorm (§2), the Plan Gate (§1.5 — see re-themed triggers below), the routing/new-thread rule (§9), and Anti-Patterns (§10).
- **Bug-Fix Flow (§7) / Short Path (§8) re-theme:** a *correction* to a published/agreed piece is the content equivalent of a bug fix — reproduce the issue (what's wrong vs the contract), fix, re-review against the contract. A *tiny tweak* (typo, one-line wording) is the short path: adjust + light review, no new contract.

## Plan Gate triggers (re-theme of process §1.5)
The core's two triggers ("before an RFC", "before implementing a phase") don't exist here. Replace with:
1. **Before agreeing the content contract** — post the brief/outline plan for approval.
2. **Before producing the piece** — confirm the approach for any large/multi-part deliverable.

## "Branch / deploy" (process §1)
- A **publishing / handoff** policy: where the piece lands, who approves it — not git branches.

## "Test gate" (process §5/§6)
- Replaced by a **content-contract checklist**: brief coverage, sources/citations present, tone/format correct. No test commands.

## "Spec schema" → content brief / contract fields (process §4)
Audience · goal · key messages · required sections · length/format · sources · tone · constraints.

## Review rubric (replaces the 5 pillars, review-guide §5)
- **Clarity · Completeness · Feasibility · Consistency · Risk (+ Enforceability)** — instead of Logic / Reliability / Performance / Maintainability / Verification.
- Reviewer is still read-only; orchestration modes (§1.1) and the CLI contract (§4) are unchanged.

## Review rounds per piece (review-guide §3 hook)
- 1 external reviewer + 1 built-in subagent per piece; bump to 2 external for high-stakes/public content. A reviewer CLI missing → 1 subagent (report the substitution).
