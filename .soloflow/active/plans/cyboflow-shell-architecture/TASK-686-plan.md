---
id: TASK-686
idea: IDEA-017
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - docs/SHELL-LAYOUT.md
  - frontend/src/App.tsx
files_readonly:
  - frontend/src/components/ReviewQueueView.tsx
  - docs/cyboflow_system_design.md
acceptance_criteria:
  - criterion: "docs/SHELL-LAYOUT.md exists and documents the three-column shell geometry (ReviewQueueView left rail, Sidebar second column, CyboflowRoot main area)"
    verification: "test -f docs/SHELL-LAYOUT.md && grep -q 'ReviewQueueView' docs/SHELL-LAYOUT.md && grep -q 'Sidebar' docs/SHELL-LAYOUT.md && grep -q 'CyboflowRoot' docs/SHELL-LAYOUT.md"
  - criterion: "docs/SHELL-LAYOUT.md cross-references docs/cyboflow_system_design.md §5.7 (review queue spec)"
    verification: "grep -E '(5\\.7|§5\\.7|Section 5\\.7)' docs/SHELL-LAYOUT.md"
  - criterion: "docs/SHELL-LAYOUT.md documents the four deferred decisions so TASK-687 through TASK-692 can cite it"
    verification: "grep -q 'TASK-687' docs/SHELL-LAYOUT.md && grep -q 'TASK-688' docs/SHELL-LAYOUT.md && grep -q 'TASK-690' docs/SHELL-LAYOUT.md && grep -q 'TASK-692' docs/SHELL-LAYOUT.md"
  - criterion: "frontend/src/App.tsx contains a code comment that references docs/SHELL-LAYOUT.md near the ReviewQueueView/Sidebar/CyboflowRoot mount site"
    verification: "grep -n 'docs/SHELL-LAYOUT.md' frontend/src/App.tsx"
  - criterion: "App.tsx edit is comment-only — no JSX, hook, or import changes"
    verification: "git diff frontend/src/App.tsx | grep -E '^[-+]' | grep -vE '^[-+]{3}' | grep -vE '^[-+]\\s*(//|\\*|/\\*|\\{/\\*|$)' returns no lines"
  - criterion: "pnpm typecheck passes"
    verification: "pnpm typecheck exits 0"
depends_on: []
estimated_complexity: low
epic: cyboflow-shell-architecture
test_strategy:
  needed: false
  justification: "Docs-only task plus a single comment-line edit in App.tsx. No runtime behavior, no exported symbols, no UI surface changes. Acceptance is doc-content and comment-presence checks; pnpm typecheck guards the App.tsx edit against accidental syntax breakage."
---

# Settle shell layout: lock review queue as left rail and define column geometry

## Objective

Record the cyboflow shell's resolved column geometry in `docs/SHELL-LAYOUT.md` so downstream cyboflow-shell-architecture tasks (TASK-687 through TASK-692) have a single source of truth to reference. The geometry — `ReviewQueueView` as permanent left rail, Crystal `Sidebar` as second column (for now), `CyboflowRoot` as main area — is already what `frontend/src/App.tsx:383-431` ships; this task simply removes the "left rail or top tab" open question by writing the decision down and adding one comment in App.tsx that points future readers at the doc. No visual change, no behavioral change.

## Implementation Steps

1. Read `frontend/src/App.tsx` lines 370-435 to confirm the current mount order is `ReviewQueueView` (line 383) → `Sidebar` (line 385) → `CyboflowRoot` or `SessionView` (lines 395-431).
2. Read `docs/cyboflow_system_design.md` §5.7 (line 206) to lift the canonical product framing for the left-rail rationale.
3. Create `docs/SHELL-LAYOUT.md` with the structure below. The doc MUST:
   - Name all three column components verbatim: `ReviewQueueView`, `Sidebar`, `CyboflowRoot`.
   - Cite the §5.7 cross-reference exactly as `§5.7`.
   - Include explicit references to `TASK-687`, `TASK-688`, `TASK-690`, and `TASK-692` in the deferred-decisions section.
   - Document the assumption order: review queue rail is load-bearing; sidebar adjusts to fit; main area gets remainder.
