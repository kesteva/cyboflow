---
id: TASK-664
idea: IDEA-018
status: in-flight
created: "2026-05-19T00:00:00Z"
files_owned:
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/index.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/eventRouter.ts
acceptance_criteria:
  - criterion: "BridgeEventsOptions exposes a `skipPersistence?: boolean` field documented as 'when true, the bridge does NOT construct an EventRouter or RawEventsSink; only the renderer-IPC publish path and onFirstMessage are active'"
    verification: "grep -n 'skipPersistence' main/src/orchestrator/runEventBridge.ts returns at least 1 match inside the BridgeEventsOptions interface declaration"
  - criterion: "When `skipPersistence: true`, the bridge does NOT call `new EventRouter()`, `new RawEventsSink(...)`, or `sink.attachToRouter(...)` — verified by a code-path that does not touch `opts.db` and by a unit test that passes a non-functional db stub"
    verification: "Read main/src/orchestrator/runEventBridge.ts lines 116-145 — when `skipPersistence === true`, the router/sink construction block is guarded; a new unit test 'skipPersistence: true skips router/sink construction' in runEventBridge.test.ts exits 0"
  - criterion: "RunExecutor's default bridgeEvents() override (runExecutor.ts:317-331) passes `skipPersistence: true` when the spawner source is a ClaudeCodeManager"
    verification: "grep -n 'skipPersistence: true' main/src/orchestrator/runExecutor.ts returns at least 1 match inside the bridgeEvents() override"
  - criterion: "A new integration test in runEventBridge.test.ts ('dual-pipeline single-INSERT guarantee') asserts: emit one output event on the source; the bridge with `skipPersistence: true` produces 0 raw_events rows from its own sink path; the publisher receives 1 envelope; onFirstMessage fires once"
    verification: "grep -n 'dual-pipeline single-INSERT' main/src/orchestrator/__tests__/runEventBridge.test.ts returns at least 1 match; pnpm --filter main test -- runEventBridge exits 0"
  - criterion: "When `skipPersistence` is absent or false, the bridge's pre-existing behaviour is unchanged — all 14 existing test cases in runEventBridge.test.ts continue to pass without modification"
    verification: git diff main/src/orchestrator/__tests__/runEventBridge.test.ts shows no edits to the 14 pre-existing `it(...)` blocks (additions only); pnpm --filter main test -- runEventBridge exits 0
  - criterion: "RunExecutor's integration test from TASK-663 (panelId/runId alignment) produces exactly 1 raw_events row, not 2 — verifying that even with both pipelines wired in production, no duplicate INSERT occurs"
    verification: "pnpm --filter main test -- runExecutor exits 0 with the panelId/runId-alignment test asserting `countRows(db, runId) === 1`"
  - criterion: pnpm --filter main typecheck and pnpm --filter main test both exit 0
    verification: pnpm --filter main typecheck exits 0; pnpm --filter main test exits 0
depends_on:
  - TASK-663
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: The 14 sibling tests in runEventBridge.test.ts all rely on the bridge constructing its own router/sink. Adding `skipPersistence` is a behaviour fork that must (a) preserve every existing path and (b) add new coverage for the skip path. The dual-pipeline duplicate-INSERT class is exactly the failure mode that FIND-SPRINT-021-5 surfaced — explicit single-INSERT assertion is required.
  targets:
    - behavior: "BridgeEventsOptions.skipPersistence=true: bridge attaches listener and publishes envelopes but constructs no EventRouter, no RawEventsSink, and never calls db.prepare(...) — verified with a stub db whose `prepare` method throws"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: unit
    - behavior: "BridgeEventsOptions.skipPersistence=true: onFirstMessage still fires correctly on the first JSON output event"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: unit
    - behavior: "Dual-pipeline single-INSERT guarantee: when the source emits one event and the source's own RawEventsSink would insert one row, the bridge with skipPersistence=true produces 0 additional rows — net 1, not 2"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: RunExecutor wires bridgeEvents with skipPersistence=true so the production pipeline (ClaudeCodeManager.runSdkQuery → EventRouter → RawEventsSink) is the single persistence path
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
---
# Resolve dual raw_events persistence pipelines (must ship alongside TASK-663)

## Objective

Two independent pipelines currently INSERT into `raw_events`. (1) `ClaudeCodeManager.runSdkQuery` constructs an `EventRouter` + `RawEventsSink` per panel at `main/src/services/panels/claude/claudeCodeManager.ts:247-255` and calls `router.emitForRun(runId, event)` for every SDK event at line 341. (2) `RunEventBridge` constructs its own `EventRouter` + `RawEventsSink` per run at `main/src/orchestrator/runEventBridge.ts:127-128, 137` and routes the same events through its own listener. Today this is latent because TASK-663's panelId mismatch prevents the bridge from ever receiving an event; the moment TASK-663 lands, every SDK event will INSERT twice (`rawEventsSink.ts:50` is a plain INSERT with no conflict guard). Add a `skipPersistence` flag to `BridgeEventsOptions` so `RunExecutor` can wire the bridge for renderer-IPC + lifecycle routing only, while `ClaudeCodeManager` retains exclusive ownership of `raw_events` persistence.

## Implementation Steps

