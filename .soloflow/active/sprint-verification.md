---
sprint: SPRINT-033
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: skipped_unable
visual_mobile_note: "verification.visual_mobile=false"
visual_web_note: "cyboflow renderer cannot bootstrap without Electron preload; visual_web is non-functional per CLAUDE.md, and no web flows exist for this sprint"
visual_macos_note: "Peekaboo ScreenCaptureKit returns -3811 (audio/video capture failure); display is asleep/locked (loginwindow is ACTIVE app), native screencapture confirms black-frame capture. Tooling configured correctly (Screen Recording + Accessibility granted); blocked on display wake. Deferred to human review."
regressions_count: 1
flows_tested: 0
flows_deferred: 1
---

## Visual Verification

### Platform classification
- visual_mobile = skipped_user_preference (verification.visual_mobile=false)
- visual_web    = not_applicable (cyboflow Electron renderer cannot bootstrap standalone; no web flows)
- visual_macos  = skipped_unable (display asleep / ScreenCaptureKit error -3811)

### Settings + tooling
- Peekaboo MCP 2.0.3: CLI present, Screen Recording granted, Accessibility granted.
- pnpm dev running (PID 80721), Electron window "Cyboflow" on-screen at 650,264 1260×811 (PID 80782).
- Vite HMR loaded the post-sprint TASK-731 refactor at 2026-05-23T04:51:11Z (CyboflowRoot.tsx + ProjectView.tsx).
- Capture attempts:
  - mcp__peekaboo__image(PID:80782, foreground) → -3811 audio/video capture failure
  - mcp__peekaboo__image(screen:0)               → "No displays available for capture"
  - peekaboo CLI image --app Electron            → -3811 SCStreamErrorDomain
  - native screencapture -x                      → succeeds but returns all-black frame (display asleep)
- loginwindow is the ACTIVE app — confirms display is locked/asleep.

### Affected flows (deduplicated across tasks)
1. **Panel surface — main repo session (CyboflowRoot path)**: open cyboflow, verify panels (Claude, logs, diff, terminal) mount/switch via the new `usePanelSurface` hook. TASK-731.
2. **Panel surface — project session (ProjectView path)**: open a project, switch between panel types, verify session activation and panel rendering via the new hook. TASK-731.

Both flows are driven by the same hook (`frontend/src/hooks/usePanelSurface.ts`) but from two render trees. Deferred together.

### Frontend debug-log evidence (HMR-time)
- No TypeError / unhandled exceptions logged after the HMR updates at 04:51:11.
- Only entries since HMR are the pre-existing Electron CSP warning and routine stream events.
- This is NOT a substitute for a full visual pass but confirms the refactored modules did not crash at mount/HMR.

### Failures
- None directly observed (capture blocked).

### Deferred
- visual_macos: TASK-731 panel-surface verification queued in human-review-queue.md (dedup_key: visual_macos_screencapturekit_-3811_display_asleep, severity: medium).

## Integration Tests

(Run as sprint-verifier in-process since `integration-tester` is not available as a sub-agent in this environment.)

### pnpm typecheck — FAIL
- shared:   No TypeScript files to check
- main:     Done
- frontend: FAIL — src/hooks/__tests__/usePanelSurface.test.tsx(492,7): TS2345
  - Argument of type '(cb: (state: StoreState) => void) => Mock<Procedure>' is not assignable to parameter of type 'NormalizedPrecedure<() => () => undefined>'. Target signature provides too few arguments. Expected 1 or more, but got 0.
  - **Sprint regression**: introduced by TASK-731 commit c74a815 (subscribe-block coverage follow-up). The hoisted `mockSessionStoreSubscribe: vi.fn(() => () => undefined)` is inferred zero-arg; `.mockImplementation((cb) => ...)` then can't take a 1-arg listener.
  - Runtime impact: NONE — all 16 unit tests in this file still pass under `vitest run`. But CI typecheck gate is broken.

### pnpm lint — PASS (warnings only)
- 0 errors, 203 warnings across main + frontend. All warnings pre-exist on main (unused-vars, require-imports, no-useless-escape).
- No new lint warnings from any sprint task.

### pnpm test (Playwright E2E) — 15 fail, 5 skipped, all pre-existing
- All 15 failures show identical signature: `page.waitForSelector('body', { timeout: 10000 })` timing out because `body` is hidden.
- Root cause: Playwright opens its own Chromium pointed at http://localhost:4521 (Vite renderer), but the cyboflow renderer cannot bootstrap without Electron `preload`-injected `electronTRPC` (documented in CLAUDE.md and `docs/VISUAL-VERIFICATION-SETUP.md`).
- **Not a sprint regression**: `git log 117b0e6..HEAD -- tests/` is empty — SPRINT-033 did not touch any tests/ E2E file. These tests fail identically on main pre-sprint.
- Failing specs: git-status, health-check, permissions-ui-fixed, smoke, standalone-terminal-panels (3 + 5 + 3 + 2 + 2 = 15).

### Vitest suites — PASS
- frontend: 24 files, 320/320 tests passed (3.99s)
- main:     62 files, 641/641 tests passed (2.74s)
- Includes the new TASK-727 fixture tests (orchestratorTestDb.test.ts), TASK-728 (approvalListing.test.ts, approvalCreatedBridge.test.ts parity), TASK-730 (claudeCodeManagerWiring.test.ts convergence), and TASK-731 (usePanelSurface.test.tsx — 16/16).

## Regressions requiring attention

1. **HIGH — pnpm typecheck broken (TASK-731)**
   - Location: `frontend/src/hooks/__tests__/usePanelSurface.test.tsx:492`
   - Error: TS2345 — zero-arg `vi.fn(() => () => undefined)` cannot accept 1-arg mockImplementation
   - Introduced by: commit c74a815 (test(TASK-731): cover useSessionStore.subscribe block)
   - Suggested fix: change vi.hoisted seed to typed signature, e.g. `mockSessionStoreSubscribe: vi.fn<[(state: unknown) => void], () => void>(() => () => undefined)` so subsequent `.mockImplementation((cb: (state: StoreState) => void) => ...)` is assignable. Or simply seed it as `vi.fn((_cb: (state: unknown) => void) => () => undefined)`.
   - Runtime not affected (vitest passes) but `pnpm typecheck` (CI gate) blocked.

(No other sprint regressions. The 15 Playwright E2E failures pre-exist on `main` and are documented infrastructure limitations of the cyboflow Electron app, not a SPRINT-033 issue.)
