---
id: TASK-503
idea: IDEA-011
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - frontend/src/hooks/useStuckNotifications.ts
  - frontend/src/hooks/__tests__/useStuckNotifications.test.ts
  - frontend/src/App.tsx
files_readonly:
  - frontend/src/hooks/useNotifications.ts
  - frontend/src/stores/sessionStore.ts
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/utils/api.ts
  - shared/types/stuckDetection.ts
  - main/src/orchestrator/stuckDetector.ts
acceptance_criteria:
  - criterion: "`useStuckNotifications` subscribes to the same `runs:stuck` / `onStuckDetected` tRPC subscription the queue slice uses and fires a macOS notification via the renderer `Notification` API on each event."
    verification: "Component test mounts a host component that calls `useStuckNotifications()`; injects a mock subscription that emits one stuck event; asserts `window.Notification` constructor was called exactly once with a body containing the run's workflow name and the stuck reason."
  - criterion: "Only the FIRST stuck-detection event per `session_id` (Crystal's session row id, the per-app-launch session counter) fires a notification. Subsequent events for the same session are suppressed silently."
    verification: "Unit test emits three stuck events for the same `sessionId` (different `runId`s allowed) and asserts `window.Notification` was called exactly once; emits one more event for a different `sessionId` and asserts the constructor count rises to 2."
  - criterion: "The suppression set is held in memory only — it does not persist across app restarts. A fresh app launch starts with an empty suppression set, so the first stuck detection after restart fires a notification regardless of pre-restart history."
    verification: "Unit test unmounts the hook (simulating app restart by re-mounting it fresh), emits a stuck event for a `sessionId` that previously triggered a notification, asserts the constructor is called again. The hook MUST NOT read or write `localStorage` / `sessionStorage` for this state."
  - criterion: "Notification text follows the format established in `frontend/src/hooks/useNotifications.ts` — title with emoji, body sentence-cased with the workflow name in quotes."
    verification: "`grep -n 'getStatusEmoji\\|Notification(' frontend/src/hooks/useStuckNotifications.ts` confirms the format follows the existing hook's conventions; the unit test asserts the title contains a warning emoji and the body matches `/Run \".*\" is stuck.*/`."
  - criterion: "Notifications are gated by the existing `NotificationSettings.enabled` flag from `useNotifications.ts`. If the user has disabled notifications globally, stuck notifications respect that."
    verification: "Unit test sets the mock config's `notifications.enabled === false`, emits a stuck event, asserts `window.Notification` was NOT called."
  - criterion: "The hook is mounted exactly once, from `frontend/src/App.tsx` at the top level (analogous to `useNotifications()`). It is not mounted inside `<ReviewQueueView />` to avoid the suppression state resetting on view-mount/unmount cycles."
    verification: "`grep -n 'useStuckNotifications' frontend/src/App.tsx` returns one call site; `grep -rn 'useStuckNotifications' frontend/src/components/` returns 0 matches."
depends_on: [TASK-501]
estimated_complexity: low
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "The collapse-after-first-per-session logic is the entire substantive behavior. Three distinct cases — first stuck, second stuck same session, stuck for new session — must each be exercised to prove the suppression is keyed correctly."
  targets:
    - behavior: "First stuck event per session fires a notification"
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "Subsequent stuck events same session are suppressed"
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "Stuck events for a new session fire a notification"
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "Suppression set is in-memory only (resets on hook remount)"
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
    - behavior: "Disabled-notifications config gates the entire hook"
      test_file: "frontend/src/hooks/__tests__/useStuckNotifications.test.ts"
      type: unit
---

# First-stuck-per-session macOS notification with collapse

## Objective

Surface stuck-state transitions to the user via a single macOS desktop notification per session, suppressing subsequent stuck notifications from the same session to prevent the notification fatigue user-needs research identified as a v1 risk vector. Implemented as a top-level renderer hook (`useStuckNotifications`) mounted from `App.tsx`, mirroring the pattern of the existing `useNotifications` hook.

## Implementation Steps

1. Create `frontend/src/hooks/useStuckNotifications.ts`. Pattern after `frontend/src/hooks/useNotifications.ts` for the `Notification` API + permission-request flow.
2. State held in a `useRef<Set<string>>(new Set())` so it survives renders but resets on remount. Key by `sessionId` (the Crystal session row id, which is exposed on the queue item).
3. Read the global notification config the same way `useNotifications` does:
   ```ts
   API.config.get().then(r => { if (r.success && r.data?.notifications) setSettings(r.data.notifications) })
   ```
   Gate the notification firing on `settings.enabled`.
