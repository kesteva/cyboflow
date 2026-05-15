---
sprint: SPRINT-009
pending_count: 16
last_updated: "2026-05-15T07:26:10.062Z"
---
# Findings Queue

## Step 2.8 prerequisite override

TASK-355 prerequisite check `test -f main/dist/services/mcpPermissionBridge.js || test -f main/src/services/mcpPermissionBridge.ts` failed at sprint init (status: fail, blocking: true). However, TASK-353 (in this same sprint, scheduled before TASK-355 via dep chain 351→352→353→354→355) declares `main/src/services/mcpPermissionBridge.ts` in `files_owned` and creates it. The static pre-flight check cannot see this in-sprint forward dependency; the sprint's actual ordering guarantees the bridge source exists before TASK-355 executes.

Override decision: continue without gating TASK-355. If the bridge is somehow not created by TASK-353's executor, TASK-355's verifier will catch the regression naturally. Documented here for audit trail.

## FIND-SPRINT-009-1
- **source:** TASK-351 (verifier)
- **type:** anti-pattern
- **severity:** high
- **status:** open
- **location:** main/src/database/schema.sql:44-69 vs main/src/database/migrations/006_cyboflow_schema.sql:6-31
- **description:** `schema.sql` (applied first by `initializeSchema`) and migration `006_cyboflow_schema.sql` (applied by `runFileBasedMigrations`) both declare `workflows` and `workflow_runs` tables, with **incompatible column structures**. schema.sql uses `workflows.id INTEGER PRIMARY KEY AUTOINCREMENT` and `workflow_runs.workflow_id INTEGER`; migration 006 uses `workflows.id TEXT PRIMARY KEY`, `workflows.spec_json TEXT NOT NULL`, `workflow_runs.workflow_id TEXT`, `workflow_runs.policy_json TEXT NOT NULL`, `stuck_at`, `stuck_reason`, `started_at`, `ended_at`, plus a `status CHECK (...)` constraint. Because schema.sql runs first and both DDL blocks use `CREATE TABLE IF NOT EXISTS`, **migration 006's column structure is silently no-op'd on a fresh install** — the database carries the TASK-351 column shape, not the system-design shape. Existing tests do not catch this because the cyboflowSchema integration tests at lines 306-373 of `cyboflowSchema.test.ts` only probe table presence (`expect(tableRows).toHaveLength(5)`), not column structure. The TASK-351 plan explicitly acknowledges this as accepted scope ("the cyboflow-schema-migration epic ... will later land the full 5-table migration ... `IF NOT EXISTS` guards prevent duplicate-creation errors"), but the column-shape divergence — particularly the `id` type mismatch (INTEGER vs TEXT) and missing `spec_json` / `policy_json` / `stuck_*` columns — will silently break any later code that follows the system-design schema (e.g. anything in cyboflow_system_design.md §5.3 referencing `policy_json`). This is not a TASK-351 blocker (the plan called it out and the AC pass), but it is a latent integration hazard that should be reconciled before any task lands code that reads/writes those 006-only columns.
- **suggested_action:** Either (a) reconcile schema.sql's DDL with migration 006 so they declare identical column shapes, or (b) extend the cyboflowSchema integration test to assert specific column presence/types via `PRAGMA table_info(workflows)` so divergence fails CI loudly, or (c) document a deprecation path that removes the 006 DDL blocks for `workflows`/`workflow_runs` (keeping only the 3 net-new tables) and lifts spec_json/policy_json/stuck_* into a follow-up ALTER TABLE migration.
- **resolved_by:** 

## FIND-SPRINT-009-2
- **source:** TASK-352 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runLauncher.ts:42-66
- **description:** `RunLauncher.launch` performs a 4-step sequence (ensureGitignoreEntry → workflowRegistry.createRun → createDeterministicWorktree → UPDATE workflow_runs). If `createDeterministicWorktree` throws (git failure, fs permission denied, branch-name collision with a stale ref, etc.) AFTER `createRun` has already inserted the workflow_runs row, the row is left orphaned with `status='queued'`, `worktree_path=NULL`, `branch_name=NULL`. The current TASK-352 acceptance criteria only specify the happy path; the plan does not require transactional rollback. This is a known-out-of-scope ergonomic gap that future work (sprint-orchestrator integration, day-3 gate task, or a janitor sweep) will need to address — either by wrapping the sequence in a try/catch that flips status to 'failed' on error, or by deferring `createRun` until after the worktree exists.
- **suggested_action:** When the next task wires `RunLauncher.launch` into the IPC orchestrator, add a try/catch around the worktree creation block that UPDATEs status='failed' and stores the error message in a column (or a sibling `workflow_run_errors` table) so the UI can surface launch failures and the orphan row doesn't accumulate.
- **resolved_by:** 

