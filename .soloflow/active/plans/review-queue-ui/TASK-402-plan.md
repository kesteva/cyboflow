---
id: TASK-402
idea: IDEA-009
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
  - frontend/src/App.tsx
  - frontend/src/components/ErrorBoundary.tsx
files_readonly:
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/components/Sidebar.tsx
  - frontend/src/components/SessionView.tsx
  - shared/types/approvals.ts
  - docs/cyboflow_system_design.md
acceptance_criteria:
  - criterion: "`<ReviewQueueView />` component exists and renders the current queue from reviewQueueStore as a vertical list"
    verification: "grep -n 'ReviewQueueView\\|useReviewQueueStore' frontend/src/components/ReviewQueueView.tsx returns matches; component exports a default React functional component"
  - criterion: "ReviewQueueView is mounted in App.tsx as an always-visible left rail (not hidden behind a tab) and is wrapped in an ErrorBoundary that renders 'Review queue error — restart app' fallback"
    verification: "grep -n 'ReviewQueueView' frontend/src/App.tsx returns at least one match inside a JSX expression; grep -n 'ErrorBoundary' frontend/src/App.tsx shows it wrapping the ReviewQueueView; running the app shows the rail visible on first paint"
  - criterion: "ErrorBoundary supports a custom fallback that renders a queue-specific recovery message including 'Review queue error' text"
    verification: "grep -n 'Review queue error' frontend/src/App.tsx returns one match (the fallback string passed to ErrorBoundary)"
  - criterion: "Empty-state UI shows 'No pending approvals' text when queue.length === 0"
    verification: "grep -n 'No pending approvals' frontend/src/components/ReviewQueueView.tsx returns a match"
  - criterion: Component calls reviewQueueStore.init() once on mount
    verification: "grep -n 'init\\(\\)\\|useEffect' frontend/src/components/ReviewQueueView.tsx returns a useEffect that invokes init exactly once (empty deps array)"
  - criterion: Layout reserves a fixed-width left rail (320-400px) for the queue; the rail is independent of the existing Sidebar component (which stays as-is)
    verification: "grep -n 'w-\\[3\\|w-\\[4\\|width:' frontend/src/components/ReviewQueueView.tsx returns a Tailwind width class or inline style; visual inspection confirms the rail is always visible"
depends_on:
  - TASK-401
estimated_complexity: medium
epic: review-queue-ui
test_strategy:
  needed: true
  justification: "Component has branching render paths (empty, populated, error fallback) and a lifecycle effect — render tests catch regressions cheaply"
  targets:
    - behavior: "Renders 'No pending approvals' when queue is empty"
      test_file: frontend/src/components/__tests__/ReviewQueueView.test.tsx
      type: component
    - behavior: Renders one card per approval in queue
      test_file: frontend/src/components/__tests__/ReviewQueueView.test.tsx
      type: component
    - behavior: "ErrorBoundary custom fallback shows 'Review queue error — restart app' on simulated child throw"
      test_file: frontend/src/components/__tests__/ReviewQueueView.test.tsx
      type: component
---
# ReviewQueueView Shell + Always-Visible Left Rail + ErrorBoundary Wrap

## Objective

Build the shell `<ReviewQueueView />` component, mount it as an always-visible left rail in `App.tsx`, and wrap it in a React error boundary with a queue-specific fallback. This is the load-bearing UI surface of the entire product per IDEA-009 slice 1 and system design §5.7. The component reads from `reviewQueueStore`, renders an empty-state when there are no pending approvals, and delegates per-item rendering to a placeholder card stub (`<PendingApprovalCard />` is implemented in TASK-403). Slice 11's error boundary requirement is folded in here because the wrapping and the view's mount point are the same edit.

## Implementation Steps

1. Create `frontend/src/components/ReviewQueueView.tsx`:
   - Functional component, default-exported.
   - Subscribes to `reviewQueueStore` via Zustand selector: `const queue = useReviewQueueStore(s => s.queue)`.
   - Calls `useReviewQueueStore.getState().init()` inside a `useEffect(() => { ... }, [])`.
   - Renders a `<div>` with Tailwind classes: `w-[360px] h-full flex flex-col border-r border-border-primary bg-bg-secondary overflow-y-auto`.
   - Renders a header: `<div class="px-4 py-3 border-b border-border-primary"><h2 class="text-sm font-semibold text-text-primary">Review Queue</h2><span class="text-xs text-text-muted">{queue.length} pending</span></div>`.
   - Empty state: when `queue.length === 0`, render `<div class="flex-1 flex items-center justify-center text-text-muted text-sm">No pending approvals</div>`.
   - Populated state: render `queue.map(a => <PendingApprovalCard key={a.id} approval={a} />)`. For this task, `<PendingApprovalCard />` may be a placeholder stub that renders `{approval.toolName}` — full implementation is TASK-403.
