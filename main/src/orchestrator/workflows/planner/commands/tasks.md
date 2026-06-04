---
description: Planner Phase 2 · break the idea (or each epic) into concrete, independently shippable tasks.
---

As you begin this step, call `cyboflow_report_step` with `step_id` `tasks`.

Break the idea (or each epic) into concrete, independently shippable tasks. Create
each task with `cyboflow_create_task`, including:

- a clear title and a task body describing the work,
- acceptance criteria (the satellite the task is judged against),
- file-ownership and dependency hints where known,
- linkage to the parent epic and/or originating idea.

Once tasks exist, the originating idea retires (it is decomposed); the children
carry the flow forward.
