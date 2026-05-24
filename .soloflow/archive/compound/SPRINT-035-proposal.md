---
sprints: [SPRINT-035]
span_label: SPRINT-035
created: "2026-05-23T00:00:00.000Z"
counters_start:
  ideas: null
summary:
  cleanups: 7
  backlog_tasks: 7
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-035

SPRINT-035 completed 11 tasks across two epics (orchestrator-and-trpc-router: TASK-709..711; trpc-cutover-and-legacy-tree-cleanup: TASK-712..717; testing-infrastructure: TASK-732..733). The sprint achieved full tRPC cutover for the four migrated raw-IPC channels (`listWorkflows`, `listRuns`, `startRun`, `mcp-health`) and deleted the legacy `main/src/trpc/` tree. The testing-infrastructure tasks canonicalized the `createTestDb` fixture and swept inline `INSERT INTO approvals` to a shared helper.

All 11 tasks had `executor_loops: 0`; TASK-715 needed one code-review round (missing in-flight guard) and TASK-732 needed one verifier retry (7th `INSERT INTO approvals` site introduced mid-sprint by a sibling task). Quality was high overall.

Open findings after reconciliation: 19 distinct items triaged below. 14 FIND entries with `status: resolved` or `resolved_by:` are skipped. FIND-SPRINT-024-2..5 in the stray findings file are erroneous (misrouted by the executor and acknowledged by verifiers as mislabeled in-scope edits) and are noted in Reconciled Findings below.

---

## A. Clean-up items (execute now)

### A1. Delete stray `.soloflow/active/findings/SPRINT-024-findings.md`
- **Summary:** Remove the untracked misrouted findings file created by executors who wrote SPRINT-024 instead of SPRINT-035; FIND-SPRINT-024-2..5 are erroneous in-scope edits acknowledged by verifiers, and FIND-SPRINT-024-1 is an archived SPRINT-024 artifact that does not belong here.
- **Source-Sprint:** SPRINT-035
- **Rationale:** The file is untracked (`git status` shows it as `??`), has the wrong sprint ID in its frontmatter, and contains four entries already resolved (by verifiers as mislabeled) plus one entry (FIND-SPRINT-024-1, a pre-existing SPRINT-024 bug about `sessionManager.ts`) that was mis-filed here. Leaving it causes confusion for future sprint-closers and tools that scan the active/findings directory.
- **Blast radius:** Deletes one untracked file. Zero risk to any code or workflow artifact. Blast radius: trivial.
- **Source:** FIND-SPRINT-035-7 (TASK-713 verifier), FIND-SPRINT-035-10 (TASK-714 verifier); stray file confirmed present in git status at conversation open.
- **Proposed change:**
  ```
  rm .soloflow/active/findings/SPRINT-024-findings.md
  ```
  Note: FIND-SPRINT-024-1 (sessionManager.ts session-data methods dependency) is a real pre-existing bug from SPRINT-024. If it is not already in SPRINT-024's archive, it should be noted in the next SPRINT-024-era compound or backlog before deletion. Based on the sprint archive, SPRINT-024 already closed; FIND-SPRINT-024-1 can be added as a new backlog FIND or as item B (below) before the file is deleted.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `git status` confirms `.soloflow/active/findings/SPRINT-024-findings.md` is untracked (`??`) — the file's existence, wrong sprint ID, and orphaned-finding triage are all verified by the SPRINT-035 findings file's reconciled-findings section, and deletion is a single-file `rm` with zero blast radius.
- **Counterfactual:** If FIND-SPRINT-024-1 (the legitimate pre-existing `sessionManager.ts` bug) is not first preserved into a backlog FIND, the deletion drops a real signal — but the item already calls that out.

