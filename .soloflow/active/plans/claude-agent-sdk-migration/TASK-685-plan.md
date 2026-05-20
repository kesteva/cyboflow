---
id: TASK-685
idea: IDEA-014
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/runEventBridge.ts
  - shared/types/claudeStream.ts
files_readonly:
  - docs/CODE-PATTERNS.md
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts
  - .soloflow/active/findings/SPRINT-026-findings.md
acceptance_criteria:
  - criterion: "StreamEventType union in cyboflowApi.ts (or hoisted shared module) includes 'run_started'"
    verification: "grep -nE \"'run_started'\" frontend/src/utils/cyboflowApi.ts shared/types/claudeStream.ts returns ≥1 match in a StreamEventType union declaration"
  - criterion: "RunView.renderEvent handles 'run_started' with a dedicated case rendering a Starting placeholder row"
    verification: "grep -nE \"case 'run_started'\" frontend/src/components/cyboflow/RunView.tsx returns ≥1 match AND grep -nE 'Starting' frontend/src/components/cyboflow/RunView.tsx returns ≥1 match"
  - criterion: "StreamEventPublisher.publish in runLauncher.ts types event.type as StreamEventType (not bare string)"
    verification: "grep -nE 'event: \\{ type: StreamEventType' main/src/orchestrator/runLauncher.ts returns ≥1 match"
  - criterion: "StreamEvent.payload in cyboflowApi.ts is no longer typed as bare 'unknown' inside a single non-union interface; the StreamEvent type is a discriminated union over event.type"
    verification: "grep -nE 'export type StreamEvent =' frontend/src/utils/cyboflowApi.ts returns ≥1 match (union form) AND `grep -nE 'export interface StreamEvent ' frontend/src/utils/cyboflowApi.ts` returns 0 matches"
  - criterion: "RunView.tsx no longer contains 'as SystemInitEvent', 'as AssistantEvent', 'as UserEvent', 'as ResultEvent', or 'as ClaudeStreamEventVariant' casts on event.payload"
    verification: "grep -cE 'payload as (SystemInitEvent|AssistantEvent|UserEvent|ResultEvent|ClaudeStreamEventVariant)' frontend/src/components/cyboflow/RunView.tsx returns 0"
  - criterion: "RunView unit test asserts run_started renders the Starting placeholder text"
    verification: "grep -nE \"run_started\" frontend/src/components/cyboflow/__tests__/RunView.test.tsx returns ≥1 match AND the new test body includes an assertion on /Starting/"
  - criterion: "pnpm --filter frontend test exits 0"
    verification: "pnpm --filter frontend test exits 0"
  - criterion: "pnpm --filter main test exits 0 (runLauncher / runEventBridge tests pass with the tightened publish signature; pre-existing FIND-SPRINT-026-10 failures are tracked separately under B4/TASK-687)"
    verification: "pnpm --filter main exec vitest run main/src/orchestrator/__tests__/runLauncher.test.ts main/src/orchestrator/__tests__/runEventBridge.test.ts exits 0"
  - criterion: "pnpm typecheck exits 0 end-to-end"
    verification: "pnpm typecheck exits 0"
depends_on:
  - TASK-684
estimated_complexity: medium
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "Tightening StreamEventPublisher.publish from `type: string` to `type: StreamEventType` is a compile-time contract change that the main-process tests exercise via literal { type: 'run_started', payload, timestamp } objects. They must still typecheck and pass. The renderer-side test must lock in the new run_started → Starting placeholder mapping (this is the AC#8 path-B intent from TASK-683). The 5 cast-removals in RunView.tsx are typecheck-driven."
  targets:
    - behavior: "RunView renders the Starting placeholder row when a run_started StreamEvent is appended"
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
prerequisites: []
---

# B2 — Fix run_started cross-task contract: tighten StreamEventType union and StreamEvent.payload

## Objective

Close two coupled cross-task drifts surfaced by FIND-SPRINT-026-16 and FIND-SPRINT-026-20. (1) `runLauncher.ts:145-149` publishes a synthetic event with `type: "run_started"`, but `StreamEventType` in `frontend/src/utils/cyboflowApi.ts:33-39` is a closed six-value union excluding it; `RunView.renderEvent`'s switch falls through and the event renders nothing — defeating the 50-500ms UI-bootstrap aid that TASK-683 retained. (2) `StreamEvent.payload: unknown` while every consumer is fully typed end-to-end forces five `as` casts in `RunView.tsx:38,98,138,167,186`. Both stem from `run_started` not being modeled as a union member. Apply path A per the docs/CODE-PATTERNS.md "StreamEvent discriminated-union narrowing" template: add `run_started` as its own union member, narrow `StreamEvent` to a true discriminated union, tighten the publisher signature, render the placeholder, and delete the casts.

## Implementation Steps

1. **Hoist `StreamEventType` to `shared/types/claudeStream.ts`** (rationale: shared is the canonical home; main already imports `ClaudeStreamEvent` from this file). Append:
   ```ts
   export type StreamEventType =
     | 'system'
     | 'assistant'
     | 'user'
     | 'result'
     | 'stream_event'
     | 'unknown'
     | 'run_started';
   ```

