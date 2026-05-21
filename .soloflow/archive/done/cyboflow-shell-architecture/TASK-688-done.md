---
id: TASK-688
sprint: SPRINT-028
epic: cyboflow-shell-architecture
status: done
summary: "Reshaped CyboflowRoot: removed permanent aside, moved WorkflowPicker into a Modal triggered from a header button and an empty-state CTA. Widened projectId to number|null. Added onWorkflowStarted callback. 4 new component tests + Playwright spec update."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: skipped_unable
visual_macos: skipped_unable
---

# TASK-688 — done

## Commits
- 99fab95 feat(TASK-688): reshape CyboflowRoot — WorkflowPicker into modal, drop aside
- db1691a test(TASK-688): add CyboflowRoot component tests (4 behaviors)
- a190f31 test(TASK-688): update cyboflow-picker Playwright spec for modal architecture

## Changes
- frontend/src/components/cyboflow/CyboflowRoot.tsx — full rewrite: flex-col shell, header button, conditional empty-state CTA / RunView, Modal-wrapped WorkflowPicker, projectId widened to number|null
- frontend/src/components/cyboflow/WorkflowPicker.tsx — added optional onWorkflowStarted?: (runId: string) => void; invoked after setActiveRun
- frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx — new (4 tests: empty state, RunView render, modal open/close, modal auto-close)
- tests/cyboflow-picker.spec.ts — updated to call openPicker() before select; new "Choose a workflow to start" empty-state CTA test; skip-guard preserved

## Verifier
APPROVED_WITH_DEFERRED — AC1..AC9 MET (269 frontend tests pass, typecheck/lint clean). AC10 (no new console warnings in cyboflow-frontend-debug.log) deferred — visual_web/visual_macos both skipped_unable (Vite renderer cannot bootstrap standalone per CLAUDE.md; Peekaboo Accessibility not granted). Tracked under existing dedup_key visual_web_electron_unreachable.

## Code review
Skipped — sprint-level aggregate review (Step 3.6) will cover.

## Tests
TESTS_WRITTEN — 4 new component tests in CyboflowRoot.test.tsx; Playwright spec updated to match modal architecture.