### A2. Remove stale mock lines from `RunView.test.tsx` and `cyboflowStore.test.ts`
- **Summary:** Drop three dead `vi.fn()` entries (`listWorkflows`, `startRun` twice) from the `vi.mock('../../../utils/cyboflowApi', ...)` blocks in two test files whose real exports were deleted during the tRPC cutover.
- **Source-Sprint:** SPRINT-035
- **Rationale:** After TASK-714 removed `listWorkflows` from `cyboflowApi` and TASK-715 removed `startRun`, both mock blocks contain dead entries. TypeScript does not check `vi.mock` factory shapes against the real module, so these pass silently — but they mislead readers about the real API surface. TASK-715 already cleaned `CyboflowRoot.test.tsx`; these two files were outside that task's scope.
- **Blast radius:** Two test files touched. No test behavior changes (the mock entries are dead weight — no test reads their return values). Blast radius: trivial.
- **Source:** FIND-SPRINT-035-11 (TASK-714 verifier, TASK-715 verifier update); `RunView.test.tsx:32-33`, `cyboflowStore.test.ts:33`.
- **Proposed change:**
  ```diff
  // frontend/src/components/cyboflow/__tests__/RunView.test.tsx
  -   listWorkflows: vi.fn(),
  -   startRun: vi.fn(),

  // frontend/src/stores/__tests__/cyboflowStore.test.ts
  -   startRun: vi.fn(),
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `RunView.test.tsx:32-33` (`listWorkflows: vi.fn(), startRun: vi.fn(),`) and `cyboflowStore.test.ts:33` (`startRun: vi.fn(),`); both `listWorkflows` and `startRun` are deleted from the real `cyboflowApi` exports per SPRINT-035, making these mocks dead weight with trivial blast radius.

### A3. Rewrite stale docblock in `shared/types/stuckInspection.ts`
- **Summary:** Update the file-header docblock that still names the deleted `main/src/trpc/routers/runs.ts` as the handler home and describes an import-cycle motivation that no longer exists.
- **Source-Sprint:** SPRINT-035
- **Rationale:** After TASK-709 ported the handler to `main/src/orchestrator/inspectorQueries.ts` and TASK-717 deleted the legacy `main/src/trpc/` tree entirely, the docblock is factually wrong. Future readers will look for code in a non-existent directory. TASK-717's AC7 was scoped only to `docs/ARCHITECTURE.md` and did not touch this shared type file.
- **Blast radius:** One file, a comment-only change. Blast radius: trivial.
- **Source:** FIND-SPRINT-035-1 (TASK-709 code-reviewer), FIND-SPRINT-035-23 (TASK-717 executor); both note the same stale comment survived the sprint.
- **Proposed change:**
  ```diff
  // shared/types/stuckInspection.ts — file-header docblock
  -  * Handler: main/src/trpc/routers/runs.ts (getStuckInspectionHandler + re-export)
  -  * Placed here (rather than in shared/types/workflows.ts or a routers file) to avoid
  -  * an import cycle that would otherwise exist between the two router files.
  +  * Handler: main/src/orchestrator/inspectorQueries.ts (getStuckInspectionHandler)
  +  * Exposed via the cyboflow.runs.getStuckInspection tRPC procedure in
  +  * main/src/orchestrator/trpc/routers/runs.ts.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `shared/types/stuckInspection.ts:5-11` still names the deleted `main/src/trpc/routers/runs.ts` and references the "import cycle that would otherwise exist between the two router files" — but `ls main/src/trpc` returns "No such file or directory" and the handler now lives in `main/src/orchestrator/inspectorQueries.ts` (confirmed exists).

### A4. Remove deleted `LegacyTrpc` node from `docs/ARCHITECTURE-diagram.md`
- **Summary:** Delete the `LegacyTrpc` Mermaid node, its edges, the line-15 legend entry, and the line-183 narrative paragraph now that `main/src/trpc/` was deleted by TASK-717.
- **Source-Sprint:** SPRINT-035
- **Rationale:** `docs/ARCHITECTURE-diagram.md` still shows `main/src/trpc/routers/` as a "gray dashed Legacy/unwired - delete or merge" candidate. The deletion is complete. Leaving the node misleads onboarding readers into thinking there is still a cleanup target, and contradicts the prose updates already made to `docs/ARCHITECTURE.md` by TASK-717.
- **Blast radius:** One doc file, three prose/diagram edits. Blast radius: trivial.
- **Source:** FIND-SPRINT-035-25 (TASK-717 executor); `docs/ARCHITECTURE-diagram.md:15,52,183`.
- **Proposed change:**
  Remove line 15 legend row (`Gray dashed — main/src/trpc/routers/ — TBD-tRPC-cutover cleanup`), remove lines 52 (`LegacyTrpc["main/src/trpc/routers/<br/>legacy / unwired - delete or merge"]`) and any Mermaid edges referencing `LegacyTrpc`, remove or update line 183 narrative paragraph. If the gray-dashed styling is useful for another deletion candidate, repurpose it; otherwise drop the `classDef` entry.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `docs/ARCHITECTURE-diagram.md:15` (legend entry naming `main/src/trpc/routers/`), `:52` (`LegacyTrpc["main/src/trpc/routers/..."]` node), `:146` (`LegacyTrpc -. candidate for TBD-tRPC-cutover .-> AppRouter`), and `:183` narrative paragraph — all stale since the legacy tree no longer exists (verified by `ls main/src/trpc` failing).