## FIND-SPRINT-009-3
- **source:** TASK-353 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runLauncher.ts:91-105
- **description:** `RunLauncher.launch` skips the per-run `.mcp.json` write entirely (with no log line) when any of the four MCP collaborators (`mcpConfigWriter`, `orchSocketProvider`, `bridgeScriptResolver`, `nodeResolver`) is undefined. This optional-and-silent pattern is correct for TASK-353 since no production wiring exists yet and TASK-352's pre-existing tests still construct the launcher with only four args, but the moment epic 6 (orchestrator-and-trpc-router) wires up production callers, a partial wiring regression (e.g. forgetting one of the four resolvers) would silently launch workflow runs without the cyboflow-permissions bridge — the entire security/isolation premise of TASK-353 — without any error, warning, or test failure. This is the same class of "passes all ground-truth checks but corrupts runtime behavior" bug that store-action audits are meant to catch. The pre-day-3-gate integration test (TASK-355) should detect a fully-missing wiring, but a partial wiring (e.g. writer present but socketProvider null) would short-circuit before TASK-355's checkpoint.
- **suggested_action:** When epic 6 wires production construction of `RunLauncher`, either (a) make the four collaborators required constructor args (no longer optional) and update TASK-352's pre-existing test fixtures to pass stubs, or (b) at minimum add a `this.logger.warn('RunLauncher: MCP config write skipped — collaborators not all injected', { hasWriter, hasSocket, hasBridge, hasNode })` inside the `else` branch so partial-wiring regressions are visible in logs. Option (a) is preferred since the writer IS the security mechanism and "optional security" is an antipattern.
- **resolved_by:** 

## FIND-SPRINT-009-4
- **type:** scope_deviation
- **source:** TASK-354 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/cyboflow.ts
- **description:** required to meet AC: plan step 2 explicitly calls for a new file main/src/ipc/cyboflow.ts to register IPC handlers for cyboflow:listWorkflows and cyboflow:startRun; the file does not appear in frontmatter files_owned but is explicitly described as an owned file in the plan body
- **resolved_by:** verifier — plan-prescribed: frontmatter files_owned line 13 lists main/src/ipc/cyboflow.ts; plan step 2 explicitly prescribes creating it ("a new file main/src/ipc/cyboflow.ts ... this file is OWNED by this task")

## FIND-SPRINT-009-5
- **type:** scope_deviation
- **source:** TASK-354 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/index.ts
- **description:** required to meet AC: plan step 2 calls for registering the cyboflow IPC handler module in main/src/ipc/index.ts; the plan marks this file read-only in frontmatter but instructs executor to add registration line
- **resolved_by:** verifier — plan-prescribed: frontmatter files_owned line 14 lists main/src/ipc/index.ts; plan step 2 explicitly prescribes adding the registration line ("Register it in main/src/ipc/index.ts ... only the registration line is added"). The frontmatter ownership wins over the inline "read-only" wording for the single registration line.

