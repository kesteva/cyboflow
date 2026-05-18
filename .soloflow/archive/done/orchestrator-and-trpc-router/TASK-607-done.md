---
id: TASK-607
sprint: SPRINT-017
epic: orchestrator-and-trpc-router
status: done
summary: "RunLauncher's 4 MCP collaborators are now required; production sentinels throw at call time (no silent skip); test injection seam added"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Removed the optional-security pattern from RunLauncher: mcpConfigWriter, orchSocketProvider, bridgeScriptResolver, nodeResolver are now required, with explicit per-field validation throws in the constructor. The `if (this.mcpConfigWriter && ...)` guard in launch() is gone; MCP write is unconditional. Production `getRunLauncher` in cyboflow.ts wires a real McpConfigWriter, defensible nodeResolver (process.execPath), and throwing sentinels for the two epic-7-owned collaborators so missing wiring fails loudly. A `_setRunLauncherForTest` injection hook lets the happy-path test exercise the wiring without invoking the production sentinels. Tests: 32 across runLauncher.test.ts + cyboflow.test.ts; test:gate passes.
