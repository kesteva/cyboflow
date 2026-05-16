---
id: TASK-407
idea: IDEA-009
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/dockBadgeService.ts
  - main/src/services/__tests__/dockBadgeService.test.ts
  - main/src/trpc/routers/events.ts
  - main/src/index.ts
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/components/ReviewQueueView.tsx
files_readonly:
  - frontend/src/trpc/client.ts
  - shared/types/approvals.ts
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "`dockBadgeService` exposes `setBadgeCount(n: number): void` that calls Electron's `app.dock.setBadge` on macOS (no-op on other platforms, but v1 is macOS-only)"
    verification: "grep -n 'app.dock.setBadge\\|setBadge' main/src/services/dockBadgeService.ts returns a match inside setBadgeCount; running the app and forcing a queue length update changes the macOS dock badge visibly"
  - criterion: "Badge value reflects queue length: when reviewQueueStore.queue.length changes, the dock badge updates"
    verification: "grep -n 'setBadgeCount\\|dockBadgeService' frontend/src/stores/reviewQueueStore.ts OR a tRPC subscription path returns matches; integration: with 0 pending → no badge; with 3 → badge shows '3'"
  - criterion: "On tRPC reconnect (subscription resync), the badge re-derives from the fresh queue length — does not retain stale value from the disconnected period"
    verification: "grep -n 'replaceAll' frontend/src/stores/reviewQueueStore.ts shows that the same code path that resyncs the queue also updates the badge; manual test: disconnect tRPC, mutate queue state, reconnect → badge matches new length"
  - criterion: Badge is updated through a renderer→main tRPC mutation OR via the store subscribing to its own queue length and pushing via IPC — pick one path and use it consistently
    verification: "Either `cyboflow.dock.setBadge` mutation exists in main/src/trpc/routers/events.ts (or a new dock router) AND is called from the store, OR the store calls a window.electron.invoke('dock:setBadge', n) IPC. Exactly one path; grep confirms only one binding."
  - criterion: "Badge value 0 clears the badge (does not show '0')"
    verification: "Unit test: dockBadgeService.setBadgeCount(0) calls app.dock.setBadge('') or equivalent clear-badge API"
  - criterion: "On app quit, badge is cleared"
    verification: "grep -n 'before-quit\\|will-quit' main/src/index.ts shows a handler that calls dockBadgeService.setBadgeCount(0)"
depends_on:
  - TASK-401
  - TASK-402
estimated_complexity: medium
epic: review-queue-ui
test_strategy:
  needed: true
  justification: Badge desync is one of the failure modes named in risks research §10 — verify the renderer→main wiring works AND that 0 clears (Electron API quirk)
  targets:
    - behavior: "setBadgeCount(3) calls app.dock.setBadge('3')"
      test_file: main/src/services/__tests__/dockBadgeService.test.ts
      type: unit
    - behavior: "setBadgeCount(0) calls app.dock.setBadge('') (clears, doesn't display zero)"
      test_file: main/src/services/__tests__/dockBadgeService.test.ts
      type: unit
    - behavior: Negative counts are clamped to 0
      test_file: main/src/services/__tests__/dockBadgeService.test.ts
      type: unit
---
# Dock Badge + Reconnect-Resync

## Objective

Bind the macOS dock badge to `reviewQueueStore.queue.length` so the user has a glanceable, always-visible count of pending approvals (IDEA-009 slice 10). The hard requirement from risks research §10 / §12 and the IDEA's reconnect-resync emphasis: the badge must be re-derived after tRPC subscription reconnect — it cannot rely on incremental events alone, because a disconnect window could miss events and leave the badge desynced ("badge says 3 pending; queue is empty"). This task implements: (1) a small `dockBadgeService` in main that wraps `app.dock.setBadge`, (2) a renderer→main bridge so the store can push the current length, (3) wiring in the store's `replaceAll` and `addApproval`/`removeApproval` reducers so every queue mutation updates the badge, (4) badge cleared on app quit.

## Implementation Steps

1. Create `main/src/services/dockBadgeService.ts`:
   - Export a singleton with `setBadgeCount(n: number): void`.
   - Implementation: `const clamped = Math.max(0, n); if (process.platform === 'darwin' && app.dock) { app.dock.setBadge(clamped === 0 ? '' : String(clamped)); }`.
   - Import `app` from `electron`.
