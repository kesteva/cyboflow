---
id: TASK-570
sprint: SPRINT-020
epic: typed-stream-event-schema
status: done
summary: "Canonicalized TextContent/ToolUseContent/ToolResultContent in main + frontend as type aliases of shared/types/claudeStream block types"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-570 — Canonicalize block/content types

Replaced 3 interface bodies in `main/src/types/session.ts` and `frontend/src/types/session.ts` with `@deprecated` type aliases pointing at `TextBlock`/`ToolUseBlock`/`ToolResultBlock` from `shared/types/claudeStream.ts`. Widened `ToolResultContent.content` to the canonical `string | Array<{type;text}>` union and added a `typeof rawContent === 'string'` guard in `main/src/utils/formatters.ts` (in-scope per plan step 4).

Verifier: APPROVED (parallel mode → visual verify skipped).
Code reviewer: CLEAN (no findings).
Test writer: TESTS_WRITTEN (4 new test cases covering both branches of the new guard).
Tests: 412/412 main, typecheck + lint clean.

Findings: FIND-SPRINT-020-1 logged then resolved (verifier reclassified — `formatters.ts` is in `files_owned` and the guard was plan-prescribed).
