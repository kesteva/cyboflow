---
id: TASK-597
idea: IDEA-014
status: in-flight
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
files_readonly:
  - shared/types/approval.ts
  - main/src/orchestrator/types.ts
  - .soloflow/active/findings/SPRINT-008-findings.md
  - .soloflow/active/plans/claude-agent-sdk-migration/EPIC-claude-agent-sdk-migration.md
acceptance_criteria:
  - criterion: "ApprovalRouter.clearPendingForRun(runId) is no longer a stub — it finds all PendingEntry values whose request.runId equals the argument, resolves each pending decision Promise with a deny-shaped ApprovalDecision (behavior='deny', message='Run was terminated before approval could be processed'), updates each approvals row's status to 'rejected', and removes the entries from this.pending."
    verification: "grep -n 'TODO(TASK-304)' main/src/orchestrator/approvalRouter.ts returns 0 matches AND the new body matches the spec under Implementation Steps."
  - criterion: "PreToolUse hook in claudeCodeManager.ts handles the deny-shaped decision returned by a terminated run gracefully — it maps behavior='deny' to a hookSpecificOutput with permissionDecision='deny' and includes the decision.message as permissionDecisionReason."
    verification: "Read main/src/services/panels/claude/claudeCodeManager.ts:395-434 (makePreToolUseHook). The existing deny branch already handles this contract — confirm no new code is needed beyond a code comment explaining that the deny may originate from clearPendingForRun."
  - criterion: "New unit test cases in approvalRouter.test.ts cover: (a) clearPendingForRun with one active pending entry resolves the awaiting promise with behavior='deny' and message containing 'terminated', and updates the approvals row to status='rejected'; (b) clearPendingForRun on a runId with zero pending entries is a silent no-op (no throw, no DB write)."
    verification: "cd main && pnpm vitest run src/orchestrator/__tests__/approvalRouter.test.ts exits 0 with at least 2 new test cases ('clearPendingForRun rejects in-flight pending entries' and 'clearPendingForRun with no pending entries is a no-op')."
  - criterion: clearPendingForRun does NOT invoke socketReply for cleared entries — only resolve(). The socketReply path is reserved for explicit user/policy decisions in respond(); termination cleanup short-circuits the wire by resolving the Promise directly. A test asserts socketReply was NOT called after clearPendingForRun ran.
    verification: The new test case in approvalRouter.test.ts asserts socketReply.mock.calls has length 0 after clearPendingForRun returns.
  - criterion: "clearPendingForRun is synchronous (returns void) — does NOT submit work through the per-run PQueue. This is intentional: termination is a one-shot cleanup, the run is being torn down, and queue submission would race with the per-run PQueue draining during shutdown."
    verification: "Read the new clearPendingForRun signature: it is `clearPendingForRun(runId: string): void` (no async, no await on this.getQueueForRun). A code comment in the body explains the deliberate non-queued ordering."
  - criterion: pnpm typecheck and pnpm lint are green for the main workspace.
    verification: "cd main && pnpm typecheck && pnpm lint both exit 0."
depends_on: []
estimated_complexity: medium
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "clearPendingForRun was a documented stub; the implementation has subtle invariants (deny-resolve without socketReply, no PQueue submission, idempotent on empty input) that need explicit unit coverage. The existing approvalRouter.test.ts already establishes the in-memory DB + real PQueue fixture pattern — extending it is the lowest-friction approach."
  targets:
    - behavior: "clearPendingForRun with one active pending entry resolves the awaiting requestApproval promise with behavior='deny', updates the approvals row to 'rejected', removes the entry from this.pending."
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
    - behavior: "clearPendingForRun with no pending entries is a silent no-op — no throw, no DB writes, no socket calls."
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
    - behavior: "clearPendingForRun with two pending entries for the same runId rejects both (covers the multi-entry case the body's loop must handle)."
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
    - behavior: clearPendingForRun does not invoke socketReply for cleared entries.
      test_file: main/src/orchestrator/__tests__/approvalRouter.test.ts
      type: unit
