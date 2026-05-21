---
sprint: SPRINT-029
pending_count: 11
last_updated: "2026-05-21T21:58:30.837Z"
---
# Findings Queue

## FIND-SPRINT-029-1
- **type:** bug
- **severity:** medium
- **source:** TASK-695 (verifier)
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts:158
- **description:** Pre-existing test failure on main (base sha 28f8281): claudeCodeManager.killProcess.test.ts > killProcess mid-stream clears pipelines, sdkRuns, and processes maps times out at 5000ms (and the no-active-run case errors with TypeError: Cannot read properties of undefined (reading close) at db.close() in afterEach). Confirmed unrelated to TASK-695 — the test file was last touched by TASK-647 and is outside TASK-695s files_owned. The failure was masked from prior verifier runs because their executors did not run the full root test:unit suite. NOT a regression from this task.
- **suggested_action:** Spawn a follow-up task to diagnose and fix the killProcess test. Likely root cause is the db helper not returning a Database instance after a recent migration change, plus a teardown/timeout interaction with ApprovalRouter._resetForTesting. Recommend a small TASK in a future sprint.

## FIND-SPRINT-029-2
- **type:** improvement
- **severity:** low
- **source:** TASK-654 (verifier)
- **status:** open
- **location:** frontend/src/components/CreateSessionDialog.tsx:91, frontend/src/components/CreateSessionDialog.tsx:633, frontend/src/components/panels/cli/BaseCliPanel.tsx:425, main/src/events.ts:667, main/src/services/panels/claude/claudeCodeManager.ts:258
- **description:** TASK-654 added docs/CODE-PATTERNS.md § permissionMode contract Rule 5: Do NOT hardcode the string approve as a standalone fallback literal (|| approve). However, five || approve literal fallbacks remain in product code (4 in main/frontend product code, plus 1 in a regression-guard test that is documenting the legacy shape). These pre-date TASK-654 (introduced when TASK-569 flipped 15 camelCase callsites from ignore to approve without routing through a constant) and are not blocked by any TASK-654 acceptance criterion — but they contradict the contract Rule 5 the task itself just documented. The grep-gate sweep grep -rnE "\|\| .approve." would surface them as a follow-up cleanup pass.
- **suggested_action:** Schedule a small follow-up task to replace the five || approve literals with DEFAULT_PERMISSION_MODE imports, completing the doc-prescribed contract. Once landed, add the grep to the contracts verification block so future grep-gates catch new occurrences.

## FIND-SPRINT-029-3
- **type:** bug
- **source:** TASK-305 (executor)
- **severity:** medium
- **status:** resolved
- **resolved_by:** verifier — status-sync: TASK-305 (worktree node_modules was empty; pnpm install in the worktree triggered postinstall electron-builder install-app-deps which rebuilt better-sqlite3 against the right ABI; all 18 approvalRouter tests now pass)
- **location:** main/src/orchestrator/__tests__/approvalRouter.test.ts
- **description:** All approvalRouter unit tests fail on this machine due to better-sqlite3 NODE_MODULE_VERSION mismatch. The pnpm store has better-sqlite3 compiled for Electron (NMV 136) while the local node is v22.15.1 (NMV 127). Running pnpm electron:rebuild or pnpm rebuild inside the main workspace would fix this, but doing so as a side-effect of a task commit is out of scope. All 16 pre-existing tests + 2 new TASK-305 tests fail with ERR_DLOPEN_FAILED. Typecheck passes cleanly.
- **suggested_action:** Run pnpm electron:rebuild or pnpm rebuild from the main workspace to recompile better-sqlite3 for the host Node version. This is a one-time environment fix.

## FIND-SPRINT-029-4
- **type:** bug
- **source:** TASK-706 (verifier)
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts:113-127
- **description:** TASK-706 (currently being verified) replaced the 5 stub procedures in main/src/orchestrator/trpc/routers/approvals.ts with live ApprovalRouter+DB wiring. router.test.ts lines 113-127 contain 3 stale assertions on the OLD stub behavior (listPending returns [], approve/reject return {success:true} without ApprovalRouter init). Those assertions now fail with `TRPCError: ApprovalRouter has not been initialized` because the live mutation calls ApprovalRouter.getInstance() which the test does not initialize. router.test.ts is owned by TASK-695 (already merged); TASK-706 cannot modify it per files_owned scoping. TASK-706's own dedicated approvals.test.ts (9 tests) covers the new live behavior — full coverage of the renderer→ApprovalRouter wiring is preserved.
- **suggested_action:** Schedule a small follow-on task in a future sprint to either (a) delete the 3 stale assertions from router.test.ts since they are now redundant with the dedicated approvals.test.ts coverage, or (b) update them to initialize ApprovalRouter and seed approvals before calling listPending/approve/reject. Option (a) is preferred — the dedicated approvals.test.ts file is the canonical home for these assertions and router.test.ts should only verify the router shape/wiring, not handler behavior.

