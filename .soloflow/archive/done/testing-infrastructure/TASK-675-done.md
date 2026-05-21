---
id: TASK-675
sprint: SPRINT-027
epic: testing-infrastructure
status: done
summary: "Flipped stale assertion in cyboflowSchema.test.ts:680 from toBe(false) to toBe(true) for stuck_detected_at — column is canonical post-migration-007 and re-added by reconciler."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-675 — Done

## What changed
- main/src/database/__tests__/cyboflowSchema.test.ts:
  - Line 621: describe-block title — removed "or stuck_detected_at orphan column exists", added "preserves stuck_detected_at (added by migration 007)"
  - Line 666: inline step-2 comment — removed "drop stuck_detected_at"
  - Lines 679-682: assertion flipped `toBe(false)` -> `toBe(true)` with explanatory comment citing database.ts:1360-1363

## Verification
- cyboflowSchema.test.ts: 13/13 pass.
- Full main vitest: 541/542 (only pre-existing killProcess timeout remains as FIND-SPRINT-027-2).
- Typecheck + lint: pass.

## Findings resolved
- FIND-SPRINT-027-1 (cyboflowSchema stuck_detected_at orphan column)

## Commit
- df699bd fix(TASK-675): flip stale assertion — stuck_detected_at must be PRESENT after reconciler
