---
id: TASK-354
idea: IDEA-008
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/App.tsx
  - frontend/src/utils/cyboflowApi.ts
files_readonly:
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/runLauncher.ts
  - shared/types/workflows.ts
  - docs/cyboflow_system_design.md
  - frontend/src/utils/api.ts
acceptance_criteria:
  - criterion: "`<WorkflowPicker />` renders a select element with exactly the 5 SoloFlow workflow names (soloflow, planner, sprint, compound, prune) as options, populated from a tRPC `cyboflow.workflows.list` query (or, until the tRPC router lands, the cyboflowApi.listWorkflows wrapper that calls the existing ipcMain.handle bridge)"
    verification: "Test or visual check: render <WorkflowPicker projectId={1} /> in a test harness with API stubbed to return the 5 workflows; assert the rendered `<option>` elements have textContent matching the 5 names. (vitest + @testing-library/react if added, OR a one-shot Playwright assertion under tests/cyboflow-picker.spec.ts.)"
  - criterion: "Clicking the 'Start Run' button invokes `cyboflowApi.startRun({ workflowId, projectId })` and the returned `runId` is stored on `cyboflowStore.activeRunId`"
    verification: "Inspect cyboflowStore behavior: render picker + start button; click; assert the store's activeRunId equals the runId the stubbed API returned. (Test in WorkflowPicker.test.tsx or via Playwright assertion on a debug element rendering the activeRunId text.)"
  - criterion: "`<RunView />` subscribes to a tRPC subscription `cyboflow.events.onStreamEvent({ runId })` and appends each received event to a scrollable event log; when no runId is active, the view shows a placeholder ('No active run')"
    verification: "Read frontend/src/components/cyboflow/RunView.tsx; grep -n 'onStreamEvent\\|No active run' returns 2 matches (one for the subscription call, one for the placeholder string)."
  - criterion: "`<CyboflowRoot />` is mounted into `App.tsx` and is rendered as the new top-level view (Cyboflow's primary surface) — the existing Crystal `<SessionView />` is still reachable but no longer the default landing"
    verification: "grep -n 'CyboflowRoot' frontend/src/App.tsx returns at least 1 match. The component is rendered (not just imported)."
  - criterion: "`cyboflowApi` module exposes typed wrappers `listWorkflows({ projectId })`, `startRun({ workflowId, projectId })`, `subscribeToStreamEvents({ runId, onEvent })`, `approveRun({ runId, approvalId, decision })`. The last is the hook the day-3 gate test calls directly."
    verification: "grep -n 'export' frontend/src/utils/cyboflowApi.ts returns at least 4 named exports: listWorkflows, startRun, subscribeToStreamEvents, approveRun."
  - criterion: "The frontend does NOT add a hard dependency on `trpc-electron` or `@trpc/client` if those have not yet been installed (epic 6 owns that install). The cyboflowApi wrapper transparently routes through the existing `window.electron`/IPC channels until tRPC lands."
    verification: "grep -rn '@trpc/client\\|trpc-electron' frontend/src/ returns 0 matches (or only matches in files NOT in this task's files_owned). The cyboflowApi uses the existing IPC pattern from frontend/src/utils/api.ts."
  - criterion: "The store exposes selectors `useCyboflowStore(s => s.activeRunId)` and `useCyboflowStore(s => s.streamEvents)`; the streamEvents array grows when events arrive via the subscription"
    verification: "Read frontend/src/stores/cyboflowStore.ts; assert `activeRunId` and `streamEvents` are declared in the state interface; assert there is an `appendStreamEvent(event)` action that pushes onto streamEvents."
