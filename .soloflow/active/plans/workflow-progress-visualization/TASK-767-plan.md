---
id: TASK-767
idea: IDEA-026
status: in-flight
created: "2026-05-26T16:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/RunRightRail.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
files_readonly:
  - frontend/src/App.tsx
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/RunChatView.tsx
  - frontend/src/components/cyboflow/ChatInput.tsx
  - frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
  - frontend/tailwind.config.js
  - .soloflow/active/ideas/IDEA-026.md
  - .soloflow/active/research/IDEA-026-research.md
  - .soloflow/active/plans/per-run-chat-surface/TASK-761-plan.md
  - .soloflow/active/plans/per-run-chat-surface/TASK-762-plan.md
acceptance_criteria:
  - criterion: frontend/src/components/cyboflow/RunRightRail.tsx exists and exports a named React component RunRightRail with no required props.
    verification: "test -f frontend/src/components/cyboflow/RunRightRail.tsx && grep -nE 'export function RunRightRail|export const RunRightRail' frontend/src/components/cyboflow/RunRightRail.tsx returns at least one match."
  - criterion: "RunRightRail renders exactly three tab buttons with labels 'Workflow Progress', 'File Explorer', 'Diff' (role=tab); 'Workflow Progress' is the default selected tab (aria-selected=true)."
    verification: "Vitest test renders <RunRightRail />, asserts screen.getByRole('tab', { name: 'Workflow Progress' }).getAttribute('aria-selected') === 'true'; other two tabs are present and aria-selected=false."
  - criterion: "When the 'Workflow Progress' tab is active, RunRightRail's tabpanel renders the literal placeholder text 'Workflow Progress — coming soon' inside an element with data-testid='run-right-rail-workflow-progress-placeholder'. (TASK-768 will replace this placeholder.)"
    verification: "grep -nE 'Workflow Progress — coming soon' frontend/src/components/cyboflow/RunRightRail.tsx returns at least one match; vitest test asserts the testid is in the DOM by default."
  - criterion: "Clicking the 'File Explorer' tab shows 'File Explorer — coming soon' inside data-testid='run-right-rail-file-explorer-placeholder' and hides the Workflow Progress placeholder."
    verification: "Vitest test fires click, asserts file-explorer testid in DOM and workflow-progress testid absent."
  - criterion: "Clicking the 'Diff' tab shows 'Diff — coming soon' inside data-testid='run-right-rail-diff-placeholder' and hides the other two placeholders."
    verification: "Vitest test fires click, asserts diff testid in DOM and other two absent."
  - criterion: "RunRightRail's root has Tailwind classes 'w-[296px] shrink-0 flex flex-col border-l border-border-primary' (296px fixed width, prevents flex compression, vertical stack, left border)."
    verification: "grep -nE 'w-\\[296px\\]' frontend/src/components/cyboflow/RunRightRail.tsx returns at least one match; vitest test asserts rendered root has class strings w-[296px] AND shrink-0 AND border-l."
  - criterion: "The tab content container inside RunRightRail has 'flex-1 overflow-y-auto' so the rail's tab body scrolls independently."
    verification: "grep -nE 'flex-1.*overflow-y-auto|overflow-y-auto.*flex-1' frontend/src/components/cyboflow/RunRightRail.tsx returns at least one match."
  - criterion: "In CyboflowRoot.tsx, the previous main content area (<div className='flex-1 overflow-auto p-4'>) is replaced by a flex-row container: left column 'flex-1 flex flex-col overflow-hidden' + <RunRightRail />. Outer wrapper has 'flex flex-row flex-1 overflow-hidden'."
    verification: "grep -nE 'flex flex-row flex-1 overflow-hidden' frontend/src/components/cyboflow/CyboflowRoot.tsx returns at least one match; grep -nE '<RunRightRail' frontend/src/components/cyboflow/CyboflowRoot.tsx returns exactly one match; grep -nE 'flex-1 overflow-auto p-4' frontend/src/components/cyboflow/CyboflowRoot.tsx returns 0 matches."
  - criterion: "CyboflowRoot.tsx imports RunRightRail from './RunRightRail'."
    verification: "grep -nE \"import \\{ RunRightRail \\} from './RunRightRail'\" frontend/src/components/cyboflow/CyboflowRoot.tsx returns exactly one match."
  - criterion: "The left column of CyboflowRoot continues to render <RunBottomPane /> when activeRunId is non-null AND the empty-state CTA when activeRunId is null. RunRightRail is ALWAYS rendered (it is the layout shell)."
    verification: "Vitest update asserts (a) activeRunId=null → both 'Choose a workflow to start' AND workflow-progress placeholder in DOM; (b) activeRunId set → RunView's runId text AND workflow-progress placeholder in DOM."
  - criterion: "Existing CyboflowRoot.test.tsx behaviours (empty-state, RunView mount, picker open/close, Quick Session full lifecycle, etc.) continue to pass unchanged."
    verification: pnpm --filter frontend test --run components/cyboflow/__tests__/CyboflowRoot.test.tsx exits 0.
  - criterion: "RunBottomPane's test suite continues to pass unchanged — this task does not modify RunBottomPane.tsx."
    verification: git diff HEAD -- frontend/src/components/cyboflow/RunBottomPane.tsx is empty; pnpm --filter frontend test --run components/cyboflow/__tests__/RunBottomPane.test.tsx exits 0.
  - criterion: Frontend typecheck and lint pass.
    verification: "pnpm --filter frontend typecheck && pnpm --filter frontend lint exit 0."
  - criterion: Frontend unit tests pass (full vitest run).
    verification: pnpm --filter frontend test exits 0.
