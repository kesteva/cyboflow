---
sprint: SPRINT-007
pending_count: 7
last_updated: "2026-05-14T19:30:00.000Z"
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

## FIND-SPRINT-007-4
- **type:** scope_deviation
- **source:** TASK-572 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/claudePanel.ts
- **description:** Required to meet AC#6 (pnpm typecheck + vitest pass): ClaudeCodeManager.setSharedDb() must be called after DatabaseService is ready. claudePanel.ts is the earliest IPC handler that has both claudeCodeManager and databaseService in scope (via AppServices). File claimed and used to wire the static DB holder.
- **resolved_by:** verifier — plan-prescribed: main/src/ipc/claudePanel.ts is listed in TASK-572-plan.md `files_owned` (line 15); not a deviation

## FIND-SPRINT-007-5
- **type:** scope_deviation
- **source:** TASK-572 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/services/panels/claude/claudePanelManager.ts
- **description:** Claimed but not ultimately modified — claudePanel.ts (also claimed) was sufficient to wire setSharedDb. claudePanelManager.ts was claimed as a fallback option in case the IPC handler path was blocked.
- **resolved_by:** verifier — plan-prescribed: main/src/services/panels/claude/claudePanelManager.ts is listed in TASK-572-plan.md `files_owned` (line 14); not a deviation, and ultimately untouched

## FIND-SPRINT-007-6
- **type:** scope_deviation
- **source:** TASK-572 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/events.ts
- **description:** Claimed but not ultimately modified — pipeline cleanup and state-machine guard calls were wired entirely within claudeCodeManager.ts. events.ts was claimed as a potential fallback for transitionToAwaitingReview production callsite.
- **resolved_by:** verifier — plan-prescribed: main/src/events.ts is listed in TASK-572-plan.md `files_owned` (line 16); not a deviation, and ultimately untouched

## FIND-SPRINT-007-7
- **source:** TASK-572 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:68-76, 309, 380
- **description:** ClaudeCodeManager uses a `static sharedDb: Database.Database | null` injector with a `setSharedDb()` static method wired from claudePanel.ts. The plan's recommended approach was constructor injection (a `db` parameter threaded through the single caller in claudePanelManager.ts), with the singleton/static pattern listed as a fallback in the "Lowest Confidence Area" section. The executor chose the fallback to avoid surface-area churn and preserve the existing constructor contract (the permissions test depends on the current shape, see test_strategy.targets[1]). The static pattern works but has known downsides: (a) cross-instance state leak in tests requires explicit reset in `afterEach` (already done correctly here), (b) the `null` branch silently degrades RawEventsSink to a no-op, which could hide a wiring regression in production where setSharedDb is forgotten on a new entry-point path, (c) it diverges from the constructor-DI pattern used elsewhere in the codebase. A future hardening pass could plumb `db` through the constructor once the AbstractAIPanelManager/BaseAIPanelHandler scaffolding is consolidated (cleanup candidate per CLAUDE.md). Not blocking — the static injector is documented in code and was explicitly authorized by the plan.
- **suggested_action:** When the AbstractAIPanelManager scaffolding is collapsed (already on the deferred cleanup list), replace the static sharedDb with a constructor `db` parameter wired through claudePanelManager.ts:39. Add an integration test that exercises the constructor path so the no-DB degraded mode becomes the explicit error path, not the silent default.
- **resolved_by:**

## FIND-SPRINT-007-8
- **source:** TASK-572 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:74, main/src/services/__tests__/claudeCodeManagerWiring.test.ts:184
- **description:** `ClaudeCodeManager.setSharedDb(db: Database.Database)` accepts only a non-null handle, but the underlying static field is typed `Database.Database | null` (line 68). The test `afterEach` at line 184 needs to reset state and does so via `ClaudeCodeManager.setSharedDb(null as unknown as Database.Database)` — a cast that papers over the setter/field signature mismatch and weakens type safety. Either widen the setter to `db: Database.Database | null` (so passing `null` is honest) or add a dedicated `clearSharedDb(): void` reset helper used by tests. Trivial fix; surfaces because the test had to lie to TypeScript to compile.
- **suggested_action:** Pick one of: (a) change line 74 to `static setSharedDb(db: Database.Database | null): void` and drop the cast in the test, or (b) add `static clearSharedDb(): void { ClaudeCodeManager.sharedDb = null; }` and replace the test's cast call with the clear method. Single small commit, no behavior change.
- **resolved_by:**

## FIND-SPRINT-007-10
- **source:** TASK-575 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:6-10
- **description:** The rewritten top-of-module JSDoc says "This module exports: `claudeStreamEventSchema` … `_typeCheck` — compile-time TS↔Zod drift bridge". Only `claudeStreamEventSchema` is actually `export`ed; `_typeCheck` is a module-local `const` used purely for its compile-time assignability check (see line 263, declared with `const` not `export const`). The prose technically misleads a reader skimming the header into thinking `_typeCheck` is part of the public surface. Functionally harmless — no caller would resolve a non-existent import — but the wording could read "This module declares" or split into "Exports:" and "Compile-time checks:" subsections.
- **suggested_action:** Change line 6 from "This module exports:" to "This module declares:", or split into two bullets — "Exports: `claudeStreamEventSchema`" and "Compile-time check: `_typeCheck` — TS↔Zod drift bridge". Single-line documentation edit.
- **resolved_by:**

## FIND-SPRINT-007-9
- **source:** TASK-572 (code-reviewer)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:367-389
- **description:** `tryTransitionToAwaitingReview` is a private method with zero in-class callers — by design, per the JSDoc which marks it as a Day-3 integration point that satisfies AC#4's grep gate. The cyboflow CLAUDE.md prescribes the `@cyboflow-hidden` annotation for "Code that is intentionally unreachable in cyboflow v1 (but preserved from the Crystal baseline for future re-enablement)" with an audit tool `grep -rn '@cyboflow-hidden' main/src frontend/src`. This method is intentionally unreachable in v1 and forward-looking rather than Crystal-preserved, but the same audit/prune tooling that scans for `@cyboflow-hidden` will not find this method, and a future cleanup pass (e.g., `soloflow-dev:prune` or `simplify`) could mark it as dead code and remove it. Either extend the convention to also cover forward-looking placeholders, or add the `@cyboflow-hidden` marker above the method with a re-enable pointer (e.g., "Re-enable by wiring from ApprovalRouter once workflow_runs rows are auto-created on Claude spawn — TASK-302"). The verifier already accepted this method for AC#4's grep gate; the open question is purely the annotation discipline.
- **suggested_action:** Either (a) add `// @cyboflow-hidden: Day-3 placeholder; called only after workflow_runs auto-creation lands. Re-enable by routing through ApprovalRouter.recordToolRequest() → tryTransitionToAwaitingReview().` immediately above the method, or (b) update docs/CODE-PATTERNS.md `@cyboflow-hidden` section to explicitly cover forward-looking placeholders alongside Crystal-preserved code. Option (a) is the smaller change.
- **resolved_by:**
