---
id: TASK-642
idea: IDEA-018
status: in-flight
created: "2026-05-18T20:30:00Z"
files_owned:
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
files_readonly:
  - main/src/orchestrator/runLauncher.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/index.ts
  - main/src/services/streamParser/types.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/types.ts
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/__tests__/rawEventsSink.test.ts
acceptance_criteria:
  - criterion: "main/src/orchestrator/runEventBridge.ts exports a `bridgeEvents(opts)` function with signature `{ runId, source, publisher, db, logger?, router?, sink? } -> { dispose: () => void }`"
    verification: "grep -n 'export function bridgeEvents' main/src/orchestrator/runEventBridge.ts returns one match; grep -n 'dispose' main/src/orchestrator/runEventBridge.ts shows the returned object exposes dispose"
  - criterion: "For each ClaudeCodeManager 'output' event whose `panelId === runId` and `type === 'json'`, the bridge narrows `data` via TypedEventNarrowing, INSERTs a raw_events row, then calls publisher.publish — in that synchronous order"
    verification: "grep -n 'narrow\\|emitForRun\\|publish' main/src/orchestrator/runEventBridge.ts shows narrow -> emitForRun (which triggers RawEventsSink INSERT) -> publish in the listener body; vitest run main/src/orchestrator/__tests__/runEventBridge.test.ts passes the happy-path test that asserts row-then-publish order"
  - criterion: "If the raw_events INSERT fails (sink fail-soft), publisher.publish still fires for that event and a single warn is logged"
    verification: "vitest run main/src/orchestrator/__tests__/runEventBridge.test.ts passes the 'INSERT failure does not block publish' case; grep -n 'logger?.warn\\|publish' main/src/orchestrator/runEventBridge.ts confirms publish runs after the sink hook regardless of failure"
  - criterion: "The bridge subscribes only to its own runId — 'output' events for other panelIds are ignored and produce zero rows / zero publish calls"
    verification: "vitest run main/src/orchestrator/__tests__/runEventBridge.test.ts passes the 'filters by panelId' case"
  - criterion: "Calling the returned dispose() removes the 'output' listener from the source EventEmitter AND disposes the RawEventsSink for this runId; subsequent emits produce no rows and no publish calls"
    verification: "vitest run main/src/orchestrator/__tests__/runEventBridge.test.ts passes the 'dispose stops the bridge' case; assert source.listenerCount('output') === 0 and zero new rows after dispose"
  - criterion: "Each call to publisher.publish receives a wrapped envelope `{ type: <ClaudeStreamEvent.type or 'unknown'>, payload: <full typed event>, timestamp: <ISO-8601> }`; UnknownStreamEvent (kind='__unknown__') maps to type='unknown'"
    verification: "vitest run main/src/orchestrator/__tests__/runEventBridge.test.ts passes the 'envelope shape' case asserting publisher receives system -> type:'system', unknown -> type:'unknown', and payload is the full narrowed event"
  - criterion: "The bridge does not modify runExecutor.ts, runLauncher.ts, or any file outside files_owned"
    verification: git diff --name-only after implementation lists exactly the two files in files_owned
depends_on:
  - TASK-640
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "This module is the load-bearing translation layer between SDK emission and renderer visibility. The same-step ordering invariant (INSERT then publish), the panelId filter, the dispose contract, and fail-soft semantics each have a documented failure mode if regressed — they must be tested. The sibling-test scan of main/src/orchestrator/__tests__/ found no existing test covering this surface; runEventBridge.test.ts is a new file."
  targets:
    - behavior: "happy path: 5 mixed-variant ClaudeStreamEvents emitted via the source EventEmitter (as 'output' payloads with type:'json') produce 5 raw_events rows AND 5 publisher.publish calls in event order"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: "ordering: for each event, the raw_events INSERT row exists BEFORE publisher.publish is observed (use a spy clock or call-order capture; assert sink.handleEvent / db row visible at the moment publish is invoked)"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: "fail-soft: when the underlying RawEventsSink INSERT throws, publish still fires for that event and a single warn is logged"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: "filter: an 'output' event for a different panelId is ignored — zero rows, zero publish calls"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: "non-json output: an 'output' event with type !== 'json' (e.g. type:'stdout' string) is ignored — zero rows, zero publish calls"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: "envelope: publisher.publish receives { type, payload, timestamp } where type is the narrowed ClaudeStreamEvent.type (or 'unknown'), payload is the full typed event, timestamp is ISO-8601"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: "narrowing: a malformed payload that fails the schema becomes an UnknownStreamEvent — one row inserted with event_type='unknown', one publish call with type='unknown'"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: "dispose: after dispose(), no further rows or publish calls occur for subsequent 'output' emits; source.listenerCount('output') returns to its baseline; dispose is idempotent"
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
---
# Pipe SDK message stream through StreamEventPublisher to the renderer

## Objective

Create a self-contained `runEventBridge` module that consumes `ClaudeCodeManager` 'output' events (filtered by a synthetic panelId === runId), narrows each SDK message to the typed `ClaudeStreamEvent` discriminated union, persists it to the `raw_events` audit log, and forwards it to the renderer via `StreamEventPublisher` — in that synchronous order. The module is the read-side load-bearing wire between the SDK's async iterator (driven by TASK-640's RunExecutor) and the renderer's `cyboflow:stream:<runId>` channel. This task owns ONLY the bridge module; TASK-640's RunExecutor will call `bridgeEvents(...)` exactly once after `spawnCliProcess` succeeds.

