---
id: TASK-701
sprint: SPRINT-030
epic: testing-infrastructure
status: done
summary: "Relocate day-3 gate test from tests/ to main/src/orchestrator/__tests__/; exclude from main vitest unit channel; add Playwright testIgnore"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-701 — Done

Resolved FIND-SPRINT-026-9. The day-3 gate test imported from `vitest` but lived under `tests/`, so Playwright 1.54.1 errored on collection with `Vitest cannot be imported in a CommonJS module`, blocking `pnpm test`.

Moved `tests/cyboflow-day3-gate.spec.ts` → `main/src/orchestrator/__tests__/cyboflowDayGate.test.ts` with import paths and `__dirname` fixture joins rewritten for the new depth. Fixtures and harness remain under `tests/`. Updated `vitest.config.gate.ts` include glob. Added `testIgnore: ['**/__tests__/**']` to `playwright.config.ts` for defense in depth.

Code-review round 1 surfaced a follow-on issue: the new file location is matched by `main/vitest.config.ts`'s `include` glob, so `pnpm --filter main test` (lead step of `pnpm test:unit`) would silently collect this 120-second integration gate alongside the in-memory unit tests, loading it under the wrong setup file. Added an explicit `exclude: ['**/node_modules/**', '**/dist/**', 'src/orchestrator/__tests__/cyboflowDayGate.test.ts']` to `main/vitest.config.ts`. `pnpm --filter main test --list | grep cyboflowDayGate` returns 0 lines; gate config still picks it up.

Tests: typecheck 0, Playwright `--list` 0 matches for the moved name, `pnpm test:gate` exits 0 on retry (first run flaked on a pre-existing same-millisecond timing assertion preserved verbatim from the original spec).

Follow-up: FIND-SPRINT-030-3 captures the pre-existing same-millisecond flake at `cyboflowDayGate.test.ts:124` (`toBeGreaterThan` → `toBeGreaterThanOrEqual`).
