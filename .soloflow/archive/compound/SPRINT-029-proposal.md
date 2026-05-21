---
sprints: [SPRINT-029]
span_label: SPRINT-029
created: 2026-05-21T22:30:00.000Z
counters_start:
  ideas: 24
summary:
  cleanups: 3
  backlog_tasks: 6
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-029

## A. Clean-up items (execute now)

### A1. Remove 3 stale stub assertions from router.test.ts
- **Summary:** Delete the 3 now-failing stub-era assertions in `main/src/orchestrator/trpc/__tests__/router.test.ts` (lines 113-127) that test the old `listPending`/`approve`/`reject` stubs — these throw `TRPCError: ApprovalRouter has not been initialized` because TASK-706 wired live handlers, and the equivalent coverage already exists in the dedicated `approvals.test.ts`.
- **Source-Sprint:** SPRINT-029
- **Rationale:** The 3 assertions have been failing since TASK-706 merged (FIND-SPRINT-029-4). They test stub behavior (`listPending returns []`, `approve/reject return {success:true}`) that no longer exists. The dedicated `approvals.test.ts` (9 tests, all passing) is the canonical home for approvals handler coverage. Deleting the stale assertions drops the failing count from 4 to 1 (only the pre-existing killProcess timeout remains) and removes dead test surface that would mislead future maintainers.
- **Blast radius:** `main/src/orchestrator/trpc/__tests__/router.test.ts` lines 113-127 deleted (or narrowed to remove the 3 failing `it` blocks). Risk: trivial — we are removing failing tests that document obsolete behavior.
- **Source:** FIND-SPRINT-029-4 (TASK-706 verifier); sprint-verification report confirming 3 failures are from these assertions.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/trpc/__tests__/router.test.ts
  // Delete the following 3 test cases (lines 113-127 at time of finding):
  -  it('cyboflow.approvals.listPending returns an empty array (stub — DB not yet wired)', ...)
  -  it('cyboflow.approvals.approve resolves { success: true } (stub)', ...)
  -  it('cyboflow.approvals.reject resolves { success: true } (stub)', ...)
  // The remaining router shape / wiring tests should be kept.
  // After deletion, pnpm --filter main test should show 0 failures in router.test.ts.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/orchestrator/trpc/__tests__/router.test.ts:113-127` — the 3 stub-era assertions test `listPending returns []` and `{success:true}` returns that no longer match the live wiring from TASK-706, and dedicated `approvals.test.ts` already covers the new behavior.

### A2. Remove all DIAG-* console.error instrumentation from production code
- **Summary:** Delete the 12 `[DIAG-*]` `console.error` lines added by TASK-694 across `main/src/orchestrator/approvalRouter.ts` (7 lines) and `main/src/orchestrator/preToolUseHookHelper.ts` (5 lines) — these are temporary diagnostic artifacts that pollute `cyboflow-backend-debug.log` and bypass the project's logger abstraction on every approval request.
- **Source-Sprint:** SPRINT-029
- **Rationale:** Every approval request currently emits 12 stderr lines (7 from `approvalRouter.ts` alone: entry → before queue.add → task entered → before txn.run → after txn.run → pending set → emit approvalCreated; 5 from `preToolUseHookHelper.ts`). These use `console.error` (unfilterable by log level, guaranteed to fire in production), and `preToolUseHookHelper.ts:39` even bypasses the injected logger to write to `console.error` directly when `logger` is undefined — defeating the loggerLike injection contract. TASK-706 and TASK-708 both shipped without cleaning these up because per-task code reviewers only saw their own diffs. The sprint-code-reviewer (FIND-SPRINT-029-7) caught the cross-task issue. If any of the 12 signals retain diagnostic value, they should be replaced with a single `logger.debug` call gated on a debug flag — not hardcoded `console.error`.
- **Blast radius:** `main/src/orchestrator/approvalRouter.ts` (7 lines removed), `main/src/orchestrator/preToolUseHookHelper.ts` (5 lines removed). Risk: low — removing logging-only calls, no behavioral change. Add a grep-gate comment or CI check: `grep -rn '\[DIAG-' main/src/` should return 0 matches post-cleanup.
- **Source:** FIND-SPRINT-029-7 (sprint-code-reviewer); TASK-694-done.md listing the 7+5 DIAG checkpoint commits.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/approvalRouter.ts — remove all lines matching:
  -  console.error('[DIAG-approval] requestApproval entry runId=', runId, 'tool=', toolName);
  -  console.error('[DIAG-approval] before queue.add runId=', runId);
  -  console.error('[DIAG-approval] queue task entered runId=', runId);
  -  console.error('[DIAG-approval] before txn.run runId=', runId);
  -  console.error('[DIAG-approval] after txn.run runId=', runId);
  -  console.error('[DIAG-approval] pending set runId=', runId, 'approvalId=', approvalId);
  -  console.error('[DIAG-approval] emit approvalCreated runId=', runId, 'approvalId=', approvalId, 'listeners=', this.listenerCount('approvalCreated'));

  // main/src/orchestrator/preToolUseHookHelper.ts — remove all lines matching:
  -  console.error('[DIAG-hook] ...');  // (5 occurrences at lines 38, 39, 42, 49, 69)
  // Note: line 39 bypasses the injected logger; also remove the surrounding undefined-check
  // that exists solely to guard the console.error bypass.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms 12 `[DIAG-*] console.error` lines in `approvalRouter.ts` (7 at lines 178/201/203/228/230/244/248) and `preToolUseHookHelper.ts` (5 at lines 38/39/42/49/69) — these are unfilterable debug artifacts that fire on every approval and bypass the injected `loggerLike`.

