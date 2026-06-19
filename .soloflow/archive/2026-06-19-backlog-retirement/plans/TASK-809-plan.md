---
id: TASK-809
idea: IDEA-013
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-013
epic: dual-substrate-claude
files_owned:
  - main/src/services/substrateDispatchFacade.ts
  - main/src/services/__tests__/substrateDispatchFacade.test.ts
  - main/src/index.ts
files_readonly:
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/claude/interactiveClaudeManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/cliManagerFactory.ts
  - main/src/services/cliToolRegistry.ts
  - main/src/orchestrator/workflowRegistry.ts
  - shared/types/workflows.ts
  - shared/types/substrate.ts
acceptance_criteria:
  - criterion: "A run whose workflow_runs.substrate === 'interactive' dispatches spawnCliProcess to InteractiveClaudeManager; substrate === 'sdk' (and any legacy/default row) dispatches to ClaudeCodeManager; abort dispatches to the manager that owns the run's panel (panelId→manager tracking)."
    verification: "substrateDispatchFacade.test.ts: with a fake WorkflowRegistryLike returning {substrate:'interactive'} and two spy managers, asserts the interactive spy's spawnCliProcess is called (sdk spy NOT called); the inverse for 'sdk' and for a row with substrate undefined; after a spawn, abort(panelId) hits only the manager that spawned that panel."
  - criterion: "The substrate-aware adapter resolves run.substrate per-run via the WorkflowRegistry.getRunById(runId) backed resolver — NOT a constructor-fixed manager — and the resolution lives entirely outside runExecutor.ts (standalone-typecheck invariant: runExecutor.ts imports no services/* module)."
    verification: "grep -n 'getRunById' main/src/services/substrateDispatchFacade.ts returns >=1 match; grep -rnE \"from '(\\.\\./)*services/\" main/src/orchestrator/runExecutor.ts returns 0 matches (no services import added by this task)."
  - criterion: "A single facade EventEmitter (SubstrateDispatchFacade) subscribes to BOTH managers' 'output' and 'exit' events and re-emits them on itself, so a one-time-bound RunExecutor `source` (runExecutor.ts:167) sees events from whichever substrate ran — without swapping the source per run."
    verification: "grep -nE \"\\.on\\('output'|\\.on\\('exit'\" main/src/services/substrateDispatchFacade.ts shows subscriptions to both managers; grep -nE \"emit\\('output'|emit\\('exit'\" main/src/services/substrateDispatchFacade.ts shows re-emission; substrateDispatchFacade.test.ts asserts an 'output' emitted by the interactive manager is re-emitted by the facade with the identical payload object."
  - criterion: "An interactive-path 'output' event reaches runEventBridge through the facade and the published cyboflow:stream:<runId> envelope is byte-identical in SHAPE across substrates (same {type, payload, timestamp} structure), and the panelId===runId===sessionId invariant holds on the forwarded payload."
    verification: "substrateDispatchFacade.test.ts feeds the SAME golden {panelId,sessionId,type:'json',data,timestamp} fixture through the facade from each manager into bridgeEvents() (skipPersistence:true) with a spy publisher, and asserts the publisher receives an envelope of identical shape for both substrates and that payload.panelId === runId === sessionId."
  - criterion: "Both substrates drive the SAME lifecycle transitions through RunExecutor (pre_spawn→running, drained→awaiting_review, failed) — the SDK (default) path is regression-clean and existing runExecutor tests stay green. To avoid cross-epic test-file collision, the new RunExecutor-over-facade integration case lives in the TASK-809-owned substrateDispatchFacade.test.ts; runExecutor.test.ts is read-only here (owned by IDEA-029 TASK-800) and runs UNCHANGED for regression."
    verification: "substrateDispatchFacade.test.ts adds a case that wires RunExecutor with the facade as both `source` and the substrate-aware spawner, runs a clean drain on the interactive branch, and asserts restAwaitingReview fired exactly once; main/src/orchestrator/__tests__/runExecutor.test.ts runs unchanged under pnpm test:unit with all pre-existing cases green (git diff --stat shows 0 changed lines in runExecutor.test.ts)."
  - criterion: "setOrchSocketPath is called on BOTH managers at boot once TASK-799's socket path is available (the facade does not own the socket path; index.ts threads it onto each manager that exposes setOrchSocketPath)."
    verification: "grep -nE 'setOrchSocketPath' main/src/index.ts shows the call applied to defaultCliManager AND interactiveCliManager (or via a helper that iterates both); pnpm typecheck passes (each manager exposing setOrchSocketPath)."
  - criterion: "index.ts initializeServices constructs BOTH managers — createManager('claude', …) AND createManager('claude-interactive', …) — and passes the facade (not defaultCliManager) as RunExecutor's `source`, and the substrate-aware adapter (not the single-manager spawnerAdapter) as RunExecutor's spawner."
    verification: "grep -nE \"createManager\\('claude-interactive'\" main/src/index.ts returns >=1 match; grep -n 'SubstrateDispatchFacade' main/src/index.ts shows the facade constructed and passed as the RunExecutor `source` argument (position 8) in place of defaultCliManager."
  - criterion: "The index.ts adapter/facade change imports NO services/* module into runExecutor.ts and does not edit runExecutor.ts (read-only for this task; its single-source contract is satisfied by the facade)."
    verification: "git diff --stat main/src/orchestrator/runExecutor.ts shows 0 changed lines after the task; grep -rnE \"from '(\\.\\./)*services/\" main/src/orchestrator/runExecutor.ts returns 0 matches."
  - criterion: "Any injected logger? on the facade is passed, not omitted (CLAUDE.md optional-logger rule) — diagnostics on subscribe/teardown/dispatch are gated on a real logger supplied from index.ts."
    verification: "grep -n 'logger' main/src/services/substrateDispatchFacade.ts shows logger.* calls; grep -n 'SubstrateDispatchFacade' main/src/index.ts shows a logger argument passed to the constructor."
  - criterion: "No use of the `any` type."
    verification: "grep -nE ':\\s*any(\\b|\\[)|<any>|as any' main/src/services/substrateDispatchFacade.ts main/src/services/__tests__/substrateDispatchFacade.test.ts returns 0 matches"
  - criterion: "All unit tests pass and the code type-checks and lints clean."
    verification: "pnpm test:unit exits 0 (substrateDispatchFacade.test.ts owns the new cases; runExecutor.test.ts runs unchanged); pnpm typecheck && pnpm lint exit 0"
