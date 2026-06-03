# Prune flow (preserved prose — deferred cyboflow-native rebuild)

> Preserved during the SoloFlow rip-out (P0). The `prune` workflow was dropped
> from `WORKFLOW_DEFINITIONS` because cyboflow v1 ships only the two user-facing
> flows (Planner + Sprint). This file keeps the original phase/step shape so a
> future cyboflow-native prune flow can be rebuilt against the DB-canonical
> entity model + `cyboflow_*` MCP tools (no `.soloflow/` state walk).

## Intent

Sweep stale / orphaned planning state and dead code, propose deletions for human
approval, then execute the approved cleanup. The original flow walked the
`.soloflow/` state directory; the native rebuild must instead reason over the
DB entity model (ideas / epics / tasks) and the working tree.

## Original phase / step shape

Phase **Prune** (`#8a4a4a`):

1. `scan` — agent `pruner` — Walks state for archived sprints, stale ideas,
   orphan tasks. (Native: query ideas/epics/tasks for terminal/orphaned rows.)
2. `propose` — agent `pruner` — Drafts a deletion plan with reasons. Nothing is
   removed yet.
3. `approve-prune` — agent `human` (human gate) — You confirm what gets deleted.
   Default is keep everything.
4. `execute-prune` — agent `pruner` — Removes approved entries and commits the
   cleanup.

## Native rebuild notes

- `scan` reads the entity tables instead of `.soloflow/`; orphans = tasks with
  no reachable epic/idea, ideas stuck in early stages, etc.
- `propose` should surface candidates as review-queue items (kind `decision`),
  resolved one-by-one rather than via a monolithic deletion plan file.
- Terminal exits (`wont_do` / `archived`) are already part of the board model,
  so most "pruning" becomes stage transitions through the chokepoint, not file
  deletion.
