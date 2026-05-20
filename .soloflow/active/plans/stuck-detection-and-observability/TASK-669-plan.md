---
id: TASK-669
idea: SPRINT-023
status: ready
created: 2026-05-19T00:00:00Z
files_owned:
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/stores/__tests__/reviewQueueSlice.test.ts
files_readonly:
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - shared/types/stuckDetection.ts
  - shared/types/cyboflow.ts
acceptance_criteria:
  - criterion: "`setRunStatus` evicts the runId entry from all three maps (`runStatusMap`, `runReasonMap`, `runDetectedAtMap`) when status is `'completed'`, `'canceled'`, or `'failed'`."
    verification: "grep -n 'runReasonMap' frontend/src/stores/reviewQueueSlice.ts shows a `delete next[runId]` (or equivalent immutable removal) inside the terminal-status branch of `setRunStatus`; same for `runDetectedAtMap`."
  - criterion: "`pureSetRunStatus` signature accepts `runReasonMap` and `runDetectedAtMap` snapshots and returns the evicted shape, OR a new pure helper `pureSetRunStatusAllMaps` exists with that signature. (Author's choice — see Implementation Steps.)"
    verification: "grep -nE 'pureSetRunStatus|pureSetRunStatusAllMaps' frontend/src/stores/reviewQueueSlice.ts shows the multi-map signature; the corresponding test file exercises eviction across all three maps."
  - criterion: "Slice JSDoc is updated to reflect the new eviction semantics for all three maps."
    verification: "grep -nE 'runReasonMap|runDetectedAtMap' frontend/src/stores/reviewQueueSlice.ts shows JSDoc text describing 'evicted on terminal status' (replacing the previous 'NOT evicted on terminal status' note on lines ~79-80)."
  - criterion: "New test case asserts `setRunStatus(runId, 'completed')` clears all three maps for that runId without affecting other runIds."
    verification: "grep -nE 'clears all three maps|evicts.*reason|evicts.*detectedAt' frontend/src/stores/__tests__/reviewQueueSlice.test.ts returns >=1 match."
  - criterion: "pnpm typecheck and pnpm lint pass."
    verification: "pnpm typecheck && pnpm lint exit 0"
  - criterion: "Frontend unit tests pass."
    verification: "cd frontend && pnpm test:unit -- reviewQueueSlice exit 0"
depends_on: []
estimated_complexity: low
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "Behavior change in a pure reducer with existing tests — must extend the test suite to assert multi-map eviction. The sibling test file `reviewQueueSlice.test.ts` already covers `setRunStatus` terminal-status eviction for `runStatusMap`; we mirror those cases for the two new maps."
  targets:
    - behavior: "`setRunStatus(runId, 'completed')` removes the runId from all three maps."
      test_file: "frontend/src/stores/__tests__/reviewQueueSlice.test.ts"
      type: unit
    - behavior: "`setRunStatus(runId, 'canceled')` removes the runId from all three maps."
      test_file: "frontend/src/stores/__tests__/reviewQueueSlice.test.ts"
      type: unit
    - behavior: "`setRunStatus(runId, 'failed')` removes the runId from all three maps."
      test_file: "frontend/src/stores/__tests__/reviewQueueSlice.test.ts"
      type: unit
    - behavior: "`setRunStatus(runId, 'running')` (non-terminal) does NOT touch `runReasonMap` or `runDetectedAtMap` for that runId."
      test_file: "frontend/src/stores/__tests__/reviewQueueSlice.test.ts"
      type: unit
    - behavior: "Eviction of runId-A does not affect runId-B entries in any of the three maps."
      test_file: "frontend/src/stores/__tests__/reviewQueueSlice.test.ts"
      type: unit
---

# Evict runReasonMap and runDetectedAtMap entries on terminal status in setRunStatus

## Objective

