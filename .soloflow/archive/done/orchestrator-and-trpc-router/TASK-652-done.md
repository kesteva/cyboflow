---
id: TASK-652
sprint: SPRINT-021
epic: orchestrator-and-trpc-router
status: done
summary: "Extract parseMarkdownFrontmatter shared helper; replace inline parsers in workflowPromptReader + workflowRegistry; canonical regex now lives in one place."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-652 — Done report

## Outcome
- NEW `main/src/orchestrator/markdownFrontmatter.ts` exposes `parseMarkdownFrontmatter(md): { frontmatter, body }` with LF/CRLF support and quote-stripping.
- `workflowPromptReader.ts` and `workflowRegistry.ts` both delegate to the shared helper.
- NEW `main/src/orchestrator/__tests__/markdownFrontmatter.test.ts` (7 cases).

## Commits
- `137b1ce` feat(TASK-652): extract parseMarkdownFrontmatter shared helper
- `ffb6545` refactor(TASK-652): replace splitFrontmatter with parseMarkdownFrontmatter in workflowPromptReader
- `06c8275` refactor(TASK-652): replace private parseFrontmatter with parseMarkdownFrontmatter in WorkflowRegistry
- `e88aa00` test(TASK-652): add markdownFrontmatter.test.ts with 7 unit cases

## Verifier verdict
APPROVED_WITH_DEFERRED — one deferred check is the pre-existing better-sqlite3 NODE_MODULE_VERSION mismatch in workflowRegistry.test.ts (requires `pnpm electron:rebuild`; unrelated to TASK-652).

## Code-reviewer verdict
CLEAN — 2 minor docstring nits queued as FIND-SPRINT-021-2 (stale references to deleted methods in markdownFrontmatter.ts:6 and workflowRegistry.ts:10-12).
