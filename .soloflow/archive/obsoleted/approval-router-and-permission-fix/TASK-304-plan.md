---
id: TASK-304
idea_id: IDEA-007
status: obsoleted
obsoleted_at: "2026-05-14T00:00:00Z"
obsoleted_reason: "TASK-590 (SDK migration) fully rewrites claudeCodeManager.ts, removing the PTY-kill pathway this task wires into. Verification ACs reference socket reply behavior that does not exist under the in-process PreToolUse hook. The semantics (cancel pending approvals on run abort / app quit) are still meaningful and should be re-planned against the SDK substrate (and against IDEA-013's shell-hook substrate if that pivot lands) post-migration."
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/index.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
files_readonly:
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/ideas/IDEA-007.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "ApprovalRouter.clearPendingForRun(runId) iterates every entry where pending.request.runId === runId, calls socketReply({behavior:'deny', message:'Run terminated'}) for each, calls clearTimeout(entry.timeoutHandle), updates each approvals row to status='canceled', and removes the entry from the pending map"
    verification: "grep -nE 'clearPendingForRun\\(runId' main/src/orchestrator/approvalRouter.ts -A 25 | grep -E \"behavior:\\s*'deny'\" && grep -nE 'clearPendingForRun' main/src/orchestrator/approvalRouter.ts -A 25 | grep -E 'clearTimeout' && grep -nE 'clearPendingForRun' main/src/orchestrator/approvalRouter.ts -A 25 | grep -E \"status\\s*=\\s*'canceled'\""
  - criterion: claudeCodeManager.cleanupCliResources calls ApprovalRouter.getInstance().clearPendingForRun(sessionId) BEFORE any PTY-kill logic and awaits it (no fire-and-forget)
    verification: "grep -n 'await ApprovalRouter\\.getInstance().clearPendingForRun' main/src/services/panels/claude/claudeCodeManager.ts"
  - criterion: "main/src/index.ts before-quit handler awaits a global ApprovalRouter.clearAllPending() that calls clearPendingForRun for every runId in the pending map, with all deny replies completing before app.exit"
    verification: "grep -nE 'clearAllPending|clearPendingForRun' main/src/index.ts | grep -E 'before-quit|will-quit|app\\.on'"
  - criterion: "Unit test 'clearPendingForRun sends deny on socket for each entry' passes; verifies socketReply mock called with behavior='deny' once per pending entry, timers cleared, approvals rows updated to status='canceled'"
    verification: "pnpm --filter @cyboflow/main test approvalRouter exits 0 with test output mentioning 'clearPendingForRun sends deny on socket for each entry'"
  - criterion: "Unit test 'clearAllPending denies across multiple runIds' passes; sets up 3 pending approvals across 2 runIds, calls clearAllPending, asserts 3 deny socket writes and all entries removed"
    verification: "pnpm --filter @cyboflow/main test approvalRouter exits 0 with output mentioning 'clearAllPending denies across multiple runIds'"
depends_on:
  - TASK-302
  - TASK-303
estimated_complexity: medium
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "clearPendingForRun has three side effects that must all fire in order (socket deny, timer clear, DB update) and any omission causes a class of bugs from 'hung PTY' (no socket deny) to 'duplicate socket write' (no timer clear) to 'stale awaiting_review row' (no DB update). Unit tests assert all three side effects per entry."
  targets:
    - behavior: "clearPendingForRun with 2 pending approvals for the same runId sends 2 deny socket writes, clears 2 timers, marks 2 approvals rows status='canceled'"
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
    - behavior: "clearPendingForRun for runId='r1' leaves pending approvals for runId='r2' untouched"
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
    - behavior: clearAllPending denies all pending across all runIds; pending map ends empty
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
---
# clearPendingForRun and clearAllPending (Clean Shutdown Semantics)

## Objective

Implement the deny-before-kill semantics on run cancel / run failure / app close. Without this, Claude's PTY blocks forever waiting for a socket reply that never arrives, the per-run p-queue stays occupied, and on app quit the OS reaps the PTY without giving Claude a chance to exit its tool call cleanly. The fix is mechanical but high-impact: for every pending approval being torn down, send `deny` on the bridge socket first, then mark the row `canceled`, then remove from the in-memory map. `clearPendingForRun(runId)` is the per-run entry point (called from `cleanupCliResources` and the cancel mutation in the future tRPC router); `clearAllPending()` is the global drain used by the `before-quit` handler.

