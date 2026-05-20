---
sprint: SPRINT-023
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_unable
visual_mobile_note: "visual_mobile=false in config (resolved preference)"
visual_web_note: "Electron renderer at http://localhost:4521 unreachable (HTTP 000); no `pnpm dev` session running. Per CLAUDE.md, visual verification of frontend UI requires full Electron dev mode."
visual_macos_note: "Cyboflow Electron process running but no UI window discoverable to Peekaboo (macOS session at loginwindow); cannot capture/drive an unmounted Electron UI."
regressions_count: 0
flows_tested: 0
flows_deferred: 7
---

## Visual Verification

### Settings gate
- `verification.visual_mobile` resolved to `false` → `skipped_user_preference`.
- `verification.visual_web` resolved to `true` → proceeded; classified `skipped_unable` (tooling unavailable, see Pre-flight).
- `verification.visual_macos` resolved to `true` → proceeded; classified `skipped_unable` (tooling unavailable, see Pre-flight).
- `verification.visual_prefer_playwright` resolved to `false` → using native paths (Peekaboo for macOS).

### Pre-flight checks
- **Renderer reachability:** `curl http://localhost:4521 → 000`. No Vite dev server is running. The only live Electron process (PIDs 22778/22780) was launched 2026-05-19T23:38Z from commit `715b6c9` (pre-sprint) in production mode without the renderer dev server.
- **Peekaboo:** server reachable, Screen Recording + Accessibility granted, but `mcp__peekaboo__list(application_windows, app=cyboflow)` returns "Application not running" — the macOS UI session is at `loginwindow` (per `running_applications` showing only loginwindow/ControlCenter/NotificationCenter/Warp/Claude). No UI session is available to attach a Cyboflow window to, even though backend processes persist.
- **Per CLAUDE.md:** "Visual verification of any frontend UI change requires `pnpm dev` (full Electron). The Vite renderer at `http://localhost:4521` cannot bootstrap standalone."

### Sprint-relevant flows (identified but not run)
Sprint touched substantial UI surface area; the following flows would be tested if visual tooling were available:
1. **Review Queue – stuck-aware card swap** (TASK-622/623/624): pending approval card swaps to stuck variant when `StuckDetectedEvent` fires; tooltip shows `detectedAt`.
2. **Review Queue – Cancel and restart tooltip** (TASK-627): WARN log + tooltip on `clearPendingForRun` TASK-304 no-op path.
3. **Onboarding card dismissal** (TASK-625): `OnboardingCard` dismissal via `onDecide` (keyboard + click paths); ensure no double-dismiss / leftover state.
4. **MCP health surface consolidation** (TASK-626): StatusBar is now the sole MCP health surface; Sidebar MCP dot must be absent. Confirm StatusBar status maps correctly via shared `McpHealthUiStatus`.
5. **Sprint-level cross-task interaction:** Review queue subscribes (`useStuckNotifications` per TASK-623) overlap with `App.tsx` top-level mount (TASK-622) and `subscribeToStuckEvents` setup — verify no duplicate subscriptions or missed events.
6. **Stuck inspector modal:** `StuckBadge` tooltip + reason/detectedAt persistence in slice (TASK-624).
7. **Commit footer formatting** (TASK-628): commits authored from cyboflow runs must still include the canonical footer composed from `commitFooter.ts` helpers.

All 7 flows are deferred to the human reviewer.

### Pre-existing renderer log signals (informational, NOT sprint-introduced)
From `cyboflow-frontend-debug.log` (captured at parent commit `715b6c9`, BEFORE sprint code loaded):
- `[reviewQueueStore] onApprovalCreated subscription error: TRPCClientError: Symbol.asyncDispose already exists`
- `[useStuckNotifications] subscription error: TRPCClientError: No "subscription"-procedure on path "cyboflow.events.onStuckDetected"`

