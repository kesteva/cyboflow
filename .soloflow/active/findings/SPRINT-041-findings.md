---
sprint: SPRINT-041
pending_count: 4
last_updated: "2026-05-27T14:23:06.075Z"
---
# Findings Queue

- SPRINT-041 started with missing infra: docker; tests deferred.
- TASK-755 gated: failing blocking prereq (Sanity check that both fields are still dead before pruning).

## FIND-SPRINT-041-1
- **source:** TASK-754 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/session.ts:312
- **description:** The `sessions:create-quick` JSDoc note (c) now reads "`db.createSession` omits `run_id` from its INSERT column list, so the row naturally gets `run_id = NULL` via TASK-743's migration default." TASK-754 added `run_id` to the INSERT column list (bound `data.run_id ?? null`); the row now gets `run_id = NULL` because the data object omits the field, not because the INSERT omits the column. Functionally still NULL — but the JSDoc rationale is stale and could mislead a future maintainer auditing the quick-session no-runId invariant. The file is in `files_readonly` for TASK-754, so the executor correctly did not touch it.
- **suggested_action:** Update note (c) to: "`SessionManager.createSessionWithId` intentionally omits `run_id` from its `sessionData` literal, so `db.createSession` binds `null` and the row gets `run_id = NULL`. See the comment above the `sessionData` literal in `sessionManager.ts:353-356`."
- **resolved_by:** 

## FIND-SPRINT-041-2
- **source:** TASK-754 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/__tests__/sessionManagerRunIdMapping.test.ts:159-163, 207-211
- **description:** The new "DB round-trip" describe block imports `better-sqlite3` via `require('better-sqlite3')` inside an IIFE, requiring two `eslint-disable @typescript-eslint/no-require-imports` comments. The plan said to "mirror the bootstrap pattern from `cyboflowSchema.test.ts:737-742`", and that file uses a top-of-file `import Database from 'better-sqlite3'` (line 24) — cleaner and matches the dominant pattern across migration007/010/011/rawEventsSink tests. Functionally identical, but the chosen path diverges from the file the plan referenced and adds two suppression comments to the test surface. Two near-identical IIFE blocks across Case A and Case B also duplicate the same 4-line raw-DB seeding sequence; a tiny `seedProject(dbPath)` helper local to the file would remove the duplication and the eslint suppressions in one move.
- **suggested_action:** Replace the two `require('better-sqlite3')` IIFEs with a top-of-file `import Database from 'better-sqlite3'`, and extract the 4-line "open raw DB → INSERT projects row → close" sequence into a small local helper. The two `eslint-disable` comments can then be dropped.
- **resolved_by:** 

## FIND-SPRINT-041-3
- **source:** TASK-776 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md
- **description:** Peekaboo MCP reports Accessibility NOT granted for MCP host process binary while Screen Recording IS granted — recurring TCC.db host-process gap documented across SPRINT-031..SPRINT-039 and now SPRINT-041. CLAUDE.md already references docs/VISUAL-VERIFICATION-SETUP.md TCC diagnostic. Recurring across many sprints suggests the doc-fix that resolves once-for-all has not landed; compounder should propose elevating the TCC fix from doc-noted to a tracked setup task (or an automated tcc-check script).
- **suggested_action:** Compounder: open a tracked task to either (a) script the TCC.db host-process check + remediation, OR (b) promote the existing doc walk-through into the project bootstrap / onboarding flow so it stops being a per-sprint resolution-loop.
- **resolved_by:** 

## FIND-SPRINT-041-4
- **type:** scope_deviation
- **source:** TASK-777 (executor)
- **severity:** low
- **status:** resolved
- **location:** tests/helpers/cyboflowTestHarness.ts:83-91
- **description:** required to meet AC: typecheck gate failed because tests/helpers/cyboflowTestHarness.ts uses both `new ApprovalRouter(db, factory)` direct construction and `ApprovalRouter.initialize(db, factory)` — both must be narrowed to 1-arg to satisfy TypeScript after removing the dead parameter from the constructor signature.
- **resolved_by:** verifier — AC-prescribed: AC7/AC8 require `pnpm typecheck` to exit 0; the harness's direct `new ApprovalRouter(dbLike, factory)` + `ApprovalRouter.initialize(dbLike, factory)` calls would have failed typecheck once the dead parameter was removed from the constructor and initialize signatures.

## FIND-SPRINT-041-5
- **source:** TASK-777 (code-reviewer)
- **type:** cleanup
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/__tests__/approvalRouter.test.ts:38-51, 70/116/177/231/285/344/395/429/464/529/546-547/605/752/830/880
- **description:** Asymmetric cleanup vs sibling questionRouter.test.ts. The 65af958 chore commit dropped `makeQueueFactory` from questionRouter.test.ts and rewrote all its `await qf.getOrCreate(runId).onIdle()` barriers to `await router['getQuestionQueue'](runId).onIdle()` (which observes the router's REAL internal queue). The same chore left approvalRouter.test.ts with 14 standalone `await qf.getOrCreate(runId).onIdle()` calls + 2 inside `await Promise.all([qf.getOrCreate(A).onIdle(), qf.getOrCreate(B).onIdle()])` (line 545-548) plus the unused `makeQueueFactory` helper at line 38-51. Since `qf` is no longer passed to `ApprovalRouter.initialize`, these queues have zero tasks enqueued and `onIdle()` resolves immediately — the comment at line 128 ("Wait for the queue to be idle so the transaction has committed") is now actively misleading. Tests still pass only because better-sqlite3 transactions are synchronous, so DB state is committed before the next microtask; the synchronization machinery is dead weight that survives only by accident.
- **suggested_action:** Mirror the questionRouter.test.ts fix: replace every `qf.getOrCreate(runId).onIdle()` with `router['getApprovalQueue'](runId).onIdle()` (private-field bracket access), then delete the now-unused `makeQueueFactory` helper + `import PQueue from 'p-queue'`. Verify with `grep -n 'makeQueueFactory\|qf\.' main/src/orchestrator/__tests__/approvalRouter.test.ts` returning 0 matches.
- **resolved_by:** TASK-777

## FIND-SPRINT-041-6
- **source:** TASK-781 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md
- **description:** Visual verification for TASK-781 (WorkflowProgressTimeline retrofit) could not run on either configured platform. visual_web=true but Cyboflow CLAUDE.md documents that Vite renderer at http://localhost:4521 cannot bootstrap without Electron preload-injected electronTRPC — Playwright MCP path is non-functional. visual_macos=true but Peekaboo MCP reports Accessibility NOT granted for the host binary (recurring TCC.db host-process gap, duplicate of FIND-SPRINT-041-3 and the same pattern across SPRINT-031..SPRINT-040). Net result: visual verification has been silently skipped for many sprints. Compounder should either (a) ship a Playwright config that uses _electron.launch() so visual_web becomes functional, or (b) automate the Peekaboo TCC.db host-process fix so visual_macos no longer requires per-sprint manual remediation. Without one of these, the visual-verify checkbox is decorative on this project.
- **suggested_action:** Compounder: open a tracked task to make visual verification actually runnable here — either Playwright over _electron.launch() (preferred per VISUAL-VERIFICATION-SETUP.md) or a scripted Peekaboo TCC remediation step in project bootstrap.
- **resolved_by:** 
