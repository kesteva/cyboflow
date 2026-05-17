---
id: TASK-627
idea: SPRINT-013
status: ready
created: 2026-05-17T00:00:00Z
files_owned:
  - main/src/orchestrator/cancelAndRestartHandler.ts
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
  - main/src/orchestrator/__tests__/cancelAndRestart.test.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/index.ts
  - shared/types/stuckInspection.ts
acceptance_criteria:
  - criterion: "cancelAndRestartHandler logs a WARN line immediately after the approvalRouter.clearPendingForRun(runId) call referencing TASK-304."
    verification: "grep -nE 'logger\\?\\.warn|logger\\?.warn' main/src/orchestrator/cancelAndRestartHandler.ts returns at least 1 match within 4 lines of the line containing 'clearPendingForRun(runId)' AND the warn message contains both '[cancelAndRestart]' and 'TASK-304'."
  - criterion: "The WARN includes the runId in the context object so log scraping can correlate."
    verification: "Read the new logger?.warn(...) call — its second argument must be `{ runId }` (or `{ runId, note: ... }` shape consistent with the existing logger?.error call on line 132)."
  - criterion: "ReviewQueue/PendingApprovalCard's 'Cancel and restart' button now carries a tooltip / title attribute that documents the partial-functionality limitation."
    verification: "grep -nE 'Cancel and restart' frontend/src/components/ReviewQueue/PendingApprovalCard.tsx returns the button element, and the button has either a `title=` attribute OR a sibling text element whose contents include the substring 'deny replies' (or 'TASK-304' / 'partial' / 'permission socket'). Verify by reading the JSX block surrounding the button."
  - criterion: "An existing or new test asserts the WARN is emitted exactly once per cancelAndRestart invocation."
    verification: "grep -nE 'warn.*TASK-304|warn.*clearPendingForRun' main/src/orchestrator/__tests__/cancelAndRestart.test.ts returns at least 1 match in a new or extended test case asserting logger.warn was called with a message containing 'TASK-304'."
  - criterion: "The PendingApprovalCard test asserts the button has the documenting tooltip / title."
    verification: "grep -nE 'title.*deny|title.*TASK-304|title.*partial' frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx returns at least 1 match in a new test case asserting the title attribute of the Cancel and restart button."
  - criterion: "pnpm typecheck succeeds across all workspaces."
    verification: "Run 'pnpm typecheck' from repo root; exit 0."
  - criterion: "Affected test suites pass."
    verification: "Run 'pnpm --filter cyboflow-main test -- --run main/src/orchestrator/__tests__/cancelAndRestart.test.ts' AND 'pnpm --filter cyboflow-frontend test -- --run frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx'; both exit 0."
depends_on: [TASK-622]
estimated_complexity: low
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "New WARN log line + new UI tooltip; each needs a direct assertion so the partial-functionality contract doesn't silently drift."
  targets:
    - behavior: "cancelAndRestartHandler emits a WARN containing '[cancelAndRestart]' and 'TASK-304' once per successful invocation."
      test_file: "main/src/orchestrator/__tests__/cancelAndRestart.test.ts"
      type: unit
    - behavior: "cancelAndRestartHandler does NOT emit the TASK-304 WARN when the run is already terminal (noOp path) — guard before clearPendingForRun returns."
      test_file: "main/src/orchestrator/__tests__/cancelAndRestart.test.ts"
      type: unit
    - behavior: "Cancel and restart button has a title attribute documenting the partial-functionality limitation."
      test_file: "frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx"
      type: component
---

# Add WARN log for clearPendingForRun stub; document partial functionality in UI tooltip

## Objective

`cancelAndRestartHandler.ts:122` calls `approvalRouter.clearPendingForRun(runId)`, which is a documented no-op until TASK-304 lands (see `approvalRouter.ts:328–337`). After TASK-622 wires the Cancel-and-restart button, pressing it will stop the Claude SDK run and update DB rows but will NOT send deny replies on the permission socket — so any in-flight approvals for that run remain unresolved on the Claude side until the SDK times out or yields. This task surfaces the partial-functionality contract in two places: a single WARN log in the handler (so support / log scraping flags the issue when it bites a user) and a tooltip on the Cancel and restart button (so the user understands the trade-off before pressing it).

## Implementation Steps

1. **Add the WARN log line** in `main/src/orchestrator/cancelAndRestartHandler.ts`, immediately after line 122's `approvalRouter.clearPendingForRun(runId);`:
   ```ts
   // Step 2: Send deny replies for all pending approvals BEFORE PTY kill.
   approvalRouter.clearPendingForRun(runId);
   logger?.warn(
     '[cancelAndRestart] clearPendingForRun is a no-op until TASK-304 lands — deny-replies are NOT being sent on the permission socket for this run',
     { runId },
   );
   ```
   Placement is critical: it goes *after* `clearPendingForRun` (so the WARN reflects the call that just no-op'd) and *before* `claudeManagerStop` (so it's logged regardless of whether PTY teardown succeeds or rejects). The existing noOp path (lines 113–115) returns early before reaching this line — no WARN is emitted for already-terminal runs, satisfying AC #2.

