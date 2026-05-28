---
epic: testing-infrastructure
created: 2026-05-12T00:00:00Z
status: complete
originating_ideas: [SPRINT-002-compound]
---

# Testing Infrastructure

## Objective

Wire the existing-but-orphaned unit-test suites (frontend vitest spec, build/scripts node-asserts) into the project's CI commands so a single `pnpm test:unit` runs every tier. SPRINT-002 inadvertently created three disconnected test runtimes — vitest in `main/`, an orphaned vitest spec in `frontend/`, and hand-rolled node tests in `build/`+`scripts/`. None of these run under `pnpm test` (Playwright only). This epic closes that gap so that silent regressions in shared utilities (the localStorage migrator, the signing-posture toggle) are caught by the standard test command.

## Scope

- In scope:
  - Add vitest devDeps + config to the `frontend/` workspace and wire `pnpm --filter frontend test`
  - Add a root-level `pnpm test:unit` script that runs main vitest, frontend vitest, and the build/scripts node tests in sequence
  - Add a root-level `pnpm test:build` script invoking the existing node-asserts in `build/afterSign.test.js` and `scripts/configure-build.test.js`
- Out of scope:
  - Porting `build/afterSign.test.js` or `scripts/configure-build.test.js` to vitest (optional follow-up; current node-asserts are functional)
  - Adding CI workflow YAML (`.github/workflows/*.yml`) — current project has no CI workflow file in repo; CI wiring is a separate concern
  - Writing new test cases beyond what already exists (those belong to their owning epics)
  - Migrating Playwright tests under `pnpm test` to anything else

## Success Signal

After this epic lands:
- `pnpm --filter frontend test` runs the 4 cases in `migrateLocalStorageKey.test.ts` and exits 0
- `pnpm test:unit` from the repo root runs (a) main vitest, (b) frontend vitest, (c) build node-asserts, (d) scripts node-asserts — in that order — and exits 0 only if all four pass
- `pnpm test:build` runs the two node-assert files standalone and exits 0
- A developer can answer "are my unit tests green?" with a single command