---
# Implement full clearPendingForRun body (TASK-304 approval-lifecycle cleanup)

## Objective

Replace the documented stub at `main/src/orchestrator/approvalRouter.ts:326-336` with a real `clearPendingForRun(runId)` body that resolves in-flight approval Promises with a deny-shaped `ApprovalDecision`, marks the corresponding approvals rows as `rejected`, and removes entries from the in-memory `pending` map. The stub has been a no-op since SPRINT-006 (TASK-304 was repeatedly deferred) and TASK-590 now wires it unconditionally into `runSdkQuery`'s `finally` block — so every Claude session termination calls it. Without a real body, any approval left pending when a run aborts (e.g., via `killProcess` mid-tool-call, or via `restartPanelWithHistory`'s defensive `killProcess` call at line 562) leaves the `requestApproval` promise unresolved. The PreToolUse hook then awaits forever inside the SDK iterator's `try { ... } finally { ... }` block, blocking the run's cleanup chain and potentially leaking a dangling promise across panel restarts.

## Implementation Steps

1. Re-read the `PendingEntry` shape in `main/src/orchestrator/approvalRouter.ts:65-72` and the `this.pending` map declaration at line 86. Each entry is keyed by `approvalId` and carries `request` (with `runId`), `socketReply`, `resolve`, `reject`.

2. Replace the stub body at `approvalRouter.ts:328-336`. New body:
   ```ts
   /**
    * Clear all pending approvals for `runId`.
    *
    * Called from runSdkQuery's finally block (claudeCodeManager.ts:314) on every
    * Claude run termination. Iterates this.pending, finds entries whose
    * request.runId matches, resolves each waiting requestApproval promise with a
    * synthetic deny ({ behavior: 'deny', message: '...terminated...' }), marks
    * the approvals row 'rejected', and removes the entry from this.pending.
    *
    * Deliberately synchronous and NOT queued through the per-run PQueue:
    *   - Termination is a one-shot cleanup, not a state mutation that races with
    *     other tool-call lifecycle events for the same run.
    *   - Queueing during shutdown would race with the PQueue's own drain.
    *   - Each DB write is a single-statement UPDATE — no transaction needed.
    *
    * socketReply is intentionally NOT invoked. The socket reply path is reserved
    * for explicit user/policy decisions in respond(); for termination cleanup we
    * short-circuit by resolving the Promise directly. The PreToolUse hook in
    * claudeCodeManager.ts:makePreToolUseHook receives the deny decision via the
    * promise and emits the hookSpecificOutput accordingly.
    */
   clearPendingForRun(runId: string): void {
     const now = new Date().toISOString();
     const denyDecision: ApprovalDecision = {
       behavior: 'deny',
       message: 'Run was terminated before approval could be processed',
     };

     // Collect first, mutate second — avoid iterating a map while deleting from it.
     const toClear: Array<[string, PendingEntry]> = [];
     for (const [approvalId, entry] of this.pending.entries()) {
       if (entry.request.runId === runId) {
         toClear.push([approvalId, entry]);
       }
     }

     if (toClear.length === 0) return;

     for (const [approvalId, entry] of toClear) {
       this.pending.delete(approvalId);

       // Mark the DB row as rejected. Use a guarded UPDATE so we don't clobber a
       // row that respond() already finalized (idempotency under concurrent
       // teardown).
       try {
         this.db
           .prepare(
             `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = 'system'
              WHERE id = ? AND status = 'pending'`,
           )
           .run(now, approvalId);
       } catch (err) {
         // Swallow DB errors during shutdown — termination must not throw or it
         // breaks the runSdkQuery finally chain. Log via console.warn.
         console.warn(
           `[ApprovalRouter] clearPendingForRun: DB update failed for approval ${approvalId}: ${err instanceof Error ? err.message : String(err)}`,
         );
       }

       // Resolve the awaiting requestApproval promise. socketReply is NOT
       // invoked — see method jsdoc.
       entry.resolve(denyDecision);
     }
   }
   ```