4. In `frontend/src/App.tsx`, locate the existing comment block at lines 392-394 and extend it (or add a sibling comment immediately above the `<div className="flex flex-1 overflow-hidden">` at line 374) with: `{/* Shell geometry (ReviewQueueView | Sidebar | CyboflowRoot) is documented in docs/SHELL-LAYOUT.md. */}`. Do NOT modify any JSX element, prop, hook, import, or other non-comment line.
5. Run `pnpm typecheck`.
6. Run `grep -n 'docs/SHELL-LAYOUT.md' frontend/src/App.tsx` and `test -f docs/SHELL-LAYOUT.md` as self-checks.

### docs/SHELL-LAYOUT.md content template

```markdown
# Cyboflow Shell Layout

Status: locked as of TASK-686 (IDEA-017, epic `cyboflow-shell-architecture`).

## Column geometry

| Column        | Component         | Width   | Role                                                |
|---------------|-------------------|---------|-----------------------------------------------------|
| Left rail     | `ReviewQueueView` | ~360 px | Cross-workflow human review queue (LOAD-BEARING).   |
| Second column | `Sidebar`         | ~256 px | Project tree (Crystal-derived; remodeled in TASK-687). |
| Main area    | `CyboflowRoot`    | flex-1  | Run mount point — hosts the active workflow run.    |

The `ReviewQueueView` left rail is the differentiator surface described in
`docs/cyboflow_system_design.md` §5.7 (Human Review Queue).

## Assumption order

1. Review queue rail is load-bearing; width/position are fixed first.
2. Project sidebar takes the next-widest band of fixed width.
3. `CyboflowRoot` gets the remaining horizontal space via `flex-1`.

## Deferred decisions (resolved by downstream tasks in this epic)

- **Sidebar info model — TASK-687.** Default: project > workflow runs (newest first).
- **CyboflowRoot disposition — TASK-688.** Default: survives as RunView mount point; `WorkflowPicker` relocates.
- **Legacy `useLegacyCrystalView` toggle and `SessionView` branch — TASK-690.** Default: retire.
- **Crystal-era session descendants — TASK-691.** Default: delete after toggle is retired.
- **Legacy Crystal DB tables — TASK-692.** Default: drop via reconcile migration (option C — Crystal-session subgraph only).

## Cross-references

- Product framing: `docs/cyboflow_system_design.md` §5.7.
- Current mount site: `frontend/src/App.tsx` lines 374-432.
- Epic: `.soloflow/active/plans/cyboflow-shell-architecture/EPIC-cyboflow-shell-architecture.md`.
```

## Acceptance Criteria

See frontmatter.

## Test Strategy

No new tests. Comment edit and markdown file; acceptance is doc-content and comment-presence checks; `pnpm typecheck` guards the App.tsx edit.

## Hardest Decision

Whether App.tsx should be `files_owned` or `files_readonly`. The skeleton's `files_readonly_hint` listed App.tsx, but the IDEA body explicitly mandates a comment annotation. Resolution: promote App.tsx to `files_owned` with a tightly scoped comment-only edit. Sibling DAG confirms this is safe — TASK-687 owns Sidebar internals, TASK-688 owns CyboflowRoot, TASK-690 owns the legacy toggle. None touches the comment above the `ReviewQueueView` mount.

## Rejected Alternatives

- **Keep App.tsx strictly readonly and skip the in-code comment.** Rejected — IDEA explicitly requires a comment reference.
- **Write the layout doc inline as a comment at the top of App.tsx instead of a separate markdown file.** Rejected — IDEA names `docs/SHELL-LAYOUT.md` as the artifact; markdown is cleaner for cross-task citation.
- **Defer the App.tsx comment to TASK-687.** Rejected — TASK-687's scope is Sidebar info model; bundling unrelated comment edit would muddy that task's diff.

## Lowest Confidence Area

Whether the comment-only diff AC is robust against JSX comment syntax. JSX comments use `{/* … */}`; the AC regex must tolerate that form. If it surfaces friction, the resolution is to place the comment on its own line as a plain `/* … */` (allowed in TSX outside JSX trees) or to widen the AC verification regex.