## Implementation Steps

1. **Create `main/src/orchestrator/runEventBridge.ts`** (new file). Define and export:

   ```ts
   import { EventEmitter } from 'node:events';
   import type Database from 'better-sqlite3';
   import { EventRouter, RawEventsSink, TypedEventNarrowing } from '../services/streamParser';
   import type { ClaudeStreamEvent } from '../../../shared/types/claudeStream';
   import type { StreamEventPublisher } from './runLauncher';
   import type { LoggerLike } from './types';

   export interface BridgeEventsOptions {
     runId: string;
     source: EventEmitter;
     publisher: StreamEventPublisher;
     db: Database.Database;
     logger?: LoggerLike;
     router?: EventRouter;
     sink?: RawEventsSink;
     narrowing?: TypedEventNarrowing;
   }

   export interface RunEventBridge {
     dispose(): void;
   }

   export function bridgeEvents(opts: BridgeEventsOptions): RunEventBridge { /* ... */ }
   ```

2. **Wire the listener.** Construct `narrowing`, `router`, `sink` (using the optional injection seams if provided). Call `sink.attachToRouter(router, opts.runId)`. Then attach `source.on('output', onOutput)` where `onOutput` filters by `panelId === runId` and `type === 'json'`, narrows the payload, calls `router.emitForRun(opts.runId, typed)` (which synchronously triggers the sink INSERT), then wraps into the publisher envelope `{ type, payload, timestamp }` and calls `publisher.publish(opts.runId, envelope)`. Each side is wrapped in try/catch with `logger?.warn`. Unknown variants map to `type: 'unknown'` via `'kind' in typed && typed.kind === '__unknown__'`.

3. **Build the dispose function.** Idempotent (`disposed` flag); calls `source.off('output', onOutput)` plus `sink.dispose(opts.runId)`; if the router was constructed internally, also clear it.

4. **Document the integration contract for TASK-640** in the file-level JSDoc:
   ```
   /**
    * After ClaudeCodeManager.spawnCliProcess(options) succeeds with options.panelId === runId,
    * call `bridgeEvents({ runId, source: claudeCodeManager, publisher, db, logger })` once.
    * Hold the returned RunEventBridge until 'exit' (TASK-644 will call bridge.dispose() in its
    * status-transition handler) or cancel.
    */
   ```

5. **Create `main/src/orchestrator/__tests__/runEventBridge.test.ts`**. Mirror `main/src/services/streamParser/__tests__/rawEventsSink.test.ts`: reuse the `RAW_EVENTS_DDL`, `makeDb()`, `countRows()`, `selectRows()` helpers (copy verbatim). Build a stub `source = new EventEmitter()` and emit 'output' payloads of shape `{ panelId, sessionId, type: 'json', data, timestamp }`. Cover the 8 cases listed in `test_strategy.targets`.

6. **Verify the test suite locally:**
   ```bash
   pnpm --filter @cyboflow/main exec vitest run main/src/orchestrator/__tests__/runEventBridge.test.ts
   pnpm --filter @cyboflow/main typecheck
   ```
   Zero `any`; use `unknown` + narrowing for the 'output' payload.

## Acceptance Criteria

Restated from frontmatter — each criterion is independently verifiable by a single grep or test invocation. The bridge is correct iff: module signature matches, per-event sequence is narrow → INSERT → publish, INSERT failure does not block publish, foreign panelIds are filtered, dispose tears down both subscriptions, publisher envelope matches `{ type, payload, timestamp }`, and no file outside files_owned changes.

## Test Strategy

See `test_strategy.targets` in the frontmatter. Eight cases in one new test file. Reuses fixture event shapes and the in-memory DB pattern from `rawEventsSink.test.ts`.

## Hardest Decision

Whether to expose an injection seam for `EventRouter` and `RawEventsSink` (chosen: yes) vs. wiring them as private internals. The same-step ordering invariant is the load-bearing contract; the simplest way to test fail-soft is to let the test inject a sink whose `insertStmt.run` is monkey-patched. Hiding it would force heavy mocking. The injection seam is optional in the public type.

## Rejected Alternatives

- **Bypass EventRouter and call `sink.handleEvent` directly** — `handleEvent` is private; coupling would break.
- **Two separate worker queues for INSERT and publish (open_question 4 candidate b)** — risks reordering.
- **Batch INSERTs (open_question 4 candidate c)** — latency on the renderer outweighs throughput.
- **Subscribe to 'output' inside RunExecutor** — entangles two responsibilities.

## Lowest Confidence Area

The exact 'output' payload shape from ClaudeCodeManager. Current emit at `claudeCodeManager.ts:338-344` is `{ panelId, sessionId, type: 'json', data, timestamp: Date }`. The bridge listener assumes this shape verbatim — if TASK-640's RunExecutor re-emits 'output' under a different shape, the filter would mismatch. Mitigation: TASK-640's slot uses a synthetic panelId === runId and reuses ClaudeCodeManager unmodified. Also: ClaudeCodeManager emits some non-SDK 'output' events (session_info descriptor at 252-267; resume-error system/error at 218-230); TypedEventNarrowing falls these through to UnknownStreamEvent — acceptable.
