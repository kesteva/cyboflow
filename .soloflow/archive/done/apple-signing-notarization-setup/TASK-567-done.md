---
id: TASK-567
sprint: SPRINT-019
epic: apple-signing-notarization-setup
status: done
summary: "Establish docs/signing/builds/<version>/ lifecycle; move 0.3.5 evidence under it; promote Notes-to-runbook content into APPLE_DEVELOPER_SETUP.md."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-567 — Done Report

## Summary

Refactored `docs/signing/` to a versioned-evidence model. The two existing 0.3.5 evidence files (`FIRST_SIGNED_BUILD_LOG.md`, `GATEKEEPER_ACCEPTANCE_TEST.md`) moved under `builds/0.3.5/` via `git mv` (history preserved with R082/R096 rename detection). Created `builds/README.md` documenting the lifecycle, plus two generic templates under `_template/`. Appended two new runbook sections to `APPLE_DEVELOPER_SETUP.md`: "Recording a Signed Build" (workflow pointer for the next signer) and "Known Build Pitfalls" (five operationally-organized items from the 0.3.5 Notes section).

## Changes

- 2 commits on run branch: `0a2e2c5` (file moves + templates + builds/README.md), `27cc4a6` (APPLE_DEVELOPER_SETUP.md sections + stale-reference sweep)
- 8 files in `files_owned` scope per plan
- 3 in-repo path sweep updates (TASK-056 plan frontmatter, EPIC Success Signal, human-review-queue.md doc_ref) — AC #9-prescribed

## Verification

- All 10 acceptance criteria PASS (verifier confirmed via grep-based AC verifications)
- Code review: CLEAN (0 critical, 0 important, 0 minor blockers)
- Tests: NO_TESTS_NEEDED (pure markdown reorganization; plan declared `test_strategy.needed: false`)
- Visual: N/A for both mobile and web (no UI changes)

## Notes

- One out-of-diff finding (FIND-SPRINT-019-3) logged by code-reviewer: pre-existing "13-step procedure" wording in human-review-queue.md vs. 10-step Gatekeeper doc. Pre-existing (commit d5e0d08), not introduced by this task.
