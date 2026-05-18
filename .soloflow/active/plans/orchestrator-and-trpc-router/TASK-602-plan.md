---
id: TASK-602
idea: SPRINT-009-compound
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - main/src/ipc/cyboflow.ts
  - main/src/orchestrator/runLauncher.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - tests/cyboflow-stream-publisher.spec.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
files_readonly:
  - main/src/preload.ts
  - frontend/src/utils/cyboflowApi.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - tests/helpers/cyboflowTestHarness.ts
  - main/src/index.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "Run orchestration emits stream events to the renderer via `mainWindow.webContents.send('cyboflow:stream:<runId>', event)`"
    verification: "grep -rn \"webContents.send('cyboflow:stream:\" main/src/ returns at least one match in either main/src/ipc/cyboflow.ts or main/src/orchestrator/runLauncher.ts (whichever owns the publish)"
  - criterion: RunView.tsx subscription comment is annotated `// TODO(epic-6)` if (and only if) the publisher delegates to a future tRPC subscription path; if the publisher uses raw IPC the comment is removed
    verification: "grep -n 'TODO(epic-6)\\|tRPC migration' frontend/src/components/cyboflow/RunView.tsx returns matches consistent with the chosen path (raw IPC live OR tRPC TODO documented)"
  - criterion: A new Playwright/Vitest spec exercises the full subscribe → publish → render path end-to-end
    verification: "test -f tests/cyboflow-stream-publisher.spec.ts AND grep -n 'subscribeToStreamEvents\\|cyboflow:stream:' tests/cyboflow-stream-publisher.spec.ts returns at least one match"
  - criterion: RunLauncher (or wherever the publish lives) accepts an optional event-publisher dependency injected via constructor — preserving the standalone-typecheck invariant (no electron import)
    verification: "grep -n 'StreamEventPublisher\\|publisher\\|publish' main/src/orchestrator/runLauncher.ts returns the dependency declaration; grep -n \"from 'electron'\" main/src/orchestrator/runLauncher.ts returns 0 matches"
  - criterion: Day-3 gate test (tests/cyboflow-day3-gate.spec.ts) continues to pass — the existing harness is not affected by the publisher addition
    verification: "pnpm test:gate exits 0 when claude is in PATH (or skip-pass when not)"
  - criterion: "The new spec uses real preload.ts whitelist (post-TASK-599 fix) — i.e. the spec depends on TASK-599's wrapper-storage fix and would fail if TASK-599 regressed"
    verification: "grep -rn 'electron.on.*cyboflow:stream\\|subscribeToStreamEvents' tests/cyboflow-stream-publisher.spec.ts returns at least one match"
depends_on:
  - TASK-599
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "End-to-end stream-event delivery is currently broken in three layers (preload, publisher, subscriber). A new spec that exercises subscribe → publish → assert is the canary for whether the fix holds; without it, regressions in any of the three layers slip through."
  targets:
    - behavior: RunLauncher.launch invokes the injected publisher with at least one stream event for the launched runId
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
    - behavior: "End-to-end: a renderer subscribes to cyboflow:stream:<runId>, the orchestrator publishes an event, the subscriber receives it"
      test_file: tests/cyboflow-stream-publisher.spec.ts
      type: integration
prerequisites:
  - check: "test -f main/src/preload.ts && grep -q 'cyboflow:stream:' main/src/preload.ts"
    fix: Complete TASK-599 (preload.ts whitelist + off() fix) before starting this task
    description: "Without TASK-599, the renderer subscription is dropped silently and any spec written here will fail for an unrelated reason"
    blocking: true
---
# Wire stream-event publisher (subscribe → publish → render path)

## Objective

After TASK-599 fixes the preload.ts whitelist, the renderer can subscribe to `cyboflow:stream:<runId>` but no main-process code is calling `mainWindow.webContents.send(...)` to actually publish anything. This task adds the publisher in the run orchestration path so that `RunView.tsx`'s subscription receives real events. The implementation must (a) avoid introducing an `electron` import inside `main/src/orchestrator/` (the standalone-typecheck invariant) and (b) be testable end-to-end by a new spec that drives the full subscribe → publish → render loop.

## Implementation Steps

1. Define a new dependency interface inside `main/src/orchestrator/runLauncher.ts` (no electron imports):
   ```ts
   export interface StreamEventPublisher {
     publish(runId: string, event: { type: string; payload: unknown; timestamp: string }): void;
   }
   ```
   Add as the 9th constructor argument (optional, after `nodeResolver`). Existing call sites that omit it continue to compile.
