---
id: TASK-748
sprint: SPRINT-037
epic: quick-session
status: done
summary: "Added Quick Session header button + inline Chat/Terminal mode picker + Cmd/Ctrl+Shift+S shortcut to CyboflowRoot; new useAddQuickSessionShortcut hook with 12 tests + 5 component tests."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-748 — Quick Session header button + shortcut

## What changed

- `frontend/src/hooks/useAddQuickSessionShortcut.ts` (new) — Cmd+Shift+S / Ctrl+Shift+S shortcut hook mirroring useAddClaudeShortcut/useAddTerminalShortcut (ref-pin pattern, focus guard, `enabled` escape hatch).
- `frontend/src/hooks/__tests__/useAddQuickSessionShortcut.test.ts` (new) — 12 tests covering Mac/Linux paths, modifier guards, focus guard, opts.enabled, cleanup on unmount.
- `frontend/src/components/cyboflow/CyboflowRoot.tsx` — added Quick Session button (`data-testid="open-quick-session-picker"`) next to "Choose workflow" with disabled+title when projectId===null; inline Chat/Terminal mode picker; Escape + outside-click dismissal via useEffect; registered the new shortcut.
- `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx` — `describe('CyboflowRoot — Quick Session', ...)` block: disabled state, Escape dismissal, Chat/Terminal IPC dispatch, failure-envelope handling.

## Code-review round

One IMPROVEMENTS_NEEDED cycle (review_retry_max=1 reached):
- `handlePickQuickMode` silently swallowed `{ success: false }` IPC envelopes — same silent-drop class as FIND-SPRINT-024-4. Fix in commit `3d2812a` inspects `result.success || !result.data` and `console.error`s on the failure path. A 17th test (`IPC failure envelope is logged...`) pins the behavior.
- Plan-deferred work (panel creation + `setActiveQuickSession` + navigation) was called out by reviewer as a minor known gap; remains a follow-up per IDEA-024's slice 3 scope.

## Verification

- L1 grep ACs: 9/9 met.
- L2 tests: 352/352 frontend tests pass (24 hook tests in the new file + extended CyboflowRoot block).
- L2 typecheck + lint: clean.
- L3 visual: not_applicable (sprint had no dev server running). Component tests cover render + click + escape + IPC dispatch + failure-envelope path at unit level.

## Notes for downstream

- The handler currently fires `createQuick` and dismisses the picker; it does NOT yet create a Claude/Terminal panel or call `setActiveQuickSession`. Per the plan's "Lowest Confidence Area" and the IDEA-024 slice 3 scope, that integration is a follow-up — TASK-747's `WorkflowPicker.handleQuickStart` is the reference pattern to mirror.
