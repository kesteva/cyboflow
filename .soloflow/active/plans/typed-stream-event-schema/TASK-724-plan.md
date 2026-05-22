---
id: TASK-724
idea: SPRINT-030
status: ready
created: 2026-05-21T00:00:00Z
files_owned:
  - shared/types/claudeStream.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts
files_readonly:
  - frontend/src/utils/cyboflowApi.ts
  - main/src/services/streamParser/derivers.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/index.ts
  - .soloflow/active/findings/SPRINT-030-findings.md
acceptance_criteria:
  - criterion: "`StreamEnvelope` is exported as a named type from `shared/types/claudeStream.ts` with the exact shape `{ type: StreamEventType; payload: unknown; timestamp: string }` (the `payload: unknown` field is preserved verbatim in this task — TASK-725 tightens it)."
    verification: "`grep -n 'export interface StreamEnvelope\\|export type StreamEnvelope' shared/types/claudeStream.ts` returns at least one match; the matched declaration carries `type: StreamEventType`, `payload: unknown`, and `timestamp: string` fields."
  - criterion: "`StreamEventPublisher.publish` in `main/src/orchestrator/runLauncher.ts` references the shared `StreamEnvelope` type instead of an inline literal."
    verification: "`grep -n 'StreamEnvelope' main/src/orchestrator/runLauncher.ts` returns at least one match; `grep -n 'publish(runId: string, event: { type: StreamEventType' main/src/orchestrator/runLauncher.ts` returns 0 matches."
  - criterion: "The unexported local `StreamEnvelope` interface in `main/src/orchestrator/runEventBridge.ts:119-123` is replaced by an import from `shared/types/claudeStream.ts`."
    verification: "`grep -n 'interface StreamEnvelope' main/src/orchestrator/runEventBridge.ts` returns 0 matches; the file imports `StreamEnvelope` from the shared module."
  - criterion: "The three inline event-literal annotations in `main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts` (lines 67, 86, 100) reference the shared `StreamEnvelope` type. The fourth site at line 115 also uses the shared type — eliminating the cast-vs-annotation inconsistency flagged in FIND-SPRINT-030-10."
    verification: "`grep -rn '{ type: StreamEventType; payload: unknown; timestamp: string }' main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts` returns 0 matches; `grep -n 'StreamEnvelope' main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts` returns at least 4 matches (one per test case)."
  - criterion: "`pnpm typecheck` exits 0 end-to-end."
    verification: "Run `pnpm typecheck`; exit status 0."
  - criterion: "`pnpm --filter main test` exits 0 with no new failures in `cyboflow-stream-publisher.test.ts`, `runLauncher.test.ts`, or `runEventBridge.test.ts`."
    verification: "Run `pnpm --filter main test`; exit status 0."
depends_on: []
estimated_complexity: low
epic: typed-stream-event-schema
test_strategy:
  needed: true
  justification: "`cyboflow-stream-publisher.test.ts` is the canonical contract test for the publisher type signature; it must be updated in lockstep with the type rename. The pre-existing `runLauncher.test.ts` and `runEventBridge.test.ts` exercise the same publisher path and act as the behavioral lock for non-test consumers. No new test cases are introduced — the existing ones simply consume the shared name."
  targets:
    - behavior: "publisher.publish is called with a StreamEnvelope-shaped argument and forwards to win.webContents.send unchanged."
      test_file: "main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts"
      type: integration
    - behavior: "RunLauncher.launch emits a run_started envelope via the publisher with all required envelope fields."
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: integration
    - behavior: "runEventBridge forwards typed events through the publisher with deriveEventType(typed) as the envelope type."
      test_file: "main/src/orchestrator/__tests__/runEventBridge.test.ts"
      type: integration
---

# Export shared StreamEnvelope type and consolidate the four duplicate literals

## Objective

The structural literal `{ type: StreamEventType; payload: unknown; timestamp: string }` is declared in five places after SPRINT-030: the `StreamEventPublisher.publish` parameter at `runLauncher.ts:66`, an unexported local `interface StreamEnvelope` at `runEventBridge.ts:119`, and three test literal annotations at `cyboflow-stream-publisher.test.ts:67,86,100`. FIND-SPRINT-030-7 flags this as a structural-duplication risk; FIND-SPRINT-030-10 separately flags the inconsistency between the three annotation sites and a fourth cast-based site at `cyboflow-stream-publisher.test.ts:115`. Promote the existing `runEventBridge.ts` `StreamEnvelope` interface to `shared/types/claudeStream.ts` and rewire all four production-side sites plus all four test sites to import the single name. Payload remains `unknown` in this task — TASK-725 owns the payload-tightening pass and depends on this consolidation having landed first.

## Implementation Steps

1. Open `shared/types/claudeStream.ts`. After the `StreamEventType` declaration (around line 430-439), add an exported interface:

   ```ts
   /**
    * IPC envelope wrapping every ClaudeStreamEvent emitted from the main process to
    * the renderer's `cyboflow:stream:<runId>` channel.
    *
    * Discriminate on `type`. The renderer-side `StreamEvent` discriminated union
    * in `frontend/src/utils/cyboflowApi.ts` narrows `payload` per `type`; this
    * envelope keeps `payload: unknown` because the publish-site producer
    * (RunLauncher) is decoupled from the SDK union TASK-725 will tighten next.
    */
   export interface StreamEnvelope {
     type: StreamEventType;
     payload: unknown;
     timestamp: string;
   }
   ```

   Place it directly below the `StreamEventType` type alias so a reader walking the file finds the producer-side and consumer-side discriminants adjacent.

