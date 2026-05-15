---
sprints: [SPRINT-009]
span_label: SPRINT-009
created: "2026-05-15T00:00:00.000Z"
counters_start:
  ideas: 15
summary:
  cleanups: 2
  backlog_tasks: 13
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-009

SPRINT-009 delivered the workflow-runs-and-day3-gate epic: WorkflowRegistry, RunLauncher with deterministic worktree naming, per-run MCP config writer, minimal Cyboflow frontend (WorkflowPicker + RunView), IPC handler wiring, and the day-3 milestone gate test (parallel SDK runs with out-of-order approval). All 5 tasks completed with 0 executor loops and ≤1 code-review round each. The sprint-level code review surfaced a cluster of high-severity cross-task issues (transport-layer split, stale plugin path version, preload whitelist bug, dead publisher) alongside medium-severity test-infrastructure duplication across 4 files. Two resolved findings (FIND-009-4, FIND-009-5) are excluded below.

---

## A. Clean-up items (execute now)

### A1. Remove workflow-fixture tmp dir leak in cyboflowTestHarness.teardown()
- **Summary:** Add one field and one `rmSync` call to `cyboflowTestHarness.ts` so the `cyboflow-gate-wf-*` temp directory created by `launchPair` is cleaned up on test teardown.
- **Source-Sprint:** SPRINT-009
- **Rationale:** Every `pnpm test:gate` run currently leaks one tmp dir containing two ~30-byte `.md` fixture files. The OS will purge them eventually, but it makes repeated test runs accumulate noise and prevents a clean "zero leftover files" assertion in CI. This is a one-field + one-line change with trivial blast radius.
- **Blast radius:** `tests/helpers/cyboflowTestHarness.ts` only; risk: trivial.
- **Source:** FIND-SPRINT-009-8 (TASK-355 verifier). Done report TASK-355 confirms "flagged as a small-change ergonomic improvement."
- **Proposed change:**
  ```diff
  // tests/helpers/cyboflowTestHarness.ts

  // In the class body, add a private field:
  -  // (no field for workflow fixture dir)
  +  private workflowFixturesDir: string | null = null;

  // In launchPair(), after the mkdtempSync call:
  -  const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-gate-wf-'));
  +  this.workflowFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-gate-wf-'));
  +  const wfDir = this.workflowFixturesDir;

  // At the top of teardown():
  +  if (this.workflowFixturesDir) {
  +    fs.rmSync(this.workflowFixturesDir, { recursive: true, force: true });
  +    this.workflowFixturesDir = null;
  +  }
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `mkdtempSync` at `tests/helpers/cyboflowTestHarness.ts:279` with no corresponding `rmSync` in `teardown()` (lines 397-412); change is single-file, single-field, trivial blast radius and pairs with B8's broader cleanup.

---

### A2. Fix plan-archive text drift: `approvalRouter.decide` → `approvalRouter.respond`
- **Summary:** Patch two stale prose references in the archived TASK-355 plan so future readers of the plan archive are not misled about the ApprovalRouter's public API.
- **Source-Sprint:** SPRINT-009
- **Rationale:** The archived plan at `.soloflow/active/plans/workflow-runs-and-day3-gate/TASK-355-plan.md` references `approvalRouter.decide(runId, approvalId, 'allow' | 'deny')` (a non-existent method) and a literal `workflows: 'sprint'` that does not match the harness API (`workflowA`/`workflowB`). The code is correct; only the plan text is wrong. Future tasks in this epic will likely reuse the harness contract description, so patching the plan archive prevents confusion.
- **Blast radius:** `.soloflow/active/plans/workflow-runs-and-day3-gate/TASK-355-plan.md` (archived plan doc only); risk: trivial.
- **Source:** FIND-SPRINT-009-9 (TASK-355 verifier). Done report TASK-355 acknowledges both drifts.
- **Proposed change:**
  ```diff
  // In TASK-355-plan.md, AC#1 verification clause:
  - "The test body uses both `workflows: 'sprint'` AND `workflows: 'prune'` strings literally."
  + "Both `'sprint'` and `'prune'` appear as quoted string literals in the test body (as `workflowA`/`workflowB` field values)."

  // In Implementation Step 1 prose:
  - approveRun calls the ApprovalRouter directly (`approvalRouter.decide(runId, approvalId, 'allow' | 'deny')`)
  + approveRun calls the ApprovalRouter directly (`approvalRouter.respond(approvalId, decision)`)
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** high
- **Reasoning:** The cited file `.soloflow/active/plans/workflow-runs-and-day3-gate/TASK-355-plan.md` does not exist anywhere in the repo (`find` returns no matches; the directory only contains `EPIC-workflow-runs-and-day3-gate.md`), so the diff's `old_string` cannot match — proposal targets a non-existent file.
- **Counterfactual:** If the plan archive is later moved into a per-task `done/` directory and a future agent will read it, patch then.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Reconcile schema.sql / migration 006 column-shape mismatch (INTEGER vs TEXT primary keys)
- **Summary:** `schema.sql` and migration `006_cyboflow_schema.sql` declare `workflows`/`workflow_runs` with incompatible column shapes; on a fresh install, migration 006's correct schema is silently no-op'd.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-1 (TASK-351 verifier), TASK-351 done report.
- **Problem:** `main/src/database/schema.sql:44-69` uses `workflows.id INTEGER PRIMARY KEY AUTOINCREMENT` and `workflow_runs.workflow_id INTEGER`. Migration `006_cyboflow_schema.sql:6-31` uses `workflows.id TEXT PRIMARY KEY`, `spec_json TEXT NOT NULL`, `workflow_runs.policy_json TEXT NOT NULL`, `stuck_at`, `stuck_reason`, `started_at`, `ended_at`, and a `status CHECK(...)` constraint. Because `schema.sql` runs first via `initializeSchema` and both blocks use `CREATE TABLE IF NOT EXISTS`, migration 006's DDL is completely no-op'd on fresh install — the database carries the wrong column shape. The `cyboflowSchema.test.ts` integration test at lines 306-373 only checks table presence (`toHaveLength(5)`), not column structure, so the mismatch is invisible to CI. Any future code reading `spec_json`, `policy_json`, or `stuck_*` columns will fail at runtime on a fresh install. The id type mismatch (INTEGER vs TEXT) is also the root of the transport-layer ID mismatch described in B3.
- **Proposed direction:** Three viable approaches: (a) Reconcile `schema.sql` to use TEXT primary keys and add the missing columns, matching 006 exactly — requires updating all test fixtures that rely on the AUTOINCREMENT shape. (b) Remove `workflows`/`workflow_runs` DDL from `006_cyboflow_schema.sql` entirely (keeping only the three net-new tables) and add the missing columns via a new `007_alter_workflow_columns.sql` migration so `schema.sql` remains the ground truth. (c) Extend `cyboflowSchema.test.ts` to `PRAGMA table_info(workflows)` and assert specific column names and types, so any future divergence fails CI loudly — this is a safety net, not a fix. Option (b) is the lowest-churn path since it avoids retroactively rewriting 006. Whatever approach is chosen, the `cyboflowSchema` integration test must be extended to assert column presence and types.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/database/schema.sql:44-69` (INTEGER PK, no spec_json/policy_json/stuck_*) vs `main/src/database/migrations/006_cyboflow_schema.sql:6-31` (TEXT PK + status CHECK + extra columns); both use `IF NOT EXISTS` so 006's DDL is silently no-op'd, and this is the structural root of the B3 transport ID-type mismatch.

---

### B2. Fix preload.ts: add `cyboflow:stream:*` to channel whitelist and fix `off()` removeListener bug
- **Summary:** `main/src/preload.ts` silently drops all `cyboflow:stream:<runId>` subscriptions because the channel is not in the `validChannels` whitelist; additionally, `off()` removes the wrong callback reference, so listeners would never be cleaned up even if the channel were whitelisted.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-6 (TASK-354 code-reviewer), TASK-354 done report.
- **Problem:** `preload.ts:609-628` has a `validChannels = ['permission:request']` whitelist. `ipcRenderer.on` is never called for non-whitelisted channels — silently. `cyboflowApi.subscribeToStreamEvents()` subscribes to `cyboflow:stream:<runId>`, which is not whitelisted, so the subscription is dead-on-arrival. A secondary bug: `off()` calls `ipcRenderer.removeListener(channel, callback)` with the original callback, but `on()` registers a wrapper `(_event, ...args) => callback(...args)` — so `removeListener` looks for a reference it never registered and the listener is never removed. The TASK-354 verifier passed because AC3 was grep-based and the Playwright smoke does not exercise the subscription path.
- **Proposed direction:** (1) Extend the channel check at `preload.ts:613` and `:621` to allow wildcard-prefix channels: `channel.startsWith('cyboflow:stream:')`. (2) Store the wrapper function in a `Map<string, Map<Function, Function>>` keyed by `(channel, originalCallback)` so `off()` can look up and remove the actual registered wrapper. This change is isolated to `preload.ts` and does not touch the orchestrator. The day-3 gate test (TASK-355) deliberately bypasses IPC, so adding an end-to-end subscribe→publish→assert Playwright test that exercises the preload path is also required to prevent regression.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `main/src/preload.ts:613-625` whitelist contains only `'permission:request'`, silently dropping `cyboflow:stream:<runId>` subscriptions, AND the `off()` at line 625 calls `removeListener(channel, callback)` with the bare callback while `on()` at line 617 registered a wrapper `(_event, ...args) => callback(...args)` — both bugs are real and this isolates the renderer pipeline failure.

---

### B3. Decide and document transport layer: delete duplicate raw-IPC handlers or delete tRPC placeholders
- **Summary:** TASK-354 added raw Electron IPC channels that duplicate and contradict the tRPC router placeholders already in the codebase, using incompatible ID types (numeric vs string); the two cannot coexist without a clear architecture decision.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-10 (sprint-code-reviewer). TASK-354 done report acknowledges lazy-singleton deviation.
- **Problem:** `main/src/ipc/cyboflow.ts` exposes `cyboflow:listWorkflows`, `cyboflow:startRun`, `cyboflow:approveRun` as raw IPC channels using `{ projectId: number }` input shapes. `main/src/orchestrator/trpc/routers/{workflows,runs,events}.ts` declare the same domain as tRPC procedures using `z.string()` input schemas (e.g., `workflowId: z.string()`). `ARCHITECTURE.md:55` names electron-trpc as the target transport. The ID type mismatch compounds FIND-SPRINT-009-1: `schema.sql` uses INTEGER primary keys while the tRPC routers use string IDs and migration 006 uses TEXT. Two surfaces with zero overlap.
- **Proposed direction:** Make an explicit documented decision: (a) Preferred per ARCHITECTURE.md — delete `main/src/ipc/cyboflow.ts` raw handlers once the tRPC routers are implemented in epic 6; update `main/src/ipc/index.ts` to remove the registration; have WorkflowPicker/RunView route through the tRPC client. (b) If raw IPC is kept — delete `trpc/routers/{workflows,runs,events}.ts` placeholders explicitly and document the rationale in ARCHITECTURE.md. Either way, reconcile the ID type across schema.sql (B1), tRPC routers, and IPC handler arg shapes so all layers agree on whether workflow IDs are integers or strings. Document the decision in ARCHITECTURE.md before epic 6 begins.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed contradictory surfaces — `main/src/ipc/cyboflow.ts:97,135` uses `{ projectId: number, workflowId: number }` while `main/src/orchestrator/trpc/routers/workflows.ts:21` uses `z.string()` and `ARCHITECTURE.md:55` explicitly names `electron-trpc` as the target; the existing `orchestrator-and-trpc-router` epic (TASK-251..255, 586) is the natural home for this decision and B5 is blocked on it.

---

### B4. Fix DEFAULT_SOLOFLOW_WORKFLOWS hardcoded version 0.9.12 — add plugin path discovery
- **Summary:** `WorkflowRegistry` hardcodes the SoloFlow plugin path at version 0.9.12, but the installed version is 0.10.3; every production auto-seed silently reads non-existent files and defaults all workflows to `permission_mode=default`, defeating the approval-router security mechanism.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-14 (sprint-code-reviewer). Confirmed cross-task: TASK-351 created the constant, TASK-354 triggered the auto-seed.
- **Problem:** `main/src/orchestrator/workflowRegistry.ts:37-43` hardcodes `~/.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/<file>.md` five times. The actually-installed version is 0.10.3. `WorkflowRegistry.seed()` wraps `readFileSync` in a try/catch and on any read failure logs a WARN and defaults `permission_mode` to `default` — never throws. Effect: `cyboflow:listWorkflows` IPC call seeds all 5 workflows with `permission_mode=default`, silently bypassing the `acceptEdits`/`dontAsk` frontmatter declarations that the approval-router epic is supposed to enforce. Unit tests never catch this because `workflowRegistry.test.ts` always inlines `writeFileSync` to a tmp file. Production is broken at the security boundary from day 1 of the auto-seed.
- **Proposed direction:** Replace the hardcoded version string with a runtime discovery strategy executed at `seed()` time: (1) Check `$CLAUDE_PLUGIN_ROOT` env var first (used by test harness). (2) Glob `~/.claude/plugins/cache/soloflow/soloflow-dev/*/commands/<name>.md` and pick the highest semver directory. (3) Fall back to a known constant (updated to 0.10.3) only when no install is found. Additionally, change the swallow-and-default behavior in `WorkflowRegistry.seed()`: on a read failure for a listed workflow, throw (or at minimum log at `error` level and set `permission_mode` to a sentinel like `'read-failure'` rather than `'default'`) so the UI/IPC layer can surface the degradation rather than silently serving wrong security posture. Add an integration test that exercises the discovery path with a real tmp dir structured like the plugin cache.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Hardcoded `0.9.12` confirmed at `main/src/orchestrator/workflowRegistry.ts:37-43` and `~/.claude/plugins/cache/soloflow/soloflow-dev/` contains both 0.9.12 and 0.10.3 — the read currently succeeds, so the proposal's "production is broken at the security boundary" framing is overstated (no workflow .md has `permission_mode` frontmatter today, so all five would default to `'default'` regardless of version), but the pin will silently break the moment 0.9.12 is uninstalled and the discovery + fail-loud fix is the right shape.
- **Counterfactual:** If a downstream task adds `permission_mode` to the workflow .md files, the severity of the silent-default fallback rises immediately.

---

### B5. Wire stream-event publisher: resolve three-layer dead-subscriber stack
- **Summary:** The frontend stream subscriber (`cyboflowApi.subscribeToStreamEvents`) has no main-side publisher, the preload whitelist drops the channel (B2), and the tRPC events router yields nothing — three independent failures make the entire stream pipeline dead-on-arrival.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-17 (sprint-code-reviewer), FIND-SPRINT-009-6 (TASK-354 code-reviewer). Cross-task: TASK-354 (subscriber), TASK-355 (records events to DB only, not IPC).
- **Problem:** `frontend/src/utils/cyboflowApi.ts:94-110` subscribes to `cyboflow:stream:<runId>`. `frontend/src/components/cyboflow/RunView.tsx:16-27` mounts this subscription. No task in SPRINT-009 added a main-process publisher (no `mainWindow.webContents.send` call for these channels). `main/src/orchestrator/trpc/routers/events.ts:73` uses `makePlaceholderAsyncIterator` that yields nothing. Combined with B2 (preload whitelist drops the channel), the subscription registers, returns a cleanup, and never fires. The day-3 gate test (TASK-355) deliberately bypassed IPC, so this was not caught. The dead UI code can mislead a future developer into thinking the pipeline is functional.
- **Proposed direction:** Before adding the publisher, make an explicit decision (tied to B3) on the transport: IPC vs tRPC. Then either: (a) IPC path — fix the preload whitelist (B2), add a `mainWindow.webContents.send('cyboflow:stream:<runId>', event)` call in the run orchestrator when new `raw_events` rows are written, and add a Playwright test that exercises the full subscribe→publish→render path. (b) tRPC path — implement `makePlaceholderAsyncIterator` replacement and route RunView through the tRPC subscription, then delete `cyboflowApi.subscribeToStreamEvents` and the IPC channel name. Until the publisher lands, disable or clearly stub out the dead RunView subscription with a `// TODO(epic-6): stream publisher not yet wired` comment rather than leaving it as apparently-active code.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed three-layer dead stack — `frontend/src/utils/cyboflowApi.ts:108` calls `electron.on(channel, handler)` for `cyboflow:stream:<runId>` which preload drops (B2), no `mainWindow.webContents.send` exists for these channels in the codebase, and `main/src/orchestrator/trpc/routers/events.ts:73` is a `throwNotImplemented` placeholder; leaving the apparently-active subscription is a future-developer trap.

---

### B6. Extract shared REGISTRY_SCHEMA SQL fixture — eliminate 4-file DDL drift
- **Summary:** The `workflows`/`workflow_runs` CREATE TABLE DDL is copy-pasted into 4 test files across SPRINT-009 with already-drifted column sets; extract a single exported constant so future schema changes propagate automatically.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-11 (sprint-code-reviewer). Suspected tasks: TASK-351, TASK-352, TASK-354, TASK-355.
- **Problem:** `main/src/orchestrator/__tests__/workflowRegistry.test.ts:29-55`, `runLauncher.test.ts:30-53`, `main/src/ipc/__tests__/cyboflow.test.ts:38-64`, and `tests/helpers/cyboflowTestHarness.ts:28-79` each define their own `REGISTRY_SCHEMA` SQL string. They already drift: `workflowRegistry.test.ts:39` has `idx_workflows_project_id` while `runLauncher.test.ts` omits it; the harness adds `approvals` and `raw_events`. When `schema.sql` column shapes change (cf. B1), every test passes against its stale local copy while production code breaks — the exact false-green risk.
- **Proposed direction:** Create `main/src/database/__test_fixtures__/registrySchema.ts` exporting `REGISTRY_SCHEMA` (workflows + workflow_runs, matching `schema.sql` exactly — ideally by slicing the SQL file between sentinel comments) and `GATE_SCHEMA` (registry + approvals + raw_events). Update the 4 call sites to import from this module. The sentinel-comment approach (`-- BEGIN_REGISTRY_DDL` / `-- END_REGISTRY_DDL` in `schema.sql`) ensures test DDL can never drift from production DDL again. Pairs naturally with B7 (same module can host both exports).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms 4 separate `REGISTRY_SCHEMA` const declarations at `workflowRegistry.test.ts:29`, `runLauncher.test.ts:30`, `cyboflow.test.ts:38`, plus a fourth `GATE_SCHEMA` at `cyboflowTestHarness.ts:28`; tied to B1 — without consolidation the schema-reconciliation fix in B1 will require updating 4 stale local copies and miss-update silently turns into false-green CI.

---

### B7. Extract shared `dbAdapter()` test helper — eliminate 4-file DatabaseLike shim duplication
- **Summary:** A `dbAdapter()` shim that wraps better-sqlite3 to satisfy the `DatabaseLike` interface is duplicated across 4 test files; extract it to a shared fixture so interface evolution does not require 4 manual updates.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-12 (sprint-code-reviewer). Suspected tasks: TASK-351, TASK-352, TASK-354, TASK-355.
- **Problem:** `main/src/orchestrator/__tests__/workflowRegistry.test.ts:73-79`, `runLauncher.test.ts:66-72`, `main/src/ipc/__tests__/cyboflow.test.ts:77-83`, and `tests/helpers/cyboflowTestHarness.ts:137-140` each define their own inline `dbAdapter()` / `dbLike` function with essentially the same body. One copy already uses a different field name. When `DatabaseLike` evolves (e.g., gains a `pragma` or `exec` method), every duplicate must be updated by hand or the new method is silently no-op'd in tests.
- **Proposed direction:** Create `main/src/orchestrator/__test_fixtures__/dbAdapter.ts` exporting `function dbAdapter(db: Database.Database): DatabaseLike`. Have all 4 callers import from there. This file can live in the same module as B6's `registrySchema.ts` exports. Once the helper exists, add a compile-time type check (`const _: DatabaseLike = dbAdapter(db)`) so TypeScript will flag any future `DatabaseLike` extension that the helper does not satisfy.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms duplicated `dbAdapter` / `dbLike` shims at `workflowRegistry.test.ts:73`, `runLauncher.test.ts:66`, `cyboflow.test.ts:77`, and `cyboflowTestHarness.ts:137`; pairs naturally with B6 in the same `__test_fixtures__` module so the marginal cost is near-zero once B6 is taken.

---

### B8. Create `withTempDir` test helper — fix tmp dir leaks across 6 test files
- **Summary:** `fs.mkdtempSync` is called in 6 test files; only 2 of them clean up; extract a `withTempDir(prefix, fn)` helper with `try/finally` cleanup so tmp dirs cannot leak.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-13 (sprint-code-reviewer). FIND-SPRINT-009-8 (TASK-355 verifier) captures the harness-fixture subset; this covers the broader cross-task pattern. Suspected tasks: TASK-352, TASK-353, TASK-354, TASK-355.
- **Problem:** `fs.mkdtempSync(join(tmpdir(), <prefix>-))` appears in 6 files. Only `mcpConfigWriter.test.ts:58-66` (afterEach) and `worktreeManager.test.ts:47-53` (afterEach) clean up. The other four (`runLauncher.test.ts:84`, `cyboflow.test.ts:264`, `cyboflowTestHarness.ts:279`, `cyboflow-day3-gate.spec.ts:62` — though the last one does use afterAll) rely on OS purge or partial cleanup. Every full sprint test invocation leaks ~6-10 tmp dirs.
- **Proposed direction:** Create `main/src/__test_fixtures__/tmp.ts` exporting `withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T>` that mkdtemps, runs `fn`, and `rmSync` in a `finally` block. Migrate the 4 leaking call sites. This task naturally follows B6/B7 and can be batched into the same "test infrastructure cleanup" task.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms `mkdtempSync` at 6 sites (`runLauncher.test.ts:85`, `mcpConfigWriter.test.ts:23`, `cyboflow.test.ts:264`, `worktreeManager.test.ts:44/150`, `cyboflowTestHarness.ts:279`, `cyboflow-day3-gate.spec.ts:62`) with cleanup only in two; A1 is the harness-specific subset and B8 makes the broader pattern non-leaking, sized as a single small helper file.

---

### B9. Add error handling for orphan `workflow_runs` rows when worktree creation fails
- **Summary:** If `RunLauncher.launch` fails after `createRun` inserts a `workflow_runs` row but before the worktree is created, the row is orphaned with `status='queued'` and `worktree_path=NULL`; add a try/catch that sets `status='failed'` when wiring `RunLauncher` into the IPC orchestrator.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-2 (TASK-352 verifier). Also noted in TASK-353 done report ("lifecycle concern even slightly widened" by `writeForRun` between `createRun` and the status UPDATE).
- **Problem:** `main/src/orchestrator/runLauncher.ts:42-66` performs `createRun` (inserts row) → `createDeterministicWorktree` → `UPDATE workflow_runs`. If `createDeterministicWorktree` throws (git failure, fs permission denied, branch-name collision), the `workflow_runs` row is left with `status='queued'`, `worktree_path=NULL`, `branch_name=NULL`. The gap widened slightly in TASK-353: `writeForRun` between `createRun` and the status UPDATE is another throw point. TASK-352 scoped this out; the right home is the IPC-wiring task where the full lifecycle context is available.
- **Proposed direction:** When wiring `RunLauncher.launch` into the IPC orchestrator (epic 6), wrap `createDeterministicWorktree` and `writeForRun` in a `try/catch`. On catch: call `UPDATE workflow_runs SET status='failed', error_message=<e.message> WHERE run_id=<runId>`. Either add `error_message TEXT` to the `workflow_runs` schema (in the B1 schema reconciliation task) or use an existing column. Return the error to the IPC caller so the UI can surface it. Add a unit test that injects a failing worktree creator and asserts the run's final status is `'failed'` rather than `'queued'`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `RunLauncher.launch` at `main/src/orchestrator/runLauncher.ts:74-111` does `createRun → createDeterministicWorktree (+ writeForRun) → UPDATE` with no try/catch on the worktree step, leaving an orphaned `status='queued'` row on any git/fs failure; the fix lands naturally in the epic-6 wiring task that already owns the IPC entry point.

---

### B10. Make MCP collaborators required args in RunLauncher — remove "optional security" pattern
- **Summary:** `RunLauncher`'s four MCP collaborators are optional constructor args; if any is missing the `.mcp.json` write is silently skipped with no log, making partial-wiring regressions invisible; make them required in epic 6 wiring.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-3 (TASK-353 code-reviewer). TASK-353 done report confirms this is deferred to "epic 6 wiring task."
- **Problem:** `main/src/orchestrator/runLauncher.ts:91-105` guards the `McpConfigWriter.writeForRun` call with `if (mcpConfigWriter && orchSocketProvider && bridgeScriptResolver && nodeResolver)`. Any partially-wired production instantiation silently skips writing `.mcp.json` — the entire cyboflow-permissions bridge. No log line, no error, no test failure. The current optionality exists to keep TASK-352's pre-existing tests passing without collaborators, but TASK-353's done report explicitly calls this out as a forward-compatibility risk.
- **Proposed direction:** In the epic 6 task that constructs `RunLauncher` for production: (a) make the four collaborators required constructor arguments (no longer optional), (b) update TASK-352's test fixtures to pass typed stubs (e.g., `{ writeForRun: vi.fn() }` satisfying `McpConfigWriter`), (c) add a guard `if (!mcpConfigWriter || !orchSocketProvider || ...) throw new Error('RunLauncher requires all MCP collaborators')` to surface mis-wiring immediately at construction time. Option (b) is strictly preferred over adding a `warn` log — "optional security" should be a compile error, not a runtime warning.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `RunLauncher` constructor at `main/src/orchestrator/runLauncher.ts:50-59` makes `mcpConfigWriter`/`orchSocketProvider`/`bridgeScriptResolver`/`nodeResolver` optional, and the gate at `:91-105` silently skips the `.mcp.json` write — the cyboflow-permissions bridge is the entire security premise of TASK-353; "optional security" deserves a constructor-time throw, not a runtime warn.

---

### B11. Move WorkflowRegistry / RunLauncher construction out of IPC handler into AppServices
- **Summary:** `main/src/ipc/cyboflow.ts` contains lazy module-level singletons for `WorkflowRegistry` and `RunLauncher` that violate the project's IPC handler thinness convention and require `vi.resetModules()` in every test; move them to `AppServices` at app startup.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-16 (sprint-code-reviewer). TASK-354 done report acknowledges "When epic 6 ... lands, replace the lazy-init blocks."
- **Problem:** `main/src/ipc/cyboflow.ts:26-79` has `let _workflowRegistry: WorkflowRegistry | null = null` and `let _runLauncher: RunLauncher | null = null` with lazy-init helpers. CODE-PATTERNS.md §IPC handler structure says "Keep business logic in services/, not in IPC handlers." Concrete risks: (1) hot-reload in dev resets the singletons but not the underlying DB rows they reference — potential race conditions; (2) `cyboflow.test.ts` requires `vi.resetModules()` at lines 174, 262, 350 solely because of the singletons — every future cyboflow test author inherits this non-obvious boilerplate. The pattern will likely be repeated in epic 6/7 IPC files if not corrected now.
- **Proposed direction:** In the epic 6 (or a dedicated refactor task before epic 6 lands): (1) Construct `WorkflowRegistry` and `RunLauncher` in `main/src/index.ts` (or wherever `AppServices` is assembled), storing them on `services.cyboflow.{workflowRegistry, runLauncher}`. (2) Change `registerCyboflowHandlers(services)` to receive the already-constructed instances via `services.cyboflow` — matching how `session.ts` uses `services.sessionManager`. (3) Remove the lazy-init helpers and `vi.resetModules()` calls from `cyboflow.test.ts`. (4) Verify the existing 10 IPC tests still pass without module-reset tricks.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed module-level `let _workflowRegistry`/`let _runLauncher` at `main/src/ipc/cyboflow.ts:26-79` plus the inline acknowledgment "When epic 6 ... lands, replace the lazy-init blocks"; CODE-PATTERNS.md "IPC handler structure" already mandates handler thinness and `session.ts` already follows the right pattern via `services.sessionManager`, so this is alignment with an existing rule and a precondition for the epic-6 wiring task.

---

### B12. Fix `vitest.config.gate.ts` fragile path resolution — move config into `main/` workspace
- **Summary:** The gate test config is at the repo root but invoked via `pnpm --filter main exec`, making the `..` relative path fragile to workspace renames; move the config into `main/` or invoke from the repo root.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-18 (sprint-code-reviewer). TASK-355 adds `package.json:54` test:gate script.
- **Problem:** `package.json:54` runs `pnpm --filter main exec vitest run --config ../vitest.config.gate.ts`. The `--config ../vitest.config.gate.ts` is resolved relative to `main/` cwd (because of `--filter main exec`), pointing one level up. Two fragility vectors: (a) renaming the `main/` workspace directory silently changes where `..` resolves; (b) a developer running `vitest run --config vitest.config.gate.ts` directly from the repo root works; `pnpm test:gate` from a subdirectory fails because pnpm scripts rewire cwd. The gate test itself (`tests/cyboflow-day3-gate.spec.ts`) lives in the repo root `tests/` directory, which is a further mismatch.
- **Proposed direction:** Drop the `--filter main exec` indirection and run vitest directly from the repo root: change `package.json:54` to `vitest run --config vitest.config.gate.ts`. This matches how the test file imports paths (it's a repo-root test, not a `main/` test). Alternatively, move `vitest.config.gate.ts` into `main/vitest.config.gate.ts` and update the `--config` reference. Option 1 (drop filter, run from root) is simpler and more honest about where the test lives.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `package.json:54` invokes `pnpm --filter main exec vitest run --config ../vitest.config.gate.ts` while `vitest.config.gate.ts` lives at the repo root and the test file `tests/cyboflow-day3-gate.spec.ts` is also a repo-root test — the proposal's option (b) is a one-line `package.json` edit with no new files; cost ≤ benefit even though the script works today.
- **Counterfactual:** If the workspace name `main/` is locked by external tooling such that `..` would never break, downgrade to DONT_IMPLEMENT.

---

### B13. Fix `makeLoggerLike` dropping structured context argument
- **Summary:** `makeLoggerLike()` in `main/src/ipc/cyboflow.ts` forwards only the `msg` string to `Logger` methods, silently discarding any structured context object passed as a second argument; IPC-launched runs log bare messages while test-launched runs get full structured context.
- **Source-Sprint:** SPRINT-009
- **Source:** FIND-SPRINT-009-7 (TASK-354 code-reviewer). TASK-354 done report acknowledges as "logging-fidelity gap."
- **Problem:** `main/src/ipc/cyboflow.ts` wraps `Logger` via `makeLoggerLike()`. Its `info`/`warn`/`error`/`debug` branches forward only `msg`, not the `context` second argument. `RunLauncher.launch` calls `this.logger.info('RunLauncher: run started', { runId, workflowId, worktreePath, branchName })` — when invoked from IPC, all the structured context is discarded and only the bare string reaches the log. Test runs (which inject a real `LoggerLike`) get full context; production IPC runs do not. Not a correctness bug but a debugging-experience gap that will matter when triaging production run failures.
- **Proposed direction:** In `makeLoggerLike()`, format context inline: change each branch from `(msg) => logger.info(msg)` to `(msg, ctx?) => logger.info(ctx ? \`${msg} ${JSON.stringify(ctx)}\` : msg)`. This is the smaller option (FIND-009-7 option (b)). Alternatively, extend `Logger.info/warn/error/debug` to accept an optional `context?: Record<string, unknown>` arg and serialize it — higher impact but wider blast radius. The inline shim fix is bounded to `cyboflow.ts` and can be applied in any small cleanup task.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/ipc/cyboflow.ts:46-51` forwards only `msg` to `logger.info/warn/error/debug` while `RunLauncher.launch` at `runLauncher.ts:113-118` calls `this.logger.info('RunLauncher: run started', { runId, workflowId, ... })` — the inline `JSON.stringify(ctx)` shim is bounded to `cyboflow.ts` with no widening to the `Logger` class.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document `cyboflowApi.ts` deviation from the `utils/api` IPC convention
- **Summary:** `docs/CODE-PATTERNS.md` currently says all renderer IPC calls must go through `utils/api.ts`; SPRINT-009 introduced `utils/cyboflowApi.ts` as a parallel surface — document which pattern wins, why, and what the migration target is.
- **Source-Sprint:** SPRINT-009
- **Target file:** `docs/CODE-PATTERNS.md`
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
   ### `frontend/src/utils/api`
   
   - **Path:** `frontend/src/utils/api.ts`
   - **Use it for:** All IPC calls from renderer to main. Do not call `window.electron` directly
     from components — go through this module.
   - **Canonical example:** Any store in `frontend/src/stores/`
  +- **Exception — `frontend/src/utils/cyboflowApi.ts`:** temporary parallel surface for the
  +  cyboflow workflow domain pending the epic-6 transport decision (raw IPC vs tRPC). Do NOT
  +  add new channels here, do NOT copy this module pattern into other domains, and do NOT
  +  deepen its surface — extend `api.ts` (`API.cyboflow.*`) or wait for the tRPC routers.
  +  Once epic 6 lands, `cyboflowApi.ts` is deleted or replaced by a tRPC client wrapper.
   
   ### `frontend/src/utils/migrateLocalStorageKey`
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `frontend/src/utils/cyboflowApi.ts` exists and `WorkflowPicker`/`RunView` import it instead of `utils/api.ts`, directly contradicting the existing CODE-PATTERNS.md `utils/api` rule at lines 50-52 ("Do not call `window.electron` directly from components"); the exception is bounded, names a deletion path tied to the active `orchestrator-and-trpc-router` epic, and explicitly forbids deepening — without it future agents will either replicate the pattern or rip it out prematurely.

---

## Reconciled Findings (informational)

No stale-open / claimed-resolved drift detected. FIND-SPRINT-009-4 and FIND-SPRINT-009-5 carry `status: resolved` in the findings file and are not triaged above.

---

## Suppressed — SoloFlow Defects

No C-candidates were identified as SoloFlow plugin defects. All C-items above reflect genuine project-code conventions (IPC transport pattern in this codebase), not SoloFlow workflow behavior.
