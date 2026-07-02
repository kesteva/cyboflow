# Test-Coverage Tightening Plan — cyboflow

_Status: EXECUTED 2026-07-02 — Milestones 0–2 + Workstream A landed (~493 tests added, all gates green; e2e reworked onto `_electron.launch()`, now 11 passed / 2 skipped). Deferred: C3/C4 coverage-threshold ratchet (needs accumulated baselines) and the two `test.skip`ped terminal-panel interactions (need a live-`claude` session fixture). Product bugs surfaced during execution are tracked in the wrap-up report, not fixed here._

## 1. Current state

The suite is large and mostly behavior-driven where it exists: **~218 main test files / 3223 tests (~12s)** and **~1754 frontend tests**, with genuinely deep coverage on the DB-write chokepoints (`taskChangeRouter`, `workflowRegistry`, `runExecutor`, `substrateResolver`), the `WorkflowController` DAG/fan-out state machine, the SDK `claudeCodeManager` (101 cases), the zustand review-queue stores, and the migration/schema-parity infrastructure. But coverage is **measured in neither workspace as part of any gate** (main has dormant, never-invoked `@vitest/coverage-v8` tooling; frontend resolves coverage-v8 only by an accidental root-node_modules phantom link), the `_electron.launch()`-less Playwright config makes the entire e2e tier a structural no-op in CI, and the highest-blast-radius seams — destructive git IPC handlers, `worktreeManager`'s merge-into-real-main path, the live `killProcessTree`/`spawnPtyProcess` PTY primitives, the `useIPCEvents`/`sessionStore` renderer ingestion core, the shared `mutex` concurrency guard, and the MCP `create-sprint-batch`/artifact write cases — ship with **zero direct tests**. The gaps cluster at chokepoint *seams* and destructive/concurrency paths, not inside individual well-tested units.

---
## 2. Workstream A: Fix the integration (e2e) suite

**Actual root cause (verified against the configs and all 7 specs):** all three Playwright configs (`playwright.config.ts`, `playwright.ci.config.ts`, `playwright.ci.minimal.config.ts`) run a plain **Chromium browser project** against `baseURL: http://localhost:4521` — the Vite dev renderer over HTTP. The `webServer: pnpm electron-dev` block does launch a real Electron window, but Playwright never attaches to it; the test `page` is a vanilla Chromium tab. That tab has no preload, so `window.electronAPI` / `window.electron` / `exposeElectronTRPC()` (`main/src/preload.ts:163/624/612`) don't exist, `App.tsx:216` early-returns, and every IPC-backed `data-testid` (`settings-button`, `sidebar`, `open-workflow-picker`, panel tabs, permission-mode radios) never mounts — specs hang to timeout.

Refinements found on the ground:

- `health-check.spec.ts` and `smoke.spec.ts` test 1 **false-pass** today — they only assert the static `<title>Cyboflow</title>` from `frontend/index.html`, which the bare Vite page serves fine. They are green without testing anything.
- `cyboflow-stream-publisher.spec.ts` is an **empty stub** (zero test blocks); its real assertions live in `main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts`.
- DB safety today is accidental: tests never reach a main process, so they never touch a DB. Under `_electron.launch()` the app **will** open `~/.cyboflow_dev/sessions.db` unless redirected — the fixture must close this before anything else lands.

### Fixture design

- **Launch:** `_electron.launch({ args: ['main/dist/main/src/index.js', '--cyboflow-dir=<tmp>'], env: { NODE_ENV: 'production', CYBOFLOW_DIR: <tmp>, ELECTRON_DISABLE_SANDBOX: '1' } })`. `NODE_ENV=production` flips `isDevelopment` (`main/src/index.ts:188`) so the window `loadFile`s the built `frontend/dist/index.html` (`index.ts:278-282`) — no Vite dev server in the loop at all.
- **Prereqs:** `pnpm build:main` + `pnpm build:frontend` + `pnpm electron:rebuild` (better-sqlite3 must match the **Electron** ABI for the launched app). Wire as a `pretest:e2e` or extend `setup`.
- **Data isolation (load-bearing):** `main/src/utils/cyboflowDirectory.ts` honors `CYBOFLOW_DIR` env and the `--cyboflow-dir` CLI flag (`index.ts:213-229`) ahead of `~/.cyboflow_dev`. Fixture creates `mkdtemp('cyboflow-e2e-')` per worker, passes both, `rmSync` on teardown.
- **Sanity gate:** after `app.firstWindow()`, assert `win.evaluate(() => !!window.electronAPI)` so a preload regression fails fast with a clear message instead of a selector timeout.
- **Helpers (new `tests/helpers/electronApp.ts`):** `launchApp()` fixture; `dismissDialogs(page)` (consolidates 4 copy-pasted Get-Started/analytics dismissers); `seedProject(dataDir, repoPath)` (fresh `CYBOFLOW_DIR` has zero projects, so picker/terminal specs currently `test.skip` — seed via the better-sqlite3 pattern in `tests/helpers/cyboflowTestHarness.ts`); `settle(page)` replacing ad-hoc `waitForTimeout`.

