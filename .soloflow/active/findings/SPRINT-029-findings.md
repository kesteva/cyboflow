---
sprint: SPRINT-029
pending_count: 4
last_updated: "2026-05-21T21:30:00.000Z"
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
