---
id: TASK-668
idea: SPRINT-023
status: in-flight
created: "2026-05-19T00:00:00Z"
files_owned:
  - shared/types/stuckDetection.ts
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/hooks/useStuckNotifications.ts
  - frontend/src/hooks/__tests__/useStuckNotifications.test.ts
files_readonly:
  - frontend/src/App.tsx
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
  - frontend/src/stores/__tests__/reviewQueueSlice.test.ts
  - frontend/src/utils/trpcClient.ts
acceptance_criteria:
  - criterion: "`StuckEventsClient` interface is declared exactly once across the repo, exported from `shared/types/stuckDetection.ts`."
    verification: "grep -rn 'interface StuckEventsClient' shared/ frontend/ main/ returns exactly 1 hit, located in shared/types/stuckDetection.ts; grep -rn 'StuckEventsClient' frontend/src returns only import statements (no local interface declarations)."
  - criterion: "`useStuckNotifications.ts` no longer opens its own `trpc.cyboflow.events.onStuckDetected` subscription."
    verification: "grep -n 'trpc.cyboflow.events' frontend/src/hooks/useStuckNotifications.ts returns 0 matches; grep -n 'onStuckDetected' frontend/src/hooks/useStuckNotifications.ts returns 0 matches."
  - criterion: "`useStuckNotifications.ts` triggers its notification side effect by observing `useReviewQueueSlice.runStatusMap` transitions to `'stuck'` (and reads reason via `useReviewQueueSlice.runReasonMap`)."
    verification: "grep -nE 'useReviewQueueSlice|runStatusMap|runReasonMap' frontend/src/hooks/useStuckNotifications.ts returns >=1 match referencing the slice."
  - criterion: Only one subscription to `cyboflow.events.onStuckDetected` is opened per App mount (in `reviewQueueSlice.subscribeToStuckEvents`).
    verification: "grep -rn 'onStuckDetected.subscribe' frontend/src returns exactly 1 hit, located in frontend/src/stores/reviewQueueSlice.ts."
  - criterion: "`useStuckNotifications.test.ts` no longer mocks `trpc.cyboflow.events.onStuckDetected` (the hook is now slice-driven). Tests drive the hook by setting slice state directly."
    verification: "grep -n 'onStuckDetected' frontend/src/hooks/__tests__/useStuckNotifications.test.ts returns 0 matches; grep -nE 'useReviewQueueSlice.setState|applyStuckEvent' frontend/src/hooks/__tests__/useStuckNotifications.test.ts returns >=1 match."
  - criterion: pnpm typecheck and pnpm lint pass.
    verification: "pnpm typecheck && pnpm lint exit 0"
  - criterion: frontend unit tests pass.
    verification: "cd frontend && pnpm test:unit -- reviewQueueSlice useStuckNotifications exit 0"
depends_on: []
estimated_complexity: medium
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "Both the slice and the hook own behavior changes (single subscription, slice-driven notification). Existing test files must be updated to reflect the new shape and to verify the de-duplicated subscription contract."
  targets:
    - behavior: "Notification fires exactly once per runId transition into 'stuck' when driven by the slice (not by direct tRPC emission)."
      test_file: frontend/src/hooks/__tests__/useStuckNotifications.test.ts
      type: unit
    - behavior: Subsequent stuck transitions for same runId in slice do not re-fire notification (per-launch dedupe still works).
      test_file: frontend/src/hooks/__tests__/useStuckNotifications.test.ts
      type: unit
    - behavior: Notification respects `notifications.enabled === false` gate even when slice transitions to stuck.
      test_file: frontend/src/hooks/__tests__/useStuckNotifications.test.ts
      type: unit
    - behavior: "`useReviewQueueSlice.subscribeToStuckEvents` continues to consume `StuckEventsClient` shape from the shared type (compile-time check + runtime smoke)."
      test_file: frontend/src/stores/__tests__/reviewQueueSlice.test.ts
      type: unit
---
# Extract shared StuckEventsClient type and de-duplicate stuck-event tRPC subscription

## Objective

