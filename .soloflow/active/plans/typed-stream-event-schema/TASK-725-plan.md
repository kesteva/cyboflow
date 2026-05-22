---
id: TASK-725
idea: SPRINT-030
status: ready
created: 2026-05-21T00:00:00Z
files_owned:
  - shared/types/claudeStream.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
files_readonly:
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
  - main/src/services/streamParser/derivers.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/index.ts
  - .soloflow/active/findings/SPRINT-030-findings.md
acceptance_criteria:
  - criterion: "Producer-side fix (path (a) from FIND-SPRINT-030-8): `runLauncher.ts:146-150` emits `payload: { type: 'run_started', runId, worktreePath, branchName }` — the inner `type: 'run_started'` literal is added so the payload structurally satisfies the declared `RunStartedEvent` interface."
    verification: "`grep -nE \"payload: \\{ type: 'run_started'\" main/src/orchestrator/runLauncher.ts` returns 1 match in the `this.publisher?.publish(runId, { … })` call site (around line 146-150)."
  - criterion: "`StreamEventPublisher.publish` in `main/src/orchestrator/runLauncher.ts` accepts a tightened envelope where `payload` is the discriminated union over per-`type` payload shapes, not `unknown`. Concretely, the parameter type is updated to a new exported `StreamEnvelope` variant (e.g. `TypedStreamEnvelope` or the existing `StreamEnvelope` with `payload` widened from `unknown` to the discriminated payload union)."
    verification: "`grep -n 'payload: unknown' shared/types/claudeStream.ts main/src/orchestrator/runLauncher.ts main/src/orchestrator/runEventBridge.ts` returns 0 matches within the `StreamEnvelope` declaration or `StreamEventPublisher.publish` signature."
  - criterion: "TypeScript catches a regression at the publish site: if a future contributor swaps the `run_started` payload to omit `type`, `pnpm typecheck` exits non-0 with a structural assignability error pointing at `runLauncher.ts`."
    verification: "Manual verification documented in commit body — flip the producer to the pre-fix shape (`payload: { runId, worktreePath, branchName }` without `type`), run `pnpm typecheck`, observe non-0 exit naming `runLauncher.ts`, then revert."
  - criterion: "`pnpm typecheck` exits 0 end-to-end after the producer fix and signature tightening."
    verification: "Run `pnpm typecheck`; exit status 0."
  - criterion: "`pnpm --filter main test` exits 0 with `runLauncher.test.ts` updated to assert the new inner `type: 'run_started'` field on the payload alongside the existing `runId/worktreePath/branchName` checks."
    verification: "Run `pnpm --filter main test`; exit status 0. `grep -n \"payload\\.type\" main/src/orchestrator/__tests__/runLauncher.test.ts` returns at least 1 match inside the publisher-spy assertion block."
  - criterion: "`pnpm --filter frontend test` exits 0 — the renderer-side `RunStartedEventRow` (which reads `payload.runId` and `payload.branchName`) continues to work because the new producer payload is a superset of the old one."
    verification: "Run `pnpm --filter frontend test`; exit status 0."
depends_on: [TASK-724]
estimated_complexity: low
epic: typed-stream-event-schema
test_strategy:
  needed: true
  justification: "The publisher contract changes in two ways (producer payload shape + envelope signature tightening); both have existing tests that act as the regression gate but require an updated assertion to lock in the new inner `type` field. The renderer-side test file (`RunView.test.tsx`) already exercises the row component against a payload that includes `type: 'run_started'` (TASK-700 design), so no new renderer tests are added."
  targets:
    - behavior: "RunLauncher.launch emits a run_started envelope whose payload now carries the inner `type: 'run_started'` field, satisfying the declared RunStartedEvent contract."
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: integration
    - behavior: "publisher.publish accepts a typed envelope whose payload narrows by envelope `type` — the four call sites in the test file continue to compile against the tightened signature."
      test_file: "main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts"
      type: integration
---

# Resolve RunStartedEvent payload contract mismatch and tighten publisher signature

## Objective