depends_on: []
estimated_complexity: medium
epic: workflow-progress-visualization
test_strategy:
  needed: true
  justification: "Two surfaces change: a net-new RunRightRail component with 3 tab states needs its own focused tests, AND the CyboflowRoot layout restructure mutates a file with existing 11-case sibling tests (CyboflowRoot.test.tsx) that must remain green with 2 added assertions for the rail invariant."
  targets:
    - behavior: "RunRightRail renders three tabs (Workflow Progress / File Explorer / Diff), defaults to Workflow Progress."
      test_file: frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
      type: component
    - behavior: Clicking each tab switches the visible placeholder; only one placeholder is in the DOM at a time.
      test_file: frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
      type: component
    - behavior: "Workflow Progress tab is default-selected and shows 'Workflow Progress — coming soon' on first render."
      test_file: frontend/src/components/cyboflow/__tests__/RunRightRail.test.tsx
      type: component
    - behavior: "CyboflowRoot renders RunRightRail in both empty-state and active-state — proves rail is shell, not gated on run."
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: Existing CyboflowRoot.test.tsx behaviours remain green after restructure.
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
---
# Restructure CyboflowRoot layout and build RunRightRail shell with 3 tabs

## Objective

Convert CyboflowRoot's single-column main content area (`flex-1 overflow-auto p-4`) into a two-column flex-row layout: a fluid left column (hosting empty-state CTA or RunBottomPane) and a fixed-296px right rail. The right rail is a new component, `RunRightRail`, with three tabs — Workflow Progress, File Explorer, Diff — all shipping as placeholders. The Workflow Progress tab's real content (`WorkflowProgressTimeline`) lands in TASK-768. The left column's flex-col structure is designed so TASK-769 can later drop a canvas above RunBottomPane without further CyboflowRoot edits.

## Dependencies — CROSS-SPRINT

**This task MUST NOT start until TASK-761 and TASK-762 (per-run-chat-surface, IDEA-025, in-flight) have landed on `main`.** Those tasks list `CyboflowRoot.tsx` in their `files_readonly` set — they reference its existing structure. Restructuring CyboflowRoot before they land would invalidate their in-flight tests.

The sibling-DAG `depends_on` is `[]` because these are cross-sprint dependencies which the orchestrator's per-IDEA DAG cannot express. **Executor must verify before starting:**
1. `git log --oneline main | grep -E 'TASK-761|TASK-762'` shows both tasks merged.
2. `frontend/src/components/cyboflow/RunChatView.tsx` and `ChatInput.tsx` both exist on main.

If either fails, report BLOCKED and stop.

## Implementation Steps

1. **Verify cross-sprint prerequisites.** Confirm TASK-761 and TASK-762 are merged. If not, report BLOCKED.

