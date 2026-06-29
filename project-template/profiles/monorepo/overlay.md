# Profile overlay — monorepo

> Fills the core `> [overlay]` hooks for a multi-package monorepo (client / server /
> packages, e.g. tea_game).

## Branch / deploy policy (process §1)
- Per-package branch/deploy policy behind a PR gate. State **which packages auto-deploy where**, and coordinate cross-package version/release bumps.

## Test gate / verification (process §5, §6)
- **Workspace-aware:** run affected-package checks (e.g. `turbo run test --filter=...[origin/main]`) plus a root build. Define the affected-graph command for this repo.

## Smoke-test target (process §6)
- Smoke the affected package(s) in their own run target; for shared/core changes, smoke at least one consuming package.

## Spec schema (process §4)
Code-spec fields (per the code base) **plus**: a `package(s) touched` field · cross-package API/contract boundaries · shared-type impact · which package **owns** the change.

## Review modes (review-guide §5)
- **Code mode = 5 pillars + cross-package checks:** public API/contract changes, version bumps, **no circular deps**, shared-type ripple.
- **Auto-escalate** any change to a shared/core package to the "large" review tier.
- RFC debate mode · Spec completeness mode · Bug-fix mode (5 pillars + Regression Coverage).

## Review rounds
- Larger blast-radius → at least one extra Code round vs single-package; shared/core change → highest tier.
