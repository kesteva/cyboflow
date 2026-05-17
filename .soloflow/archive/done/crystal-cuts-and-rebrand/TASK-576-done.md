---
id: TASK-576
sprint: SPRINT-014
epic: crystal-cuts-and-rebrand
status: done
summary: "Backend Crystal-reference sweep across main/, scripts/, tests/. Updated comments, JSDoc, log strings, 1 user-facing error, test-infra mocks (app.getName + smoke window title)."
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-576 — Done

## Outcome

Rewrote ~25 sites across `main/src/`, `scripts/README.md`, and `tests/`. Notable: `main/src/test/setup.ts` mock `app.getName()` now returns `'Cyboflow'`; `tests/smoke.spec.ts` now asserts `'Cyboflow'` window title (matching `productName` set by TASK-558); 5 stale `Crystal session` log strings in claudeCodeManager.ts fixed; user-facing error in AbstractCliManager.ts L519 now says "Cyboflow Settings" (aligns with TASK-560's Settings modal rename); SQL/fixture migration comment reworded to "inherited" to accurately describe the upstream-substrate boundary.

Allowlist preserved per plan: deprecated `--crystal-dir` CLI alias, 5 stream-parser upstream-attribution comments, all `enableCrystalFooter`/`crystalDirectory` symbol references (owned by other tasks).

Round 2 fix swept 2 prose lines in `main/src/services/permissionManager.ts` via force-claim (TASK-579 hadn't started). 6 residual prose lines in TASK-561-owned files were knowingly deferred to TASK-561's merge-back (already swept on TASK-561's branch).

## Verification

- 300 main tests passing (32 files).
- Main + frontend typecheck: exit 0.
- Frontend lint: 0 errors.
- Verifier round 1: NEEDS_CHANGES (parallel-execution coordination); round 2: APPROVED.
- Code reviewer CLEAN.

## Findings

- Resolved (AC-prescribed): FIND-SPRINT-014-7/8/9 (scope deviations for force-claimed files), FIND-SPRINT-014-10 (TASK-561 swept prose lines), FIND-SPRINT-014-11 (permissionManager.ts fixed via round 2)
- New: FIND-SPRINT-014-13 (scope deviation force-claim of permissionManager.ts), FIND-SPRINT-014-14 (permissionManager.ts rewrite collapses Crystal-era contrast in dead-code JSDoc — self-resolves when TASK-579 deletes file)

## Commits

- `74350a9` feat(TASK-576): backend Crystal-reference sweep — rewrite comments, log strings, test mocks
- `9908b75` fix(TASK-576): replace Crystal- with Cyboflow- in permissionManager.ts comments
