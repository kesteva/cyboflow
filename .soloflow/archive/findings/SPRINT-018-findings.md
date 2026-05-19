---
sprint: SPRINT-018
pending_count: 13
last_updated: "2026-05-19T00:26:57.484Z"
---
# Findings Queue

## FIND-SPRINT-018-1
- **source:** TASK-642 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runEventBridge.test.ts:22
- **description:** `TypedEventNarrowing` is imported from `../../services/streamParser` but never referenced in the test body. The bridge uses the default-constructed narrowing under the hood, so the test does not need to import it. ESLint flags it as `@typescript-eslint/no-unused-vars` (warning, not error).
- **suggested_action:** Drop `TypedEventNarrowing` from the import; keep only `EventRouter` and `RawEventsSink`.
- **resolved_by:** 

## FIND-SPRINT-018-2
- **source:** TASK-642 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runEventBridge.test.ts:96-99
- **description:** The `unknownEvent` fixture is declared but never consumed — the malformed-payload test (case 7) emits an inline raw object instead. ESLint flags this as `@typescript-eslint/no-unused-vars` (warning). The fixture is misleading because it shows a pre-built __unknown__ shape that the bridge never produces from the emit path it tests.
- **suggested_action:** Either delete the fixture, or rework case 7 to round-trip it (would need to feed it through `narrowing.narrow` first — probably not worth it; deletion is simpler).
- **resolved_by:** 

## FIND-SPRINT-018-3
- **source:** TASK-642 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runEventBridge.ts:89-94 + main/src/services/streamParser/rawEventsSink.ts:38-44
- **description:** `deriveEnvelopeType` in runEventBridge.ts is a verbatim duplicate of `deriveEventType` in rawEventsSink.ts — both check `'kind' in event && event.kind === '__unknown__'` and fall back to `event.type`. The mapping from `ClaudeStreamEvent → event_type` is now defined in two places, so a future variant rename (e.g. a third "kind"-tagged catch-all) must be updated in both files or the sink/bridge views diverge silently. TASK-642's files_owned excluded rawEventsSink.ts, so the bridge correctly duplicated the helper rather than editing the sink — this is a cross-task cleanup, not a TASK-642 defect.
- **suggested_action:** Promote a single `deriveEventType(event: ClaudeStreamEvent): string` helper to `main/src/services/streamParser/index.ts` (or a new `derivers.ts`), then have both runEventBridge.ts and rawEventsSink.ts import it. Add a unit test for the helper itself rather than testing the mapping through each call site.
- **resolved_by:** 

## FIND-SPRINT-018-4
- **source:** TASK-643 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/permissionModeMapper.ts:40-82 + main/src/services/panels/claude/claudeCodeManager.ts:481-519
- **description:** `deferToApprovalRouter` in permissionModeMapper.ts is a near-verbatim duplicate of `ClaudeCodeManager.makePreToolUseHook`: identical try/catch shape, identical allow/deny branches, identical `updatedInput` and `permissionDecisionReason` spreads, identical safe-deny reason string `'Internal approval-router error'`, identical `() => {}` socketReply, identical `'PreToolUse' as const` / `'allow' as const` / `'deny' as const` literals. The only differences are the log-line prefix and the surrounding class vs. module shell. Same drift profile as FIND-SPRINT-018-3 (deriveEnvelopeType): TASK-643's `claudeCodeManager.ts` is in files_readonly, so the mapper correctly duplicated rather than edited the legacy panel — this is a cross-task cleanup, not a TASK-643 defect. Going forward, any change to the SDK's PreToolUseHookOutput contract (e.g. a new `decisionReason` shape, additional metadata field, or richer ApprovalDecision branches) must be applied in BOTH files or the legacy chat-panel path and the new RunExecutor path will silently diverge.
- **suggested_action:** Hoist a shared `routePreToolUseThroughApprovalRouter(pretool, callerId, logger?, callerLabel?): Promise<HookJSONOutput>` helper into `main/src/orchestrator/` (e.g. a new `preToolUseHookHelper.ts`). Have both `permissionModeMapper.deferToApprovalRouter` and `claudeCodeManager.makePreToolUseHook` delegate to it. The `callerLabel` lets each call site keep its own log prefix without re-declaring the body. Verify both pipelines still pass their unit tests after the consolidation. Plan with `claudeCodeManager.ts` in files_owned and `permissionModeMapper.ts` in files_readonly (or both owned), since the consolidation must edit the legacy panel.
- **resolved_by:** 

