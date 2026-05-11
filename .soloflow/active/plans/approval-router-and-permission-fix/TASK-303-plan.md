---
id: TASK-303
idea_id: IDEA-007
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
files_readonly:
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - .soloflow/active/ideas/IDEA-007.md
acceptance_criteria:
  - criterion: "ApprovalRouter.requestApproval schedules a setTimeout of exactly 60 * 60 * 1000 ms when a pending approval is registered; the timeout handle is stored on the pending entry"
    verification: "grep -nE 'setTimeout\\([^,]+,\\s*60\\s*\\*\\s*60\\s*\\*\\s*1000\\b' main/src/orchestrator/approvalRouter.ts || grep -nE 'setTimeout\\([^,]+,\\s*3_?600_?000\\b' main/src/orchestrator/approvalRouter.ts"
  - criterion: "When the 60-min timeout fires, ApprovalRouter writes a deny response onto the bridge socket via the stored socketReply closure"
    verification: "Unit test 'expires after 60min with socket deny' asserts the socketReply mock was called with { behavior: 'deny', ... } when the test fake-timer advances 60 minutes"
  - criterion: "When the timeout fires, the approvals row transitions to status='expired' and workflow_runs stays in awaiting_review until Claude itself yields (matching the deny semantics in TASK-302)"
    verification: "Unit test asserts approvals.status === 'expired' after timer fires; workflow_runs.status remains 'awaiting_review'"
  - criterion: "Calling respond() before the timeout fires cancels the timer (no leaked timers)"
    verification: "grep -nE 'clearTimeout' main/src/orchestrator/approvalRouter.ts && unit test asserts that after a normal respond() call followed by jest.advanceTimersByTime(60*60*1000+1000), the socketReply mock is invoked exactly once (from respond, not also from the timeout)"
  - criterion: "Test suite passes: pnpm --filter @cyboflow/main test approvalRouter exits 0 with the new timeout test cases visible in output"
    verification: "pnpm --filter @cyboflow/main test approvalRouter exits 0 and the output mentions 'expires after 60min' and 'clears timer on respond'"
depends_on: [TASK-302]
estimated_complexity: medium
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "The 60-min timeout is §5.7's non-negotiable failure-mode mitigation and the #1 inherited bug from risks research §4. Without explicit fake-timer tests the timer code is invisible to CI; a regression that drops the deny socket reply would only surface after a real 60-min user wait."
  targets:
    - behavior: "60-min timeout fires deny on socket and marks approvals row expired"
      test_file: "main/src/orchestrator/__tests__/approvalRouter.test.ts"
      type: unit
    - behavior: "Normal respond() before timeout cancels the timer; no duplicate socket writes"
      test_file: "main/src/orchestrator/__tests__/approvalRouter.test.ts"
      type: unit
    - behavior: "Timeout fires when respond() never arrives; pending entry is removed from the map"
      test_file: "main/src/orchestrator/__tests__/approvalRouter.test.ts"
      type: unit
---

# 60-Minute Timeout Per Pending Approval (Deny on Socket)

## Objective

Add the per-approval 60-minute `setTimeout` that fires `deny` on the bridge Unix socket and updates the `approvals` row to `status='expired'`. This is the non-negotiable §5.7 mitigation that fixes the inherited `permissionManager.ts:73` bug: a permission request that hangs forever blocks the Claude PTY, which blocks the per-run queue, which blocks the entire workflow. The constant `APPROVAL_TIMEOUT_MS = 60 * 60 * 1000` lives at module top so a follow-up config knob can override it (out of scope for v1).

## Implementation Steps

1. **In `main/src/orchestrator/approvalRouter.ts`, add a module-level constant** near the top, after the imports:
   ```ts
   /** v1 default per ROADMAP-001 §5.7. Adjustable post-MVP via config. */
   export const APPROVAL_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
   ```

2. **Extend the pending-entry type** (the value side of `this.pending` Map): add `timeoutHandle: NodeJS.Timeout` to the entry shape. Update all writers of `this.pending.set(...)` to include the handle.

3. **In `requestApproval`, after the transaction commits and `this.pending.set(...)` runs**, schedule the timeout:
   ```ts
   const timeoutHandle = setTimeout(() => {
     void this.expireApproval(approvalId);
   }, APPROVAL_TIMEOUT_MS);
   ```
   Store `timeoutHandle` on the pending entry. Use `void` because we don't want unhandled-rejection noise from the timer firing; errors inside `expireApproval` are logged but not surfaced to a caller.

4. **Implement private method `expireApproval(approvalId)`:**
   ```ts
   private async expireApproval(approvalId: string): Promise<void> {
     const entry = this.pending.get(approvalId);
     if (!entry) return;  // already responded — race lost cleanly
     // Submit through the per-run queue so this serializes with respond()
     await this.getQueueForRun(entry.request.runId).add(async () => {
       const entryNow = this.pending.get(approvalId);
       if (!entryNow) return;  // respond() won the race inside the queue
       this.db.prepare(`UPDATE approvals SET status='expired' WHERE id=?`).run(approvalId);
       entryNow.socketReply({ behavior: 'deny', message: 'Approval timed out after 60 minutes' });
       this.pending.delete(approvalId);
       this.emit('approvalExpired', approvalId);
     });
   }
   ```
   Note: workflow_runs.status is intentionally NOT touched here. The semantics match `respond({behavior: 'deny'})` from TASK-302 — Claude receives the deny socket reply, will emit a tool-result error event, and the orchestrator's stream parser drives the run's terminal-state transition.

