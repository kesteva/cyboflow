---
sprint: SPRINT-025
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_unable
visual_web_note: "Vite renderer at http://localhost:4521 cannot bootstrap standalone — depends on preload-injected electronTRPC (CLAUDE.md). Playwright MCP can reach the URL but renders a blank page (1 console error: 'Could not find electronTRPC global'). The running Electron window IS at HEAD-equivalent commit but is unreachable by Playwright (no separate Electron Playwright driver attached)."
visual_macos_note: "Peekaboo MCP available with Screen Recording + Accessibility granted, and cyboflow Electron window enumerable (PID 76201, ID 6335, 'Cyboflow' 1260×811), but ScreenCaptureKit stream itself fails: 'Failed to start stream due to audio/video capture failure' and 'No displays available for capture' for both window-target and screen-target. The init notes flagged peekaboo as 'IS NOT available this session' — TCC grant is present at the policy layer but capture-stream not authorized for this Claude Code host process."
visual_mobile_note: "User preference: visual_mobile=false (Electron desktop app; no mobile surface)."
regressions_count: 0
flows_tested: 0
flows_deferred: 7
---

# SPRINT-025 Sprint Verification

## Visual Verification — Pass 1

**Surfaces:**
- `visual_mobile` — `skipped_user_preference` (not applicable to Electron desktop app)
- `visual_web` — `skipped_unable` (Vite renderer blank without electronTRPC preload; Playwright cannot drive the running Electron instance)
- `visual_macos` — `skipped_unable` (Peekaboo MCP probe OK + window enumerable, but capture stream itself rejects with "No displays available" / "Failed to start stream")

**Affected UI flows from SPRINT-025 changes (deferred to human review):**

1. **TASK-657**: Open a session/project, switch panel-state cwd via `panels:initialize`. Confirm `customState.cwd` round-trips and is preferred over the session/project default for both new and re-mounted panels.
2. **TASK-658**: In ProjectView and SessionView, click the new "+" / Add Terminal button in the PanelTabBar. Confirm a new terminal panel appears and is focused. Repeat in both contexts.
3. **TASK-659**: With a session/project open, press Cmd+Shift+Backquote (or Ctrl+Shift+Backquote on Linux/Win). Confirm a new terminal panel is added (same effect as the button). Then verify the TerminalPanel breadcrumb header shows the cwd.
4. **TASK-667**: Start a fresh cyboflow run; open DevTools console. Confirm `[cyboflowApi] stream event #1, #2, #3...` log entries appear up to ~#25, and that `useCyboflowStore.getState().streamEvents.length >= 3` by completion. (Already queued — pre-existing entry from this sprint.)
5. **TASK-668**: With at least one run that triggers a stuck detection, confirm the desktop notification fires exactly once per run and does NOT duplicate. Confirm `reviewQueueSlice.runStatusMap` reflects stuck state in the Review Queue UI.
6. **TASK-669**: Take a run that became stuck, then transition it to a terminal state (completed/failed/canceled). Confirm `runReasonMap` and `runDetectedAtMap` entries for that runId are cleared (no stale tooltip / inspector content).
7. **TASK-670**: Through the file menu or project tree, exercise paths that go through `worktreeManager`, `runCommandManager`, and `ipc/file.ts` with paths containing single quotes and spaces (e.g. project named `my'project's worktree`). Confirm no shell errors; commands succeed and quoted args render correctly in any backend logs.

**Tools probed:**
- `mcp__playwright__browser_navigate` to http://localhost:4521 → page loads but body is blank with 1 console error ("Could not find electronTRPC global"). Matches CLAUDE.md constraint.
- `mcp__peekaboo__list` (server_status) → MCP 2.0.3, Screen Recording ✓, Accessibility ✓.
- `mcp__peekaboo__list` (application_windows, PID:76201) → found "Cyboflow" window (1260×811).
- `mcp__peekaboo__image` (PID:76201 background) → "Failed to capture the specified window. Failed to start stream due to audio/video capture failure".
- `mcp__peekaboo__image` (PID:76201 foreground) → same error.
- `mcp__peekaboo__image` (screen:0) → "No displays available for capture".

**Debug-log triage (read against running `pnpm dev` session):**
The two FRONTEND ERROR entries in `cyboflow-frontend-debug.log` are pre-existing and explicitly out-of-scope for SPRINT-025:
- `[reviewQueueStore] onApprovalCreated subscription error: TRPCClientError: Symbol.asyncDispose already exists` — pre-existing tRPC client-side initialization issue.
- `[reviewQueueSlice] onStuckDetected subscription error: TRPCClientError: No "subscription"-procedure on path "cyboflow.events.onStuckDetected"` — pre-existing backend-router gap, already queued under SPRINT-023's deferred-visual entry. TASK-668 rewired `useStuckNotifications` to **consume** the slice rather than re-subscribe; the slice's own subscription still fails because the backend procedure is still missing. This is the producer-gap discussed in TASK-668's plan, not a regression.

