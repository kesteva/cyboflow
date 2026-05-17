---
id: TASK-622
idea: SPRINT-013
status: ready
created: 2026-05-17T00:00:00Z
files_owned:
  - frontend/src/components/ReviewQueueView.tsx
  - main/src/index.ts
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
files_readonly:
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - frontend/src/components/PendingApprovalCard.tsx
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/App.tsx
  - frontend/src/hooks/useStuckNotifications.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/cancelAndRestartHandler.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - shared/types/cyboflow.ts
  - shared/types/stuckInspection.ts
  - shared/types/stuckDetection.ts
acceptance_criteria:
  - criterion: "ReviewQueueView imports PendingApprovalCard from './ReviewQueue/PendingApprovalCard' (the stuck-aware variant), not './PendingApprovalCard'."
    verification: "grep -n \"from './PendingApprovalCard'\" frontend/src/components/ReviewQueueView.tsx returns 0 matches AND grep -n \"from './ReviewQueue/PendingApprovalCard'\" frontend/src/components/ReviewQueueView.tsx returns exactly 1 match."
  - criterion: "ReviewQueueView passes runStatus and stuckReason props derived from useReviewQueueSlice.runStatusMap to each PendingApprovalCard."
    verification: "grep -n 'runStatus=' frontend/src/components/ReviewQueueView.tsx returns at least 2 matches (one per blocking / normal map), and the value is read from useReviewQueueSlice (grep -n 'useReviewQueueSlice' frontend/src/components/ReviewQueueView.tsx returns at least 1 match)."
  - criterion: "A new useRunStatus(runId) selector hook is exported from reviewQueueSlice.ts and used by ReviewQueueView (or the slice store is read inline with an equivalent selector)."
    verification: "grep -n 'export function useRunStatus' frontend/src/stores/reviewQueueSlice.ts returns 1 match, and grep -n 'useRunStatus' frontend/src/components/ReviewQueueView.tsx returns at least 1 match."
  - criterion: "subscribeToStuckEvents() from useReviewQueueSlice is mounted exactly once at app top-level with a useEffect that returns the unsubscribe."
    verification: "grep -n 'subscribeToStuckEvents' frontend/src/App.tsx returns at least 2 matches (import + invocation), and grep -n 'useReviewQueueSlice' frontend/src/App.tsx returns at least 1 match."
  - criterion: "main/src/index.ts calls setCancelAndRestartDeps({ db, approvalRouter, runQueues, claudeManagerStop }) exactly once during bootstrap after ApprovalRouter.initialize."
    verification: "grep -n 'setCancelAndRestartDeps' main/src/index.ts returns exactly 2 matches (import + call), and the call appears after the line containing 'ApprovalRouter.initialize'."
  - criterion: "claudeManagerStop is provided as a bound (sessionId: string) => Promise<void> delegating to defaultCliManager.stopPanel."
    verification: "grep -nE 'claudeManagerStop\\s*:\\s*' main/src/index.ts returns 1 match whose RHS references defaultCliManager.stopPanel (verify by reading the surrounding 3 lines)."
  - criterion: "The known-limitation comment 'clearPendingForRun is a no-op until TASK-304' is present near the setCancelAndRestartDeps call in main/src/index.ts."
    verification: "grep -n 'TASK-304' main/src/index.ts returns at least 1 match within 10 lines of the line containing 'setCancelAndRestartDeps'."
  - criterion: "pnpm typecheck succeeds across all workspaces with no new errors."
    verification: "Run 'pnpm typecheck' from repo root; exit 0."
  - criterion: "Existing test suites still pass and the updated ReviewQueueView.test.tsx covers the new import + prop wiring."
    verification: "Run 'pnpm --filter cyboflow-frontend test -- --run' (or equivalent); exit 0. ReviewQueueView.test.tsx imports from '../ReviewQueue/PendingApprovalCard' (or mocks that path) and asserts the new card receives runStatus when the slice's runStatusMap has the runId."
depends_on: []
estimated_complexity: medium
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "Wiring touches the existing ReviewQueueView.test.tsx (mock path must move) and warrants a slice-driven prop-propagation test."
  targets:
    - behavior: "ReviewQueueView passes runStatus='stuck' to PendingApprovalCard for runs whose runId is in useReviewQueueSlice.runStatusMap as 'stuck'."
      test_file: "frontend/src/components/__tests__/ReviewQueueView.test.tsx"
      type: component
    - behavior: "ReviewQueueView passes runStatus=undefined for runs not in runStatusMap."
      test_file: "frontend/src/components/__tests__/ReviewQueueView.test.tsx"
      type: component
    - behavior: "useRunStatus(runId) selector returns the value from runStatusMap or undefined (pure unit test against the Zustand store)."
      test_file: "frontend/src/stores/__tests__/reviewQueueSlice.test.ts"
      type: unit
---

