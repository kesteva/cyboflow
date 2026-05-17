---
id: TASK-623
idea: SPRINT-013
status: ready
created: 2026-05-17T00:00:00Z
files_owned:
  - frontend/src/hooks/useStuckNotifications.ts
  - frontend/src/hooks/__tests__/useStuckNotifications.test.ts
files_readonly:
  - shared/types/stuckDetection.ts
  - main/src/orchestrator/stuckDetector.ts
  - frontend/src/stores/reviewQueueSlice.ts
acceptance_criteria:
  - criterion: "useStuckNotifications.ts no longer re-declares StuckDetectedEvent or StuckReasonKind locally; it imports both from '../../../shared/types/stuckDetection'."
    verification: "grep -nE 'export interface StuckDetectedEvent|export type StuckReasonKind' frontend/src/hooks/useStuckNotifications.ts returns 0 matches AND grep -n \"from '../../../shared/types/stuckDetection'\" frontend/src/hooks/useStuckNotifications.ts returns at least 1 match importing StuckDetectedEvent and StuckReason."
  - criterion: "stuckReasonText accepts a StuckReason object and switches on reason.kind, not a bare string."
    verification: "grep -nE 'function stuckReasonText\\(reason: StuckReason\\)|reason: StuckReason' frontend/src/hooks/useStuckNotifications.ts returns at least 1 match AND grep -n 'reason.kind' frontend/src/hooks/useStuckNotifications.ts returns at least 1 match (the switch statement)."
  - criterion: "The suppression key is now event.runId, not event.sessionId."
    verification: "grep -n 'notifiedSessionsRef\\|notifiedRunsRef' frontend/src/hooks/useStuckNotifications.ts shows a ref renamed to notifiedRunsRef (or equivalent runId-keyed name), AND grep -n 'event.sessionId\\|sessionId,' frontend/src/hooks/useStuckNotifications.ts returns 0 matches."
  - criterion: "The notification body no longer references workflowName. It uses runId (truncated) or a generic 'Run is stuck' phrase plus the stuck reason."
    verification: "grep -n 'workflowName' frontend/src/hooks/useStuckNotifications.ts returns 0 matches AND grep -nE 'new Notification\\(' frontend/src/hooks/useStuckNotifications.ts returns 1 match whose body argument references runId or a static 'Run' label (not workflowName)."
  - criterion: "Tests are updated to construct StuckDetectedEvent with { runId, approvalId, reason: {kind: ...}, detectedAt } shape and to assert against the new notification body."
    verification: "grep -nE 'sessionId|workflowName' frontend/src/hooks/__tests__/useStuckNotifications.test.ts returns 0 matches (or only matches inside historical/removed-by-this-task assertions) AND grep -n 'approvalId' frontend/src/hooks/__tests__/useStuckNotifications.test.ts returns at least 1 match AND grep -n 'reason: { kind:' frontend/src/hooks/__tests__/useStuckNotifications.test.ts returns at least 1 match."
  - criterion: "All 6 existing test cases continue to pass after rewriting (renamed to use runId suppression semantics where they tested sessionId)."
    verification: "Run 'pnpm --filter cyboflow-frontend test -- --run frontend/src/hooks/__tests__/useStuckNotifications.test.ts'; exit 0 with 6 passing tests."
  - criterion: "pnpm typecheck succeeds across all workspaces with no new errors."
    verification: "Run 'pnpm typecheck' from repo root; exit 0."
depends_on: []
estimated_complexity: low
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "The existing test file is the only place that constructed events using the diverged local type; rewriting it is required to keep coverage green and now asserts the canonical schema."
  targets:
    - behavior: "First stuck event for a runId fires a notification."
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "Second stuck event with the same runId is suppressed."
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "Different runId fires a second notification."
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "Remount resets the suppression set (in-memory only)."
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "notifications.enabled === false gates the hook."
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "Notification title contains warning emoji; body matches new format using stuck reason from reason.kind."
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
---

# Fix useStuckNotifications StuckDetectedEvent schema divergence

## Objective

`useStuckNotifications` re-declares `StuckDetectedEvent` locally as `{ runId, sessionId, workflowName, reason: StuckReasonKind }` while the orchestrator emits the canonical `{ runId, approvalId, reason: StuckReason, detectedAt }` from `shared/types/stuckDetection.ts`. Today the 6 existing tests pass only because they construct events using the hook's diverged type — once TASK-254 wires the real `cyboflow.events.onStuckDetected` subscription, the hook will receive events with undefined `sessionId` and `workflowName` and never fire a notification (or worse, throw on `reason.toUpperCase()`-shaped helpers). This task aligns the hook with the canonical schema and rewrites the tests against it.

## Implementation Steps

1. **Delete the local type re-declaration.** Remove lines 16–28 of `frontend/src/hooks/useStuckNotifications.ts` (the `StuckReasonKind` type alias and the local `StuckDetectedEvent` interface).

2. **Import the canonical types.** Add at the top of the file:
   ```ts
   import type { StuckDetectedEvent, StuckReason } from '../../../shared/types/stuckDetection';
   ```

3. **Rewrite `stuckReasonText` to accept the object form.** Change the signature and body:
   ```ts
   export function stuckReasonText(reason: StuckReason): string {
     switch (reason.kind) {
       case 'self_deadlock': return 'self-deadlock';
       case 'cross_run_deadlock': return 'cross-run deadlock';
       case 'orphan_pty': return 'Claude process exited';
       case 'stale_socket': return 'permission socket disconnected';
     }
   }
   ```
   TypeScript will check exhaustiveness against the canonical discriminated union.