## FIND-SPRINT-009-6
- **type:** bug
- **source:** TASK-354 (code-reviewer)
- **severity:** high
- **status:** open
- **location:** main/src/preload.ts:609-628
- **description:** The contextBridge exposes `window.electron.on/off` with an explicit `validChannels = ['permission:request']` whitelist. Any subscription to a non-whitelisted channel is **silently dropped** — `ipcRenderer.on` is never called. `cyboflowApi.subscribeToStreamEvents()` (TASK-354) subscribes to `cyboflow:stream:<runId>` channels, which are NOT in this whitelist, so the RunView's event subscription is dead-on-arrival: it will register, return a cleanup, and never receive a single event at runtime. The TASK-354 verifier passed because AC3 verification is grep-based (string presence) and the Playwright smoke does not exercise the subscription path. A secondary defect exists in the same block: `ipcRenderer.on` wraps the user callback as `(_event, ...args) => callback(...args)` but `off()` calls `ipcRenderer.removeListener(channel, callback)` with the **original** callback, so even if the channel were whitelisted, the listener would never be removed. preload.ts is not in TASK-354's files_owned, so this must be addressed by the next task that touches the stream pipeline (TASK-355 / day-3 gate, or epic 6 when tRPC lands).
- **suggested_action:** In `main/src/preload.ts:613` and `:621`, extend the channel check to allow `cyboflow:stream:*` (e.g. `validChannels.includes(channel) || channel.startsWith('cyboflow:stream:')`). Additionally, store the wrapped callback in a per-(channel, callback) WeakMap so `off()` can look up and remove the actual registered wrapper instead of the user's bare callback. Day-3 gate test (TASK-355) MUST exercise an end-to-end subscribe→publish→assert path or it will not detect this regression.
- **resolved_by:** 

## FIND-SPRINT-009-7
- **type:** improvement
- **source:** TASK-354 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** main/src/ipc/cyboflow.ts:34-52
- **description:** `makeLoggerLike()` wraps the Logger class to satisfy LoggerLike but **drops the `context` argument entirely** in the info/warn/error/debug branches (it only forwards `msg`). The orchestrator (RunLauncher, WorkflowRegistry) calls `this.logger.info('RunLauncher: run started', { runId, workflowId, worktreePath, branchName })` — when invoked via this IPC path, all that structured context is silently discarded; only the bare message reaches the Logger. Runs launched from tests (which inject a real LoggerLike) get the full context; runs launched from the IPC handler do not. This is a logging-fidelity gap, not a correctness bug.
- **suggested_action:** Either (a) extend `Logger.info/warn/error` to accept an optional `context?: Record<string, unknown>` and serialise it (e.g. JSON.stringify) into the log line, then forward it from `makeLoggerLike`, or (b) format the context inline in the shim: `(msg, ctx) => logger.info(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg)`. Option (b) is the smaller change.
- **resolved_by:** 

## FIND-SPRINT-009-8
- **source:** TASK-355 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** tests/helpers/cyboflowTestHarness.ts:279-283 (creation), :397-412 (teardown — missing rmSync of the workflow-fixture tmp dir)
- **description:** `launchPair` calls `fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-gate-wf-'))` to host the seeded workflow .md files but `teardown()` never removes that directory — only the per-test project dir (created in the spec's `beforeAll` and rm'd in `afterAll`) and the in-memory DB are cleaned. After two consecutive `pnpm test:gate` runs, four `cyboflow-gate-wf-*` dirs remained under `$TMPDIR` (3 carried over from prior local runs + 1 from the most recent run), each holding two ~30-byte .md files. The OS will purge `os.tmpdir()` on its own schedule, so this is not a correctness bug, but every gate-test invocation leaks one tmp dir + two files. No AC mandates fixture cleanup so this is a non-blocker; flagged as a small-change ergonomic improvement.
- **suggested_action:** Track the workflow-fixture tmp dir as a private field on the harness (e.g. `private workflowFixturesDir: string | null = null;`), set it inside `launchPair`, and add `if (this.workflowFixturesDir) fs.rmSync(this.workflowFixturesDir, { recursive: true, force: true });` to the start of `teardown()`. Single small change; keeps the test fully hermetic.
- **resolved_by:** 

