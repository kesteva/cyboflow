---
id: TASK-615
sprint: SPRINT-017
epic: approval-router-and-permission-fix
status: done
summary: "Added DO-NOT-EXPAND warnings to the orphan main/src/trpc/ subtree pointing at the canonical router directory and approval-router epic"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

The orphan `main/src/trpc/` subtree (TASK-401's parallel router tree) now warns future contributors against expansion. Added WARNING blocks to `index.ts` and `routers/approvals.ts` plus a one-line back-pointer in `context.ts`, each naming the canonical `main/src/orchestrator/trpc/routers/` location and the `approval-router` epic that will eventually collapse the subtree. Comments-only — the existing approveRestOfRunHandler tests remain the behavioural gate.
