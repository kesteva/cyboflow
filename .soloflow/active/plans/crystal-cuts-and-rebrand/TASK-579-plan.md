---
id: TASK-579
idea: SPRINT-006-compound
status: in-flight
source_sprint: SPRINT-006
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/services/permissionManager.ts
  - main/src/services/mcpPermissionServer.ts
files_readonly:
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/approvalRouter.ts
  - frontend/src/App.tsx
  - frontend/src/types/electron.d.ts
  - .soloflow/active/findings/SPRINT-006-findings.md
  - .soloflow/active/compound/SPRINT-006-proposal.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/EPIC-crystal-cuts-and-rebrand.md
acceptance_criteria:
  - criterion: main/src/services/permissionManager.ts no longer exists on disk
    verification: "test ! -e main/src/services/permissionManager.ts"
  - criterion: main/src/services/mcpPermissionServer.ts no longer exists on disk
    verification: "test ! -e main/src/services/mcpPermissionServer.ts"
  - criterion: "No production source file imports from a path resolving to the deleted permissionManager file (the import string `'./permissionManager'`, `'../services/permissionManager'`, etc. is gone)"
    verification: "grep -rn --include='*.ts' --include='*.tsx' \"from ['\\\"].*permissionManager['\\\"]\" main/src frontend/src returns 0 matches"
  - criterion: No production source file imports the dead MCPPermissionServer or PermissionManager classes
    verification: "grep -rn --include='*.ts' --include='*.tsx' -E '\\b(MCPPermissionServer|PermissionManager)\\b' main/src frontend/src returns 0 matches (this includes class names, type names, and instance references)"
  - criterion: "No production source file imports the `PermissionResponse` *type* from the deleted file. The `PermissionResponse` interface in `frontend/src/types/electron.d.ts` is an independent renderer-side type declaration (not imported from main) and remains untouched"
    verification: "grep -rn --include='*.ts' --include='*.tsx' \"from ['\\\"].*permissionManager['\\\"]\" main/src frontend/src returns 0 matches; grep -n 'interface PermissionResponse' frontend/src/types/electron.d.ts returns 1 match (this file is intentionally not modified)"
  - criterion: Main process typecheck passes
    verification: pnpm --filter main typecheck exits 0
  - criterion: Main process lint passes
    verification: pnpm --filter main lint exits 0
  - criterion: Main process unit tests pass with the same case count as before deletion
    verification: pnpm --filter main test exits 0; record the case count from the test run output in the done report so the reviewer can compare against the pre-task baseline
  - criterion: Frontend typecheck passes (sanity check that the unrelated renderer-side `PermissionResponse` interface still resolves)
    verification: pnpm --filter frontend typecheck exits 0
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Pure deletion of two dead files (zero live importers verified at plan time — `grep -rn --include='*.ts' \"from ['\\\"].*permissionManager['\\\"]\" main/src frontend/src` returns 0 matches; `grep -rn --include='*.ts' -E '\\b(MCPPermissionServer|PermissionManager)\\b' main/src frontend/src` returns matches only inside the two files being deleted). Sibling-test scan: `ls main/src/services/__tests__/` contains only `claudeCodeManagerPermissions.test.ts`, which tests `ClaudeCodeManager` permission-mode enforcement and does not import either of the deleted files (verified via `grep -n 'PermissionManager\\|MCPPermissionServer\\|permissionManager' main/src/services/__tests__/claudeCodeManagerPermissions.test.ts` returns 0 matches). The existing AC `pnpm --filter main test exits 0 with unchanged case count` IS the regression test — if any hidden import path is missed, vitest will fail to resolve the module."
---
# Delete dead permission-layer files (permissionManager.ts, mcpPermissionServer.ts)

## Objective