`RunStartedEvent` in `shared/types/claudeStream.ts:265-270` declares `{ type: 'run_started'; runId; worktreePath; branchName }`, and the renderer-side discriminated `StreamEvent` union pins the `run_started` arm to `payload: RunStartedEvent`. The producer at `runLauncher.ts:146-150` emits `payload: { runId, worktreePath, branchName }` — the inner `type: 'run_started'` field is missing, silently violating the type contract because `StreamEventPublisher.publish` accepts `payload: unknown`. TASK-724 consolidated the envelope literal into `StreamEnvelope` but preserved `payload: unknown` to keep that diff surgical. This task resolves the contract mismatch (path (a) from FIND-SPRINT-030-8: make the producer match the declared shape) AND tightens `StreamEnvelope.payload` from `unknown` to the discriminated payload union so TypeScript catches future drift at the publish site. The renderer-side change-surface is zero because `RunStartedEvent` already declared the inner `type`, so the renderer was already typed to consume it — TASK-700 just got lucky that the missing field went unread.

## Implementation Steps

1. Choose path (a): add the inner `type: 'run_started'` field. Path (b) (drop `type` from `RunStartedEvent`) would force a renderer-side audit because `frontend/src/utils/cyboflowApi.ts:101` pins the arm to `payload: RunStartedEvent`, and a downstream contributor reading `RunStartedEvent` in isolation would expect every other variant in `ClaudeStreamEvent` (which all have an inner `type` field for the same reason) to lack one too. Path (a) is the minority change at one call site; path (b) is a many-file structural normalization. The orchestrator-synthetic `SessionInfoEvent` (lines 277-286) also carries an inner `type: 'session_info'`, so path (a) is consistent with the established convention.

2. Open `main/src/orchestrator/runLauncher.ts`. Edit the publisher call at lines 146-150 to add the inner discriminant:

   ```ts
   this.publisher?.publish(runId, {
     type: 'run_started',
     payload: { type: 'run_started', runId, worktreePath, branchName },
     timestamp: new Date().toISOString(),
   });
   ```

3. Tighten the envelope. Open `shared/types/claudeStream.ts`. Build a payload-side union that pairs each `StreamEventType` value with the corresponding payload shape:

   ```ts
   /**
    * Discriminated payload union for StreamEnvelope. Each arm pairs a StreamEventType
    * value with the corresponding payload shape. `unknown` is the catch-all for the
    * 'unknown' arm (deriveEventType emits 'unknown' when classification fails).
    *
    * Updated alongside StreamEventType — keep the two unions in sync.
    */
   export type StreamEnvelopePayload =
     | { type: 'system';            payload: SystemInitEvent | SystemApiRetryEvent | SystemCompactEvent | SystemCompactBoundaryEvent | SystemHookStartedEvent | SystemHookResponseEvent | SystemStatusEvent }
     | { type: 'assistant';         payload: AssistantEvent }
     | { type: 'user';              payload: UserEvent }
     | { type: 'result';            payload: ResultEvent }
     | { type: 'stream_event';      payload: StreamEvent }
     | { type: 'session_info';      payload: SessionInfoEvent }
     | { type: 'rate_limit_event'; payload: RateLimitEvent }
     | { type: 'run_started';       payload: RunStartedEvent }
     | { type: 'unknown';           payload: unknown };

   export type StreamEnvelope = StreamEnvelopePayload & { timestamp: string };
   ```

   This mirrors the renderer-side `StreamEvent` union in `frontend/src/utils/cyboflowApi.ts:93-102` (minus the `runId` field, which is on the envelope wrapper, not the inner payload). Replace the previous `StreamEnvelope` declaration TASK-724 added.

4. Open `main/src/orchestrator/runEventBridge.ts`. The local `const envelope: StreamEnvelope = { type: deriveEnvelopeType(typed) as StreamEventType, payload: typed, timestamp: ... }` at line 247 may now fail TypeScript because the cross-product of `StreamEventType` × `ClaudeStreamEvent` is not narrowed. Resolve by using a typed builder: cast `typed` to the appropriate per-`type` payload via a type predicate, OR keep the broad cast `as StreamEnvelope` at the construction site since `deriveEnvelopeType(typed)` is structurally tied to `typed`. Prefer the latter (one cast at the bridge boundary) — the construction-site cast is a single audited line.

5. Open `main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts`. The four sites that TASK-724 annotated as `StreamEnvelope` may now require per-test payload narrowing. The two `run_started` cases (lines 67, 115) need `payload: { type: 'run_started', runId, worktreePath, branchName } satisfies RunStartedEvent` to typecheck. The two `payload: {}` cases (lines 86, 100) test the publisher skipping send entirely when `getMainWindow` returns null or the window is destroyed — they never read payload contents. Replace `payload: {}` with a minimal valid `RunStartedEvent`-shaped object (`payload: { type: 'run_started', runId: 'x', worktreePath: '', branchName: '' }`) so the literal satisfies the tightened union; the test behavior is unchanged because the publish path short-circuits before payload is touched.

