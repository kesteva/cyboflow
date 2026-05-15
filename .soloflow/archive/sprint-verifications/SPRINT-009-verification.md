---
sprint: SPRINT-009
visual_mobile: skipped_user_preference
visual_web:    skipped_unable
visual_macos:  skipped_user_preference
visual_mobile_note: "verification.visual_mobile=false"
visual_web_note:    "Electron renderer dev server (http://localhost:4521) not running; TASK-354 already filed deferred entry (dedup_key=visual_web_unavailable) — not re-queued"
visual_macos_note:  "verification.visual_macos=false"
regressions_count: 1
flows_tested: 0
flows_deferred: 1
---

## Sprint Verification Report
- **Sprint:** SPRINT-009
- **Sprint-verification file:** /Users/raimundoesteva/Developer/cyboflow/.soloflow/active/sprint-verification.md

### Visual Verification

- **visual_mobile:** skipped_user_preference — verification.visual_mobile=false in resolved config
- **visual_web:**    skipped_unable — Electron renderer dev server (http://localhost:4521) returned connection refused; not re-queued because TASK-354 already filed `dedup_key: visual_web_unavailable` in the human-review-queue
- **visual_macos:**  skipped_user_preference — verification.visual_macos=false in resolved config
- **Flows tested:** 0
- **Flows deferred:** 1 (WorkflowPicker → Start Run → RunView event log; deferred via TASK-354 queue entry)
- **Failures:** none observed (no flows could be exercised)
- **Deferred:**
  - WorkflowPicker → Start Run → RunView (workflow select renders 5 SoloFlow workflows; Start Run creates worktree under .cyboflow/worktrees/<workflow>/<runId8>; RunView event log appends stream events as Claude emits them) — awaiting `pnpm dev` + interactive verification per TASK-354 review-queue entry

### Cross-task static integration analysis (substitute for unrunnable visual flow)

Because the dev server was unreachable, I performed a static end-to-end trace of the new Cyboflow surface against the legacy Crystal SessionView surface in the renderer + preload + IPC + orchestrator stack. One sprint-wide regression surfaced that per-task verification missed:

- **`cyboflow:stream:<runId>` channel is not whitelisted in `main/src/preload.ts:613-627`** (whitelist contains only `'permission:request'`). `cyboflowApi.subscribeToStreamEvents()` (TASK-354, `frontend/src/utils/cyboflowApi.ts:101-110`) calls `electron.on('cyboflow:stream:' + runId, handler)` which the preload silently no-ops because the channel fails the whitelist check. The RunView component (`frontend/src/components/cyboflow/RunView.tsx:16-27`) registers the subscription, gets back the cleanup, and **never receives a single event at runtime**. AC#3 of TASK-354 was verified by string-grep, not by an end-to-end subscribe→publish→assert path; the day-3 gate test (TASK-355) bypasses the IPC channel entirely and drives `ApprovalRouter.respond()` directly, so it cannot detect this gap either. This is exactly the "all per-task gates pass but the sprint-wide UX is broken" failure the sprint verifier exists to catch. It is already filed as **FIND-SPRINT-009-6 (high)** in `.soloflow/active/findings/SPRINT-009-findings.md`. A secondary defect in the same block: `electron.off()` calls `ipcRenderer.removeListener(channel, callback)` with the user's bare callback, but `electron.on()` wraps it as `(_event, ...args) => callback(...args)`, so the listener cannot be removed even if the channel were whitelisted.

  Cross-task attribution: TASK-354 created the renderer subscription pipeline; preload.ts is not in any TASK-351..TASK-355 `files_owned` list. The fix belongs to either a follow-up task in this epic or the next epic that touches the stream pipeline.

- **App.tsx ↔ legacy SessionView coexistence (TASK-354)**: the new `useLegacyCrystalView` toggle defaults to `false` and gates on `activeProjectId !== null`. When no project is selected, `SessionView` still renders (App.tsx:382-400), preserving the legacy entry path. The `useSessionStore` cleanup interval (App.tsx:113-152) still fires regardless of which view is active, so the legacy session lifecycle is not starved. No regression here.

- **WorktreeManager refactor (TASK-352)**: `createWorktree` was extracted into `_createAtPath` and a new `createDeterministicWorktree` was added. Both go through the shared private helper, and the existing `withLock` semantics are preserved (`worktree-create-<projectPath>-<name>` for legacy callers, `worktree-create-<projectPath>-<runId8>` for cyboflow). The 5 `worktreeManager.test.ts` tests pass, including the integration test that actually creates a real branch matching `cyboflow/<workflowName>/<runId8>`. No regression observed for legacy session creation.

- **claudeCodeManager.buildCommandArgs (TASK-353)**: changed from returning `[]` unconditionally to returning `['--strict-mcp-config']` when `options.strictMcpConfig === true`. Default is `undefined`/falsy, so legacy Crystal session callers (which never pass the flag) get the same empty array as before. No regression observed for legacy session spawning.

- **schema.sql vs migration 006 collision (TASK-351)**: already filed as **FIND-SPRINT-009-1 (high)**. Both DDL paths declare `workflows` and `workflow_runs` with incompatible column shapes; `schema.sql` runs first and the `IF NOT EXISTS` guard in migration 006 silently no-ops. Sprint-009's code only reads/writes the columns declared in `schema.sql`, so this does not break anything in this sprint, but it is a latent integration hazard for any future task that touches `spec_json` / `policy_json` / `stuck_*` columns from the system-design schema.

### Integration Tests

(Pass 2 — equivalent of integration-tester pass; no Task tool available in this environment, so these were run inline.)

- **Typecheck (`pnpm typecheck`)**: PASS. 0 errors across `frontend`, `main`, `shared` workspaces. Output:
  ```
  frontend typecheck: Done
  main typecheck: Done
  shared typecheck: Done
  ```
- **Lint (`pnpm lint`)**: PASS (0 errors, 303 warnings — all pre-existing, no new errors introduced by the sprint).
- **Main workspace unit suite (`pnpm --filter main exec vitest run`)**: PASS. 22 test files, 219 tests passed in 1.41s. Includes the new sprint-009 suites:
  - `src/orchestrator/__tests__/workflowRegistry.test.ts` (18 tests)
  - `src/orchestrator/__tests__/runLauncher.test.ts` (8 tests)
  - `src/orchestrator/__tests__/mcpConfigWriter.test.ts` (5 tests)
  - `src/services/__tests__/worktreeManager.test.ts` (5 tests, includes a real-git integration case)
  - `src/ipc/__tests__/cyboflow.test.ts` (10 tests)
- **Day-3 gate integration (`pnpm test:gate`)**: PASS. 1 test, 8.08s, runs two real Claude processes (sprint workflow + prune workflow) in parallel, both pause on tool-use approvals, prune is approved first, sprint remains paused, then sprint is approved — both resume independently. This is the epic Success Signal and it deterministically passes within the 7-12s envelope claimed by TASK-355.
- **Playwright E2E (`pnpm test`)**: NOT RUN. Playwright specs in `tests/cyboflow-picker.spec.ts` require a running Electron build, and the Playwright spawn pattern in this repo is itself the surface that would tell us whether `cyboflow:stream:*` events flow end-to-end. Same blocker as visual_web; covered by the existing TASK-354 deferred entry.

### Regressions requiring attention

1. **HIGH — `cyboflow:stream:<runId>` channel not whitelisted in preload.ts**. RunView event subscription is dead-on-arrival; the entire stream-events UX promised by TASK-354 will not function in the running app despite all per-task gates passing. Already filed as FIND-SPRINT-009-6. Belongs to the next task that touches the stream pipeline (e.g. epic 6 `orchestrator-and-trpc-router`, or a same-epic follow-up). Suggested fix:
   ```
   const validChannels = ['permission:request'];
   if (validChannels.includes(channel) || channel.startsWith('cyboflow:stream:')) { ... }
   ```
   plus a per-(channel, callback) WeakMap so `off()` can remove the wrapped listener.

2. **HIGH — schema.sql vs migration 006 column-shape divergence**. Already filed as FIND-SPRINT-009-1. Not a Sprint-009 functional regression (Sprint-009 code only touches the `schema.sql` columns), but a latent hazard the next epic must reconcile before any task lands code that reads `spec_json` / `policy_json` / `stuck_*`.

3. **MEDIUM — RunLauncher silently skips `.mcp.json` write when MCP collaborators are partially injected**. Already filed as FIND-SPRINT-009-3. Not a current regression because no production wiring exists yet, but a partial-wiring regression in epic 6 (e.g. forgetting `nodeResolver`) would silently launch runs without the cyboflow-permissions bridge — the entire security premise of TASK-353 — with no log line. Suggested mitigation captured in the finding.

4. **LOW — RunLauncher.launch leaves an orphaned `workflow_runs` row if `createDeterministicWorktree` throws after `createRun` succeeded**. Already filed as FIND-SPRINT-009-2. Not a Sprint-009 regression; a known-out-of-scope ergonomic gap for a future task.

No regressions appeared in the integration test suite (typecheck/lint/vitest/test:gate all pass). All four regressions above are static cross-task observations that the per-task verifier did not have visibility into, and the most severe of them (FIND-SPRINT-009-6) is what would have failed the visual_web flow if the dev server had been reachable.