## Implementation Steps

1. **Replace the TASK-302 stub of `clearPendingForRun(runId)` in `main/src/orchestrator/approvalRouter.ts`** with the real body:
   ```ts
   clearPendingForRun(runId: string): void {
     for (const [approvalId, entry] of this.pending.entries()) {
       if (entry.request.runId !== runId) continue;
       clearTimeout(entry.timeoutHandle);
       try {
         entry.socketReply({ behavior: 'deny', message: 'Run terminated' });
       } catch (err) {
         this.logger?.warn(`[ApprovalRouter] Socket write failed for ${approvalId}: ${err}`);
       }
       this.db.prepare(`UPDATE approvals SET status='canceled' WHERE id=?`).run(approvalId);
       this.pending.delete(approvalId);
       this.emit('approvalCanceled', approvalId);
     }
   }
   ```
   This is intentionally synchronous: socket writes via `client.write(...)` are buffered by Node and return immediately. The caller (`cleanupCliResources` or the `before-quit` handler) does not need to await individual entries.

2. **Add `clearAllPending()` to `ApprovalRouter`:**
   ```ts
   clearAllPending(): void {
     const runIds = new Set<string>();
     for (const entry of this.pending.values()) runIds.add(entry.request.runId);
     for (const runId of runIds) this.clearPendingForRun(runId);
   }
   ```

3. **Update `main/src/services/panels/claude/claudeCodeManager.ts` `cleanupCliResources(sessionId)`** (around line 268):
   - Replace the existing line (`PermissionManager.getInstance().clearPendingRequests(sessionId);` → which TASK-302 already changed to a stub call) with `await ApprovalRouter.getInstance().clearPendingForRun(sessionId);`. Note: `clearPendingForRun` is synchronous, but await-ing a sync function is harmless and future-proofs against the implementation becoming async (e.g., if the socket write becomes promisified). Actually — re-evaluate: better-sqlite3's `db.prepare(...).run(...)` is synchronous, and `client.write` is synchronous-fire-and-forget. The function body has no async operations. Drop the `await` and just call `ApprovalRouter.getInstance().clearPendingForRun(sessionId);` directly. The AC explicitly requires this — see AC #2.
   - Re-evaluate the AC: it says "awaits it (no fire-and-forget)." Since the function is synchronous, "no fire-and-forget" means the call must complete before the next line runs. A direct synchronous call satisfies that. Update the AC verification grep accordingly if it conflicts — but the grep `await ApprovalRouter.getInstance().clearPendingForRun` is too strict for a sync method. **Updated step: do NOT add `await`; the verification grep should be `grep -n 'ApprovalRouter.getInstance().clearPendingForRun(sessionId)'`. Update AC #2 in your output to match: `grep -n 'ApprovalRouter\\.getInstance\\(\\)\\.clearPendingForRun' main/src/services/panels/claude/claudeCodeManager.ts`.**
   - Place the call as the FIRST line of `cleanupCliResources` (before any of the existing 5-second-delayed unlink logic for MCP config files). Order matters: deny on socket → then PTY kill (which happens in the caller) → then file cleanup.

4. **Update `main/src/index.ts` `before-quit` handler:**
   - Find the existing `before-quit` block (around line 910). Currently it calls `sessionManager.cleanup()`, `runCommandManager.stopAllRunCommands()`, `cliManagerFactory.shutdown()`, then `permissionIpcServer.stop()`.
   - Add `ApprovalRouter.getInstance().clearAllPending();` as the FIRST step inside the handler, BEFORE `sessionManager.cleanup()`. The order is intentional: deny replies must reach Claude PTYs before those PTYs are killed by `cliManagerFactory.shutdown()`.
   - Add the import at the top of `index.ts`: `import { ApprovalRouter } from './orchestrator/approvalRouter';`.

5. **Update the AC text** in this plan: AC #2's verification was authored too strictly. The correct verification is `grep -nE 'ApprovalRouter\\.getInstance\\(\\)\\.clearPendingForRun\\(sessionId\\)' main/src/services/panels/claude/claudeCodeManager.ts` (no `await`). The executor should apply the corrected grep when running AC checks. This in-plan correction is intentional — see Hardest Decision.

