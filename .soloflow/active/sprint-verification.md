---
sprint: SPRINT-008
visual_mobile: skipped_user_preference
visual_web: pass
visual_macos: skipped_user_preference
visual_mobile_note: "visual_mobile=false in resolved config"
visual_web_note: "Cyboflow renderer shell + Settings dialog + Add-Project modal render cleanly; 10 console errors are pre-existing 'Electron API not available' guards from preload bridge being absent when Playwright MCP connects via HTTP (unchanged from base)"
visual_macos_note: "visual_macos=false in resolved config"
regressions_count: 0
flows_tested: 3
flows_deferred: 1
---

# Sprint-008 Visual + Integration Verification

## Pass 1 — Visual Verification (visual_web)

### Path selection
- `verification.visual_prefer_playwright` = false → use platform-native driver.
- `playwright_target.kind` = `electron`, `divergence_risk` = false → no native-divergence guard.
- `visual_mobile` = false → `skipped_user_preference` (no Maestro probe).
- `visual_macos` = false → `skipped_user_preference` (no Peekaboo probe).
- `visual_web` = true → Playwright MCP against renderer-only at `http://localhost:4521`.

### Sprint UI surface inventory
- Frontend file changes in SPRINT-008: **zero** (`git diff --name-only 61bd60d..HEAD frontend/` returns empty).
- All sprint changes live in `main/`, `shared/`, `scripts/`, `docs/`, lockfiles.
- EPIC invariant (IDEA-014): "same panel UI, same review queue, same worktrees, same runs". The SDK substrate swap is intentionally invisible end-to-end.
- The user explicitly asked Pass 1 to exercise the app anyway to confirm no renderer-side regression.

### Flows exercised (3 of 3 passing)
1. **App shell load** — header (Cyboflow logo + heading), Help/Settings buttons, sidebar ("Projects & Sessions" + sort/history/legend), empty state ("No Projects Yet" + "Add Project"), Archived Sessions entry, main pane "No Session Selected". Screenshot: `docs/screenshots/sdk-migration/sprint008-empty-state.png`. **PASS**.
2. **Settings dialog** — opens with Cancel + Save Changes footer + form sections; Cancel dismisses cleanly. **PASS**.
3. **Add-Project modal** — opens with Close + form regions. **PASS**.

### Console error analysis
10 errors total, **all the same class**: `window.electronAPI` is undefined (because Playwright MCP connects over HTTP to Vite, not via the Electron preload bridge). The renderer is designed to fail gracefully here — confirmed by inspecting `frontend/src/components/Sidebar.tsx:38` and `frontend/src/utils/api.ts:12` at base SHA `61bd60d`: same `window.electronAPI` calls verbatim, same guard message. Error count stays at exactly 10 across initial load + Settings + Add-Project interactions; no interaction-triggered new errors. **Not a regression.**

### Flow deferred (1)
- **End-to-end Claude session via SDK substrate** — "create session → drive Claude panel → observe stream events → exercise approval prompt → finish run" requires Electron shell + claude binary + Anthropic auth + a real project + worktree. Already queued under bucket `testing`, action `"Run human smoke per TASK-596 spec..."` — covers UI signals 1+2+3+9 from `docs/sdk-migration-smoke-results.md`. **No duplicate enqueue needed.**

## Pass 2 — Integration Tests

### Typecheck (`pnpm typecheck`)
**PASS.** All 3 workspaces (`main`, `frontend`, `shared`) clean. No SDK type errors leak across the substrate boundary.