TASK-624 added `runReasonMap` and `runDetectedAtMap` to `reviewQueueSlice` but `setRunStatus`'s terminal-status branch only evicts `runStatusMap[runId]`. The original JSDoc justified this as "the reason stays available for diagnostic display even after cancel" — but the sole consumer (`PendingApprovalCard.tsx:102`) already gates `useRunStuckDetails(isStuck ? runId : undefined)`. Since `runStatus` is evicted on terminal status, `isStuck` becomes false, and the reason/detectedAt entries become unreachable. The current shape is a slow memory leak: stuck runs accumulate reason/detectedAt entries that no UI path ever reads. This task extends `setRunStatus`'s terminal-status branch to also delete the corresponding `runReasonMap[runId]` and `runDetectedAtMap[runId]` entries, updates the JSDoc, and adds tests asserting full-map eviction.

## Implementation Steps

1. **Read the current `setRunStatus` implementation** at `frontend/src/stores/reviewQueueSlice.ts:168-182` to confirm the terminal-status branch shape. Confirm the file still imports `WorkflowRunStatus` and `StuckReason`.

2. **Update `setRunStatus` (lines ~168-182) to evict from all three maps in the terminal-status branch:**
   ```ts
   setRunStatus: (runId, status) => {
     // Terminal statuses: evict the entry from all three maps to prevent
     // unbounded growth. The sole consumer (PendingApprovalCard) gates
     // useRunStuckDetails on `isStuck`, which becomes false the moment we
     // remove runStatusMap[runId] — so the reason/detectedAt entries are
     // unreachable anyway. Keeping them around is a slow memory leak.
     if (status === 'completed' || status === 'canceled' || status === 'failed') {
       set((state) => {
         const nextStatus = { ...state.runStatusMap };
         delete nextStatus[runId];
         const nextReason = { ...state.runReasonMap };
         delete nextReason[runId];
         const nextDetectedAt = { ...state.runDetectedAtMap };
         delete nextDetectedAt[runId];
         return {
           runStatusMap: nextStatus,
           runReasonMap: nextReason,
           runDetectedAtMap: nextDetectedAt,
         };
       });
       return;
     }
     set((state) => ({
       runStatusMap: { ...state.runStatusMap, [runId]: status },
     }));
   },
   ```
   Note: the non-terminal branch is unchanged — we never write `runReasonMap` or `runDetectedAtMap` from `setRunStatus` (only `applyStuckEvent` does). The non-terminal branch should NOT touch the reason/detectedAt maps.

3. **Update the JSDoc on `setRunStatus` (lines ~110-123)** to reflect the new semantic. Replace the existing "## Eviction semantics" block with:
   ```
    * ## Eviction semantics
    *
    * When `status` is a terminal value (`completed`, `canceled`, or `failed`),
    * the entry is **removed** from `runStatusMap` AND from the companion
    * `runReasonMap` / `runDetectedAtMap`.  Once a run reaches a terminal
    * state the only consumer (`PendingApprovalCard`) gates `useRunStuckDetails`
    * on `isStuck`, which is false post-terminal — so reason/detectedAt entries
    * become unreachable.  Co-eviction prevents unbounded growth of all three
    * maps over a long-running app session.
   ```

4. **Update the JSDoc on `runReasonMap` (lines ~74-82) and `runDetectedAtMap` (lines ~84-90)** to remove the claim that they are NOT evicted on terminal status:
   - For `runReasonMap`: change "Entries are written alongside runStatusMap but are NOT evicted on terminal status — the reason stays available for diagnostic display even after cancel." to "Entries are written alongside `runStatusMap` and are co-evicted by `setRunStatus` when the run reaches a terminal status (`completed` / `canceled` / `failed`)."
   - For `runDetectedAtMap`: add a parallel sentence stating it is co-evicted.

