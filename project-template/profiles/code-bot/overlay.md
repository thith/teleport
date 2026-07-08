# Profile overlay — code-bot

> Fills the `> [overlay]` hooks in `../teleport-docs/guides/process.md` / `review-guide.md` for a
> Telegram/CLI bot (single-maintainer experimental service, e.g. luni).

## Branch / deploy policy (process §1)
- Commit directly to `main` (small single-maintainer repo); no PR / staging gate.
- Deploy is a manual/scripted push to the bot host after Pre-Close.

## Test gate / verification (process §5, §6)
- Run the project test runner (e.g. `npm test`). Targeted tests while iterating; **full suite once** before close.

## Smoke-test target (process §6)
- Manual smoke test against a **real sandbox bot / test chat** (e.g. Telegram) for every user-visible command.

## Spec schema (process §4)
A complete spec defines: command list (`/cmd <args>` + per-case behavior) · input validation (max length / regex / type) · exact user-facing message + error text · config / env vars · persistence schema · edge cases.

## Review modes (review-guide §5)
- **Code mode = 5 pillars + bot checks:** admin commands check the whitelist; **no secret/token leak** into logs or error replies; retry-safe on redelivered updates; rate limits on broadcast/loops.
- **RFC debate mode** (Blockers / Discussion / Nits) · **Spec completeness mode** · **Bug-fix mode** (5 pillars + Regression Coverage — a missing regression test is Critical).

## Review rounds per artifact × tier
- RFC / Spec: `Gemini×1 + Codex×1 + subagent×1` (medium).
- Code: `Gemini×2 + subagent×2 + Codex×1`.
- Bug-fix: `Gemini×1 + subagent×1 + Codex×1`.
- A reviewer CLI missing → collapse to `subagent×1` (and report the substitution).
