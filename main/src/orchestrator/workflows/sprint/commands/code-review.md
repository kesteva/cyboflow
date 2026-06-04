---
description: Sprint Phase 1 · inline review of the diff — naming, layering, pattern compliance; out-of-scope issues become findings.
---

As you begin this step, call `cyboflow_report_step` with `step_id` `code-review`.

Inline review of the diff — naming, layering, pattern compliance. If you spot an
issue that is out of scope for this task (tech debt, an adjacent bug, a doc gap),
record it as a **finding** via `cyboflow_report_finding` instead of expanding the
task. Findings are non-blocking and land in the review queue for human triage.
