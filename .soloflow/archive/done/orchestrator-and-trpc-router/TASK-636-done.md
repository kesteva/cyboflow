---
id: TASK-636
sprint: SPRINT-017
epic: orchestrator-and-trpc-router
status: done
summary: "Extended WorkflowRunRow and getRunById SELECT projection with started_at/ended_at; added 2 regression tests"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Closed the read-side gap left by TASK-598: WorkflowRunRow now carries optional nullable `started_at` and `ended_at` fields, and `getRunById`'s SELECT projects both columns alongside the existing nullable cluster. Two regression tests in the `describe('getRunById')` block mirror the existing `reads back policy_json` pattern — one asserts null defaults on a fresh createRun, the other round-trips ISO-8601 strings via a direct UPDATE. 341 tests pass; typecheck clean. No semantic guard (started_at <= ended_at) added — out of scope until started_at gets a writer.
