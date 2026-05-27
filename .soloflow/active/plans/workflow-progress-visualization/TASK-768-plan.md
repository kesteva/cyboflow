---
id: TASK-768
idea: IDEA-026
status: in-flight
created: "2026-05-26T16:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
files_readonly:
  - shared/types/workflows.ts
  - frontend/src/components/cyboflow/RunRightRail.tsx
  - frontend/src/components/cyboflow/RunBottomPane.tsx
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/trpc/client.ts
  - frontend/tailwind.config.js
  - docs/protoflow-design/README.md
  - docs/protoflow-design/dashboard.jsx
  - .soloflow/active/ideas/IDEA-026.md
  - .soloflow/active/research/IDEA-026-research.md
acceptance_criteria:
  - criterion: "frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx exists and exports a named React function component WorkflowProgressTimeline with prop signature { runId: string | null }."
    verification: "grep -E 'export function WorkflowProgressTimeline|export const WorkflowProgressTimeline' frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx returns at least one match; pnpm --filter frontend typecheck exits 0."
  - criterion: "When runId is non-null, on mount and on every runId change, invokes trpc.cyboflow.runs.getPhaseState.query({ runId }) exactly once per runId to seed initial state."
    verification: "Vitest test mocks getPhaseState.query, asserts called once with { runId: 'run-A' }; rerenders with 'run-B' and asserts called second time with { runId: 'run-B' }."
  - criterion: "When runId is non-null, on mount opens exactly one onStepTransition.subscribe({ runId }, { onData, onError }) subscription, and on unmount or runId change calls subscription.unsubscribe() exactly once before opening a new subscription."
    verification: "Vitest test mocks subscribe to return { unsubscribe: vi.fn() }; mounts with 'run-A', asserts subscribe called once; unmounts to null, asserts unsubscribe called once and no new subscribe; remount with 'run-B' issues subscribe with { runId: 'run-B' }."
  - criterion: "Step state derivation: 'done' renders timeline-item left border in border-status-success; 'running' uses a running token (status-running if defined, else status-error fallback per Q5); 'pending' uses border-border-primary."
    verification: "Vitest test seeds getPhaseState with one phase × three steps in three states, asserts each step item rendered by data-testid 'step-item-<stepId>' has expected border-color class."
  - criterion: "The running step's left bullet has the 1.4s pulse animation (opacity 1→0.4→1, scale 1→0.8→1). The animation applies ONLY to the running step's bullet."
    verification: "Vitest test asserts running step's bullet element has style.animation containing '1.4s' and 'infinite'; pending/done bullets do NOT have that animation."
  - criterion: "Phase headers render: 8×8 colored swatch (background = phase.color), phase label 11px bold, right-aligned step count text '${steps.length} steps'."
    verification: "Vitest test seeds two phases with non-empty steps[], queries data-testid 'phase-header-<id>' for each phase, asserts swatch background inline style equals phase color, label text present, count text matches."
  - criterion: "Each non-pending step renders log lines projected from cyboflowStore.streamEvents filtered to step's time window: mono prefix glyph (▸ ✎ · ✓ ●), 42px tabular-numerics timestamp column, message text."
    verification: "Vitest test seeds streamEvents at known timestamps; renders; queries 'log-line-<stepId>' lines; asserts prefix glyph + timestamp width 42px (tabular-nums) + message body."
  - criterion: "On onStepTransition delta for active runId, updates local stepStates so matching stepId reflects new status; updates currentStepId to stepId if status === 'running'. Events for different runId are ignored."
    verification: "Vitest test captures onData callback; invokes with delta moving S2 'pending' → 'running'; asserts S2 has running border + pulse. Invokes with different runId; asserts no state change."
  - criterion: "When runId is null, renders 'No active run' placeholder and does NOT call getPhaseState.query or onStepTransition.subscribe."
    verification: "Vitest test renders runId={null}, asserts placeholder text present and both trpc mocks have callCount 0."
  - criterion: "Component renders entirely within cyboflow Tailwind tokens — no hardcoded protoflow paper-cream palette hex (#f5f1e8, #ebe4d2, #1a1815, #6a5e44, #9c8e6c, #d8cfb8). Phase.color values are data, not theme tokens."
    verification: "grep -nE '#f5f1e8|#ebe4d2|#1a1815|#6a5e44|#9c8e6c|#d8cfb8' frontend/src/components/cyboflow/WorkflowProgressTimeline.tsx returns 0 matches."
  - criterion: pnpm --filter frontend typecheck exits 0 and pnpm --filter frontend test exits 0 with new test suite green.
    verification: Run both commands; both exit 0.
