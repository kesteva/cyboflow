---
sprint: SPRINT-017
visual_mobile: skipped_user_preference
visual_web:    skipped_unable
visual_macos:  skipped_user_preference
visual_mobile_note: "visual_mobile=false in resolved config"
visual_web_note:    "Vite renderer at http://localhost:4521 cannot bootstrap standalone (Electron preload-injected electronTRPC missing); Playwright web mode unable to test Electron-target UI without Playwright-Electron driver, which is not the configured visual_web path"
visual_macos_note:  "visual_macos=false in resolved config"
regressions_count: 0
flows_tested: 0
flows_deferred: 1
---

## Sprint Verification Report
- **Sprint:** SPRINT-017
- **Base SHA:** 2305714c59f209a64269b96df2dddf597f805eaf
- **Branch:** soloflow/run-20260518-134219-SPRINT-017
- **Sprint-verification file:** .soloflow/active/sprint-verification.md

### Visual Verification

- **visual_mobile:** skipped_user_preference — visual_mobile=false in resolved config
- **visual_web:**    skipped_unable — Vite renderer at http://localhost:4521 cannot bootstrap standalone (no Electron preload-injected electronTRPC); Playwright MCP cannot test the live Electron-target UI without the Playwright-Electron driver
- **visual_macos:**  skipped_user_preference — visual_macos=false in resolved config
- **Flows tested:** 0
- **Flows deferred:** 1 (review-queue keyboard/mouse triage flow, queued for human visual verification on the running `pnpm dev` Electron window)

#### Probe details for visual_web

1. `pnpm dev` IS running (Electron + Vite; PIDs detected at 84916/85011/85017).
2. `http://localhost:4521` returns `HTTP/1.1 200 OK` and serves the renderer HTML.
3. Playwright MCP `browser_navigate` to that URL loads the page but immediately errors:
   - `Error: Could not find `electronTRPC` global. Check that `exposeElectronTRPC` has been called in your preload file.`
   - This matches the documented constraint in `CLAUDE.md`: "The Vite renderer at http://localhost:4521 cannot bootstrap standalone — it depends on `preload`-injected `electronTRPC` and will error without the main process."
4. The Playwright preference (`verification.visual_prefer_playwright`) is `false`, and `playwright_target.kind = "electron"`. The configured Playwright path (browser mode) is structurally unable to drive the Electron renderer. No fallback to Playwright-Electron is configured.

Classification: `skipped_unable` (tooling cannot reach the live UI given the current visual_web path). A deferred-flow entry has been queued for human verification.

#### Sprint-touched flows (would have been tested)

These flows would have been verified had Playwright-Electron been available; per-task tests cover them at the component level.

- **Review-queue keyboard triage** (TASK-612, TASK-614, TASK-616): mount the ReviewQueueView, focus body, press `j` to navigate, `y` on a group card → atomic `approveRestOfRun`, `n` on a group card → atomic `rejectRestOfRun`. Focus guard: shortcuts must NOT fire when a Radix focus-trap / custom button has focus.
- **Review-queue mouse triage** (TASK-616): click the group-card Reject button → atomic `rejectRestOfRun` (no per-item fan-out).
- **Run launcher start** (TASK-607, TASK-608, TASK-636): start a run from RunView and confirm `started_at`/`ended_at` populate on `getRunById`.

Each of these flows has unit/integration test coverage that passed in Pass 2; runtime/UI verification is the human-deferred item.

### Integration Tests

I ran the equivalent integration sweep (typecheck + full test suites + lint) directly in this verifier:

- **`pnpm typecheck`** — PASS across `frontend`, `main`, `shared` (no errors).
- **`pnpm --filter main run test`** — 36 test files, **344/344 tests passed**.
- **`pnpm --filter frontend run test`** — 16 test files, **208/208 tests passed**.
- **`pnpm test:build`** — afterSign smoke (4/4) and configure-build posture cases (Case A/B) all PASS.
- **`pnpm lint`** — **0 errors, 306 warnings** (warnings are pre-existing in source files not modified by this sprint, e.g. `slashCommandStore.ts`, `console.ts`, unused `error` vars in `configStore.ts`/`sessionPreferencesStore.ts`). No sprint-introduced lint errors or warnings.

