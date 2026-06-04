---
description: Planner Phase 1 · capture the idea — parse the prompt, scan the codebase, and record a self-contained idea spec in cyboflow.
---

As you begin this step, call `cyboflow_report_step` with `step_id` `context`.

Parse the user's prompt and scan the codebase for relevant context. Form a clear,
self-contained idea: the problem, the proposed direction, and the scope hint
(`small` or `large`). Capture the idea in the database — record the idea body and
its scope hint via the available `cyboflow_*` capture tool. Surface the idea spec
to the user for review.

A selected idea is provided at the top of the run prompt when one was chosen at
launch (a `# Selected idea` block) — treat it as the raw idea to refine and do
**not** re-capture it. Otherwise parse the user's free-form prompt.

If the idea is ambiguous, use the **AskUserQuestion** tool to ask up to 2–3
targeted clarifying questions before capturing the spec (rarely needed when an
idea was selected at launch).
