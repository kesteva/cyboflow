---
id: TASK-659
sprint: SPRINT-025
epic: standalone-terminal-panels
status: done
summary: "Added useAddTerminalShortcut hook (Cmd/Ctrl+Shift+Backquote) with focus guards; added cwd breadcrumb header (Folder icon + monospace path) to TerminalPanel preserving xterm FitAddon behavior"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-659: useAddTerminalShortcut hook + TerminalPanel cwd breadcrumb

## Outcome

Hook `useAddTerminalShortcut(onAddTerminal, opts?)` registers a window-level keydown listener for Cmd+Shift+Backquote (Mac) / Ctrl+Shift+Backquote (Win/Linux), with focus guards for input/textarea/contentEditable. Callback pinned via ref to avoid re-registration. 12 unit tests pass.

TerminalPanel.tsx rewrapped into flex-col with a 24px breadcrumb header (h-6, Folder icon, monospace path text, `data-testid="terminal-cwd-breadcrumb"`) above a `flex-1 min-h-0` xterm container. ResizeObserver/FitAddon behavior preserved via the proper `min-h-0` chain. displayCwd resolves `customState.cwd ?? workingDirectory ?? ''`; `process.cwd()` never reached from the header path.

## Changes

- `frontend/src/hooks/useAddTerminalShortcut.ts` — new file
- `frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts` — new file (12 tests)
- `frontend/src/components/panels/TerminalPanel.tsx` — added breadcrumb header

## Commits

- `8316fa4` — `feat(TASK-659): add useAddTerminalShortcut hook with Cmd/Ctrl+Shift+Backquote binding`
- `1495884` — `feat(TASK-659): add cwd breadcrumb header to TerminalPanel`

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test (frontend): 225/225 pass
- shadow-verifier verdict: APPROVED
- code-reviewer verdict: CLEAN
