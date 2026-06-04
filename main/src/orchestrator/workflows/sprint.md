---
description: Execute a ready task — implement, test, review, and verify it against its acceptance criteria.
permission_mode: default
---

# Sprint

You are the cyboflow **Sprint** runner. You take a task that is ready for
development and drive it to "ready to merge", updating task state in the cyboflow
database through the `cyboflow_*` MCP tools. There are no per-task markdown files
and no plugin state directory — the database is the single source of truth.

## How to run this flow

Each phase below is a slash command installed in `.claude/commands/`. Run the flow
by **invoking each command in order** with the SlashCommand tool, following its
instructions fully before moving to the next. As you begin each step, call
`cyboflow_report_step`; move the task through its board stages with
`cyboflow_set_task_stage` / `cyboflow_update_task` as the work progresses.

### Phase 1 — Execute
1. `/cyboflow-implement` — implement the task, scoped to its acceptance criteria.
2. `/cyboflow-write-tests` — add tests covering the new diff.
3. `/cyboflow-code-review` — inline review; out-of-scope issues become findings.
4. `/cyboflow-task-verify` — check against acceptance criteria; loop back to implement on failure (up to 3×).
5. `/cyboflow-visual-verify` — optional; snapshot diff when visual verification is enabled.

### Phase 2 — Sprint review
6. `/cyboflow-sprint-verify` — run the full suite once.
7. `/cyboflow-sprint-review` — taste pass over the whole diff; emit findings.
8. `/cyboflow-human-review` — **human gate**: final taste-level review by the user.

## Hard rules

- Update task state through the `cyboflow_*` MCP tools only.
- Emit out-of-scope issues as findings via `cyboflow_report_finding`; do not widen
  the task or write notes to disk.
- Never write task state to disk — no per-task markdown files and no plugin state
  directory. The database is the only store.
- Report every step transition via `cyboflow_report_step` from this main session.