### A3. Fix `db: db` shorthand redundancy at index.ts:691
- **Summary:** Replace `createContext({ db: db, setDockBadge: ... })` with `createContext({ db, setDockBadge: ... })` at `main/src/index.ts:691` — a one-line cosmetic fix to use ES2015 property shorthand consistently with the rest of the file.
- **Source-Sprint:** SPRINT-029
- **Rationale:** The same file uses shorthand elsewhere (e.g. `new Orchestrator({ db, logger: loggerLike, runQueues })` at line 683). The `db: db` long form is an inconsistency introduced by TASK-706 when it passed `db` into `createContext`. Minor but worth a one-liner cleanup.
- **Blast radius:** `main/src/index.ts` line 691 only. Risk: trivial — pure cosmetic, no behavioral change.
- **Source:** FIND-SPRINT-029-12 (sprint-code-reviewer); TASK-706-done.md as the introducing commit.
- **Proposed change:**
  ```diff
  // main/src/index.ts:691
  -  createContext({ db: db, setDockBadge: ... })
  +  createContext({ db, setDockBadge: ... })
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/index.ts:691` — `db: db` long-form is inconsistent with shorthand `{ db, logger: loggerLike, runQueues }` at line 681; one-line cosmetic fix in an isolated callsite.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Diagnose and fix the pre-existing killProcess test timeout
- **Summary:** Investigate and fix the pre-existing 5s timeout in `claudeCodeManager.killProcess.test.ts > killProcess mid-stream clears pipelines, sdkRuns, and processes maps` and the companion `TypeError: Cannot read properties of undefined (reading 'close') at db.close()` in `afterEach`.
- **Source-Sprint:** SPRINT-029
- **Source:** FIND-SPRINT-029-1 (TASK-695 verifier); sprint-verification report confirming the failure is pre-existing at base SHA 28f8281 and not a SPRINT-029 regression.
- **Problem:** `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts:158` times out at 5000ms (`killProcess mid-stream` case) and the `no-active-run` companion case errors with `TypeError: Cannot read properties of undefined (reading 'close')` in `afterEach`. The test file was last touched by TASK-647. The suspected root cause (per FIND-SPRINT-029-1) is the db helper not returning a `Database` instance after a recent migration change, plus a teardown/timeout interaction with `ApprovalRouter._resetForTesting`. This has been masking from the test suite for multiple sprints because prior verifiers did not run the full root `test:unit` suite.
- **Proposed direction:** Read `claudeCodeManager.killProcess.test.ts` in full, trace the `afterEach` db teardown, confirm whether `createTestDb` or the equivalent returns `undefined` or a closed handle. Check if `ApprovalRouter._resetForTesting` was added after TASK-647 and whether it needs to be called before the timeout fires. Fix the teardown so `db.close()` is guarded, and investigate whether the `mid-stream` timeout indicates a real hang in the kill path or a missing `vi.useFakeTimers()` / `vi.runAllTimers()` call needed after the ApprovalRouter additions.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Real concrete harm — `claudeCodeManager.killProcess.test.ts:158` is a confirmed hang (5s timeout + `db.close()` TypeError in `afterEach`) that was hidden until SPRINT-029 ran the full root suite, leaving a failing test in main; scope is bounded to one test file.

