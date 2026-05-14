---
id: TASK-568
title: Wire MessageProjection into panels:get-json-messages IPC handler
status: ready
epic: wire-sprint-005-services
source: compound/SPRINT-004-005
source_sprint: SPRINT-005
depends_on: []
files_owned:
  - main/src/ipc/session.ts
files_readonly:
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/index.ts
  - shared/types/claudeStream.ts
  - shared/types/unifiedMessage.ts
  - frontend/src/components/panels/ai/RichOutputView.tsx
  - frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts
acceptance_criteria:
  - criterion: "The `panels:get-json-messages` IPC handler returns an array of `UnifiedMessage` shapes (each carrying a `.segments` array), not raw stream-json objects."
    verification: "grep -n 'MessageProjection' main/src/ipc/session.ts returns at least one match inside the handler body for 'panels:get-json-messages'; grep -n 'TypedEventNarrowing' main/src/ipc/session.ts returns at least one match in the same handler."
  - criterion: "Opening a session's Claude panel after a fresh run does not throw `TypeError: Cannot read properties of undefined (reading 'some')` in the renderer."
    verification: "Manual smoke: `pnpm dev`, create a session with a prompt, wait for output, open the Claude panel. cyboflow-frontend-debug.log contains no TypeError matching /Cannot read properties of undefined .*'some'/."
  - criterion: "Every stored raw stream-json output is fed through `TypedEventNarrowing.narrow()` then `MessageProjection.project()` before the IPC returns; null results (events with no renderable content) are filtered out of the response array."
    verification: "grep -nE 'narrow\\(|project\\(|filter\\(' main/src/ipc/session.ts returns matches inside the panels:get-json-messages handler block (lines ~869-923)."
  - criterion: "`pnpm typecheck` and `pnpm --filter main exec vitest run` pass."
    verification: "Exit code 0 for both commands."
depends_on: []
estimated_complexity: medium
test_strategy:
  needed: true
  justification: "The IPC handler currently has no direct unit test, and the wiring introduces a new data transform that the renderer depends on. A focused integration-style vitest test of the handler's projection pipeline locks the regression."
  targets:
    - behavior: "Stored raw system/init + assistant events are projected to UnifiedMessage[] with `.segments` populated."
      test_file: "main/src/ipc/__tests__/sessionJsonMessages.test.ts"
      type: integration
    - behavior: "Events that project to null (e.g. user events with only tool_result blocks, stream_event deltas) are filtered out of the returned array."
      test_file: "main/src/ipc/__tests__/sessionJsonMessages.test.ts"
      type: integration
prerequisites: []
---

# Wire MessageProjection into panels:get-json-messages IPC handler

## Problem

`main/src/ipc/session.ts:869-918` (`panels:get-json-messages` handler) returns
raw `{type, subtype, message, ...}` stream-json objects pulled directly from
`sessionManager.getPanelOutputs()`. The renderer at
`frontend/src/components/panels/ai/RichOutputView.tsx:230` passes those objects
through `messageTransformer.transform()`, which TASK-205 reduced to an identity
stub — so the renderer ends up calling `.segments.some(...)` on raw stream-json
that has no `segments` property, throwing
`TypeError: Cannot read properties of undefined (reading 'some')` on every
Claude-panel load (FIND-SPRINT-005-9, severity: high).

`MessageProjection` (`main/src/services/streamParser/messageProjection.ts`) was
authored by TASK-205 specifically to convert one `ClaudeStreamEvent` at a time
into a `UnifiedMessage` (with proper segments) but has zero production
callsites today.

## Proposed Direction (Implementation Steps)

1. **Pre-flight grep** (completeness gate before reporting COMPLETED):
   ```
   grep -rn 'MessageProjection\|TypedEventNarrowing' main/src/ipc/
   ```
   Must show at least one hit each in `main/src/ipc/session.ts` inside the
   `panels:get-json-messages` handler after the change.

2. Open `main/src/ipc/session.ts`. At the top, add the barrel import:
   ```ts
   import { MessageProjection, TypedEventNarrowing } from '../services/streamParser';
   ```
   (Use the existing alias/depth that other imports in the file use.)