6. **Add three test cases to `main/src/orchestrator/__tests__/approvalRouter.test.ts`:**
   - **Case D — "clearPendingForRun sends deny on socket for each entry":** Seed two pending approvals for `runId='r1'`. Call `clearPendingForRun('r1')`. Assert (a) `socketReply` mock invoked exactly 2× with `{behavior: 'deny', message: 'Run terminated'}`, (b) both approvals rows have `status='canceled'`, (c) `router.getPending()` returns `[]`, (d) `jest.advanceTimersByTime(APPROVAL_TIMEOUT_MS + 1)` after the clear — no additional socket writes (timers were cleared).
   - **Case E — "clearPendingForRun for r1 leaves r2 untouched":** Seed one approval each for `r1` and `r2`. Call `clearPendingForRun('r1')`. Assert (a) `socketReply` for r1's entry called once with deny, (b) r2's entry still in `router.getPending()`, (c) r2's approvals row still has `status='pending'`.
   - **Case F — "clearAllPending denies across multiple runIds":** Seed three approvals across two runIds (`r1`: 2, `r2`: 1). Call `clearAllPending()`. Assert (a) 3 deny socket writes total, (b) all 3 approvals rows `status='canceled'`, (c) `router.getPending()` empty.

7. **Run `pnpm --filter @cyboflow/main test approvalRouter`** and `pnpm run typecheck`. Both exit 0.

## Acceptance Criteria

See frontmatter — but apply the correction from Implementation Step 5 to AC #2 when running the verification (no `await` on the sync call).

## Test Strategy

Three unit tests in the same suite as TASK-302/303. Cases D and F exercise the full deny-clear-update side-effect chain; Case E proves the scoping by runId is correct (a common bug class: an iteration that accidentally matches all entries).

## Hardest Decision

Whether the in-plan AC correction in step 5 is acceptable. **Decision: yes, with explicit acknowledgement.** The original AC #2 (authored before the `await` re-evaluation) is wrong for a synchronous method — and shipping that AC unchanged would force the executor to either (a) add a useless `await` to make the grep pass, or (b) flag a scope-deviation. Option (a) hides intent; option (b) is correct but expensive. Calling out the correction inside Implementation Step 5 + leaving the verification text to match the synchronous form is the most honest path. Treat the frontmatter AC as a hint and step 5's grep as the source of truth.

## Rejected Alternatives

- **Make `clearPendingForRun` async and `await` the socket writes.** Rejected: `net.Socket.write()` is sync (returns whether the write was buffered or queued). The async-ness would be cosmetic and could mask bugs where the await is forgotten.
- **Send deny replies in parallel via Promise.all.** Rejected: same reason — there's no async work to parallelize. Synchronous for-loop is faster and easier to reason about.
- **Tear down the socket connection instead of writing deny.** Rejected: the bridge subprocess's `on('close')` handler does `process.exit(0)` (per `cyboflowPermissionBridge.ts`), which kills the bridge but leaves Claude's MCP tool call hanging. The deny *reply* is what unblocks Claude — closing the socket without a reply causes the exact PTY-hang bug we're fixing.

## Lowest Confidence Area

The `before-quit` ordering (step 4). Specifically, `ApprovalRouter.clearAllPending()` writes to sockets that are managed by `cyboflowPermissionIpcServer` — if `permissionIpcServer.stop()` runs first, the writes go to closed sockets and silently fail (the `try/catch` in step 1 absorbs the error). The intended order is: (1) deny replies to live sockets → (2) Claude PTYs see deny and exit their tool calls → (3) `cliManagerFactory.shutdown()` kills the PTYs cleanly → (4) `permissionIpcServer.stop()` closes the socket server. If this ordering is wrong in practice (e.g., Electron doesn't give `before-quit` enough time for Claude to react), the user-visible symptom is "app quit but a Claude tool call hung for a second" — annoying but not data-corrupting. Adding a small `await new Promise(r => setTimeout(r, 500))` between the deny replies and the PTY shutdown is a defensible mitigation if testing surfaces this.