No SPRINT-025-introduced runtime errors observed in the frontend or backend debug log post the most recent main-process restart.

## Pass 2 — Integration / Test Suite

**Typecheck:** PASS (3/3 workspaces; main + frontend + shared all clean).

**Lint:** PASS (0 errors; warnings-only; main: 208 warnings, frontend: 307 warnings — all pre-existing baseline noise. Zero `@typescript-eslint/no-explicit-any` errors).

**Main vitest (`pnpm --filter main test`):** 535 passed / 5 failed / 540 total.

Net delta vs base SHA `2493186`: SPRINT-025 actually **reduced** failures from **6 → 5** (TASK-666/667's changes resolved one pre-existing failure incidentally).

All 5 failures are pre-existing and reproducible at base:
1. `src/orchestrator/__tests__/runExecutor.test.ts:626` — "pre_spawn/post_spawn are no-ops" — running() called twice (introduced by pre-sprint `715b6c9 fix: transition to running pre-spawn`)
2. `src/orchestrator/__tests__/runExecutor.test.ts:796` — "source arg: lifecycleTransitions.running() fires when source emits output event" — running() called twice (same root cause)
3. `src/orchestrator/__tests__/runExecutor.test.ts:847` — "source absent: bridgeEvents short-circuits; running() is not called" — running() called once (same root cause)
4. `src/orchestrator/__tests__/runExecutor.test.ts:1284` — "bridge drops output event when panelId has run- prefix (old broken behaviour)" — bridge no longer drops (intentional fix in pre-sprint `9195fdf TASK-663`)
5. `src/database/__tests__/cyboflowSchema.test.ts:680` — "rebuilds the table when worktree_path is NOT NULL or stuck_detected_at orphan column exists" — `stuck_detected_at` column still present after expected rebuild (pre-existing migration bug)

**Frontend vitest (`pnpm --filter frontend test`):** PASS (243/243). Includes 12 new tests for `useAddTerminalShortcut` (TASK-659) and 41 tests for `reviewQueueSlice` (TASK-668/669) — all green.

**Schema parity (`pnpm verify:schema` + `verify-schema-parity.test.js`):** PASS (3/3 subtests).

**Build tests (`pnpm test:build`):** PASS.

**Day-3 gate (`pnpm test:gate`):** PASS (16.4s integration test).

**Playwright E2E (`pnpm test`):** Cannot complete collection — `tests/cyboflow-day3-gate.spec.ts` imports from `vitest` and breaks `playwright test`'s collection step (this misrouting is pre-existing and the spec is intended to run via `pnpm test:gate`, not playwright). Running specs explicitly: 12 failures, all symptomatic of the documented "Vite renderer cannot bootstrap standalone" CLAUDE.md constraint (the same failures reproduce against base SHA for `smoke.spec.ts` + `health-check.spec.ts`).

The new TASK-658 `standalone-terminal-panels.spec.ts` (3 specs) added in this sprint fails for the **same** infra reason — body never becomes visible because `electronTRPC` is missing. This is not a behavioral regression but a **test-strategy gap**: those assertions need Playwright-Electron or RTL-vitest to actually run. See follow-up note.

## Regressions requiring attention

**None introduced by SPRINT-025.**

The integration suite is in the same or better shape than at base SHA. Net deltas:
- Main vitest: -1 failure (6 → 5; all pre-existing)
- Frontend vitest: 0 change (still all green; +new task tests passing)
- Playwright: +3 net failures from `standalone-terminal-panels.spec.ts` (TASK-658), but root cause is the pre-existing infra constraint, not a regression in app behavior.

## Follow-ups to consider (NOT regressions)

1. **TASK-658 E2E coverage**: The Add Terminal Playwright spec asserts in `tests/standalone-terminal-panels.spec.ts` will never actually execute against the current `playwright.config.ts` setup. Recommend converting to Playwright-Electron (electron driver) or to React Testing Library + vitest. Already covered for TASK-659 (useAddTerminalShortcut has 12 RTL tests, all passing).
2. **Pre-existing baseline-test gap**: 4 `runExecutor.test.ts` cases + 1 `cyboflowSchema.test.ts` case have been failing on `main` since before this sprint. Recommend a future sprint to either fix the production code (if the test intent is canonical) or update the tests (if the pre-spawn / panelId-prefix changes were intentional).
3. **`cyboflow-day3-gate.spec.ts` misrouting**: this spec sits under `tests/` (Playwright's testDir) but uses vitest imports. Recommend moving to `tests-gate/` or renaming to `.test.ts` so `playwright test` stops trying to collect it.