All sprint-modified test files (`PendingApprovalCard.test.tsx`, `useReviewQueueKeyboard.test.ts`, `reviewQueueStore.test.ts`, `ReviewQueueView.test.tsx`, `approvals.test.ts`, `runLauncher.test.ts`, `workflowRegistry.test.ts`, `cyboflow.test.ts`, `Orchestrator.test.ts`, `stuckDetector.test.ts`, `useStuckNotifications.test.ts`, `useMcpHealth.test.tsx`, `Sidebar.mcpHealth.test.tsx`, `RunView.test.tsx`, `StuckInspectorModal.test.tsx`, `OnboardingCard.test.tsx`, `StatusBar.test.tsx`) ran within their workspace suite and passed.

### Cross-task / log-inspection findings (informational, NOT regressions)

The running dev session shows two persistent runtime errors. Both PRE-DATE the sprint (verified against base SHA logs in this same `cyboflow-frontend-debug.log` from session start 19:51:51, before any sprint commit landed). Reporting for situational awareness:

1. **`[reviewQueueStore] onApprovalCreated subscription error: TRPCClientError: Symbol.asyncDispose already exists`** — fires on every renderer load (19:51:51, 21:07:54, 21:22:44, 21:41:50). This is a tRPC subscription-init issue independent of TASK-611's leak fix. TASK-611 correctly plugs the unmount unsubscribe and the test suite verifies it. The `Symbol.asyncDispose` error prevents the delta subscription from connecting, but the full-state resync via `listPending` (the documented correctness path per `reviewQueueStore.ts` header) still works. Recommended follow-up: file a separate issue for tRPC client `Symbol.asyncDispose` polyfill collision. NOT a sprint regression.
2. **`SqliteError: table workflow_runs has no column named permission_mode_snapshot`** — fired twice at session start (19:52:01, 19:52:28). The fix landed in pre-sprint commits `a204216 fix: rebuild workflows table when post-006 column-level drift remains` and `6e849e9 fix: reconcile post-006 workflows schema drift`. No new occurrences after 19:52:28 in the latest dev session. NOT a sprint regression.

### Latent transport state (documented in TASK-600, NOT a regression)

The frontend dispatches `trpc.cyboflow.approvals.approveRestOfRun` and `rejectRestOfRun` mutations directly. Per TASK-600's transport map, these tRPC procedures currently throw `TRPCError` until `ctx.db` is wired (approval-router epic). Confirmed:
- Before SPRINT-017: group `Reject` used `trpc.cyboflow.approvals.reject` per-item — same tRPC transport state.
- After SPRINT-017: group `Reject` uses `trpc.cyboflow.approvals.rejectRestOfRun` atomically — same tRPC transport state.

No regression: the transport state is identical before and after the sprint. TASK-616's frontend changes are correctly symmetric with TASK-612's `approveRestOfRun` wiring. The actual live decide path is documented in TASK-600 (raw IPC bucket).

### Regressions requiring attention

**None identified across Pass 1 and Pass 2.**

- Visual flows could not be verified because the configured `visual_web` path (Playwright browser mode) cannot reach the Electron-target renderer. This is a tooling gap, not a regression. Per-task tests cover the affected user flows at the component level, and all pass.
- All 552 unit tests pass, typecheck is clean, lint has 0 sprint-introduced issues.

### Deferred

- **Review-queue keyboard+mouse triage flow** (TASKs 612/614/616) — awaiting human visual verification on the running `pnpm dev` Electron window. The reviewer should: (a) press `j`/`k` to navigate; (b) press `y` on a group card and confirm a single atomic `approveRestOfRun` fires; (c) press `n` on a group card and confirm a single atomic `rejectRestOfRun` fires; (d) confirm pressing `y`/`n` while an input has focus is a no-op (TASK-614 focus guard).