2. Decide the renderer→main path. Choice: extend tRPC. Add to `main/src/trpc/routers/events.ts` (or create a new `main/src/trpc/routers/dock.ts` if cleaner — for this task, fold into events.ts to keep the router count small):
   - `setBadgeCount: publicProcedure.input(z.object({ count: z.number().int().min(0) })).mutation(({ input }) => { dockBadgeService.setBadgeCount(input.count); return { ok: true }; })`.
   - Wire it under the existing cyboflow router as `cyboflow.events.setBadgeCount` (acceptable here because the events router is the "side-effect / cross-cutting" bucket for now; a future refactor can rename).
   - Alternatively: a one-line `ipcMain.handle('dock:setBadge', ...)` is also acceptable per the codebase's existing pattern. The plan uses tRPC for consistency with TASK-401's commitment.
3. Modify `frontend/src/stores/reviewQueueStore.ts`:
   - Add a private helper `syncBadge(queue: Approval[])` that calls `trpc.cyboflow.events.setBadgeCount.mutate({ count: queue.length })`.
   - Call `syncBadge` at the end of `replaceAll`, `addApproval`, and `removeApproval` reducers. Critically, call it inside `init()` after the `replaceAll(result)` line — this is the reconnect-resync path: a fresh full-state load updates the badge from authoritative data, eliminating drift.
   - Wrap the `trpc.*.mutate` call in a try/catch — a badge failure (e.g., tRPC disconnected) must not crash the reducer. Log + swallow.
4. Modify `main/src/index.ts`:
   - Import `dockBadgeService` and `app`.
   - Register `app.on('before-quit', () => dockBadgeService.setBadgeCount(0))` near other lifecycle handlers.
5. Modify `frontend/src/components/ReviewQueueView.tsx`:
   - No structural change needed for badge — the store reducers handle it. But add a one-time defensive call: in the mount effect (the `useEffect(() => { init(); }, [])` from TASK-402), the call to `init()` already triggers `syncBadge` via `replaceAll`. Verify by reading the implementation; no new code if the wiring is correct.
6. Write unit tests in `main/src/services/__tests__/dockBadgeService.test.ts`:
   - Mock `electron.app.dock.setBadge`.
   - Test 1: `setBadgeCount(3)` → `setBadge` called with `'3'`.
   - Test 2: `setBadgeCount(0)` → `setBadge` called with `''`.
   - Test 3: `setBadgeCount(-5)` → `setBadge` called with `''` (clamp to 0).
7. Manual smoke (document in PR description, not in code): start the app, simulate 3 pending approvals (via direct DB insert or a debug command), verify the macOS dock shows '3'; remove one, verify '2'; clear all, verify badge disappears; force a tRPC disconnect (kill the subscription), re-mutate state, reconnect → verify badge matches reality.

## Acceptance Criteria

All six criteria above.

## Test Strategy

Three unit tests on `dockBadgeService` covering the clamp, the zero-clear, and the normal case. The store→badge wiring is verified by the manual smoke step + a follow-up integration test if the team adds one; for v1, the store reducer's `syncBadge` call is simple enough that direct review suffices.

## Hardest Decision

**Push-from-renderer vs pull-from-main.** The decision is push-from-renderer (the store calls a mutation when the queue mutates). Rejected the pull-from-main alternative (main subscribes to its own approval events and updates the badge) because: (a) it duplicates the "source of truth" — main would need its own queue mirror; (b) the renderer's `replaceAll` is the reconnect-resync moment by definition; (c) keeping the badge logic on the same code path as the queue state means they cannot diverge. The cost: an extra round-trip on every queue mutation. Negligible at the expected frequency (1-10 per minute).

## Rejected Alternatives

- **Main process subscribes to its own approval EventEmitter and updates the badge.** Rejected — duplicate source of truth; harder to reconcile after disconnect.
- **Badge shows count of `awaiting_review` runs instead of pending approvals.** Rejected — IDEA explicitly says queue.length is the binding. Run count diverges (1 run can have N pending approvals).
- **Use Electron's `setOverlayIcon` instead of dock badge.** Windows-only API; v1 is macOS.

What would change my mind: if the tRPC mutation latency becomes a visible UX drag (badge updates 200ms after the card disappears), move to a same-process push (renderer dispatches an IPC fire-and-forget that doesn't await main's reply).

## Lowest Confidence Area

The exact tRPC subscription reconnect semantics. `electron-trpc`'s `ipcLink` reconnect behavior on Electron crash/HMR is not fully documented in the v11 RCs. The plan assumes that on reconnect, the renderer's `init()` is called either by a manual trigger (e.g., a `subscription.error → setTimeout(init, 1000)` loop) or by an explicit reconnect detection. If the link silently reconnects without re-emitting the snapshot, the badge could stay stale. Mitigation already in place: any time the user interacts with the queue (focus, scroll), the store can opportunistically re-derive. If self-host shows desync, add a 30s polling fallback (call `listPending` periodically and `replaceAll`).
