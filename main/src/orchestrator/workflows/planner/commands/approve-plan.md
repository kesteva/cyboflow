---
description: Planner Phase 2 · human gate — surface the full task plan for sign-off via AskUserQuestion.
---

As you begin this step, call `cyboflow_report_step` with `step_id` `approve-plan`.

Use the **AskUserQuestion** tool to surface the full task plan for sign-off (header
`Approve plan`, options Approve / Revise; put the scope, ordering, and acceptance
criteria in the option markdown preview). Do **not** proceed until the user answers
Approve — on approval the tasks become ready for a Sprint run.

This is a hard human gate.
