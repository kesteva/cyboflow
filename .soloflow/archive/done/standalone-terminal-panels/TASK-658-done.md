---
id: TASK-658
sprint: SPRINT-025
epic: standalone-terminal-panels
status: done
summary: "Added Add Terminal button to PanelTabBar; wired handleAddTerminal + useAddTerminalShortcut in ProjectView and SessionView with cwd routed from session.worktreePath"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-658: Add 'Add Terminal' button to PanelTabBar + wire createPanel

## Outcome

Added an `onAddTerminal?: () => void | Promise<void>` optional prop to `PanelTabBarProps`. `PanelTabBar` renders an Add Terminal button (Plus + Terminal icon, `aria-label="Add terminal panel"`) at the trailing edge when the prop is provided. Both `ProjectView` and `SessionView` define a `handleAddTerminal` `useCallback` that calls `panelApi.createPanel` with `type: 'terminal'` and `initialState: { cwd: <session.worktreePath> }`, then activates the new panel. Both views also call `useAddTerminalShortcut(handleAddTerminal)` (the hook itself comes from TASK-659 — a sibling worktree task in this same sprint).

## Changes

- `frontend/src/types/panelComponents.ts` — added `onAddTerminal?: () => void | Promise<void>` to `PanelTabBarProps`
- `frontend/src/components/panels/PanelTabBar.tsx` — added Plus to lucide-react import; added `handleAddTerminal` callback; restructured trailing container to include the button alongside gitBranchActions
- `frontend/src/components/ProjectView.tsx` — added `handleAddTerminal` + `useAddTerminalShortcut(handleAddTerminal)` + `onAddTerminal={handleAddTerminal}` prop pass
- `frontend/src/components/SessionView.tsx` — same pattern (includes `addToHistory`)
- `tests/standalone-terminal-panels.spec.ts` — new Playwright spec with 3 active cases + 1 documented skip

## Commits

- `6527193` — `feat(TASK-658): add onAddTerminal optional prop to PanelTabBarProps`
- `4c65a7d` — `feat(TASK-658): add Plus icon and Add Terminal button to PanelTabBar`
- `cb84cf1` — `feat(TASK-658): wire handleAddTerminal and useAddTerminalShortcut in ProjectView`
- `a5e2ab5` — `feat(TASK-658): wire handleAddTerminal and useAddTerminalShortcut in SessionView`
- `428167a` — `test(TASK-658): add Playwright spec for Add Terminal button`

## Verification

- pnpm typecheck: 2 expected TS2307 errors for missing `'../hooks/useAddTerminalShortcut'` — will resolve when TASK-659 merges (PARALLEL_EXECUTION_RESIDUE)
- pnpm lint: PASS (0 errors)
- Playwright spec: deferred — depends on TASK-657 and TASK-659 in sibling worktrees
- shadow-verifier verdict: APPROVED_WITH_DEFERRED (3 items deferred to sprint-level verifier)
- code-reviewer verdict: CLEAN
- test-writer: NO_TESTS_NEEDED (Playwright spec is the right level per plan)

## Deferred verification (queued in human-review-queue.md)

- Re-run pnpm typecheck on merged run branch to confirm the 2 TS2307 errors clear
- Run pnpm test -- tests/standalone-terminal-panels.spec.ts post-merge
- Visual: open project in pnpm dev, click Add Terminal, confirm PTY rooted at project path; repeat for session
