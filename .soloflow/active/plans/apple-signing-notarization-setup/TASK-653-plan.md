---
id: TASK-653
idea: SPRINT-019
status: ready
created: 2026-05-18T00:00:00Z
files_owned:
  - main/package.json
  - pnpm-lock.yaml
  - docs/packaging/root-deps-policy.md
files_readonly:
  - package.json
  - main/src
  - frontend/src
  - shared
  - scripts
  - .soloflow/archive/done/apple-signing-notarization-setup/TASK-585-done.md
  - .soloflow/active/findings/SPRINT-019-findings.md
acceptance_criteria:
  - criterion: "electron-store removed from main/package.json dependencies block"
    verification: "grep -n '\"electron-store\"' main/package.json returns 0 matches (exit code 1)"
  - criterion: "No source code or scripts import electron-store"
    verification: "grep -rnE \"from ['\\\"]electron-store['\\\"]|require\\(['\\\"]electron-store['\\\"]\\)\" main/src frontend/src shared scripts returns 0 matches (exit code 1)"
  - criterion: "pnpm-lock.yaml no longer pins the electron-store package"
    verification: "grep -n '^  electron-store@' pnpm-lock.yaml returns 0 matches (exit code 1) AND grep -n '^      electron-store:' pnpm-lock.yaml returns 0 matches (exit code 1)"
  - criterion: "pnpm install completes cleanly after removal"
    verification: "pnpm install exits 0 with no ERR_PNPM_* errors in stderr"
  - criterion: "Repo-wide typecheck still passes"
    verification: "pnpm typecheck exits 0"
  - criterion: "Repo-wide lint still passes"
    verification: "pnpm lint exits 0"
  - criterion: "main workspace unit tests still pass"
    verification: "pnpm --filter main test exits 0 (run after pnpm electron:rebuild if better-sqlite3 ABI mismatch is reported)"
  - criterion: "root-deps-policy.md no longer lists electron-store under 'Dead dependencies' and instead records the removal"
    verification: "grep -nE '^- `electron-store' docs/packaging/root-deps-policy.md returns 0 matches AND grep -ni 'removed in TASK-653' docs/packaging/root-deps-policy.md returns at least 1 match"
depends_on: []
estimated_complexity: low
epic: apple-signing-notarization-setup
test_strategy:
  needed: false
  justification: "Pure dependency removal with no importers anywhere in the codebase (verified by repo-wide grep across main/src, frontend/src, shared, scripts — zero hits). No runtime behavior changes, so no new test coverage is warranted. Existing test suites (pnpm typecheck, pnpm lint, pnpm --filter main test) are run as gates in the acceptance criteria to confirm nothing regressed. No sibling test exists for main/package.json, pnpm-lock.yaml, or docs/packaging/root-deps-policy.md (config/lockfile/docs files do not have unit tests in this repo)."
---

# Remove dead electron-store dependency from main/package.json

## Objective

`electron-store@^11.0.0` is declared at `main/package.json:25` but has zero importers anywhere in the codebase — it is a Crystal-era leftover from when window-state persistence was handled differently. TASK-585 confirmed and documented this in `docs/packaging/root-deps-policy.md`, deliberately leaving the removal as a follow-up. This task performs the removal: delete the dep, refresh the lockfile, verify no regression in typecheck/lint/tests, and update the policy doc so future readers see this as a closed issue rather than a pending one.

## Implementation Steps

1. **Completeness gate — confirm zero importers before removing.** Run this grep and confirm it returns no matches (exit code 1):
   ```
   grep -rnE "from ['\"]electron-store['\"]|require\(['\"]electron-store['\"]\)" main/src frontend/src shared scripts
   ```
   If any match is returned, STOP and escalate — the dep is not actually dead and the removal must not proceed.

2. **Remove the dependency from `main/package.json`.** Delete line 25 of `main/package.json`:
   ```
       "electron-store": "^11.0.0",
   ```
   Preserve trailing-comma correctness on the line above.

3. **Refresh the lockfile.** From the repo root, run:
   ```
   pnpm install
   ```
   This must update `pnpm-lock.yaml` to drop both occurrences of `electron-store`. Stage the updated `pnpm-lock.yaml`.

4. **Rebuild native modules if needed.** If a prior session left `better-sqlite3` with an ABI mismatch (NODE_MODULE_VERSION error visible during a subsequent test run), run `pnpm electron:rebuild`.

5. **Run the verification gates in order.** Each must exit 0:
   ```
   pnpm typecheck
   pnpm lint
   pnpm --filter main test
   ```
   If any gate fails, the failure must be diagnosed before the doc edit.

6. **Update `docs/packaging/root-deps-policy.md`.** Make two changes:
   - In the `## Dead dependencies in main/package.json` section, remove the `electron-store@^11.0.0` bullet.
   - Add a new section `## Removed dependencies` with this entry:
     ```
     ## Removed dependencies

     - `electron-store@^11.0.0` — removed in TASK-653 (sprint SPRINT-019 follow-up).
       Was declared in `main/package.json` but had zero importers in `main/src/**`,
       `frontend/src/**`, `shared/**`, or `scripts/**` — a Crystal-era leftover.
       Removal verified by repo-wide grep returning zero hits.
     ```
   - If the `## Dead dependencies in main/package.json` section is now empty, keep the heading and replace its body with `_(none — see Removed dependencies below)_`.

7. **Run the completeness grep one more time after edits.** Confirm AC-criterion #1 and #2.

8. **Commit per global atomic-commits policy.** Stage exactly the three changed files and commit with message `chore(TASK-653): remove dead electron-store dependency`.

## Acceptance Criteria

See frontmatter — 8 criteria covering removal, lockfile cleanup, typecheck/lint/test gates, and doc updates.

## Test Strategy

No new tests. Pure dependency-removal cleanup with no runtime behavior change and zero importers. Existing typecheck / lint / unit-test suites are invoked as acceptance gates.

## Hardest Decision

**Whether to also remove `electron-store` from `pnpm.onlyBuiltDependencies` or other root-level pnpm config.** Checked — `electron-store` is NOT listed in root `package.json`'s `pnpm.onlyBuiltDependencies` and NOT in root `dependencies`. So the only file edits required are `main/package.json`, the regenerated `pnpm-lock.yaml`, and the policy doc. Chose to keep scope minimal.

The second-hardest choice was epic assignment: this is a one-off cleanup. Chose `apple-signing-notarization-setup` because TASK-585 lived there and the policy doc is under `docs/packaging/` — grouping preserves narrative continuity. Did not propose a new `packaging-hygiene` epic because there is no second task currently queued.

## Rejected Alternatives

- **Move `electron-store` to root `package.json` instead of removing it.** Rejected because TASK-585 already verified zero importers.
- **Run a packaged-build smoke test as an additional AC.** Rejected because there is no code path that can possibly load `electron-store` at runtime.
- **Bundle this with a broader dead-dep sweep.** Rejected — no other dead-dep findings are currently logged.
- **Propose a new `packaging-hygiene` epic.** Rejected: only one task currently fits.

## Lowest Confidence Area

The lockfile cleanup behavior of `pnpm install` after removing a single direct dep. Expectation: pnpm drops the importer-level pin and the top-level package entry. Risk: pnpm could leave a stale top-level entry if some transitive dep also pulls `electron-store` (very unlikely). If the post-install lockfile still contains `electron-store@`, treat AC#3 as failed and investigate — do not work around by manually editing `pnpm-lock.yaml`.