## FIND-SPRINT-029-5
- **type:** anti-pattern
- **source:** TASK-706 (verifier)
- **severity:** medium
- **status:** open
- **location:** main/src/utils/mutex.ts:1,46
- **description:** main/src/utils/mutex.ts contains two latent TS6133 ("declared but never read") errors: `import { Logger } from './logger';` at line 1 and `const lockId = this.lockCounts.get(resourceName);` at line 46. The Logger import is dead since the file inlines its own console-based logger; lockId is computed but never used (the original Crystal design had it as a debug aid). These errors existed at base SHA 28f8281 (the Crystal fork point) but were latent because no file in frontend/'s tsc reachable set imported any module that transitively imported mutex.ts. TASK-706 changed that — main/src/orchestrator/trpc/routers/approvals.ts now imports approveRestOfRunHandler from main/src/trpc/routers/approvals.ts, which imports `withLock` from main/src/utils/mutex.ts. Because shared/types/trpc.ts re-exports AppRouter from main/src/orchestrator/trpc/router (which composes approvalsRouter), frontend tsc (which sets `noUnusedLocals: true`) now reaches mutex.ts and surfaces the errors. The result: pnpm typecheck fails with exit 2 — directly contradicting TASK-706 AC #11 ("pnpm typecheck and pnpm lint exit 0"). The errors are NOT in TASK-706's files_owned, but the AC is broad and the regression is causally TASK-706's. Recommended fix (one line each): remove the unused `Logger` import; remove or use `lockId`.
- **suggested_action:** Add main/src/utils/mutex.ts to TASK-706's executor change set and delete the two unused declarations (line 1 import and line 46 const). The fix is two-line and AC-prescribed by AC #11. Alternative: a tiny follow-on task that fixes only mutex.ts and re-runs typecheck. Either way, do not merge TASK-706 with typecheck failing.

## FIND-SPRINT-029-6
- **type:** infra
- **severity:** low
- **source:** SPRINT-029 sprint-verifier
- **status:** open
- **location:** package.json (postinstall hook), pnpm-lock.yaml, cyboflow-backend-debug.log
- **description:** Recurring infra friction: running `pnpm dev` triggers `electron-builder install-app-deps` which rebuilds better-sqlite3 against Electron's NODE_MODULE_VERSION 136. The host node v22.15.1 uses NMV 127, so any subsequent `pnpm --filter main test` (or any other node-only test runner) fails with ERR_DLOPEN_FAILED on `new Database(:memory:)` across ~239 tests. FIND-SPRINT-029-3 hit this once already this sprint; the sprint-verifier hit it a second time after a separate `pnpm dev` run. `pnpm rebuild better-sqlite3` clears it. The fingerprint is now stable across two sprints.
- **suggested_action:** Consider one of: (a) a `pretest:main` script that runs `pnpm rebuild better-sqlite3` if NMV mismatch is detected; (b) switching `pnpm --filter main test` to use Electron's bundled node via `electron-vitest` or similar; (c) documenting the manual `pnpm rebuild better-sqlite3` step in CLAUDE.md under "Common Commands" so future verifiers don't have to rediscover it. Option (a) or (c) is lowest-risk. Not blocking; informational only.

