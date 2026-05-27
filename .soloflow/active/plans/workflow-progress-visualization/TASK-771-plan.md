---
id: TASK-771
idea: IDEA-026
status: ready
created: "2026-05-26T16:00:00Z"
files_owned:
  - frontend/src/hooks/useWorkflowPhaseState.ts
  - frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
files_readonly:
  - frontend/src/components/cyboflow/WorkflowCanvas.tsx
  - frontend/src/components/cyboflow/WorkflowStepCard.tsx
  - frontend/src/components/cyboflow/WorkflowCanvasEdges.tsx
  - frontend/src/hooks/useWorkflowTokenAnimation.ts
  - shared/types/workflows.ts
  - frontend/src/trpc/client.ts
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/test/setup.ts
  - frontend/src/hooks/__tests__/useStuckNotifications.test.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - .soloflow/active/research/IDEA-026-research.md
acceptance_criteria:
  - criterion: "useWorkflowPhaseState(runId) is exported from frontend/src/hooks/useWorkflowPhaseState.ts with return shape { definition, currentStepId, stepStates, isLoading, error }."
    verification: "grep -n 'export function useWorkflowPhaseState' frontend/src/hooks/useWorkflowPhaseState.ts; grep -n 'definition' && 'currentStepId' && 'stepStates' && 'isLoading' && 'error' each return at least 1 match."
  - criterion: "Hook returns { definition: null, currentStepId: null, stepStates: [], isLoading: false, error: null } when runId === null without invoking tRPC procedures."
    verification: "pnpm --filter frontend test useWorkflowPhaseState — 'null runId' test passes; spies on query/subscribe not called."
  - criterion: "Hook calls trpc.cyboflow.runs.getPhaseState.query({ runId }) exactly once per non-null runId on mount and merges resolved value into state."
    verification: "pnpm --filter frontend test useWorkflowPhaseState — 'initial fetch' test passes; query spy invoked once with { runId: 'r1' } and returned state reflects fixture."
  - criterion: "Hook subscribes to trpc.cyboflow.runs.onStepTransition.subscribe({ runId }, { onData, onError }) and on each onData call merges WorkflowStepTransitionEvent into state. Pre-current → 'done', current → event.status (typically 'running', 'done' valid), post-current → 'pending'."
    verification: "pnpm --filter frontend test useWorkflowPhaseState — 'subscription delta merge' test passes."
  - criterion: Hook calls subscription.unsubscribe() on unmount AND when runId changes (no leaked subscriptions).
    verification: "pnpm --filter frontend test useWorkflowPhaseState — 'unsubscribes on unmount' and 'unsubscribes on runId change' tests pass."
  - criterion: Hook surfaces tRPC errors from both query() rejection and subscription onError into error field without throwing.
    verification: "pnpm --filter frontend test useWorkflowPhaseState — 'query error' and 'subscription error' tests pass; both produce non-null error in hook return without uncaught rejection."
  - criterion: pnpm typecheck succeeds at repo root with no new errors attributable to this hook.
    verification: "pnpm typecheck 2>&1 | tail -50 — exit 0; no error lines mentioning useWorkflowPhaseState.ts."
  - criterion: pnpm lint succeeds with no no-explicit-any violations introduced.
    verification: "pnpm lint 2>&1 | grep -E 'useWorkflowPhaseState|no-explicit-any' — empty output."
depends_on:
  - TASK-766
  - TASK-769
  - TASK-770
estimated_complexity: medium
epic: workflow-progress-visualization
test_strategy:
  needed: true
  justification: "This hook is the load-bearing bridge between live tRPC state and the canvas's visual state. Without unit tests, regressions in the query/subscription lifecycle silently break the canvas in production with no failing build signal."
  targets:
    - behavior: Null runId — returns empty state and does not call tRPC.
      test_file: frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
      type: unit
    - behavior: Initial getPhaseState.query resolves and populates definition/currentStepId/stepStates.
      test_file: frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
      type: unit
    - behavior: "onStepTransition delta merges: pre-current → done, current → event.status, post-current → pending."
      test_file: frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
      type: unit
    - behavior: Unmount calls subscription.unsubscribe().
      test_file: frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
      type: unit
    - behavior: "Changing runId tears down old subscription, fetches new state, subscribes anew."
      test_file: frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
      type: unit
    - behavior: Query rejection surfaces in error without throwing; isLoading transitions true → false.
      test_file: frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
      type: unit
    - behavior: Subscription onError surfaces in error without throwing.
      test_file: frontend/src/hooks/__tests__/useWorkflowPhaseState.test.tsx
      type: unit
---
# Wire WorkflowCanvas to live tRPC phase state driving card states and token position

## Objective

Ship the read-only React hook `useWorkflowPhaseState(runId)` that bridges the tRPC phase-state surface (TASK-766) to the static WorkflowCanvas shell (TASK-769) and SVG/token layer (TASK-770). The hook owns the per-run subscription lifecycle (initial getPhaseState.query + live onStepTransition.subscribe merge), produces a WorkflowStepState[] the canvas consumes to drive pending/running/done cards, and exposes currentStepId so the RAF token can derive its active edge. This task does NOT modify any UI component — only ships the hook and its tests; the integration call site is owned by TASK-767 (CyboflowRoot).

## Implementation Steps

1. **Read in-repo tRPC pattern**: `frontend/src/trpc/client.ts`, `frontend/src/stores/reviewQueueSlice.ts:180-202`, `frontend/src/stores/mcpHealthStore.ts:96-131`. **Critical:** cyboflow uses vanilla `createTRPCProxyClient` — NOT tRPC v11 React Query integration. IDEA prose mentions useQuery/useSubscription but actual API is `trpc.cyboflow.runs.getPhaseState.query({ runId })` (returns Promise<T>) and `trpc.cyboflow.runs.onStepTransition.subscribe({ runId }, { onData, onError })` (returns { unsubscribe(): void }).