3. Replace the body of the `panels:get-json-messages` handler (lines 869-923).
   The current handler maps each `output` row into a raw stream-json object
   with a timestamp; instead:
   - Instantiate `const narrower = new TypedEventNarrowing();` and
     `const projection = new MessageProjection(panelId);` *once per IPC call*
     (per-call instance keeps internal `toolResults` / `parentToolMap` state
     scoped to the panel being viewed).
   - Iterate `outputs` in chronological order (the existing array is already
     ordered by `getPanelOutputs`; if not, sort by `timestamp` ascending first).
   - For each `output.type === 'json'`:
     - Resolve `raw` from `output.data` exactly as the current code does
       (object passthrough, JSON.parse for strings, fallback for everything else).
     - Call `const event = narrower.narrow(raw)`.
     - Call `const projected = projection.project(event)`.
     - If `projected !== null`, push it onto the result array, **preserving
       the original `output.timestamp` as ISO-8601** (MessageProjection emits
       `timestamp: new Date().toISOString()` of *now*, which is wrong for
       historical replay — overwrite it with the persisted timestamp).
   - Drop the raw-fallback paths (the current `if (typeof output.data === 'string')`
     branch and the final `return output.data` fallback): they fed the
     renderer raw stream-json which is precisely what crashed it. If `raw`
     cannot be projected, the event silently drops (matches the existing
     contract of `MessageProjection.project() === null`).
   - Return `{ success: true, data: unifiedMessages }`.

4. Update the log line `console.log('[IPC] Returning ${jsonMessages.length}
   JSON messages …')` to log the projected count and the input count, e.g.
   ``console.log(`[IPC] panel ${panelId}: projected ${unifiedMessages.length}
   UnifiedMessages from ${outputs.length} raw outputs`)``. This makes the
   wiring observable in dev-mode logs.

5. **Author the test file** `main/src/ipc/__tests__/sessionJsonMessages.test.ts`.
   The handler is too closely coupled to `ipcMain.handle` to invoke directly;
   the test should instead exercise the projection pipeline that the handler
   delegates to. Two minimal approaches the executor should choose between:
   - **(preferred)** Extract the projection loop into a small pure helper
     `projectStoredOutputs(outputs: PanelOutput[]): UnifiedMessage[]` in the
     same file (or in `main/src/ipc/sessionJsonMessages.ts` if you prefer
     a separate module), then unit-test the helper.
   - **(fallback)** Construct a `narrower`+`projection` directly in the test
     and assert the same transform against fixtures from
     `main/src/services/streamParser/__fixtures__/`.

   Required test cases:
   - Two `system/init` + `assistant` fixtures project to ≥1 `UnifiedMessage`
     with `.segments.length >= 1` each.
   - A user-only `tool_result` event projects to null and is filtered out.
   - The returned `UnifiedMessage.timestamp` is the persisted output
     timestamp (NOT `new Date().toISOString()` of test runtime).

6. Run `pnpm typecheck` and `pnpm --filter main exec vitest run`. Both must
   pass.

## Acceptance Criteria

(See frontmatter.)

## Test Strategy

- New unit/integration tests in `main/src/ipc/__tests__/sessionJsonMessages.test.ts`
  covering the projection pipeline (see Implementation Step 5).
- The frontend transform-pipeline is not in scope here — that's tested by
  visual rendering and the existing renderer tests (which remain green
  because `RichOutputView` still consumes `UnifiedMessage[]`, the shape it
  has always consumed).

## Hardest Decision

**Where to instantiate `MessageProjection`.** The class holds per-run state
(`toolResults`, `parentToolMap`, `allToolCalls`) that mutates as events are
projected. Two options:
- **(A) Per-IPC-call instance** (chosen) — instantiate inside the handler
  every time the renderer requests messages. State is rebuilt from
  scratch each call. Cost: O(n) work per panel-open, but the IPC is
  already O(n) in the current implementation and the in-memory cost is
  bounded by panel output count.
- **(B) Long-lived per-panel instance** — cache the projection in a Map
  keyed by `panelId`. Avoids rebuild work but adds an invalidation
  surface (when does the cache get evicted? what if events arrive
  between calls?).

(A) is chosen because the IPC is read-only / pull-based and the projection
must replay the full history every call anyway to produce a consistent
ordered result. The cache would be a perf optimization for a workload
that hasn't proven to be hot.

## Rejected Alternatives

- **Introduce a new IPC surface** (e.g. `panels:get-unified-messages`)
  and leave `panels:get-json-messages` alone. Rejected because the
  TASK-205 plan explicitly said "do not introduce a new IPC surface"
  and the renderer already calls this endpoint; a parallel endpoint
  would leave two implementations to keep in sync. Would flip if the
  caller list grew beyond `RichOutputView`.
- **Project in the renderer instead of main.** Rejected because
  `MessageProjection` is main-process-only by design (TASK-205
  intentionally moved this logic out of the renderer to drop the
  duplicate Anthropic-types dep from frontend).
- **Leave the renderer crash and only fix the AC.** Rejected — the
  crash is the symptom and the missing wiring is the cause.

## Lowest Confidence Area

The timestamp overwrite (step 3, last bullet). `MessageProjection.project()`
sets `timestamp: new Date().toISOString()` inside the projection rather than
deriving it from the event — so historical replay produces wall-clock-of-now
timestamps. Overwriting after `project()` with the persisted
`output.timestamp` should be straightforward, but if the renderer relies on
the projected timestamp matching any other field on the event, this may
need a second pass. The test in step 5 (third case) is the early warning.
