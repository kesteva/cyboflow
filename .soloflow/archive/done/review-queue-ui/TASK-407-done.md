---
id: TASK-407
sprint: SPRINT-010
epic: review-queue-ui
status: done
summary: "Dock badge service + reconnect-resync via DI on orchestrator context (preserves standalone invariant)"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-407 — Dock Badge + Reconnect-Resync

## Outcome

`dockBadgeService` singleton wraps macOS `app.dock.setBadge` with clamp + zero-clear semantics. `cyboflow.events.setBadgeCount` tRPC mutation lives in the orchestrator events router but delegates via `ctx.setDockBadge` (dependency injection from `main/src/index.ts`), preserving the orchestrator's standalone-typecheck invariant declared in `events.ts`'s own docstring. Reviewer-queue store fires `syncBadge` on every reducer (`replaceAll`/`addApproval`/`removeApproval`) and inside `init()` after the full-state resync, so reconnect drift is impossible. `before-quit` clears the badge on app shutdown.

## Files

- `main/src/services/dockBadgeService.ts` (NEW)
- `main/src/services/__tests__/dockBadgeService.test.ts` (NEW — 3 unit tests)
- `main/src/orchestrator/trpc/context.ts` (added ContextDeps.setDockBadge)
- `main/src/orchestrator/trpc/routers/events.ts` (setBadgeCount mutation calls ctx.setDockBadge)
- `main/src/orchestrator/trpc/__tests__/router.test.ts` + `ipcAdapter.test.ts` (context shape assertions)
- `frontend/src/stores/reviewQueueStore.ts` (syncBadge wired into all reducers + init)
- `main/src/index.ts` (DI wire + before-quit handler)

## Verification

- dockBadgeService: 3/3 pass
- Router context tests: 2 new tests pass (default no-op + injected callback)
- Frontend: 95/95 pass
- 68 baseline test failures (NODE_MODULE_VERSION mismatch in better-sqlite3) are pre-existing at base SHA — not regressions
- `pnpm typecheck`: clean
- `pnpm lint`: 0 errors
- Standalone invariant: restored (no `services/*` import in `orchestrator/trpc/routers/events.ts`)
- Visual: skipped (parallel mode)

## Commits

- `e8919e8` feat(TASK-407): add dockBadgeService singleton with macOS dock badge management
- `eaadfad` feat(TASK-407): add setBadgeCount mutation to cyboflow.events tRPC router
- `5926de7` feat(TASK-407): wire dock badge sync into reviewQueueStore reducers
- `69d1155` feat(TASK-407): clear dock badge on app quit via before-quit lifecycle handler
- `ababbc7` test(TASK-407): unit tests for dockBadgeService clamp, zero-clear, and normal case
- `ccc5c28` refactor(TASK-407): inject dockBadge via orchestrator deps to restore standalone invariant