SPRINT-023 introduced two parallel subscribers to `trpc.cyboflow.events.onStuckDetected`: `useReviewQueueSlice.subscribeToStuckEvents()` (mounted at `App.tsx:91-95`, TASK-622) and `useStuckNotifications()` (mounted at `App.tsx:80`, TASK-623). Both declare a verbatim-duplicated local `interface StuckEventsClient` and both open their own subscription via `trpc.cyboflow.events.onStuckDetected.subscribe(...)`. Every stuck event therefore travels two parallel observer chains. This task collapses the surface to a single subscription owned by the slice and reshapes `useStuckNotifications` to derive its notification trigger reactively from slice state. The `StuckEventsClient` interface is promoted to `shared/types/stuckDetection.ts` so any future consumer imports rather than re-declares it.

## Implementation Steps

1. **Pre-flight grep — confirm current duplication state and capture call sites:**
   - `grep -rn 'interface StuckEventsClient' shared/ frontend/ main/`
   - `grep -rn 'onStuckDetected.subscribe' frontend/src`
   - Expected current state: two `interface StuckEventsClient` hits (in `frontend/src/stores/reviewQueueSlice.ts` and `frontend/src/hooks/useStuckNotifications.ts`); two `onStuckDetected.subscribe` hits in the same files. If counts differ, stop and reconcile before proceeding.

2. **Promote `StuckEventsClient` to `shared/types/stuckDetection.ts`.** At the end of the existing file, append the interface (uses already-exported `StuckDetectedEvent`):
   ```ts
   // ---------------------------------------------------------------------------
   // tRPC subscription client surface
   //
   // Narrow shape for `trpc.cyboflow.events.onStuckDetected`. Consumers cast the
   // tRPC client through `unknown` until TASK-254 lands the real router type.
   // Promoted out of frontend/ so any consumer imports rather than re-declares.
   // ---------------------------------------------------------------------------
   export interface StuckEventsClient {
     onStuckDetected: {
       subscribe(
         input: undefined,
         callbacks: {
           onData: (event: StuckDetectedEvent) => void;
           onError: (err: unknown) => void;
         },
       ): { unsubscribe(): void };
     };
   }
   ```

3. **Update `frontend/src/stores/reviewQueueSlice.ts`:**
   - Remove the local `interface StuckEventsClient` declaration (lines ~47–57).
   - Add `StuckEventsClient` to the existing import from `../../../shared/types/stuckDetection` (alongside `StuckDetectedEvent`, `StuckReason`).
   - Remove the TASK-503 cross-reference comment from the file header JSDoc (lines ~26–28: "the same pattern used in `useStuckNotifications.ts` (TASK-503)") since that pattern is no longer parallel — replace with a one-line note that `useStuckNotifications` consumes slice state, not its own subscription.
   - Verify the `subscribeToStuckEvents` action still type-checks against the imported `StuckEventsClient`.