### B2. Replace residual `|| 'approve'` literals with `DEFAULT_PERMISSION_MODE` constant
- **Summary:** Audit and replace the 5 remaining `|| 'approve'` fallback literals in product code with the `DEFAULT_PERMISSION_MODE` import from `shared/types/permissionMode.ts`, completing the documented permissionMode contract Rule 5 from CODE-PATTERNS.md.
- **Source-Sprint:** SPRINT-029
- **Source:** FIND-SPRINT-029-2 (TASK-654 verifier); TASK-654-done.md noting the finding was emitted at task completion.
- **Problem:** TASK-654 documented Rule 5 in `docs/CODE-PATTERNS.md`: "Do NOT hardcode the string `'approve'` as a standalone fallback literal (`|| 'approve'`)." However, 5 such literals remain in product code at: `frontend/src/components/CreateSessionDialog.tsx:91`, `frontend/src/components/CreateSessionDialog.tsx:633`, `frontend/src/components/panels/cli/BaseCliPanel.tsx:425`, `main/src/events.ts:667`, and `main/src/services/panels/claude/claudeCodeManager.ts:258`. These were introduced by TASK-569 when it flipped 15 camelCase callsites and missed the snake-case attribute paths. They contradict the contract the task itself just documented.
- **Proposed direction:** Run `grep -rnE "\|\| 'approve'" frontend/src main/src` to enumerate all 5 sites. For each, replace with `import { DEFAULT_PERMISSION_MODE } from 'shared/types/permissionMode'` and substitute `|| DEFAULT_PERMISSION_MODE`. Verify `pnpm typecheck` and `pnpm lint` exit 0. Add the grep pattern to the `## Grep-gate verification` block in CLAUDE.md or CODE-PATTERNS.md so future agents catch new occurrences (the pattern `\|\| 'approve'` already suggested in FIND-SPRINT-029-2 — add it to the sprint-verifier grep-gates contract).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms all 5 cited `|| 'approve'` literals exist in product code at the exact paths, directly contradicting the Rule 5 contract that TASK-654 just landed in `docs/CODE-PATTERNS.md` — closing the gap that the rule documents.

### B3. Fix workflowName data drift between SSE bridge and listPending
- **Summary:** Resolve the `workflowName: ''` hardcode in the `approvalCreated` SSE bridge (`main/src/index.ts:706`) so it emits the real workflow name, eliminating the observable UI inconsistency where cards arriving via the live SSE stream show a blank workflow name while cards loaded from `listPending` show the real name.
- **Source-Sprint:** SPRINT-029
- **Source:** FIND-SPRINT-029-8 (sprint-code-reviewer); TASK-694-done.md (bridge author) and TASK-706-done.md (listPending author) as the two diverging tasks.
- **Problem:** `main/src/index.ts:706` (TASK-694 bridge) emits `workflowName: ''` with a `TODO(approval-router): resolve via workflows-table lookup`. `main/src/orchestrator/trpc/routers/approvals.ts:67,83` (TASK-706 listPending) JOINs `workflows.name` and returns the real value. The renderer `reviewQueueStore` consumes both paths into the same `Approval` shape — visible consequence: SSE-pushed cards render a blank workflow name, while listPending-hydrated cards render the real name. The divergence is a textbook cross-task data-drift that per-task reviewers couldn't see.
- **Proposed direction:** Resolve `workflowName` at emit time in the bridge. Preferred approach (a): perform a single prepared SELECT against `workflows` inside the `approvalCreated` bridge callback using the `runId` → `workflow_runs.workflow_id` → `workflows.name` chain (the `db` reference is already in scope after TASK-706 threaded it through `createContext`). Alternative approach (b): move the JOIN into `ApprovalRouter.requestApproval` so the in-memory `ApprovalRequest` carries `workflowName` from creation, removing the bridge's need to look it up. Either way, remove the `TODO` comment and the hardcoded empty string. Add a unit test that round-trips an approval through both the SSE event and `listPending` and asserts `workflowName` matches in both responses.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed concrete UI bug — `main/src/index.ts:706` emits `workflowName: ''` with a TODO while `approvals.ts:67,83` JOINs and returns the real value, producing visibly inconsistent cards in the same `reviewQueueStore` slice for the same approval depending on arrival path.

