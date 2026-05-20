---
id: TASK-624
idea: SPRINT-013
status: in-flight
created: "2026-05-17T00:00:00Z"
files_owned:
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/stores/__tests__/reviewQueueSlice.test.ts
  - frontend/src/components/ReviewQueue/StuckBadge.tsx
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
files_readonly:
  - frontend/src/utils/approvalFormatters.ts
  - shared/types/stuckDetection.ts
  - shared/types/cyboflow.ts
acceptance_criteria:
  - criterion: reviewQueueSlice exposes runReasonMap and runDetectedAtMap as new top-level state fields.
    verification: "grep -nE 'runReasonMap:|runDetectedAtMap:' frontend/src/stores/reviewQueueSlice.ts returns at least 2 matches in the state-interface block and at least 2 matches in the store implementation (initial values + applyStuckEvent writes)."
  - criterion: applyStuckEvent writes runId → reason into runReasonMap and runId → detectedAt into runDetectedAtMap when those values are present on the event.
    verification: "Read the applyStuckEvent body in reviewQueueSlice.ts; it must include set updates for both maps when params.reason and params.detectedAt are defined. Confirm via 'grep -nE \"runReasonMap:\\s*\\{|runDetectedAtMap:\\s*\\{\" frontend/src/stores/reviewQueueSlice.ts' returning at least 2 matches inside the applyStuckEvent reducer."
  - criterion: "A new useRunStuckDetails(runId) selector hook is exported and returns { reason: StuckReason | undefined, detectedAt: number | undefined }."
    verification: "grep -n 'export function useRunStuckDetails' frontend/src/stores/reviewQueueSlice.ts returns exactly 1 match. Test file imports and exercises it."
  - criterion: "StuckBadge accepts an optional detectedAt?: number prop and appends a relative-time suffix to the native title attribute when provided."
    verification: "grep -nE 'detectedAt\\??:\\s*number' frontend/src/components/ReviewQueue/StuckBadge.tsx returns at least 1 match (the prop definition). Read the component — when detectedAt is provided, title = `${reason ?? '...'} · ${formatAge(...)}` (or equivalent)."
  - criterion: ReviewQueue/PendingApprovalCard reads useRunStuckDetails(runId) and forwards detectedAt + a serialized reason to StuckBadge.
    verification: "grep -n 'useRunStuckDetails' frontend/src/components/ReviewQueue/PendingApprovalCard.tsx returns at least 1 match AND grep -nE 'detectedAt=' frontend/src/components/ReviewQueue/PendingApprovalCard.tsx returns at least 1 match passing the prop into StuckBadge."
  - criterion: "ReviewQueueView's existing stuckReason wiring (added in TASK-622) is removed in favor of the card's internal selector, OR ReviewQueueView still passes stuckReason explicitly — pick one path and document. The card MUST end up with both reason and detectedAt for the badge."
    verification: "Read ReviewQueueView.tsx after the edit. Either (a) it no longer passes stuckReason and the card resolves it internally (preferred), or (b) it computes both reason + detectedAt from useRunStuckDetails(runId) and passes both. There is exactly one source of truth for the badge data."
  - criterion: "Reducer unit tests cover the new reason + detectedAt writes (idempotent, doesn't clobber other entries, falls back to undefined when not provided)."
    verification: "grep -nE 'runReasonMap|runDetectedAtMap|useRunStuckDetails' frontend/src/stores/__tests__/reviewQueueSlice.test.ts returns at least 4 matches across at least 3 new test cases."
  - criterion: "PendingApprovalCard test covers the StuckBadge title including the detectedAt suffix (verify via toHaveAttribute('title', ...))."
    verification: "grep -n 'detectedAt' frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx returns at least 1 match AND there is at least one test asserting title attribute contains both reason text and a relative-time fragment."
  - criterion: pnpm typecheck succeeds and all updated test suites pass.
    verification: "Run 'pnpm typecheck' (exit 0) and 'pnpm --filter cyboflow-frontend test -- --run' (exit 0)."
depends_on:
  - TASK-622
estimated_complexity: medium
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "New state, new selector, and new badge tooltip behavior each need direct coverage; existing tests need updates because applyStuckEvent now writes additional fields."
  targets:
    - behavior: "applyStuckEvent({ runId, reason, detectedAt }) writes all three maps."
      test_file: frontend/src/stores/__tests__/reviewQueueSlice.test.ts
      type: unit
    - behavior: "applyStuckEvent({ runId }) without reason/detectedAt leaves the reason/detectedAt maps unchanged for that runId."
      test_file: frontend/src/stores/__tests__/reviewQueueSlice.test.ts
      type: unit
    - behavior: "useRunStuckDetails(runId) returns { reason, detectedAt } from the maps, or undefined fields when absent."
      test_file: frontend/src/stores/__tests__/reviewQueueSlice.test.ts
      type: unit
    - behavior: StuckBadge title attribute includes both reason text and a relative time suffix when detectedAt is provided.
      test_file: frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
      type: component
    - behavior: StuckBadge title contains only the reason (no suffix) when detectedAt is omitted.
      test_file: frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
      type: component
