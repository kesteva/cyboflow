---
id: TASK-005
sprint: SPRINT-001
epic: crystal-cuts-and-rebrand
status: done
summary: "Removed Add Tool dropdown UI surface from PanelTabBar; preserved panels:create IPC handler, panelManager service, and tool_panels schema for backward compat."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-005 — Delete Multi-Panel-Per-Session UI Surfaces

## Commits

- `85dc598 feat(TASK-005): remove Add Tool dropdown and onPanelCreate UI surface from PanelTabBar`

## Changes

- `PanelTabBar.tsx`: deleted "Add Tool" dropdown JSX (~80 lines), removed `Plus`/`ChevronDown`/`PANEL_CAPABILITIES` imports, removed `onPanelCreate` prop, removed dropdown state and click-outside effect
- `panelComponents.ts`: removed `onPanelCreate` from `PanelTabBarProps` interface (scope deviation — required to remove the prop)
- `SessionView.tsx`: removed `onPanelCreate={handlePanelCreate}` prop pass and the `handlePanelCreate` callback
- `ProjectView.tsx`: removed `onPanelCreate={handlePanelCreate}` prop pass (kept the `handlePanelCreate` function — still used by `handleGitPull`/`handleGitPush`)

Backend preserved: `panels:create` IPC handler in `main/src/ipc/panels.ts`, `panelManager` service, `tool_panels` schema. Existing sessions with multiple panels still load.

## Verification

All 6 acceptance criteria passed (AC3 has known false-positive matching `onPanelCreated` event subscriptions — different identifier, documented). Code-review verdict: CLEAN.

## Carryover findings

- FIND-SPRINT-001-6 (resolved by reviewer): scope deviation modifying `panelComponents.ts` (`files_readonly`) judged structurally required.
- FIND-SPRINT-001-7 (minor): `handlePanelCreate` vs `handlePanelCreated` naming collision in `ProjectView.tsx`.
