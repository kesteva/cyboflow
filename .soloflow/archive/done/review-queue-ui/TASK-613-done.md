---
id: TASK-613
sprint: SPRINT-017
epic: review-queue-ui
status: done
summary: "Consolidated dual vitest configs: deleted root vitest.config.frontend.ts, removed test:unit:frontend script, dropped @vitest-environment jsdom pragmas from 11 frontend test files"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

The frontend test config is now driven by a single canonical `frontend/vite.config.ts` (jsdom default). Pre-flight grep revealed 11 files carrying the redundant pragma (plan anticipated 3); all were cleaned up in the same commit — FIND-SPRINT-010-1 logs the scope expansion. AC4 regression gate satisfied: 204 tests pass (well above the ≥96 floor). Verifier separately filed FIND-SPRINT-017-4 noting the executor mis-filed the deviation to the wrong sprint file.