depends_on: [TASK-353]
estimated_complexity: medium
epic: workflow-runs-and-day3-gate
test_strategy:
  needed: true
  justification: "The minimal frontend is the visible end-to-end smoke for the orchestrator: if the picker can't list workflows or the run view can't show events, the day-3 gate can't be demoed. A small behavioral test per component (picker renders 5 options + start triggers API) catches regressions cheaply; full UX testing is Phase 2's review-queue-ui epic."
  targets:
    - behavior: "WorkflowPicker renders 5 options and start button triggers cyboflowApi.startRun"
      test_file: "frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx"
      type: component
    - behavior: "RunView shows placeholder when no run is active and event log when run is active"
      test_file: "frontend/src/components/cyboflow/__tests__/RunView.test.tsx"
      type: component
    - behavior: "cyboflowStore.appendStreamEvent grows the streamEvents array"
      test_file: "frontend/src/stores/__tests__/cyboflowStore.test.ts"
      type: unit
---

# Minimal Frontend: Workflow Picker + Run Start + Single Run View

## Objective

Ship the bare-minimum UI to drive the orchestrator end-to-end: a dropdown listing the 5 SoloFlow workflows, a "Start Run" button that launches the selected workflow, and a single run view that subscribes to the typed stream-event feed and renders events as they arrive. This is the visible substrate for the day-3 gate — without it, the gate test cannot demo "two runs paused, approve in any order, both resume." Polish is deliberately deferred to Phase 2's `review-queue-ui` epic; this task ships the demo wire, not the product.

## Implementation Steps

1. **Create `frontend/src/utils/cyboflowApi.ts`** as a typed wrapper over the IPC surface. Mirror the pattern of `frontend/src/utils/api.ts` (the existing Crystal API wrapper). Surface:
   ```ts
   import type { WorkflowRow } from '../../../shared/types/workflows';

   export interface StartRunResult { runId: string; worktreePath: string; branchName: string; }
   export interface StreamEvent { runId: string; type: string; payload: unknown; timestamp: string; }

   export const cyboflowApi = {
     async listWorkflows({ projectId }: { projectId: number }): Promise<WorkflowRow[]> {
       // For now: window.electron.invoke('cyboflow:listWorkflows', { projectId })
       // When tRPC lands in epic 6: trpc.cyboflow.workflows.list.query({ projectId })
       const res = await window.electron.invoke('cyboflow:listWorkflows', { projectId });
       if (!res.success) throw new Error(res.error || 'listWorkflows failed');
       return res.data;
     },

     async startRun({ workflowId, projectId }: { workflowId: number; projectId: number }): Promise<StartRunResult> {
       const res = await window.electron.invoke('cyboflow:startRun', { workflowId, projectId });
       if (!res.success) throw new Error(res.error || 'startRun failed');
       return res.data;
     },

     subscribeToStreamEvents({ runId, onEvent }: { runId: string; onEvent: (e: StreamEvent) => void }): () => void {
       const channel = `cyboflow:stream:${runId}`;
       const handler = (_evt: unknown, payload: StreamEvent) => onEvent(payload);
       window.electron.on(channel, handler);
       return () => window.electron.off(channel, handler);
     },

     async approveRun({ runId, approvalId, decision }: { runId: string; approvalId: string; decision: 'allow' | 'deny' }): Promise<void> {
       const res = await window.electron.invoke('cyboflow:approveRun', { runId, approvalId, decision });
       if (!res.success) throw new Error(res.error || 'approveRun failed');
     },
   };
   ```
   The four IPC channels (`cyboflow:listWorkflows`, `cyboflow:startRun`, `cyboflow:stream:<runId>`, `cyboflow:approveRun`) need to be registered in `main/src/ipc/` — this task adds the channel names to the contract but does NOT add the main-process handlers. **Register handler stubs that throw 'NOT_IMPLEMENTED'**; the actual wiring is done by the integration of TASK-353 (which exposes RunLauncher.launch) and epic 7 (which exposes the approve action). The handler bodies for `cyboflow:listWorkflows` and `cyboflow:startRun` SHOULD be implemented in this task because the dependencies (TASK-351, TASK-353) are merged; leave `cyboflow:approveRun` as a stub that throws — the day-3 gate test (TASK-355) bypasses it and calls the orchestrator directly. (Note: when epic 6 lands tRPC, this whole module migrates to typed `trpc.cyboflow.*` calls; the wrapper insulates components from that swap.)