4. **Rewrite `frontend/src/hooks/useStuckNotifications.ts` to consume the slice rather than open its own subscription:**
   - Remove the local `interface StuckEventsClient` declaration (lines ~40–50) and its surrounding header comment block.
   - Remove the `import { trpc } from '../utils/trpcClient'` import.
   - Add `import { useReviewQueueSlice } from '../stores/reviewQueueSlice'`.
   - Replace the second `useEffect` (lines ~106–146, the one that opens the tRPC subscription) with a Zustand `subscribe`-based effect that watches `runStatusMap` for transitions into `'stuck'`. Concretely:
     ```ts
     useEffect(() => {
       // Snapshot of runIds we have seen as stuck — used to detect transitions
       // (a runId entering the map at 'stuck' or moving from non-stuck → 'stuck').
       // Initialize from current state so a stuck entry already present at mount
       // does NOT immediately re-fire — first-real-transition semantics.
       const prevStuck = new Set<string>(
         Object.entries(useReviewQueueSlice.getState().runStatusMap)
           .filter(([, status]) => status === 'stuck')
           .map(([runId]) => runId),
       );

       const unsubscribe = useReviewQueueSlice.subscribe((state) => {
         for (const [runId, status] of Object.entries(state.runStatusMap)) {
           if (status !== 'stuck') continue;
           if (prevStuck.has(runId)) continue;
           prevStuck.add(runId);

           // Per-app-launch suppression
           if (notifiedRunsRef.current.has(runId)) continue;
           if (!settings.enabled) continue;
           notifiedRunsRef.current.add(runId);

           const reason = state.runReasonMap[runId];
           requestPermission().then((hasPermission) => {
             if (!hasPermission) return;
             new Notification('Run Stuck ⚠️', {
               body: reason
                 ? `Run ${runId.slice(0, 8)} is stuck: ${stuckReasonText(reason)}`
                 : `Run ${runId.slice(0, 8)} is stuck`,
               icon: '/favicon.ico',
               badge: '/favicon.ico',
               requireInteraction: false,
             });
           }).catch((err: unknown) => {
             console.warn('[useStuckNotifications] Failed to show notification:', err);
           });
         }
       });

       return unsubscribe;
     }, [settings.enabled]);
     ```
   - Update the file-header JSDoc to reflect the new contract: "Observes `useReviewQueueSlice.runStatusMap` for transitions into `'stuck'` and fires exactly one macOS notification per `runId` per app launch. The slice owns the tRPC subscription; this hook is a downstream observer."
   - Reason lookup falls back to a runId-only message if `runReasonMap[runId]` is absent (slice may write status before reason in a race-free design, but the type allows reason to be optional).

5. **Update `frontend/src/hooks/__tests__/useStuckNotifications.test.ts`:**
   - Remove the entire `vi.mock('../../utils/trpcClient', ...)` block — the hook no longer imports `trpc`.
   - Remove the `makeFakeSubscription`, `onDataCallback`, and `emitStuck` helpers — replace with a helper that drives the slice directly:
     ```ts
     import { useReviewQueueSlice } from '../../stores/reviewQueueSlice';

     function emitStuck(event: StuckDetectedEvent) {
       act(() => {
         useReviewQueueSlice.getState().applyStuckEvent({
           runId: event.runId,
           reason: event.reason,
           detectedAt: event.detectedAt,
         });
       });
     }
     ```
   - In `beforeEach`, reset the slice: `useReviewQueueSlice.setState({ runStatusMap: {}, runReasonMap: {}, runDetectedAtMap: {} });`
   - Keep all six existing test cases — they assert behavior (notification fires/suppresses, title contains emoji, body matches reason text, etc.) which remains true under the new wiring. The only mechanical change is `emitStuck` now drives the slice instead of the fake subscription.
   - Adjust the "different runId" and "second runId" assertions to confirm that two separate `applyStuckEvent` calls (each with distinct runIds) produce two notifications.
   - Keep the "remount resets suppression set" test — the `notifiedRunsRef` lives in the hook, not the slice, so remounting still resets it. Between mounts, also reset the slice so the second-mount transition is a fresh entry (otherwise `prevStuck` initialization from current state would mask the transition).

6. **Audit `App.tsx`:** confirm there is still exactly one call site each — `useStuckNotifications()` on line ~80 and `useReviewQueueSlice((s) => s.subscribeToStuckEvents)` followed by the `useEffect` that calls it on lines ~91-95. Do NOT touch App.tsx; the mount points stay where they are.

7. **Audit `frontend/src/components/__tests__/ReviewQueueView.test.tsx`** (readonly): the existing `vi.mock('../../utils/trpcClient', ...)` mock there must remain — `ReviewQueueView`'s slice still subscribes. Verify no changes needed.

8. **Completeness gate — re-run the pre-flight greps:**
   - `grep -rn 'interface StuckEventsClient' shared/ frontend/ main/` → 1 hit (shared/types/stuckDetection.ts).
   - `grep -rn 'onStuckDetected.subscribe' frontend/src` → 1 hit (frontend/src/stores/reviewQueueSlice.ts).
   - `grep -n 'trpc.cyboflow.events' frontend/src/hooks/useStuckNotifications.ts` → 0 hits.

