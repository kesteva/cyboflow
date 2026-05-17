---
id: TASK-551
sprint: SPRINT-013
epic: first-run-onboarding-and-self-host-acceptance
status: done
summary: "Add OnboardingCard inside ReviewQueueView with j/k/y/n shortcut hint; dismisses permanently via cyboflow_onboarding_dismissed preference; lifted dismissed state to parent so y/n keypress also unmounts the card in-session."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-551 — First-run Onboarding Card

Delivered:

- `frontend/src/components/OnboardingCard.tsx` — functional component supporting both uncontrolled (self-managed dismissed state via preferences:get on mount) and controlled (parent-driven dismissed prop + onDismiss callback). Renders welcome card with exact phrase "Cyboflow pauses Claude when it needs to take an action. Approve or reject in this queue." plus keyboard hint "Keyboard: j/k navigate, y/n decide". Exports `dismissOnboarding()` helper that writes `cyboflow_onboarding_dismissed='true'` via `preferences:set`.
- `frontend/src/components/ReviewQueueView.tsx` — mounts `<OnboardingCard dismissed={onboardingDismissed} onDismiss={...} />` inside the existing App-level ErrorBoundary. Reads the preference at mount to seed state. Added one-shot y/n keydown listener (input-focus + empty-queue guards) that calls `dismissOnboarding()` then `setOnboardingDismissed(true)` so the card unmounts in-session.
- `frontend/src/components/OnboardingCard.test.tsx` — 3 component tests: preference='true' renders null, Got-it button writes preference, y keypress writes preference AND unmounts card (Round 2 fix).

Loop history:
- Round 1: verifier APPROVED. Code-reviewer IMPROVEMENTS_NEEDED — y/n keypress wrote the preference but did NOT unmount the card in the current session (violated AC#3 spirit).
- Round 2: executor lifted dismissed state into ReviewQueueView, made OnboardingCard support a controlled mode via `dismissed` prop + `onDismiss` callback. Re-verifier APPROVED. Two new follow-up findings logged: FIND-15 (mouse-clicking Approve/Reject does NOT auto-dismiss — Got-it + y/n only), FIND-16 (sub-perceptible flash for returning users while parent async-loads the preference).