## FIND-SPRINT-018-5
- **source:** TASK-644 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/services/cyboflow/transitions.ts:210-214 + main/src/orchestrator/cancelAndRestartHandler.ts:147-150 + main/src/orchestrator/trpc/routers/runs.ts:115-119
- **description:** The terminal-status guard SQL `UPDATE workflow_runs SET status='canceled', ended_at=..., updated_at=... WHERE id=? AND status NOT IN ('canceled','failed','completed')` now appears verbatim in three locations: the canonical helper `transitionToCanceled`, the legacy `cancelAndRestartHandler`, and the new `cancelHandler` in `runs.ts`. The orchestrator/trpc/* tree cannot import from `main/src/services/*` per its repeatedly-stated standalone-typecheck invariant, so DRYing via `transitionToCanceled` is blocked. The inlined SQL is intentional, but the terminal-status set `('canceled','failed','completed')` is also a magic literal repeated in 3+ files — a future addition of a terminal status (e.g. 'abandoned') silently diverges between the helper and the orchestrator handlers.
- **suggested_action:** Export `TERMINAL_RUN_STATUSES` (and a derived `TERMINAL_RUN_STATUSES_SQL_LITERAL` string like `"('canceled','failed','completed')"`) from `shared/types/cyboflow.ts` — both `services/*` and `orchestrator/*` can import shared/types without violating the standalone-typecheck invariant. All three call sites then build the WHERE clause via string interpolation of the SQL literal (still parameterized for the runId). Add a runtime assertion that the SQL literal matches `Array.from(TERMINAL_RUN_STATUSES)` on module load.
- **resolved_by:** 

## FIND-SPRINT-018-6
- **source:** SPRINT-018 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runEventBridge.ts:21-22
- **description:** Standalone-typecheck invariant violation in runEventBridge.ts — VALUE imports from main/src/services/* (only place in orchestrator/**/*.ts that does this).
- **suggested_action:** Either (a) accept the exception and codify it in runEventBridge.tss header comment plus a one-line entry in docs/ARCHITECTURE.md noting that orchestrator/runEventBridge.ts is the documented exception (matching how transitions.ts is treated in services/cyboflow), OR (b) hoist EventRouter / RawEventsSink / TypedEventNarrowing into orchestrator/ (or expose them as injection-only collaborators on the bridgeEvents opts) so the value imports go away. Path (a) is cheaper and consistent with FIND-SPRINT-018-5s acceptance of inlined SQL in trpc/routers/runs.ts. Pair this with FIND-SPRINT-018-3 (deriveEventType duplication) — both stem from streamParser being half-coupled to orchestrator.
- **resolved_by:** 








runEventBridge.ts:21-22:
  import type Database from better-sqlite3;
  import { EventRouter, RawEventsSink, TypedEventNarrowing } from ../services/streamParser;

runExecutor.ts:6 explicitly documents the invariant: "This module must NOT import electron, better-sqlite3, or any concrete service in main/src/services/*." The other three sprint helpers (runExecutor, workflowPromptReader, permissionModeMapper) honor it; runLauncher.ts uses only `import type` from services. runEventBridge.ts is the lone defector with VALUE imports of EventRouter/RawEventsSink/TypedEventNarrowing.

