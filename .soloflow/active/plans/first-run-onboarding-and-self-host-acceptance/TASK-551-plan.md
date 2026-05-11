---
id: TASK-551
idea: IDEA-012
idea_id: IDEA-012
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/components/OnboardingCard.tsx
  - frontend/src/components/OnboardingCard.test.tsx
files_readonly:
  - frontend/src/App.tsx
  - frontend/src/components/Welcome.tsx
  - main/src/ipc/app.ts
  - main/src/database/database.ts
acceptance_criteria:
  - criterion: "An OnboardingCard component renders inside ReviewQueueView when user_preferences key cyboflow_onboarding_dismissed is absent or not 'true'."
    verification: "grep -n 'OnboardingCard' frontend/src/components/ReviewQueueView.tsx returns at least one import and one JSX usage; OnboardingCard component file exists at frontend/src/components/OnboardingCard.tsx."
  - criterion: "Card text contains the exact phrase 'Cyboflow pauses Claude when it needs to take an action.' and lists keyboard shortcuts 'j/k navigate, y/n decide'."
    verification: "grep -n 'Cyboflow pauses Claude when it needs to take an action' frontend/src/components/OnboardingCard.tsx returns one match; grep -n 'j/k' frontend/src/components/OnboardingCard.tsx returns one match; grep -n 'y/n' frontend/src/components/OnboardingCard.tsx returns one match."
  - criterion: "Dismissing the card (clicking Got it button OR approving/rejecting any queue item) writes cyboflow_onboarding_dismissed='true' via preferences:set and unmounts the card."
    verification: "grep -n \"preferences:set.*cyboflow_onboarding_dismissed\" frontend/src/components/OnboardingCard.tsx returns one match; grep -n \"preferences:set.*cyboflow_onboarding_dismissed\" frontend/src/components/ReviewQueueView.tsx returns one match (on first decide)."
  - criterion: "After dismissal, reloading the renderer never shows the card again — the OnboardingCard mount effect short-circuits if preferences:get returns 'true'."
    verification: "Unit test in OnboardingCard.test.tsx: mock preferences:get to return {success:true, data:'true'}, assert the rendered output is null/empty."
  - criterion: "OnboardingCard is wrapped inside the existing ReviewQueueView error boundary (no separate boundary needed) — verify it lives below the ReviewQueueView ErrorBoundary in the JSX tree."
    verification: "Read frontend/src/components/ReviewQueueView.tsx; <OnboardingCard /> appears as a child of the ErrorBoundary wrapper, not as a sibling at App.tsx level."
depends_on: [TASK-525]
estimated_complexity: low
epic: first-run-onboarding-and-self-host-acceptance
test_strategy:
  needed: true
  justification: "State logic (preference read/write, one-shot dismissal) is non-trivial and is the criterion that defines 'one-time'. Without a unit test, regression-by-typo (writing the wrong preference key) is undetectable until a user complains."
  targets:
    - behavior: "Card hidden when preferences:get returns 'true'"
      test_file: "frontend/src/components/OnboardingCard.test.tsx"
      type: component
    - behavior: "Clicking Got it writes preferences:set with cyboflow_onboarding_dismissed='true'"
      test_file: "frontend/src/components/OnboardingCard.test.tsx"
      type: component
    - behavior: "First approval/rejection in queue auto-dismisses the card"
      test_file: "frontend/src/components/OnboardingCard.test.tsx"
      type: component
---

# First-Run Onboarding Card for the Review Queue

## Objective

Show first-time users a single dismissable card inside the ReviewQueueView explaining what the queue is, how Claude pauses behavior connects to it, and the j/k/y/n keyboard shortcuts. The card dismisses forever on first interaction (Got it click OR first approve/reject), persisted via the existing `preferences:set` / `preferences:get` IPC backed by the `user_preferences` table. This is a zero-cost UX addition that prevents the "why is Claude stopped?" confusion the user-needs research identified.

## Implementation Steps

1. Create `frontend/src/components/OnboardingCard.tsx`:
   - Functional component, no props (it self-manages its visibility via preferences IPC).
   - On mount, `await window.electron.invoke('preferences:get', 'cyboflow_onboarding_dismissed')`. If `result.data === 'true'`, set internal `dismissed` state to true and render `null`.
   - Card body: a Tailwind-styled `<div>` with heading "Welcome to Cyboflow", body text containing the exact phrase "Cyboflow pauses Claude when it needs to take an action. Approve or reject in this queue.", and a keyboard hint line "Keyboard: j/k navigate, y/n decide".
   - "Got it" button calls `dismiss()`, which fires `window.electron.invoke('preferences:set', 'cyboflow_onboarding_dismissed', 'true')` then sets local `dismissed = true`.
   - Export `dismissOnboarding()` named helper that also writes the preference — exported for ReviewQueueView to call when the user first approves/rejects.

2. Modify `frontend/src/components/ReviewQueueView.tsx`:
   - Import `OnboardingCard` and `dismissOnboarding`.
   - Render `<OnboardingCard />` at the top of the queue panel content, inside the existing ErrorBoundary, above the queue list.
   - In the approve and reject handlers, call `dismissOnboarding()` once per session (guard with a ref or module-level flag to avoid re-writing the preference on every decision).

3. Create unit tests in `frontend/src/components/OnboardingCard.test.tsx`:
   - Test 1: `preferences:get` mocked to return `{success:true, data:'true'}` → component renders nothing.
   - Test 2: `preferences:get` mocked to return `{success:true, data:undefined}` → component renders the welcome text. Click "Got it" → assert `preferences:set` was called with `('cyboflow_onboarding_dismissed', 'true')`.
   - Test 3: Render `<ReviewQueueView />` with `preferences:get` returning undefined and a fake pending approval; simulate `y` keypress → assert `preferences:set` called with the dismissal key.

4. Do not add the card to `App.tsx`. The card lives inside `ReviewQueueView` so it shares the queue's error boundary and is only seen when the user first looks at the queue.

## Acceptance Criteria

See frontmatter. The card must appear once, dismiss permanently, and never re-render after the preference is set.

## Test Strategy

Three component tests cover the visibility-by-preference branch, the explicit-dismiss branch, and the implicit-dismiss-on-first-decide branch. No backend changes required (the `preferences:*` IPC and `user_preferences` table already exist in the inherited Crystal codebase per CLAUDE.md).

## Hardest Decision

Where to mount the card. Two options considered:
- (a) Mount inside `<ReviewQueueView />` — what this plan picks.
- (b) Mount as a modal at `<App />` level alongside `<Welcome />`.

Picked (a) because the card is **about the review queue**, not the app at large. It should appear where the queue does, so users see it the first time they encounter pending approvals — not on initial app launch when they may not have any runs yet. This also avoids the `<Welcome />` versus `<OnboardingCard />` ordering puzzle in App.tsx (both wanting to be the "first" modal).

## Rejected Alternatives

- App-level modal (option b above). Rejected because of timing: the card should explain the queue at the moment the user first sees a pending approval, not at app launch when they have no context for it.
- Storing the dismissal flag in localStorage instead of `user_preferences`. Rejected because the user_preferences table already exists, is the established pattern (CLAUDE.md schema list), and survives renderer cache clears.

## Lowest Confidence Area

The auto-dismiss-on-first-decide UX choice. If the user is confused and accidentally hits `y` thinking it means something else, the card disappears before they read it. A "click anywhere on the card to dismiss" alternative is gentler. Re-evaluate after the self-host run — if the user reports never reading the card before it vanished, switch to explicit-Got-it-only.