### B4. Extract shared payloadPreview truncation helper
- **Summary:** Replace the two independent 512-char truncation implementations in the SSE bridge (`main/src/index.ts`) and in `listPending` (`main/src/orchestrator/trpc/routers/approvals.ts`) with a single exported helper and named constant, eliminating the risk of the two paths delivering different-sized previews for the same approval.
- **Source-Sprint:** SPRINT-029
- **Source:** FIND-SPRINT-029-9 (sprint-code-reviewer); TASK-694-done.md and TASK-706-done.md as the two introducing tasks.
- **Problem:** Both `main/src/index.ts:706-714` (TASK-694 bridge) and `main/src/orchestrator/trpc/routers/approvals.ts:85-87` (TASK-706 listPending) implement `payloadJson.length > 512 ? payloadJson.slice(0, 512) : payloadJson` as an inline literal. The magic number `512` is duplicated. If the truncation length changes (e.g. to 1024 or a smarter boundary), both sites must change in sync — if only one changes, the SSE stream and listPending deliver different-sized previews for the same approval.
- **Proposed direction:** Extract `truncatePayloadPreview(raw: string): string` and `PAYLOAD_PREVIEW_MAX_LEN = 512` into `shared/types/approvals.ts` (or a sibling `shared/utils/approvals.ts` if the types file is schema-only). Update both the bridge and `listPending` to import and call the helper. Add a unit test in `shared/` pinning the length constant and the slice behavior (including the boundary case: exactly 512 chars passes through, 513 chars truncates).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed duplication at `main/src/index.ts:708` and `main/src/orchestrator/trpc/routers/approvals.ts:85-87` — same magic `512` literal across two paths feeding the same `Approval` shape; small shared helper proportional to the drift risk and pairs naturally with B3 in the same compound bucket.

### B5. Consolidate duplicated createTestDb/seedRun test helpers across three test files
- **Summary:** Extract the near-identical `createTestDb` and `seedRun` helpers from `approvalRouter.test.ts`, `runRecovery.test.ts`, and `approvals.test.ts` into a single shared fixture module, resolving the schema-source divergence (two helpers read `006_cyboflow_schema.sql` from disk, one uses the in-memory `GATE_SCHEMA`) and the subtle `seedRun` signature drift.
- **Source-Sprint:** SPRINT-029
- **Source:** FIND-SPRINT-029-10 (sprint-code-reviewer); TASK-303-done.md, TASK-305-done.md, TASK-706-done.md, TASK-708-done.md as the four introducing tasks.
- **Problem:** Three new test files written by different tasks each define their own `createTestDb` and `seedRun`:
  1. `main/src/orchestrator/__tests__/approvalRouter.test.ts` (TASK-303/305): reads `006_cyboflow_schema.sql` via `readFileSync`
  2. `main/src/orchestrator/__tests__/runRecovery.test.ts` (TASK-708): near-identical body, also reads `006_cyboflow_schema.sql`
  3. `main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts` (TASK-706): uses `GATE_SCHEMA` from `registrySchema.ts` + a different `seedRun` signature
  
  Three problems: (1) name clash risks import collision on future promotion; (2) two schema sources diverge silently as migrations land (migration 008 is already a drift point); (3) `seedRun` has three subtly different signatures.
- **Proposed direction:** Create `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` (or extend `main/src/database/__test_fixtures__/`). Standardize on `GATE_SCHEMA` as the single schema source (preferred: in-memory, no file I/O, no ENOENT risk). Define one canonical `seedRun(db, overrides?: Partial<...>): {workflowId, runId}` signature. Update all three test files to import. Add a column-level diff assertion that `GATE_SCHEMA` stays in sync with `006_cyboflow_schema.sql` (or validate via `pnpm run verify:schema` extension).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed three diverging `createTestDb`/`seedRun` implementations (`runRecovery.test.ts:44-68`, `approvalRouter.test.ts:50`, `approvals.test.ts:33-60`) — two read `006_cyboflow_schema.sql` from disk while one uses in-memory `GATE_SCHEMA`, and `__test_fixtures__/` already exists as a natural landing site, making this a proportional consolidation rather than new infra.

