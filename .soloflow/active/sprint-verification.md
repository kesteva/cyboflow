---
sprint: SPRINT-028
visual_mobile: skipped_user_preference
visual_web:    skipped_unable
visual_macos:  skipped_unable
visual_mobile_note: "verification.visual_mobile=false"
visual_web_note:    "Electron-only target; Playwright MCP/CDP cannot drive renderer (preload-injected electronTRPC); dedup_key visual_web_electron_unreachable"
visual_macos_note:  "pnpm dev not running and Peekaboo Accessibility grant missing — both required per docs/VISUAL-VERIFICATION-SETUP.md"
regressions_count: 1
flows_tested: 0
flows_deferred: 4
---

# SPRINT-028 — Sprint Verification

## Visual Verification (Pass 1)

- **visual_mobile** — `skipped_user_preference`. `verification.visual_mobile=false`.
- **visual_web** — `skipped_unable`. `playwright_target.kind=electron`; the Vite renderer at `http://localhost:4521` cannot bootstrap standalone (preload-injected `electronTRPC` missing). Same constraint already filed under `dedup_key: visual_web_electron_unreachable` (SPRINT-015 actions bucket).
- **visual_macos** — `skipped_unable`. `pnpm dev` is not running (no Electron/Vite process visible; port 4521 returns 000), and Peekaboo reports `Accessibility: NOT granted` (only Screen Recording is granted). Per CLAUDE.md L41 / docs/VISUAL-VERIFICATION-SETUP.md, both grants are required.

### Identified flows (would have been tested if visual_macos were available)

1. **Discord modal absence** (TASK-684 + TASK-685): launch app, confirm no Discord popup appears.
2. **Sidebar shows project > workflow runs** (TASK-687): open Sidebar, expand a project, observe newest-first runs list with status dots and `WF-XXXXXX` labels; verify "No runs yet. Use Start Run." empty state.
3. **Click run row → RunView in CyboflowRoot** (TASK-687 × TASK-688 interaction): click a run row, confirm RunView renders inside CyboflowRoot.  **STATIC ANALYSIS CONTRADICTS THIS** — see Regression below.
4. **WorkflowPicker as modal** (TASK-688): click "Choose workflow" header button, confirm modal opens with select; pick a workflow, click Start Run, confirm modal closes and RunView mounts.

All four flows are queued as deferred (`bucket: testing`) under the existing `visual_web_electron_unreachable` and the new `visual_macos_grants_missing` dedup_keys.

## Integration Tests (Pass 2)

- **Status:** REGRESSIONS_FOUND (1 static regression; integration suites themselves show only pre-existing failures).
- **`pnpm test:unit` chain (main + frontend + verify:schema + verify-schema-parity + test:build):**
  - `main` vitest: **563/564 pass; 1 fail** — `src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts > killProcess mid-stream clears pipelines, sdkRuns, and processes maps` (5s timeout). **CONFIRMED PRE-EXISTING**: reproduced on base SHA `c360d9dea6` after `git checkout c360d9dea6...HEAD -- main/src` and re-running the same spec — identical timeout. TASK-685's done report also pre-flagged this. Not a sprint regression.
  - `frontend` vitest: **269/269 pass**, including the new `DraggableProjectTreeView.runs.test.tsx` (6 assertions) and `CyboflowRoot.test.tsx` (4 assertions).
  - `verify:schema` + `verify-schema-parity` + `test:build`: all pass.