depends_on:
  - TASK-766
  - TASK-767
estimated_complexity: high
epic: workflow-progress-visualization
test_strategy:
  needed: true
  justification: "Net-new component owning four distinct behaviors needing explicit coverage: (a) tRPC seed query on mount/runId change, (b) tRPC subscription lifecycle, (c) state-keyed border + pulse rendering, (d) log-line projection from cyboflowStore. Sibling tests do NOT exercise this component (it doesn't exist yet). A new dedicated test file is required."
  targets:
    - behavior: "On mount with non-null runId, calls getPhaseState.query exactly once and re-calls on runId change."
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
      type: component
    - behavior: Opens onStepTransition subscription on mount and tears it down on unmount or runId change exactly once.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
      type: component
    - behavior: Renders phase headers + step items with state-keyed border colors using cyboflow Tailwind tokens.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
      type: component
    - behavior: "Applies 1.4s pulse animation to running step's bullet only."
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
      type: component
    - behavior: Projects log lines from cyboflowStore.streamEvents filtered to step time window with prefix glyph + 42px tabular timestamp + message.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
      type: component
    - behavior: Incoming onStepTransition delta updates state; delta for different runId is ignored.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
      type: component
    - behavior: runId=null renders placeholder and issues no tRPC calls.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowProgressTimeline.test.tsx
      type: component
---
# WorkflowProgressTimeline — vertical per-phase step feed wired to live tRPC phase state

## Objective

Create the content body of the Workflow Progress tab inside `RunRightRail` (TASK-767). Consumes `cyboflow.runs.getPhaseState` (seed query) and `cyboflow.runs.onStepTransition` (live subscription) exposed by TASK-766. Renders protoflow §4a: vertical feed with phase sections (colored swatch + label + step count), timeline step items with state-keyed 2px left borders + 8px bullet + name + agent + uppercase status, log lines below non-pending steps with mono prefix glyph + 42px tabular timestamp + message. 1.4s opacity+scale pulse on running step's bullet only. Uses existing cyboflow Tailwind tokens, NOT protoflow paper-cream palette.

## Implementation Steps

1. **Create `WorkflowProgressTimeline.tsx`** as a new file. Export `function WorkflowProgressTimeline({ runId }: { runId: string | null }): ReactElement`. Imports: React hooks, useCyboflowStore, trpc client, WorkflowDefinition/WorkflowStepState/WorkflowStepTransitionEvent types from shared/types/workflows.ts, StreamEvent from cyboflowApi.

2. **Local state**: `{ definition, currentStepId, stepStates }` initial `{ null, null, [] }`; `loadError`, `isLoading` initial `null`/`false`. Select `streamEvents` from `useCyboflowStore`.

3. **Seed-query effect** keyed on `[runId]`:
   - runId=null → reset state, return.
   - Set isLoading=true, capture `aborted=false` flag.
   - `trpc.cyboflow.runs.getPhaseState.query({ runId })` → on resolve update state, on reject set loadError.
   - Cleanup: `aborted = true`.