5. **In `respond(approvalId, ...)`, after looking up the pending entry but before the queue submission**, clear the timer:
   ```ts
   const entry = this.pending.get(approvalId);
   if (!entry) throw new ApprovalNotFoundError(approvalId);
   clearTimeout(entry.timeoutHandle);
   ```
   This prevents the timer from firing after respond's queued task runs (which is when the `socketReply` gets invoked from the respond path).

6. **In `clearPendingForRun(runId)` (the stub from TASK-302)**: ensure it clears each pending entry's `timeoutHandle` before the entry is removed. TASK-304 owns the full body; for this task, update the stub so it does `clearTimeout(entry.timeoutHandle)` for any entries it removes. This is a defensive write — TASK-304 must preserve this behavior.

7. **Add three test cases to `main/src/orchestrator/__tests__/approvalRouter.test.ts`**:
   - **Case A — "expires after 60min with socket deny":** Use `jest.useFakeTimers()`. Call `requestApproval(runId='r1', ...)`. Advance timers by `60 * 60 * 1000 + 1`. Assert (a) `socketReply` mock called with `{ behavior: 'deny', message: /timed out/i }`, (b) the approvals row queried via the test DB has `status='expired'`, (c) the `workflow_runs` row still has `status='awaiting_review'`.
   - **Case B — "clears timer on respond":** Call `requestApproval`. Without advancing timers, call `respond(approvalId, { behavior: 'allow' })`. Assert `socketReply` is called exactly once with `behavior='allow'`. Then advance timers by `60 * 60 * 1000 + 1000`. Assert `socketReply` was still called exactly once (the timer did not fire after respond).
   - **Case C — "pending entry removed on expiry":** Call `requestApproval`. Advance timers by `APPROVAL_TIMEOUT_MS + 1`. Assert `router.getPending()` returns `[]`.

8. **Run** `pnpm --filter @cyboflow/main test approvalRouter`. Expect the new cases plus all four pre-existing TASK-302 cases to pass.

## Acceptance Criteria

See frontmatter. The verification for AC #1 uses two alternative grep patterns because TypeScript / JS allows either `60 * 60 * 1000` or `3_600_000` numeric literal — both encode the same intent.

## Test Strategy

Three fake-timer tests in the same test file as TASK-302's suite. Fake timers are the only way to verify a 60-minute timeout without a 60-minute test run; Jest's `useFakeTimers()` + `advanceTimersByTime()` is the canonical pattern. The tests deliberately exercise the timer-clearing path (case B) because a leaked timer firing after `respond` would cause a duplicate socket write (Claude would see two responses for the same tool call — undefined behavior).

## Hardest Decision

Whether the timeout path should also transition `workflow_runs.status` to a new `'expired'` enum value, or leave it in `awaiting_review` until Claude's tool-result-error propagation. **Decision: leave `workflow_runs.status` alone.** Two reasons:
1. Symmetry with `respond({behavior: 'deny'})` from TASK-302 — the user explicitly denying should not behave differently from the timer auto-denying.
2. Claude's tool call receives the deny on the socket and emits a `tool_result` with `is_error: true`; the stream parser (epic `stream-parser-to-main`) drives the terminal-state transition. Having two code paths racing to set the same column is a recipe for state-machine bugs.

The `approvals` row's `status='expired'` is the audit-log record that distinguishes user-deny from timer-deny; that's where the data should live, not in `workflow_runs`.

## Rejected Alternatives

- **Use a single global timer that scans for expired pending entries every minute.** Rejected: simpler scheduling but worse latency (up to 60s past expiry) and harder to test deterministically. Per-entry `setTimeout` is the standard pattern and tests cleanly with fake timers.
- **Make the timeout configurable per workflow via frontmatter.** Rejected: out of scope per the IDEA's assumption ("60-minute timeout is the right default for v1; adjustable post-MVP"). The constant export gives a single point of edit later.
- **Defer the timer setup until the renderer has consumed the `approvalCreated` event.** Rejected: there is no "consumption" signal in tRPC subscriptions; the timer starts when the row is written. If the renderer is closed when the row is written, the timer still fires correctly.

## Lowest Confidence Area

The interaction with `clearPendingForRun` (step 6). Specifically, if the executor of TASK-304 inadvertently removes the `clearTimeout` call when implementing the full body, timers will leak — they fire 60 minutes later and try to write to a socket whose client has already disconnected. Mitigation: TASK-304's acceptance criteria explicitly include "clearTimeout is called for every pending entry before it is removed."