5. **Extend `pureSetRunStatus`** (lines ~283-295). The current pure reducer only operates on a single map. Choose one:
   - **Option A (preferred):** keep `pureSetRunStatus` unchanged (still single-map), and add a new pure helper `pureSetRunStatusAllMaps` that takes all three snapshots and returns the new triple. This preserves existing tests for `pureSetRunStatus` and makes the multi-map operation explicit.
   - **Option B:** extend `pureSetRunStatus` to take and return all three maps. Higher test churn.

   Implementation for Option A:
   ```ts
   /**
    * Pure setRunStatus reducer that operates on all three slice maps — exported
    * for unit testing. Mirrors the Zustand action: terminal statuses evict the
    * key from all three maps; non-terminal statuses update only runStatusMap.
    */
   export function pureSetRunStatusAllMaps(
     maps: {
       runStatusMap: Record<string, WorkflowRunStatus>;
       runReasonMap: Record<string, StuckReason>;
       runDetectedAtMap: Record<string, number>;
     },
     runId: string,
     status: WorkflowRunStatus,
   ): {
     runStatusMap: Record<string, WorkflowRunStatus>;
     runReasonMap: Record<string, StuckReason>;
     runDetectedAtMap: Record<string, number>;
   } {
     if (status === 'completed' || status === 'canceled' || status === 'failed') {
       const nextStatus = { ...maps.runStatusMap };
       const nextReason = { ...maps.runReasonMap };
       const nextDetectedAt = { ...maps.runDetectedAtMap };
       delete nextStatus[runId];
       delete nextReason[runId];
       delete nextDetectedAt[runId];
       return { runStatusMap: nextStatus, runReasonMap: nextReason, runDetectedAtMap: nextDetectedAt };
     }
     return {
       runStatusMap: { ...maps.runStatusMap, [runId]: status },
       runReasonMap: maps.runReasonMap,
       runDetectedAtMap: maps.runDetectedAtMap,
     };
   }
   ```

6. **Add tests in `frontend/src/stores/__tests__/reviewQueueSlice.test.ts`.** Extend the existing `describe('useReviewQueueSlice — setRunStatus', ...)` block with new cases:
   ```ts
   it('evicts runReasonMap and runDetectedAtMap entries when status is completed', () => {
     useReviewQueueSlice.setState({
       runStatusMap: { 'run-1': 'stuck' },
       runReasonMap: { 'run-1': { kind: 'self_deadlock' } },
       runDetectedAtMap: { 'run-1': 1700000000000 },
     });
     const { setRunStatus } = useReviewQueueSlice.getState();
     setRunStatus('run-1', 'completed');
     const state = useReviewQueueSlice.getState();
     expect('run-1' in state.runStatusMap).toBe(false);
     expect('run-1' in state.runReasonMap).toBe(false);
     expect('run-1' in state.runDetectedAtMap).toBe(false);
   });

   it('evicts all three maps when status is canceled', () => {
     useReviewQueueSlice.setState({
       runStatusMap: { 'run-1': 'stuck' },
       runReasonMap: { 'run-1': { kind: 'orphan_pty' } },
       runDetectedAtMap: { 'run-1': 1700000000000 },
     });
     useReviewQueueSlice.getState().setRunStatus('run-1', 'canceled');
     const state = useReviewQueueSlice.getState();
     expect('run-1' in state.runStatusMap).toBe(false);
     expect('run-1' in state.runReasonMap).toBe(false);
     expect('run-1' in state.runDetectedAtMap).toBe(false);
   });

   it('evicts all three maps when status is failed', () => {
     useReviewQueueSlice.setState({
       runStatusMap: { 'run-1': 'stuck' },
       runReasonMap: { 'run-1': { kind: 'stale_socket' } },
       runDetectedAtMap: { 'run-1': 1700000000000 },
     });
     useReviewQueueSlice.getState().setRunStatus('run-1', 'failed');
     const state = useReviewQueueSlice.getState();
     expect('run-1' in state.runStatusMap).toBe(false);
     expect('run-1' in state.runReasonMap).toBe(false);
     expect('run-1' in state.runDetectedAtMap).toBe(false);
   });

   it('non-terminal status does not touch runReasonMap or runDetectedAtMap', () => {
     useReviewQueueSlice.setState({
       runStatusMap: { 'run-1': 'stuck' },
       runReasonMap: { 'run-1': { kind: 'self_deadlock' } },
       runDetectedAtMap: { 'run-1': 1700000000000 },
     });
     useReviewQueueSlice.getState().setRunStatus('run-1', 'running');
     const state = useReviewQueueSlice.getState();
     expect(state.runStatusMap['run-1']).toBe('running');
     expect(state.runReasonMap['run-1']).toEqual({ kind: 'self_deadlock' });
     expect(state.runDetectedAtMap['run-1']).toBe(1700000000000);
   });

   it('does not affect other runIds in reason/detectedAt maps when evicting', () => {
     useReviewQueueSlice.setState({
       runStatusMap: { 'run-1': 'stuck', 'run-2': 'stuck' },
       runReasonMap: { 'run-1': { kind: 'self_deadlock' }, 'run-2': { kind: 'orphan_pty' } },
       runDetectedAtMap: { 'run-1': 100, 'run-2': 200 },
     });
     useReviewQueueSlice.getState().setRunStatus('run-1', 'completed');
     const state = useReviewQueueSlice.getState();
     expect('run-1' in state.runStatusMap).toBe(false);
     expect('run-1' in state.runReasonMap).toBe(false);
     expect('run-1' in state.runDetectedAtMap).toBe(false);
     expect(state.runStatusMap['run-2']).toBe('stuck');
     expect(state.runReasonMap['run-2']).toEqual({ kind: 'orphan_pty' });
     expect(state.runDetectedAtMap['run-2']).toBe(200);
   });
   ```