depends_on: [TASK-806, TASK-808, TASK-799]
estimated_complexity: medium
test_strategy:
  needed: true
  justification: "New routing/forwarding component with branchy behavior (per-run substrate resolution, dual-manager event fan-in, panel-owning abort) — every behavior is unit-testable with two spy AbstractCliManager-shaped EventEmitters, a fake WorkflowRegistryLike, and the existing orchestrator DB/logger fixtures. The cross-substrate envelope-shape parity and the SDK regression-cleanliness must be proven by test, not by inspection."
  targets:
    - behavior: "substrate-aware dispatch routes spawnCliProcess to the manager matching run.substrate ('interactive'→InteractiveClaudeManager, 'sdk'/default→ClaudeCodeManager) and abort to the panel-owning manager."
      test_file: "main/src/services/__tests__/substrateDispatchFacade.test.ts"
      type: unit
    - behavior: "The facade re-emits 'output'/'exit' from BOTH managers keyed by panelId; an interactive-path 'output' reaches bridgeEvents() and the published envelope shape matches the SDK path (shared golden fixture); panelId===runId===sessionId holds."
      test_file: "main/src/services/__tests__/substrateDispatchFacade.test.ts"
      type: integration
    - behavior: "RunExecutor wired with the facade as `source` and the substrate-aware spawner drives identical lifecycle transitions for an interactive-branch clean drain; the SDK path stays regression-clean (existing runExecutor.test.ts cases run unchanged and green)."
      test_file: "main/src/services/__tests__/substrateDispatchFacade.test.ts"
      type: integration
---

# Substrate-aware spawner dispatch at the index.ts boot seam via a facade EventEmitter source

## Objective

