---
id: TASK-680
sprint: SPRINT-027
epic: standalone-terminal-panels
status: done
summary: "Extracted useAddTerminalPanel hook; consolidated handleAddTerminal duplication in SessionView and ProjectView. SessionView preserves addToHistory side-effect via onAfterActivate option."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_unable
---

# TASK-680 — Done

## What changed
- frontend/src/hooks/useAddTerminalPanel.ts (new): shared hook with UseAddTerminalPanelSession + UseAddTerminalPanelOptions; memoized callback; null-session guard with logTag-prefixed console.warn.
- frontend/src/components/SessionView.tsx: replaced inline useCallback with `useAddTerminalPanel(activeSession, { onAfterActivate: addToHistory, logTag: 'SessionView' })`.
- frontend/src/components/ProjectView.tsx: replaced inline useCallback with `useAddTerminalPanel(mainRepoSession, { logTag: 'ProjectView' })`.
- frontend/src/hooks/__tests__/useAddTerminalPanel.test.tsx (new): 11 tests using vi.hoisted() for mock refs.

## Verification
- Frontend tests: 259/259 pass.
- Typecheck + lint: pass.

## Commits
- 0e944cb feat(TASK-680): extract useAddTerminalPanel hook, migrate SessionView and ProjectView
- 4572162 test(TASK-680): add unit tests for useAddTerminalPanel hook