---
# Persist reason + detectedAt in reviewQueueSlice; surface detectedAt in StuckBadge tooltip

## Objective

`reviewQueueSlice.applyStuckEvent` currently discards the `reason` and `detectedAt` fields from the canonical `StuckDetectedEvent` (line 131 destructures only `runId`). As a result `StuckBadge` can only render the reason text passed manually as a prop and cannot show a relative-time hint about *when* a run became stuck — a feature the design called for. This task extends the slice with two parallel maps (`runReasonMap`, `runDetectedAtMap`), adds a `useRunStuckDetails(runId)` selector, makes `StuckBadge` accept an optional `detectedAt` and append a relative-time suffix to its title, and wires `PendingApprovalCard` to consume both via the selector.

## Implementation Steps

1. **Extend the slice state shape** in `frontend/src/stores/reviewQueueSlice.ts`:
   - Update the interface block. After `runStatusMap`, add:
     ```ts
     runReasonMap: Record<string, StuckReason>;
     runDetectedAtMap: Record<string, number>;
     ```
   - Update the import: `import type { StuckDetectedEvent, StuckReason } from '../../../shared/types/stuckDetection';` (StuckReason was previously only used as a type for the applyStuckEvent param).

2. **Update store initial values:** add `runReasonMap: {}` and `runDetectedAtMap: {}` next to `runStatusMap: {}` in the `create` body.

3. **Extend `applyStuckEvent`.** Change the implementation from the current shape (which only writes runStatusMap) to:
   ```ts
   applyStuckEvent: ({ runId, reason, detectedAt }) => {
     set((state) => {
       const next: Partial<ReviewQueueSliceState> = {};
       if (state.runStatusMap[runId] !== 'stuck') {
         next.runStatusMap = { ...state.runStatusMap, [runId]: 'stuck' };
       }
       if (reason !== undefined && state.runReasonMap[runId] !== reason) {
         next.runReasonMap = { ...state.runReasonMap, [runId]: reason };
       }
       if (detectedAt !== undefined && state.runDetectedAtMap[runId] !== detectedAt) {
         next.runDetectedAtMap = { ...state.runDetectedAtMap, [runId]: detectedAt };
       }
       return next;
     });
   },
   ```
   Idempotency is preserved per-field. Tests in step 7 cover both the "all provided" and "only runId provided" paths.

4. **Add the selector hook** below the store definition:
   ```ts
   export function useRunStuckDetails(runId: string | undefined): {
     reason: StuckReason | undefined;
     detectedAt: number | undefined;
   } {
     return useReviewQueueSlice((s) => ({
       reason: runId ? s.runReasonMap[runId] : undefined,
       detectedAt: runId ? s.runDetectedAtMap[runId] : undefined;
     }));
   }
   ```
   Note: returning a fresh object on every call will cause unnecessary re-renders. Use Zustand's `shallow` equality:
   ```ts
   import { shallow } from 'zustand/shallow';
   ...
   return useReviewQueueSlice(
     (s) => ({ reason: runId ? s.runReasonMap[runId] : undefined, detectedAt: runId ? s.runDetectedAtMap[runId] : undefined }),
     shallow,
   );
   ```

5. **Extend StuckBadge.** In `frontend/src/components/ReviewQueue/StuckBadge.tsx`:
   - Update `StuckBadgeProps`:
     ```ts
     export interface StuckBadgeProps {
       reason?: string | null;
       /** Unix epoch ms when the run was classified stuck. When provided, appended to the title as a relative time. */
       detectedAt?: number;
     }
     ```
   - Build the title string:
     ```ts
     import { formatAge } from '../../utils/approvalFormatters';
     ...
     const baseTitle = reason ?? undefined;
     const suffix = detectedAt !== undefined ? formatAge(new Date(detectedAt).toISOString()) : undefined;
     const title = baseTitle && suffix ? `${baseTitle} · ${suffix}` : (baseTitle ?? suffix);
     ...
     <span title={title} ...>STUCK</span>
     ```
   `formatAge` accepts an ISO string and returns `<1m`, `Nm`, `Nh`, `Nd` — perfect for a hover tooltip. Re-using it avoids a new utility.

6. **Update ReviewQueue/PendingApprovalCard** in `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx`:
   - Import `useRunStuckDetails`:
     ```ts
     import { useRunStuckDetails } from '../../stores/reviewQueueSlice';
     ```
   - Inside `CardChrome`, replace the existing `stuckReason` prop pass-through with:
     ```ts
     const { reason: stuckReasonObj, detectedAt } = useRunStuckDetails(isStuck ? runId : undefined);
     const stuckReasonLabel = stuckReasonObj ? stuckReasonObj.kind : stuckReason; // fall back to legacy prop
     ...
     {isStuck && <StuckBadge reason={stuckReasonLabel} detectedAt={detectedAt} />}
     ```
   - Keep the `stuckReason?: string | null` prop on `PendingApprovalCardProps` for backward compatibility with the test mock (and any future passthrough), but mark it deprecated in JSDoc: "Prefer letting the card resolve reason+detectedAt from useRunStuckDetails by runId."