Route each workflow run to the correct CLI substrate at the `index.ts` boot seam, and guarantee the structured Claude panel lights up on BOTH substrates by feeding `RunExecutor` a single facade `source` that fans-in events from both managers. `index.ts initializeServices` constructs BOTH managers — `defaultCliManager` via `createManager('claude', …)` (already present at index.ts:493) AND `interactiveCliManager` via `createManager('claude-interactive', …)` (the second built-in tool registered by TASK-806/S1) — and replaces the single-manager `spawnerAdapter` (index.ts:576-579, currently bound to `defaultCliManager`) with a substrate-aware `ClaudeSpawnerLike` adapter that resolves `run.substrate` per run (via `WorkflowRegistry.getRunById(runId)`, workflowRegistry.ts:342) and dispatches `spawnCliProcess`/`abort` to the matching manager. Because `RunExecutor` binds a SINGLE `source` `EventEmitter` at construction (runExecutor.ts:167) for its lifetime — it cannot be swapped per run — this task introduces a `SubstrateDispatchFacade` (a small `EventEmitter`) at the boot seam that subscribes to BOTH managers' `'output'`/`'exit'` events and re-emits them on itself; that facade is passed as `RunExecutor`'s `source` (index.ts:630, in place of `defaultCliManager`). Both substrates emit the identical normalized `{panelId,sessionId,type:'json',data,timestamp}` shape (the SDK manager at claudeCodeManager.ts:383-389; the interactive manager byte-identical per TASK-808/S3), so `runEventBridge.ts` needs ZERO edits and the `cyboflow:stream:<runId>` envelope is shape-identical across substrates.

DEPENDS-ON-MERGE: `main/src/index.ts` is OWNED by IDEA-029 TASK-799 (which currently holds the `orchSocketProvider`/`bridgeScriptResolver` sentinels at index.ts:542-565 and the `OrchestratorHealth` sentinel at 659-662). This task is `depends_on: [TASK-799, …]` and MUST branch off the MERGED TASK-799 tree — it edits `index.ts` strictly AFTER TASK-799 merges, NEVER co-editing it concurrently. It also relies on TASK-799 having resolved a real orchestrator socket path at boot, which this task threads onto BOTH managers via `setOrchSocketPath`. This task adds NO duplicate of any IDEA-029 code (no socket server, no `setOrchSocketPath` reimplementation — it only calls the existing seam). It likewise consumes TASK-806's substrate column + factory registration and TASK-808's `InteractiveClaudeManager` body without re-implementing either.

## Implementation Steps

1. **Create `main/src/services/substrateDispatchFacade.ts`** (new, production). It lives under `services/` (NOT `orchestrator/`) so it may import the concrete `AbstractCliManager` type — keeping all per-run resolution out of `orchestrator/runExecutor.ts` (the standalone-typecheck invariant: `runExecutor.ts` imports nothing from `services/*`). Import: `EventEmitter` from `node:events`; type `AbstractCliManager` from `./panels/cli/AbstractCliManager`; the narrow `ClaudeSpawnerLike` + `ClaudeSpawnerOptions` + `WorkflowRegistryLike` types from `../orchestrator/runExecutor`; `CliSubstrate` + `DEFAULT_SUBSTRATE` from `../../../shared/types/substrate` (added by TASK-806); and `LoggerLike` from `../orchestrator/types`. No `any`.

2. **Define `class SubstrateDispatchFacade extends EventEmitter implements ClaudeSpawnerLike`.** Constructor `(private readonly sdkManager: AbstractCliManager, private readonly interactiveManager: AbstractCliManager, private readonly registry: WorkflowRegistryLike, private readonly logger: LoggerLike)`. In the constructor, subscribe to BOTH managers and re-emit (fan-in):
   - `sdkManager.on('output', (p) => this.emit('output', p))` and `sdkManager.on('exit', (p) => this.emit('exit', p))`.
   - `interactiveManager.on('output', (p) => this.emit('output', p))` and `interactiveManager.on('exit', (p) => this.emit('exit', p))`.
   The re-emit forwards the payload object UNCHANGED (preserving `panelId===runId===sessionId` and `type:'json'`), so `runEventBridge.ts`'s `onOutput` filter (`p.panelId !== runId || p.type !== 'json'`, runEventBridge.ts:207) behaves identically regardless of which manager produced the event. Note `EventEmitter`'s default 10-listener cap is not hit (one listener per event per manager); no `setMaxListeners` needed.