### B6. Consolidate boot recovery into a single module
- **Summary:** Merge `ApprovalRouter.recoverStaleAwaitingReview()` (TASK-305) and `recoverActiveStateOrphans()` (TASK-708) into a single boot-recovery entry point so that a future maintainer asking "what state does boot recovery touch?" reads one file instead of two.
- **Source-Sprint:** SPRINT-029
- **Source:** FIND-SPRINT-029-11 (sprint-code-reviewer, severity: low); TASK-305-done.md and TASK-708-done.md as the two introducing tasks.
- **Problem:** Boot recovery is split across `ApprovalRouter.recoverStaleAwaitingReview()` (a method on the singleton, handles `awaiting_review` runs + pending approvals) and `recoverActiveStateOrphans()` (a free function in a separate module, handles `starting`/`running` orphans + pending approvals). Both operate on the same tables, use the same sentinel values (`'timed_out'`, `'system'`, `'app_restart'`), and are called back-to-back at `main/src/index.ts:721,728`. The split reflects task boundaries, not domain boundaries.
- **Proposed direction:** Export a single `recoverAllBootOrphans(db, runQueues): { awaitingReviewRecovered, runningRecovered, startingRecovered, approvalsCanceled }` from `main/src/orchestrator/runRecovery.ts`. Move the `ApprovalRouter.recoverStaleAwaitingReview()` logic into this free function (or have it delegate), keeping the `ApprovalRouter` singleton method as a thin wrapper if callers need the instance API. Single call in `main/src/index.ts`. Update `approvalRouter.test.ts` and `runRecovery.test.ts` to target the new entry point. This is optional/low-urgency — both functions work correctly; the concern is maintainability.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Finding itself labels this severity:low and "optional/low-urgency — both functions work correctly"; the proposed move (singleton method → free function or wrapper) plus test retargeting across `approvalRouter.test.ts` and `runRecovery.test.ts` exceeds the harm of two callsites 7 lines apart at `index.ts:721,728`.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the pnpm dev NMV side-effect and targeted rebuild command
- **Summary:** Add a note to CLAUDE.md warning that `pnpm dev` rebuilds better-sqlite3 for Electron's ABI, causing subsequent `pnpm --filter main test` runs to fail with `ERR_DLOPEN_FAILED` — and that `pnpm rebuild better-sqlite3` (not the full `pnpm electron:rebuild`) is the fast targeted fix.
- **Source-Sprint:** SPRINT-029
- **Target file:** `CLAUDE.md`
- **Rationale:** FIND-SPRINT-029-3 and FIND-SPRINT-029-6 document this recurring pattern: `pnpm dev` triggers `electron-builder install-app-deps` which rebuilds better-sqlite3 against Electron ABI 136; any subsequent node-only test runner then fails with `ERR_DLOPEN_FAILED` (ABI 127 vs 136). This hit the sprint twice (once during TASK-305 executor, once during sprint-verifier). The sprint-verification report notes "The recurring fingerprint is now stable across two sprints." The existing `pnpm electron:rebuild` entry in CLAUDE.md covers only the "after Node/Electron upgrades" case; it does not cover the `pnpm dev` postinstall side-effect, which is a different trigger with a faster fix (`pnpm rebuild better-sqlite3` only, rather than a full rebuild).
- **Proposed change:**
  ```diff
  ## Common Commands

  ```bash
  pnpm dev               # Electron dev (Vite renderer + Electron main)
  pnpm build:main        # Compile main process (run at least once before `pnpm dev`)
  pnpm typecheck         # Type-check all workspaces
  pnpm lint              # Lint all workspaces
  pnpm test              # Playwright E2E
  pnpm electron:rebuild  # Fix better-sqlite3 NODE_MODULE_VERSION errors after Node/Electron upgrades
  ```
  +
  +**NMV drift after `pnpm dev`:** Running `pnpm dev` triggers `electron-builder install-app-deps`
  +which rebuilds better-sqlite3 for Electron's ABI (136). Subsequent `pnpm --filter main test`
  +runs then fail with `ERR_DLOPEN_FAILED` (Node ABI 127 vs Electron ABI 136). Fix with:
  +```bash
  +pnpm rebuild better-sqlite3   # faster than full electron:rebuild; resets to host Node ABI
  +```
  +Run this any time you see `ERR_DLOPEN_FAILED` on `new Database(:memory:)` in test output.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Recurring trap with strong frequency evidence — grep of `.soloflow/archive/findings/` shows NMV/ERR_DLOPEN_FAILED hits in SPRINT-006, 008, 014, 026, and now 029; the existing `pnpm electron:rebuild` entry covers only the "after Node/Electron upgrades" trigger and misses the faster targeted fix for the `pnpm dev` postinstall side-effect.

---

## Reconciled Findings (informational)

The following finding was recorded as `status: open` in the findings file but was already resolved during the sprint. The sprint-closer's reconciliation step did not patch the status field; the cross-check here catches the drift.

- **FIND-SPRINT-029-5** — claimed resolved by TASK-706 in `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/approval-router-and-permission-fix/TASK-706-done.md`. TASK-706 removed the two unused declarations from `main/src/utils/mutex.ts` (unused `Logger` import and unused `lockId` const) as a follow-on to its own AC #11 typecheck regression. Sprint-verification report independently confirms: "FIND-SPRINT-029-5 (mutex.ts TS6133) is resolved" and `pnpm typecheck` exits 0 across all workspaces.