6. Open `main/src/orchestrator/__tests__/runLauncher.test.ts`. At line 585-587 (the publisher-spy assertion block), add a new assertion: `expect(firstCall[1].payload.type).toBe('run_started')`. This locks in the producer fix from step 2.

7. Run `pnpm typecheck` — exit 0.

8. Run the regression check described in AC#3: temporarily revert the inner `type` field at runLauncher.ts:146-150, run `pnpm typecheck`, confirm it now exits non-0 naming the `runLauncher.ts` site, then revert. Document the observed error message in the commit body.

9. Run `pnpm --filter main test` and `pnpm --filter frontend test`; both exit 0.

## Acceptance Criteria

- Producer payload includes `type: 'run_started'`.
- `StreamEnvelope` is tightened; no `payload: unknown` remains in the publish-site signature.
- TypeScript catches the regression class (verified manually per AC#3).
- All workspace tests pass.
- Renderer is untouched.

## Test Strategy

`runLauncher.test.ts` is the regression gate for the producer fix — it asserts the envelope shape via `publishSpy.mock.calls[0]`. The new `expect(firstCall[1].payload.type).toBe('run_started')` line locks in the producer contract. `cyboflow-stream-publisher.test.ts` is the contract gate for the publisher signature — its four sites must continue compiling against the tightened union. No new test files are introduced. The renderer-side `RunStartedEventRow` test at `frontend/src/components/cyboflow/__tests__/RunView.test.tsx:637` already asserts that `payload.runId.slice(0, 8)` renders correctly — that assertion holds because the new payload is a superset of the old one.

## Hardest Decision

The narrowing strategy at `runEventBridge.ts:247` (step 4). The bridge constructs the envelope from a `ClaudeStreamEvent` whose `type` field is structurally related to (but not the same as) the envelope `type` derived by `deriveEventType(typed)`. A fully type-safe construction would require either (a) a typed builder per `StreamEventType` (verbose, 9 arms), (b) a runtime narrowing function that returns the per-type payload union (`function narrowEnvelopePayload(typed: ClaudeStreamEvent): StreamEnvelopePayload`), or (c) a single cast at the boundary. Option (c) is chosen because the bridge is itself the source of truth for the `event_type` mapping — `deriveEventType(typed)` is the only function that produces both halves of the discriminated union from a single source, and TS cannot infer that without an explicit predicate. The cast is at a single audited line (`as StreamEnvelope`); the alternative is N predicates that duplicate `deriveEventType`'s logic.

## Rejected Alternatives

- **Path (b): drop `type` from `RunStartedEvent`**. Symmetric and one fewer field in the payload, but inconsistent with `SessionInfoEvent` (which keeps its inner `type`) and with every SDK wire variant. Would reconsider if a sweep landed normalizing all orchestrator-synthetic variants to no-inner-`type`.
- **Generic `StreamEnvelope<T extends StreamEventType>`**: shifts the discriminant to the type parameter. Rejected because the producer at `runEventBridge.ts:247` would need to invoke the constructor with a type parameter computed from `deriveEventType(typed)`, which TS cannot infer at the call site without the same `as` cast.
- **Leave `payload: unknown` and rely on a Zod validator at the publish boundary**: defers the cost from compile-time to runtime, adds a runtime allocation per event (115k/day projection from `006_cyboflow_schema.sql` index sizing), and doesn't catch the contract drift FIND-SPRINT-030-8 names. Would reconsider if a future cross-process boundary (web socket / IPC) needs runtime validation regardless.

## Lowest Confidence Area

Step 4: the runEventBridge envelope construction may surface unexpected TS errors when `typed` is the catch-all `UnknownStreamEvent` (whose discriminant is `kind: '__unknown__'`, not `type`). The `as StreamEnvelope` cast plus the `deriveEventType` mapping to the string `'unknown'` should land both halves of the discriminated union on the `{ type: 'unknown'; payload: unknown }` arm, which accepts anything. If TS rejects this construction despite the cast, fallback to splitting the envelope literal across two assignments: build a typed payload variant, then spread into the timestamped envelope. This is a known-narrow risk area that surfaces only if step 7 fails — the typecheck pass is the authoritative gate.