4. Subscribe to the tRPC subscription that carries stuck events. Reuse the same subscription path TASK-502 chose for the queue slice — coordinate with that task on whether it's `cyboflow.events.onStuckDetected` or rolled into `cyboflow.events.onRunStatusChanged`. The hook does not care which; it just listens for `kind === 'stuck'` events.
5. On each event, check `if (notifiedSessionsRef.current.has(sessionId)) return`. Otherwise: add to set, fire `new Notification(...)` with title `"Run Stuck ⚠️"` and body `"Run \"<workflow_name>\" is stuck: <stuck_reason_human_text>"`. Map the four `StuckReason.kind` variants to short human strings inline (`self_deadlock` → "self-deadlock", `cross_run_deadlock` → "cross-run deadlock", `orphan_pty` → "Claude process exited", `stale_socket` → "permission socket disconnected").
6. Modify `frontend/src/App.tsx` to mount the hook once at the top level, alongside the existing `useNotifications()` call. Single line addition.
7. Write the unit tests in `frontend/src/hooks/__tests__/useStuckNotifications.test.ts`. Use a fake `Notification` constructor (`vi.stubGlobal('Notification', vi.fn())`), a mock for the tRPC subscription that exposes an `emit` helper, and a mock for `API.config.get`. Render the hook in a host component via React Testing Library's `renderHook`.

## Acceptance Criteria

Each criterion above must pass. The third (`localStorage`-free) is non-obvious but load-bearing — persisting suppression across restarts would mean a single stuck event for a long-running session permanently silences future stuck notifications for that session, which is worse than fatigue. Per-app-launch suppression is the right balance per the user-needs research framing.

## Test Strategy

Five test cases in one file using vitest's `renderHook` and `vi.stubGlobal('Notification', ...)`:

1. First stuck event fires: emit one event, assert `Notification` constructor called once with expected title/body.
2. Second event same session: emit two events with same `sessionId`, assert constructor called once.
3. Different session: emit two events with different `sessionId`s, assert constructor called twice.
4. Remount resets: render, emit, unmount, render again with a fresh hook instance, emit again — assert constructor called twice across the lifecycle.
5. Disabled config: mock `API.config.get` to return `notifications.enabled === false`, emit, assert constructor not called.

## Hardest Decision

**Key suppression by `sessionId` (Crystal app-launch session) rather than `runId`.** A naive read of the IDEA ("collapsed thereafter") could mean per-run suppression (every new run gets its first stuck notification). The deliberate choice here is per-session — meaning across all runs in one app-launch, the user gets exactly one stuck notification total. Rationale: the user-needs research showed that even one wrong-context notification during deep work is a focus-killer; a user who has already seen "something is stuck, go check the queue" does not need a second notification before they have actually checked the queue. The queue badge and dock count carry the count, the notification carries the "you have a new stuck thing to see" signal — once, per app-launch.

If the 1-day self-host bar reveals this is too aggressive (e.g., user clears the first stuck, returns to deep work, a new stuck arrives 4 hours later and is silently missed), the fallback is per-run keying — a one-line change.

## Rejected Alternatives

- **OS-level rate-limit via notification `tag`.** The renderer `Notification` API supports a `tag` that replaces prior notifications with the same tag. Rejected: replacing the prior notification still shows the new one (with a sound), which is the fatigue we're avoiding. Suppression is stronger than replacement.
- **Persist suppression to `localStorage`.** Rejected per Acceptance Criterion 3 — fresh app launch should let the user see at least one stuck notification.
- **Show a non-notification UI signal only (e.g., dock badge + queue badge).** Rejected: the dock badge already exists for queue length; a stuck-specific signal needs an out-of-app surface so the user notices during deep-work-in-another-app, which is the exact context the IDEA addresses.

## Lowest Confidence Area

Whether per-session collapse is too aggressive in practice. The user-needs research is clear that fatigue is the risk, but the 1-day self-host is the actual test. If the user reports "I missed a stuck run because the notification only fired once 6 hours ago," loosen to per-run. The code change is one identifier swap (`sessionId` → `runId`) in the `notifiedSessionsRef.current.has(...)` check.