1. **Edit `main/src/orchestrator/runEventBridge.ts` — extend `BridgeEventsOptions`** with `skipPersistence?: boolean` immediately after the `narrowing?` field. Keep `db: Database.Database` required for back-compat (only the runtime usage is conditional).
2. **Edit `main/src/orchestrator/runEventBridge.ts` lines 116-145** — guard router/sink construction so it is skipped when `opts.skipPersistence === true`. Keep `narrowing` unconditional (always needed for the publish envelope). Preserve `opts.router` / `opts.sink` overrides for tests.
3. **Edit `main/src/orchestrator/runEventBridge.ts` lines 174-184** — guard `router.emitForRun(...)` behind `if (router)` so it is skipped when null.
4. **Edit `main/src/orchestrator/runEventBridge.ts` lines 225-236** — guard `sink.dispose(...)` behind `if (sink)` in the disposer.
5. **Edit `main/src/orchestrator/runExecutor.ts` lines 317-331** — pass `skipPersistence: true` in the default `bridgeEvents()` override and document why (`ClaudeCodeManager.runSdkQuery` owns the per-run EventRouter+RawEventsSink pipeline; without this flag every SDK event would INSERT twice — FIND-SPRINT-021-5).
6. **`main/src/index.ts` — read-only verification.** Confirm no in-line `bridgeEvents` call exists at the construction site; bridging is dispatched through the executor's override.
7. **Add unit tests in `main/src/orchestrator/__tests__/runEventBridge.test.ts`** — new `describe('skipPersistence', ...)` block:
   - (a) `skipPersistence: true` skips router/sink construction (pass a stub db whose `prepare` throws).
   - (b) `skipPersistence: true` still fires `onFirstMessage` exactly once.
   - (c) `skipPersistence: true` produces zero rows in a real DB.
   - (d) `skipPersistence: false`/absent preserves legacy behaviour (5 INSERTs, 5 publishes).
   - (e) Dispose with `skipPersistence: true` is idempotent.
8. **Add the dual-pipeline integration test** in the same describe block — name: `'dual-pipeline single-INSERT guarantee — bridge with skipPersistence does not double-INSERT alongside CCM-owned sink'`. Construct a real db, real EventEmitter source, real `EventRouter` + `RawEventsSink` (simulating CCM's pipeline). Attach the bridge with `skipPersistence: true`. Emit one `'output'` event AND call `ccmRouter.emitForRun(runId, narrowedEvent)` once. Assert `countRows(db, runId) === 1` and `publish` called once.
9. **Update the TASK-663 integration test** in `runExecutor.test.ts` so `countRows === 1` (tighten from `>= 1`). Cross-task interlock: TASK-664 enforces single-INSERT against TASK-663's bridge wiring.
10. **Pre-flight grep** — `grep -rn 'new RawEventsSink' main/src/ --include='*.ts'` should return only `runEventBridge.ts` (guarded), `claudeCodeManager.ts:251` (canonical production sink), and test files.
11. **Run** `pnpm --filter main test` and `pnpm --filter main typecheck`. Both must exit 0.

## Acceptance Criteria

See frontmatter. Critical pair: (a) the new `dual-pipeline single-INSERT guarantee` test (catches FIND-SPRINT-021-5 if it ever resurfaces), (b) the unchanged-existing-tests guarantee (proves the default-behaviour fork is opt-in only).

## Test Strategy

- **Unit:** five cases covering construction-time skip, callback dispatch, zero-row guarantee, default-false behaviour, dispose idempotency. The stub-db `prepare`-throws pattern is the cleanest way to prove the bridge never reaches the DB.
- **Integration:** new dual-pipeline test simulates the production wiring where ClaudeCodeManager owns the sink path. Constructing an `EventRouter` + `RawEventsSink` and calling `emitForRun` manually is a faithful reproduction of `runSdkQuery`'s pipeline.
- **Cross-task interlock:** the runExecutor integration test from TASK-663 must assert `countRows === 1`. That assertion would fail if TASK-664 weren't applied (it would be 2). The two tasks must ship together.

## Hardest Decision

**Option B (`skipPersistence` flag) vs Option A (remove the CCM-internal pipeline).** Option A would break Crystal-baseline panel sessions (legacy `startPanel`/`continuePanel` paths) whose only persistence is that internal pipeline. The flag preserves the legacy path while giving new orchestrator runs a single-source-of-persistence path. The cost is a permanent dual-mode in `bridgeEvents` — acceptable given the legacy surface that `@cyboflow-hidden` discipline preserves.

## Rejected Alternatives

- **Option A: delete the EventRouter + RawEventsSink construction inside `ClaudeCodeManager.runSdkQuery`.** Rejected — breaks Crystal-baseline panel sessions.
- **Option C: add an UPSERT / `INSERT OR IGNORE` guard in `rawEventsSink.ts:50`.** Rejected — addresses the symptom not the cause; schema lacks a suitable unique key.
- **Option D: gate the CCM pipeline behind a constructor flag.** Rejected — `ClaudeCodeManager` is constructed once and shared between panel and workflow-run callers; would force splitting it into two instances.

## Lowest Confidence Area

Whether keeping `db: Database.Database` required (not optional) in `BridgeEventsOptions` when `skipPersistence: true` is the right type shape. Required-only minimises type churn but doesn't signal at the type level that `db` is unused. A follow-up could narrow once the flag is established.