2. **Add the tooltip to the Cancel and restart button** in `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx`. Locate the button at line 160:
   ```tsx
   {isStuck && (
     <Button
       variant="secondary"
       size="sm"
       disabled={busy || cancelBusy}
       onClick={handleCancelAndRestart}
       title="Stops the Claude run and starts a new one with the same workflow + worktree. Note: until TASK-304 ships, pending approvals are not yet denied on the permission socket — Claude may need to time out on its side before the new run can proceed cleanly."
     >
       Cancel and restart
     </Button>
   )}
   ```
   The tooltip text is intentionally explicit so the user (or a future contributor) reading the source sees the limitation. Keep it under ~200 chars to fit a typical browser native-title tooltip width.

3. **Add the handler test** in `main/src/orchestrator/__tests__/cancelAndRestart.test.ts`. Reference the existing test "still marks run as canceled and inserts new run when claudeManagerStop rejects" (line 282) which already constructs a `testLogger` — that pattern is the template.
   - New test "emits a WARN with TASK-304 reference after clearPendingForRun":
     - Seed a stuck run.
     - Build deps with a `testLogger` that captures `warn` calls into an array.
     - Call `cancelAndRestartHandler(runId, deps)`.
     - Assert `loggerWarns.length === 1` and `loggerWarns[0].msg.includes('[cancelAndRestart]') && loggerWarns[0].msg.includes('TASK-304')` and `loggerWarns[0].ctx['runId'] === runId`.
   - New test "does NOT emit the TASK-304 WARN when the run is already terminal":
     - Seed a run in 'completed' state.
     - Call the handler — it should return `{ noOp: true, reason: ... }`.
     - Assert `loggerWarns.length === 0`.

4. **Add the component test** in `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx`. Reference the existing "Cancel and restart button" describe block (line 243):
   - New test "Cancel and restart button title attribute documents partial functionality":
     - Render `<PendingApprovalCard item={singleItem} runStatus="stuck" />`.
     - `const button = screen.getByRole('button', { name: /cancel and restart/i });`
     - `expect(button).toHaveAttribute('title', expect.stringContaining('TASK-304'));` (or `expect.stringContaining('deny')` — match whichever phrase is in the source).

5. **Run typecheck + targeted tests**:
   ```
   pnpm typecheck
   pnpm --filter cyboflow-main test -- --run main/src/orchestrator/__tests__/cancelAndRestart.test.ts
   pnpm --filter cyboflow-frontend test -- --run frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
   ```

## Acceptance Criteria

- All criteria in the frontmatter list. WARN log fires once per non-noOp invocation, tooltip is present and references the limitation.

## Test Strategy

Two new handler unit tests (WARN-emitted, WARN-not-emitted-on-noOp), one new component test (tooltip attribute). All existing tests continue to pass — the WARN addition is strictly additive to the handler's existing logger calls and the tooltip is a new attribute on an already-rendered button.

## Hardest Decision

Whether to gate the Cancel-and-restart button visibility behind a feature flag (or behind `TASK-304-shipped` detection) so the user simply doesn't see a button whose behavior is incomplete. Rejected in favor of "ship the WARN + tooltip" because (a) the button does still provide value — stopping the Claude SDK run and inserting a new workflow_runs row is the primary user-visible effect, the missed deny-reply only matters in a narrow race where Claude is mid-approval-wait, and (b) hiding the button defers the visibility of the stuck-detection epic until TASK-304 ships, which the brief explicitly says is the longer dependency. The tooltip-and-log path makes the limitation honest without sacrificing functionality.

## Rejected Alternatives

- **Gate the Cancel-and-restart button visibility behind TASK-304.** See hardest decision. Revisit if user feedback indicates the tooltip is missed or the race is biting users in practice.
- **Emit the WARN inside `approvalRouter.clearPendingForRun` itself.** Rejected because the stub is intentionally silent at the source — adding a WARN there would fire from every callsite (claudeCodeManager.runSdkQuery's finally block also calls it on normal run termination, per the TODO at approvalRouter.ts:333–335). Logging at the cancelAndRestart callsite scopes the WARN to the user-facing surface that actually advertises this functionality.

## Lowest Confidence Area

Whether the WARN should also fire when `claudeManagerStop` subsequently rejects (the existing logger.error at line 132). Today the WARN-then-error sequence will log two lines, which is correct but verbose. If log noise is a concern, a future task can downgrade the WARN to a `logger?.debug` once TASK-304 lands and is verified to make the stub a real implementation. For now WARN is the right level: it's user-visible-functionality-limiting and rare (only fires when the user presses the Cancel-and-restart button, which is only available for stuck runs).
