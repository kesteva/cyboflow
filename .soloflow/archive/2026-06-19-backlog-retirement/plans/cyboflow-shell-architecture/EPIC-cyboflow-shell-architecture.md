---
epic: cyboflow-shell-architecture
created: 2026-05-20T00:00:00Z
status: active
originating_ideas: [IDEA-017]
---

# Cyboflow Shell Architecture Migration

## Objective

Replace the dual-paradigm Crystal+Cyboflow shell with a unified cyboflow shell: `ReviewQueueView` as permanent left rail, a run-centric project sidebar, `CyboflowRoot`/`RunView` as the sole main area, and all Crystal-era session surfaces (`SessionView`, `CreateSessionDialog`, legacy DB tables) cleanly removed. The `useLegacyCrystalView` escape hatch in `App.tsx` is the last load-bearing thread of the Crystal shell; this epic cuts it cleanly after the new shell is fully wired.

## Scope

- In scope:
  - Locking the shell geometry (review queue as left rail, sidebar as second column) in `docs/SHELL-LAYOUT.md` (TASK-686)
  - Remodeling `DraggableProjectTreeView` to show project > workflow runs, newest first (TASK-687)
  - Reshaping `CyboflowRoot` to be RunView-only with `WorkflowPicker` relocated to a modal-popover (TASK-688)
  - Deleting `CreateSessionDialog`, `CreateSessionButton`, the legacy duplicate `ProjectTreeView`, and the Crystal session-creation triggers in `DraggableProjectTreeView`/`SetupTasksPanel` (TASK-689)
  - Retiring the `useLegacyCrystalView` toggle and the `SessionView` render branch in `App.tsx` (TASK-690)
  - Deleting `SessionView` and the descendant components/hooks whose only mount path was through SessionView (TASK-691)
  - Dropping the Crystal-era DB tables via reconcile-style migration `008_drop_legacy_crystal_tables.sql` (TASK-692; option C default — Crystal session subgraph only)

- Out of scope:
  - Review queue component internals — owned by the already-completed `review-queue-ui` epic.
  - Discord popup and other one-shot Crystal modals — owned by IDEA-016.
  - First-run onboarding polish — owned by `first-run-onboarding-and-self-host-acceptance`.
  - Retirement of `panelManager` / `tool_panels` / `claude_panel_settings` — TASK-692 explicitly preserves these under option C; their retirement is a separate future task contingent on the SDK-migration epic stabilizing.
  - Main-process session-only IPC handlers and their `electron.d.ts`/`api.ts` type declarations (orphaned-by-renderer but main-side handlers stay; follow-up sweep).

## Success Signal

The running app has a single shell: left rail (`ReviewQueueView`), sidebar (project > runs tree), main area (`CyboflowRoot` mounting `RunView`). No `Legacy view` toggle exists. No `CreateSession` dialog reachable. `sessions`, `session_outputs`, `conversation_messages`, `prompt_markers`, `execution_diffs` tables absent from the SQLite schema (option C). `pnpm typecheck`, `pnpm lint`, and `pnpm test` all exit 0. `git grep "useLegacyCrystalView"` and `git grep "SessionView"` both return zero matches in `frontend/src/`.
