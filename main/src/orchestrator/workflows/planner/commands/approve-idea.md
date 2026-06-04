---
description: Planner Phase 1 · human gate — surface the idea spec for sign-off via AskUserQuestion before refinement.
---

As you begin this step, call `cyboflow_report_step` with `step_id` `approve-idea`.

Use the **AskUserQuestion** tool to surface the idea spec for sign-off (header
`Approve idea`, options Approve / Revise / Reject; put the full spec in the option
markdown preview). Do **not** proceed to refinement until the user answers Approve.

This is a hard human gate — `cyboflow_report_step` is observational only and never
substitutes for it.
