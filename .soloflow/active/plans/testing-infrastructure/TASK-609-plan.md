---
id: TASK-609
idea: SPRINT-009-compound
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - package.json
files_readonly:
  - vitest.config.gate.ts
  - tests/cyboflow-day3-gate.spec.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "package.json:54 `test:gate` script runs vitest from repo root, not via `pnpm --filter main exec`"
    verification: "grep -n '\"test:gate\":' package.json returns the value `\"vitest run --config vitest.config.gate.ts\"` (exact match, no `pnpm --filter main exec` indirection)"
  - criterion: "Running `pnpm test:gate` works from a clean checkout (no double-prefix path errors)"
    verification: "pnpm test:gate exits 0 (or skip-pass when claude is not in PATH); the relative config path no longer needs the `../` adjustment"
  - criterion: vitest.config.gate.ts continues to resolve test files correctly under the new invocation
    verification: "grep -n 'include:' vitest.config.gate.ts shows `tests/cyboflow-day3-gate.spec.ts` resolves correctly because cwd is now repo root, and the `__dirname` resolution comment in the config remains accurate"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "This is a script-config edit; the test_gate command itself is the regression check. No new tests are warranted because the change is purely how the existing test is invoked. The AC enforces that `pnpm test:gate` exits 0 (or skip-pass), which is the integration test of the script change."
---
# Fix package.json test:gate script (drop pnpm --filter indirection)

## Objective

`package.json:54` currently runs the day-3 gate test via `pnpm --filter main exec vitest run --config ../vitest.config.gate.ts` — the `--filter main` indirection forces vitest to resolve the config from `main/`'s cwd, which requires the `../` prefix in the config path. This is fragile (any restructure breaks it) and confusing. The repo-root vitest config (`vitest.config.gate.ts`) is at the repo root anyway, so the indirection adds no value. This task changes the script to invoke vitest directly from the repo root.

## Implementation Steps

1. Open `/Users/raimundoesteva/Developer/cyboflow/package.json`.
2. On line 54, change:
   ```json
   "test:gate": "pnpm --filter main exec vitest run --config ../vitest.config.gate.ts"
   ```
   to:
   ```json
   "test:gate": "vitest run --config vitest.config.gate.ts"
   ```
3. Verify vitest is available at the repo root. The repo's root `node_modules/.bin/vitest` should exist because `vitest` is a transitive dep through `main/`. If it isn't, add `"vitest": "^X.Y.Z"` (matching `main/package.json`'s version) to the root `devDependencies` so `pnpm test:gate` resolves the binary. Check: `node -e "console.log(require.resolve('vitest/package.json'))"` from the repo root.
4. Run `pnpm test:gate` from the repo root. Expected: vitest boots, finds `tests/cyboflow-day3-gate.spec.ts`, and either runs the test (if `claude` is in PATH) or skip-passes the single test (if claude is not). Either outcome is exit 0.
5. Manual sanity: `cat package.json | grep test:gate` returns the new line with no `pnpm --filter` prefix.

## Acceptance Criteria

See frontmatter. The new script is shorter, has no nested package indirection, and produces the same behavior.

## Test Strategy

`needed: false` — the AC verification command IS the integration test for this change.

## Hardest Decision

Whether to add `vitest` as a root devDep or rely on hoisted resolution from `main/`. Picked rely-on-hoisting because pnpm's default install hoists transitive devDeps to the root `node_modules/.bin`, and adding a duplicate root entry creates version-drift risk. If `pnpm test:gate` fails with `vitest: command not found`, fall back to adding the root devDep.

## Rejected Alternatives

- **Move the gate test under `main/` so `--filter main` becomes natural.** Rejected because `tests/` at the repo root is the established Playwright location; moving the spec breaks the convention and re-fragments tests.
- **Use `pnpm exec vitest ...` (no --filter).** Slightly cleaner than the current state but still adds the `pnpm exec` prefix. The plain `vitest ...` is the simplest viable form because pnpm's bin-link makes it Just Work.

## Lowest Confidence Area

Whether some CI environment depends on the `pnpm --filter` invocation pattern (e.g. for permission isolation). The repo currently has no `.github/workflows/` per the testing-infrastructure epic body, so this is unlikely to surface as a CI break. If it does, fall back to the rejected alternative `pnpm exec vitest run --config vitest.config.gate.ts`.
