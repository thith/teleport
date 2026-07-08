# Spec NN — <title>

- **Status:** Draft
- **Ref:** [RFC NN](../rfc/NN-*.md) <or "— (short-path, no RFC)">
- **Changelog:** <date — what changed> (append small edits here per `../../teleport-docs/guides/process.md` §5)

---

## 1. Summary

<One paragraph: what this feature does, from the user's point of view.>

## 2. Behavior

<The detailed, testable behavior. Each rule as "given X, when Y, then Z" so it maps to a test.>

> The exact fields a complete spec must define are **profile-specific** — see the project's
> profile `overlay.md` ("Spec schema"). Examples: a bot spec lists commands/args/validation/
> messages; a web spec lists route/API-contract/SSR/UI-states/i18n; a monorepo spec adds
> package(s) touched + cross-package contracts.

## 3. Edge cases

- Empty / missing input → <…>
- Max length / out of range → <…>
- Retry / concurrent / idempotency → <…>
- Unauthorized caller (if admin/destructive) → <…>

## 4. User-facing text

<Exact messages / errors / labels, decided here (not improvised in code).>

## 5. Tests

<Which test file, which cases — at least one per behavior rule and per edge case above.>
