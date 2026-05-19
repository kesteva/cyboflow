---
id: TASK-661
sprint: SPRINT-021
epic: orchestrator-and-trpc-router
status: done
summary: "Wire WorkflowPromptReaderLike into RunExecutor.getPrompt + thread system_prompt_append frontmatter through ClaudeCodeManager.composeSystemPromptAppend; replace TASK-660 nopSpawner with concrete ClaudeCodeManager adapter."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-661 — Done report

## Outcome
- New `WorkflowPromptReaderLike` interface in `runExecutor.ts`; getPrompt(runId, workflow) now reads via injected reader; pendingSystemPromptAppend Map mirrors existing per-run map patterns and is cleared in teardownRun.
- `ClaudeSpawnOptions.systemPromptAppend` added; `composeSystemPromptAppend` concatenates per-spawn after dbSession append with documented precedence.
- `main/src/index.ts` now passes a concrete `readWorkflowPrompt` adapter and a real `spawnerAdapter` (over `defaultCliManager`) to `RunExecutor`, replacing TASK-660's nopSpawner.
- 3 new runExecutor tests + 4 new claudeCodeManagerWiring tests. 456/456 main suite green.

## Commits
- `8666acc` feat(TASK-661): wire WorkflowPromptReaderLike into RunExecutor.getPrompt
- `e04e11c` feat(TASK-661): add systemPromptAppend to ClaudeSpawnOptions and composeSystemPromptAppend
- `446e2b2` feat(TASK-661): wire concrete WorkflowPromptReader and ClaudeSpawnerLike adapter in index.ts
- `4ad8094` test(TASK-661): add unit tests for getPrompt reader injection and systemPromptAppend precedence

## Verifier verdict
APPROVED. One minor scope deviation logged as FIND-SPRINT-021-3 (promptReader parameter is `optional` rather than required; mitigated by sentinel error + pinning test, and production site passes the concrete reader).

## Code-reviewer verdict
CLEAN — no findings beyond an aesthetic note on the double-cast adapter (acceptable as integration shim).
