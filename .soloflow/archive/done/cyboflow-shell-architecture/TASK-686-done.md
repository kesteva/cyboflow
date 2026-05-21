---
id: TASK-686
sprint: SPRINT-028
epic: cyboflow-shell-architecture
status: done
summary: "Created docs/SHELL-LAYOUT.md (three-column geometry: ReviewQueueView | Sidebar | CyboflowRoot) and added one comment in App.tsx pointing at it. Locks the deferred decisions for TASK-687..692."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-686 — done

## Commits
- 50f33d7 docs(TASK-686): add SHELL-LAYOUT.md and annotate App.tsx mount site
- bff39b5 docs(TASK-686): fix stale mount-site line range in SHELL-LAYOUT.md

## Changes
- docs/SHELL-LAYOUT.md — new; column table, assumption order, §5.7 cross-ref, deferred decisions for TASK-687/688/690/691/692
- frontend/src/App.tsx — single JSX comment at line 315 referencing the doc

## Verifier
APPROVED — all 6 ACs MET. Visual not applicable (no UI behavior change). FIND-SPRINT-028-4 (stale line range) flagged.

## Code review
IMPROVEMENTS_NEEDED → fixed in bff39b5. FIND-SPRINT-028-4 resolved by updating line 33 from 374-432 to 317-375 (the post-TASK-684/685 mount site).

## Tests
NO_TESTS_NEEDED — doc + comment task.