7. **Update ReviewQueueView wiring (from TASK-622).** Now that the card resolves its own reason+detectedAt by runId, remove any stuckReason prop pass that TASK-622 may have added. The QueueRow helper from TASK-622 only needs to pass `item`, `isFocused`, and `runStatus` — drop `stuckReason` if present.

8. **Add slice tests** in `frontend/src/stores/__tests__/reviewQueueSlice.test.ts`:
   - "applyStuckEvent writes reason and detectedAt when provided" — call `applyStuckEvent({ runId: 'r1', reason: { kind: 'self_deadlock' }, detectedAt: 1700000000000 })`, assert all three maps populated.
   - "applyStuckEvent without reason/detectedAt only writes runStatusMap" — assert `runReasonMap` and `runDetectedAtMap` remain `{}` afterwards (with `'r1' in map === false`).
   - "useRunStuckDetails returns map values" — use `renderHook` (or call the underlying selector directly via store.getState — the slice test file already operates on the store directly, follow that style: set state, then read `useReviewQueueSlice.getState().runReasonMap['r1']`).
   - Update existing `beforeEach` blocks to also reset `runReasonMap: {}` and `runDetectedAtMap: {}` alongside `runStatusMap: {}`.

9. **Add component tests** in `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx`:
   - Before the test that asserts `StuckBadge shows stuckReason as tooltip title attribute`, seed the slice via:
     ```ts
     import { useReviewQueueSlice } from '../../../stores/reviewQueueSlice';
     ...
     useReviewQueueSlice.setState({
       runStatusMap: { [baseApproval.runId]: 'stuck' },
       runReasonMap: { [baseApproval.runId]: { kind: 'cross_run_deadlock', conflictingRunId: 'run-other' } },
       runDetectedAtMap: { [baseApproval.runId]: Date.now() - 120_000 }, // 2m ago
     });
     ```
     Then render `<PendingApprovalCard item={singleItem} runStatus="stuck" />` and assert `screen.getByText('STUCK')` has a `title` attribute containing both `cross_run_deadlock` and `2m`.
   - Add a second test where `runDetectedAtMap` is empty for the runId, assert title contains the reason text but NOT a relative time suffix.

10. **Run typecheck + tests:**
   ```
   pnpm typecheck
   pnpm --filter cyboflow-frontend test -- --run frontend/src/stores/__tests__/reviewQueueSlice.test.ts frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
   ```

## Acceptance Criteria

- All criteria in the frontmatter list. The slice now carries reason + detectedAt, StuckBadge renders a richer tooltip, and the card resolves the data internally via the selector.

## Test Strategy

Three new slice unit tests (reason+detectedAt write paths and the new selector), two new card component tests (title with and without detectedAt suffix). Existing tests in both files must continue to pass after the `beforeEach` reset blocks are extended to clear the new maps. No new test files are created.

## Hardest Decision

Where to put the `reason → string` conversion for display. The canonical `StuckReason` is a discriminated union (`{kind: 'self_deadlock'} | {kind: 'cross_run_deadlock', conflictingRunId} | ...`) but `StuckBadge` accepts a flat `reason?: string | null`. Three options: (a) push a `stuckReasonLabel(reason: StuckReason): string` helper alongside `stuckReasonText` in `useStuckNotifications.ts` and re-use it, (b) accept a `StuckReason` object directly in StuckBadge and format inside, (c) keep the badge string-based and format in PendingApprovalCard. Chose (c) for the smallest change: the badge stays a dumb presentational component and only PendingApprovalCard needs to know the discriminated union exists. If future surfaces need a richer label (e.g. exposing the conflictingRunId for cross_run_deadlock), promote (a).

## Rejected Alternatives

- **Single `runStuckDetailsMap: Record<runId, { status, reason, detectedAt }>` instead of three parallel maps.** Rejected because the existing `runStatusMap` already has well-tested terminal-status eviction logic in `setRunStatus`. Folding reason+detectedAt into the same map would require re-thinking eviction semantics. Parallel maps are cheap (small N) and let `setRunStatus`'s eviction logic stay scoped to status.
- **Always render the detectedAt suffix on the badge text itself (e.g. `STUCK 2m`).** Rejected because the badge's compactness is a visual-design property (per StuckBadge JSDoc: "small, bold, red"). The tooltip is the right surface for additional context.

## Lowest Confidence Area

The `shallow` equality choice in `useRunStuckDetails`. Zustand v4's `useStore(selector, equality)` form requires the equality function — verifying its current API exposes `shallow` from `'zustand/shallow'` matters. If the project's Zustand version doesn't export that path, fall back to deconstructing into two `useReviewQueueSlice(s => ...)` calls inside the hook (one per field) to avoid the equality issue entirely. The trade-off is two store subscriptions per card instead of one — negligible for review queue sizes.