7. **If Option A was chosen, add a `describe('pureSetRunStatusAllMaps', ...)` block** mirroring the new behavior at the pure-function level (same five cases but invoking the pure helper). This keeps parity with the existing `pureSetRunStatus` test block.

8. **Run `pnpm typecheck && pnpm lint && cd frontend && pnpm test:unit -- reviewQueueSlice`.** Confirm all green, including the existing 5 `setRunStatus` test cases (which only assert `runStatusMap` eviction — those remain valid).

## Acceptance Criteria

- All three maps are evicted on terminal status (verified by greps above + test cases).
- Slice JSDoc reflects the new eviction semantics (no stale "NOT evicted" language).
- Non-terminal `setRunStatus` calls do NOT touch `runReasonMap` / `runDetectedAtMap`.
- `pnpm typecheck`, `pnpm lint`, and the targeted unit tests pass.

## Test Strategy

Five new test cases inside the existing `describe('useReviewQueueSlice — setRunStatus', ...)` block (one per terminal status, one for non-terminal preservation, one for cross-runId isolation). If Option A is taken for the pure helper, add a parallel `describe('pureSetRunStatusAllMaps', ...)` block. The existing test cases (assert `runStatusMap` eviction) remain valid — do not delete them. Total new test count: 5–10 depending on Option A vs B.

## Hardest Decision

**Pure helper signature: extend `pureSetRunStatus` (Option B) or add a parallel `pureSetRunStatusAllMaps` (Option A)?**

Option A is preferred because the existing `pureSetRunStatus` is exported and may be consumed by callers outside the slice for granular runStatusMap-only diffs (none today, but the export is the contract). Option B would be a breaking change to that export. Option A also makes the multi-map intent visible at the call site. Cost: two pure helpers instead of one, with the original now being a no-op for the multi-map use case. Reversal trigger: if `pureSetRunStatus` has no live callers after this task (and a follow-up sweep grep confirms it), collapse them in a later refactor.

## Rejected Alternatives

- **Make eviction opt-in via an action parameter** (`setRunStatus(runId, status, { evictAll: true })`). Rejected — adds API surface for a defect fix. The whole point of eviction is the entries become unreachable post-terminal; there is no legitimate consumer wanting to retain them.
- **Keep entries but add a TTL.** Rejected — adds a timer, complicates the slice, and still requires a consumer to read post-terminal reason data. The work item explicitly notes no such consumer exists.
- **Lift eviction into the consumer** (`PendingApprovalCard` clears its slice entries on terminal status). Rejected — distributes the invariant ("terminal status implies maps clear") across components instead of centralizing it in the slice.

## Lowest Confidence Area

Whether a future feature (e.g. a "stuck-run history" view) will legitimately need the reason/detectedAt entries after the run reaches a terminal state. The work item assertion is that no such consumer exists today and `PendingApprovalCard`'s `isStuck` gate forecloses one being viable while sharing the slice. If such a feature lands, it should record terminal-state stuck history in a separate slice (e.g. `stuckHistorySlice`) with its own retention policy, not piggy-back on `reviewQueueSlice`'s short-lived maps. Not adding that slice now to stay scope-bounded.