3. Confirm the PreToolUse hook in `claudeCodeManager.ts:395-434` already handles the deny case correctly. The current branch at line 414-420 maps `decision.behavior !== 'allow'` to `permissionDecision: 'deny'` and forwards `decision.message` as `permissionDecisionReason`. No code change needed in `claudeCodeManager.ts`. Add ONE explanatory comment above the deny branch:
   ```ts
   // The deny may originate from explicit user/policy denial OR from
   // ApprovalRouter.clearPendingForRun() during run termination — the
   // hookSpecificOutput contract is identical for both sources.
   ```
   Place it immediately before the `return { hookSpecificOutput: { ..., permissionDecision: 'deny' as const, ... } }` block at lines 414-420.

4. Extend `main/src/orchestrator/__tests__/approvalRouter.test.ts` with the four new test cases listed in the Test Strategy section below. Follow the existing fixture pattern (`createTestDb`, `dbAdapter`, `makeQueueFactory`, `seedRun`). All new tests must call `ApprovalRouter._resetForTesting()` in `afterEach` (the existing `afterEach` block at line 116 already does this).

5. Run `cd main && pnpm vitest run src/orchestrator/__tests__/approvalRouter.test.ts` — confirm all existing tests still pass and the new ones pass.

6. Run `cd main && pnpm typecheck && pnpm lint` — confirm green.

## Acceptance Criteria

Re-stated from frontmatter — each verifiable by command or by inspecting the diff:

1. The TODO(TASK-304) comment is gone; the body matches the spec in step 2 above.
2. The PreToolUse hook's deny branch is annotated; no behavior change to that file beyond the comment.
3. The vitest suite has 4 new passing cases (named per the test_strategy entries).
4. `socketReply` is never invoked from `clearPendingForRun` — verified by mock assertion in the new test.
5. The new method signature is synchronous (`(runId: string): void`).
6. `pnpm typecheck` and `pnpm lint` are green.

## Test Strategy

Extend `main/src/orchestrator/__tests__/approvalRouter.test.ts` with four cases. Use the existing `describe('ApprovalRouter', ...)` block.

**Case A: clearPendingForRun rejects in-flight pending entries.** Seed run-100 as 'running'. Call `router.requestApproval(runId, 'tool', {}, socketReply)`; await queue idle. Call `router.clearPendingForRun(runId)`. Await the original `requestApproval` promise → assert resolved with `{ behavior: 'deny', message: containing 'terminated' }`. Assert `socketReply` was NOT called (`expect(socketReply).not.toHaveBeenCalled()`). Assert `router.getPending().length === 0`. Assert the approvals row in the DB has `status='rejected'` and `decided_by='system'`.

**Case B: clearPendingForRun with no pending entries is a no-op.** Initialize the router. Without seeding any approvals, call `router.clearPendingForRun('nonexistent-run-id')`. Expect no throw. Assert `router.getPending().length === 0`. Assert no rows exist in `approvals`.

**Case C: clearPendingForRun with two pending entries for the same runId rejects both.** This is the tricky case — the existing case 3 in the test file demonstrates that two `requestApproval` calls for the same runId serialize via the queue, with the second one throwing `RunNotRunningError`. To create two genuinely-pending entries for the same runId, we must do something the production code never does in a single run: seed two pending entries directly. The simplest robust approach: seed run-101 in 'running' state, fire one `requestApproval`, await queue idle (entry 1 pending, run now in 'awaiting_review'), manually `UPDATE workflow_runs SET status = 'running' WHERE id = ?` to allow a second request, fire a second `requestApproval` with a different toolName, await queue idle. Now two entries are pending under the same runId. Call `clearPendingForRun(runId)`. Assert both promises resolve with deny, both approvals rows are 'rejected', `getPending()` returns 0.

**Case D: clearPendingForRun does not invoke socketReply.** Covered as part of case A (single explicit assertion `expect(socketReply).not.toHaveBeenCalled()`). Optionally add a one-line redundant assertion in case C for both `socketReply1` and `socketReply2`.