`main/src/services/permissionManager.ts` (class `PermissionManager`) and `main/src/services/mcpPermissionServer.ts` (class `MCPPermissionServer`) are dead code: zero live importers across `main/src/` and `frontend/src/`. `mcpPermissionServer.ts` imports `PermissionManager`, so they form a self-referencing dead island. TASK-301 rebranded the socket name inside `mcpPermissionServer.ts` ("crystal-permissions" → "cyboflow-permissions"), making stale dead code look freshly maintained and bleeding false signal into the rebrand sweep. Delete both files now to remove the deceptive surface area.

## Implementation Steps

1. **Re-verify zero importers right before deletion** (the codebase may have changed since refinement):
   ```
   grep -rn --include='*.ts' --include='*.tsx' "from ['\"].*permissionManager['\"]" main/src frontend/src
   grep -rn --include='*.ts' --include='*.tsx' -E '\b(MCPPermissionServer|PermissionManager)\b' main/src frontend/src
   ```
   The first command must return 0 matches. The second command may return matches **only** inside `main/src/services/permissionManager.ts` and `main/src/services/mcpPermissionServer.ts` themselves — both files are being deleted in this task, so self-references are fine. If either grep surfaces an unexpected match, stop and escalate; the dead-island claim is no longer true.

2. **Delete the two files**:
   ```
   git rm main/src/services/permissionManager.ts
   git rm main/src/services/mcpPermissionServer.ts
   ```

3. **Re-run the import greps after deletion** to confirm zero residual references:
   ```
   grep -rn --include='*.ts' --include='*.tsx' "from ['\"].*permissionManager['\"]" main/src frontend/src
   grep -rn --include='*.ts' --include='*.tsx' -E '\b(MCPPermissionServer|PermissionManager)\b' main/src frontend/src
   ```
   Both must return 0 matches.

4. **Confirm the renderer-side `PermissionResponse` interface is untouched.** `frontend/src/types/electron.d.ts:16` declares an *independent* renderer `PermissionResponse` interface (not imported from main). Leave it alone — it is part of the legacy frontend `permission:respond` IPC channel which lives in different code paths and is out of scope for this task.

5. **Run the verification chain**:
   ```
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test
   pnpm --filter frontend typecheck
   ```
   All four must exit 0. Record the `pnpm --filter main test` case count in the done report so the reviewer can compare against baseline (pre-task case count should equal post-task case count — no tests were modified).

## Acceptance Criteria

See frontmatter. Two file deletions, six grep / build assertions.

## Test Strategy

See `test_strategy.justification` in the frontmatter. No new tests; existing `pnpm --filter main test` is the regression gate.

## Hardest Decision

Whether to also delete the unrelated `PermissionResponse` interface in `frontend/src/types/electron.d.ts:16`. Chosen: **leave it alone**. That interface is part of the renderer's `electronAPI.permissions.respond` declaration (line 199), which is a separate `ipcMain.handle('permission:respond')` channel from the Unix-socket path. Tracing whether anything still consumes the renderer-side channel is out of scope for a dead-file deletion task; it belongs to a future sweep targeting the renderer IPC surface (likely the same epic that finishes the Crystal IPC retirement).

## Rejected Alternatives

- **Rename `permissionManager.ts` to `.dead.ts` instead of deleting.** Rejected: half-measures encode the dead-state in filename suffix that future contributors must learn to interpret. Deletion is unambiguous; `git log` preserves history for archaeology.
- **Bundle into TASK-301's already-done scope.** Rejected: TASK-301 archived as done; reopening would require done-report unwind. A net-new task is cleaner.
- **Delete the renderer-side `PermissionResponse` interface in the same task.** Rejected: those are different code paths (renderer-IPC channel vs Unix-socket bridge), and the renderer-side channel may still have live consumers we have not traced. Scope discipline.

## Lowest Confidence Area

The case-count comparison in step 5. The done report must record the pre-task baseline count from the most recent green main-test run; if the executor cannot retrieve a baseline from CI / done reports, the simplest path is to checkout HEAD~1 of the deletion, run `pnpm --filter main test`, record the count, then proceed.