### A5. Fix stale doc-comment in `runLifecycle.test.ts:16`
- **Summary:** Update the file-header comment that still says "Real in-memory better-sqlite3 with REGISTRY_SCHEMA" — the file now uses GATE_SCHEMA via the canonical `createTestDb` fixture.
- **Source-Sprint:** SPRINT-035
- **Rationale:** TASK-733 migrated `runLifecycle.test.ts` onto `createTestDb` (GATE_SCHEMA), but the top-of-file comment still advertises the old schema. A reader checking schema coverage will be misled.
- **Blast radius:** One file, one comment line. Blast radius: trivial.
- **Source:** FIND-SPRINT-035-30 (TASK-733 verifier); `main/src/orchestrator/__tests__/runLifecycle.test.ts:16`.
- **Proposed change:**
  ```diff
  -  * Real in-memory better-sqlite3 with REGISTRY_SCHEMA.
  +  * Real in-memory better-sqlite3 via the canonical createTestDb fixture (GATE_SCHEMA).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/orchestrator/__tests__/runLifecycle.test.ts:16` the docblock still says "Real in-memory better-sqlite3 with REGISTRY_SCHEMA" while line 24 now imports `createTestDb` from `__test_fixtures__/orchestratorTestDb` (which uses GATE_SCHEMA per TASK-733); one-line comment fix with zero blast radius.

### A6. Replace local `DatabaseLike` in `approvals.ts` with canonical import
- **Summary:** Delete the inline `type DatabaseLike = { prepare: ... }` redeclaration in `approvals.ts` and replace it with `import type { DatabaseLike } from '../../types'`, matching every sibling orchestrator handler.
- **Source-Sprint:** SPRINT-035
- **Rationale:** TASK-717 inlined `approveRestOfRunHandler`/`rejectRestOfRunHandler` from the legacy tree but introduced a local `DatabaseLike` shape instead of importing the canonical one. The local shape omits the `run()` return value (`{ changes, lastInsertRowid }`), which will mask future bugs if any handler in `approvals.ts` inspects the result of `run()`. Three sibling handler files (`inspectorQueries.ts:11`, `runQueries.ts:7`, `approvalListing.ts:14`) all use the canonical import.
- **Blast radius:** One file (`main/src/orchestrator/trpc/routers/approvals.ts`). No runtime behavior change — canonical type is a strict superset. Blast radius: trivial.
- **Source:** FIND-SPRINT-035-33 (SPRINT-035 sprint-code-reviewer); `approvals.ts:40-46`.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/trpc/routers/approvals.ts
  +import type { DatabaseLike } from '../../types';
  -type DatabaseLike = {
  -  prepare: (sql: string) => {
  -    all: (...params: unknown[]) => unknown[];
  -    run: (...params: unknown[]) => void;
  -  };
  -};
  ```
  After: verify `pnpm --filter main typecheck` still passes.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `approvals.ts:40-46` local `type DatabaseLike = { prepare: ...; run: ...void }` while `inspectorQueries.ts:11`, `runQueries.ts:7`, `approvalListing.ts:14`, plus 4 other orchestrator files all `import type { DatabaseLike } from './types'` (canonical interface defined at `orchestrator/types.ts:27`); pure type substitution with strict-superset shape, zero runtime change.

### A7. Import canonical `McpServerStatus` type in `orchestrator/health.ts` instead of re-declaring the union inline
- **Summary:** Replace the inline `'starting' | 'running' | 'failed' | 'stopped'` union in `health.ts`'s `McpLifecycleReadable` interface with `import type { McpServerStatus }` from the existing re-export in `mcpServerLifecycle.ts`, eliminating one of three drift surfaces for this union.
- **Source-Sprint:** SPRINT-035
- **Rationale:** TASK-713 added a third copy of the status union (`McpLifecycleReadable.getStatus()` return type in `health.ts`). If the state machine gains a new state (e.g. `'restarting'`), the `McpLifecycleReadable` interface lags silently. The fix is a single import — `mcpServerLifecycle.ts:25-26` already comments that `McpServerStatus` is "re-exported for callers that want the status type without importing the class." Importing it from within `orchestrator/` does not violate the standalone-typecheck invariant (no `services/` imports required).
- **Blast radius:** One file (`main/src/orchestrator/health.ts`). Pure type-level change; no runtime behavior. Blast radius: trivial.
- **Source:** FIND-SPRINT-035-9 (TASK-713 code-reviewer); `health.ts:24`, `mcpServerLifecycle.ts:26`, `shared/types/mcpHealth.ts:13`.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/health.ts
  +import type { McpServerStatus } from './mcpServer/mcpServerLifecycle';

   export interface McpLifecycleReadable {
  -  getStatus(): 'starting' | 'running' | 'failed' | 'stopped';
  +  getStatus(): McpServerStatus;
   }
  ```
  After: run `pnpm --filter main typecheck` to confirm the standalone typecheck still passes.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `health.ts:24` declares the inline union `'starting' | 'running' | 'failed' | 'stopped'` while `mcpServerLifecycle.ts:25-26` already exports `McpServerStatus` as a re-exportable type ("Re-export for callers that want the status type without importing the class"); single-import substitution that collapses one of three drift surfaces, blast radius trivial.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Restore Migration-007 idempotency tests