2. **Add main-process IPC handlers** for `cyboflow:listWorkflows` and `cyboflow:startRun` in a new file `main/src/ipc/cyboflow.ts` (this file is OWNED by this task; small enough to fit in the budget). Register it in `main/src/ipc/index.ts` (read-only for this task — only the registration line is added, do not touch the rest). The handler bodies:
   - `cyboflow:listWorkflows`: call `workflowRegistry.listByProject(projectId)`. If the registry has not been seeded for the project, call `workflowRegistry.seed(projectId, ...DEFAULT_SOLOFLOW_WORKFLOWS)` first.
   - `cyboflow:startRun`: call `runLauncher.launch(workflowId, projectPath)` (project path resolved via the existing `sessionManager.getProjectById(projectId).path`). Return `{ runId, worktreePath, branchName }`.

   Add this file to files_owned. The orchestrator boot (epic 6) is responsible for instantiating and passing `workflowRegistry` and `runLauncher` to the IPC layer; until that lands, the handlers can lazily construct them on first call using the existing singleton `databaseService` and `worktreeManager`.

3. **Create `frontend/src/stores/cyboflowStore.ts`** as a Zustand slice:
   ```ts
   import { create } from 'zustand';
   import type { StreamEvent } from '../utils/cyboflowApi';

   interface CyboflowState {
     activeRunId: string | null;
     streamEvents: StreamEvent[];
     setActiveRun: (runId: string) => void;
     clearActiveRun: () => void;
     appendStreamEvent: (event: StreamEvent) => void;
   }

   export const useCyboflowStore = create<CyboflowState>((set) => ({
     activeRunId: null,
     streamEvents: [],
     setActiveRun: (runId) => set({ activeRunId: runId, streamEvents: [] }),
     clearActiveRun: () => set({ activeRunId: null, streamEvents: [] }),
     appendStreamEvent: (event) => set((s) => ({ streamEvents: [...s.streamEvents, event] })),
   }));
   ```

4. **Create `frontend/src/components/cyboflow/WorkflowPicker.tsx`**:
   - Accept prop `projectId: number`.
   - On mount, call `cyboflowApi.listWorkflows({ projectId })` and store the result in local state (or in `cyboflowStore` if a workflows list field is added — for v1 keep it local).
   - Render a `<select>` with one `<option>` per workflow (option label = workflow.name, value = workflow.id).
   - Render a `<button>Start Run</button>` that on click calls `cyboflowApi.startRun({ workflowId: selectedId, projectId })` and on success calls `useCyboflowStore.getState().setActiveRun(result.runId)`.

5. **Create `frontend/src/components/cyboflow/RunView.tsx`**:
   - Read `activeRunId` and `streamEvents` from `useCyboflowStore`.
   - If `activeRunId` is null, render `<div>No active run</div>` placeholder.
   - When `activeRunId` becomes non-null, call `cyboflowApi.subscribeToStreamEvents({ runId, onEvent })` in a `useEffect`. In the `onEvent` handler, call `useCyboflowStore.getState().appendStreamEvent(event)`. Return the cleanup function from the effect to unsubscribe on unmount or runId change.
   - Render a scrollable `<div>` listing each event as `<pre>{JSON.stringify(event, null, 2)}</pre>`. No need for tabs, syntax highlighting, or workflow-aware rendering — this is the gate-test surface, not the product UI.

6. **Create `frontend/src/components/cyboflow/CyboflowRoot.tsx`** as the new top-level Cyboflow view:
   ```tsx
   import { WorkflowPicker } from './WorkflowPicker';
   import { RunView } from './RunView';

   export function CyboflowRoot({ projectId }: { projectId: number }) {
     return (
       <div className="flex h-full">
         <aside className="w-80 border-r border-border p-4"><WorkflowPicker projectId={projectId} /></aside>
         <main className="flex-1 overflow-auto p-4"><RunView /></main>
       </div>
     );
   }
   ```

