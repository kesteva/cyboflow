---
sprint: SPRINT-035
pending_count: 1
last_updated: "2026-05-23T22:45:00Z"
---

# Findings Queue

## FIND-SPRINT-035-1
- **source:** TASK-709 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** shared/types/stuckInspection.ts:5
- **description:** The header docblock still names `main/src/trpc/routers/runs.ts (getStuckInspectionHandler + re-export)` as the handler's home and lists "an import cycle that would otherwise exist between the two router files." After TASK-709, the handler now lives in `main/src/orchestrator/inspectorQueries.ts`, the legacy `main/src/trpc/routers/runs.ts` no longer hosts it, and the cycle motivation is obsolete. The file is out of TASK-709's diff (in `files_readonly`), so the stale comment was not corrected in this task. TASK-717 (legacy-tree deletion) is a natural place to refresh this header — at that point the bullet list collapses to a single canonical handler location.
- **suggested_action:** When TASK-717 runs, rewrite the file-header docblock to list `main/src/orchestrator/inspectorQueries.ts` as the handler home and drop the import-cycle paragraph (cycle no longer possible — legacy tree is gone).
- **resolved_by:**
