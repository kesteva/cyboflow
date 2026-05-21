---
id: TASK-701
idea: SPRINT-026-compounder
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - tests/cyboflow-day3-gate.spec.ts
  - main/src/orchestrator/__tests__/cyboflowDayGate.test.ts
  - vitest.config.gate.ts
  - playwright.config.ts
files_readonly:
  - tests/helpers/cyboflowTestHarness.ts
  - tests/fixtures/cyboflow-day3-gate/prune-prompt.md
  - tests/fixtures/cyboflow-day3-gate/sprint-prompt.md
  - main/vitest.config.ts
  - package.json
  - main/src/utils/shellPath.ts
  - .soloflow/active/findings/SPRINT-026-findings.md
acceptance_criteria:
  - criterion: "tests/cyboflow-day3-gate.spec.ts no longer exists (file deleted, not just renamed in place)"
    verification: "test ! -e tests/cyboflow-day3-gate.spec.ts"
  - criterion: "The day-3 gate test exists at main/src/orchestrator/__tests__/cyboflowDayGate.test.ts and imports from vitest"
    verification: "test -e main/src/orchestrator/__tests__/cyboflowDayGate.test.ts AND grep -nE \"from 'vitest'\" main/src/orchestrator/__tests__/cyboflowDayGate.test.ts returns ≥1 match"
  - criterion: "vitest.config.gate.ts include glob targets the relocated file"
    verification: "grep -nE \"cyboflowDayGate.test\" vitest.config.gate.ts returns ≥1 match"
  - criterion: "Playwright no longer attempts to collect the day-3 gate file"
    verification: "pnpm test --list 2>&1 | grep -E 'cyboflow-day3-gate|cyboflowDayGate' returns 0 lines"
  - criterion: "pnpm test exits 0 (Playwright suite collection no longer breaks on vitest import)"
    verification: "pnpm test exits 0"
  - criterion: "pnpm test:gate still works (the relocated test is still runnable as the canonical day-3 gate)"
    verification: "pnpm test:gate exits 0 when claude is in PATH; exits 0 (skip path) when claude is not in PATH"
  - criterion: "Test file's imports of helpers and fixtures are updated to the new relative-path depths"
    verification: "grep -nE \"__dirname.*fixtures|createHarness|findExecutableInPath\" main/src/orchestrator/__tests__/cyboflowDayGate.test.ts returns matches with paths that resolve from the new location"
  - criterion: "pnpm typecheck exits 0"
    verification: "pnpm typecheck exits 0"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "The relocated test file IS the test artifact. The only behavioral requirement is that it still runs as a vitest test under pnpm test:gate, and that Playwright no longer attempts to collect it. The existing test logic (gate semantics, Claude availability guard, beforeAll/afterAll harness setup) must remain functionally identical — only the file path and the relative imports change."
  targets:
    - behavior: "The relocated cyboflowDayGate.test.ts skips cleanly when Claude is not in PATH (existing claudeAvailable guard preserved)"
      test_file: "main/src/orchestrator/__tests__/cyboflowDayGate.test.ts"
      type: integration
    - behavior: "pnpm test (Playwright) exits 0 — does not pick up cyboflowDayGate.test.ts because it lives outside tests/"
      test_file: "playwright.config.ts"
      type: integration
prerequisites: []
---

# B3 — Fix Playwright/vitest spec-file conflict for cyboflow-day3-gate.spec.ts

## Objective

Resolve FIND-SPRINT-026-9. `tests/cyboflow-day3-gate.spec.ts:17` imports from `vitest` but lives in `tests/`, which `playwright.config.ts` collects. Playwright 1.54.1 errors on collection with `Vitest cannot be imported in a CommonJS module`, blocking `pnpm test`. Per the brief, option 2 (relocate to a vitest-collected path) is preferred. Move the file to `main/src/orchestrator/__tests__/cyboflowDayGate.test.ts`, rewire the relative imports, update `vitest.config.gate.ts`, and confirm Playwright no longer picks it up.

## Implementation Steps