# Wire stuck-detection UI: ReviewQueueView card swap, subscription mount, cancelAndRestart deps

## Objective

The stuck-detection epic (TASK-501–504) is fully built but invisible at runtime due to three disconnects: ReviewQueueView imports the base PendingApprovalCard instead of the stuck-aware one, no consumer ever mounts useReviewQueueSlice.subscribeToStuckEvents, and main/src/index.ts never calls setCancelAndRestartDeps so the cancelAndRestart mutation throws METHOD_NOT_SUPPORTED. This task wires all three so that when StuckDetector emits a runs:stuck event the UI renders the STUCK badge, "Why stuck?" button, and "Cancel and restart" button, and pressing Cancel and restart actually stops the Claude SDK run and inserts a new workflow_runs row.

## Implementation Steps

1. **Add the useRunStatus selector to reviewQueueSlice.** In `frontend/src/stores/reviewQueueSlice.ts`, export a new selector hook below the store definition:
   ```ts
   export function useRunStatus(runId: string | undefined): WorkflowRunStatus | undefined {
     return useReviewQueueSlice((s) => (runId ? s.runStatusMap[runId] : undefined));
   }
   ```
   No change to existing state shape (B4 will add reason/detectedAt persistence as a follow-up task).

2. **Swap the import in ReviewQueueView.tsx.** Change line 3 from `import { PendingApprovalCard } from './PendingApprovalCard';` to `import { PendingApprovalCard } from './ReviewQueue/PendingApprovalCard';`. Add `import { useRunStatus } from '../stores/reviewQueueSlice';` near the existing store imports.

3. **Thread runStatus into each card render.** In the two `<PendingApprovalCard ... />` JSX sites (lines ~124 and ~137 of the current file), compute and pass the prop. The runId for both card kinds resolves through `item.kind === 'single' ? item.approval.runId : item.runId` — extract a small helper at the top of the component file:
   ```ts
   function itemRunId(item: QueueItem): string {
     return item.kind === 'single' ? item.approval.runId : item.runId;
   }
   ```
   Then inside the map functions: `const runStatus = useRunStatus(itemRunId(item));` and pass `runStatus={runStatus}` to the card. The new card already accepts `stuckReason?: string | null` — leave that undefined for this task; B4 will populate it.

   Note: calling `useRunStatus` inside `.map()` is a hooks-rules violation. Instead, render each row through a small inline child component, e.g.:
   ```tsx
   function QueueRow({ item, isFocused }: { item: QueueItem; isFocused: boolean }) {
     const runStatus = useRunStatus(itemRunId(item));
     return <PendingApprovalCard item={item} isFocused={isFocused} runStatus={runStatus} />;
   }
   ```
   Use `<QueueRow ... />` in the two map calls.

4. **Mount subscribeToStuckEvents at app top-level.** In `frontend/src/App.tsx`, near the existing `const { subscribeToMcpHealth } = useMcpHealthStore();` block (around line 86–90), add an analogous wiring for the stuck-events subscription:
   ```ts
   import { useReviewQueueSlice } from './stores/reviewQueueSlice';
   ...
   const subscribeToStuckEvents = useReviewQueueSlice((s) => s.subscribeToStuckEvents);
   useEffect(() => {
     const unsubscribe = subscribeToStuckEvents();
     return unsubscribe;
   }, [subscribeToStuckEvents]);
   ```

5. **Add the cancelAndRestart deps wiring in main/src/index.ts.** Add the import near the other orchestrator imports at the top:
   ```ts
   import { setCancelAndRestartDeps } from './orchestrator/trpc/routers/runs';
   ```
   Inside the `app.whenReady().then(async () => { ... { ... ApprovalRouter.initialize(...) } })` block, immediately after the `ApprovalRouter.initialize(db, runQueues.getOrCreate.bind(runQueues));` line, add:
   ```ts
   // Known limitation: ApprovalRouter.clearPendingForRun is still a documented no-op
   // until TASK-304 lands. The Cancel-and-restart button therefore stops the Claude
   // SDK run and updates DB rows, but does not yet send deny-replies on the
   // permission socket. See approvalRouter.ts:328–337.
   setCancelAndRestartDeps({
     db,
     approvalRouter: ApprovalRouter.getInstance(),
     runQueues,
     claudeManagerStop: (sessionId: string) => defaultCliManager.stopPanel(sessionId),
     logger: loggerLike,
   });
   console.log('[Main] cancelAndRestart deps wired');
   ```
   Note: the handler's `claudeManagerStop(sessionId)` is invoked with `runId` (see cancelAndRestartHandler.ts:130 and the JSDoc on CancelAndRestartDeps.claudeManagerStop). For cyboflow workflow runs the SDK keys its sdkRuns by panelId which equals the runId, so delegating to `defaultCliManager.stopPanel(sessionId)` is correct (claudeCodeManager.ts:637).