4. **Replace sessionId suppression with runId suppression.** Rename `notifiedSessionsRef` → `notifiedRunsRef` (still `useRef<Set<string>>(new Set())`). Inside the `onData` callback, change:
   - `const { sessionId, workflowName, reason } = event;` → `const { runId, reason } = event;`
   - `if (notifiedSessionsRef.current.has(sessionId)) return;` → `if (notifiedRunsRef.current.has(runId)) return;`
   - `notifiedSessionsRef.current.add(sessionId);` → `notifiedRunsRef.current.add(runId);`

5. **Rewrite the notification body.** The current body `Run "${workflowName}" is stuck: ${stuckReasonText(reason)}` referenced `workflowName` which no longer exists on the canonical event. Replace with a runId-truncated body (workflow lookup by runId is out of scope here — punt to a future enrichment task):
   ```ts
   new Notification('Run Stuck ⚠️', {
     body: `Run ${runId.slice(0, 8)} is stuck: ${stuckReasonText(reason)}`,
     icon: '/favicon.ico',
     badge: '/favicon.ico',
     requireInteraction: false,
   });
   ```

6. **Rewrite the test file.** In `frontend/src/hooks/__tests__/useStuckNotifications.test.ts`:
   - Remove the import `import type { StuckDetectedEvent } from '../useStuckNotifications';` and replace with `import type { StuckDetectedEvent } from '../../../../shared/types/stuckDetection';` (the path may need adjusting based on actual depth — verify the resolved path matches `shared/types/stuckDetection.ts`).
   - Update `makeEvent` to produce the canonical shape:
     ```ts
     function makeEvent(overrides: Partial<StuckDetectedEvent> = {}): StuckDetectedEvent {
       return {
         runId: 'run-001',
         approvalId: 'approval-001',
         reason: { kind: 'orphan_pty' },
         detectedAt: Date.now(),
         ...overrides,
       };
     }
     ```
   - Rename the 6 tests' parameter pivots from `sessionId` → `runId` (and `workflowName` references removed entirely).
   - Update the title/body assertion in the 1st and 6th tests:
     - 1st test (was `expect(opts.body).toMatch(/Run "Alpha" is stuck/);`): change to `expect(opts.body).toMatch(/Run run-001 is stuck/);` (or match the truncated 8-char prefix as `/Run run-001 is stuck/` against runId `'run-001'`).
     - 6th test (was `expect(opts.body).toMatch(/Run "Test Flow" is stuck: self-deadlock/);`): change to `expect(opts.body).toMatch(/is stuck: self-deadlock/);` and update `reason: 'self_deadlock'` to `reason: { kind: 'self_deadlock' }`.
   - Verify the 2nd test (suppression) uses two events with the same `runId` (was `sessionId`) and different `approvalId` values, asserting only 1 notification fires.
   - Verify the 3rd test uses two events with different `runId` values, asserting 2 notifications fire.

7. **Run typecheck + the hook's test file as completeness gate:**
   ```
   pnpm typecheck
   pnpm --filter cyboflow-frontend test -- --run frontend/src/hooks/__tests__/useStuckNotifications.test.ts
   ```

## Acceptance Criteria

- All criteria in the frontmatter list. The 6 existing test cases continue to pass after rewriting (now using canonical event shape).

## Test Strategy

Rewrite the existing 6 test cases in `useStuckNotifications.test.ts`. No new test files. The test file is the only place the diverged local type was visible — once the local types are deleted and the canonical types imported, TypeScript will catch any remaining drift at compile time, and runtime behavior is fully covered by the existing 6 cases (re-keyed on runId).

## Hardest Decision

What to do about `workflowName` in the notification body. The canonical event does not carry it (and rightly so — the StuckDetector lives in the orchestrator and shouldn't need to JOIN to workflows to emit an event). Three options were considered: (a) drop the name and use a truncated runId, (b) look up workflowName via a store selector inside the hook, (c) extend the canonical event to include workflowName. Chose (a): smallest change, no new dependency, and the notification's job is to alert the user that *some* run is stuck so they switch to the app — the in-app StuckBadge + Why-stuck button surfaces the full identity. Option (c) would require a coordinated change to StuckDetector and shared types; option (b) would couple the notification hook to the workflow registry which is currently a different epic surface.

## Rejected Alternatives

- **Keep a parallel `workflowName` field on the event by extending `StuckDetectedEvent`.** Would require StuckDetector to JOIN to workflows on every emit; out of scope for this fix and adds a runtime cost to the orchestrator hot path. Revisit if user feedback indicates the runId prefix is too opaque.
- **Re-export the canonical types from the hook file.** Rejected because the existing public surface (`stuckReasonText`) is the only export consumers should depend on; pretending types are owned by the hook was the original mistake.

## Lowest Confidence Area

The exact relative-path depth from `frontend/src/hooks/__tests__/useStuckNotifications.test.ts` to `shared/types/stuckDetection.ts` — should be `../../../../shared/types/stuckDetection` (4 levels up: __tests__ → hooks → src → frontend → repo-root). Verify by re-reading the file path and counting; if TypeScript complains at typecheck time, adjust accordingly. The reviewQueueSlice imports it as `'../../../shared/types/stuckDetection'` from `frontend/src/stores/`, which suggests `frontend/src/hooks/__tests__/` needs one more `../`.