4. **Subscription effect** separate, keyed on `[runId]`:
   - runId=null → return.
   - `const subscription = trpc.cyboflow.runs.onStepTransition.subscribe({ runId }, { onData, onError })` matching the pattern in `reviewQueueSlice.ts:194`.
   - onData: runtime-guard payload, ignore if `evt.runId !== runId`, update stepStates immutably (replace matching entry's status), update currentStepId if status='running'.
   - onError: console.error, do not reset state.
   - Cleanup: `subscription.unsubscribe()`.

5. **Time-window derivation** helper `getStepTimeWindow(stepId, stepStates)`. If TASK-765 ships transition timestamps on WorkflowStepState, read directly. Otherwise walk streamEvents for `workflow_step_transition` events. Degraded mode: empty log section with TODO comment.

6. **Log-line projection** helper `projectLogLines(streamEvents, runId, window)`:
   - Filter by runId and time window.
   - Map each event to `{ kind, t, text }`:
     - `assistant` with `tool_use` (Edit/Write/MultiEdit) → kind='edit'
     - `assistant` with `tool_use` → kind='tool'
     - `assistant` with `text` → kind='note'
     - `result` → kind='done'
   - Format elapsed time as mm:ss padded for tabular alignment.

7. **Phase-grouped render** inside `<div className="flex h-full flex-col overflow-y-auto p-3 text-xs text-text-primary">`:
   - runId=null → "No active run" placeholder.
   - Loading state.
   - Error state.
   - Otherwise iterate `phaseState.definition.phases`:
     - Section with data-testid `phase-section-<id>`.
     - Phase header (swatch via inline style `{ background: phase.color }` + label + step count).
     - Step list: derive status, compute borderClass (`border-status-success` / `border-status-error` (or `status-running` if available) / `border-border-primary`). Step item with data-testid `step-item-<id>`, bullet with conditional pulse animation, name + status + agent, log lines if non-pending.

8. **Pulse animation declaration** — inject module-level `<style>` tag once via useEffect with flag (since index.css is files_readonly). `@keyframes workflow-step-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }`.

9. **Log-line item** with `data-testid="log-line-<stepId>-<idx>"`: prefix glyph (`▸` tool, `✎` edit, `·` note, `✓` done, `●` running), 42px tabular timestamp, message.

10. **No protoflow hex colors** — self-check grep returns 0 matches.

11. **Create `__tests__/WorkflowProgressTimeline.test.tsx`** mirroring RunView.test.tsx / RunBottomPane.test.tsx setup. Mock cyboflowApi and trpc/client with captured subscribe/query spies. 7 test cases per test_strategy targets.

12. **Run typecheck and tests** — both exit 0.

## Acceptance Criteria

See frontmatter.

## Test Strategy

New test file with 7 cases. Uses `renderHook` / `render` from @testing-library/react. tRPC mock returns `{ unsubscribe: vi.fn() }` from `subscribe()`; onData handler captured for imperative invocation per test.

## Hardest Decision

**Whether to read step time-window from WorkflowStepState fields (TASK-765) or re-derive by walking streamEvents.** Chose defensive two-mode: prefer reading timestamps off WorkflowStepState if shipped; otherwise walk streamEvents for `workflow_step_transition` entries. Fallback to degraded mode (empty log block + TODO) if neither available. Keeps the timeline UI shell viable independent of TASK-765's exact field layout.

## Rejected Alternatives

- **Defer log projection entirely.** Rejected — log lines are load-bearing per IDEA Slice 2.
- **Mount subscription inside cyboflowStore as second singleton.** Rejected — timeline is the only consumer; per-component subscription is simpler.
- **Use @trpc/react-query useQuery/useSubscription.** Rejected — `frontend/src/trpc/client.ts` uses `createTRPCProxyClient`, not React Query bindings. Imperative pattern matches `reviewQueueStore.ts:194`.
- **Add @keyframes workflow-step-pulse to index.css.** Rejected — index.css is files_readonly. Module-level `<style>` injection is the right boundary.

## Lowest Confidence Area

**Exact field shape of WorkflowStepState shipped by TASK-765 and WorkflowStepTransitionEvent payload from TASK-766.** Defensive two-mode log-projection mitigates field uncertainty.

Secondary: cyboflow Tailwind config has `status-success/warning/error/info/neutral` but NO `status-running`. Executor MUST grep `frontend/tailwind.config.js` for `status-running` before importing the class; if absent, fall back to `border-status-error` (rust analog) per IDEA-026 Q5 answer.
