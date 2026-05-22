---
id: TASK-693
sprint: SPRINT-032
epic: standalone-terminal-panels
status: done
summary: "Wire +Terminal/+Claude PanelTabBar surface and Cmd+Shift+C shortcut into CyboflowRoot (Option B); extract shared useEnsureClaudePanel hook from ProjectView."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-693 — Done

## Changes
- New shared hooks: `useEnsureClaudePanel` (find-or-create) + `useAddClaudeShortcut` (Cmd/Ctrl+Shift+C).
- `PanelTabBarProps.onAddClaude` + `+ Claude` button next to `+ Terminal` in the trailing-action row.
- `ProjectView` refactored to call the shared hook (behavior-equivalent — preserves legacy escape hatch until TASK-690/691 ship).
- `CyboflowRoot` gained a PanelTabBar + PanelContainer panel surface below the run/empty-state region (Option B). Main-repo session resolution + panel:created subscription added.
- Unit tests: 12 for `useEnsureClaudePanel`, 13 for `useAddClaudeShortcut`. `CyboflowRoot.test.tsx` mocks extended; existing 4 cases still green.
- Playwright: 3 new cases in `tests/standalone-terminal-panels.spec.ts` (Add Terminal, Add Claude, Add Claude idempotency).

## Verification
- Verifier: APPROVED_WITH_DEFERRED. visual_mobile skipped (config), visual_web/macos skipped_unable (pnpm dev not running).
- Code review: CLEAN. One minor finding (`FIND-SPRINT-032-1`) queued for compound — `useEnsureClaudePanel` deps array uses `session?.id + eslint-disable` instead of `session` like the sibling hook.
- Tests: 304/304 frontend pass. `pnpm typecheck` and `pnpm lint` both 0 errors.

## Deferred
- Manual visual contract walkthrough (queued in `human-review-queue.md` under `actions`/`testing`) — requires `pnpm dev`.

## Commits
- 360809c feat(TASK-693): add shared useEnsureClaudePanel hook
- d4c7478 feat(TASK-693): add useAddClaudeShortcut hook
- 8bf3ccd feat(TASK-693): extend PanelTabBar with onAddClaude
- 88803c1 refactor(TASK-693): migrate ProjectView to shared hooks
- d2fee49 feat(TASK-693): wire PanelTabBar surface into CyboflowRoot
- 2a85a8d test(TASK-693): add Playwright cases for CyboflowRoot affordances
