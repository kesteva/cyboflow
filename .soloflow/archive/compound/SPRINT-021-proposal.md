---
sprints: [SPRINT-021]
span_label: SPRINT-021
created: 2026-05-19T00:00:00.000Z
counters_start:
  ideas: 17
summary:
  cleanups: 5
  backlog_tasks: 2
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-021

## A. Clean-up items (execute now)

### A1. Fix stale docstrings in markdownFrontmatter.ts and workflowRegistry.ts after TASK-652 extraction
- **Summary:** Two docstrings reference deleted/moved code introduced by the TASK-652 extraction refactor and should be updated to match the current call graph.
- **Source-Sprint:** SPRINT-021
- **Rationale:** The stale references will mislead future contributors reading the code. `markdownFrontmatter.ts:6` still names `WorkflowRegistry.parseFrontmatter` (deleted by TASK-652); `workflowRegistry.ts:10-12` says the parser is inline (it now lives in `markdownFrontmatter.ts`). Behavior and tests are correct — this is pure doc-drift.
- **Blast radius:** `main/src/orchestrator/markdownFrontmatter.ts` (line 6), `main/src/orchestrator/workflowRegistry.ts` (lines 10-12). Risk: trivial.
- **Source:** FIND-SPRINT-021-2 (TASK-652 code-reviewer)
- **Proposed change:**
  ```diff
  // main/src/orchestrator/markdownFrontmatter.ts:6
  - * Shared by workflowPromptReader.readWorkflowPrompt and WorkflowRegistry.parseFrontmatter
  + * Shared by workflowPromptReader.readWorkflowPrompt and WorkflowRegistry.extractPermissionMode
  
  // main/src/orchestrator/workflowRegistry.ts:10-12
  - * the inline parser intentionally avoids js-yaml
  + * the parser lives in markdownFrontmatter.ts and intentionally avoids js-yaml
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `main/src/orchestrator/markdownFrontmatter.ts:5-6` ("Shared by ... WorkflowRegistry.parseFrontmatter") and `workflowRegistry.ts:9-11` ("the inline parser intentionally avoids js-yaml") while the registry now imports `parseMarkdownFrontmatter` from `./markdownFrontmatter` at line 14 — both docstrings actively misdirect readers and the fix is 2 isolated comment edits.

### A2. Fix stale StreamEventPublisher JSDoc in runLauncher.ts pointing at the wrong source file
- **Summary:** A JSDoc comment in `runLauncher.ts` claims the concrete `StreamEventPublisher` implementation lives in `main/src/ipc/cyboflow.ts`, but after TASK-660 it actually lives in `main/src/index.ts`.
- **Source-Sprint:** SPRINT-021
- **Rationale:** The comment actively points a reader to the wrong file. The move happened in TASK-660 (commit `596948b`) when `cyboflowPublisher` became an inline in `initializeServices`; `cyboflow.ts` is now a thin getter.
- **Blast radius:** `main/src/orchestrator/runLauncher.ts` (lines 55-65, specifically 58-60). Risk: trivial.
- **Source:** FIND-SPRINT-021-8 (SPRINT-021 sprint-code-reviewer); TASK-660-done.md confirms the move.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/runLauncher.ts:58-60
  - * The concrete implementation lives in main/src/ipc/cyboflow.ts, which is the only
  - * place that calls win.webContents.send for cyboflow stream events.
  + * The concrete implementation lives in main/src/index.ts (initializeServices), which is
  + * the only place that calls win.webContents.send for cyboflow stream events.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `runLauncher.ts:58-59` claims the implementation lives in `main/src/ipc/cyboflow.ts`, but `main/src/index.ts:564-572` is the actual `cyboflowPublisher` site (verified by grep: only `index.ts` lines 282/333/379/416/447/572 call `webContents.send` and 572 is the cyboflow stream channel) — comment is wrong, fix is one line.

### A3. Fix runEventBridge JSDoc header whose integration contract is violated by the panelId=`run-${runId}` convention
- **Summary:** `runEventBridge.ts:5-10` documents `options.panelId === runId` as the required pre-condition, but TASK-661/662 wired `panelId = "run-${runId}"`, leaving a directly contradictory comment at the integration entry point.
- **Source-Sprint:** SPRINT-021
- **Rationale:** This comment will actively mislead whoever diagnoses the FIND-SPRINT-021-4 bug. Whichever alignment decision is made when B1 is executed (panelId === runId OR explicit boundary translation), the docblock must reflect the chosen convention. This cleanup item clears the worst-case confusion: update the header now to document the current actual behavior (panelId is `run-${runId}`) and flag that it is a known mismatch under active remediation.
- **Blast radius:** `main/src/orchestrator/runEventBridge.ts` (lines 5-10). Risk: trivial.
- **Source:** FIND-SPRINT-021-9 (SPRINT-021 sprint-code-reviewer); FIND-SPRINT-021-4 identifies the root cause.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/runEventBridge.ts:5-10
  - * After ClaudeCodeManager.spawnCliProcess(options) succeeds with options.panelId === runId,
  - * call bridgeEvents({...}) once.
  + * After ClaudeCodeManager.spawnCliProcess(options) succeeds, call bridgeEvents({...}) once.
  + * NOTE: current wiring passes options.panelId = `run-${runId}` (runExecutor.ts:181).
  + * The bridge filter uses runId directly, so the filter never matches.
  + * See FIND-SPRINT-021-4 — the panelId/runId alignment is tracked as a bug and
  + * will be resolved in the backlog task that fixes it. Update this comment when that lands.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `runEventBridge.ts:5-7` documents `options.panelId === runId` as the contract while `runExecutor.ts:181` passes `panelId = run-${runId}` and the bridge filter at line 153 keys on raw `runId` — the comment is the surface symptom of FIND-SPRINT-021-4 (a high-sev bug) and updating it now to flag the active mismatch is a near-zero-cost fix that prevents a reader from being misled.
- **Counterfactual:** If B1 is going to be executed in the same sprint as this fix lands, prefer to just update the comment once when the underlying bug fix lands (skip A3) — but doing A3 first costs almost nothing and de-risks a slow B1.

### A4. Move teardownRun(runId) after onLifecycleTransition in cancel() to match execute() ordering
- **Summary:** In `RunExecutor.cancel()`, `teardownRun` is called before firing the `canceled` lifecycle transition, deleting the pending-state maps that the transition handler could legitimately need — fix the ordering to match the `execute()` pattern.
- **Source-Sprint:** SPRINT-021
- **Rationale:** The `execute()` path calls teardown in the `finally` block only after all transitions have fired, so `onLifecycleTransition('failed'/'completed')` can read `pendingFailedMessage`, `pendingFailedFromStatus`, and `pendingSystemPromptAppend`. The `cancel()` path reverses this: `teardownRun` fires first, then `onLifecycleTransition('canceled')`. Today it works by accident (the default `canceled` phase does not read those maps), but any enhancement that stores cancel-reason metadata in those maps will break silently. The fix is a 2-line reorder.
- **Blast radius:** `main/src/orchestrator/runExecutor.ts` (the three lines in `cancel()` that call abort, teardownRun, and onLifecycleTransition). Risk: low — the 3-arg ordering change is mechanical and matches existing execute() pattern; existing unit tests cover the cancel path.
- **Source:** FIND-SPRINT-021-6 (SPRINT-021 sprint-code-reviewer); TASK-650 introduced `cancel()`/`teardownRun`, TASK-662 added the pending* maps.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/runExecutor.ts cancel() method
  - await this.spawner.abort(panelId);
  - this.teardownRun(runId);
  - await this.onLifecycleTransition(runId, 'canceled');
  + await this.spawner.abort(panelId);
  + await this.onLifecycleTransition(runId, 'canceled');
  + this.teardownRun(runId);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `runExecutor.ts:251-253` (abort → teardownRun → transition) versus the execute() pattern at `:215-227` (transition → teardownRun in finally); the 2-line reorder restores symmetry and removes a latent footgun for any future canceled-phase handler that reads `pendingFailedMessage`/`pendingSystemPromptAppend` — change is mechanical with near-zero cost.

### A5. Replace unsafe double-cast ClaudeSpawnerLike adapter in index.ts with direct method binding
- **Summary:** The `ClaudeSpawnerLike` adapter in `main/src/index.ts` uses `as unknown as { spawnCliProcess(...) }` double-casts that bypass TypeScript's structural checking — replace with `.bind()` calls against the public `AbstractCliManager` contract.
- **Source-Sprint:** SPRINT-021
- **Rationale:** CLAUDE.md bans `any` (ESLint `@typescript-eslint/no-explicit-any` is set to `error`); `as unknown as SomeShape` is the moral equivalent for these two methods. If `ClaudeCodeManager.spawnCliProcess` gains a new required field, TypeScript will not flag the adapter call site, resulting in a silent runtime failure. `AbstractCliManager` already publicly exposes `spawnCliProcess` and `killProcess`, so direct binding is safe and eliminates the cast entirely. The code-reviewer noted this in TASK-661's round 1 review and accepted it as an "integration shim" — but FIND-SPRINT-021-7 escalates it to a named bug, making a clean fix appropriate.
- **Blast radius:** `main/src/index.ts` (the `spawnerAdapter` object literal, ~4 lines). Risk: low — binding to the concrete public method surface rather than casting through unknown; same runtime behavior, stronger static check.
- **Source:** FIND-SPRINT-021-7 (SPRINT-021 sprint-code-reviewer); TASK-661 introduced the adapter.
- **Proposed change:**
  ```diff
  // main/src/index.ts — spawnerAdapter construction
  - const spawnerAdapter: ClaudeSpawnerLike = {
  -   spawnCliProcess: (options) =>
  -     (defaultCliManager as unknown as { spawnCliProcess(opts: typeof options): Promise<void> })
  -       .spawnCliProcess(options),
  -   abort: (panelId) =>
  -     (defaultCliManager as unknown as { killProcess(id: string): Promise<void> })
  -       .killProcess(panelId),
  - };
  + const spawnerAdapter: ClaudeSpawnerLike = {
  +   spawnCliProcess: defaultCliManager.spawnCliProcess.bind(defaultCliManager),
  +   abort: defaultCliManager.killProcess.bind(defaultCliManager),
  + };
  ```
  If a structural mismatch surfaces after removing the cast, resolve it by aligning `ClaudeSpawnerLike`'s interface fields with the public `ClaudeSpawnOptions` superset rather than re-introducing the cast.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `AbstractCliManager.ts:130` (`async spawnCliProcess`) and `:224` (`async killProcess`) are public methods on the abstract base that `ClaudeCodeManager` extends, so `.bind(defaultCliManager)` is type-safe and removes the `as unknown as { ... }` double-cast at `index.ts:611-612` — codebase forbids `any` (CLAUDE.md), this is the equivalent escape hatch for those two methods, and the fix is ~4 lines.

---

*Note: FIND-SPRINT-021-3 (promptReader optional vs required) was considered for bucket A but requires updating two test call sites in `runExecutor.test.ts` (lines 166 and 908) in addition to changing the field signature. The executor intentionally made it optional as a backward-compat hedge, and the production call site at `index.ts:610` passes the concrete reader. The fix is straightforward but touches test semantics (the :908 test exercises a failure path whose failure source changes from sentinel error to `WorkflowPromptReadError`). Promoting to B1-adjacent — see B2 below.*

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix panelId/runId mismatch in RunExecutor that prevents runs from ever reaching `running` status and breaks ApprovalRouter
- **Summary:** `RunExecutor` spawns with `panelId = "run-${runId}"` but the bridge filter and ApprovalRouter both key on `runId`, so `onFirstMessage` never fires (runs stuck in `starting` forever) and every tool-approval UPDATE hits zero rows.
- **Source-Sprint:** SPRINT-021
- **Source:** FIND-SPRINT-021-4 (SPRINT-021 sprint-code-reviewer); TASK-650 introduced the synthetic panelId, TASK-661 wired CCM as the event source, TASK-662 wired `onFirstMessage` → `running` transition that depends on bridge delivering events.
- **Problem:** `runExecutor.ts:181` constructs `panelId = "run-${runId}"`. `runEventBridge.ts:153` filters events by `p.panelId !== runId` — this condition is always true when panelId has the `run-` prefix, so no event passes the bridge filter, `onFirstMessage` never fires, and `workflow_runs.status` is stuck at `starting`. Separately, `claudeCodeManager.ts:401-402, 506` routes `makePreToolUseHook(panelId)` through `ApprovalRouter.requestApproval`, which does `UPDATE workflow_runs SET ... WHERE id = ?` with the `run-${runId}` value — that matches zero rows in `workflow_runs` (whose PK is `runId`), throws `RunNotRunningError`, and denies every tool call with `Internal approval-router error`. This is a production-breaking cross-task contract leak.
- **Proposed direction:** Option A (recommended): change `RunExecutor.execute()` at `runExecutor.ts:181` to pass `panelId = runId` directly, making `panelId === runId === sessionId` the invariant throughout. Verify `ClaudeSpawnerLike.spawnCliProcess` accepts the plain runId as panelId (no `run-` prefix expectation exists in `ClaudeCodeManager.runSdkQuery`). Update `runEventBridge.ts:5-10` docblock (see A3). Add an integration test that wires a real CCM with `permission_mode=default`, fires a synthetic tool-call event, and asserts (a) the bridge delivers the event so `workflow_runs.status` flips to `running`, and (b) the approval UPDATE lands on the correct `workflow_runs` row. Option B (if panelId must differ from runId for another reason): add explicit boundary translation at both `bridgeEvents()` call sites and the CCM pre-tool hook wiring, with a comment explaining the indirection. Option A is simpler and eliminates the impedance mismatch entirely.
- **Scope:** medium — touches `runExecutor.ts`, `runEventBridge.ts` docblock, `claudeCodeManager.ts` (verify panelId contract), `index.ts` (wiring site), and requires a new integration test.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed bug — `runExecutor.ts:181` sets `panelId = run-${runId}` while `runEventBridge.ts:153` filters on `p.panelId !== runId` (always true with the `run-` prefix), and `claudeCodeManager.ts:401-506` routes pre-tool-use approval through `ApprovalRouter.requestApproval(panelId)` which does `UPDATE workflow_runs WHERE id = ?` against `runId`-PK rows — production-breaking and properly scoped as a backlog task with two clean directions.

### B2. Resolve dual raw_events persistence pipelines (RunEventBridge + ClaudeCodeManager) before FIND-021-4 fix ships
- **Summary:** Once the panelId/runId mismatch (B1) is fixed, every SDK event will be INSERTed into `raw_events` twice — once by ClaudeCodeManager's own EventRouter+RawEventsSink pipeline and once by the bridge's parallel pipeline — because `RawEventsSink.insert` has no UNIQUE guard.
- **Source-Sprint:** SPRINT-021
- **Source:** FIND-SPRINT-021-5 (SPRINT-021 sprint-code-reviewer); TASK-650 introduced `RunEventBridge` with its own router/sink, TASK-661 wired CCM as the bridge source (CCM already has its own router/sink at `claudeCodeManager.ts:247-255, 341`), TASK-662 kept both active.
- **Problem:** `runEventBridge.ts:122-123, 132` constructs `new EventRouter` + `new RawEventsSink` per `runId` and attaches them to the bridge listener. `claudeCodeManager.ts:247-255, 341-344, 366` also constructs `EventRouter` + `RawEventsSink` per `panelId` inside `runSdkQuery`. When both pipelines are active against the same underlying EventEmitter, every SDK event triggers two INSERT paths. `rawEventsSink.ts:50` is a plain `INSERT INTO raw_events` with no conflict guard. This is latent today only because B1's bug prevents the bridge from receiving any events at all — fixing B1 without fixing B2 will cause immediate duplicate data.
- **Proposed direction:** Option B from the finding (recommended): pass a `skipPersistence?: boolean` flag (or omit `db`) on the bridge options when it is wired from `RunExecutor` against a CCM source that already has its own sink. Specifically: when `RunExecutor.execute()` calls `bridgeEvents({..., db})` in `index.ts`, pass `db: undefined` (or `skipPersistence: true`) to instruct the bridge to set up its `onFirstMessage` routing only, without constructing its own `EventRouter`/`RawEventsSink`. The CCM pipeline already handles persistence for active sessions. Guard the bridge's sink construction behind the flag. Option A (remove CCM's internal pipeline) risks regressing legacy panel sessions that have no bridge — those sessions depend on the CCM-internal pipeline for all `raw_events` writes. This task must be planned and executed alongside or immediately before B1 to avoid introducing duplicate rows in production.
- **Scope:** medium — touches `runEventBridge.ts` (bridge options + conditional sink), `runExecutor.ts` (call-site wiring), `index.ts` (construction site), and requires unit tests covering the `skipPersistence` path and the legacy path.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified both pipelines coexist — `runEventBridge.ts:122-123, 132` constructs `EventRouter` + `RawEventsSink` and attaches via `sink.attachToRouter(router, runId)`, while `claudeCodeManager.ts:247-251` also constructs `EventRouter` + `RawEventsSink` per panelId, and `rawEventsSink.ts` performs a plain `INSERT` with no UNIQUE guard — duplicates only currently hidden by B1's filter mismatch, so this must ship alongside B1.

---

*Note on FIND-SPRINT-021-3 (promptReader optional vs required):* The verifier flagged the `promptReader?` optional field as a scope deviation from AC2. The executor's mitigation (sentinel error at runtime + pinning test + concrete reader at the production call site) means there is no user-visible breakage. Making it required is a 3-file change (field signature in `runExecutor.ts:103`, two constructor call sites in `runExecutor.test.ts:166` and `:908`, with a stub reader injected). This is a small clean-up rather than a backlog feature, but the test at `:908` deliberately exercises the failure path and its assertion would need updating. Because the change is safe and bounded but has a non-trivial test-semantics note, it is listed here as an explicit call-out for the executor: make `promptReader` required, add `makeStubReader({})` to the two 3-arg constructor calls in the test file, and verify the `:908` test's assertion still covers its intended contract (the assertion can remain broad if it covers the executor failure log entry regardless of failure source).

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document makeLoggerLike as the canonical Logger-to-LoggerLike adapter in CODE-PATTERNS.md
- **Summary:** Add a CODE-PATTERNS.md entry for `makeLoggerLike` so executors do not re-invent the adapter when bridging Logger to LoggerLike-typed boundaries, repeating the drift that FIND-017-5 was created to eliminate.
- **Source-Sprint:** SPRINT-021
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after "### `main/src/utils/logger`" block (i.e. append a new `### main/src/orchestrator/loggerAdapter` entry under "Shared Utilities", immediately after the existing `main/src/utils/logger` entry).
- **Status:** ready
- **source_item:** C1
- **Rationale:** TASK-651 had `code_review_rounds: 1` because the executor hand-rolled a `Logger → LoggerLike` adapter instead of calling the existing `makeLoggerLike` utility — the same drift FIND-017-5 was created to eliminate. A short pointer in CODE-PATTERNS.md alongside the other `main/src/utils/*` entries would have prevented the rework. Diff rewritten to match the surrounding ~5-line Shared Utilities style and to fix the import path (proposal had `@/utils/loggerLike`; actual path is `main/src/orchestrator/loggerAdapter`).
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@
   ### `main/src/utils/logger`

   - **Path:** `main/src/utils/logger.ts`
   - **Use it for:** Structured file logging in the main process. Rolling 10 MB logs, max 5 files.
     Captures original `console.*` methods before any override to avoid recursion.
   - **Canonical example:** `main/src/services/sessionManager.ts`

  +### `main/src/orchestrator/loggerAdapter`
  +
  +- **Path:** `main/src/orchestrator/loggerAdapter.ts`
  +- **Use it for:** Bridging a `Logger` instance to any boundary typed as `LoggerLike`
  +  (the structural interface in `main/src/orchestrator/types.ts`). Call
  +  `makeLoggerLike(logger)` — also handles the `logger === undefined` case by returning
  +  a console-based shim, so callers never need a null check. Companion `makeDatabaseLike`
  +  builds the matching `DatabaseLike` adapter.
  +- **Why single-source:** Hand-rolled inline adapters (`{ info: m => logger.info(m), ... }`)
  +  silently drift when `Logger` or `LoggerLike` gain methods — FIND-017-5 extracted this
  +  utility specifically to kill that drift surface, and TASK-651 re-introduced it before
  +  the code-reviewer caught the duplication. Do NOT inline.
  +- **Canonical example:** `main/src/services/panels/claude/claudeCodeManager.ts:503`;
  +  `main/src/index.ts:559` and `:717`.
  +
   ### `frontend/src/utils/api`
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Drift is recurrent — `loggerAdapter.ts` was extracted by FIND-017-5 and re-inlined again in TASK-651 (caught at code-review round 1); CODE-PATTERNS.md currently has zero references to `loggerAdapter`/`makeLoggerLike` (grep confirms), and the proposed entry slots cleanly into the existing Shared Utilities section right after the related `main/src/utils/logger` block, matching the surrounding style and citing real call sites at `claudeCodeManager.ts:503` and `index.ts:559/717`.



## Reconciled Findings (informational)

- FIND-SPRINT-021-1 — marked `status: resolved` in the findings file (resolved by TASK-662, which implemented the suggested `try/catch` → `onLifecycleTransition('failed')` fix). No triaging needed; confirmed skipped.

## Suppressed — SoloFlow Defects

_None identified. All C-items passed the self-defect check as genuine project conventions._
