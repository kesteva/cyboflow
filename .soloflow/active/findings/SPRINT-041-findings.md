---
sprint: SPRINT-041
pending_count: 2
last_updated: "2026-05-27T04:35:00Z"
---

# Findings Queue
- SPRINT-041 started with missing infra: docker; tests deferred.
- TASK-755 gated: failing blocking prereq (Sanity check that both fields are still dead before pruning).

## FIND-SPRINT-041-1
- **source:** TASK-754 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/session.ts:312
- **description:** The `sessions:create-quick` JSDoc note (c) now reads "`db.createSession` omits `run_id` from its INSERT column list, so the row naturally gets `run_id = NULL` via TASK-743's migration default." TASK-754 added `run_id` to the INSERT column list (bound `data.run_id ?? null`); the row now gets `run_id = NULL` because the data object omits the field, not because the INSERT omits the column. Functionally still NULL — but the JSDoc rationale is stale and could mislead a future maintainer auditing the quick-session no-runId invariant. The file is in `files_readonly` for TASK-754, so the executor correctly did not touch it.
- **suggested_action:** Update note (c) to: "`SessionManager.createSessionWithId` intentionally omits `run_id` from its `sessionData` literal, so `db.createSession` binds `null` and the row gets `run_id = NULL`. See the comment above the `sessionData` literal in `sessionManager.ts:353-356`."
- **resolved_by:**

## FIND-SPRINT-041-2
- **source:** TASK-754 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/__tests__/sessionManagerRunIdMapping.test.ts:159-163, 207-211
- **description:** The new "DB round-trip" describe block imports `better-sqlite3` via `require('better-sqlite3')` inside an IIFE, requiring two `eslint-disable @typescript-eslint/no-require-imports` comments. The plan said to "mirror the bootstrap pattern from `cyboflowSchema.test.ts:737-742`", and that file uses a top-of-file `import Database from 'better-sqlite3'` (line 24) — cleaner and matches the dominant pattern across migration007/010/011/rawEventsSink tests. Functionally identical, but the chosen path diverges from the file the plan referenced and adds two suppression comments to the test surface. Two near-identical IIFE blocks across Case A and Case B also duplicate the same 4-line raw-DB seeding sequence; a tiny `seedProject(dbPath)` helper local to the file would remove the duplication and the eslint suppressions in one move.
- **suggested_action:** Replace the two `require('better-sqlite3')` IIFEs with a top-of-file `import Database from 'better-sqlite3'`, and extract the 4-line "open raw DB → INSERT projects row → close" sequence into a small local helper. The two `eslint-disable` comments can then be dropped.
- **resolved_by:**