### Sequenced tasks

1. **A1 — Fixture + proof-of-life (M):** write `electronApp.ts`, convert `health-check.spec.ts` to launch the built bundle with a tmp `CYBOFLOW_DIR` and assert `window.electronAPI` + sidebar mount. Validates build-prereq, preload, and data isolation in one spec.
2. **A2 — Convert the no-seed specs (S):** `smoke.spec.ts`, then `permissions-ui-fixed.spec.ts` (its selectors are already valid — highest-value real assertion in the suite). Proves live IPC round-trips.
3. **A3 — `seedProject` + convert seeded specs (M):** `cyboflow-picker.spec.ts` (fix stale "5 SoloFlow workflows" expectations → `planner/sprint/compound`) and `standalone-terminal-panels.spec.ts` (needs a cheap worktree fixture per its own TODO).
4. **A4 — Delete dead weight (S):** remove `cyboflow-stream-publisher.spec.ts` (empty stub, covered in vitest) and `git-status.spec.ts` (both tests no-op on a fresh data dir; reintroduce only with a real seeded-session fixture if it earns its keep).
5. **A5 — Two-tier config rework (S):** smoke tier (health-check + smoke + permissions, no seeding, parallelizable — each test gets its own `CYBOFLOW_DIR`) replaces `playwright.ci.minimal.config.ts`; full tier (adds seeded specs, `workers: 1`) replaces `playwright.ci.config.ts`. Drop `webServer`/`baseURL` from all configs.
6. **A6 — CI job (S):** smoke tier on a **macOS runner** (ship-target fidelity, no xvfb), full tier optionally on linux + `xvfb-run -a` (the existing `DISPLAY=:99` assumption carries over, now wrapping Electron instead of an unused browser). Report-only until green two consecutive runs, then blocking; at that point delete the CLAUDE.md "treat e2e failures as environmental" caveat.

### Spec triage

| Spec | What it tests | Verdict | Effort | Notes |
|---|---|---|---|---|
| `health-check.spec.ts` | boot + title | **Rewrite** | S | False-green today; becomes the proof-of-life spec |
| `smoke.spec.ts` | title, sidebar, settings-button | **Rewrite** | S | Test 1 false-passes, 2-3 hang; straight port onto fixture |
| `permissions-ui-fixed.spec.ts` | Settings → default permission mode radio | **Salvage** | S | Selectors valid; only needs the fixture |
| `cyboflow-picker.spec.ts` | WorkflowPicker modal, flow options, Start Run | **Rewrite** | M | Needs `seedProject`; stale flow-name expectations |
| `standalone-terminal-panels.spec.ts` | add-terminal button → active tab | **Rewrite** | M | Needs `seedProject` + worktree fixture; largest surface |
| `git-status.spec.ts` | per-session git-status indicators | **Delete/defer** | — | No-ops without seeded sessions; near-zero value vs fixture cost |
| `cyboflow-stream-publisher.spec.ts` | (empty stub) | **Delete** | S | Real coverage already in vitest |


---
## 3. Workstream B: Close unit-coverage gaps

Batched so each is an independently-shippable **parallel agent lane partitioned by file** (no two batches edit the same source/test file). Ordered by **risk-per-effort** (highest first).

> Struck per critic pass: `sessionPermissionMode.ts` (already covered by `main/src/ipc/__tests__/sessionPermissionMode.test.ts`) and `worktreeManager.deleteBranch` (already integration-tested). These are **not** in any batch below.