7. **Modify `frontend/src/App.tsx`** to render `<CyboflowRoot />` as the primary surface. The simplest landing-page swap: when an active project is selected (existing logic via `useSessionStore` or whatever drives the current rail), render `<CyboflowRoot projectId={activeProjectId} />` instead of `<SessionView />` as the main content. Keep `<SessionView />` reachable via a "Legacy Crystal view" toggle (a single button in the header) — Crystal sessions still exist post-fork; this is the bare-minimum coexistence. The roadmap's `crystal-cuts-and-rebrand` epic owns deeper UI surgery; this task only adds the new entry point.

8. **Write the three component / store tests** named in `test_strategy.targets`. Use vitest + a minimal mock of `window.electron` to drive the API wrapper. If `@testing-library/react` is not yet installed in the frontend workspace, defer the component tests and instead add a lightweight Playwright smoke under `tests/cyboflow-picker.spec.ts` that opens the app, asserts the 5 workflow names appear in the picker, and asserts clicking Start populates the activeRunId placeholder. Either path satisfies `test_strategy`.

## Acceptance Criteria

See frontmatter. The criteria together verify: (1-2) the picker renders and dispatches start, (3) the run view subscribes and shows events, (4) the new root is mounted, (5) the API wrapper exposes the four required functions, (6) no premature tRPC dep, (7) the store's append behavior.

## Test Strategy

See `test_strategy.targets`. Three tests cover the core behaviors. The day-3 gate test (TASK-355) is the end-to-end integration that exercises the full UI + orchestrator path.

## Hardest Decision

Whether to wait for epic 6 (`orchestrator-and-trpc-router`) to land before building the frontend on tRPC, or ship the frontend on existing `ipcMain.handle` wrappers and migrate later. Chose the latter:
- The IDEA explicitly says "Minimal frontend ... Bare minimum to validate the orchestrator end-to-end." Coupling the frontend timeline to the tRPC install adds risk to the day-3 gate that the differentiator's substrate is not yet stable enough to absorb.
- The `cyboflowApi` wrapper provides a single migration point. When tRPC lands, swap the internals of the wrapper functions; component call sites are unchanged.
- The downside is a duplicated IPC contract (channel names in `main/src/ipc/cyboflow.ts` + wrapper in `cyboflowApi.ts`) for the duration of one epic. That's cheap to maintain and one of the explicit transition tax payments noted in the roadmap.

## Rejected Alternatives

- **Wait for epic 6 to install tRPC before starting the frontend.** Rejected per "Hardest Decision" above — couples day-3 gate timing to a separate epic.
- **Skip the run view entirely; just have a `Start Run` button that prints to console.** Rejected because the day-3 gate explicitly says "sprint resumes independently when its approval is decided afterward" — the human needs visible confirmation that the run is actually running, then paused, then resumed. The bare event log delivers that without UI investment.
- **Use Crystal's existing `<SessionView />` retrofitted with a Cyboflow data adapter.** Rejected because `<SessionView />` is 587 lines and tightly coupled to the Crystal session lifecycle (`sessionStore`, `panelStore`). Wiring a Cyboflow data adapter in would touch dozens of files. Cleaner to ship a fresh `<CyboflowRoot />` view at the cost of two-pane redundancy until `crystal-cuts-and-rebrand` finishes Phase 1.

## Lowest Confidence Area

The interaction between the new `<CyboflowRoot />` mount in `App.tsx` and the existing Crystal initialization sequence (welcome dialog, analytics consent, permission dialog, prompt history modal). All those dialogs assume the legacy `<SessionView />` surface — when the legacy view is no longer the default, some dialogs may render against a missing context. Mitigation: render `<CyboflowRoot />` ONLY when an active project is selected AND the legacy toggle is off; default state shows the Crystal welcome flow until the user dismisses it. If this turns out to be brittle, the fallback is to render `<CyboflowRoot />` in a dedicated tab next to the Crystal view until `crystal-cuts-and-rebrand` finishes.