- **Summary:** Restore the deleted `describe('Migration 007 idempotency', ...)` block that was the only test reading `007_add_stuck_reason.sql` from disk, so future edits to that SQL file are caught automatically.
- **Source-Sprint:** SPRINT-035
- **Source:** FIND-SPRINT-035-31 (TASK-733 code-reviewer); deleted from `stuckDetector.test.ts` lines 562-611 of pre-commit file.
- **Problem:** TASK-733's step 9 deleted the two idempotency test cases (`describe('Migration 007 idempotency', ...)`) that read `007_add_stuck_reason.sql` from disk, applied it on top of `006_cyboflow_schema.sql`, and asserted the `stuck_detected_at` column + `idx_workflow_runs_status_stuck_at` index exist. The justification in the commit message ("redundant — canonical option is unit-tested") is factually incorrect: `orchestratorTestDb.ts:57` uses an inline `ALTER TABLE` statement, NOT the SQL file. Verification: `grep -rn '007_add_stuck_reason' main/src --include='*.test.ts'` returns 0 matches; `grep -rn 'idx_workflow_runs_status_stuck_at' main/src --include='*.test.ts'` returns 0 matches. Net effect: typos, dropped indexes, or column-type changes in `007_add_stuck_reason.sql` will be invisible to the test suite.
- **Proposed direction:** Create a new test file `main/src/database/__tests__/migration007.test.ts` (or add a section to `cyboflowSchema.test.ts`). The test should: (1) read `007_add_stuck_reason.sql` from disk via `readFileSync + join`, (2) apply it on top of a fresh `006_cyboflow_schema.sql` DB, (3) assert `stuck_detected_at INTEGER` is present in `workflow_runs` via `PRAGMA table_info`, (4) assert `idx_workflow_runs_status_stuck_at` exists via `SELECT name FROM sqlite_master WHERE type='index'`. The deleted block from the TASK-733 commit diff can be adapted near-verbatim. Do NOT use `createTestDb` — that fixture uses inline SQL, not the real migration file; this test's purpose is to validate the SQL file itself.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `grep -rn '007_add_stuck_reason\|idx_workflow_runs_status_stuck_at' main/src --include='*.ts'` returns 0 matches — the on-disk migration file `main/src/database/migrations/007_add_stuck_reason.sql` (verified to exist) is now entirely untested, while `createTestDb` uses an inline `ALTER TABLE` (verified in `runs.test.ts:58`) that does NOT exercise the real SQL file or its index; severity is medium since silent drift in a live migration file is a concrete production-DB risk.

### B2. Wire `setCancelDeps()` at boot or demote `runs.cancel` to `throwNotImplemented`
- **Summary:** Fix the latent bug where `cyboflow.runs.cancel` always throws `METHOD_NOT_SUPPORTED` because `setCancelDeps()` is declared but never called in production — either wire it at boot or explicitly demote the procedure to `NOT_IMPLEMENTED`.
- **Source-Sprint:** SPRINT-035
- **Source:** FIND-SPRINT-035-32 (SPRINT-035 sprint-code-reviewer); `main/src/orchestrator/trpc/routers/runs.ts:110-122`, `main/src/index.ts` (missing `setCancelDeps` call).
- **Problem:** `cyboflow.runs.cancel` delegates to `cancelHandler` through the `cancelDeps` module-level singleton. `setCancelDeps()` is declared in `runs.ts` but is never called in `main/src/index.ts`. Three sibling setters are wired at boot: `setCancelAndRestartDeps` (line 744), `setStartRunDeps` (line 753), `setHealthProvider` (line 759). Any future caller — renderer, integration test, or epic-7 work — that invokes `cyboflow.runs.cancel` will get a `METHOD_NOT_SUPPORTED` error with a confusing message. The frontend currently calls only `cancelAndRestart` (not `cancel`), so no UI regression today, but the omission is invisible until someone hits it.
- **Proposed direction:** Decide which of two paths is correct for v1: (a) **Wire it** — add a `setCancelDeps({ db, approvalRouter: ApprovalRouter.getInstance(), lookupExecutor: ..., logger: loggerLike })` call in `main/src/index.ts` adjacent to `setCancelAndRestartDeps` (line 744). This requires implementing the `lookupExecutor` callback — check whether the `WorkflowRegistry` or `RunQueueRegistry` can provide it. (b) **Demote it** — if bare `cancel` is not in v1 scope, replace the procedure body with `throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: 'cancel is not used in v1' })` and delete the dead `CancelDeps` interface + `setCancelDeps` setter to make the intent explicit. Check epic-7 plan to decide.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `grep -rn setCancelDeps main/src --include='*.ts'` returns only the declaration in `runs.ts:120`, a comment ref at line 93, and the error message at line 238 — zero call sites — while `main/src/index.ts` imports and calls `setCancelAndRestartDeps`/`setStartRunDeps`/`setHealthProvider` (lines 35-36, 744-759) but never imports `setCancelDeps`, making `cyboflow.runs.cancel` a latent guaranteed-fail procedure that needs an explicit IMPLEMENT-or-demote decision.