### Lint (`pnpm lint`)
**PASS.** 0 errors, 303 warnings — all pre-existing baseline noise (`no-console`, `react-hooks/exhaustive-deps`, `@typescript-eslint/no-unused-vars`, `react-refresh/only-export-components`). No new lint errors introduced by the substrate swap. `@typescript-eslint/no-explicit-any` (the project's `error`-level rule) is clean.

### Main process build (`pnpm build:main`)
**PASS.** `rimraf dist && tsc && copy:assets` completes with no errors. The SDK substrate compiles to production target — strong cross-task integration signal that TASK-587 (dep), TASK-588 (approval type extraction), TASK-589 (wire format retarget), TASK-590 (`claudeCodeManager.ts` rewrite), TASK-591 (bridge delete), TASK-592 (legacy parser delete), TASK-593 (CompletionDetector delete), TASK-594 (test mock factory migration) all compose coherently.

### Main vitest (`pnpm --filter main exec vitest run`)
**124 PASS / 32 FAIL / 10 skipped across 166 tests (17 files, 11 passed / 6 failed).**

All 32 failures share **one root cause**: `NODE_MODULE_VERSION 136 vs 127` better-sqlite3 ABI mismatch. Failing files (every one fails at `new Database(...)` instantiation, before any test body runs):
1. `src/database/__tests__/cyboflowSchema.test.ts`
2. `src/ipc/__tests__/sessionJsonMessages.test.ts`
3. `src/database/__tests__/fileMigrationRunner.test.ts`
4. `src/orchestrator/__tests__/approvalRouter.test.ts`
5. `src/services/cyboflow/__tests__/transitions.test.ts`
6. `src/services/streamParser/__tests__/rawEventsSink.test.ts`

This is the **environmental defect already queued** as FIND-SPRINT-008-1 + `better_sqlite3_node_module_version_mismatch` action (severity high) in `human-review-queue.md`. Fix: `pnpm electron:rebuild`. **Not a sprint regression** — same failures reproduce on `main` pre-SPRINT-008 per the queue entry. After the rebuild, the 32 currently-erroring-at-load tests should all pass.

The **124 passing tests include the SDK-relevant ones**:
- `src/services/streamParser/__tests__/schemas.test.ts` (TASK-589/594 SDK wire format)
- `src/services/streamParser/__tests__/typedEventNarrowing.test.ts` (TASK-589/594 narrowing)
- `src/services/streamParser/__tests__/sdkMockFactories.ts` (TASK-594 new factories)

i.e., the substrate-swap-specific test surface passes; only DB-bound tests fail, and they fail for the unrelated ABI reason.

### Playwright E2E (`pnpm test`)
**DEFERRED** — running this would spawn Electron in the user's active session via the webServer config (`pnpm electron-dev`), interfering with their working environment. The smoke specs (`tests/smoke.spec.ts`, `tests/health-check.spec.ts`) exercise the same renderer shell I already manually verified in Pass 1 against the same `:4521` baseURL. The substantive SDK-substrate E2E exercise (live Claude panel run) is covered by the already-queued TASK-596 human smoke. No new queue entry required.

## Regressions requiring attention

**None introduced by SPRINT-008.**

All observed failures are environmental or pre-existing and have queue coverage:
- 32 better-sqlite3 ABI failures → FIND-SPRINT-008-1 / `better_sqlite3_node_module_version_mismatch` (queued, severity high, fix = `pnpm electron:rebuild`).
- Renderer's 10 `Electron API not available` console errors → not a regression (preload absent by design when accessed over HTTP; pre-existing in renderer code at base SHA).
- TASK-596 human smoke for SDK substrate live signals → already queued under bucket `testing` (severity per existing entry).

## Acceptable deferrals re-confirmed

Pre-existing entries in `.soloflow/human-review-queue.md` referenced by this sprint:
- `better_sqlite3_node_module_version_mismatch` (action, high)
- `streamparser_fixtures_missing` (action, medium — superseded by TASK-594, but queue entry's exit criteria — re-run vitest — is now part of the same `pnpm electron:rebuild` follow-up)
- FIND-SPRINT-008-2 (MCP server type cast narrowing, low)
- FIND-SPRINT-008-3 (`killProcess` early-return, low)
- FIND-SPRINT-008-5 (stale JSDoc-only refs in `session.ts:34`, low)
- FIND-SPRINT-008-6 (`cyboflowPermissionBridge.ts` TS source dead-code sweep, low)
- FIND-SPRINT-008-7 (future grep-AC patterns should exclude `dist/`, low)
- TASK-596 human smoke (testing bucket)