1. **Inspect the current relative-import depths in `tests/cyboflow-day3-gate.spec.ts`:**
   - `./helpers/cyboflowTestHarness` → must become `../../../../tests/helpers/cyboflowTestHarness` (helper stays under `tests/`).
   - `../main/src/utils/shellPath` → must become `../../utils/shellPath` (now inside main/src).
   - `path.join(__dirname, 'fixtures/cyboflow-day3-gate/sprint-prompt.md')` → must become `path.join(__dirname, '../../../../tests/fixtures/cyboflow-day3-gate/sprint-prompt.md')` (fixtures stay under `tests/`). Same for the prune prompt.

2. **Create the new file `main/src/orchestrator/__tests__/cyboflowDayGate.test.ts`** with the full content of the old spec, rewriting the three import paths and two `__dirname` joins. Keep all vitest imports, the `claudeAvailable` guard, the 120 000 ms timeout, and the `test.skipIf(!claudeAvailable)` pattern.

3. **Delete the original `tests/cyboflow-day3-gate.spec.ts`.** Do NOT delete `tests/fixtures/cyboflow-day3-gate/` or `tests/helpers/cyboflowTestHarness.ts`.

4. **Update `vitest.config.gate.ts`:**
   - Change `include: ['tests/cyboflow-day3-gate.spec.ts']` → `include: ['main/src/orchestrator/__tests__/cyboflowDayGate.test.ts']`.
   - Keep `root: repoRoot`, `resolve.alias['@'] = main/src`, `testTimeout: 120_000`, `hookTimeout: 30_000`.

5. **Update `playwright.config.ts`:** the relocation alone fixes the Playwright collection error (file is no longer under `tests/`). For defense in depth, add `testIgnore: ['**/__tests__/**']` so any future `.spec.ts` inside a `__tests__/` dir is also skipped.

6. **Validation:**
   - `pnpm test:gate` — exits 0 (skips if Claude is not in PATH, runs end-to-end if it is). Run `pnpm electron:rebuild` first if NODE_MODULE_VERSION errors surface.
   - `pnpm test` (Playwright) — exits 0; specifically, the collection-time vitest-import error must be gone.
   - `pnpm typecheck` — exits 0.

7. **Completeness gate** — re-run the ACs above.

## Acceptance Criteria

See frontmatter.

## Test Strategy

The test file is the artifact. Relocation must preserve full functional behavior — vitest still runs it via `pnpm test:gate`, the Claude-availability guard still skips cleanly when `claude` is absent, and the harness wiring still resolves to `tests/helpers/cyboflowTestHarness.ts`. The Playwright side requires only that the file is no longer present under `tests/`; the explicit `testIgnore: ['**/__tests__/**']` addition is belt-and-suspenders for future drift.

## Hardest Decision

Whether to keep fixtures under `tests/fixtures/` (current path) and link via `__dirname` from the new test location, OR co-locate fixtures next to the test. Keep at `tests/fixtures/` because (a) they are repo-level test scaffolding, (b) co-locating duplicates structure without behavior gain, and (c) `main/vitest.config.ts` `include` is `src/**/*.{test,spec}.…` — putting fixtures inside `src/` risks shipping them via the build pipeline.

## Rejected Alternatives

- **Option 1: `testIgnore: ['**/cyboflow-day3-gate.spec.ts']` in `playwright.config.ts`.** Rejected per brief — leaves a vitest-only file next to Playwright `*.spec.ts` peers, making its status invisible at the directory level.
- **Convert to a Playwright test:** rejected — the gate orchestrates services directly (DB, RunLauncher, ApprovalRouter), does not exercise the renderer; would force significant rewriting for zero behavior gain.

## Lowest Confidence Area

The `__dirname` resolution in TS-compiled output. Vitest with `root: repoRoot` runs the test source directly, so `__dirname` at runtime is `<repo>/main/src/orchestrator/__tests__`. The four `..` segments resolve to `<repo>/tests/fixtures/...`. If resolution fails, switch to an explicit `const REPO_ROOT = path.resolve(__dirname, '../../../..')` + `const FIXTURE_DIR = path.join(REPO_ROOT, 'tests/fixtures/cyboflow-day3-gate');`.