2. In `RunLauncher.launch`, after the `UPDATE workflow_runs SET status='starting'` block (line 109-111), publish a synthetic launch event so the renderer sees something immediately: `this.publisher?.publish(runId, { type: 'run_started', payload: { runId, worktreePath, branchName }, timestamp: new Date().toISOString() });` Add a brief comment that this is the wiring proof; richer events come from the SDK pipeline once integrated.
3. In `main/src/ipc/cyboflow.ts`, build a concrete publisher in `getRunLauncher()` that adapts `services.getMainWindow()`:
   ```ts
   const publisher: StreamEventPublisher = {
     publish: (runId, event) => {
       const win = services.getMainWindow();
       if (!win || win.isDestroyed()) return;
       win.webContents.send(`cyboflow:stream:${runId}`, event);
     },
   };
   ```
   Pass it as the 9th arg to `new RunLauncher(...)`. This is the only place `webContents.send` is called for cyboflow streams; keeps electron imports out of `orchestrator/`.
4. Update `frontend/src/components/cyboflow/RunView.tsx`. Today it subscribes via `cyboflowApi.subscribeToStreamEvents` (which uses `electron.on`). With this task and TASK-599 landed, that path becomes live. Remove or update the obsolete comment `tRPC migration note: replace with trpc.cyboflow.events.onStreamEvent({ runId })` to either: (a) `// TODO(epic-7-trpc-cutover): migrate to trpc.cyboflow.events.onStreamEvent({ runId })` if the tRPC path is the long-term goal per TASK-600, OR (b) delete the comment if raw IPC is the chosen permanent transport. Recommendation: keep the TODO with a real future task ID per TASK-600's documentation outcome.
5. Add a unit test to `main/src/orchestrator/__tests__/runLauncher.test.ts` (`describe('RunLauncher.launch publisher', ...)`) that constructs a spy publisher, runs `launch()`, and asserts: (a) `publisher.publish` was called at least once, (b) the `runId` arg matches the returned `runId`, (c) the event has `type: 'run_started'`. Use the same `dbAdapter` + in-memory DB pattern as the existing tests in the file.
6. Create new spec `tests/cyboflow-stream-publisher.spec.ts` (Playwright). Structure:
   - Boot the Electron app via the existing Playwright harness pattern (mirror `tests/cyboflow-picker.spec.ts` if it exists; otherwise model after the day-3-gate harness).
   - In a renderer-side `page.evaluate`, register a listener via `window.electron.on('cyboflow:stream:<knownRunId>', cb)` that pushes events to a window-scoped array.
   - Trigger `cyboflow:startRun` via `window.electron.invoke('cyboflow:startRun', { workflowId, projectId })`, then poll the window-scoped array for at least one event.
   - Assert the captured event has `type: 'run_started'` and a non-empty `runId`.
   - If the existing Playwright config can't easily start the Electron app, fall back to a Vitest integration test that mocks `getMainWindow` to capture `webContents.send` calls and asserts the publisher was invoked. Document the choice in the spec's top comment.
7. Run `pnpm --filter main test`, `pnpm test:gate` (skip-pass if claude isn't installed), and the new `tests/cyboflow-stream-publisher.spec.ts` (or its Vitest equivalent).

## Acceptance Criteria

See frontmatter. The end-to-end spec is the load-bearing AC: it depends on TASK-599's wrapper-storage fix AND on this task's publisher AND on RunView's subscription path all being correct simultaneously. If any one regresses, the spec fails.

## Test Strategy

Two new test entry points: a unit test on RunLauncher confirming the publisher is called with the right shape, and an integration spec confirming the full path works end-to-end. The integration spec is intentionally chosen to overlap with TASK-599's surface area so a regression in either task is caught.

## Hardest Decision

Where the publish lives. Three options: (a) inside `RunLauncher.launch`, (b) inside `main/src/ipc/cyboflow.ts` after launch returns, (c) inside an SDK-event router that ALSO writes raw_events. Picked (a) for the wiring proof event (`run_started`), with the understanding that real per-event publishing lives in (c) once the SDK pipeline is connected. Putting the wiring proof in `RunLauncher` ensures the day-3 gate harness exercises it (the harness uses RunLauncher directly, bypassing IPC), which keeps the test path coherent.

## Rejected Alternatives

- **Implement the real tRPC subscription publisher in events.ts instead of raw IPC.** Rejected because TASK-600 documents raw IPC as the live transport for now; building the tRPC publisher first would require landing the tRPC client wiring in cyboflowApi.ts simultaneously, which is a sprint, not a task.
- **Skip the synthetic `run_started` event and only publish real SDK events.** Rejected because the SDK event pipeline isn't wired in `RunLauncher` yet (the day-3 harness wires it via the test harness, not via RunLauncher itself); without a synthetic seed event there's nothing for the integration spec to wait on.

## Lowest Confidence Area

Whether the new Playwright spec can boot the Electron app reliably in CI. The repo has existing Playwright specs but they are gated on local env (e.g. `findExecutableInPath('claude')`); a new spec that needs `pnpm dev` running may be flaky. If integration boot proves flaky, downgrade to the Vitest-with-mocked-`getMainWindow` variant called out in step 6, which is deterministic.
