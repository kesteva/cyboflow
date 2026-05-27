---
id: TASK-777
idea: SPRINT-039-followups
status: in-flight
created: "2026-05-26T00:00:00Z"
files_owned:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/questionRouter.ts
  - main/src/index.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
  - main/src/orchestrator/__tests__/questionRouter.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/questions.test.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
files_readonly:
  - main/src/orchestrator/RunQueueRegistry.ts
  - .soloflow/active/findings/SPRINT-039-findings.md
acceptance_criteria:
  - criterion: "ApprovalRouter constructor signature is reduced to a single argument: `constructor(private readonly db: DatabaseLike)`. The `_getQueueForRun: (runId: string) => PQueue` parameter is removed."
    verification: "grep -n 'constructor' main/src/orchestrator/approvalRouter.ts shows a single-arg constructor; grep -n '_getQueueForRun' main/src/orchestrator/approvalRouter.ts returns 0 matches."
  - criterion: "QuestionRouter constructor signature is symmetrically reduced to `constructor(private readonly db: DatabaseLike)`. The `_getQueueForRun` parameter is removed."
    verification: "grep -n 'constructor' main/src/orchestrator/questionRouter.ts shows a single-arg constructor; grep -n '_getQueueForRun' main/src/orchestrator/questionRouter.ts returns 0 matches."
  - criterion: "ApprovalRouter.initialize and QuestionRouter.initialize static methods are reduced to a single argument: `static initialize(db: DatabaseLike)`. The `getQueueForRun: (runId: string) => PQueue` parameter is removed."
    verification: "grep -nA 2 'static initialize' main/src/orchestrator/approvalRouter.ts shows a 1-arg signature; same grep against main/src/orchestrator/questionRouter.ts also shows 1-arg."
  - criterion: main/src/index.ts no longer passes the runQueues factory to either router. The calls at lines 719 and 734 each pass only `db`.
    verification: "grep -n 'ApprovalRouter.initialize\\|QuestionRouter.initialize' main/src/index.ts shows both calls as `XxxRouter.initialize(db)` (no second argument)."
  - criterion: All 8 test call sites that currently pass `qf.getOrCreate.bind(qf)` or `registry.getOrCreate.bind(registry)` to a router initialize are updated to the 1-arg form.
    verification: "grep -rn 'Router.initialize(adapter, qf' main/src returns 0 matches; grep -rn 'Router.initialize(adapter, registry' main/src returns 0 matches; grep -rn 'Router.initialize(faultyAdapter, qf' main/src returns 0 matches."
  - criterion: A new comment above each constructor (in both routers) explains why per-router PQueues are intentional (no recursive-enqueue with RunQueueRegistry).
    verification: "grep -B 1 -A 6 'constructor(' main/src/orchestrator/approvalRouter.ts shows a comment block mentioning 'recursive' or 'RunQueueRegistry'; same grep against questionRouter.ts shows the symmetric comment."
  - criterion: "Main + integration tests pass: pnpm --filter main test exits 0; pnpm typecheck exits 0."
    verification: pnpm --filter main test exits 0; pnpm typecheck exits 0.
depends_on: []
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: false
  justification: "Pure signature narrowing — all existing tests cover the routers' behavior; the change removes a dead parameter without altering runtime semantics. Sibling tests in main/src/orchestrator/__tests__/*Router.test.ts (≥18 invocations of `Router.initialize(adapter, qf.getOrCreate.bind(qf))`) ARE updated in step 5 because their call signatures change, but no NEW test cases are needed — the existing behavioral tests continue to assert the same invariants on the new 1-arg form. Sibling-test scan: `main/src/orchestrator/__tests__/approvalRouter.test.ts`, `main/src/orchestrator/__tests__/questionRouter.test.ts`, `main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts`, `main/src/orchestrator/trpc/routers/__tests__/questions.test.ts`, and the three claudeCodeManager test files — all explicitly included in `files_owned` because their calls must change."
