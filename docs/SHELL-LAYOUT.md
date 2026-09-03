# Cyboflow Shell Layout

Status: locked as of TASK-686 (IDEA-017, epic `cyboflow-shell-architecture`).
Updated by the Protoflow UI refresh: human review folded into the rail (see below).
Column-geometry table's Main-area row re-verified 2026-08-30 against `frontend/src/App.tsx`'s
center-surface branch chain and `frontend/src/components/landing/LandingHome.tsx`; the rest of
this doc was not re-checked on that pass.

## Column geometry

| Column     | Component                          | Width      | Role                                                                 |
|------------|------------------------------------|------------|----------------------------------------------------------------------|
| Left rail  | `Sidebar` (agent rail)             | resizable  | Project tree + sessions, a **Human review** primary item with pending-count badge, and the user footer (avatar · settings). |
| Main area  | `CyboflowRoot` **or** `LandingHome` | flex-1 | Run surface (CyboflowRoot) by default; swaps to `LandingHome` with `focusQueue={showHumanReview}` (scrolling to its embedded `TypeGroupedQueue`) when the rail's Human-review item is active. `ReviewQueueView.tsx` still exists but is no longer mounted anywhere in production — kept alive only by its own test. |

The human-review queue is the differentiator surface described in
`docs/cyboflow_system_design.md` §5.7. Per the Protoflow refresh it is no longer a
standing ~360px left column; it is reached via the rail's **Human review** item,
which swaps the center to a full-width review pane (App-level `showHumanReview`
state). The review queue store is initialised at the App-shell level
(`useReviewQueueStore.getState().init()` in `App.tsx`) so the rail badge and the
macOS dock badge stay live even when the pane is unmounted.

The center surface has since grown further rail-driven overlay panes not captured in
the table above — Insights, Workflows, Verify Queue, Experiment Comparison, and the
task Backlog — so treat the table as illustrative, not exhaustive; the branch chain under
the "Center-surface state machine" comment in `App.tsx` is the current list (the comment
itself enumerates only the main branches).

**Onboarding shell states.** The first-run tour has three shell states, read by `App.tsx`
from `frontend/src/utils/onboarding.ts`:

1. *Hidden* (`isOnboardingShellHidden(state)` — true while the persisted snapshot read is
   unresolved, or `status === 'active'` on a step before the project exists, 0-8). The whole
   row above (Sidebar, center surface, AgentRail) plus `StatusBar` is NOT mounted; the row is
   swapped for `OnboardingShellSurface` — a bare `bg-bg-primary` container
   (`data-testid="onboarding-shell"`) that renders `onboarding/guided/GuidedSetupSurface` on
   the two project screens (7-8) and nothing on the modal ones, whose card comes from
   `<OnboardingGate/>`'s body portal (mounted outside the swap, as are the dialog siblings).
   `TitleBar` stays mounted throughout, which is why the guided screens render inside the row
   rather than in the portal: the native drag region has to keep working.
2. *Sidebar* (`onboardingGuidedShell(state) === 'sidebar'`, steps 9-11): the project exists,
   so the real shell mounts — the Sidebar (wrapped in a `display:contents` div,
   `data-testid="shell-sidebar-slot"`; it stays CLICKABLE, and navigating through it parks the
   tour via `onboarding/guided/guidedNavPause.ts` — resumable from the Sidebar "Resume setup"
   card), `GuidedSetupSurface` in the CENTER slot in place of the view switch, no AgentRail,
   `StatusBar` below. Steps 10-11 host
   the real global-assistant thread in that center column.
3. *Full* (`'full'`, steps 12-14): as above plus the AgentRail — it mounts exactly at the "meet
   the assistant" step over the same conversation and stays through the finale, so the tour →
   shell transition never remounts it.

"Skip the set-up" on an in-shell step PARKS the tour (`leaveGuidedSetup` → store `skip()`, status
`skipped`) with the same shell frame and landing as the finale; the Sidebar "Resume setup" card
brings it back at the same step (warm `resume()`). Every completing exit runs
`onboarding/guided/guidedFinish.ts`: stage the shell's
first frame (AgentRail forced expanded; the one-shot assistant greeting primed only when the
thread never held a conversation), stamp the active project, `navigationStore.openHumanReview()`
(or the launched session for step 14's "Open the session"), then flip the store to `completed`.
The bare-paper exits (7-8 "Skip the set-up") stage the same frame BEFORE the `completed`
transition because every one of those values is read by a mount that only happens once the
shell comes back.

"Not sure yet" on step 7 is NOT an exit: the store skips step 8 and walks into the same in-shell
states with `guidedProject` null, and the screens render their no-project variants ("Your
projects will live here", "What do you want to get done with Cyboflow?", "Here's how Cyboflow
can help", a read-only preview of the session types whose only exit is "Finish set-up"). The
finale then has no project to stamp or navigate to, so it lands on LandingHome's empty state;
step 14 is never reached on that branch.

## Assumption order

1. The agent rail (Sidebar) is leftmost; the title bar (38px) spans above the row.
2. The center takes the remaining horizontal space via `flex-1` and hosts either
   the run surface or the full-width human-review pane.

## Deferred decisions (epic history)

- **Sidebar info model — TASK-687.** Done: sidebar remodeled to project > workflow runs (newest first).
- **CyboflowRoot disposition — TASK-688.** Done: CyboflowRoot survives as the run-surface mount point; `WorkflowPicker` relocated into a modal.
- **Legacy `useLegacyCrystalView` toggle and `SessionView` branch — TASK-690.** Done: toggle and render branch retired.
- **Crystal-era session descendants — TASK-691.** Done: `SessionView` and Crystal-era session descendants deleted.
- **Legacy Crystal DB tables — TASK-692.** Still open, status **blocked** (panelmanager-vs-tool-panels escalation: dropping the Crystal-session subgraph risks panel-co-tenant rows written by `addPanelOutput`/`addPanelConversationMessage`/`addPanelPromptMarker`).

## Cross-references

- Product framing: `docs/cyboflow_system_design.md` §5.7.
- Current mount site: the "Center-surface state machine" comment block in
  `frontend/src/App.tsx`.

## Navigation store contract

`CyboflowRoot` is mounted **only when `navigationStore.view === 'session'`** — the first
branch of the center-surface state machine (see Cross-references above). All other
`view` values (`'wizard'`, `'home'`) render the wizard or one of the rail-driven overlays
instead.

`navigateToSessions()` (`frontend/src/stores/navigationStore.ts`) is a **wide reset, not a
narrow one**: it sets `view: 'home'`, `activeView: 'sessions'`, `activeProjectId: null`,
and clears every overlay flag (`humanReviewOpen`, `backlogOpen`, `insightsOpen`,
`workflowsOpen`, `experimentComparisonId`, `verifyQueueOpen`) — nine fields in total.
Calling it while activating a run un-mounts `CyboflowRoot` immediately (REG-SPRINT-028-1),
and it also drops out of whatever overlay pane the user was in. Rules:

- Do NOT call `navigateToSessions()` in a click handler that also calls `setActiveRun()`.
  Use `setActiveProjectId(run.project_id)` or a dedicated `selectRun(runId, projectId)`
  action instead.
- When adding a new App-level mount condition, document it in this section.
