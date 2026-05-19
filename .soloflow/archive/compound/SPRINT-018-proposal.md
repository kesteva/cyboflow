---
sprints: [SPRINT-018]
span_label: SPRINT-018
created: "2026-05-18T00:00:00.000Z"
counters_start:
  ideas: 0
summary:
  cleanups: 2
  backlog_tasks: 3
  claude_md: 3
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-018

## A. Clean-up items (execute now)

### A1. Remove `deriveEnvelopeType` duplication — promote shared `deriveEventType` helper to `streamParser/`
- **Summary:** `deriveEnvelopeType` in `runEventBridge.ts` is a verbatim duplicate of `deriveEventType` in `rawEventsSink.ts`; extract one shared helper so the `ClaudeStreamEvent → event_type` mapping cannot silently diverge.
- **Source-Sprint:** SPRINT-018
- **Rationale:** Both files implement the same `'kind' in event && event.kind === '__unknown__'` guard and fallback to `event.type`. Any future variant rename must currently be applied in two places. This is a bounded, low-risk extraction with a clear target module (`main/src/services/streamParser/index.ts` or a new `derivers.ts` alongside it).
- **Blast radius:** `main/src/orchestrator/runEventBridge.ts`, `main/src/services/streamParser/rawEventsSink.ts`, plus the export surface of `main/src/services/streamParser/index.ts`. Risk: trivial — pure function extraction, no runtime behavior change.
- **Source:** FIND-SPRINT-018-3 (TASK-642 verifier + code-reviewer); TASK-642 done report explicitly acknowledges the duplication and deferred it to compound.
- **Proposed change:**
  ```
  1. Add to main/src/services/streamParser/index.ts (or a new derivers.ts):
       export function deriveEventType(event: ClaudeStreamEvent): string {
         return 'kind' in event && event.kind === '__unknown__'
           ? '__unknown__'
           : event.type;
       }

  2. In main/src/orchestrator/runEventBridge.ts:
     - Delete the local `deriveEnvelopeType` function.
     - Add: import { deriveEventType } from '../services/streamParser';
     - Replace all call sites of `deriveEnvelopeType(event)` with `deriveEventType(event)`.

  3. In main/src/services/streamParser/rawEventsSink.ts:
     - Delete the local `deriveEventType` function (or just import the canonical one
       if the local definition is unexported).

  4. Add 2-3 unit tests for the exported helper in
     main/src/services/streamParser/__tests__/derivers.test.ts covering
     known-kind, __unknown__, and plain-type cases.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified verbatim duplicates — `deriveEnvelopeType` at runEventBridge.ts:89-94 and `deriveEventType` at rawEventsSink.ts:38-44 share identical `'kind' in event && event.kind === '__unknown__'` guard and `(event as { type: string }).type` fallback, and streamParser already has a barrel `index.ts` ready to host the export.

### A2. Export `TERMINAL_RUN_STATUSES` from `shared/types/cyboflow.ts` to eliminate the repeated magic literal
- **Summary:** The three-value terminal-status set `('canceled','failed','completed')` is inlined verbatim in three separate files; export a single `TERMINAL_RUN_STATUSES` constant from `shared/types/` so a future status addition is a one-line change.
- **Source-Sprint:** SPRINT-018
- **Rationale:** `main/src/services/cyboflow/transitions.ts`, `main/src/orchestrator/cancelAndRestartHandler.ts`, and `main/src/orchestrator/trpc/routers/runs.ts` all hard-code the same SQL `NOT IN ('canceled','failed','completed')` fragment. The `shared/types/` package is already importable by both `services/*` and `orchestrator/*` without violating the standalone-typecheck invariant (confirmed by FIND-SPRINT-018-5's suggested fix). This is a clean-up: no logic changes, only a constant export and three import updates.
- **Blast radius:** `shared/types/cyboflow.ts`, `main/src/services/cyboflow/transitions.ts`, `main/src/orchestrator/cancelAndRestartHandler.ts`, `main/src/orchestrator/trpc/routers/runs.ts`. Risk: low — string constant extraction, all three call sites remain functionally identical.
- **Source:** FIND-SPRINT-018-5 (TASK-644 code-reviewer).
- **Proposed change:**
  ```
  1. In shared/types/cyboflow.ts, add:
       export const TERMINAL_RUN_STATUSES = ['canceled', 'failed', 'completed'] as const;
       export type TerminalRunStatus = typeof TERMINAL_RUN_STATUSES[number];
       // Derived SQL literal — use via template literal, not raw string
       export const TERMINAL_RUN_STATUSES_SQL =
         `(${TERMINAL_RUN_STATUSES.map(() => '?').join(',')})`;  // parameterized form
       // Or if inlined into SQL string (no bind params for these):
       export const TERMINAL_RUN_STATUSES_SQL_IN =
         `('${TERMINAL_RUN_STATUSES.join("','")}')`;

  2. In each of the three call sites, replace the inline SQL fragment with a
     template literal referencing TERMINAL_RUN_STATUSES_SQL_IN (or rebuild the
     WHERE clause via the array). Keep the existing parameterized runId binding.

  3. Optionally add a runtime assertion in transitions.ts module body:
       console.assert(
         TERMINAL_RUN_STATUSES_SQL_IN.includes('canceled'),
         'TERMINAL_RUN_STATUSES_SQL mismatch'
       );
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Three inlined copies of `NOT IN ('canceled', 'failed', 'completed')` confirmed at transitions.ts:213, cancelAndRestartHandler.ts:68/149, runs.ts:127, all in modules that already import from `shared/types/` (or are import-compatible per the standalone-typecheck invariant); cost is one constant export plus three template-literal swaps.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Integrate RunExecutor helpers — wire `buildPreToolUseHook`, `bridgeEvents`, and `onLifecycleTransition` into a single working execution pipeline
- **Summary:** Four cross-helper contract gaps (FIND-7/8/9/10) block the integration of SPRINT-018's scaffolding into a running pipeline; a single integration task must resolve the `cancel()` surface, `bridgeEvents` return-type, `ExecutionPhase` vocabulary, and `ClaudeSpawnerOptions.preToolUseHook` slot together.
- **Source-Sprint:** SPRINT-018
- **Source:** FIND-SPRINT-018-7, FIND-SPRINT-018-8, FIND-SPRINT-018-9, FIND-SPRINT-018-10 (all sprint-code-reviewer).
- **Problem:** The four helpers built in SPRINT-018 (`RunExecutor`, `runEventBridge`, `permissionModeMapper`, `cancelHandler`) are individually unit-tested but cannot be wired together yet because of four mutually-reinforcing contract gaps:

  1. **Missing `cancel()` on RunExecutor** (`runExecutor.ts` vs `runs.ts:63`): `cancelHandler` expects `{ cancel(): Promise<void> }` but `RunExecutor` exposes only `execute()`. No reference to an abort/stop handle exists on `ClaudeSpawnerLike`. (FIND-SPRINT-018-8)

  2. **`bridgeEvents` swallows its return value** (`runExecutor.ts:159-161` vs `runEventBridge.ts:59-61`): The protected hook is `Promise<void>`, but `runEventBridge.bridgeEvents()` returns `RunEventBridge { dispose(): void }`. The integration override cannot retain the bridge handle for cleanup on cancel or terminal transition. (FIND-SPRINT-018-9)

  3. **`ExecutionPhase` vocabulary mismatch** (`runExecutor.ts:66` vs `transitions.ts:43-221`): `spawning|spawned|error` does not map to `starting→running→completed|failed|canceled`. The `onLifecycleTransition` hook cannot route to the correct `transitions.ts` helper without an impedance adapter that currently does not exist. (FIND-SPRINT-018-10)

  4. **No `preToolUseHook` slot on `ClaudeSpawnerOptions`** (`runExecutor.ts:33-39` vs `permissionModeMapper.ts:96-100`): `buildPreToolUseHook()` returns `HookCallback | undefined` but `buildOptionsOverrides()` has nowhere to thread it; the stale `permissionMode?: 'approve'|'ignore'` field is also a no-caller dead field. (FIND-SPRINT-018-7)

- **Proposed direction:** Produce a single integration task that resolves all four gaps in one coherent plan, since they are load-bearing for each other:
  - Decide `cancel()` ownership (Option A: `RunExecutor.cancel()` calls `spawner.abort(panelId)` — requires `ClaudeSpawnerLike.abort`; Option B: thin `RunHandle { cancel() }` side-registry). The `cancelHandler` wrapper-contract points toward Option A.
  - Change `RunExecutor.bridgeEvents` return type to `Promise<RunEventBridge | void>` (or `Promise<{ dispose(): void } | void>`); add a private `Map<string, { dispose(): void }>` field; call `dispose()` from `teardownRun(runId)` invoked by `cancel()` and terminal `onLifecycleTransition` phases.
  - Drop `ExecutionPhase` enum or widen it to `pre_spawn|post_spawn|sdk_initialized|completed|failed|canceled`; replace `onLifecycleTransition(runId, phase)` with split hooks (`onPreSpawn`, `onPostSpawn`, `onExecuteError`) OR document the mapping from each new phase to the correct `transitions.ts` helper.
  - Replace `ClaudeSpawnerOptions.permissionMode?: 'approve'|'ignore'` with `preToolUseHook?: HookCallback`; update `buildOptionsOverrides()` to call `buildPreToolUseHook(workflow.permission_mode, runId, logger)` and pass the result.
  - Add integration tests in `runExecutor.test.ts` that exercise the wired cancel+dispose path and the hook-threading path (injected real `buildPreToolUseHook` result).
  - Files that will need editing: `main/src/orchestrator/runExecutor.ts`, `main/src/orchestrator/runEventBridge.ts` (or its integration subclass), `main/src/orchestrator/trpc/routers/runs.ts`, `main/src/orchestrator/permissionModeMapper.ts` (types only); `claudeCodeManager.ts` may need `ClaudeSpawnerLike.abort` added if Option A is chosen.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** All four gaps verified concrete: `RunExecutor` class (runExecutor.ts:68-189) has no `cancel()` method despite `CancelDeps.lookupExecutor` typing it at runs.ts:63; `bridgeEvents` override returns `Promise<void>` (runExecutor.ts:159-161) while helper returns `RunEventBridge` (runEventBridge.ts:110); `ExecutionPhase = 'spawning'|'spawned'|'error'` (runExecutor.ts:66) cannot map to `starting|running|completed|failed|canceled` in transitions.ts; and `ClaudeSpawnerOptions.permissionMode?: 'approve'|'ignore'` (runExecutor.ts:38) has no slot for the `HookCallback` that `buildPreToolUseHook` returns — leaving SPRINT-018 scaffolding non-integrated.

### B2. Hoist shared `preToolUseHook` logic — eliminate `deferToApprovalRouter` / `makePreToolUseHook` duplication
- **Summary:** `permissionModeMapper.deferToApprovalRouter` and `ClaudeCodeManager.makePreToolUseHook` are near-verbatim duplicates; extract a shared `routePreToolUseThroughApprovalRouter` helper so any SDK `PreToolUseHookOutput` contract change only needs one edit.
- **Source-Sprint:** SPRINT-018
- **Source:** FIND-SPRINT-018-4 (TASK-643 code-reviewer). TASK-643 done report acknowledges the duplication and defers it since `claudeCodeManager.ts` was in `files_readonly` for that task.
- **Problem:** The try/catch shape, allow/deny branch logic, `updatedInput` spread, `permissionDecisionReason` field, `'Internal approval-router error'` safe-deny string, `() => {}` socketReply, and all three `as const` literals are byte-for-byte identical in both files. Only the log-line prefix differs. A future SDK `PreToolUseHookOutput` shape change (new `decisionReason` field, richer `ApprovalDecision` branches, additional metadata) must be applied in both places or the legacy chat-panel path and the new `RunExecutor` path silently diverge. Located at: `main/src/orchestrator/permissionModeMapper.ts:40-82` and `main/src/services/panels/claude/claudeCodeManager.ts:481-519`.
- **Proposed direction:** Create `main/src/orchestrator/preToolUseHookHelper.ts` (or `main/src/services/panels/claude/preToolUseHookHelper.ts` if the file must live outside orchestrator to satisfy the standalone-typecheck invariant — check which side imports `ApprovalRouter`). Export `routePreToolUseThroughApprovalRouter(pretool, callerId, callerLabel, logger?): Promise<HookJSONOutput>`. Have `permissionModeMapper.deferToApprovalRouter` and `claudeCodeManager.makePreToolUseHook` both delegate to it. The integration task must include `claudeCodeManager.ts` in `files_owned` since the legacy panel cannot be edited with it in `files_readonly`. Verify both test suites pass after the consolidation.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified byte-equivalent try/catch + allow/deny branches at claudeCodeManager.ts:481-520 and permissionModeMapper.ts:40-82, both producing the identical `'Internal approval-router error'` safe-deny string and `permissionDecisionReason` field — a single SDK `PreToolUseHookOutput` change would silently fork the two paths.

### B3. Extract shared `parseMarkdownFrontmatter` helper to end `workflowPromptReader` / `WorkflowRegistry` divergence
- **Summary:** `workflowPromptReader.splitFrontmatter` and `WorkflowRegistry.parseFrontmatter` implement the same flat key:value YAML extractor with identical regex shapes but already-divergent boundary conditions; extract one canonical helper before the parsers silently diverge further.
- **Source-Sprint:** SPRINT-018
- **Source:** FIND-SPRINT-018-11 (sprint-code-reviewer, with explicit deferral note from TASK-641 plan).
- **Problem:** Both files use identical inner-line regex (`/^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/`), identical CRLF-aware outer regex shapes, and identical quote-strip logic. They already differ on one boundary: `workflowPromptReader.ts:99` captures the body via a trailing `\r?\n?` consumer; `workflowRegistry.ts:175` does not. Any frontmatter extension (array values, multiline strings, comments, nested keys) must be applied in both regexes or the two parsers diverge. The TASK-641 plan explicitly flagged this as a "Hardest Decision" deferral — the compound findings make the cleanup actionable now.
- **Proposed direction:** Create `main/src/orchestrator/markdownFrontmatter.ts` (importable by both `workflowPromptReader.ts` and `workflowRegistry.ts` without violating the standalone-typecheck invariant, since neither file imports `electron` or `better-sqlite3`). Export `parseMarkdownFrontmatter(md: string): { frontmatter: Record<string, string>; body: string }`. Replace `workflowPromptReader.splitFrontmatter` and `WorkflowRegistry.parseFrontmatter` (+ `extractPermissionMode`) with calls to the shared helper. Add 5-6 unit tests in `main/src/orchestrator/__tests__/markdownFrontmatter.test.ts`: LF/CRLF, single/double quote stripping, `---` sequences inside body, empty body, missing frontmatter, multi-line body.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified identical inner regex `/^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/` and identical quote-stripping at workflowPromptReader.ts:107-115 and workflowRegistry.ts:179-188, with the already-flagged outer-regex divergence (workflowPromptReader.ts:99 uses `\r?\n?` body consumer vs workflowRegistry.ts:175 stops at `---`) confirming the parsers are already drifting.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the `runEventBridge.ts` standalone-typecheck exception in `docs/ARCHITECTURE.md`
- **Summary:** `runEventBridge.ts` is the lone file in `orchestrator/**` that uses VALUE imports from `main/src/services/*`, violating the stated standalone-typecheck invariant; document the accepted exception so future authors do not silently add more.
- **Source-Sprint:** SPRINT-018
- **Target file:** `docs/ARCHITECTURE.md`
- **Rationale:** FIND-SPRINT-018-6 (sprint-code-reviewer) identifies that `runExecutor.ts:6` explicitly states the invariant ("This module must NOT import electron, better-sqlite3, or any concrete service in `main/src/services/*`"), but `runEventBridge.ts:21-22` imports `EventRouter`, `RawEventsSink`, and `TypedEventNarrowing` at value position. The `import type Database` is type-only and erased, but the three class imports are not. The mitigating factor (streamParser itself has clean runtime imports today) does not prevent future streamParser changes from pulling in electron or better-sqlite3 and silently breaking the guarantee. Accepting the exception is the cheaper path (per FIND-SPRINT-018-6's path (a)), but it must be documented so reviewers can enforce the boundary explicitly.
- **Proposed change:**
  ```diff
  In docs/ARCHITECTURE.md, under the section that describes the orchestrator/
  standalone-typecheck invariant (wherever runExecutor.ts's invariant comment
  is referenced or wherever the orchestrator/ module constraints are described):

  + ### Documented Exception: `runEventBridge.ts`
  + `main/src/orchestrator/runEventBridge.ts` imports `EventRouter`,
  + `RawEventsSink`, and `TypedEventNarrowing` from
  + `main/src/services/streamParser` at value position. This is the ONLY
  + accepted exception to the orchestrator standalone-typecheck invariant.
  + It is permitted because `streamParser` itself has clean runtime imports
  + (zod, node:events; only a type-only `better-sqlite3` import as of
  + SPRINT-018). If `streamParser` ever pulls in `electron` or `better-sqlite3`
  + at value position, `runEventBridge.ts` must be updated to inject these
  + collaborators via constructor options rather than direct imports.
  + Do NOT add additional value imports from `services/*` to any other file
  + under `orchestrator/**` without updating this exception list.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified runEventBridge.ts:22 value-imports `EventRouter`, `RawEventsSink`, `TypedEventNarrowing` from `../services/streamParser`, contradicting the invariant stated at ARCHITECTURE.md:57-60 and runExecutor.ts:6-9; without a documented exception, future agents will either copy the pattern or attempt to "fix" the violation with a churny refactor.

### C2. Add log-prefix naming convention to `docs/CODE-PATTERNS.md`
- **Summary:** Three conflicting log-prefix conventions were introduced in SPRINT-018 across the four new helper files; document the canonical `[PascalCase]` rule so future helpers match the existing `[ClaudeCodeManager]` / `[RunLauncher]` pattern.
- **Source-Sprint:** SPRINT-018
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** FIND-SPRINT-018-13 (sprint-code-reviewer) documents three styles now in use: `[RunExecutor]` / `[RunLauncher]` (PascalCase), `[runEventBridge]` / `[permissionModeMapper]` (camelCase), and `[cancel]` / `[cancelAndRestart]` (action verb). The canonical pattern matches existing legacy code (`[ClaudeCodeManager]`). Additionally, `runEventBridge.ts` and `runs.ts:cancelHandler` log only `err.message` while `runLauncher.ts:152` logs `err.stack ?? err.message` — stack-trace parity is worth standardizing at the same time. The four non-conforming call sites are: `runEventBridge.ts:158,171,188` (should be `[RunEventBridge]`), `permissionModeMapper.ts:72` (should be `[PermissionModeMapper]`), `runs.ts:116` (should be `[Cancel]` or `[CancelHandler]`). Including the call sites in the pattern doc entry gives the next cleanup task a concrete search target.
- **Proposed change:**
  ```diff
  In docs/CODE-PATTERNS.md, add a new section (or append to an existing
  "Logging" section if one exists):

  + ## Logger Prefix Convention
  +
  + All logger call sites in `main/src/` use a bracketed PascalCase prefix
  + that matches the module's primary export name (class or handler):
  +
  + ```ts
  + // Good — matches class name
  + logger.info('[RunExecutor] starting execute', { runId });
  + logger.error('[RunEventBridge] bridge error', { err: err.stack ?? err.message });
  +
  + // Bad — camelCase module filename
  + logger.info('[runEventBridge] bridge error', ...);
  +
  + // Bad — action verb fragment
  + logger.error('[cancel] handler error', ...);
  + ```
  +
  + **Rule:** prefix = PascalCase of the primary exported class or handler
  + (e.g. `ClaudeCodeManager`, `RunLauncher`, `RunExecutor`, `RunEventBridge`,
  + `PermissionModeMapper`, `CancelHandler`).
  +
  + **Error logging:** always log `err.stack ?? err.message` (not `err.message`
  + alone) so stack traces survive into production logs.
  +
  + **Known non-conforming sites (fix in next cleanup pass):**
  + - `main/src/orchestrator/runEventBridge.ts:158,171,188` → `[RunEventBridge]`
  + - `main/src/orchestrator/permissionModeMapper.ts:72` → `[PermissionModeMapper]`
  + - `main/src/orchestrator/trpc/routers/runs.ts:116` → `[CancelHandler]`
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The "always log `err.stack ?? err.message`" portion is rule drift — grep shows only 2 callsites use that form (stuckDetector.ts:197, runLauncher.ts:152) versus 20+ that use `err.message` alone across worktreeManager, messageProjection, claudeCodeManager — codifying it would mark the majority of the codebase non-conforming, and the embedded inline list of "known non-conforming sites" guarantees the doc goes stale.
- **Counterfactual:** Verdict would flip to IMPLEMENT if the rule were narrowed to just the PascalCase prefix convention (which IS the current dominant pattern) and the embedded todo-site list were dropped.

### C3. Document shared test-fixture pattern — `seedWorkflowRun` helper and shared `makeTestDb`
- **Summary:** The inline `INSERT INTO workflow_runs …` SQL appears verbatim 9+ times across the SPRINT-018 test files; document a canonical `seedWorkflowRun` fixture helper in `CODE-PATTERNS.md` so future test authors do not continue the duplication.
- **Source-Sprint:** SPRINT-018
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** FIND-SPRINT-018-12 (sprint-code-reviewer) documents that the sprint introduced 4 new test files, each with its own inline `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot) VALUES (?, ?, ?, 'queued', 'default')`. The same literal (or near-identical variants) appears 9 times across `runExecutor.test.ts` (4×), `runLauncher.test.ts` (5×), with additional siblings in `runLifecycle.test.ts` and `cancelAndRestart.test.ts`. Four copies of `createTestDb()` also exist independently. A single `workflow_runs` schema change (e.g. adding a NOT NULL column without a default) will require 9+ edits before the test suite goes green. The fix is a shared fixture module; documenting the pattern prevents the next sprint from continuing the inline-insert habit.
- **Proposed change:**
  ```diff
  In docs/CODE-PATTERNS.md, add a section under test patterns:

  + ## Test Fixtures — Database Seeds
  +
  + Do NOT inline SQL INSERT statements for `workflow_runs` or `workflows` in
  + individual test files. Use (or create) shared seed helpers in
  + `main/src/orchestrator/__test_fixtures__/seed.ts`:
  +
  + ```ts
  + // main/src/orchestrator/__test_fixtures__/seed.ts
  + export function seedWorkflowRun(
  +   db: Database,
  +   opts: {
  +     id: string;
  +     workflowId: string;
  +     projectId: string;
  +     status?: string;           // defaults to 'queued'
  +     permissionModeSnapshot?: string; // defaults to 'default'
  +     policyJson?: string;
  +   }
  + ): void { /* ... */ }
  +
  + export function makeTestDb(): Database {
  +   /* in-memory better-sqlite3 + schema migrations applied */
  + }
  + ```
  +
  + Rationale: a single `workflow_runs` schema change (e.g. a new NOT NULL
  + column) currently requires editing 9+ inline INSERTs across the test suite.
  + With a shared helper, it is one change.
  +
  + **Known inline-insert sites to migrate:**
  + - `main/src/orchestrator/__tests__/runExecutor.test.ts:278,389,482,544`
  + - `main/src/orchestrator/__tests__/runLauncher.test.ts:206,292,400,545,631,739`
  + - `main/src/orchestrator/__tests__/runLifecycle.test.ts` (seedRun helper — hoist)
  + - `main/src/orchestrator/__tests__/cancelAndRestart.test.ts:77`
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified 11 independent `createTestDb` definitions and 24 inline `INSERT INTO workflow_runs` sites across `main/src/`, and the pattern fits cleanly alongside the existing `__test_fixtures__/dbAdapter` entry in CODE-PATTERNS.md:92-96 — the "Extract-shared-utility refactors: prove completeness" rule already at line 161 explicitly cites this class of regression (TASK-603/604/605).

---

## Reconciled Findings (informational)

The following findings were marked `status: open` in the findings file but were already resolved during the sprint. The sprint-closer's reconciliation step did not patch their `resolved_by:` field. These are NOT triaged into A/B/C buckets above.

- **FIND-SPRINT-018-1** — claimed resolved by TASK-642 in `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/orchestrator-and-trpc-router/TASK-642-done.md`. Done report states: "Hygiene pass removed an unused TypedEventNarrowing import and unused `unknownEvent` fixture." Both FIND-1 (unused `TypedEventNarrowing` import) and FIND-2 (unused `unknownEvent` fixture) were addressed inline.
- **FIND-SPRINT-018-2** — claimed resolved by TASK-642 in `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/orchestrator-and-trpc-router/TASK-642-done.md`. See note above.
