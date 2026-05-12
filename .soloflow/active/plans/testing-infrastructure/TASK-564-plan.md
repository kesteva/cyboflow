---
id: TASK-564
idea: SPRINT-002-compound
status: ready
created: 2026-05-12T00:00:00Z
files_owned:
  - package.json
files_readonly:
  - frontend/package.json
  - main/package.json
  - build/afterSign.test.js
  - scripts/configure-build.test.js
acceptance_criteria:
  - criterion: "Root package.json has a `test:build` script that runs both node-asserts in sequence with an && so a failure short-circuits"
    verification: "node -e 'const p = require(\"./package.json\"); const t = p.scripts[\"test:build\"]; if (!t || !t.includes(\"build/afterSign.test.js\") || !t.includes(\"scripts/configure-build.test.js\")) process.exit(1);' exits with status 0"
  - criterion: "Root package.json has a `test:unit` script that runs main vitest, frontend vitest, AND test:build in sequence"
    verification: "node -e 'const p = require(\"./package.json\"); const t = p.scripts[\"test:unit\"]; if (!t || !t.includes(\"--filter main test\") || !t.includes(\"--filter frontend test\") || !t.includes(\"test:build\")) process.exit(1);' exits with status 0"
  - criterion: "pnpm run test:build exits 0 (both node-asserts pass on a clean tree)"
    verification: "pnpm run test:build exits with status 0"
  - criterion: "pnpm run test:unit exits 0 (all four tiers pass)"
    verification: "pnpm run test:unit exits with status 0"
  - criterion: "The existing `test` script (Playwright) is unchanged"
    verification: "node -e 'const p = require(\"./package.json\"); if (p.scripts.test !== \"playwright test\") process.exit(1);' exits with status 0"
depends_on: [TASK-563]
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "Pure script wiring in package.json. The verification IS the test (running pnpm test:unit and checking exit code). No new test logic is introduced. Sibling-test scan: the root has no `.test.*` files of its own, and the workspace-level tests are owned by their respective workspaces."
prerequisites:
  - check: "test -f build/afterSign.test.js && test -f scripts/configure-build.test.js"
    fix: "Both node-assert files must exist. They were created in TASK-053/TASK-054 (SPRINT-002). If missing, restore from git history."
    description: "Confirms the orphaned node-assert files this task wires up are present."
    blocking: true
  - check: "node -e 'const p = require(\"./frontend/package.json\"); if (p.scripts.test !== \"vitest run\") process.exit(1);'"
    fix: "Run TASK-563 first — it adds the `test` script to frontend/package.json. Without it, `pnpm --filter frontend test` would fail."
    description: "TASK-564 depends on TASK-563 wiring frontend vitest. Confirms the frontend test script exists before referencing it."
    blocking: true
---

# Add root-level test:unit and test:build scripts unifying all unit-test tiers

## Objective

SPRINT-002 added two hand-rolled node-assert files (`build/afterSign.test.js`, `scripts/configure-build.test.js`) covering the unsigned/signed posture toggle in `scripts/configure-build.js`. Neither is invoked by any `pnpm` script — they're only runnable manually. Combined with B4's frontend vitest wiring (TASK-563), the project now has three unit-test tiers (main vitest, frontend vitest, node-asserts) with zero unified entry point. This task adds two root scripts: `test:build` (runs both node-asserts) and `test:unit` (runs main vitest + frontend vitest + test:build). The existing `pnpm test` (Playwright E2E) is left unchanged.

## Implementation Steps

1. **Edit root `package.json`.** In the `scripts` block, after the existing `test:headed` entry, add two new entries (note the use of `&&` so a failure in any tier short-circuits the rest):
   ```json
   "test:build": "node build/afterSign.test.js && node scripts/configure-build.test.js",
   "test:unit": "pnpm --filter main test && pnpm --filter frontend test && pnpm run test:build"
   ```
   Place them in this order — `test:build` first (because `test:unit` references it via `pnpm run test:build`).

2. **Verify the Playwright `test` script is untouched.** The existing line `"test": "playwright test",` must remain identical — `pnpm test` continues to mean "run E2E tests". `pnpm test:unit` is the new entry point for unit-tier coverage.

