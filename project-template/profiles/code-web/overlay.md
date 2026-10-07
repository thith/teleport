# Profile overlay — code-web

> Fills the core `> [overlay]` hooks for a production web app (e.g. Next.js/SSR,
> like a typical web-app frontend).

## Branch / deploy policy (process §1)
- **Production repo — no direct push.** `feat|fix|chore|refactor/*` → PR to `develop` → auto-deploy **staging** → verify on staging → PR `develop`→`main` → auto-deploy **prod** → smoke-check the prod URL.

## Test gate / verification (process §5, §6)
- **4 local checks**, run once after the final edit and as the gate before opening a PR: `type-check` · `lint` · `test:run` · `build`.

## Smoke-test target (process §6)
- The route/feature on a `dev`/preview build (loading / empty / error + happy path), then on **staging**, then a prod check after deploy.

## Spec schema (process §4)
Route/URL + params + SSR-vs-client + auth-gated · API contract (endpoint / method / request-response / error shape / auth) · data-fetching keys + invalidation + state atoms · UI states (loading / empty / error / success) · validation schema · i18n keys + analytics events · edge cases.

## Review modes (review-guide §5)
- **Code mode = 5 pillars + web checks:** re-render/perf, SSR/hydration, a11y, XSS, **no secrets in the client bundle**.
- Tiering adds a middle **spec-only** tier: ≥2 modules but no multi-phase/debate → spec + implement, no RFC.
- RFC debate mode · Spec completeness mode · Bug-fix mode (5 pillars + Regression Coverage).

## Review rounds
- Same default cadence as code-bot; escalate any auth/security-touching change to the higher tier.