## FIND-SPRINT-029-7
- **source:** SPRINT-029 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/approvalRouter.ts:178,201,203,228,230,244,248; main/src/orchestrator/preToolUseHookHelper.ts:38,39,42,49,69
- **description:** DIAG-* console.error debug instrumentation left in production code — 12 lines across approvalRouter.ts (7) and preToolUseHookHelper.ts (5) added by TASK-694 to investigate a hook-routing issue. Every approval request now emits 7 stderr lines from approvalRouter alone (requestApproval entry → before queue.add → queue task entered → before txn.run → after txn.run → pending set → emit approvalCreated), plus 3 more from preToolUseHookHelper. These are obviously temporary diagnostic artifacts that should not have shipped:
- **suggested_action:** Delete all 12 [DIAG-*] console.error lines. If any signal value remains, replace with a single logger.debug call (or the project logger pattern) gated on a debug flag. Add a grep-gate to prevent regressions: grep -rn \[DIAG- main/src/ should return 0 matches.
- **resolved_by:** 






    console.error([DIAG-approval] requestApproval entry runId=, runId, tool=, toolName);
    ...
    console.error([DIAG-approval] emit approvalCreated runId=, runId, approvalId=, approvalId, listeners=, this.listenerCount(approvalCreated));

They use console.error (not logger.debug or logger.error), guaranteeing they fire in every environment, are unfilterable by log level, and pollute cyboflow-backend-debug.log. Also defeats the loggerLike injection contract — preToolUseHookHelper.ts:39 even bypasses the injected logger to log to console.error directly when logger is undefined. TASK-706 and TASK-708 both passed verifier without cleaning these up; the per-task reviewer scoped to its own diff would not have flagged them.

Suspected tasks: TASK-694

## FIND-SPRINT-029-8
- **source:** SPRINT-029 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/index.ts:706; main/src/orchestrator/trpc/routers/approvals.ts:67,83
- **description:** Cross-task data drift: approvalCreated SSE stream emits workflowName='' while listPending JOINs workflows.name and returns the real value. The renderer reviewQueueStore consumes BOTH paths into the SAME Approval shape:
- **suggested_action:** Resolve workflowName at emit time in the bridge — either (a) JOIN to workflows in a single prepared statement inside the bridge callback (preferred — keeps the wire shape consistent), or (b) move the JOIN into ApprovalRouter.requestApproval so the in-memory ApprovalRequest carries workflowName from creation. Either way, remove the TODO and the hardcoded empty string. Add a unit test that round-trips an approval through both paths and asserts workflowName matches.
- **resolved_by:** 





  // index.ts:706 (TASK-694 bridge)
  const event: ApprovalCreatedEvent = {
    approval: {
      ...
      workflowName: '', // TODO(approval-router): resolve via workflows-table lookup
      ...
    },
  };

  // orchestrator/trpc/routers/approvals.ts:67,83 (TASK-706)
  SELECT ... w.name AS workflowName ...
  return rows.map((row): Approval => ({
    workflowName: row.workflowName,
    ...
  }));

The consequence is observable in the UI: cards that arrive via the live SSE event stream show a blank workflow name, while cards loaded from listPending show the real name. Same renderer slice, two visibly different shapes for the same Approval.

This is the canonical class of bug only the sprint-code-reviewer can catch — TASK-694's reviewer saw only the bridge in isolation, TASK-706's reviewer saw only listPending in isolation, neither saw the cross-task divergence.

Suspected tasks: TASK-694, TASK-706

## FIND-SPRINT-029-9
- **source:** SPRINT-029 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/index.ts:706-714; main/src/orchestrator/trpc/routers/approvals.ts:85-87
- **description:** Duplicated payloadPreview truncation logic — two cross-task sites both implement the same 512-char truncation:
- **suggested_action:** Extract a single helper, e.g. `truncatePayloadPreview(raw: string): string` in shared/types/approvals.ts (or a sibling utility module), with the 512 length exported as PAYLOAD_PREVIEW_MAX_LEN. Both the bridge and listPending should import and call it. Add a unit test pinning the length and the slice behavior.
- **resolved_by:** 




  // index.ts:706 (TASK-694 bridge)
  const payloadJson = JSON.stringify(request.input);
  ...
  payloadPreview: payloadJson.length > 512 ? payloadJson.slice(0, 512) : payloadJson,

  // orchestrator/trpc/routers/approvals.ts:85 (TASK-706 listPending)
  payloadPreview: row.payloadPreviewRaw.length > 512
    ? row.payloadPreviewRaw.slice(0, 512)
    : row.payloadPreviewRaw,

If the truncation length changes (e.g. 1024, or a smarter end-of-token boundary), both sites must change. If only one changes, the SSE stream and the listPending refresh will deliver different-sized previews for the same approval. The 512 magic number is duplicated as a literal, not a named constant.

Suspected tasks: TASK-694, TASK-706

## FIND-SPRINT-029-10
- **source:** SPRINT-029 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/approvalRouter.test.ts:50-78; main/src/orchestrator/__tests__/runRecovery.test.ts:44-69; main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts:33-60
- **description:** Duplicated test-DB helpers across three new test files written by different tasks:
- **suggested_action:** Promote createTestDb and seedRun to a single shared helper module under `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` (or extend the existing `main/src/database/__test_fixtures__/` location). Standardize on ONE schema source — either GATE_SCHEMA (preferred — in-memory, no file I/O) or `006_cyboflow_schema.sql`. Update all three test files to import. Add a unit test asserting GATE_SCHEMA stays in sync with the migration via a column-level diff.
- **resolved_by:** 



  - approvalRouter.test.ts (TASK-303/305): createTestDb + seedRun reading `006_cyboflow_schema.sql` via readFileSync
  - runRecovery.test.ts (TASK-708): createTestDb + seedRun reading `006_cyboflow_schema.sql` via readFileSync — near-identical body
  - trpc/routers/__tests__/approvals.test.ts (TASK-706): createTestDb using GATE_SCHEMA from registrySchema.ts + seedRun

Problems:
1. The function name `createTestDb` clashes across three sibling test files. A future refactor that promotes it to a shared helper risks an import collision.
2. Two helpers read the migration SQL from disk; one uses the in-memory GATE_SCHEMA fixture. If migration 006 drifts from GATE_SCHEMA (TASK-654's migration 008 already introduced one such drift point), the three test suites will silently test against different schemas — TASK-706's approvals.test.ts will see one shape, TASK-303/305/708's tests will see another. The existing `pnpm run verify:schema` guard only compares schema.sql vs database.ts, not these test fixtures.
3. seedRun has three subtly different signatures (one uses policy_json='{}', one uses status union literals, one returns {workflowId, runId}).

This is the textbook cross-task duplication signal — each per-task reviewer saw only its own file and waved through `it works in isolation`.

Suspected tasks: TASK-303, TASK-305, TASK-706, TASK-708

## FIND-SPRINT-029-11
- **source:** SPRINT-029 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/approvalRouter.ts:454 (recoverStaleAwaitingReview); main/src/orchestrator/runRecovery.ts:27 (recoverActiveStateOrphans); main/src/index.ts:721-735 (callsites)
- **description:** Boot recovery is split across two locations with overlapping concerns and identical call patterns:
- **suggested_action:** Consolidate into a single module — e.g. `main/src/orchestrator/runRecovery.ts` exporting `recoverAllBootOrphans(db, runQueues): { awaitingReviewRecovered, runningRecovered, startingRecovered, approvalsCanceled }`. Move the ApprovalRouter method body into the free function (or keep it on the singleton but have runRecovery delegate to it). Single call in index.ts. Update tests to point at the new entry point. Optional follow-on, not blocking.
- **resolved_by:** 


  1. ApprovalRouter.recoverStaleAwaitingReview() (TASK-305) — handles workflow_runs.status='awaiting_review' AND flips matching pending approvals to 'timed_out'.
  2. recoverActiveStateOrphans() (TASK-708) — handles workflow_runs.status IN ('starting','running') AND flips matching pending approvals to 'timed_out'.

Both functions:
  - Operate on the same workflow_runs + approvals tables
  - Use identical 'timed_out' / 'system' / 'app_restart' sentinel values
  - Run back-to-back at index.ts:721 and index.ts:728 in the same boot path
  - Use the same single-transaction pattern

Difference: TASK-305 lives as a method on the ApprovalRouter singleton, TASK-708 lives as a free function in a separate module. The split reflects task boundaries, not domain boundaries. A future maintainer asking 'what state does boot recovery touch?' must read two files; a future bug that flips runs/approvals state on app_restart must be patched in two places.

Minor because both functions are tested and work; the structural concern is maintainability and discoverability.

Suspected tasks: TASK-305, TASK-708

## FIND-SPRINT-029-12
- **source:** SPRINT-029 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/index.ts:691
- **description:** Minor redundancy: `createContext({ db: db, setDockBadge: ... })` — `db: db` is the long-hand shorthand. Should be `createContext({ db, setDockBadge: ... })`. Trivial but worth a one-line cleanup; the same file uses the shorthand idiomatic form elsewhere (e.g. `new Orchestrator({ db, logger: loggerLike, runQueues })` at index.ts:683).

Suspected tasks: TASK-706
- **suggested_action:** One-line edit: `db: db` → `db` on main/src/index.ts:691.
- **resolved_by:** 