Mocking notes:
- Use the existing in-memory `better-sqlite3` fixture; do NOT mock the DB.
- Use real `PQueue` instances from `makeQueueFactory`; do NOT mock the queue.
- `socketReply` is a `vi.fn<(decision: ApprovalDecision) => void>()` — same pattern as existing tests.

## Hardest Decision

**Should clearPendingForRun be queued through the per-run PQueue, or run synchronously outside the queue?** The existing `requestApproval` and `respond` both submit through `this.getQueueForRun(runId).add(...)` to serialize mutations against each other for the same run. Submitting `clearPendingForRun` through the queue would preserve that invariant for the rejection writes. However:

1. Termination cleanup runs in `runSdkQuery`'s `finally` block. The run is being torn down; no other tool-call lifecycle events will fire for this run (the SDK iterator has exited).
2. The per-run PQueue itself may have pending work (a respond() submitted but not yet drained). Submitting `clearPendingForRun` to the queue would wait for that to drain, but if the in-flight respond() is what we're trying to interrupt (because its run was canceled), the queue can be in a state where it's effectively starved.
3. Each DB UPDATE in `clearPendingForRun` is a single guarded statement (`WHERE id = ? AND status = 'pending'`); it is naturally idempotent against a concurrent respond() — the second UPDATE finds `changes=0` and is a silent no-op.

I chose the synchronous, non-queued path for clarity and shutdown-safety, with the guarded UPDATE providing the idempotency that the queue would otherwise provide. The synchronous signature also makes the call from `runSdkQuery`'s `finally` (line 314) trivially non-awaited — no risk of an unawaited promise smuggling an error out of the cleanup chain.

## Rejected Alternatives

**Queue submission via `this.getQueueForRun(runId).add(...)`.** Considered above. Rejected because (a) the run is being torn down so the serialization invariant is moot, (b) shutdown ordering becomes harder to reason about, (c) the guarded UPDATE gives us idempotency without the queue. Would change my mind if a future code path were to call `clearPendingForRun` on a still-active run (e.g., a "cancel all pending approvals for this run but keep the run going" feature); at that point the queue submission would be needed, and the signature would have to become async.

**Reject with an error sentinel (`RunTerminatedError`) instead of resolving with deny.** The source brief mentioned this option. Rejected because:
1. The `requestApproval` promise contract is `Promise<ApprovalDecision>` — turning a normal termination path into a rejection forces every caller to wrap in `try/catch`. Today there is exactly one caller: `makePreToolUseHook` at `claudeCodeManager.ts:399`. That caller already has a `try/catch`, but the catch block returns `permissionDecision: 'deny'` with `permissionDecisionReason: 'Internal approval-router error'` — which would be misleading for a normal termination.
2. Resolving with a synthetic deny matches the existing precedent in `respond()` at line 296 (`resolve({ behavior: 'deny', message: 'Run was canceled before approval could be processed' })`) for the structurally identical "approval superseded by cancel" case. Consistent shape is more important than novel error semantics.
3. The PreToolUse hook can distinguish the source via `decision.message` if it ever needs to.

Would change my mind if a future caller of `requestApproval` cared about distinguishing terminated-vs-denied (e.g., for telemetry); add a discriminant field to `ApprovalDecision` at that point rather than throwing.

## Lowest Confidence Area

**The two-pending-entries-for-same-runId test case (case C).** Production code does not put two entries in `this.pending` for the same runId — the `requestApproval` guard at line 198 (`UPDATE ... WHERE status = 'running'`) ensures a second request for the same run while the first is pending fails with `RunNotRunningError` (this is exactly what existing test case 3 verifies). So case C reaches into the internal state via a manual `UPDATE workflow_runs SET status = 'running'` to bypass the guard and create the two-entry scenario. This is somewhat artificial but valid as a unit test of `clearPendingForRun`'s loop. If reviewers object to the bypass, the case can be downgraded: instead of two entries for the same runId, populate two entries for two different runIds (run-101A and run-101B), call `clearPendingForRun('run-101A')`, assert only the run-101A entry was cleared and the run-101B entry remains. That tests the `runId` filter rather than the loop multiplicity, which is arguably more important.