### B3. Resolve statically-dead `ctx.userId !== 'local'` guards in `runs.ts`
- **Summary:** The five `ctx.userId !== 'local'` FORBIDDEN guards in `runs.ts` are unreachable at compile time because `createContext` returns `userId` typed as the literal `'local'`; either widen the type to `string` (making the guards live) or drop the guards (aligning with `workflows.ts` and `approvals.ts` which omit them).
- **Source-Sprint:** SPRINT-035
- **Source:** FIND-SPRINT-035-34 (SPRINT-035 sprint-code-reviewer) refining FIND-SPRINT-035-4 (TASK-711 code-reviewer); `context.ts:88`, `runs.ts:185,204,231,276,301`, `runs.test.ts:172,250,389` (forced casts).
- **Problem:** `createContext()` in `context.ts:88` returns `{ userId: 'local' as const }`. TypeScript proves `ctx.userId` is always the literal `'local'`, so `ctx.userId !== 'local'` is structurally dead at every call site (5 occurrences in `runs.ts`). The tests exercise these branches using `userId: 'someone-else' as 'local'` — an explicit cast that must lie about the type to reach the branch. Meanwhile `workflows.ts` and `approvals.ts` (TASK-711's new procedures) omit the guard and rely on `protectedProcedure`'s `isAuthed` middleware. This inconsistency will widen if new procedures follow the stale `runs.ts` pattern.
- **Proposed direction:** Choose one canonical pattern and apply uniformly across `runs.ts`, `workflows.ts`, and `approvals.ts`: **(a) Make the guards live:** widen `context.ts:88` from `userId: 'local' as const` to `userId: string` (or a `UserId` nominal type), then the five checks in `runs.ts` become meaningful and the test casts become idiomatic. Consider extracting a `localOnlyProcedure = protectedProcedure.use(assertLocalUserId)` middleware that all three routers compose. **(b) Drop the guards:** if v1 will always have `userId = 'local'`, remove all five `ctx.userId !== 'local'` blocks from `runs.ts` plus the three forced-cast test cases that exercise them. This matches `workflows.ts`/`approvals.ts` and is the honest v1 representation. Coordinate with FIND-SPRINT-035-4's suggested middleware approach — the middleware option in (a) gives a single enforcement point for v2.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `context.ts:88` types `userId: 'local'` as literal (`return { userId: 'local' as const, ... }` line 94) and grep finds exactly the 5 cited `ctx.userId !== 'local'` sites in `runs.ts:185,204,231,276,301` — the guards are provably dead at compile time, and `workflows.ts`/`approvals.ts` already chose the no-guard path, so the inconsistency is real and growing; the decision (widen vs drop) is genuinely load-bearing and warrants explicit refinement.
- **Counterfactual:** If a v2 session-principal swap is already planned in a near-term epic, the (a)-widen path becomes obvious and refinement collapses to a small task.

### B4. Sweep two remaining local `createTestDb` declarations to canonical fixture
- **Summary:** Migrate the two test files that still declare a local `createTestDb` function — introduced after TASK-733's plan was written — onto the canonical `orchestratorTestDb` fixture.
- **Source-Sprint:** SPRINT-035
- **Source:** FIND-SPRINT-035-29 (TASK-733 verifier); `main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts:78`, `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:53`.
- **Problem:** TASK-733 consolidated 10 files but two more were introduced mid-sprint by sibling tasks (TASK-709 added `runs.test.ts` at 15:34 PT; the `composeMcpServers` file was committed at 12:50 PT, both after TASK-733's plan was written). Both files declare local `function createTestDb()` instead of importing from `main/src/orchestrator/__test_fixtures__/orchestratorTestDb`. The consolidation goal — a single canonical fixture for test bootstrapping — is not yet fully achieved.
- **Proposed direction:** For each file: (1) add `import { createTestDb } from 'main/src/orchestrator/__test_fixtures__/orchestratorTestDb'` (adjust relative path per file location), (2) delete the local `createTestDb` function declaration, (3) inspect for stale `REGISTRY_SCHEMA` / `SCHEMA_PATH` / `readFileSync` imports to remove after the local is deleted, (4) run `pnpm --filter main test` to confirm all tests pass. Scope is identical to what TASK-733 already did for 10 files.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed both cited local `function createTestDb()` declarations exist — `claudeCodeManager.composeMcpServers.test.ts:78` and `runs.test.ts:53` — and grep shows the canonical fixture is already imported successfully by `claudeCodeManager.killProcess.test.ts:29` and `claudeCodeManagerWiring.test.ts:30` using the same relative-path pattern; mechanically identical to the 10 files TASK-733 already migrated.

### B5. Canonicalize tRPC mock target across renderer test suite
- **Summary:** Sweep 9 test files that mock `../utils/trpcClient` (the backwards-compat shim) to instead mock `../trpc/client` (the canonical path), matching the global setup and the new TASK-715 tests.
- **Source-Sprint:** SPRINT-035
- **Source:** FIND-SPRINT-035-35 (SPRINT-035 sprint-code-reviewer); 9 files listed explicitly: `reviewQueueSlice.test.ts:25`, `reviewQueueStore.test.ts:27`, `mcpHealthStore.test.ts:28`, `OnboardingCard.test.tsx:86`, `StuckInspectorModal.test.tsx:34`, `ReviewQueueView.test.tsx:23`, `PendingApprovalCard.test.tsx:37`, `DraggableProjectTreeView.runs.test.tsx:31`, `useReviewQueueKeyboard.test.ts:28`, `useStuckNotifications.test.ts:42`.
- **Problem:** The canonical tRPC client lives at `frontend/src/trpc/client.ts`. A shim at `frontend/src/utils/trpcClient.ts` re-exports it with a docstring saying "Do NOT add new exports here — import from `@/trpc/client` in new code." The global test setup (`frontend/src/test/setup.ts:13`) mocks the canonical. But 9 test files (including TASK-714's new `DraggableProjectTreeView.runs.test.tsx`) mock the shim. Both work today — the shim is a pure re-export. The risk is that if the shim ever gains logic (instrumentation, error mapping, runtime adapter), tests mocking the shim silently skip the shim logic while tests mocking the canonical do not. TASK-715's `CyboflowRoot.test.tsx` already uses the correct canonical target.
- **Proposed direction:** For each of the 9 files, replace `vi.mock('…/utils/trpcClient', ...)` with `vi.mock('…/trpc/client', ...)` and adjust the relative path. Run `pnpm --filter frontend test` to confirm all 336+ tests still pass. Alternatively, if a future task plans to delete the shim `frontend/src/utils/trpcClient.ts`, do that instead and update the 9 mock targets at the same time. The shim has exactly one binding (`export { trpc }`) so deletion is low-risk.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified by grep — 10 test files mock `…/utils/trpcClient` (the shim) while the global `frontend/src/test/setup.ts:13` and `CyboflowRoot.test.tsx:32` (new this sprint) mock the canonical `…/trpc/client`, confirming the divergence; severity today is zero (shim is a pure re-export) but the inconsistency cements at exactly the moment new tRPC tests get added, and the deletion-of-shim variant is genuinely low cost.
- **Counterfactual:** If there is an existing in-flight plan to delete `frontend/src/utils/trpcClient.ts` entirely, this task should fold into that.

### B6. Fix the `pnpm test` / Playwright bootstrap ambiguity in the root `test` script
- **Summary:** The root `pnpm test` script runs Playwright, which cannot bootstrap because the Electron renderer requires a `preload`-injected `electronTRPC` global; verifiers cannot use it as a code-change gate and sprints with `pnpm test exits 0` ACs get false-positive rubber-stamp verdicts.
- **Source-Sprint:** SPRINT-035
- **Source:** FIND-SPRINT-035-26 (TASK-717 verifier); `tests/` Playwright specs, `package.json:scripts.test`.
- **Problem:** `pnpm test` is `playwright test`, which launches `pnpm electron-dev` as a webServer and points `baseURL` at `http://localhost:4521`. But per CLAUDE.md, the renderer at that port cannot bootstrap standalone — it needs the Electron `preload`-injected `electronTRPC` global. Every `pnpm test` run against the spec suite that waits on `[data-testid="settings-button"]` will hang (body remains hidden). 15 specs fail consistently. Verifiers treating this as a valid AC gate either rubber-stamp with "pre-existing flake" or spend rounds doing parent-commit comparisons. The workspace unit tests (`pnpm test:unit` / `pnpm --filter main test` + `pnpm --filter frontend test`) are the only suite that actually validates code changes.
- **Proposed direction:** Three options — choose one before planning: **(a) Rename the root script** so `"test"` maps to `"test:unit"` (runs `pnpm --filter main test && pnpm --filter frontend test`) and the Playwright suite lives under `"test:e2e"`. Update any AC language in plans and CLAUDE.md to use `"pnpm test:unit"`. **(b) Fix the Playwright config** to launch Electron via `_electron.launch()` instead of `pnpm electron-dev` + `baseURL` — matching the CDP-attach pattern in `docs/VISUAL-VERIFICATION-SETUP.md`. This is more work but restores e2e test capability. **(c) Add a Playwright `testIgnore`** for the Vite-only specs and document the e2e suite as requiring a display/Electron environment, noting which specs are currently skipped and why. Option (a) is the lowest-effort fix for the verifier's AC gate problem; option (b) is the correct long-term fix.
- **Scope:** small (option a) | medium (option b)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `package.json:52` defines `"test": "playwright test"` and `:59` defines `"test:unit"` as the real unit chain — and CLAUDE.md itself notes the renderer "cannot bootstrap standalone" at `http://localhost:4521`, making the Playwright AC gate structurally broken; the SPRINT-035 verifier-rubberstamp evidence (FIND-SPRINT-035-26) shows real verifier-cycle waste, satisfying both frequency and severity.
- **Counterfactual:** If the user's preference is to fix Playwright's Electron bootstrap (option b) rather than rename the root script, the refinement target shifts but the underlying defect still warrants planning.

### B7. Align module-level singletons in `main/src/index.ts` to the `| null = null` safety pattern
- **Summary:** Change the four bare `let` singleton declarations added this sprint (`runQueues`, `workflowRegistry`, `runLauncher`, `orchestratorHealth`) to use `| null = null` initializers, matching the pre-existing `taskQueue`/`orchestrator` pattern and making read-before-init type-visible.
- **Source-Sprint:** SPRINT-035
- **Source:** FIND-SPRINT-035-36 (SPRINT-035 sprint-code-reviewer); `main/src/index.ts:87-90`.
- **Problem:** `taskQueue` and `orchestrator` (pre-existing singletons, lines 85-86) are typed as `Type | null = null`, so any read-before-`initializeServices` is a compile-time null-check obligation. The four singletons added this sprint (`runQueues`, `workflowRegistry`, `runLauncher`, `orchestratorHealth`) are typed without an initializer — TypeScript's `strictPropertyInitialization` does not apply to `let`, so they are silently `undefined` until `initializeServices()` runs. Any future code that reads one of these too early (e.g. a module-level initializer, a top-level event handler) gets `undefined` with no compile-time signal. The sprint widened the unsafe pattern from 1 pre-existing site (`runQueues`) to 4 sites.
- **Proposed direction:** Change lines 87-90 from bare declarations to `| null = null`: `let runQueues: RunQueueRegistry | null = null`, etc. At each read site inside `initializeServices()` and the `createContext` closure, add non-null assertions (`!`) or guards where appropriate. Alternatively, consolidate the four into `let orchestratorServices: { runQueues: RunQueueRegistry; workflowRegistry: WorkflowRegistry; runLauncher: RunLauncher; orchestratorHealth: OrchestratorHealth } | null = null`, assembled once inside `initializeServices()` — this encodes the boot-order invariant as a single null-check obligation. Confirm `pnpm typecheck` passes after the change; the `createContext` closure captures `workflowRegistry` by reference and is safe (only invoked per-request after boot), but the compiler will surface any new null-obligation sites.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed at `main/src/index.ts:85-90` the divergence is real (`taskQueue`/`orchestrator` use `| null = null`; `runQueues`/`workflowRegistry`/`runLauncher`/`orchestratorHealth` use bare `let`), but the severity is purely hypothetical — no current code path reads these before `initializeServices()` runs, and the finding's own analysis admits "the `createContext` closure captures `workflowRegistry` by reference and is safe"; this is preemptive defensive code that would add 4 null-assertions at every read site to guard against a problem no caller is hitting, failing the proportionality bar for module-internal singletons.
- **Counterfactual:** If a future stack trace shows an `undefined.method` crash from one of these singletons being read at module load (not request time), the severity flips and IMPLEMENT becomes correct.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add a note to `CLAUDE.md` clarifying that `pnpm test` runs Playwright (not the unit suite) and is not a reliable verifier AC gate
- **Summary:** Document in project CLAUDE.md that `pnpm test` runs Playwright E2E specs that require a display + Electron preload, and that `pnpm test:unit` (or per-workspace `pnpm --filter main test` + `pnpm --filter frontend test`) is the correct code-change validation gate for verifiers.
- **Source-Sprint:** SPRINT-035
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/CLAUDE.md`
- **Action:** edit the `Common Commands` code block + insert one follow-up sentence after the watch-mode paragraph
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  @@ ## Common Commands
  -pnpm test              # Playwright E2E
  +pnpm test              # Playwright E2E (requires display + Electron preload — NOT a code-change AC gate; see below)
  +pnpm test:unit         # Unit chain — main + frontend vitest, schema parity, build scripts (use this as the verifier AC gate)
   pnpm electron:rebuild  # Fix better-sqlite3 NODE_MODULE_VERSION errors after Node/Electron upgrades
  @@ Workspace `"test"` scripts that participate in a root multi-tier chain ... Put watch mode on a separate `"test:watch"` key.
  +
  +The root `pnpm test` script runs Playwright against `http://localhost:4521`, which cannot bootstrap without the Electron `preload`-injected `electronTRPC` (same root cause as the `visual_web` non-functionality below). Specs that wait on `[data-testid="settings-button"]` hang and the suite fails consistently in headless verifier environments. Verifiers MUST use `pnpm test:unit` (or per-workspace `pnpm --filter main test` + `pnpm --filter frontend test`) as the code-change AC gate; treat `pnpm test` failures as environmental until the root script / Playwright config is reworked.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `package.json:52` is `"test": "playwright test"` and `:59` is the real unit chain at `"test:unit"`, plus CLAUDE.md already documents that the renderer at `http://localhost:4521` "cannot bootstrap standalone" — making the Playwright failure mode a structural deterministic trap for verifiers, not a one-off; the proposed text is a 2-line code-block comment plus one paragraph in the existing Common Commands section (no new rule, no new file, just disambiguates an existing trap).
- **Counterfactual:** If B6 lands first as option (a) — rename the root script — this CLAUDE.md note becomes partially obsolete and should be slimmed to point at `test:unit` as the canonical name without the warning paragraph.

---

## Reconciled Findings (informational)

The following findings appear as `status: open` in the sprint findings file but were confirmed resolved by cross-checking done reports:

- FIND-SPRINT-035-1 — superseded by FIND-SPRINT-035-23 (same stale docblock; TASK-717 did not touch `shared/types/stuckInspection.ts`; triaged as A3 above).
- FIND-SPRINT-024-2 — claimed resolved by TASK-713 verifier (mislabeled in-scope edit; `main/src/ipc/types.ts` was in `files_owned`). Filed in stray `SPRINT-024-findings.md` instead of `SPRINT-035-findings.md`.
- FIND-SPRINT-024-3 — claimed resolved by TASK-713 verifier (mislabeled in-scope edit; `routers/health.ts` was in `files_owned`). Same stray file.
- FIND-SPRINT-024-4 — claimed resolved by TASK-714 verifier (mislabeled in-scope edit; `frontend/src/test/setup.ts` was in `files_owned`). Same stray file.
- FIND-SPRINT-024-5 — claimed resolved by TASK-714 verifier (file not modified; the `setup.ts` approach was sufficient; no actual scope deviation). Same stray file.

FIND-SPRINT-024-1 (real bug: `sessionManager.ts` still imports Crystal-era session-data methods, blocking schema table-drops) is a pre-SPRINT-035 bug that was misfiled into the stray `SPRINT-024-findings.md` by TASK-713's executor. It is not a SPRINT-035 finding. Before deleting the stray file (A1 above), this finding should be preserved — either as a backlog note or carried into the next sprint that touches `sessionManager.ts` / database schema cleanup.

---

## Suppressed — SoloFlow Defects

The following C-bucket candidates were reclassified as SoloFlow executor-agent defects (tester mode is off). They describe behavioral problems in the SoloFlow executor agent itself — not conventions specific to the cyboflow codebase.

- **Executor findings misrouted to wrong sprint ID + in-scope edits misclassified as scope_deviations (FIND-SPRINT-035-7, FIND-SPRINT-035-10, FIND-SPRINT-035-14, FIND-SPRINT-035-15, FIND-SPRINT-035-20, FIND-SPRINT-035-21, FIND-SPRINT-035-24)** — Three consecutive tasks (TASK-712, TASK-713, TASK-714) wrote findings to `.soloflow/active/findings/SPRINT-024-findings.md` instead of `SPRINT-035-findings.md`. Four tasks (TASK-712, TASK-713, TASK-716, TASK-717) logged `type: scope_deviation` entries for files that were explicitly listed in `files_owned` in the plan. Both behaviors point to the SoloFlow executor agent not consulting the active sprint ID from `.soloflow/sprint.json` when opening the findings file, and not checking the plan's `files_owned` list before classifying a touched path as a deviation. Any CLAUDE.md rule added to work around this would be SoloFlow-specific lore that evaporates if the user switches to a different Claude Code workflow. Consider opening a SoloFlow issue or running `/soloflow:compound --tester` in a tester setup to surface this as a D-bucket maintainer recommendation.
- **Peekaboo per-binary Screen Recording grant recurring failure (FIND-SPRINT-035-13)** — Peekaboo MCP capture against the dev-time Electron binary fails again this sprint with "Failed to start stream due to audio/video capture failure." The project `CLAUDE.md` and `docs/VISUAL-VERIFICATION-SETUP.md` already document the per-binary grant requirement. The recurrence (SPRINT-033, SPRINT-034, SPRINT-035) reflects a SoloFlow verification workflow gap — the sprint-verifier is dispatched to attempt `visual_macos` on tasks that have no UI changes and no realistic path to capture success. A workflow-level guard ("skip visual_macos for backend-only tRPC tasks") is a SoloFlow planner/verifier concern, not a project convention. Consider opening a SoloFlow issue. No CLAUDE.md entry is proposed here — the existing `docs/VISUAL-VERIFICATION-SETUP.md` reference in CLAUDE.md is sufficient for human readers.