### B1 — MCP write-path seams + eval SDK boundary · risk: **critical/high** · effort: **M**
Files: `main/src/orchestrator/mcpServer/mcpQueryHandler.ts`, `main/src/orchestrator/eval/evalJudgeQuery.ts`, `main/src/orchestrator/eval/judgePromptScaffold.ts` (+ their new `__tests__`).
- `handleCreateSprintBatch` (`mcp-create-sprint-batch`): happy-path mints batch+lanes and CAS-stamps `workflow_runs.batch_id`; second call idempotent (returns existing `batchId`, `created:false`); explicit `taskIds` subset intersects against run-created tasks (foreign id dropped); omitted `taskIds` materializes all; empty set → `ship_no_tasks_to_materialize` (no write); over-cap → `ship_batch_too_large` per `SPRINT_BATCH_MAX_TASKS[substrate]`; substrate defaults `'sdk'` when column/row missing; `SprintLaneStore.createForRun` throw rolls back (no orphan stamp); `retireRunOwnedIdeas` failure never fails response.
- `handleReportArtifact`/`handleCommitArtifact`: happy paths reply `{artifactId, atype}` / `{artifactId, committed:true}`; `actor` coercion `'linear'→'agent:unknown'`; `resolveReviewItemRunContext` `ok:false` → `ok:false` with `ctx.error`; each `ArtifactError` code (`not_found`, `invalid_atype`, `already_committed`, `run_not_found`, `wrong_project`) surfaced via `writeArtifactError` as `` `${code}: ${message}` ``.
- `evalJudgeQuery` (mirror `programmatic/__tests__/monitorQuery.test.ts` against a mocked `@anthropic-ai/claude-agent-sdk`): returns `structured_output`; passes `JUDGE_ALLOWED_TOOLS`+`json_schema`+cwd/model/maxTurns; `null` when no success drains; throws on iterator throw; aborts-and-throws on timeout (default + custom `timeoutMs`); bridges caller `AbortSignal` → SDK `abortController`; `cleanup()` clears timer/listener on throw.
- `judgePromptScaffold`: schema `required`/enum ids match rubric sub-check ids; prompt embeds every sub-check id the schema requires (no drift); snapshot-lock the schema shape.
- **Retires:** silent batch double-mint/task-drop/cap-bypass; opaque artifact error regression; paid-Claude hang/spurious-retry on judge timeout; K=3→K<3 schema-drift degradation.

### B2 — Orchestrator gate / cancel / recovery seams · risk: **high/medium** · effort: **M**
Files: `main/src/orchestrator/humanStepManager.ts`, `cancelRunHandler.ts`, `approvalRouter.ts`, `reviewItemListing.ts`, `questionListing.ts`, `stuckDetector.ts`.
- `humanStepManager.maybeResumeRun` (the path the `reviewItems.resolve` mutation drives): seed run `awaiting_review` + one pending blocking `review_item` (kind `permission`/`decision`, **not** via `resolveHumanGate`) → `maybeResumeRun(runId)` returns `true`, run flips `running`, `runStatusEvents` emits `changed`; returns `false`/leaves run alone when a second blocking item still pending; no-op when run not `awaiting_review`. `findPendingGate`: real DB row `gate:human-step:<step>` round-trips; `null` when absent or table missing.
- `cancelRunHandler.clearPendingHumanGatesForRun`: spy called with correct `runId`; called **after** `stopLiveRun` resolves (ordering assertion); handler awaits it (slow spy delays completion); omitting the dep doesn't throw and cancel still completes.
- `approvalRouter.recoverStaleAwaitingReview`: seed folded pending `review_items` (`kind='permission'`, matching `payload.approvalId`) alongside the approvals row → row becomes `status='resolved'`, `resolved_by='system'`, `resolution='app_restart'`; **document the current no-emit behavior** with an explicit regression assertion.
- `reviewItemListing` (the sanctioned co-write exception): `hasReviewItemsTable` WeakMap memoization (no re-query per db handle); `resolvePermissionReviewItem` → `null` on no `approvalId` match; `resolveReviewItemRow` → `null` (not throw) on double-resolve; `count/selectPendingBlockingReviewItems`/`selectFindingForSeed` return empty-safe defaults (`0`/`[]`/`null`) when table absent.
- `questionListing.selectPendingQuestions`: malformed `questions_json` → row surfaces with `questions:[]` (not thrown/omitted); well-formed round-trips; `workflowName` JOIN + `createdAt` ISO normalize.
- `stuckDetector.scan`: seed run `awaiting_review` with **only** a pending human-gate decision `review_item` (no approvals row) past threshold → assert **current** behavior (no transition, no `runs:stuck`), pinning the blind spot as intentional/documented.
- **Retires:** permanently-stuck resolved runs; orphaned mid-open gate rows on cancel; boot-recovery review-item desync; malformed-row list corruption; the human-gate stuck-detector blind spot going undocumented.

### B3 — tRPC subscription primitive + routers + plugin disk layer · risk: **high/medium** · effort: **M**
Files: `main/src/orchestrator/trpc/routers/events.ts`, `trpc/routers/artifacts.ts`, `trpc/routers/substrates.ts`, `main/src/orchestrator/integrations/installedPlugins.ts`.
- `eventToAsyncIterable`: emit one event while iterator awaits → yielded; emit two synchronously before consumer resumes → both yielded in order (no drop); abort mid-wait → loop terminates cleanly and `emitter.listenerCount` returns to zero (`off`/`removeEventListener` actually called).
- `artifacts` router: `list` with/without `committed` filter builds correct WHERE + maps via `ArtifactRouter.shapeRow`; `get` → `null` on missing; `commit` forwards `op:'commit'`, `actor:'user'`, optional `payloadJson`; each `ArtifactError` code → mapped `TRPCError` (esp. `already_committed→CONFLICT`); every proc throws `PRECONDITION_FAILED` when `ctx.db` unwired; `onArtifactChanged` scoped to `artifactProjectChannel(projectId)` + respects abort.
- `substrates.resolveEffective`: forced pin (`ctx.getForcedSubstrate()` non-null) outranks and ignores `requestedSubstrate`; falls through to `resolveSubstrate(requested, env)` when pin null; defaults `getForcedSubstrate` to `()=>null` when omitted.
- `installedPlugins` (inject temp HOME / injectable root): well-formed `installed_plugins.json` splits id/name/marketplace (incl. id with no `@`); malformed/missing → `[]`; non-object `plugins` → `[]`; missing optional per-plugin fields default; `readUserEnabledPluginsMap` malformed/non-object `enabledPlugins` → `{}`; non-boolean value coerced to `false` (`=== true`).
- **Retires:** dropped/duplicated push-subscription events (stale review-queue/rail UI); uncoded-500 artifact errors; picker previewing wrong batch cap under a forced-substrate lock; silent wrong-plugin-set spawns from a half-written catalogue.