2. Open `main/src/orchestrator/runLauncher.ts`. Add `StreamEnvelope` to the existing `import type` line for `StreamEventType` (line 23). Rewrite the `StreamEventPublisher` interface (line 65-67) to use the shared name:

   ```ts
   export interface StreamEventPublisher {
     publish(runId: string, event: StreamEnvelope): void;
   }
   ```

3. Open `main/src/orchestrator/runEventBridge.ts`. Remove the local `interface StreamEnvelope` declaration at lines 119-123. Add `StreamEnvelope` to the existing `import type` of `ClaudeStreamEvent, StreamEventType` from `shared/types/claudeStream` at line 29. The downstream usage at line 247 (`const envelope: StreamEnvelope = { … }`) is unchanged — it now references the shared name. Confirm the envelope literal still carries `payload: typed` (a `ClaudeStreamEvent`), which is structurally assignable to `payload: unknown`.

4. Open `main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts`. Add `import type { StreamEnvelope }` from `../../../../shared/types/claudeStream` (alongside the existing `StreamEventType` import on line 28). Replace the three inline annotations at lines 67, 86, 100 with `: StreamEnvelope`. At line 115 (the cast-based site flagged in FIND-SPRINT-030-10), replace the inline `event.type as StreamEventType` cast pattern with a typed `const event: StreamEnvelope = { type: 'run_started', payload: {}, timestamp: '' }` so the four call sites are uniform.

5. Verify cross-file consistency: `grep -rn '{ type: StreamEventType; payload: unknown; timestamp: string }' main/src shared frontend/src` must return 0 matches after the edit (the only place this literal is allowed to exist is inside the `StreamEnvelope` declaration in `shared/types/claudeStream.ts`).

6. Run `pnpm typecheck` from repo root; expect exit 0. Run `pnpm --filter main test`; expect exit 0 with all three test files (`cyboflow-stream-publisher.test.ts`, `runLauncher.test.ts`, `runEventBridge.test.ts`) passing. No test-case logic changes — only the type annotation rename.

7. Run `grep -n 'StreamEnvelope' main/src/orchestrator main/src/ipc/__tests__ shared/types | wc -l` and confirm the count is at least 6 (declaration + 1 publisher type + 1 envelope local in runEventBridge + 4 test sites).

## Acceptance Criteria

- `StreamEnvelope` is exported from `shared/types/claudeStream.ts` with payload typed as `unknown` (tightening deferred to TASK-725).
- `runLauncher.ts:StreamEventPublisher.publish` references the shared name.
- `runEventBridge.ts` imports the shared name and no longer declares a local `interface StreamEnvelope`.
- All four sites in `cyboflow-stream-publisher.test.ts` use the shared type annotation; no inline-cast variant remains.
- `pnpm typecheck` and `pnpm --filter main test` both exit 0.

## Test Strategy

This task is a pure type-name consolidation. No new behavior, no new tests. The three existing test files that exercise the publisher path (`cyboflow-stream-publisher.test.ts`, `runLauncher.test.ts`, `runEventBridge.test.ts`) are the regression gate: if any of them previously compiled against the inline literal and breaks against `StreamEnvelope`, the assignment of `event.payload = {}` or `event.payload = { runId, worktreePath, branchName }` to `unknown` would still typecheck (`unknown` accepts any value). The risk surface is purely the import path and naming.

## Hardest Decision

Whether to also tighten `payload: unknown` in this task. FIND-SPRINT-030-7 implies a single follow-up that does both; the proposal direction explicitly hands the payload-tightening to TASK-725. Splitting is correct because (a) TASK-725 requires a separate decision on the `RunStartedEvent.type` field shape that this task does not need, (b) leaving `payload: unknown` here keeps the diff surgical and isolates the type-name rename from the type-narrowness change, and (c) the test-fixture audit FIND-SPRINT-030-12 flags is on TASK-725's hook (`unknown` payload tolerates `{ source: 'run-B' }` fixtures that a tightened union would reject). Keeping the two changes separate lets each ship without ambiguity about which finding it closes.

## Rejected Alternatives

- **Inline the StreamEnvelope into runLauncher.ts and re-export from there**: keeps the orchestrator-side as the source of truth, but runEventBridge already imports from `shared/types/claudeStream` for sibling types, and the renderer-side `StreamEvent` discriminated union also lives in a shared-types-adjacent file. Putting `StreamEnvelope` in shared/types is the minimum-cross-import shape. Would reconsider if a future cut moved `StreamEventType` out of `shared/types`.
- **Make `StreamEnvelope` generic in payload (`StreamEnvelope<P = unknown>`)**: tempting because TASK-725 will then specialize `P` per `type`. Rejected because the generic form forces every consumer to either re-spell `StreamEnvelope<unknown>` or import a default alias; the renderer-side `StreamEvent` union in `cyboflowApi.ts` already encodes the per-`type` narrowing pattern, and the publish-site doesn't benefit from `P` parameterization. Would reconsider if TASK-725 finds that the publish signature genuinely benefits from per-call-site generic inference.

## Lowest Confidence Area

The interaction with FIND-SPRINT-030-12: that finding flags fixtures in `frontend/src/stores/__tests__/cyboflowStore.test.ts` where the renderer-side `StreamEvent` union (not `StreamEnvelope`) has `type: 'unknown'` with a payload that doesn't match what production would deliver. This task doesn't touch that file (it's renderer-side and uses the discriminated `StreamEvent`, not the publish-side `StreamEnvelope`), so FIND-SPRINT-030-12 remains open after this task lands. If a reviewer reads this plan and expects -12 to be closed here, the answer is "no — that's a renderer fixture-shape problem, not a publish-side type-name problem, and it correctly waits on TASK-725's payload tightening."