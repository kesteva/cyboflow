---
id: TASK-688
idea: IDEA-017
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - tests/cyboflow-picker.spec.ts
  - CyboflowRoot.tsx
  - WorkflowPicker.tsx
files_readonly:
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
  - frontend/src/App.tsx
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/components/Sidebar.tsx
  - frontend/src/components/ui/Modal.tsx
  - frontend/src/utils/cyboflowApi.ts
acceptance_criteria:
  - criterion: "CyboflowRoot.tsx no longer renders an <aside> element"
    verification: "grep -nE '<aside' frontend/src/components/cyboflow/CyboflowRoot.tsx returns 0 matches"
  - criterion: CyboflowRoot.tsx no longer mounts WorkflowPicker as a direct child of the layout root (only inside a Modal triggered by a button)
    verification: "Visual review of diff + grep -nE 'WorkflowPicker' CyboflowRoot.tsx — each occurrence sits within a Modal-wrapped block"
  - criterion: CyboflowRoot mounts RunView exactly once as the sole content surface when activeRunId is non-null
    verification: "grep -cE '<RunView' frontend/src/components/cyboflow/CyboflowRoot.tsx returns 1"
  - criterion: "When activeRunId is null, CyboflowRoot renders an empty-state CTA containing 'Choose a workflow to start'"
    verification: "pnpm --filter frontend test passes 'renders Choose a workflow to start empty state when activeRunId is null'"
  - criterion: "When activeRunId is non-null, CyboflowRoot renders RunView and does NOT render the empty-state CTA"
    verification: "pnpm --filter frontend test passes 'renders RunView when activeRunId is set and hides the empty-state CTA'"
  - criterion: Clicking the CTA opens a Modal containing WorkflowPicker; ESC / close-button dismiss it
    verification: "pnpm --filter frontend test passes 'opening and closing the workflow picker modal toggles its visibility'"
  - criterion: WorkflowPicker accepts an optional onWorkflowStarted callback prop and invokes it on successful runs.start
    verification: "pnpm --filter frontend test passes 'modal closes automatically after a successful run start'"
  - criterion: Existing RunView unit tests remain green
    verification: pnpm --filter frontend test -- RunView passes with zero failures
  - criterion: "tests/cyboflow-picker.spec.ts updated: the workflow <select> is no longer visible on initial load, becomes visible after clicking the 'Choose a workflow' trigger"
    verification: "Read tests/cyboflow-picker.spec.ts; pnpm test passes if a project is configured, or skips with same skip-guard"
  - criterion: No new console warnings in cyboflow-frontend-debug.log
    verification: "Launch pnpm dev, open project, observe empty state, open and close picker, start a run; grep log for React warnings/errors from CyboflowRoot.tsx or WorkflowPicker.tsx — 0 matches"
depends_on:
  - TASK-687
estimated_complexity: medium
epic: cyboflow-shell-architecture
test_strategy:
  needed: true
  justification: "CyboflowRoot is being reshaped from a static two-column layout into a conditional shell with a modal-managed WorkflowPicker. Control-flow branches (activeRunId null vs set, modal open/closed, onWorkflowStarted firing) all need explicit assertions. The Playwright spec hard-codes the assumption that the workflow <select> is visible on page load — that assumption no longer holds."
  targets:
    - behavior: "renders 'Choose a workflow to start' empty state when activeRunId is null"
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: renders RunView when activeRunId is set and hides the empty-state CTA
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: opening and closing the workflow picker modal toggles its visibility
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: modal closes automatically after a successful run start (onWorkflowStarted fires)
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: "playwright: workflow select is reachable via the picker trigger (no longer visible by default)"
      test_file: tests/cyboflow-picker.spec.ts
      type: integration
---
# Reshape CyboflowRoot: WorkflowPicker moves out of aside into a modal-popover

## Objective

CyboflowRoot becomes a thin shell around RunView. The permanent `w-80` aside that hosted WorkflowPicker is removed; the picker now lives inside a Modal (using `frontend/src/components/ui/Modal.tsx`) triggered from two entry points: (1) a header button at the top of CyboflowRoot and (2) the centered "Choose a workflow to start" CTA shown when `activeRunId` is null. WorkflowPicker itself is preserved — only its mount point changes and one optional callback prop is added. App.tsx, Sidebar.tsx, RunView.tsx, and cyboflowStore.ts are read-only; the legacy-toggle removal stays with TASK-690.

**Important:** This task should also broaden `CyboflowRootProps.projectId` from `number` to `number | null` so TASK-690 can render `<CyboflowRoot projectId={activeProjectId} />` unconditionally without TypeScript errors. The empty-state branch when `projectId === null` is also part of this task.

