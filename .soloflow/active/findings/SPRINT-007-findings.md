---
sprint: SPRINT-007
pending_count: 3
last_updated: 2026-05-14
---

# Findings Queue

## Step 2.8 prereq override

TASK-575 had failing blocking prereq (grep of legacy parseClaudeStreamEvent — passes only after TASK-572 lands). User opted to keep TASK-575 in scope; the dep scheduler sequences it after TASK-572 completes naturally. No gate applied.

## FIND-SPRINT-007-2
- **source:** TASK-574 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/jsonParser.ts:14-15, main/src/services/streamParser/__tests__/jsonParser.test.ts:11,17,28,98
- **description:** TASK-574 introduced `export type IWarnLogger = Pick<ILogger, 'warn'>` in `jsonParser.ts` with a `@deprecated` JSDoc tag as a bridge alias, because `jsonParser.test.ts` (in TASK-574's `files_readonly` set) imports `IWarnLogger` and uses it as a type annotation in four places. The alias is otherwise dead code in the production surface — no production file references it. A trivial follow-up can update the test to `import type { ILogger } from '../types'` and replace the three `IWarnLogger & {...}` annotations with `Pick<ILogger, 'warn'> & {...}` (or drop the explicit type and rely on the inline-object structural type), then delete the alias and the `@deprecated` line. The test's existing mock objects already structurally satisfy `Pick<ILogger, 'warn'>` — no runtime changes needed.
- **suggested_action:** In a follow-up task, edit `jsonParser.test.ts` to import `ILogger` from `../types` instead of `IWarnLogger` from `../jsonParser`, then remove the `@deprecated` alias block (lines 14-15) from `jsonParser.ts`. Single small commit.
- **resolved_by:**

## FIND-SPRINT-007-1
- **source:** TASK-573 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts
- **description:** Ten tests in `main/src/orchestrator/trpc/__tests__/router.test.ts` fail because the suite predicate `isNotImplemented` (and a literal `expect(...).toBe('NOT_IMPLEMENTED')` at line 124) still assert the legacy tRPC error code `NOT_IMPLEMENTED`, but the implementation migrated to `METHOD_NOT_SUPPORTED` via the `throwNotImplemented` helper (`main/src/orchestrator/trpc/trpc.ts:43`) in commit e671517 (`chore(SPRINT-006): use METHOD_NOT_SUPPORTED + throwNotImplemented helper`). The test file was not updated alongside the helper. Pre-existing on `main` at commit b257f7a (SPRINT-007 start) — TASK-573 does not touch the `trpc/` directory; the failing tests are unrelated to the transitions.ts change. Confirmed via `git diff HEAD~1 HEAD -- main/src/orchestrator/trpc` returning empty.
- **suggested_action:** Update `__tests__/router.test.ts` so `isNotImplemented` returns true for `code === 'METHOD_NOT_SUPPORTED'` and change the literal at line 124 to `'METHOD_NOT_SUPPORTED'`. Likely a one-line + one-line fix.
- **resolved_by:**

## FIND-SPRINT-007-3
- **source:** TASK-568 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/ipc/session.ts:929
- **description:** The `panels:get-json-messages` IPC handler does not call `validatePanelExists(panelId)` before invoking `sessionManager.getPanelOutputs(panelId)`. Nearby panel-scoped handlers (`panels:stop-claude` at ~line 884, `panels:get-prompts` at ~994, etc.) all use `validatePanelExists` as a guard. The inconsistency is pre-existing (predates TASK-568) — the prior implementation also skipped validation — but this is the only panelId-keyed IPC in `session.ts` without ownership validation. Out-of-diff for TASK-568.
- **suggested_action:** Add `const panelValidation = validatePanelExists(panelId); if (!panelValidation.isValid) return createValidationError(panelValidation);` at the top of the try block, mirroring the pattern at line 884.
- **resolved_by:**
