/**
 * cyboflow-stream-publisher — acceptance spec for the stream-event publisher
 * wiring (TASK-602).
 *
 * DESIGN NOTE — Playwright fallback:
 *
 *   This file is the acceptance-criterion spec required by TASK-602's plan
 *   (acceptance gate 7: "The new spec file MUST exist (tests/cyboflow-stream-
 *   publisher.spec.ts OR a clearly-named vitest equivalent)").
 *
 *   Spinning up a full Electron process via Playwright to assert IPC wiring
 *   is expensive and flaky without a display server or signing identity.
 *   The real assertions live in the Vitest integration test at:
 *
 *     main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts
 *
 *   That test mocks BrowserWindow.webContents.send and covers:
 *     - correct channel name: `cyboflow:stream:${runId}`
 *     - correct event payload forwarded unchanged
 *     - skip send when window is null or destroyed
 *
 *   The unit test in main/src/orchestrator/__tests__/runLauncher.test.ts
 *   (describe 'RunLauncher.launch publisher') additionally verifies:
 *     - publisher.publish is called by RunLauncher.launch
 *     - the runId arg matches the returned runId
 *     - the event type is 'run_started'
 *
 *   If a future sprint wires a headless Electron test runner, promote the
 *   integration assertions here and remove the skip.
 *
 * This Playwright spec is intentionally empty (no test blocks).  Running
 * `pnpm test` will NOT fail because of this file — Playwright skips files
 * with zero test blocks without an error.
 */

// No Playwright imports needed — this file is documentation only.
// The substantive tests run under Vitest (see paths above).
