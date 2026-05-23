---
id: TASK-717
idea: IDEA-023
status: in-flight
created: "2026-05-21T14:30:00Z"
files_owned:
  - main/src/trpc/routers/runs.ts
  - main/src/trpc/routers/events.ts
  - main/src/trpc/routers/approvals.ts
  - main/src/trpc/__tests__/approvals.test.ts
  - main/src/trpc/__tests__/runLifecycle.test.ts
  - main/src/trpc/__tests__/inspectorQueries.test.ts
  - main/src/trpc/index.ts
  - main/src/trpc/context.ts
  - main/src/trpc/trpc.ts
files_readonly:
  - .soloflow/active/plans/approval-router-and-permission-fix/
  - main/src/orchestrator/inspectorQueries.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
acceptance_criteria:
  - criterion: The `main/src/trpc/` directory contains zero files (or no longer exists at all).
    verification: "find main/src/trpc -type f 2>/dev/null returns 0 results; ls main/src/trpc 2>/dev/null returns nothing or 'No such file or directory'."
  - criterion: "No file under `main/src/orchestrator/**` or `main/src/ipc/**` imports from `main/src/trpc/*` (the directory is fully de-referenced)."
    verification: "grep -rnE \"from\\s+['\\\"](\\.\\./)*trpc/(routers|index|context|trpc)\" main/src/orchestrator main/src/ipc returns 0 matches."
  - criterion: "Approval-router epic confirmed completed: `approveRestOfRunHandler` and `rejectRestOfRunHandler` live in `main/src/orchestrator/**` (not in `main/src/trpc/`)."
    verification: "grep -rn 'export function approveRestOfRunHandler' main/src/orchestrator returns at least 1 match; grep -rn 'export function rejectRestOfRunHandler' main/src/orchestrator returns at least 1 match; same greps on main/src/trpc return 0 matches."
  - criterion: "TASK-709 confirmed completed: `getStuckInspectionHandler` lives at `main/src/orchestrator/inspectorQueries.ts` (not in the legacy tree)."
    verification: "test -f main/src/orchestrator/inspectorQueries.ts && grep -n 'export function getStuckInspectionHandler' main/src/orchestrator/inspectorQueries.ts returns 1 match."
  - criterion: Test files that depended on the legacy tree have been migrated or deleted. Specifically `main/src/trpc/__tests__/approvals.test.ts` is removed; equivalent coverage either pre-exists or has been added in the approval-router epic.
    verification: "test ! -f main/src/trpc/__tests__/approvals.test.ts ; grep -rn 'approveRestOfRunHandler\\|rejectRestOfRunHandler' main/src/orchestrator/__tests__ main/src/orchestrator/trpc/__tests__ returns at least 1 match."
  - criterion: "pnpm typecheck && pnpm lint && pnpm test all exit 0."
    verification: "pnpm typecheck && pnpm lint && pnpm test"
  - criterion: "ARCHITECTURE.md is updated: the 'legacy/unwired tRPC tree' note in the IPC section is removed; the corresponding entry in 'Planned / Not Yet Built' (`TBD-tRPC-cutover` cleanup) is removed too."
    verification: "grep -nE 'main/src/trpc/routers/|legacy.*tRPC tree|TBD-tRPC-cutover' docs/ARCHITECTURE.md returns 0 matches."
depends_on:
  - TASK-716
  - TASK-709
estimated_complexity: small
epic: trpc-cutover-and-legacy-tree-cleanup
---
# Delete the legacy `main/src/trpc/` tree

## Objective

Delete every file in `main/src/trpc/` — the unwired duplicate tRPC tree flagged by the 2026-05-21 ARCHITECTURE.md audit. By the time this task runs, all unique logic has been ported into the orchestrator subtree:

- `getStuckInspectionHandler` → `main/src/orchestrator/inspectorQueries.ts` (TASK-709).
- `approveRestOfRunHandler` / `rejectRestOfRunHandler` → relocated by the approval-router epic into `main/src/orchestrator/**`.
- Re-export shims (`runs.ts`, `events.ts`, `approvals.ts`, `index.ts`, `context.ts`, `trpc.ts`) have no remaining importers.

This task is a clean directory rm + ARCHITECTURE.md update.

## Hard preconditions (verify before starting)

1. **Approval-router epic completion.** Check `.soloflow/active/plans/approval-router-and-permission-fix/` — no remaining `status: in-flight` or `status: approved` task plans referencing `approveRestOfRunHandler` / `rejectRestOfRunHandler` relocation. If the approval-router epic is not yet complete, STOP — coordinate sprint sequencing.

2. **TASK-709 completion.** Verify `main/src/orchestrator/inspectorQueries.ts` exists and the handler lives there.

3. **No remaining importers.** Run:
   ```
   grep -rnE "from\\s+['\"](\\.\\./)*trpc/(routers|index|context|trpc)" main/src/orchestrator main/src/ipc frontend/src
   ```
   Must return 0 matches.

## Implementation Steps

1. **Delete the directory:**
   ```
   git rm -r main/src/trpc/
   ```
   This removes:
   - `main/src/trpc/routers/runs.ts`
   - `main/src/trpc/routers/events.ts`
   - `main/src/trpc/routers/approvals.ts`
   - `main/src/trpc/index.ts`
   - `main/src/trpc/context.ts`
   - `main/src/trpc/trpc.ts` (if present)
   - `main/src/trpc/__tests__/approvals.test.ts`
   - `main/src/trpc/__tests__/runLifecycle.test.ts`
   - `main/src/trpc/__tests__/inspectorQueries.test.ts`

2. **Verify equivalent test coverage exists** in the orchestrator subtree before the deletion lands:
   - `main/src/orchestrator/__tests__/inspectorQueries.test.ts` covers `getStuckInspectionHandler` (moved by TASK-709).
   - `main/src/orchestrator/__tests__/` or `main/src/orchestrator/trpc/__tests__/` covers `approveRestOfRunHandler` / `rejectRestOfRunHandler` (moved by approval-router epic).
   - If any test coverage is missing post-deletion, the corresponding precondition task is incomplete — block this PR until they catch up.

3. **Update `ARCHITECTURE.md`:**
   - Remove the "A second, legacy/unwired tRPC tree exists at `main/src/trpc/routers/`..." block in the IPC section.
   - Remove the `TBD-tRPC-cutover` and "Delete/merge `main/src/trpc/routers/` legacy tree" entries in "Planned / Not Yet Built".
   - Update the transport-migration paragraph (currently says "The migration from raw IPC to tRPC for the above procs is owned by a future task (placeholder ID: TBD-tRPC-cutover)") to refer to this epic as completed instead.

4. **Run full gates:** `pnpm typecheck && pnpm lint && pnpm test` exit 0.

## Edge Cases

- **A stray import was missed.** Typecheck catches it immediately — fix the import (point at the relocated module) and re-run.
- **A test file in the deleted set has no equivalent in the orchestrator subtree.** Surfaces as a pre-existing-coverage gap. Either (a) port the test alongside its handler in this PR — small one-time hit, or (b) push back: the relocating epic (approval-router or TASK-709) should have moved the test.

## Out of Scope

- Cleanup of `main/src/orchestrator/trpc/routers/` — this is now the canonical tree, no changes here.
- Any consolidation of Pattern A/B injection setters introduced during the epic — defer to a hygiene task.