2. **Edit `frontend/src/utils/cyboflowApi.ts`:**
   - Remove the local `StreamEventType` declaration (lines 33-39); re-export from shared: `export type { StreamEventType } from '../../../shared/types/claudeStream';`.
   - Import SDK variants from shared at the top of the file (`SystemInitEvent`, `SystemCompactBoundaryEvent`, `AssistantEvent`, `UserEvent`, `ResultEvent`, plus the renamed `StreamEvent as ClaudeStreamEventVariant`).
   - Replace the single `StreamEvent` interface (with `payload: unknown`) with a discriminated union:
     ```ts
     interface StreamEventBase { runId: string; timestamp: string; }
     export type StreamEvent =
       | (StreamEventBase & { type: 'system';        payload: SystemInitEvent | SystemCompactBoundaryEvent })
       | (StreamEventBase & { type: 'assistant';     payload: AssistantEvent })
       | (StreamEventBase & { type: 'user';          payload: UserEvent })
       | (StreamEventBase & { type: 'result';        payload: ResultEvent })
       | (StreamEventBase & { type: 'stream_event';  payload: ClaudeStreamEventVariant })
       | (StreamEventBase & { type: 'unknown';       payload: unknown })
       | (StreamEventBase & { type: 'run_started';   payload?: undefined });
     ```

3. **Edit `main/src/orchestrator/runLauncher.ts`:**
   - Add `import type { StreamEventType } from '../../../shared/types/claudeStream';`.
   - Tighten the `StreamEventPublisher` interface from `event: { type: string; payload: unknown; timestamp: string }` to `event: { type: StreamEventType; payload: unknown; timestamp: string }`. Keep `payload: unknown` on the publisher (the per-arm narrowing happens on the renderer side via the discriminated union; main↔renderer boundary keeps `payload` opaque).

4. **Edit `main/src/orchestrator/runEventBridge.ts`:**
   - Import `StreamEventType` from shared.
   - Tighten any local envelope shape's `type` field from `string` to `StreamEventType`. The bridge currently emits `'system' | 'assistant' | 'user' | 'result' | 'stream_event' | 'unknown'` via `deriveEnvelopeType`; all are in the union.

5. **Edit `frontend/src/components/cyboflow/RunView.tsx`:**
   - Change each row component's parameter type from `event: StreamEvent` to its per-arm narrowed form (`Extract<StreamEvent, { type: 'system' }>` etc.). Then delete the `as` casts on `event.payload` at lines 38, 98, 138, 167, 186.
   - `SystemEventRow` already removed api_retry/compact branches in TASK-684 — this task picks up the cleaner narrowing.
   - Add a `case 'run_started':` arm before the `case 'unknown':` arm in `renderEvent` rendering a minimal placeholder:
     ```tsx
     case 'run_started':
       return (
         <div className="mb-1 rounded border border-border-primary bg-bg-secondary p-2 text-xs text-text-secondary">
           <span className="font-semibold text-text-primary">Starting…</span>
         </div>
       );
     ```

6. **Edit `frontend/src/components/cyboflow/__tests__/RunView.test.tsx`:**
   - Add a new test case at the end of the suite:
     ```ts
     it('renders run_started as a Starting placeholder row', () => {
       act(() => { useCyboflowStore.getState().setActiveRun('run-1'); });
       const event: StreamEvent = {
         runId: 'run-1',
         type: 'run_started',
         timestamp: '2026-05-20T00:00:16Z',
       };
       act(() => { useCyboflowStore.getState().appendStreamEvent(event); });
       render(<RunView />);
       expect(screen.getByText(/Starting/)).toBeInTheDocument();
       expect(screen.queryByText(/Unrecognized event/)).not.toBeInTheDocument();
     });
     ```
   - The discriminated-union form means `payload` is `undefined` for `run_started`; do NOT include `payload:` in the literal.

7. **Validation:**
   - `pnpm typecheck` → exit 0.
   - `pnpm --filter frontend test` → exit 0.
   - `pnpm --filter main exec vitest run main/src/orchestrator/__tests__/runLauncher.test.ts main/src/orchestrator/__tests__/runEventBridge.test.ts` → exit 0 (full `pnpm --filter main test` may still surface FIND-SPRINT-026-10 pre-existing failures owned by TASK-687).

8. **Completeness gate** — re-run the ACs above.

## Acceptance Criteria

See frontmatter.

## Test Strategy

The new `'renders run_started as a Starting placeholder row'` test locks in the AC#8 (TASK-683 path-B) intent — the synthetic event must produce a visible UI signal during the 50-500ms bootstrap gap. Existing main-process tests already construct `StreamEventPublisher` instances with explicit publish signatures; tightening `type: StreamEventType` is typecheck-enforced — off-union literals will fail to compile.

## Hardest Decision

Whether to hoist `StreamEventType` to `shared/types/` or keep it in `frontend/src/utils/cyboflowApi.ts` and have main cross-package-import from frontend. Hoist wins because (a) shared is the canonical home for envelope-and-wire types, (b) main already imports `ClaudeStreamEvent` from shared, and (c) it avoids a `main → frontend` import direction.

## Rejected Alternatives

- **Path B (remove the synthetic `run_started` publish):** rejected — discards the AC#8 path-B UI-bootstrap aid TASK-683 explicitly retained. Reconsider only if FIND-SPRINT-026-11 instrumentation shows first-real-event p95 < 100ms.
- **Path C (tighten only publisher signature, leave `StreamEvent.payload: unknown`):** rejected — half-fixes the drift; FIND-SPRINT-026-20 stays live and the docs/CODE-PATTERNS.md template is violated.
- **Cross-package import (main → frontend):** rejected — see Hardest Decision.

## Lowest Confidence Area

The per-arm `Extract<StreamEvent, { type: '…' }>` parameter typing for each row component. TypeScript's `Extract<>` correctly narrows the union, and after TASK-684 lands `SystemEventRow` only needs `SystemInitEvent | SystemCompactBoundaryEvent` on `payload` — but if TASK-684 has not yet landed, the row's payload type still references `SystemApiRetryEvent` / `SystemCompactEvent`. **depends_on: [TASK-684]** is encoded for this reason.