- **Typecheck (`pnpm typecheck`):** clean (main, frontend, shared).
- **Lint (`pnpm lint`):** 0 errors, 276 warnings — all pre-existing unused-var/no-console warnings; none introduced by sprint files (grep'd the sprint-changed files: `App.tsx`, `Sidebar.tsx`, `DraggableProjectTreeView.tsx`, `CyboflowRoot.tsx`, `WorkflowPicker.tsx`, `cyboflowApi.ts`, `cyboflow.ts` — only `cyboflowApi.ts:135` `no-console` warning, which is also pre-existing).
- **Playwright (`pnpm test`):**
  - `cyboflow-day3-gate.spec.ts` causes collection error when running the full suite (`vitest import in a CommonJS module via require()`). Spec is unchanged in this sprint (last touched in TASK-605); pre-existing. Workaround used: filter by spec name.
  - `cyboflow-picker.spec.ts` (4 tests, modified by TASK-688): all **4 SKIPPED** by design via the spec's `hasCyboflowRoot()` guard — no active project configured in the test environment. Skip-guard is intentional and matches the existing convention.
  - `smoke.spec.ts` (3 tests) + `health-check.spec.ts` (1 test): all **4 FAIL** because the Vite-only renderer cannot bootstrap without Electron `preload` (CLAUDE.md L39). **CONFIRMED PRE-EXISTING**: reproduced on base SHA after restoring `frontend tests playwright.config.ts` — identical failures. Same `visual_web_electron_unreachable` dedup_key.
- Other Playwright specs not exercised (collection blocked when running without spec filter; per-spec filtering is the only currently viable path). Logged as a separate deferred item.

### Regressions (caused by this sprint)

#### REG-SPRINT-028-1 — Run-row click renders SessionView instead of CyboflowRoot's RunView

- **Type:** cross-task interaction regression (static analysis; not caught by per-task tests).
- **Caused by:** TASK-687 × TASK-688 interaction.
- **Files:**
  - `frontend/src/components/DraggableProjectTreeView.tsx:849-852` — `handleRunClick`
  - `frontend/src/stores/navigationStore.ts:27-30` — `navigateToSessions`
  - `frontend/src/App.tsx:338` — `activeProjectId !== null && !useLegacyCrystalView` gate
  - `frontend/src/components/cyboflow/CyboflowRoot.tsx:39` — `activeRunId !== null ? <RunView /> : ...`
- **What breaks:**
  1. User clicks a workflow-run row in the Sidebar (TASK-687 new behavior).
  2. `handleRunClick` runs:  
     `useCyboflowStore.getState().setActiveRun(run.id)`  ← `activeRunId` ✓ set  
     `useNavigationStore.getState().navigateToSessions()`  ← sets `{ activeView: 'sessions', activeProjectId: null }`
  3. In `App.tsx:338` the primary-content branch requires `activeProjectId !== null` to mount `CyboflowRoot`. Because `navigateToSessions` just nulled it, the renderer falls into the legacy `SessionView` branch.
  4. `CyboflowRoot` (and thus `RunView`) never mounts on this path — the `activeRunId` that step 2 just set has no visible consumer. The user clicked a run and lands on the legacy session view.
- **Why per-task verification missed it:**
  - TASK-687's new test `DraggableProjectTreeView.runs.test.tsx:352` only asserts `mockSetActiveRun` was called; it mocks `navigationStore` and never composes the two stores against the App-shell render path.
  - TASK-688's `CyboflowRoot.test.tsx` renders the component directly with an injected `projectId`, bypassing the App-shell gate.
- **Suggested fix (executor-only choice):** in `DraggableProjectTreeView.handleRunClick`, replace `navigateToSessions()` with a path that preserves the project context, e.g. call `useNavigationStore.getState().setActiveProjectId(run.project_id)` (run rows carry project context — `ProjectWithRuns` already knows the project) or remove the navigation call entirely if `CyboflowRoot` is the always-on home view when a project is active. Either way the test in `DraggableProjectTreeView.runs.test.tsx` should be extended to assert `activeProjectId` is non-null after the click (or to render the full App shell and check that `RunView` is in the DOM).

### Pre-existing failures (do NOT block sprint)

- `claudeCodeManager.killProcess.test.ts` — 5s timeout; identical on base SHA.
- `tests/smoke.spec.ts` (3 tests) + `tests/health-check.spec.ts` (1 test) — Vite renderer cannot bootstrap standalone; identical on base SHA. Tracked under `visual_web_electron_unreachable`.
- `tests/cyboflow-day3-gate.spec.ts` — vitest-in-Playwright collection error; spec untouched in this sprint.

## Cross-task interaction checks — explicit results

1. **"Does TASK-684/685 actually delete the Discord modal cleanly?"** — YES.
   - `grep -rn "DiscordPopup|discord_shown|discord-popup|DiscordModal" frontend/src main/src` returns only the intentionally-orphaned DB column at `main/src/database/database.ts:750` (marked with `IDEA-016` comment in TASK-685's done report). No frontend references, no IPC handler.
2. **"Does TASK-687's sidebar correctly drive TASK-688's CyboflowRoot active-run rendering?"** — NO (regression REG-SPRINT-028-1 above). The two tasks share the correct store (`useCyboflowStore.activeRunId`), but the navigation-store side effect from TASK-687 (`navigateToSessions` → `activeProjectId: null`) unmounts the CyboflowRoot host from `App.tsx`, so the `RunView` branch in CyboflowRoot never gets the chance to render.

## Human review queue entries appended

1. **Existing dedup_key** `visual_web_electron_unreachable` — updated with SPRINT-028 affected tasks (TASK-688 already listed).
2. **New entry** REG-SPRINT-028-1 — cross-task regression, bucket `decisions`, severity `high`.
3. **New entry** dedup_key `visual_macos_grants_missing` — visual_macos config gap, bucket `actions`, severity `medium` (Peekaboo Accessibility grant required + `pnpm dev` not running).
4. **New entry** dedup_key `playwright_full_run_blocked_by_day3_gate_spec` — testing bucket, severity `low` (pre-existing, but worth noting for future sprint verifiers).