## FIND-SPRINT-009-9
- **source:** TASK-355 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/workflow-runs-and-day3-gate/TASK-355-plan.md:23 (AC#1 verification clause), :87 (Implementation Step 1 prose)
- **description:** Two minor plan-vs-code drifts that did not change verdict, but would confuse a future verifier or executor reading the plan in isolation. (1) AC#1 verification text says "The test body uses both `workflows: 'sprint'` AND `workflows: 'prune'` strings literally." The actual harness API surface (also defined in the plan's Step 1 skeleton) uses `workflowA: SoloFlowWorkflowName; workflowB: SoloFlowWorkflowName;` — singular keys. The strict literal `workflows: 'sprint'` does NOT appear in the test (and shouldn't, given the API). The intent (both workflow names appear as quoted literals) is met. (2) Implementation Step 1 says `approveRun` "calls the ApprovalRouter directly (`approvalRouter.decide(runId, approvalId, 'allow' | 'deny')`)" but the actual ApprovalRouter API method is `respond(approvalId, decision)` (see main/src/orchestrator/approvalRouter.ts:248). The harness correctly uses `respond` — the plan text references a non-existent `decide` method. Both are plan-quality issues, not code defects. Surfacing because future tasks in this epic will likely reuse the harness contract description.
- **suggested_action:** Compounder may amend the plan template (or the day-3 gate plan archive) to (a) restate AC#1 verification as "both `'sprint'` and `'prune'` appear as quoted string literals in the test body" — drops the misleading `workflows:` key prefix; (b) replace `approvalRouter.decide` with `approvalRouter.respond` to match the ApprovalRouter public API. Lowest-friction fix at compound time.
- **resolved_by:** 

## FIND-SPRINT-009-10
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/ipc/cyboflow.ts:85-171 vs main/src/orchestrator/trpc/routers/workflows.ts + runs.ts + events.ts
- **description:** Parallel transport layers for the same domain — TASK-354 added raw Electron IPC channels (cyboflow:listWorkflows, cyboflow:startRun, cyboflow:approveRun, cyboflow:stream:<runId>) that duplicate the contract already declared as tRPC procedures in main/src/orchestrator/trpc/routers/{workflows,runs,events}.ts. The two surfaces use INCOMPATIBLE identifier shapes: raw IPC takes numeric workflowId/projectId (e.g. cyboflow.ts:97 args: { projectId: number }), while the tRPC schema uses z.string() (workflows.ts:22 input: { workflowId: z.string() }, runs.ts:22 input: { workflowId: z.string(), projectId: z.string() }). ARCHITECTURE.md:55 states the target is electron-trpc — TASK-354 is moving in the opposite direction by hardening a parallel raw-IPC path. When epic 6 wires up the tRPC routers, callers will need to be migrated AND the schema mismatch reconciled (numeric DB id vs string id everywhere else in the cyboflow_system_design schema).
- **suggested_action:** Before epic 6 lands, decide and document a single transport: either (a) delete the new raw-IPC handlers in cyboflow.ts and reroute WorkflowPicker/RunView through electron-trpc once the routers are implemented (preferred per ARCHITECTURE.md), or (b) explicitly delete the trpc/routers/{workflows,runs,events}.ts placeholders to remove the false promise of a tRPC migration. Whatever the choice, reconcile the workflowId/projectId TYPE mismatch (numeric vs string) — system-design 006 migration uses TEXT primary keys for workflow.id, but TASK-351 schema.sql uses INTEGER (already tracked separately as FIND-SPRINT-009-1). The transport choice and the id-type choice are coupled.
- **resolved_by:** 









Suspected tasks: TASK-354

## FIND-SPRINT-009-11
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/workflowRegistry.test.ts:29-55, main/src/orchestrator/__tests__/runLauncher.test.ts:30-53, main/src/ipc/__tests__/cyboflow.test.ts:38-64, tests/helpers/cyboflowTestHarness.ts:28-79
- **description:** REGISTRY_SCHEMA SQL block duplicated as 4 inline string copies across the sprint, one per task that needed an in-memory test DB. workflowRegistry.test.ts created the original; runLauncher.test.ts copy-pasted it for TASK-352; cyboflow.test.ts copy-pasted it again for TASK-354; cyboflowTestHarness.ts (TASK-355) cloned it AGAIN and bolted on approvals + raw_events tables. The four copies already drift slightly: workflowRegistry.test.ts:39 has `idx_workflows_project_id` while runLauncher.test.ts omits it; cyboflow.test.ts has both indexes; the harness has yet another shape. This is exactly the cross-task duplication that the per-task reviewers cannot see. When schema.sql or the cyboflow migration changes column shape (cf. FIND-SPRINT-009-1), every test will compile + pass against its stale local copy and the production code will break.
- **suggested_action:** Extract a single source of truth — e.g. main/src/database/__test_fixtures__/registrySchema.ts that exports `REGISTRY_SCHEMA` (workflows + workflow_runs only) and `GATE_SCHEMA` (registry + approvals + raw_events). Have the four files import from there. Bonus: source the schema directly from main/src/database/schema.sql (slice between sentinel comments) so tests cannot drift from production DDL. The first task in the next sprint that touches any cyboflow test should consolidate.
- **resolved_by:** 








Suspected tasks: TASK-351, TASK-352, TASK-354, TASK-355

## FIND-SPRINT-009-12
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/workflowRegistry.test.ts:73-79, main/src/orchestrator/__tests__/runLauncher.test.ts:66-72, main/src/ipc/__tests__/cyboflow.test.ts:77-83, tests/helpers/cyboflowTestHarness.ts:137-140
- **description:** `dbAdapter()` / `dbLike` shim that maps better-sqlite3 to the orchestrator DatabaseLike interface is duplicated across 4 sprint files. The body is essentially identical — wrap `db.prepare` and `db.transaction` to satisfy DatabaseLike. Three tasks added their own copy (TASK-351, TASK-352, TASK-354) and TASK-355 added a fourth in the harness (with a different field name). When the DatabaseLike shape evolves (adding pragma, exec, or close methods), every duplicate must be updated by hand or tests silently no-op the new method.
- **suggested_action:** Add a single helper main/src/orchestrator/__test_fixtures__/dbAdapter.ts that exports `dbAdapter(db: Database.Database): DatabaseLike` and have all 4 callers import it. Pairs naturally with the REGISTRY_SCHEMA consolidation finding — same module can host both.
- **resolved_by:** 







Suspected tasks: TASK-351, TASK-352, TASK-354, TASK-355

## FIND-SPRINT-009-13
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/runLauncher.test.ts:84-86, main/src/orchestrator/__tests__/mcpConfigWriter.test.ts:22-24, main/src/ipc/__tests__/cyboflow.test.ts:264, main/src/services/__tests__/worktreeManager.test.ts:44, tests/helpers/cyboflowTestHarness.ts:279, tests/cyboflow-day3-gate.spec.ts:62
- **description:** Pattern of `mkdtempSync(join(tmpdir(), <prefix>-))` is duplicated across 6 sprint files, and only mcpConfigWriter.test.ts:58-66 (afterEach) and worktreeManager.test.ts:47-53 (afterEach) clean up. The other four locations either rely on the OS to eventually purge $TMPDIR or only clean up some of the dirs they create:
- **suggested_action:** Add a tiny test-helper main/src/__test_fixtures__/tmp.ts exporting `withTempDir(prefix: string, fn: (dir: string) => Promise<T>): Promise<T>` that mkdtemps + try/finally rmSync so callers cannot leak. Migrate the 6 call sites in a single follow-up cleanup task. Lower priority than schema/dbAdapter consolidation, but same shape of cross-task copy-paste drift.
- **resolved_by:** 





  - runLauncher.test.ts:84 makeTempDir() — never deleted
  - cyboflow.test.ts:264 tmpDir — never deleted
  - cyboflowTestHarness.ts:279 workflow-fixture tmp dir — never deleted (already FIND-SPRINT-009-8 — but the pattern is broader than that single tmp dir)
  - cyboflow-day3-gate.spec.ts:62 projectPath IS cleaned in afterAll, ok
Aggregate effect: every full sprint test invocation leaks ~6-10 tmp dirs. FIND-SPRINT-009-8 captured the harness-fixture leak; this finding captures the broader cross-task pattern.

Suspected tasks: TASK-352, TASK-353, TASK-354, TASK-355

## FIND-SPRINT-009-14
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/orchestrator/workflowRegistry.ts:37-43
- **description:** DEFAULT_SOLOFLOW_WORKFLOWS hardcodes the SoloFlow plugin path version 0.9.12 5 times (one per workflow), but the actually-installed version on this machine is 0.10.3 (per CLAUDE_PLUGIN_ROOT and confirmed by the directory layout). Effect chain triggered by TASK-354 auto-seed:
- **suggested_action:** Replace the hardcoded version with a discovery strategy: (a) read $CLAUDE_PLUGIN_ROOT env var when set (which the harness uses); (b) glob ~/.claude/plugins/cache/soloflow/soloflow-dev/*/commands/<file>.md and pick the highest semver; (c) fall back to the previously-known 0.10.3 constant only if no install is found. ALSO escalate: WorkflowRegistry.seed() should change the swallow-and-default behavior to either (i) throw on read failure for unknown workflows, or (ii) at minimum log error (not warn) and set a sentinel permission_mode like default-fallback so the UI/IPC layer can surface the degradation to the user.
- **resolved_by:** 




  1. cyboflow:listWorkflows (cyboflow.ts:104-113) calls registry.seed(projectId, descriptors) where each descriptor.path = $HOME + .claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/<file>.md
  2. WorkflowRegistry.seed() (workflowRegistry.ts:120-128) wraps readFileSync in try/catch and on ANY read failure, defaults permission_mode to default and logs a WARN — never throws.
  3. Result: all 5 workflows are seeded with permission_mode=default, completely bypassing each workflow actual frontmatter declaration. The acceptEdits / dontAsk modes that should be set on /sprint and /prune are silently lost.
This is the security/correctness mechanism the entire approval-router epic is supposed to enforce. Cross-task because TASK-351 created the constant with a stale version, TASK-354 auto-seed actually triggers the read, and no test exercises the real $HOME path (workflowRegistry.test.ts always uses inline writeFileSync to a tmp .md file). The unit tests pass; production silently degrades to default permission mode.

Suspected tasks: TASK-351, TASK-354

## FIND-SPRINT-009-15
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/utils/cyboflowApi.ts:37-42 + frontend/src/components/cyboflow/{WorkflowPicker,RunView}.tsx
- **description:** TASK-354 introduced frontend/src/utils/cyboflowApi.ts that calls window.electron.invoke / window.electron.on directly via a private requireElectron() guard, and the new components (WorkflowPicker, RunView) import cyboflowApi instead of the documented frontend/src/utils/api.ts. CODE-PATTERNS.md §`utils/api`: `Use it for: All IPC calls from renderer to main. Do not call window.electron directly from components — go through this module.` ARCHITECTURE.md:64 reinforces this: `utils/api.ts — Thin IPC call wrapper used by all frontend components to talk to main.` By creating a parallel cyboflowApi the sprint forks the renderer IPC convention: half the codebase routes through API, the other half through cyboflowApi, and there is no shared response-shape contract (cyboflowApi reinvents the success/data/error pattern locally at lines 54-58, 75-78). When the cyboflow domain grows (epic 6, 7, 8) this drift compounds.
- **suggested_action:** Either (a) extend frontend/src/utils/api.ts with a `cyboflow` namespace (`API.cyboflow.listWorkflows`, `API.cyboflow.startRun`, etc.) following the exact pattern of API.sessions / API.git, then have cyboflowApi re-export those methods OR delete cyboflowApi entirely; or (b) explicitly carve out cyboflowApi as the new pattern and update CODE-PATTERNS.md to document it (justifying why cyboflow needs its own surface — likely the upcoming tRPC migration, in which case the rationale should be written down so future contributors do not reinforce the legacy API path). Option (a) is lower-risk; option (b) requires a CLAUDE.md update.
- **resolved_by:** 




Suspected tasks: TASK-354

## FIND-SPRINT-009-16
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/cyboflow.ts:26-79
- **description:** TASK-354 placed module-level lazy singletons (`let _workflowRegistry: WorkflowRegistry | null = null` and `let _runLauncher: RunLauncher | null = null`) inside the IPC handler file, with helper functions `getWorkflowRegistry(services)` / `getRunLauncher(services)` that lazy-init on first call. CODE-PATTERNS.md §`IPC handler structure (main process)`: `Keep business logic in services/, not in IPC handlers — handlers should be thin: validate input, delegate to service, return result.` Object lifecycle/wiring is business logic. The comment at cyboflow.ts:23-24 acknowledges the deviation (`When epic 6 ... lands, replace the lazy-init blocks with proper singletons instantiated during app startup`). Concrete present-day risks: (1) hot-reload in dev resets the singletons but does NOT reset the underlying DB rows the singletons referenced — race conditions if the second handler call sees a half-rebuilt registry; (2) the test file workaround vi.resetModules() (cyboflow.test.ts:174, :262, :350) is necessary only because of the singleton — adding non-trivial cognitive cost to every future test author. The same pattern WILL be repeated by epic 6/7 IPC handlers if not corrected.
- **suggested_action:** Move WorkflowRegistry and RunLauncher construction into main/src/index.ts (or wherever AppServices is assembled), pass the ALREADY-CONSTRUCTED instances into AppServices, and have registerCyboflowHandlers receive them via services.cyboflow.{workflowRegistry,runLauncher}. Drops the lazy-init helpers, eliminates the vi.resetModules() requirement, and matches the canonical pattern of every other ipc/*.ts file (e.g. session.ts uses services.sessionManager directly).
- **resolved_by:** 



Suspected tasks: TASK-354

## FIND-SPRINT-009-17
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/utils/cyboflowApi.ts:94-110, frontend/src/components/cyboflow/RunView.tsx:16-27, main/src/orchestrator/trpc/routers/events.ts:73-83
- **description:** TASK-354 wired the renderer side of a stream pipeline that has NO MAIN-SIDE PUBLISHER in this sprint. cyboflowApi.subscribeToStreamEvents subscribes to `cyboflow:stream:<runId>` IPC events and RunView mounts that subscription, but no task in SPRINT-009 added a producer that emits on those channels (RunLauncher only inserts a workflow_runs row; the test harness recordEvent writes to raw_events table, not to IPC). The tRPC events.ts:73 onStreamEvent procedure exists but explicitly uses makePlaceholderAsyncIterator that yields nothing. Combined with FIND-SPRINT-009-6 (preload whitelist drops the channel), the entire subscriber path is dead-on-arrival from THREE independent failures stacking. The cross-task observation: the sprint shipped a UI subscriber, an IPC channel name, and a tRPC schema for events — but no task owned the publisher side. Future epic that wires the publisher will need to discover and either (a) publish on the existing `cyboflow:stream:<runId>` channel via mainWindow.webContents.send AND fix the preload whitelist, OR (b) use the tRPC subscription path AND remove the dead IPC subscriber. Today both surfaces exist with neither working.
- **suggested_action:** Add a tracking task to the next compound run: `Wire stream-event publisher`. Decide IPC vs tRPC (tied to FIND-SPRINT-009-10), then either remove cyboflowApi.subscribeToStreamEvents + the channel name in cyboflowApi.ts:102 + the dead RunView subscription, OR implement the main-side publisher (mainWindow.webContents.send for IPC, or replace makePlaceholderAsyncIterator for tRPC). Until then, delete or disable the dead UI code so a developer cannot mistake it for working integration.
- **resolved_by:** 


Suspected tasks: TASK-354 (subscriber), TASK-355 (recorded events but only to DB)

## FIND-SPRINT-009-18
- **source:** SPRINT-009 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** package.json:54 vs vitest.config.gate.ts:18-20
- **description:** TASK-355 added `pnpm --filter main exec vitest run --config ../vitest.config.gate.ts` as the test:gate script. The `--config ../vitest.config.gate.ts` is resolved relative to the main/ workspace cwd (because of `--filter main exec`), pointing one level up to the repo root config. The vitest.config.gate.ts itself uses `__dirname` to set repoRoot (config:20). This works today but is fragile to two changes: (a) if the workspace layout changes (rename main → main-process, or split out a sub-workspace), the `..` break silently with a confusing `cannot find config` error rather than a structured failure; (b) if a developer runs `vitest run --config vitest.config.gate.ts` directly from the repo root (intuitive), it works — but `pnpm test:gate` from a subdir fails because pnpm scripts always run from package.json dir, but pnpm --filter rewires cwd. Multiple paths, multiple ways to break.

Suspected tasks: TASK-355
- **suggested_action:** Either (a) move vitest.config.gate.ts INTO main/ (e.g. main/vitest.config.gate.ts) so the --filter main exec call uses a sibling path; or (b) drop the --filter flag and run vitest directly from repo root: `vitest run --config vitest.config.gate.ts`. Option (b) is simpler and matches how the day-3-gate test imports paths anyway (it lives in repo-root tests/).
- **resolved_by:** 
