---
sprint: SPRINT-021
pending_count: 2
last_updated: "2026-05-19T21:30:00Z"
---

# Findings Queue

## FIND-SPRINT-021-1
- **source:** TASK-650 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:129-160
- **description:** Plan step 5 prescribes "terminal-phase fires from cancel() ('canceled') and execute()'s catch arm ('failed')." The implementation correctly fires 'canceled' from cancel() but uses `try/finally` (not `try/catch`) in execute() — `teardownRun` is called on both paths, but `onLifecycleTransition(runId, 'failed')` is NEVER fired when spawnCliProcess throws. AC5 only requires the union to widen (verified), so this is not a blocker. AC4 only requires dispose() on terminal phase via teardownRun (verified). However, downstream TASK-644 will need an explicit way to distinguish completed-vs-failed runs at the lifecycle hook layer — currently both paths look identical to the default no-op override. Either (a) wrap the try in try/catch + finally and fire 'failed'/'completed' explicitly before re-throw, or (b) document that TASK-644 must use a different signal (e.g. the spawnCliProcess return value or a thrown error caught in the integration override) to detect failure. The plan's step 5 wording implies (a) was intended.
- **suggested_action:** Address in TASK-644 or as a follow-up plan: change `try { ... } finally { teardownRun }` to `try { ... onLifecycleTransition(runId, 'completed') } catch (err) { await onLifecycleTransition(runId, 'failed'); throw err } finally { teardownRun }`. The current public-surface contract for ExecutionPhase suggests the executor itself is responsible for firing these phases.
- **resolved_by:**

## FIND-SPRINT-021-2
- **source:** TASK-652 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/markdownFrontmatter.ts:6 and main/src/orchestrator/workflowRegistry.ts:10-12
- **description:** Two docstrings reference structures that no longer exist after the TASK-652 extraction. (a) `markdownFrontmatter.ts:6` says the helper is "Shared by workflowPromptReader.readWorkflowPrompt and WorkflowRegistry.parseFrontmatter" — but `parseFrontmatter` was deleted; the registry now consumes the helper from `extractPermissionMode`. (b) `workflowRegistry.ts:10-12` says "the inline parser intentionally avoids js-yaml" — the parser is no longer inline, it lives in `markdownFrontmatter.ts`. Both are cosmetic doc-drift introduced by the refactor; behavior and tests are correct.
- **suggested_action:** Update `markdownFrontmatter.ts` header to "Shared by workflowPromptReader.readWorkflowPrompt and WorkflowRegistry.extractPermissionMode" (or generic: "any markdown caller in main/src/orchestrator that needs flat key:value frontmatter"). Update `workflowRegistry.ts` header note to reference `markdownFrontmatter.ts` instead of describing the parser as inline.
- **resolved_by:**