6. **Update ReviewQueueView.test.tsx mock path.** The existing mock `vi.mock('../PendingApprovalCard', ...)` (line 41) must move to `vi.mock('../ReviewQueue/PendingApprovalCard', ...)` to match the new import. Also extend the mock to receive `runStatus` and expose it via a data attribute so the new prop-propagation tests can assert it:
   ```tsx
   vi.mock('../ReviewQueue/PendingApprovalCard', () => ({
     PendingApprovalCard: ({ item, runStatus }: { item: QueueItem; runStatus?: string }) => {
       const toolName = item.kind === 'single' ? item.approval.toolName : item.toolName;
       return <div data-testid="pending-approval-card" data-run-status={runStatus ?? ''}>{toolName}</div>;
     },
   }));
   ```

7. **Add two new ReviewQueueView tests** verifying:
   (a) When `useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'stuck' } })` is set before render, the card whose item has runId 'run-1' has `data-run-status="stuck"`.
   (b) When runStatusMap is empty, every card has `data-run-status=""` (undefined coerced via `?? ''`).
   Mock the slice the same way the existing reviewQueueStore is mocked (or import and use `useReviewQueueSlice.setState` directly — vitest's jsdom env supports it).

8. **Add one new reviewQueueSlice test** for `useRunStatus`: set state, call the hook via `renderHook`, assert returned value tracks the map; clear the entry and assert it returns undefined.

9. **Run typecheck and tests as completeness gate:**
   ```
   pnpm typecheck
   pnpm --filter cyboflow-frontend test -- --run
   pnpm --filter cyboflow-main test -- --run
   ```

## Acceptance Criteria

- All criteria in the frontmatter list. The two grep-style criteria for the ReviewQueueView import must each match exactly the numbers stated (0 matches for the base path, 1 match for the ReviewQueue path).

## Test Strategy

Component tests update the existing `ReviewQueueView.test.tsx` to (1) move the `vi.mock('../PendingApprovalCard', …)` path to `'../ReviewQueue/PendingApprovalCard'` and (2) assert prop propagation from `useReviewQueueSlice.runStatusMap` → `PendingApprovalCard runStatus`. The Zustand slice gains one unit test for `useRunStatus(runId)`. No changes are required to `PendingApprovalCard.test.tsx` (base card test) or `ReviewQueue/PendingApprovalCard.test.tsx` (already exists and covers stuck UI behaviors). The main-process wiring is verified by the existing `cancelAndRestart.test.ts` unit tests of the handler itself — no new main-process test is needed because the wiring lines are themselves trivial bindings; their correctness is asserted by the grep-style ACs above plus the fact that `pnpm typecheck` will catch arity / type mismatches.

## Hardest Decision

Whether to expose `useRunStatus` from the slice file or inline the `useReviewQueueSlice(s => s.runStatusMap[runId])` selector at each call site in ReviewQueueView. Chose the exported hook for two reasons: (1) it satisfies the brief's "Add a useRunStatus(runId) selector" directive, and (2) future call sites (B4 will need `useRunStuckDetails`, the StuckInspectorModal already exists) benefit from a single canonical selector that can later memoize when the slice grows. The cost is one new export.

## Rejected Alternatives

- **Mount subscribeToStuckEvents inside ReviewQueueView instead of App.** Rejected for parity with useStuckNotifications which is mounted at App top-level so the subscription survives view unmount. Symmetry matters because both subscriptions share the same forward-looking `cyboflow.events.onStuckDetected` tRPC channel.
- **Delete the base PendingApprovalCard.tsx now.** Rejected because PendingApprovalCard.test.tsx still imports it and tests pure behavior, and the file is referenced as a fallback in `docs/CODE-PATTERNS.md`-style precedent. A separate, scoped task can collapse the duplication later — out of scope here.
- **Provide claudeManagerStop via a wrapper that catches and logs errors at the call site rather than relying on the handler's try/catch.** Rejected because the handler already wraps `claudeManagerStop` in try/catch (cancelAndRestartHandler.ts:129–136) and logs via the injected logger. Duplicating that defensive code at the wiring site is redundant.

## Lowest Confidence Area

The `claudeManagerStop: (sessionId) => defaultCliManager.stopPanel(sessionId)` mapping assumes ClaudeCodeManager keys its `sdkRuns` map by `panelId === runId` for cyboflow workflow runs. That assumption is documented in `CancelAndRestartDeps.claudeManagerStop` JSDoc (cancelAndRestartHandler.ts:31–35) but has not been exercised end-to-end since the cyboflow runs subsystem is still under construction. If a future task discovers the runId is not the panel key, this wiring will need to translate runId → panelId via a registry lookup. Today, stopPanel on an unknown panelId returns silently (claudeCodeManager.ts:538–544), so a mismatch produces a silent no-op rather than a crash — acceptable for v1 wiring.