### B4 — Live PTY base primitives · risk: **critical/high** · effort: **M**
Files: `main/src/services/panels/cli/AbstractCliManager.ts` (via a minimal concrete subclass, real child processes — do **not** use the `pid=0` FakePty bypass).
- `killProcessTree`: spawn `sh -c 'sleep 100 & sleep 100 & wait'`, kill, poll all descendants gone; SIGTERM-then-timeout-SIGKILL escalation via a SIGTERM-ignoring child; already-exited pid resolves without throwing; `getAllDescendantPids` returns empty-safe on a childless pid.
- `spawnPtyProcess`: call the base impl with a trivial command (`node -e 'process.exit(0)'` / shell echo) → correct cwd, passed env visible to child, returned `IPty` exposes pid/exit; failure path when command absent.
- **Retires:** interactive-substrate process-tree leaks (unkillable descendants) and arg/env/cwd assembly regressions that the FakePty override structurally hides. (These files are LIVE per CLAUDE.md dual-substrate note — do not mark `@cyboflow-hidden`.)

### B5 — worktreeManager destructive lifecycle · risk: **critical/high** · effort: **L**
Files: `main/src/services/worktreeManager.ts` (real-git tmp-repo integration tests, mirroring the existing `mergeWorktreeToBranch` style).
- `squashAndMergeWorktreeToMain`/`mergeWorktreeToMain` (mutate the user's **actual main**): squash-merge clean branch → single squashed commit + footer + ff-only ok; non-squash multi-commit merge lands all commits; conflicting change on both sides → conflict thrown, rebase aborted, worktree clean, **main untouched**; main advances between rebase and checkout+merge → ff-only fails loudly (no silent history rewrite); `no commits to merge/squash` guard fires when branch === main tip.
- `removeWorktree`/`removeWorktreeByPath`: remove-already-removed twice → second is silent no-op; `--force` on uncommitted changes discards them (documents intended data loss); an unrelated git error (invalid projectPath) **does** throw (matcher not overly broad).
- `checkForRebaseConflicts`/`rebaseMainIntoWorktree`/`abortRebase`: same-line edits → conflicting files reported; divergent non-conflicting → none reported; successful rebase includes main's commits; conflicting pair leaves mid-rebase, `abortRebase` cleanly returns to pre-rebase HEAD.
- `createWorktree`/`initializeProject`: create at `baseDir/name` off `baseBranch` (default + explicit); same-name collision; `initializeProject` bootstraps `.cyboflow/worktrees` + git config idempotently.
- `gitPull`/`gitPush`/`getLastCommits`: fast-forward vs diverged/conflict surfaced; rejected-push (remote ahead) surfaced; `getLastCommits` shape capped at `count`.
- **Retires:** the single highest data-loss blast radius in the codebase (silent main-branch clobber), close-out idempotency false-positives, and pre-merge conflict-gate false negatives.

### B6 — gitDiff + session/panel-bundle service seams · risk: **medium** · effort: **M**
Files: `main/src/services/gitDiffManager.ts`, `main/src/services/sessionManager.ts` (archive slice), `main/src/services/panels/claude/workflowBundleInstall.ts`.
- `getCombinedDiff`: no `origin` remote → falls back to working-dir diff **and result is distinguishable** from a true combined diff (flag as bug if not); normal case with fetched `origin/main` → correct diff/stats/changedFiles. `captureDiffAgainstRef` (moving ref); `captureCommitDiff` single- and multi-commit + `toCommit`-omitted→HEAD default.
- `sessionManager.archiveSession`: not-found id throws before side effects; panels unregistered; a throwing panel-unregister still allows terminal close + `activeSessions.delete` + `session-deleted` emit; `session-deleted` payload shape. `addPanelOutput` auto-context-capture vs normal DB-persist branches.
- `workflowBundleInstall`: `ensureBundleExcluded` appends both globs + marker to fresh `info/exclude`, second call no-op (no dupes), pre-existing no-trailing-newline file closed before append, non-git path fails soft; `installWorkflowBundle` DB-miss → no-op write, `writer.write()` throw caught+logged (never propagated to spawn).
- **Retires:** working-tree diff masquerading as run diff; inconsistent session teardown on panel-unregister failure; generated `cyboflow-*.md` files leaking into run diffs/commits.

### B7 — Destructive IPC handlers · risk: **critical/high** · effort: **L**
Files: `main/src/ipc/git.ts`, `main/src/ipc/file.ts`, `main/src/ipc/session.ts`, `main/src/ipc/project.ts`, `main/src/ipc/ideaAttachments.ts`, `main/src/ipc/commitMode.ts` (new `ipc/__tests__/`).
- `git.ts` (20 handlers): `squash-and-rebase-to-main`/`rebase-to-main`/`rebase-main-into-worktree` conflict-detected short-circuit **does not** mutate worktree vs clean-rebase branch; `git-push` force-vs-normal + failure surfacing; `abort-rebase-and-use-claude` when NOT mid-rebase is a no-op (no throw); the 30s/120s `Promise.race` timeouts reject+report instead of hanging.
- `file.ts`: `git:restore` (`reset --hard` + `clean -fd`) discards uncommitted changes, and returns `success:false` with no mutation when session/worktree missing; `read`/`write` reject `../` + absolute paths **and** a sibling-prefix dir (worktree `/tmp/wt`, target `/tmp/wt-other/x`); `readAtRevision` → empty content when file absent at revision vs real git error; `write` creates nested dirs.
- `session.ts` `sessions:delete`: already-archived → `success:false` no side effects; interactive+`chat_run_id` calls `killLiveSession` **before** worktree removal; a `cancelHostedRuns()` throw still lets archive+stamp proceed (fail-soft); `stampSessionRunsOutcome` idempotent when outcome already set.
- `project.ts` `projects:delete`: running-script stopped before delete; worktree-removal attempted for all N sessions even when one throws; `deleteProject()` only after cleanup attempts; unknown id → `success:false` untouched.
- `ideaAttachments.ts`: path/name sanitization rejects traversal; duplicate filenames don't overwrite; delete removes only the targeted file.
- `commitMode.ts`: `update-session-settings` round-trips `CommitModeSettings` JSON unchanged; `get-project-characteristics` failure returns usable default (no throw).
- **Retires:** irreversible `reset --hard`/`clean -fd` and sibling-dir path-escape data loss; ordering-invariant breaks in the ~175-line delete chokepoints; opaque timeout hangs.

### B8 — DB CRUD, migrations, mutex, pure utils · risk: **high/medium** · effort: **M**
Files: `main/src/database/database.ts` (folder CRUD), `main/src/utils/mutex.ts`, migrations `021/027/028/029/031/032/033/038/039`, plus a full-chain continuity test, `main/src/utils/contextCompactor.ts`, `main/src/utils/sessionValidation.ts`.
- `mutex`: two concurrent `acquire()` on same resource serialize (2nd waits for `release()`); `acquire()` throws on timeout when never released (polling loop gives up); `withLock()` releases even when `fn()` throws; `releaseAll()` unblocks all waiters; different resource names never block each other; the `this.locks.get(name) === lockPromise` release-identity check (no stale lock / double-release).
- `database.ts`: `wouldCreateCircularReference` true for move-into-own-descendant and for a pre-existing data cycle; `getFolderDepth` correct for a 3-level chain and bails at `depth>10` on a pathological cycle; `deleteFolder` leaves child sessions `folder_id=NULL` (ON DELETE SET NULL); `reorderFolders` matches BOTH id and project_id (cross-project isolation).
- Migrations `038/039`: re-run idempotent (duplicate-column caught); `DEFAULT '[]'` round-trips as empty array; `029` `UNIQUE(project_id, agent_key)` still enforced post-ADD-COLUMN; `028` idea_attachments FK/cascade on parent-idea delete.
- **Full-chain continuity (cross-cutting):** fresh `:memory:` DB → `DatabaseService.initialize()` → assert `user_version == 44` (highest prefix) and a representative column from the latest migration exists — catches an ordering/FK-dependent migration that passes every per-migration test.
- `contextCompactor`: preserves most-recent N turns verbatim; already-short transcript no-op; malformed entries don't throw; token-estimate threshold matches expected. `sessionValidation`: per-exported-validator valid/invalid boundary (read exports first).
- **Retires:** the untested shared concurrency chokepoint (silent worktree-creation corruption); folder-cycle infinite loops; JSON-column security-surface defaults on 038/039; a predecessor-ordering migration break shipping green.

### B9 — Frontend renderer ingestion core + stores · risk: **critical/high** · effort: **L**
Files: `frontend/src/hooks/useIPCEvents.ts`, `stores/sessionStore.ts`, `stores/reviewItemsSlice.ts`, `hooks/useSprintLanes.ts`, `utils/sanitizer.ts`, `stores/panelStore.ts`, `stores/modelAvailabilityStore.ts`, `utils/api.ts`.
- `useIPCEvents` (the other 12 handlers beyond `panel:updated`): `onSessionUpdated` rejects payload missing id/session (no write) and dispatches `session-status-changed` only when updated session IS active + status stopped/completed_unviewed/error; `onSessionDeleted` accepts string + `{id}`/`{sessionId}` shapes; `onSessionsLoaded` sets `gitStatusLoading` for non-archived no-gitStatus sessions, skips archived; `onSessionOutput`/`onTerminalOutput`/`onSessionOutputAvailable` `validateEventSession()` drops mismatched sessionId; `onZombieProcessesDetected` joins pids into details; `throttle()` coalesces within window / fires immediately when spaced; batch git-status handlers call the `*Batch` setter once + one CustomEvent per session; unmount calls every unsubscribe exactly once.
- `sessionStore`: `addSessionOutput` caps `output` at 300 + `jsonMessages` at 100 + mirrors into `activeMainRepoSession`; `setSessionOutputs` >500-item input returns last N (not mid-array truncation); `setActiveSession` null-clear / already-in-store / main-repo / fetch-fallback / error-path branches; `updateSession` preserves pre-existing output/jsonMessages arrays (silent-drop footgun); 50ms git-status batch coalesces; `cleanupInactiveSessions` spares active + short arrays.
- `reviewItemsSlice`: `applyReviewItemChangeToList` upsert-by-id/append/no-mutate; `applyChange` ignores stale-projectId deltas, accepts when `projectId` null/matching; `init()` same-projectId returns cached unsubscribe (no re-subscribe), different projectId tears down + resyncs with `connecting→connected`, full-sync failure → `disconnected`, stale-`wiredProjectId` resync dropped, `onError` → `disconnected` + clears wired state.
- `useSprintLanes`: `runId=null` resets; subscribe BEFORE query resolves; event-before-snapshot creates bare lane row; snapshot merges (query base + event-only extras, snapshot wins on dup taskId); later event updates status/step/attempts in place without touching ref/title; runId change cancels prior effect + ignores stale callbacks; query/subscription errors set `error` without throwing.
- `sanitizer`: `sanitizeHtml` strips `<script>`/`<img onerror>`/`<a href=javascript:>` + disallowed attrs (`onclick`/`href`/`src`), preserves allowlisted tags/attrs and only allowed style props; `sanitizeGitOutput` escapes `& < > " '` with `&` first (no double-escape).
- `panelStore`: `addPanel` dedup-on-add + sets active; `removePanel` clears `activePanels` only if removed was active; `updatePanelState` in-place-by-id + no-op when no panels loaded; `addPanelEvent` caps at 100; `getPanelEvents` filter by panelId/eventTypes incl. no-filter.
- `modelAvailabilityStore`: `isAliasUsable` true for non-guarded alias; guarded+`unavailable` → false + reason (or default); `ensureStarted` once-guard across mounts; rejected `getAvailability()` leaves `{}` (optimistic); live `onAvailabilityChanged` flip re-derives. `api.ts`: representative methods throw `'Electron API not available'` when `window.electronAPI` undefined; `models.*` degrade to throw/no-op when `window.electronAPI.models` undefined (preload skew); happy-path forwards args verbatim.
- **Retires:** silent renderer-ingestion drops feeding every store; 300/100-cap and merge-order data loss; stale-subscription cross-project leakage; the sprint-lane subscribe-before-query race; a re-opened XSS hole from an allowlist regression.

### B10 — Frontend components: launch/dialog/tree seams · risk: **critical/high** · effort: **L**
Files: `frontend/src/components/Backlog/useTaskRunLauncher.ts`, `cyboflow/unified/UnifiedComposer.tsx` (SDK branch), `DraggableProjectTreeView.tsx`, `PermissionDialog.tsx`, `CommitDialog.tsx`, `MainBranchWarningDialog.tsx`, `ReviewQueue/PendingApprovalsForRun.tsx`, `Backlog/NewTaskDialog.tsx`, `CreateProjectDialog.tsx`, `RunScriptConfigDialog.tsx`.
- `useTaskRunLauncher.launch()`: resolves `'sprint'` for task / `'planner'` for idea+epic by name even when `workflows[0]` differs; falls back to `workflows[0]` when named flow absent; seeds `{ideaId}`/`{taskIds:[id]}`/`{taskId}` per type; `ensureSessionForLaunch({forceNew:true})`; empty workflows → sets error, returns null; `runs.start` reject → error, returns null (no throw); `launchingTaskId` null in `finally` on both paths. `launchSprintBatch()`: empty `taskIds` no-ops; `spinnerId` drives `launchingTaskId`.
- `UnifiedComposer` (SDK attachment branch — existing test only covers PTY): large-text paste (>threshold) → text attachment + `preventDefault`; image clipboard → `processImageFile` adds to `atts.images`; `onDrop` no-op when `supportsAttachments=false`; file-input `onChange` adds images + resets `value`; `removeImage`/`removeText` drop only targeted id; submit clears atts on success but **leaves them** when `onSubmit` rejects; Escape → `onStop` while running / `onTogglePtyOpen` when idle+!isSDK.
- `DraggableProjectTreeView` (1570-line, zero-test): `handleProjectDrop` reorder calls `API.projects.reorder` with full order, updates local only on `{success:true}`, `showError` on failure; folder-on-project-root → `API.folders.move(id, null)`; `handleFolderDrop` A-onto-B → `move(A, B.id)` + auto-expand B on success; folder-onto-self no-op; `dragCounter` clears overType only at 0; reactive auto-expand expands a running-session project by default but doesn't re-expand a user-collapsed one after the one-shot pass.
- `PermissionDialog`: Allow with valid edited JSON → `onRespond(id,'allow',parsed)`; Allow with broken edited JSON → falls back to **original** `request.input` (no throw) — **flag whether this is intended**; Deny + Modal-close/backdrop both → `onRespond(id,'deny',undefined,'Permission denied by user')`; `isHighRisk` badge for Bash/Write/Edit/MultiEdit/Delete not Read/Grep; `renderInputPreview` per-tool blocks incl. >500-char truncation; Edit→Preview toggle preserves unedited input.
- `CommitDialog`: blank message blocks + shows error, `onCommit` never called; Ctrl/Cmd+Enter submits; Escape closes without committing; `onCommit` reject keeps dialog open + shows error + re-enables (`isCommitting` resets in finally); success → `onClose`; default message pluralizes `fileCount`.
- `MainBranchWarningDialog`: "don't ask again" writes `mainBranchWarning_<projectId>` + `onContinue`; plain Continue → `onContinue` but **no** localStorage write; Cancel touches neither; key scoped per projectId.
- `PendingApprovalsForRun`: null on `runId=null`; null when no queue item matches `runId`; renders only cards whose `approval.runId===runId` (no cross-run leak); reactive on queue change.
- `NewTaskDialog`: default-project chain (`filterProjectId ?? projectId ?? projects[0] ?? null`), explicit pick wins, create always sends selected id (not raw prop), close resets fields, reject surfaces error without `onCreated`. `CreateProjectDialog`: empty path/name blocks; path select → `detectBranch` populates; create always `active:false`; reject keeps open; demo-mode prefill. `RunScriptConfigDialog`: save calls update+closes; cancel discards; reject keeps open with error.
- **Retires:** wrong-flow/wrong-entity one-click launches + stuck spinners; the entire untested SDK attachment surface; silent revert on drag-drop reorder failure; unintended permission approvals from broken edited JSON; main-branch-warning nag inversion.

### B11 — Cross-boundary drift, release scripts, shared, preload · risk: **high/medium** · effort: **M**
Files: `main/src/preload.ts`, `scripts/{bundle-mcp-server.mjs,publish-update.mjs,gen-mac-latest-yml.mjs,inject-build-info.js,restore-version.js}`, `shared/utils/{extractToolResultText.ts,approvals.ts}`, `shared/types` guards `isCliSubstrate`/`isFindingPriority`, plus an **IPC type-parity drift guard**.
- **Preload/api parity guard (cross-cutting):** assert the `contextBridge`-exposed `electronAPI` keyset equals the set `frontend/src/utils/api.ts` consumes; assert request interfaces (e.g. `CreateSessionRequest`) identical frontend↔main; unit-cover the `models`-namespace skew fallback (undefined → throw/no-op).
- `scripts`: `gen-mac-latest-yml`/`publish-update` manifest shape (`version`/`path`/`sha512`/`releaseDate`) against a fixture dmg + injected version; `bundle-mcp-server` emits a resolvable entrypoint with expected exports; `inject-build-info`→`restore-version` round-trip leaves `package.json` byte-identical.
- `shared`: table-driven `isCliSubstrate`/`isFindingPriority` (valid/invalid/null); `extractToolResultText` over string / array-of-blocks / error `tool_result` shapes; `approvals` matcher edge cases.
- **Retires:** the silent-drop IPC class CLAUDE.md warns about (field added one side, forgotten the other, green CI); a broken auto-update manifest shipping to every user; a broken bundled MCP server only surfacing at runtime in a packaged build.

---

## 4. Workstream C: Infrastructure

| ID | Task | Detail | Effort |
|---|---|---|---|
| C1 | **Wire main coverage into CI report-only** | main already has `@vitest/coverage-v8` + config block + unused `test:coverage`. Add a CI step `pnpm --filter main exec vitest run --coverage --reporter=dot` after `pnpm test:unit`, upload as artifact / job summary, **no threshold yet**. | S |
| C2 | **Fix frontend's phantom coverage dep** | Add `@vitest/coverage-v8` (pin 2.1.x, match `vitest`) as an explicit `frontend` devDependency + a `coverage` block in `frontend/vitest.config.ts` mirroring main's excludes. Today it resolves only via an accidental root-node_modules link. | S |
| C3 | **Set conservative coverage floors — after baseline** | Once C1/C2 report 1–2 runs, add `coverage.thresholds` **5–10 pts below observed baseline** so it fails only on real regressions. Do **not** guess blind. | S |
| C4 | **Per-PR changed-file coverage diff** | After C1 is stable, add a script or `davelosert/vitest-coverage-report-action` diffing coverage for PR-touched files + a summary comment. Higher leverage than a repo-wide threshold. | M |
| C5 | **Document + schedule `pnpm test:gate`** | It's invisible (not in CI/CLAUDE.md/docs). Add one sentence to CLAUDE.md Common Commands (requires `claude` on PATH + real API); add a `workflow_dispatch` + nightly macOS-runner job with `claude` installed. | S |
| C6 | **Boot smoke test for `index.ts` + `preload.ts`** | Vitest test using the existing electron mock asserting `ipcMain.handle` was called with the expected channel names + `contextBridge.exposeInMainWorld` fired — closes the "silently drops an IPC channel" class without a real Electron runtime. Pairs with B11's parity guard. | M |
| C7 | **Fix env-var leak in MCP server test** | Add an `afterAll` restoring `CYBOFLOW_RUN_ID`/`CYBOFLOW_ORCH_SOCKET` in `cyboflowMcpServer.test.ts` (set in `beforeAll` with no cleanup) — latent forked-worker order-dependency. | S |

---

## 5. Sequencing & milestones

**Milestone 0 — Instrument (week 1, serial, blocks nothing downstream):** C1 + C2 + C7. Turns on coverage measurement so B-batch progress is visible; C7 removes a latent flake. Then C5 (cheap, unblocks the gate-chain safety net).

**Milestone 1 — Retire critical data-loss/leak risk (parallel lanes):** Run **B1, B4, B5, B7, B9, B10** as concurrent agent lanes (partitioned by file — no collisions). These hold every `critical`-rated gap (MCP batch writes, live PTY kill, merge-into-real-main, destructive git IPC, renderer ingestion core, one-click launcher). B5 and B7 and B10 are `L`; give them the longest budget.

**Milestone 2 — Close high/medium seams (parallel):** **B2, B3, B6, B8, B11**. B8's full-chain migration continuity test and B11's IPC parity guard are the cross-cutting wins here; C6 lands alongside B11 (shared preload surface).

**Milestone 3 — e2e rework:** Workstream A (A1→A6), independent of B/C and runnable in parallel from the start by a dedicated lane, but **land it after Milestone 0** so the launch fixture can piggyback on the coverage/CI plumbing. Gate blocking only after two green nightly runs.

**Milestone 4 — Ratchet:** C3 (thresholds below baseline) then C4 (per-PR diff). Only after Milestones 1–2 have moved the baseline.

**Rough total:** ~6 `S`, ~9 `M`, ~4 `L` tasks/batches. With 6 parallel agent lanes, Milestones 0–2 are achievable in a small number of iterations; Workstream A is the long pole due to the macOS-runner + fixture work.

---

## 6. Explicitly out of scope / not worth it

- **Mutation testing (Stryker).** Skip until coverage tracking is established and stable; only ever for a single high-value module (e.g. `TaskChangeRouter` or the schema-parity checker), never repo-wide — the suite is already large and the CI cost/maintenance dwarfs the signal.
- **Snapshot tests as a coverage tactic.** Avoid broad component snapshots; they lock rendered markup, not behavior, and rot into rubber-stamp updates. The one sanctioned snapshot is `judgePromptScaffold`'s schema shape (B1), where the shape *is* the contract.
- **`main/src/index.ts` full boot orchestration test.** 2066-line Electron bootstrap; structurally untestable without a real Electron harness. Covered only to the extent of the C6 handler-registration smoke test; deeper coverage would require extracting the boot-recovery call sequence into a standalone function (defer as a refactor, not a test task).
- **Packaged-app signing/notarization path.** `electron-builder --mac` + real code-signing has no CI coverage (ubuntu-only runners); leave to local `docs/signing/APPLE_DEVELOPER_SETUP.md` discipline plus the existing logic-only `test:build`. Not worth a self-hosted signing runner yet.
- **End-to-end tRPC response-shape validation against a live preload bridge.** Structurally impossible headless (renderer can't bootstrap `electronTRPC`); the B11 static parity guard + C6 smoke test are the affordable substitute — do not attempt a live-bridge harness.
- **Re-testing already-covered chokepoints.** `sessionPermissionMode.ts` and `worktreeManager.deleteBranch` are struck from all batches — they already have dedicated tests; adding more is pure duplication.