2. **Read TASK-763 types** as landed. Import canonical `WorkflowDefinition`, `WorkflowStepState`, `WorkflowStepTransitionEvent`. If TASK-763's names differ, use TASK-763's. Do NOT modify shared/types/workflows.ts (files_readonly).

3. **Create `useWorkflowPhaseState.ts`** with skeleton:
   ```ts
   export interface UseWorkflowPhaseStateResult {
     definition: WorkflowDefinition | null;
     currentStepId: string | null;
     stepStates: WorkflowStepState[];
     isLoading: boolean;
     error: Error | null;
   }
   export function useWorkflowPhaseState(runId: string | null): UseWorkflowPhaseStateResult { /* … */ }
   ```
   No `any`.

4. **Implement state machine** inside hook. One `useState` snapshot. One `useEffect` keyed on `[runId]`:
   - runId=null → reset to initialState, return.
   - Set isLoading=true. Capture local `cancelled=false`.
   - Call `trpc.cyboflow.runs.getPhaseState.query({ runId })`. On success setSnapshot; on rejection set error.
   - After kicking off query (do NOT await before subscribing), call `subscription = trpc.cyboflow.runs.onStepTransition.subscribe({ runId }, { onData, onError })`.
   - onData(event): setSnapshot(prev => mergeTransition(prev, event)) — pure local function.
   - onError(err): setSnapshot(prev => ({ ...prev, error: ... })). Do NOT log.
   - Cleanup: cancelled=true, subscription.unsubscribe().

5. **mergeTransition(prev, event)** local pure function:
   - Guard: if prev.definition === null, return prev (race protection).
   - Flatten orderedIds from definition.phases.flatMap(p => p.steps).map(s => s.id).
   - idx = orderedIds.indexOf(event.stepId). If -1, return prev (defensive).
   - For each step at i: 'done' if i < idx; event.status if i === idx; 'pending' if i > idx.
   - Return { ...prev, currentStepId: event.stepId, stepStates: newStates, error: null }.

6. **Create `__tests__/useWorkflowPhaseState.test.tsx`** new file. Mock tRPC locally:
   ```ts
   vi.mock('../../trpc/client', () => {
     const subscribeSpy = vi.fn();
     const querySpy = vi.fn();
     return { trpc: { cyboflow: { runs: {
       getPhaseState: { query: querySpy },
       onStepTransition: { subscribe: subscribeSpy },
     } } } };
   });
   ```
   Use renderHook from @testing-library/react. Drive onData by capturing subscribeSpy's second arg and invoking args.onData(syntheticEvent) inside act().

7. **Seven test cases** per test_strategy targets.

8. **Run gates**: `pnpm --filter frontend test useWorkflowPhaseState`, `pnpm typecheck`, `pnpm lint`. All exit 0.

## Acceptance Criteria

See frontmatter — eight verifiable criteria.

## Test Strategy

Seven unit tests in `__tests__/useWorkflowPhaseState.test.tsx`, all using renderHook + per-file `vi.mock('../../trpc/client', ...)` exposing querySpy/subscribeSpy. Mock NOT hoisted to setup.ts (those don't exist on the current global stub and adding them would ripple into unrelated suites).

Fixture: 2-phase × 3-step WorkflowDefinition built inline (independent of TASK-763's exact content).

For delta-merge test: fire synthetic event with stepId='s2', status='running', assert stepStates and currentStepId.

For runId-change test: render with runId='r1', await initial query, rerender with runId='r2', assert previous unsubscribe fired exactly once, second subscribe with new runId.

Do NOT modify `frontend/src/test/setup.ts` — out of scope here.

## Hardest Decision

**The tRPC API mismatch between IDEA prose and actual codebase.** IDEA references `useQuery`/`useSubscription` (React Query integration), but `frontend/src/trpc/client.ts` uses vanilla `createTRPCProxyClient` (no @trpc/react-query). Three options:
- (a) Add @trpc/react-query integration. Rejected — major dependency, conflicts with TASK-766, out of scope.
- (b) Build a `useTRPCQuery` helper wrapping the proxy client. Rejected — duplicates trivial state plumbing.
- (c) Follow actual in-repo API exactly: useState + useEffect + .query() Promise + .subscribe(...).unsubscribe. **Chosen.** Matches reviewQueueSlice.ts:181-202 exactly.

## Rejected Alternatives

- **React Query integration.** Rejected per (a).
- **Zustand slice for phase state** (mirroring reviewQueueSlice). Rejected — canvas state is per-mounted-run, not app-global. Hook with local useState is right scope.
- **Server-pushed full stepStates snapshot on every transition.** Rejected — WorkflowStepTransitionEvent per research Area E is a delta. Would change TASK-766 schema.
- **Imperative ref-based update bypassing React state.** Rejected — research Area B scopes imperative-ref to token animation (TASK-770), not step-state updates which are sparse.

## Lowest Confidence Area

**Exact wire shape of TASK-766 procedure outputs and TASK-765 event type.** Plan assumes:
- `getPhaseState.query` returns `{ definition, currentStepId, stepStates }` directly (not envelope-wrapped).
- `onStepTransition.subscribe` onData receives `{ runId, stepId, status, timestamp }`.
- Server-side input filtering on runId in TASK-766.

If TASK-766 lands with different shape, hook's destructuring needs a one-line adjustment.

Secondary: TASK-767's plan should add `const phaseState = useWorkflowPhaseState(activeRunId)` at the canvas mount site. If TASK-767 didn't include the call, canvas renders only initial empty state — integration gap to flag during verification, not a defect in this task.
