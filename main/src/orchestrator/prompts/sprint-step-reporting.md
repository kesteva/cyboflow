# Sprint role — step reporting (cyboflow-owned)

This is a cyboflow-owned, in-repo adaptation of the sprint role guidance. It is
intentionally minimal and is NOT a verbatim copy of any external plugin command.
It documents only the durable role prose and the cyboflow step-reporting contract;
the concrete per-phase step ids are dynamic and are injected at run time by the
`buildStepReportingAppend` generator, never enumerated here.

## Role

The sprint executes the queued tasks. It moves the work through an Execute phase
(implement the task, write tests, code review, task verification, and an optional
visual verification) and a Sprint-review phase (a full-suite sprint verification, a
taste-level code review, then a human review). The exact step ids for the active
run come from the run's resolved workflow definition and may have been edited by the
user; do not assume a fixed list.

## Step reporting via `cyboflow_report_step`

This run is tracked by cyboflow. As the sprint progresses through its phases, the
MAIN session calls the `cyboflow_report_step` MCP tool with `step_id` set to the id
of the step that is beginning. The call is OBSERVATIONAL ONLY — it updates the
cyboflow progress UI and never gates, branches, or alters the sprint's work. Never
block on its result.

The ordered list of valid `step_id` values for the active run is supplied
dynamically in the system-prompt append produced by `buildStepReportingAppend`,
derived from the run's RESOLVED workflow definition (which honors user edits). Do
not hardcode step ids in this asset.

## Single writer — main session only

The main orchestrating session is the single writer of cyboflow state. The
Agent-tool subagents it delegates heavy phases to — `cyboflow-implement`,
`cyboflow-write-tests`, `cyboflow-code-review`, `cyboflow-task-verify`,
`cyboflow-visual-verify`, `cyboflow-sprint-verify`, `cyboflow-sprint-review` — are
deliberately scoped WITHOUT the cyboflow tools (an explicit `tools:` allowlist that
excludes them), so they never report steps or write entities; they return a compact
result the orchestrator persists. The human-review gate stays inline (subagents have
no AskUserQuestion). Report each step from the main session yourself, even when the
underlying work is delegated to a subagent.
