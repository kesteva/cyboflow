---
sprint: SPRINT-009
pending_count: 6
last_updated: "2026-05-15T00:11:00.000Z"
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