Mitigating: (a) streamParser itself has clean runtime imports (zod, node:events; only a type-only better-sqlite3 import), so typecheck still passes today; (b) the `import type Database` is type-only and Erased at compile time. But the value imports of three concrete classes still mean a future change inside main/src/services/streamParser/ that pulls in electron or better-sqlite3 at value position will silently break the standalone-typecheck guarantee for orchestrator/**.

Suspected tasks: TASK-642

## FIND-SPRINT-018-7
- **source:** SPRINT-018 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:33-39 + main/src/orchestrator/permissionModeMapper.ts:96-100
- **description:** Cross-helper type-contract gap: RunExecutor.ClaudeSpawnerOptions has no slot for the SDK `hooks` field, so when the integration task wires TASK-643s buildPreToolUseHook() into RunExecutor, buildOptionsOverrides() will have nowhere to thread the HookCallback through.
- **suggested_action:** In the next sprints integration task (or as a small clean-up), extend ClaudeSpawnerOptions with a `preToolUseHook?: HookCallback` field that mirrors the SDKs actual options shape, then make `buildOptionsOverrides()` route the output of `buildPreToolUseHook(workflow.permission_mode, runId, logger)` into it. Drop the stale `permissionMode?: approve|ignore` field — there is no caller producing those values from the workflows PermissionMode. Add a unit test in runExecutor.test.ts that exercises the wired path (a subclass that injects a real buildPreToolUseHook result) so the contract is exercised end-to-end.
- **resolved_by:** 







runExecutor.ts:33-39:
  export interface ClaudeSpawnerOptions {
    panelId, sessionId, worktreePath, prompt;
    permissionMode?: approve | ignore;
  }

permissionModeMapper.ts:96-100:
  export function buildPreToolUseHook(mode, runId, logger?): HookCallback | undefined

The header comment in runExecutor.ts:17-19 even calls out the type-axis mismatch (WorkflowRow.permission_mode is default|acceptEdits|dontAsk vs ClaudeSpawnOptions.permissionMode approve|ignore), but the resolution stops at "buildOptionsOverrides() leaves permissionMode undefined until TASK-643 lands." TASK-643 actually lands a HookCallback (not a permissionMode value), so the contract is still mismatched after the sprint closes. The integration task will need to either widen ClaudeSpawnerOptions to accept `hooks?: { PreToolUse?: HookCallback[] }`, OR add a separate `preToolUseHook?: HookCallback` slot — either way its a missing seam that surfaces only when both helpers are wired.

Suspected tasks: TASK-640, TASK-643

## FIND-SPRINT-018-8
- **source:** SPRINT-018 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts (no cancel()) + main/src/orchestrator/trpc/routers/runs.ts:63
- **description:** Cross-task contract gap: TASK-644s cancelHandler expects a RunExecutor surface with `cancel(): Promise<void>`, but TASK-640s RunExecutor class does NOT expose any cancel method.
- **suggested_action:** Decide ownership of cancellation in the next integration task:
- **resolved_by:** 






runs.ts:63:
  lookupExecutor: (runId: string) => { cancel(): Promise<void> } | null;

runExecutor.ts (full module) has only: constructor, execute(), and four protected hooks (getPrompt/bridgeEvents/buildOptionsOverrides/onLifecycleTransition). No public cancel().

Consequence: when the integration task wires the runs.cancel mutation, it must either (a) add a `cancel()` method to RunExecutor that aborts the underlying spawnCliProcess AsyncIterator, or (b) register a separate cancel-handle in a side registry, leaving the wrapper-vs-class question unresolved. The cancelHandler is structured around the wrapper-with-cancel shape (`{ cancel(): Promise<void> }`), so the implicit contract is that RunExecutor will eventually be that wrapper — but the constructor today does not even hold a reference to anything cancelable (ClaudeSpawnerLike has only spawnCliProcess, not abort/stop).

Suspected tasks: TASK-640, TASK-644
  Option A — extend ClaudeSpawnerLike with `abort(panelId): Promise<void>` (mirroring ClaudeCodeManager.killProcess / stopProcess), have RunExecutor expose `async cancel(): Promise<void>` that calls spawner.abort(panelId), and store the active panelId on the instance during execute(). This makes RunExecutor stateful and matches the contract in runs.ts:63.
  Option B — leave RunExecutor stateless and have the integration task build a thin RunHandle wrapper { runId, cancel() } per-call, store it in a registry, and resolve lookupExecutor against the registry.
Either way, decide before wiring runs.cancel to a real RunExecutor. Add a unit test in runExecutor.test.ts that exercises the chosen surface.

## FIND-SPRINT-018-9
- **source:** SPRINT-018 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:159-161 + main/src/orchestrator/runEventBridge.ts:59-61
- **description:** Hook-vs-bridge return-type mismatch: RunExecutor.bridgeEvents() is declared `protected async bridgeEvents(runId, panelId): Promise<void>` — the integration override has no way to retain the `RunEventBridge { dispose(): void }` handle that runEventBridge.bridgeEvents() returns, so per-run cleanup on cancel/error/exit cannot work.
- **suggested_action:** Change `RunExecutor.bridgeEvents` to return `Promise<RunEventBridge | void>` (or `Promise<{ dispose(): void } | void>`), store the result in a private `Map<string, { dispose(): void }>` keyed by runId, and call `dispose()` from a new private `teardownRun(runId)` invoked from cancel() and from terminal onLifecycleTransition phases. Add a unit test in runExecutor.test.ts that verifies dispose() is called on cancel and on terminal transitions. Coordinate with the resolution of FIND-SPRINT-018-8 (cancel surface) — both findings point to the same gap: RunExecutor is currently stateless when it needs to hold per-run resources.
- **resolved_by:** 





runExecutor.ts:159-161:
  protected async bridgeEvents(_runId, _panelId): Promise<void> {
    // no-op until TASK-642
  }

runEventBridge.ts:59-61:
  export interface RunEventBridge { dispose(): void; }

runEventBridge.ts:8-10 explicitly documents the integration contract: "Hold the returned RunEventBridge until exit (TASK-644 will call bridge.dispose() in its status-transition handler) or cancel." But the integration task cannot hold the bridge in any clean way because the hook returns `Promise<void>`. The natural fix is per-run bookkeeping on RunExecutor (a `Map<runId, RunEventBridge>` field) plus a teardown call in cancel()/onLifecycleTransition(error|terminal). None of this scaffolding exists today.

Suspected tasks: TASK-640, TASK-642, TASK-644

## FIND-SPRINT-018-10
- **source:** SPRINT-018 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:66 + main/src/services/cyboflow/transitions.ts:43-221
- **description:** ExecutionPhase enum does not cover the lifecycle states that TASK-644 actually models. Today RunExecutor uses `type ExecutionPhase = spawning | spawned | error`, but the transition helpers operate on the workflow_runs status machine: starting → running → (awaiting_review ↔ running) → completed | failed | canceled.
- **suggested_action:** Drop the ExecutionPhase enum and replace `onLifecycleTransition(runId, phase)` with a more surgical pair of hooks that mirror the lifecycle actually used by the integration:
- **resolved_by:** 




The integration task that overrides `onLifecycleTransition(runId, phase)` will have to map between two unrelated vocabularies:
  - RunExecutors pre/post-spawn phases (spawning|spawned|error)
  - transitions.tss status machine (transitionToRunning fires on system/init event, not on spawn; transitionToCompleted fires on result event; transitionToFailed/Canceled fire on error/cancel paths)

Neither vocabulary subsumes the other:
  - spawned (after spawnCliProcess resolves) ≠ transitionToRunning (which fires on the first system/init event from the SDK iterator).
  - error (caught by execute()) maps to transitionToFailed only if the run wasnt already canceled; the executor cannot tell from the phase alone.
  - completed has no corresponding phase — the integration task would need to add it (and the SDKs result event is the trigger, not anything execute() observes synchronously).

Suspected tasks: TASK-640, TASK-644
  - protected onPreSpawn(runId): Promise<void>     // last call before spawnCliProcess
  - protected onPostSpawn(runId): Promise<void>    // after spawnCliProcess resolves
  - protected onExecuteError(runId, err): Promise<void>
The orchestrator/services/cyboflow boundary then routes each hook to the right transitions.ts helper (e.g. onPreSpawn → no-op today, transitionToRunning fires from a SDK event listener elsewhere; onExecuteError → transitionToFailed). Alternatively, if the goal is a single hook, widen the enum to pre_spawn|post_spawn|sdk_initialized|completed|failed|canceled and document which trigger fires each.
Decide before wiring TASK-644s transition helpers into the executor — otherwise the integration task will silently invent its own coupling layer.

## FIND-SPRINT-018-11
- **source:** SPRINT-018 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/workflowPromptReader.ts:98-119 + main/src/orchestrator/workflowRegistry.ts:174-192
- **description:** Frontmatter parser duplication between workflowPromptReader.splitFrontmatter and WorkflowRegistry.parseFrontmatter. Both files implement the same flat key:value extractor with identical regex shapes:
- **suggested_action:** Promote a single helper `parseMarkdownFrontmatter(md): { frontmatter: Record<string,string>, body: string }` into `main/src/orchestrator/markdownFrontmatter.ts` (or `shared/utils/`). Have both workflowPromptReader.readWorkflowPrompt and WorkflowRegistry.parseFrontmatter (+ extractPermissionMode) call into it. Add 5-6 unit tests for the helper itself (LF/CRLF, quote stripping, multiline body containing `---`, empty body, missing frontmatter). Coordinate with TASK-641s plan note — the deferral was explicit, this finding makes the cleanup actionable.
- **resolved_by:** 


  - workflowPromptReader.ts:99: /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
  - workflowRegistry.ts:175: /^---\r?\n([\s\S]*?)\r?\n---/
  - Identical inner-line regex: /^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/
  - Identical quote-strip logic for surrounding single/double quotes.

workflowPromptReader.ts:92-96 explicitly acknowledges the duplication: "This mirrors the regex shape used by WorkflowRegistry.parseFrontmatter ... A shared parser was intentionally NOT extracted here — see the Hardest Decision section in the TASK-641 plan." The decision is recorded, but the cost is now real: any future frontmatter extension (e.g. array values, multi-line strings, comments) must be applied in both regexes and both quote-strip branches, or the two parsers diverge silently.

Subtle existing divergence: workflowPromptReader.ts also captures the body (consumes the trailing `\r?\n?` after the closing `---`), while workflowRegistry.parseFrontmatter does not. That difference is necessary because the reader returns body, but it means the two regexes are NOT byte-identical and reviewers cannot grep-equivalence them.

Suspected tasks: TASK-641

## FIND-SPRINT-018-12
- **source:** SPRINT-018 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts:278,389,482,544 + main/src/orchestrator/__tests__/runLauncher.test.ts:206,292,400,545,631,739
- **description:** Test-helper duplication: the literal SQL `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot) VALUES (?, ?, ?, queued, default)` appears verbatim 9 times across runExecutor.test.ts (4×) and runLauncher.test.ts (5×). A 10th near-duplicate with a different column set (`policy_json` instead of `permission_mode_snapshot`) lives in runLifecycle.test.ts:60-63 (seedRun helper), and an 11th sibling exists in cancelAndRestart.test.ts:77 — neither shares structure with the others.
- **suggested_action:** Extract a `seedWorkflowRun(db, { id, workflowId, projectId, status, permissionModeSnapshot?, policyJson? })` helper into `main/src/database/__test_fixtures__/seed.ts` (or `main/src/orchestrator/__test_fixtures__/seed.ts`). Migrate all 9+ inline inserts to use it. Pair with a `seedWorkflow(db, {...})` helper if it does not exist already — runLifecycle.test.ts:49-56 has a local one that should be hoisted. Drop the duplicate `createTestDb()` helpers (4 copies between the test files) in favor of a shared `makeTestDb()` from the same fixture module.
- **resolved_by:** 


The sprint added 4 new test files; each rolled its own inline insert. Future schema changes to `workflow_runs` (e.g. adding a NOT NULL column without default) will require 9+ edits before the test suite goes green — exactly the failure mode the per-task reviewer cannot catch because each plan only sees one file.

Suspected tasks: TASK-640, TASK-644

## FIND-SPRINT-018-13
- **source:** SPRINT-018 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:121 + main/src/orchestrator/runEventBridge.ts:158,171,188 + main/src/orchestrator/permissionModeMapper.ts:72 + main/src/orchestrator/trpc/routers/runs.ts:116
- **description:** Log-prefix convention drift across the four new helpers. Three different naming styles are now in use, all introduced this sprint:
  - PascalCase / class label:  [RunExecutor], [RunLauncher] (matches the legacy [ClaudeCodeManager] convention)
  - camelCase / module label:  [runEventBridge], [permissionModeMapper]
  - action verb / handler label: [cancel], [cancelAndRestart]

A secondary inconsistency: runLauncher.ts:152 logs `err.stack ?? err.message` for executor failures, while runEventBridge.ts, permissionModeMapper.ts, and runs.ts:cancelHandler all log only `err.message`. Stack-trace loss in the bridge / cancel paths is a real (low) diagnostic gap.

Suspected tasks: TASK-640, TASK-642, TASK-643, TASK-644
- **suggested_action:** Standardize on one convention. PascalCase class label (e.g. [RunEventBridge], [PermissionModeMapper], [Cancel]) is the path of least change since it matches the existing [ClaudeCodeManager], [RunLauncher], [RunExecutor], [cancelAndRestart-handler] pattern more uniformly when capitalised. Update the four call sites: runEventBridge.ts:158,171,188 → [RunEventBridge]; permissionModeMapper.ts:72 → [PermissionModeMapper]; runs.ts:116 → [Cancel]. Also widen runEventBridge.ts and runs.ts:cancelHandler error fields to `err.stack ?? err.message` (matching runLauncher.ts:152) for parity. Add a one-line entry to docs/CODE-PATTERNS.md if a canonical prefix convention does not already exist.
- **resolved_by:** 
