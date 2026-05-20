---
sprint: SPRINT-024
pending_count: 3
last_updated: "2026-05-20T04:30:00.000Z"
---
# Findings Queue

## FIND-SPRINT-024-1
- **source:** TASK-634 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts:635,816,871,1310
- **description:** 4 pre-existing test failures in runExecutor.test.ts: lifecycle-transition spy called-once assertions fail (got 2 calls), bridgeEvents short-circuit not-called assertion fails. Not related to TASK-634 changes — failures present on the branch before this task.
- **suggested_action:** Investigate runExecutor or its mocks for state bleeding between tests (spy not being reset); may need a clearAllMocks in beforeEach.
- **resolved_by:** 

## FIND-SPRINT-024-2
- **source:** TASK-634 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:680
- **description:** Pre-existing test failure: rebuilds the table when worktree_path is NOT NULL or stuck_detected_at orphan column exists — assertion `expect(cols.some((c) => c.name === stuck_detected_at)).toBe(false)` fails (column still present after rebuild). Not caused by TASK-634 changes.
- **suggested_action:** Investigate the schema migration / reconciler that should drop stuck_detected_at; the rebuild path may not be removing it.
- **resolved_by:** 

## FIND-SPRINT-024-3
- **source:** TASK-634 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/workflowRegistry.test.ts:20-21
- **description:** Duplicate import of the `path` module — line 20 has `import { join } from 'path'` and line 21 has `import * as path from 'path'`. Both are used (line 20's `join` 17 times; namespace `path.relative` and `path.join` on lines 572,578). Predates TASK-634 (already present in 5c08a56^) but the executor touched this import block while removing `mkdtempSync` and `tmpdir`, and had the opportunity to collapse to a single namespace import.
- **suggested_action:** Collapse to a single `import * as path from 'path'` and rewrite the 17 `join(...)` callsites to `path.join(...)`, OR drop the namespace import and inline `path.relative` as `relative` from `'path'` alongside `join`. Optional — both imports work and the dual-import idiom is not strictly broken.
- **resolved_by:** 