9. **Run `pnpm typecheck && pnpm lint && cd frontend && pnpm test:unit -- reviewQueueSlice useStuckNotifications`.** Confirm all green.

## Acceptance Criteria

- `StuckEventsClient` declared once, in `shared/types/stuckDetection.ts`. (greps above)
- `useStuckNotifications.ts` does not reference `trpc` or `onStuckDetected` symbols.
- `useStuckNotifications.ts` imports and reads `useReviewQueueSlice`.
- Exactly one `onStuckDetected.subscribe` call site survives (in the slice).
- `useStuckNotifications.test.ts` no longer mocks `onStuckDetected`; it drives the hook by manipulating slice state.
- `pnpm typecheck`, `pnpm lint`, and the targeted unit tests all pass.

## Test Strategy

Six existing test cases stay in `useStuckNotifications.test.ts` but are rewired to drive the slice via `applyStuckEvent` instead of a fake subscription. Add no new test files. The slice's existing `reviewQueueSlice.test.ts` already covers `applyStuckEvent` behavior; we extend it only if a compile-time regression slips through (unlikely — TypeScript should catch interface-import mismatches).

The remount-resets-suppression test needs careful handling: the new effect snapshots `prevStuck` from current slice state on mount, so the test must reset slice state between the two `renderHook` invocations (otherwise the stuck entry from mount 1 would be in `prevStuck` at mount 2 and the second notification would not fire). Add the reset inside the test rather than into `beforeEach` since other tests rely on cross-emit behavior within one mount.

## Hardest Decision

**Slice transition detection model.** Three candidates were considered:
- **(a) Zustand `subscribe` callback that diffs `runStatusMap` snapshots.** Chosen. Plays naturally with Zustand's reactivity, no need to change slice surface, and the `prevStuck` set is small (≤ count of stuck runs) so the diff cost is bounded.
- **(b) Add an event emitter to the slice — slice fires `'stuck-detected'` events that the hook listens to.** Rejected: introduces a new event channel parallel to the existing Zustand notifier, which is exactly the duplication we are removing.
- **(c) Have the slice expose a hook like `useStuckTransitions(callback)` that internally manages the diff.** Rejected as over-engineering for one consumer; if a second consumer appears, refactor then.

The `prevStuck` initialization-from-current-state semantic (rather than from `new Set()`) matters: if a stuck entry is already present at hook mount (e.g. the slice resync populated it before App mounted the hook), we do NOT want to fire a notification for a pre-existing state. Only true *transitions* observed during this hook's lifetime trigger.

## Rejected Alternatives

- **Keep both subscriptions but share the interface.** Considered as a smaller diff (just promote the interface, leave the subscriptions). Rejected because the work item explicitly calls out the doubled subscription as a defect — every stuck event still traverses two observer chains, the GC profile is two subscription closures instead of one, and the duplication is the root cause we are removing. Would reverse if a sibling task surfaces a reason to keep `useStuckNotifications` independently subscribable (e.g. running outside an App context).
- **Move the notification side effect entirely into the slice (no `useStuckNotifications` hook at all).** Rejected: the slice should not own DOM/Notification API side effects. Settings gating (`notifications.enabled`) lives in React state (`useState` + `API.config.get()` on mount), and `requestPermission()` is a browser API the slice has no business calling. Reversal trigger: if the slice grows other DOM-side-effect responsibilities and the layering blurs anyway, fold them together.

## Lowest Confidence Area

The Zustand `subscribe` re-fire frequency. Zustand notifies subscribers on every `set` — even if the field the callback inspects (`runStatusMap`) did not change. The diff-against-`prevStuck` guard prevents duplicate notifications, but the callback walks `Object.entries(state.runStatusMap)` on every slice mutation (including unrelated mutations to `runReasonMap` or `runDetectedAtMap`). For typical sizes (single-digit stuck runs at any time) this is fine; if `runStatusMap` ever grows large, a selector-scoped subscription (`useReviewQueueSlice.subscribe(s => s.runStatusMap, ...)`) would be a one-line optimization. Not adding it now to keep the diff minimal.