2. Create the placeholder stub `frontend/src/components/PendingApprovalCard.tsx` if it does not exist yet (TASK-403 will replace it with the full impl). Minimal: takes `{ approval: Approval }` prop, renders a `<div>` with the tool name. NOTE: do NOT add this to `files_owned` here — TASK-403 owns that file. Reference it via import only; if the file does not exist when this task is executed, leave a TODO and TASK-403 will create it.
3. Modify `frontend/src/components/ErrorBoundary.tsx`: the existing implementation already supports a `fallback` prop. No code change needed — just confirm. If a change is needed (e.g., make the fallback receive an explicit `retry` callback), do so additively.
4. Modify `frontend/src/App.tsx`:
   - Import `ReviewQueueView` and `ErrorBoundary`.
   - In the main JSX layout (the `<div className="h-screen flex overflow-hidden bg-bg-primary">` container), insert the queue rail BEFORE the existing `<Sidebar />`:
     ```tsx
     <ErrorBoundary fallback={(error) => (
       <div className="w-[360px] h-full flex items-center justify-center p-4 border-r border-border-primary bg-bg-secondary">
         <div className="text-center">
           <p className="text-sm text-status-error font-semibold mb-2">Review queue error — restart app</p>
           <p className="text-xs text-text-muted">{error.message}</p>
         </div>
       </div>
     )}>
       <ReviewQueueView />
     </ErrorBoundary>
     ```
   - The existing `<Sidebar />` and `<SessionView />` stay; the queue rail is additive to the left.
5. Write component tests in `frontend/src/components/__tests__/ReviewQueueView.test.tsx`:
   - Mock the store to return an empty queue → assert `getByText('No pending approvals')`.
   - Mock the store to return 3 approvals → assert 3 PendingApprovalCard-equivalent nodes (test against the stub or use a data-testid).
   - Render the App with a ReviewQueueView that throws on first render → assert `getByText(/Review queue error/)`.

## Acceptance Criteria

- Always-visible left rail showing the queue.
- Empty state renders "No pending approvals".
- Init is called exactly once on mount.
- ErrorBoundary wraps the view; on child throw, the fallback shows "Review queue error — restart app" and the rest of the app stays usable.

## Test Strategy

Three component tests (above). Test setup uses React Testing Library + Vitest (or whatever the codebase uses — check `frontend/package.json` and existing test files for the pattern). If no component test infrastructure exists, the test-writer agent will scaffold one as part of this task's verification — but the test scaffold cost should be a few lines, not a refactor.

## Hardest Decision

**Where to mount the queue: a) inside Sidebar, b) replacing Sidebar, c) as a separate rail to the left of Sidebar.** User-needs research §3 / IDEA-009 frontmatter both want the queue "never hidden during normal operation." Crystal's Sidebar is the session navigator and would become cluttered if the queue shared it. Replacing Sidebar removes session nav. The chosen approach (c — separate rail) preserves existing Crystal session UX (the cuts in `crystal-cuts` epic will trim Sidebar separately) while making the queue first-class. Tradeoff: 360px of horizontal real estate. The IDEA assumption explicitly calls out 1366px-min displays for self-host verification; 360 + sidebar (~500) + main content leaves enough but is tight on small screens. Self-host day will validate.

## Rejected Alternatives

- **Tab inside SessionView.** Hidden by default = misses the slice 1 requirement "never hidden during normal operation."
- **Modal/overlay triggered by hotkey.** Same — invisible until summoned, violates the always-visible thesis.
- **Mount queue inside ErrorBoundary at the App.tsx root (no per-rail fallback).** Rejected because a queue crash should not blank the entire app — the rest of Crystal's UI (sessions, terminals) should keep working. The per-rail fallback achieves this.

What would change my mind: if the 1366px width test fails during self-host (verify in IDEA-009's assumption), shrink to 280px or move to a collapsible-but-default-expanded pattern.

## Lowest Confidence Area

The Sidebar component is from the inherited Crystal codebase and is being trimmed by a separate epic (`crystal-cuts`). The queue rail's placement and styling may need to coordinate with that work to avoid visual conflict. If executed before crystal-cuts, the layout may look cluttered (Sidebar still shows Crystal's full session UI). This is acceptable — the queue should ship visible even if the rest of the UI is mid-transition.