## Implementation Steps

1. **Reshape `frontend/src/components/cyboflow/CyboflowRoot.tsx`:**
   - Drop the existing two-column layout.
   - Replace with `<div className="flex h-full flex-col">` containing (a) thin top header row with a "Choose workflow" button, (b) main content area `flex-1 overflow-auto p-4`.
   - Subscribe to `useCyboflowStore` for `activeRunId`.
   - Broaden the `CyboflowRootProps.projectId` type from `number` to `number | null`. When `projectId === null`, render an unobtrusive empty container or the same "Choose a workflow to start" CTA (degraded — no project context to pick from).
   - In main content: if `activeRunId` is null, render centered empty state with text "Choose a workflow to start" + primary CTA button "Choose a workflow"; otherwise render `<RunView />`.
   - Add local state `const [isPickerOpen, setIsPickerOpen] = useState(false);`.
   - Mount picker inside `<Modal isOpen={isPickerOpen} onClose={() => setIsPickerOpen(false)} size="md">` with `<WorkflowPicker projectId={projectId} onWorkflowStarted={() => setIsPickerOpen(false)} />`. Import Modal from `'../ui/Modal'`.

2. **Extend `frontend/src/components/cyboflow/WorkflowPicker.tsx`:**
   - Add optional prop `onWorkflowStarted?: (runId: string) => void;`.
   - After `useCyboflowStore.getState().setActiveRun(result.runId);` in `handleStartRun`, call `onWorkflowStarted?.(result.runId);`.
   - Existing callers continue to work unchanged.

3. **Create `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx`:**
   - Mock `'../../../utils/cyboflowApi'` same way `RunView.test.tsx` does.
   - `beforeEach`: stub `HTMLElement.prototype.scrollIntoView`, reset store via `clearActiveRun()`.
   - Tests: (1) empty state renders when activeRunId null; (2) RunView renders + empty state hidden when activeRunId set; (3) opening/closing modal toggles picker visibility; (4) modal auto-closes after successful run start.

4. **Update `tests/cyboflow-picker.spec.ts`:** Add helper `openPicker(page)` clicking `button:has-text("Choose a workflow")`. Update each test to open the picker first. Change "No active run" assertion to "Choose a workflow to start" assertion. Preserve skip-guard pattern.

5. **Self-verification:** `pnpm --filter frontend test`. All four CyboflowRoot tests pass; existing RunView tests remain green.

6. **Visual verification:** `pnpm build:main && pnpm dev`. Confirm: (a) no permanent aside in CyboflowRoot; (b) centered empty-state CTA; (c) clicking CTA or header button opens Modal; (d) ESC and X close Modal; (e) starting a run closes modal and RunView replaces empty state. Read `cyboflow-frontend-debug.log` for warnings.

## Acceptance Criteria

See frontmatter.

## Test Strategy

New `CyboflowRoot.test.tsx` covers four behaviors. Existing `RunView.test.tsx` stays untouched. Playwright `cyboflow-picker.spec.ts` is owned by this task and updated. Mocking follows `RunView.test.tsx` patterns; stub `HTMLElement.prototype.scrollIntoView` because RunView mounts inside CyboflowRoot when activeRunId is set.

## Hardest Decision

**Picker entry point: dedicated popover library vs reuse the existing Modal primitive.** Reusing Modal avoids a new dependency, keeps bundle size flat, and matches established interaction patterns (AboutDialog, UpdateDialog). The header button + empty-state CTA both open the same Modal — single mount point, single open/close state, no anchoring math.

## Rejected Alternatives

- **Popover from Sidebar's Start Run button.** Rejected because sibling boundary says Sidebar is touchable only with caveats, and TASK-687 owns Sidebar geometry. Keeping the trigger inside CyboflowRoot eliminates coupling.
- **Add a true anchored-popover primitive (Radix).** Rejected to keep scope small and avoid a new dependency.
- **Absorb WorkflowPicker entirely into RunView's empty state.** Rejected because IDEA explicitly wants picker reachable from a header affordance too.
- **Render the empty-state CTA inside RunView.** Rejected because RunView is read-only here and empty state is conceptually a shell concern.

## Lowest Confidence Area

The Playwright spec update. Locator collisions are possible; if `button:has-text("Choose a workflow")` collides, swap to `data-testid="open-workflow-picker"`. Unit-test mocks are async — Test 4 may need `await screen.findByRole(...)` rather than `getByRole`.