2. **Create `RunRightRail.tsx`** as a new file. State: `const [activeTab, setActiveTab] = useState<TabId>('workflow-progress')`. Tab list: TABS array with 3 entries. Root: `<aside data-testid="run-right-rail" className="w-[296px] shrink-0 flex flex-col border-l border-border-primary bg-bg-primary">`. Tablist: `role="tablist"`, flex border-b. Each tab button: `role="tab"`, `aria-selected={isActive}`, `data-testid="run-right-rail-tab-${tab.id}"`. Tabpanel: `role="tabpanel" className="flex-1 overflow-y-auto"`. Three placeholder divs keyed by activeTab, each with its testid and "X — coming soon" text.

3. **Restructure `CyboflowRoot.tsx`.** Locate the current main content area:
   ```tsx
   <div className="flex-1 overflow-auto p-4">
     {activeRunId !== null ? <RunBottomPane /> : <empty state CTA>}
   </div>
   ```
   Replace with:
   ```tsx
   <div className="flex flex-row flex-1 overflow-hidden">
     <div className="flex-1 flex flex-col overflow-hidden">
       {activeRunId !== null ? <RunBottomPane /> : <empty state CTA with p-4>}
     </div>
     <RunRightRail />
   </div>
   ```
   Add `import { RunRightRail } from './RunRightRail';`. Move `p-4` padding into the empty-state inner div. RunBottomPane reaches column edges.

4. **Create `__tests__/RunRightRail.test.tsx`** with 3 test cases per test_strategy targets.

5. **Update `__tests__/CyboflowRoot.test.tsx`** — add 2 single-line assertions to existing tests (empty-state + active-state) that `screen.getByTestId('run-right-rail-workflow-progress-placeholder')` is in the document. Do NOT modify the other 9 test cases.

6. **Run verification**: `pnpm --filter frontend typecheck`, `pnpm --filter frontend lint`, `pnpm --filter frontend test --run components/cyboflow/__tests__/RunRightRail.test.tsx`, `pnpm --filter frontend test --run components/cyboflow/__tests__/CyboflowRoot.test.tsx`, `pnpm --filter frontend test --run components/cyboflow/__tests__/RunBottomPane.test.tsx`, `pnpm --filter frontend test` (full). All exit 0.

7. **Diff hygiene**: `git diff HEAD -- RunBottomPane.tsx` must be empty.

## Acceptance Criteria

See frontmatter for the verifiable list.

## Test Strategy

Two test files participate. RunRightRail.test.tsx (NEW, 3 cases). CyboflowRoot.test.tsx (UPDATE — additive, 2 single-line assertions added to existing tests; do NOT refactor the existing 11 cases). RunBottomPane.test.tsx in files_readonly because RunBottomPane.tsx is unchanged.

## Hardest Decision

**Whether the right rail should be rendered only when a run is active or always rendered as part of the shell.** Chose **always render** — protoflow design treats the rail as a stable structural element, TASK-769/768 wiring is cleaner if their host is always mounted, and a 296px deduction leaves plenty of room for empty-state CTA on typical viewports.

## Rejected Alternatives

- **CSS Grid for two-column layout.** Rejected — research Area D explicitly recommends plain flexbox with shrink-0.
- **Move RunBottomPane mounting into RunRightRail or vice versa.** Rejected — they are independent surfaces.
- **Author RunRightRail with tabs wired to real components.** Rejected — out of scope per skeleton. TASK-768 owns WorkflowProgressTimeline; File Explorer and Diff are out of scope for IDEA-026.
- **Add a Tailwind config token for 296px.** Rejected — single-use literal; `w-[296px]` arbitrary value is idiomatic.
- **Wait for TASK-768 to land first.** Rejected — TASK-768 cannot land without the rail to host it.

## Lowest Confidence Area

**Whether the empty-state CTA visually centers correctly inside the narrower left column after restructure.** The `flex h-full flex-col items-center justify-center` should still center, but the column is now ~984px wide (vs ~1280px before) on typical viewports. Visual verification recommended; fix is single-line tweak.

Secondary: the `p-4` removal from the outer wrapper. If this introduces a visual gap, executor may add `p-4` to left-column container — but doing so requires coordinating with TASK-769 (canvas placement).