---
# TASK-777 — Remove dead `_getQueueForRun` constructor parameter from QuestionRouter and ApprovalRouter

## Objective

Close FIND-SPRINT-039-20: both `ApprovalRouter` and `QuestionRouter` accept a `_getQueueForRun: (runId: string) => PQueue` constructor parameter that is documented as unused (underscore prefix + JSDoc note) and is, in fact, unused — both routers operate their own per-router PQueue maps internally (`approvalQueues` / `questionQueues`). The misleading DI surface suggests dependency injection where none happens; tests inject a queue factory the implementation silently ignores. Drop the dead parameter from both constructors, narrow the `initialize` static methods to 1-arg, and update all 18+ call sites (boot wiring + test fixtures) to match. Add a clarifying comment on each constructor explaining why per-router PQueues are intentional (no recursive-enqueue with RunQueueRegistry — see RunQueueRegistry's `§no-recursive-enqueue` rule).

## Implementation Steps

1. **Pre-flight grep — enumerate every call site.** Run these commands and add every matching file to `files_owned`:
   ```bash
   grep -rn 'ApprovalRouter.initialize\|QuestionRouter.initialize' main/src --include='*.ts'
   grep -rn '_getQueueForRun' main/src --include='*.ts'
   grep -rn 'new ApprovalRouter(\|new QuestionRouter(' main/src --include='*.ts'
   ```
   Plan-time enumeration (verified): all call sites are in `main/src/index.ts` (lines 719, 734) and the 7 test files in `files_owned`. If new files appear from the grep at execution time (e.g. someone added another initialize call in an interim sprint), STOP and surface them — `files_owned` must be expanded before continuing.

2. **Edit `main/src/orchestrator/approvalRouter.ts`** — drop the parameter from the constructor (lines 123-128). Current:
   ```ts
   constructor(
     private readonly db: DatabaseLike,
     _getQueueForRun: (runId: string) => PQueue,
   ) {
     super();
   }
   ```
   New:
   ```ts
   /**
    * Per-router PQueues (this.approvalQueues, see field doc above) are
    * intentional and MUST stay separate from RunQueueRegistry's per-run
    * queues — that registry hosts the long-running runExecutor.execute()
    * task and the SDK PreToolUse hook fires from WITHIN that task.
    * Re-entering RunQueueRegistry's queue from inside its own task would
    * self-deadlock (runQueueRegistry.ts §no-recursive-enqueue).
    */
   constructor(private readonly db: DatabaseLike) {
     super();
   }
   ```

3. **Edit `ApprovalRouter.initialize`** static method (lines 140-146). Current:
   ```ts
   static initialize(
     db: DatabaseLike,
     getQueueForRun: (runId: string) => PQueue,
   ): ApprovalRouter {
     ApprovalRouter.initialize = new ApprovalRouter(db, getQueueForRun);
     return ApprovalRouter.instance;
   }
   ```
   (Note: the actual code at line 144 is `ApprovalRouter.instance = new ApprovalRouter(db, getQueueForRun);` — the line above is a documentation typo, the code reads `ApprovalRouter.instance`.)

   New:
   ```ts
   static initialize(db: DatabaseLike): ApprovalRouter {
     ApprovalRouter.instance = new ApprovalRouter(db);
     return ApprovalRouter.instance;
   }
   ```

4. **Also remove the `import PQueue from 'p-queue';` line ONLY if PQueue is no longer used elsewhere in the file.** Verify with `grep -n 'PQueue\|p-queue' main/src/orchestrator/approvalRouter.ts` — the import IS still needed because `approvalQueues` and `getApprovalQueue` use `new PQueue({ concurrency: 1 })` internally. Keep the import; the parameter is gone but the local type usage remains.

5. **Edit `main/src/orchestrator/questionRouter.ts`** symmetrically — drop the parameter from the constructor (lines 119-124). Current:
   ```ts
   constructor(
     private readonly db: DatabaseLike,
     _getQueueForRun: (runId: string) => PQueue,
   ) {
     super();
   }
   ```
   New:
   ```ts
   /**
    * Per-router PQueues (this.questionQueues, see field doc above) are
    * intentional and MUST stay separate from RunQueueRegistry's per-run
    * queues — that registry hosts the long-running runExecutor.execute()
    * task and the SDK PreToolUse hook fires from WITHIN that task.
    * Re-entering RunQueueRegistry's queue from inside its own task would
    * self-deadlock (runQueueRegistry.ts §no-recursive-enqueue).
    */
   constructor(private readonly db: DatabaseLike) {
     super();
   }
   ```

6. **Edit `QuestionRouter.initialize`** (lines 136-142). Current:
   ```ts
   static initialize(
     db: DatabaseLike,
     getQueueForRun: (runId: string) => PQueue,
   ): QuestionRouter {
     QuestionRouter.instance = new QuestionRouter(db, getQueueForRun);
     return QuestionRouter.instance;
   }
   ```
   New:
   ```ts
   static initialize(db: DatabaseLike): QuestionRouter {
     QuestionRouter.instance = new QuestionRouter(db);
     return QuestionRouter.instance;
   }
   ```

7. **Update `main/src/index.ts` lines 719 and 734** — drop the second argument from both initialize calls.
   - Line 719: `ApprovalRouter.initialize(db, runQueues.getOrCreate.bind(runQueues));` → `ApprovalRouter.initialize(db);`
   - Line 734: `QuestionRouter.initialize(db, runQueues.getOrCreate.bind(runQueues));` → `QuestionRouter.initialize(db);`

8. **Update all test call sites.** Run this enumeration and apply the same 1-arg narrowing:
   ```bash
   grep -rn 'Router.initialize(adapter, qf' main/src
   grep -rn 'Router.initialize(adapter, registry' main/src
   grep -rn 'Router.initialize(faultyAdapter, qf' main/src
   ```
   Plan-time list (each line numbered match becomes `XxxRouter.initialize(adapter);` or `XxxRouter.initialize(faultyAdapter);`):
   - `main/src/orchestrator/__tests__/approvalRouter.test.ts` — 16 call sites (lines 73, 119, 185, 234, 288, 347, 398, 432, 467, 515, 534, 610, 675, 719, 777, 836, 886)
   - `main/src/orchestrator/__tests__/questionRouter.test.ts` — 9 call sites (lines 73, 131, 197, 261, 320, 389, 435, 500, 548)
   - `main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts` — 4 call sites (lines 99, 150, 165, 212)
   - `main/src/orchestrator/trpc/routers/__tests__/questions.test.ts` — 3 call sites (lines 108, 161, 207)
   - `main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts` — 1 call site (line 151)
   - `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts` — 2 call sites (lines 164-165)
   - `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` — 6 call sites (lines 143-144, 398-399, 523-524)
   The mechanical edit: `Router.initialize(<adapter-expr>, <factory-expr>)` → `Router.initialize(<adapter-expr>)`. Remove the second-argument expression entirely; if it left a dangling makeQueueFactory variable that becomes unused, leave it — the linter's `no-unused-vars` (warn-level per CLAUDE.md) will be a noise increase, not a new error, but you may also drop the now-dead `const qf = makeQueueFactory();` line to keep the diff clean.

9. **Run the grep gate.** After all edits:
   ```bash
   grep -rn '_getQueueForRun' main/src
   grep -rn 'Router.initialize(adapter, qf' main/src
   grep -rn 'Router.initialize(adapter, registry' main/src
   ```
   All three commands must return 0 matches. This is the completeness check the executor MUST run before reporting COMPLETED.

10. **Run the full test gate**:
    ```bash
    pnpm --filter main test
    pnpm typecheck
    pnpm --filter main lint
    ```
    All exit 0. Pre-flight: ensure `pnpm rebuild better-sqlite3` has been run if NODE_MODULE_VERSION errors appear (per CLAUDE.md note).

## Acceptance Criteria

1. `grep -n '_getQueueForRun' main/src/orchestrator/approvalRouter.ts` returns 0 matches; same against `questionRouter.ts` returns 0.
2. `grep -rn '_getQueueForRun' main/src --include='*.ts'` (after all edits) returns 0 matches across the entire main source tree.
3. `grep -nA 2 'static initialize' main/src/orchestrator/approvalRouter.ts` shows a 1-arg signature `static initialize(db: DatabaseLike): ApprovalRouter`; same against `questionRouter.ts`.
4. `grep -n 'ApprovalRouter.initialize\|QuestionRouter.initialize' main/src/index.ts` shows both calls as `XxxRouter.initialize(db)` (no second argument).
5. `grep -rn 'Router.initialize(adapter, qf\|Router.initialize(adapter, registry\|Router.initialize(faultyAdapter, qf' main/src` returns 0 matches.
6. Each constructor has a comment block mentioning `recursive` or `RunQueueRegistry` (the rationale comment from steps 2 and 5).
7. `pnpm --filter main test` exits 0; all 700+ main tests pass.
8. `pnpm typecheck` exits 0.

## Test Strategy

No new test cases — this is pure signature narrowing. The existing behavioral tests (router behavior, transaction guards, queue serialization, recovery semantics) continue to assert the same invariants on the 1-arg form. The test files in `files_owned` are listed because their call signatures change mechanically; that change is part of the implementation, not a new test contribution.

If a test in any of those files asserts on the second-argument value (e.g. `expect(qf.getOrCreate).toHaveBeenCalled()`), that assertion is testing dead behavior and must be deleted alongside the call-site narrowing. The grep `grep -rn 'qf.getOrCreate).toHaveBeenCalled\|registry.getOrCreate).toHaveBeenCalled' main/src` returns 0 matches at plan time — no such assertions exist; the executor should re-run the grep before deletion to confirm.

## Hardest Decision

Whether to drop ALSO the now-dead `makeQueueFactory()` helper and the `const qf = makeQueueFactory();` lines from each test file. Decided **leave them** because: (1) they're scoped to per-test setup and don't bleed across files; (2) the lint rule `@typescript-eslint/no-unused-vars` is warn-level per CLAUDE.md (warnings don't block CI), so an unused `const qf` becomes a noise warning but not an error; (3) removing them risks expanding the test diff into unrelated cleanup, and the test files are already large. The executor MAY drop unused locals as a courtesy follow-up if doing so produces a clean diff; treat as discretionary.

## Rejected Alternatives

- **Promote the dead parameter to a real injected per-run queue factory** (make the routers actually use it instead of their own queue map). Rejected: the per-router queue map exists specifically because the global RunQueueRegistry's queue would self-deadlock if re-entered from inside a PreToolUse hook (documented at runQueueRegistry.ts §no-recursive-enqueue rule and approvalRouter.ts:97-103 / questionRouter.ts:94-101). The current architecture is correct; the parameter is the wart.
- **Leave the parameter but rename it to make the unusedness even more explicit** (e.g. `_DEAD_getQueueForRun`). Rejected: kicks the can; the parameter has been `_`-prefixed for several sprints already and contributors still mistakenly populate it in new tests. The fix is removal.
- **Extract a shared `GateRouter` base class for ApprovalRouter and QuestionRouter that takes neither parameter** (FIND-SPRINT-039-16's broader suggestion). Rejected for this task: scope creep. FIND-SPRINT-039-16 is the abstraction task; THIS is the targeted cleanup. They can land sequentially.

## Lowest Confidence Area

Whether any non-test caller (e.g. a tRPC router or service) instantiates these routers directly with `new ApprovalRouter(...)` rather than via `initialize()`. The pre-flight grep in step 1 includes `grep -rn 'new ApprovalRouter(\|new QuestionRouter(' main/src --include='*.ts'`; at plan time only the `initialize` static and the test fixtures construct these singletons. If the executor's pre-flight surfaces a new caller in production code, expand `files_owned` to include that file and apply the same 1-arg narrowing — STOP and surface in the done report rather than silently editing a file outside the original `files_owned` list.
```

---

Now let me return the final summary as the orchestrator expects. The plans above are the complete deliverables to be written to disk by the orchestrator.

## Summary

I have refined the 6 SPRINT-039 compounder work items into execution-ready task plans. Each plan has:
- Frontmatter `status: ready` and full ACs with grep/test verification.
- Explicit `files_owned` lists driven by grep enumeration (especially TASK-777, which spans 10 files due to constructor signature changes).
- Test strategy with sibling-test scan completed per refiner rule 5b (all surfaces have sibling tests that need updating).
- Depends-on graph: TASK-775 depends on TASK-773 (the second-subscription onError test requires the renamed mock scaffolding from TASK-773); all others independent.

Plan-to-file mapping (orchestrator should write each block to its corresponding path):

| TASK | Epic | Target path |
|------|------|-------------|
| TASK-772 (B1) | `per-run-chat-surface` | `.soloflow/active/plans/per-run-chat-surface/TASK-772-plan.md` |
| TASK-773 (B2) | `testing-infrastructure` | `.soloflow/active/plans/testing-infrastructure/TASK-773-plan.md` |
| TASK-774 (B3) | `ask-user-question-roundtrip` | `.soloflow/active/plans/ask-user-question-roundtrip/TASK-774-plan.md` |
| TASK-775 (B4) | `ask-user-question-roundtrip` | `.soloflow/active/plans/ask-user-question-roundtrip/TASK-775-plan.md` |
| TASK-776 (B6) | `per-run-chat-surface` | `.soloflow/active/plans/per-run-chat-surface/TASK-776-plan.md` |
| TASK-777 (B10) | `orchestrator-and-trpc-router` | `.soloflow/active/plans/orchestrator-and-trpc-router/TASK-777-plan.md` |

No new epics are introduced — all 6 plans reuse existing epic slugs.

Key cross-cutting design decisions documented in the plans:

1. **TASK-772 (otherText multi-sub-question keying)**: chose **uniform distribution** (FIND-14 option b) over per-(questionId, subIndex) bus extension — no ChatInput producer change required, dominant case is single-sub-question, per-sub-question "local dirty" flag lets users override divergently.

2. **TASK-774 (cancelAndRestart symmetry)**: questionRouter clear placed **after** approvalRouter clear and **before** claudeManagerStop, matching the existing AC5 ordering rationale.

3. **TASK-775 (onError asymmetry)**: depends on TASK-773 so the renamed `mockCreatedSubscribe` / `mockDecidedSubscribe` (or `mockAnsweredSubscribe`) handles are in place when the second-subscription tests are added.

4. **TASK-776 (dedup)**: chose **id-based dedup for assistants + timestamp filter for users** (FIND-11's simpler fallback) over a wire-shape change to UserEvent — no IPC-layer change needed.

5. **TASK-777 (`_getQueueForRun` removal)**: pre-flight grep enumerates 18+ call sites in plan; explicit grep completeness gate (`grep -rn '_getQueueForRun' main/src` must return 0) encoded as final implementation step.

Relevant absolute file paths (read during refinement):
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/stores/questionStore.ts`
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/stores/reviewQueueStore.ts`
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/AskUserQuestion/AskUserQuestionCard.tsx`
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/cyboflow/RunChatView.tsx`
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/cyboflow/ChatInput.tsx`
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/cancelAndRestartHandler.ts`
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/questionRouter.ts`
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/approvalRouter.ts`
- `/Users/raimundoesteva/Developer/cyboflow/main/src/index.ts`
- `/Users/raimundoesteva/Developer/cyboflow/main/src/orchestrator/__tests__/cancelAndRestart.test.ts`
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/stores/__tests__/reviewQueueStore.test.ts`
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/stores/__tests__/questionStore.test.ts`
- `/Users/raimundoesteva/Developer/cyboflow/frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx`
- `/Users/raimundoesteva/Developer/cyboflow/.soloflow/active/findings/SPRINT-039-findings.md`