3. **Run `pnpm run test:build`.** Expected: both node-assert files print their PASS lines and exit 0. If either fails, stop — the failure is a pre-existing bug in the signing-posture logic and must be triaged before this task ships (this is unlikely given both files passed when committed in SPRINT-002, but the unified runner now makes regressions visible).

4. **Run `pnpm run test:unit`.** Expected sequence:
   - `pnpm --filter main test` (main vitest, including the existing crystalDirectory.test.ts and any new specs from B2/B3) — exit 0
   - `pnpm --filter frontend test` (frontend vitest, 4 cases in migrateLocalStorageKey.test.ts) — exit 0
   - `pnpm run test:build` (build/afterSign.test.js then scripts/configure-build.test.js) — exit 0
   - Overall exit 0

5. **Document the new entry point** by appending a single line to the project README or CLAUDE.md (optional follow-up; not blocking this task). Sample line for the "Common Commands" block in `/Users/raimundoesteva/Developer/cyboflow/CLAUDE.md`:
   ```
   pnpm test:unit         # All unit tests (main vitest + frontend vitest + build node-asserts)
   ```
   Not in scope for this task because CLAUDE.md is not in `files_owned` — the README documentation update is a separate small task if desired.

## Acceptance Criteria

See frontmatter. Compound rule: `pnpm run test:unit` exits 0 on a clean tree and runs all four tiers (main vitest, frontend vitest, build asserts, scripts asserts) in sequence.

## Test Strategy

No new tests. The verification surface is the exit code of `pnpm run test:unit`. The existing test files are unchanged.

## Hardest Decision

Whether to port `build/afterSign.test.js` and `scripts/configure-build.test.js` to vitest in the same task. **Decision: no, leave them as node-asserts.** Three reasons: (1) the files are functional as-is and were just shipped in SPRINT-002 — porting them now would be a re-test of recently-validated code with no behavior change. (2) Vitest in the root or in `build/`/`scripts/` would require a new workspace or hoisted vitest config — disproportionate friction for two small files. (3) The node-assert style is appropriate for these tests: they assert against `package.json` byte-level state (snapshot to `.bak`, mutate, restore) — a use case vitest doesn't materially improve. A future task can port them if a third node-assert file appears (then the duplication becomes the prompt to consolidate).

## Rejected Alternatives

- **Run all unit-test tiers in parallel via `concurrently` or vitest's `--reporter` features.** Rejected: parallelism saves ~10-20s but obscures failure attribution and complicates exit-code aggregation. Sequential `&&` is simpler and the suites are fast enough that wall-clock savings don't matter for local dev.
- **Add a `pretest` hook to `pnpm test` that runs `test:unit` first.** Rejected: would silently change the meaning of `pnpm test`. Two separate entry points (`pnpm test` for E2E, `pnpm test:unit` for units) preserves the existing contract and is what most users expect.
- **Add CI YAML wiring (`.github/workflows/unit-tests.yml`) in the same task.** Rejected: explicitly out of scope per epic boundary. The repo currently has no `.github/workflows/` dir, so adding CI is a larger task that requires runner image decisions and Apple-signing secret handling — independent of this script wiring.

## Lowest Confidence Area

The dependency order encoded in `pnpm --filter main test && pnpm --filter frontend test && pnpm run test:build`. If main vitest fails, the frontend and build tests are skipped — which is intentional (fail fast) but means a frontend regression introduced after a main regression won't be visible in the same run. Two ways to relax this:
- Replace `&&` with `;` (run all, exit code reflects whether any failed) — but cross-platform shell behavior diverges (Windows lacks `;` in npm scripts; pnpm scripts go through `cross-env`-like shimming).
- Use a small JS runner that captures each tier's exit code and aggregates.

For now the `&&` chain is the simplest and most portable; if devs want to see all failures at once they can run each `pnpm --filter X test` individually. Secondary concern: when TASK-563 (B4) is not yet merged, this task's `pnpm --filter frontend test` will fail because the frontend has no `test` script — which is why `depends_on: [TASK-563]` is encoded in the frontmatter. The prerequisite check in the frontmatter verifies the dep is satisfied before this task starts.
