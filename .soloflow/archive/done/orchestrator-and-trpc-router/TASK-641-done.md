---
id: TASK-641
sprint: SPRINT-018
epic: orchestrator-and-trpc-router
status: done
summary: "Pure helper readWorkflowPrompt() reads workflow .md body + system_prompt_append frontmatter; typed WorkflowPromptReadError for missing/empty paths."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-641 — Done

Added `main/src/orchestrator/workflowPromptReader.ts` exporting
`readWorkflowPrompt(workflowPath)` and `WorkflowPromptReadError`. Pure
synchronous helper that reads a workflow `.md`, strips its frontmatter,
returns `{ prompt, systemPromptAppend }`. Three explicit throw paths
(missing file with ENOENT cause chain, empty body with `/empty/i`-matching
message, future parse errors). Mirrors the regex shape used by
`WorkflowRegistry.parseFrontmatter` for CRLF + quote-stripping parity, but
intentionally not extracted into a shared parser (documented in plan
"Hardest Decision").

Tests at `main/src/orchestrator/__tests__/workflowPromptReader.test.ts`: 9
unit cases covering all 7 plan-required paths + two test-writer additions
(single-quoted frontmatter values, `---` sequences inside body). All
9 green; full main suite 363 tests pass.
