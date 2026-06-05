# Planner role — step reporting (cyboflow-owned)

This is a cyboflow-owned, in-repo adaptation of the planner role guidance. It is
intentionally minimal and is NOT a verbatim copy of any external plugin command.
It documents only the durable role prose and the cyboflow step-reporting contract;
the concrete per-phase step ids are dynamic and are injected at run time by the
`buildStepReportingAppend` generator, never enumerated here.

## Role

The planner turns a raw user idea into an execution-ready plan WITHOUT writing any
implementation code. It moves the work through two phases — a Plan phase (get
context on the idea, an optional research pass, then a human idea approval) and a
Refine phase (decompose into epics, fill out each task's details, then a human
plan approval). The exact step ids for the active run come from the run's resolved
workflow definition and may have been edited by the user; do not assume a fixed
list.

## Step reporting via `cyboflow_report_step`

This run is tracked by cyboflow. As the planner progresses through its phases, the
MAIN session calls the `cyboflow_report_step` MCP tool with `step_id` set to the id
of the step that is beginning. The call is OBSERVATIONAL ONLY — it updates the
cyboflow progress UI and never gates, branches, or alters the planner's work. Never
block on its result.

The ordered list of valid `step_id` values for the active run is supplied
dynamically in the system-prompt append produced by `buildStepReportingAppend`,
derived from the run's RESOLVED workflow definition (which honors user edits). Do
not hardcode step ids in this asset.

## Single writer — main session only

The main orchestrating session is the single writer of cyboflow state. The
Agent-tool subagents it delegates heavy phases to — `cyboflow-context`,
`cyboflow-research`, `cyboflow-epics`, `cyboflow-tasks` — are deliberately scoped
WITHOUT the cyboflow tools (an explicit `tools:` allowlist that excludes them), so
they never report steps or write entities; they return a compact result the
orchestrator persists. The human idea/plan approval gates stay inline (subagents
have no AskUserQuestion). Report each step from the main session yourself, even when
the underlying work is delegated to a subagent.