3. **Implement per-run substrate resolution + dispatch.** Add a `private resolveManager(runId: string): AbstractCliManager`: `const run = this.registry.getRunById(runId); const substrate: CliSubstrate = run?.substrate ?? DEFAULT_SUBSTRATE; return substrate === 'interactive' ? this.interactiveManager : this.sdkManager;`. The `?? DEFAULT_SUBSTRATE` floor makes every legacy/`null` row resolve to `'sdk'` (byte-identical SDK path). Implement `ClaudeSpawnerLike`:
   - `async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<void>` — `const mgr = this.resolveManager(options.panelId)` (panelId===runId, so resolve by it); record `this.panelOwners.set(options.panelId, mgr)` so `abort` later finds the same manager even if the row mutates; `this.logger.info('[SubstrateDispatchFacade] dispatch spawn', { panelId, substrate });` then `await mgr.spawnCliProcess(options)`. (`AbstractCliManager.spawnCliProcess` accepts the `ClaudeSpawnOptions` superset of `ClaudeSpawnerOptions`, same as today's `defaultCliManager.spawnCliProcess.bind` at index.ts:577.)
   - `async abort(panelId: string): Promise<void>` — look up `this.panelOwners.get(panelId)`; if found, call its `.killProcess(panelId)` (the SDK abort+cleanup, matching index.ts:578 `defaultCliManager.killProcess.bind`); if not tracked, fall back to `resolveManager(panelId).killProcess(panelId)` and `logger.warn` the untracked panel. Hold `private readonly panelOwners = new Map<string, AbstractCliManager>()`.
   Note `AbstractCliManager.killProcess` is the public abort entry (AbstractCliManager.ts:224); the existing adapter aliases it to `abort`, so the facade preserves that contract.

4. **Add a `dispose()`** that calls `this.sdkManager.off('output', …)`/`off('exit', …)` (and the same for the interactive manager) using stored bound handlers, and `this.removeAllListeners()` — so a re-init does not leak listeners. Store the four handler references as private fields when subscribing in step 2.

5. **Edit `main/src/index.ts` (branch off MERGED TASK-799).** Near the existing `defaultCliManager` creation (index.ts:493-501), add a sibling:
   ```
   const interactiveCliManager = await cliManagerFactory.createManager('claude-interactive', {
     sessionManager, logger, configManager,
     additionalOptions: { db: databaseService.getDb() },
     skipValidation: true,
   });
   ```
   (TASK-806 registers the `'claude-interactive'` built-in tool in `cliManagerFactory`/`cliToolRegistry`.)

6. **Replace the single-manager `spawnerAdapter` (index.ts:576-579) with the facade.** Construct `const substrateFacade = new SubstrateDispatchFacade(defaultCliManager, interactiveCliManager, workflowRegistry, cyboflowLogger);` AFTER `workflowRegistry` is built (index.ts:527). Pass `substrateFacade` as RunExecutor's `spawner` argument (position 1) AND as the `source` argument (position 8, replacing `defaultCliManager` at index.ts:630). The facade IS the `ClaudeSpawnerLike` and IS the `EventEmitter` source — one object satisfies both seams, which is exactly why the single-source constraint is honored. Remove the now-dead `spawnerAdapter` object literal (or keep `defaultCliManager` only for the `taskQueue`/`AppServices.claudeCodeManager` backward-compat references at index.ts:515,671 — those stay pointed at `defaultCliManager`).

7. **Thread the orchestrator socket path onto BOTH managers at boot.** Wherever TASK-799's merged code resolves the real socket path and calls `setOrchSocketPath` on `defaultCliManager`, call it on `interactiveCliManager` too (e.g. `for (const m of [defaultCliManager, interactiveCliManager]) m.setOrchSocketPath(socketPath);`). `setOrchSocketPath` is currently declared on `ClaudeCodeManager` (claudeCodeManager.ts:105) — TASK-808 adds the equivalent to `InteractiveClaudeManager`. If TASK-799/TASK-808's merged tree promotes `setOrchSocketPath` onto `AbstractCliManager`, prefer the iterate-both form; otherwise call each manager's own method (both expose it post-TASK-808). Do NOT introduce a new socket-path resolver — consume TASK-799's.

8. **Create `main/src/services/__tests__/substrateDispatchFacade.test.ts`** (new). Use vitest. Build two spy managers as `EventEmitter` subclasses (or plain `EventEmitter` instances) exposing `spawnCliProcess: vi.fn()` and `killProcess: vi.fn()` cast to the narrow shape — mirror the `makeSpawner()` pattern in `runExecutor.test.ts` but keep the `EventEmitter` base so `.on`/`.emit` work. Build a fake `WorkflowRegistryLike` whose `getRunById` returns a `WorkflowRunRow` with a controllable `substrate`. Reuse `makeSpyLogger` from `../../orchestrator/__test_fixtures__/loggerLikeSpy`. Cover:
   - **dispatch**: `getRunById → {substrate:'interactive'}` ⇒ `spawnCliProcess` lands on the interactive spy only; `'sdk'` and `undefined` ⇒ on the sdk spy only.
   - **abort by owner**: spawn a panel on the interactive spy, then `abort(panelId)` calls the interactive spy's `killProcess`, not the sdk spy's.
   - **fan-in re-emit**: attach a `vi.fn()` to `facade.on('output', …)`; have the interactive spy `emit('output', goldenPayload)`; assert the facade listener received the identical payload object; same for `'exit'`.
   - **cross-substrate envelope parity**: feed the SAME golden `{panelId:runId,sessionId:runId,type:'json',data:<fixture>,timestamp}` through `bridgeEvents({ runId, source: facade, publisher: spyPublisher, skipPersistence:true, logger })` (import `bridgeEvents` from `../../orchestrator/runEventBridge`), emit it once from the sdk manager and once from the interactive manager, and assert `spyPublisher.publish` received an envelope of identical SHAPE (`{type, payload, timestamp}`) both times and `payload.panelId === runId`.
   - **no-any** grep gate passes for the test file.

9. **Add the RunExecutor-over-facade integration case to `substrateDispatchFacade.test.ts`** (owned — NOT runExecutor.test.ts, which IDEA-029 TASK-800 owns and TASK-809 does not depend on; co-editing it would risk a cross-epic collision). Construct a `SubstrateDispatchFacade` over two spy managers, wire `new RunExecutor(facade, registry, logger, promptReader, lifecycleTransitions, …, facade, stepEmitter)` (facade as both spawner and `source`), set the run row's `substrate:'interactive'`, run `execute(runId)` through a clean `spawnCliProcess` resolve, and assert `lifecycleTransitions.restAwaitingReview` fired once (drained→awaiting_review) and the interactive spy's `spawnCliProcess` was called. (Reuse the `makeSpawner()`/fixture patterns from `runExecutor.test.ts` by import/reference — do not edit that file.)

10. Run `pnpm test:unit` (exit 0; if `better-sqlite3` NODE_MODULE_VERSION error, `pnpm rebuild better-sqlite3` first per CLAUDE.md, then re-run). Then `pnpm typecheck && pnpm lint` (exit 0). Confirm `git diff --stat main/src/orchestrator/runExecutor.ts main/src/orchestrator/__tests__/runExecutor.test.ts` shows 0 lines (both read-only this task).

## Acceptance Criteria notes

- **Why a facade and not source-swapping:** `RunExecutor`'s `source` is a constructor arg bound once (runExecutor.ts:167) and `bridgeEvents()` registers its `onOutput`/`exit` listeners against THAT object for each run's lifetime (runEventBridge.ts:276). There is no per-run source hook. The facade is the only place that can multiplex two managers onto one stable `EventEmitter` without touching `runExecutor.ts`. The facade re-emits the payload object by reference (no re-wrapping), so the `panelId===runId===sessionId` invariant and the `type:'json'` filter survive unchanged.
- **skipPersistence stays true:** each manager owns its own per-run `EventRouter`+`RawEventsSink` (the SDK manager at claudeCodeManager.ts:377; the interactive manager per TASK-808), so the bridge runs with `skipPersistence:true` (no double-INSERT, FIND-SPRINT-021-5). The facade changes NOTHING about persistence ownership — it only forwards `'output'`/`'exit'`.
- **Substrate resolution floor:** `run?.substrate ?? DEFAULT_SUBSTRATE` (== `'sdk'`) means every existing/legacy `workflow_runs` row and any pre-TASK-806 read resolves to the SDK manager, so the default path is byte-identical. `WorkflowRunRow.substrate` is added by TASK-806 (read-only here); do not add the column or type field in this task.
- **abort/panel-owner map:** resolving `abort` via `panelOwners` (recorded at spawn) rather than re-reading the row guards against a row whose substrate could be misread after the fact — the manager that actually spawned the panel is the one that must kill it. This mirrors the run-canceled teardown contract S5 relies on (the interactive manager must be the one to deny+close in-flight approval sockets).
- **No `any` in the test:** the spy managers are `EventEmitter` instances with `vi.fn()` methods; cast each to the narrow interface via `as unknown as AbstractCliManager` ONLY at the construction boundary if strictly needed, or prefer a typed minimal `EventEmitter & Pick<AbstractCliManager,'spawnCliProcess'|'killProcess'>` shape so the grep AC (`as any`) stays clean. The double-cast `as unknown as` is permitted; bare `as any` is not.
- **setOrchSocketPath on both:** the AC verifies the call lands on BOTH managers. If the merged TASK-799/TASK-808 tree has promoted `setOrchSocketPath` to `AbstractCliManager`, the iterate-both loop is cleanest; if not, both managers still expose their own method, so two explicit calls satisfy the AC.

## Out of Scope

- **Editing `index.ts` concurrently with TASK-799** — `index.ts` is OWNED by TASK-799 (IDEA-029); this task branches off the MERGED TASK-799 tree and edits `index.ts` only after that merge. It adds NO duplicate of TASK-799's socket-path resolution, `orchSocketProvider`, `bridgeScriptResolver`, or `OrchestratorHealth` wiring — it consumes them.
- **Implementing `setOrchSocketPath`, the socket server, or the orchestrator socket path resolution** — those are IDEA-029 (TASK-798/TASK-799), consumed via depends-on-MERGE. This task only CALLS `setOrchSocketPath` on the second manager.
- **The `InteractiveClaudeManager` body, PTY spawn, transcript tail, normalizer, or turn-end completion** — owned by TASK-808 (S3) and TASK-807 (S2). This task treats `InteractiveClaudeManager` as an already-built `AbstractCliManager` sibling that emits the identical `'output'`/`'exit'` shape; it asserts cross-substrate envelope-shape parity but does not build the interactive emission.
- **The `'claude-interactive'` factory/registry registration, the `substrate` column/migration, `shared/types/substrate.ts`, or `substrateResolver.ts`** — owned by TASK-806 (S1). This task consumes the registered tool id and the `WorkflowRunRow.substrate` field read-only.
- **Editing `runExecutor.ts` OR `runExecutor.test.ts`** — both read-only; the single-`source` contract is satisfied by the facade. `runExecutor.test.ts` is OWNED by IDEA-029 TASK-800 and this task does not depend on TASK-800, so the RunExecutor-over-facade integration case lives in the TASK-809-owned `substrateDispatchFacade.test.ts` instead — avoiding a cross-epic test-file collision. `runExecutor.test.ts` must run unchanged for regression.
- **Shell-hook permission gating, step tracking on the interactive substrate, and the renderer substrate picker** — TASK-810/S5, TASK-811/S6, TASK-812/S7 respectively. This task ships only the boot-seam dispatch + facade source.
- **Any `runEventBridge.ts`, `streamParser`, or `WORKFLOW_DEFINITIONS` change** — both substrates emit the identical normalized shape, so zero bridge/frontend edits are needed.