TASK-623 specifically aligned `useStuckNotifications` with the canonical `StuckDetectedEvent` schema. The second warning above PRE-DATES the sprint (the log is from the pre-sprint binary) but its persistence post-sprint cannot be confirmed without a fresh `pnpm dev` launch. Flagged below for human verification.

## Integration Tests

- **Typecheck (`pnpm typecheck`):** PASS (frontend + main + shared).
- **Frontend (`pnpm --filter frontend test`):** 259/259 PASS across 18 test files (3.42s).
- **Main (`pnpm --filter main test`):** 482 PASS / 5 FAIL across 47 test files (1.95s).
- **Build smoke (`pnpm run test:build`):** PASS (Case A: unsigned posture; Case B: signed posture).
- **Lint (`pnpm lint`):** 0 errors / 307 warnings (warnings non-blocking, pre-existing).

### Main failures — confirmed pre-existing at base SHA
Reproduced all 5 failures by checking out `main/` at base SHA `14129c7` and re-running the two failing files. Result: **5 failed / 34 passed** — identical to HEAD. Therefore NOT sprint regressions.

| File | Test | Status |
|---|---|---|
| `src/database/__tests__/cyboflowSchema.test.ts` | `006 reconciler … rebuilds when stuck_detected_at orphan column exists` | Pre-existing — collides with parent fix `715b6c9 fix: stop reconciliation from dropping stuck_detected_at column` |
| `src/orchestrator/__tests__/runExecutor.test.ts` | `onLifecycleTransition routes each phase to the right transition helper` | Pre-existing |
| `src/orchestrator/__tests__/runExecutor.test.ts` | `source arg: lifecycleTransitions.running() fires when source emits output event` | Pre-existing |
| `src/orchestrator/__tests__/runExecutor.test.ts` | `source absent: bridgeEvents short-circuits; running() is not called` | Pre-existing |
| `src/orchestrator/__tests__/runExecutor.test.ts` | `bridge drops output event when panelId has run- prefix (old broken behaviour)` | Pre-existing |

### Sprint-specific test additions all pass
- `frontend/src/stores/__tests__/mcpHealthStore.test.ts` (TASK-626): 8 tests pass.
- `frontend/src/stores/__tests__/reviewQueueSlice.test.ts` (TASK-624): 31 tests pass, including new `runReasonMap` / `runDetectedAtMap` coverage.
- `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts` (TASK-622): 30 tests pass.
- `frontend/src/hooks/__tests__/useStuckNotifications.test.ts` (TASK-623): aligned with canonical schema, passes.
- `frontend/src/hooks/__tests__/useMcpHealth.test.tsx` (TASK-626): 7 tests pass (now exercises store-adapter mapping, not polling).
- `frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx` (TASK-626): 4 tests confirm MCP dot removed.
- `frontend/src/components/__tests__/ReviewQueueView.test.tsx` (TASK-622): 17 tests pass with new import + `runStatus` prop.
- `frontend/src/components/__tests__/PendingApprovalCard.test.tsx` (TASK-622/624): 39 tests pass.
- `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx` (TASK-624): 37 tests pass with `detectedAt` tooltip cases.
- `frontend/src/components/OnboardingCard.test.tsx` (TASK-625): 3 tests pass with `onDecide` consolidation.
- `main/src/utils/commitFooter.test.ts` (TASK-628): all helpers tested.
- `main/src/utils/devDebugLog.test.ts` (TASK-629): 12 tests pass for extracted `formatConsoleArgs`.
- `main/src/orchestrator/__tests__/approvalRouter.test.ts`, `cancelAndRestart.test.ts`, `stuckDetector.test.ts`, `mcpServer/__tests__/mcpQueryHandler.test.ts` (TASK-633): all pass with extracted dbAdapter fixture.

## Regressions requiring attention

**None.** All test failures pre-exist at base SHA `14129c7` and are not caused by this sprint. They belong to ongoing work tracked elsewhere (likely the orchestrator-and-trpc-router epic — note recent commit `feat(orchestrator-and-trpc-router): plan TASK-667 — debug RunView envelope drop past event #1`).

