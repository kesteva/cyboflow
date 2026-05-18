---
sprints: [SPRINT-017]
span_label: SPRINT-017
created: 2026-05-18T22:30:00.000Z
counters_start:
  ideas: 19
summary:
  cleanups: 5
  backlog_tasks: 4
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-017

## A. Clean-up items (execute now)

### A1. Fix stale `approvals.ts` file-header index (missing `rejectRestOfRun` bullet)
- **Summary:** The top-of-file procedure index in `main/src/orchestrator/trpc/routers/approvals.ts` omits `rejectRestOfRun`, which TASK-616 added — readers grepping the header to enumerate the surface will miss it.
- **Source-Sprint:** SPRINT-017
- **Rationale:** Pure docstring fix; zero behavioral impact. A reader scanning the file-header to understand the full `cyboflow.approvals` surface will miss `rejectRestOfRun` until this is corrected. The suggested_action in the finding gives the exact insertion point.
- **Blast radius:** `main/src/orchestrator/trpc/routers/approvals.ts` (one line insert), trivial
- **Source:** FIND-SPRINT-017-6 (TASK-616 code-reviewer)
- **Proposed change:**
  ```diff
  // main/src/orchestrator/trpc/routers/approvals.ts (lines 4-8 area)
  // Insert after the `approveRestOfRun` bullet:
  -  *   - approveRestOfRun   : mutation → { decided: number } (TASK-406 — per-run batch approve)
  +  *   - approveRestOfRun   : mutation → { decided: number } (TASK-406 — per-run batch approve)
  +  *   - rejectRestOfRun    : mutation → { decided: number } (TASK-616 — per-run batch reject)
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `rejectRestOfRun` is defined in `main/src/orchestrator/trpc/routers/approvals.ts:133` but the file-header index (lines 4-8) stops at `approveRestOfRun` — one-line docstring fix, zero behavioral risk.

### A2. Sweep all four local `interface IPCResponse<T>` declarations and replace with canonical import
- **Summary:** Four frontend files (`App.tsx`, `OnboardingCard.tsx`, `DiscordPopup.tsx`, `ReviewQueueView.tsx`) declare a local `interface IPCResponse<T>` that CLAUDE.md explicitly forbids — all four should import from `frontend/src/utils/api.ts` instead.
- **Source-Sprint:** SPRINT-017
- **Rationale:** CLAUDE.md states "Never declare a local `interface IPCResponse<T>` … in frontend code" and provides an audit recipe (`grep -rn "interface IPCResponse" frontend/src/`). These four files are the complete set of violations at current HEAD; fixing them in one sweep avoids the per-task reviewers continuing to miss pre-existing offenders (as happened with TASK-611 and `ReviewQueueView.tsx`). The CLAUDE.md rule also requires explicit `T` type parameters on each `electronInvoke(...)` call to force narrowing.
- **Blast radius:** `frontend/src/App.tsx:34`, `frontend/src/components/OnboardingCard.tsx:4`, `frontend/src/components/DiscordPopup.tsx:5`, `frontend/src/components/ReviewQueueView.tsx:9` — four files, low risk (pure import-substitution + explicit type param addition)
- **Source:** FIND-SPRINT-017-9 (sprint-code-reviewer umbrella, covering App.tsx / OnboardingCard.tsx / DiscordPopup.tsx) + FIND-SPRINT-017-1 (TASK-611 executor, covering ReviewQueueView.tsx)
- **Proposed change:**
  In each of the four files, remove the local `interface IPCResponse<T> { success: boolean; data?: T; error?: string }` declaration and replace it with:
  ```diff
  + import type { IPCResponse } from '../utils/api'; // adjust relative path per file
  ```
  Then add an explicit type parameter to each `electronInvoke(...)` / `window.electron.*` call in those files. The ambient global declaration in `frontend/src/types/electron.d.ts` is exempt (the CLAUDE.md audit recipe says so).

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `grep -rn "interface IPCResponse" frontend/src/` confirms exactly the 4 cited violation sites plus the canonical export in `utils/api.ts` and the exempt `types/electron.d.ts` — CLAUDE.md explicitly forbids these local declarations and supplies the audit recipe, so the sweep matches an existing rule rather than codifying a new one.

### A3. Add `approvals.rejectRestOfRun` to the tRPC stub bucket in `docs/ARCHITECTURE.md`
- **Summary:** `docs/ARCHITECTURE.md` lines 106-109 list the renderer-called tRPC stubs for the `approvals.*` namespace but omit `rejectRestOfRun`, which TASK-616 added in the same sprint.
- **Source-Sprint:** SPRINT-017
- **Rationale:** The transport-map section TASK-600 added exists precisely to let developers enumerate every renderer-called stub. One missing entry defeats that purpose. The suggested_action in the finding gives the exact token to append.
- **Blast radius:** `docs/ARCHITECTURE.md` (one line edit), trivial
- **Source:** FIND-SPRINT-017-10 (sprint-code-reviewer; suspected tasks TASK-600 author, TASK-616 adder)
- **Proposed change:**
  ```diff
  // docs/ARCHITECTURE.md ~line 108
  - approvals.listPending, approvals.approve, approvals.reject, approvals.approveRestOfRun — called by PendingApprovalCard, useReviewQueueKeyboard, and reviewQueueStore.
  + approvals.listPending, approvals.approve, approvals.reject, approvals.approveRestOfRun, approvals.rejectRestOfRun — called by PendingApprovalCard, useReviewQueueKeyboard, and reviewQueueStore.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `docs/ARCHITECTURE.md:107-109` confirms the bullet stops at `approveRestOfRunHandler` while `useReviewQueueKeyboard.ts:122` already invokes `rejectRestOfRun.mutate` — one-token append keeps the transport-map section authoritative.

### A4. Replace the local `dbAdapter` in `main/src/trpc/__tests__/approvals.test.ts` with the shared fixture import
- **Summary:** TASK-616's new test file declared its own narrow `dbAdapter` (lines 39-54) instead of importing the shared `main/src/orchestrator/__test_fixtures__/dbAdapter.ts`, adding a 7th drift site that also bypasses the fixture's type-safety guarantee.
- **Source-Sprint:** SPRINT-017
- **Rationale:** The shared fixture's docstring explicitly warns "any future widening of DatabaseLike fails the build here, not in 4 silently-drifting test copies." TASK-616's local copy is also shape-narrower (only `all` and `run`, missing `transaction`), so it cannot satisfy `DatabaseLike` — which means the compile-time contract the shared fixture exists to provide is completely bypassed in this new test. The fix is a one-line import swap; the shared fixture path is `../../orchestrator/__test_fixtures__/dbAdapter`.
- **Blast radius:** `main/src/trpc/__tests__/approvals.test.ts` (remove ~16 lines, add 1 import line), low risk
- **Source:** FIND-SPRINT-017-11 (sprint-code-reviewer; TASK-616 as adder of the new local copy)
- **Proposed change:**
  ```diff
  // main/src/trpc/__tests__/approvals.test.ts lines 39-54
  - function dbAdapter(db: Database.Database) {
  -   return {
  -     all: <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[],
  -     run: (sql: string, ...params: unknown[]): Database.RunResult => db.prepare(sql).run(...params),
  -   };
  - }
  + import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Local copy at `main/src/trpc/__tests__/approvals.test.ts:39-54` returns a non-`DatabaseLike` shape (no `transaction`) while the shared fixture at `main/src/orchestrator/__test_fixtures__/dbAdapter.ts:10` returns full `DatabaseLike` — swap-in is compatible because `approveRestOfRunHandler` only uses `prepare(sql).all/run`, restoring the compile-time tripwire the shared fixture was designed for.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the shared fixture's better-sqlite3 `prepare` shape silently mismatched the handler's narrower expectation in a way that broke tests.

### A5. Collapse the duplicate inline adapter blocks at `main/src/index.ts` lines 673-684 into shared helpers
- **Summary:** The tRPC-orchestrator block at `main/src/index.ts:673-684` re-defines both an inline `db` adapter and an inline `loggerLike` adapter that are byte-identical or functionally equivalent to the helpers already extracted in TASK-608, and the `loggerLike` copy silently discards the `ctx` parameter unlike `makeLoggerLike`.
- **Source-Sprint:** SPRINT-017
- **Rationale:** TASK-608 extracted `makeLoggerLike` into `main/src/orchestrator/loggerAdapter.ts` specifically to unify context-forwarding semantics, but the older tRPC-orchestrator wiring block at lines 673-684 was not updated. The inline `loggerLike` at line 681 discards `ctx` (no second-arg handling), while `makeLoggerLike` preserves it via `JSON.stringify` — this means two different callers of the same underlying `logger` get different semantics. Additionally, the inline `db` adapter at lines 673-676 is byte-identical to the `cyboflowDb` adapter assembled at lines 554-557. Adding a `makeDatabaseLike(databaseService)` factory next to `makeLoggerLike` in `loggerAdapter.ts` (or a sibling `dbAdapter.ts`) and calling both from lines 673-684 eliminates the DRY violation and unifies semantics.
- **Blast radius:** `main/src/index.ts` (lines 673-684 replaced), `main/src/orchestrator/loggerAdapter.ts` (one new exported factory function added), low risk
- **Source:** FIND-SPRINT-017-5 (TASK-608 code-reviewer)
- **Proposed change:**
  1. Add to `main/src/orchestrator/loggerAdapter.ts`:
  ```diff
  + import type { DatabaseService } from '../services/database';
  + import type { DatabaseLike } from '../orchestrator/types'; // adjust import path
  +
  + export function makeDatabaseLike(databaseService: DatabaseService): DatabaseLike {
  +   return {
  +     all: <T>(sql: string, ...params: unknown[]): T[] =>
  +       databaseService.getDatabase().prepare(sql).all(...params) as T[],
  +     run: (sql: string, ...params: unknown[]): import('better-sqlite3').RunResult =>
  +       databaseService.getDatabase().prepare(sql).run(...params),
  +     transaction: <T>(fn: () => T): T =>
  +       databaseService.getDatabase().transaction(fn)(),
  +   };
  + }
  ```
  2. In `main/src/index.ts` lines 673-684, replace the two inline adapters:
  ```diff
  - const db = {
  -   all: <T>(sql: string, ...params: unknown[]): T[] => ...
  -   run: (sql: string, ...params: unknown[]): ... => ...
  - };
  - const loggerLike = {
  -   log: (msg: string) => logger.info(msg),
  -   warn: (msg: string) => logger.warn(msg),
  -   error: (msg: string) => logger.error(msg),
  - };
  + const db = makeDatabaseLike(databaseService);
  + const loggerLike = makeLoggerLike(logger);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `main/src/index.ts:554-557` and `main/src/index.ts:673-676` define structurally identical `DatabaseLike` adapters and the inline `loggerLike` at lines 679-684 maps `debug` to `logger.info('[debug] ${msg}')` and drops `ctx`, diverging from `makeLoggerLike` in `loggerAdapter.ts:33-38` — extracting one factory eliminates real semantic drift with a proportionate change.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the inline `db` adapter's call sites required behavior that the proposed factory couldn't express without parameters.

## B. Backlog tasks (refine into execution-ready plans)

### B1. Extract `decideRestOfRunHandler` to eliminate the approve/reject clone in `main/src/trpc/routers/approvals.ts`
- **Summary:** `approveRestOfRunHandler` and `rejectRestOfRunHandler` are near-identical ~50-line clones that differ only in the status string and log prefix — collapsing them into a single parameterized factory removes the duplication and prevents the two implementations from drifting.
- **Source-Sprint:** SPRINT-017
- **Source:** FIND-SPRINT-017-7 (sprint-code-reviewer; TASK-406 initial author, TASK-616 cloner)
- **Problem:** `main/src/trpc/routers/approvals.ts` lines 54-156 contain two handlers that are byte-for-byte identical except for the literal `'approved'` / `'rejected'` in the UPDATE SET clause and the error-log prefix. They share the same `withLock('run:${runId}')` scope, the same SELECT-pending SQL, the same UPDATE pattern, the same try/catch/console.error/continue loop, and the same `return { decided }` shape. Future behavior changes (e.g. audit logging, timeout handling, new decision states) must be applied to both files independently, inviting divergence. The per-task reviewer for TASK-616 verified the symmetric behavior but could not see the duplication because TASK-406's code was already in tree before the sprint.
- **Proposed direction:** Add a `decideRestOfRunHandler(db, runId, decision: 'approved' | 'rejected'): Promise<{ decided: number }>` function to `main/src/trpc/routers/approvals.ts`. The SQL becomes `UPDATE approvals SET status = ?, decided_at = ?, decided_by = 'user' WHERE id = ? AND status = 'pending'` with `decision` bound as the first `?`. The error-log prefix becomes `` `[${decision === 'approved' ? 'approveRestOfRun' : 'rejectRestOfRun'}]` ``. Keep the two existing named wrappers (`approveRestOfRunHandler`, `rejectRestOfRunHandler`) as thin one-line call-throughs so that the TODO comments in the orchestrator-side `main/src/orchestrator/trpc/routers/approvals.ts` (lines 109-110 and 139-140) still grep-replace cleanly when `ctx.db` is eventually wired. Update the 3 existing handler tests to cover the shared implementation via both entry points.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `approveRestOfRunHandler` (`main/src/trpc/routers/approvals.ts:54-98`) and `rejectRestOfRunHandler` (lines 112-156) differ only in the `'approved'`/`'rejected'` literal and log prefix — preserving thin named wrappers keeps the existing orchestrator-side TODO grep-replace pivot intact, so the refactor is proportional and lowers future divergence risk.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the orchestrator-side TODOs (`main/src/orchestrator/trpc/routers/approvals.ts:109-140`) named the underlying impl rather than the wrappers, since collapsing would then break the grep-replace pivot.

### B2. Extract `shouldIgnoreKeyboardEvent` utility and apply it to the onboarding-dismiss listener in `ReviewQueueView.tsx`
- **Summary:** The onboarding-dismiss keydown listener in `ReviewQueueView.tsx` uses a weaker focus guard than the hardened `useReviewQueueKeyboard` hook, so a focused button or Radix focus-trap can still trigger an accidental dismiss on a stray `y`/`n` keypress.
- **Source-Sprint:** SPRINT-017
- **Source:** FIND-SPRINT-017-8 (sprint-code-reviewer; TASK-611 initial onboarding listener author, TASK-614 hook hardener)
- **Problem:** `ReviewQueueView.tsx` lines 57-82 register a `window.keydown` listener that guards against `HTMLInputElement`, `HTMLTextAreaElement`, and `isContentEditable` but does NOT guard against the `document.activeElement !== document.body` case. TASK-614 added that guard to `useReviewQueueKeyboard.ts` (line 77), but the sibling listener was missed. Other global keydown listeners elsewhere in the app (`App.tsx`, `SessionView.tsx`, `LogsView.tsx`) also lack the `activeElement` guard, making this a recurring pattern. The `window.keydown` path through the onboarding card is a correctness issue: in any modal or Radix focus-trap context, `y` or `n` can dismiss the onboarding card even though the user intended a different action.
- **Proposed direction:** Create `frontend/src/utils/keyboardGuards.ts` exporting `shouldIgnoreKeyboardEvent(event: KeyboardEvent): boolean` that consolidates the full guard ladder: modifier keys (`metaKey`, `ctrlKey`, `altKey`) check + `document.activeElement !== document.body && document.activeElement !== null` check + `instanceof HTMLInputElement | HTMLTextAreaElement | isContentEditable` check. Update `useReviewQueueKeyboard.ts` to call this utility (replacing its inline guard at line 77) and update the `ReviewQueueView.tsx` onboarding-dismiss listener to call it as well. The JSDoc on `keyboardGuards.ts` should note that `App.tsx`, `SessionView.tsx`, and `LogsView.tsx` global listeners are future migration candidates. Add a test covering the `shouldIgnoreKeyboardEvent` function directly for the three guard conditions, plus regression tests that verify the onboarding-dismiss listener is now guarded.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The concrete bug at `ReviewQueueView.tsx:57-82` (missing `activeElement` guard on the onboarding-dismiss listener) is a one-line inline fix — extracting a new utility file plus tests and noting `App.tsx`/`SessionView.tsx`/`LogsView.tsx` as future migration candidates inflates a low-severity dismiss-banner glitch into a frontend-wide refactor surface, failing proportionality.
- **Counterfactual:** Would flip to IMPLEMENT if multiple cited global listeners were already producing user-visible bugs that this utility would actually migrate in the same change, rather than just being annotated as future migration candidates.

### B3. Expose a subscription surface on `Orchestrator` for `runs:stuck` events before the first real consumer lands
- **Summary:** `Orchestrator.start()` constructs a `StuckDetector` with an anonymous inline `EventEmitter` that is never stored and never accessible externally, silently creating an unreachable event sink for all `runs:stuck` emissions.
- **Source-Sprint:** SPRINT-017
- **Source:** FIND-SPRINT-017-2 (TASK-586 code-reviewer)
- **Problem:** `main/src/orchestrator/Orchestrator.ts:58` passes `emitter: new EventEmitter()` as a constructor argument to `StuckDetector`. The emitter is not stored on `this`, not returned, and `StuckDetector.emitter` is a `private readonly` field with no accessor. Every `runs:stuck` event fired by `StuckDetector.transitionRunsToStuck()` (`stuckDetector.ts:282`) goes into a void sink — no subscriber outside the test harness can receive it. This is functionally a no-op event bus in production. When the first real consumer (stream-parser-to-main or admin-UI epic) needs to subscribe to `runs:stuck`, the wire-up task will rediscover this dead end. The TASK-586 finding acknowledges the design intent ("no speculative wiring") but correctly identifies the inline-anonymous choice as recreating the same invisible failure mode.
- **Proposed direction:** Add a thin subscription facade to `main/src/orchestrator/Orchestrator.ts`: either (a) a `onStuck(listener: (runId: string) => void): () => void` method that proxies to an internal emitter stored on `this`, or (b) a `readonly stuckEmitter: EventEmitter` getter that exposes the `StuckDetector`'s emitter (requires adding a public getter on `StuckDetector`). Option (a) is preferred — it hides the internal EventEmitter, allows `Orchestrator` to own the listener lifecycle, and does not leak the full EventEmitter API. The production `getOrchestrator` factory in `cyboflow.ts` does not need to wire a listener yet; the point is to have a stable subscription API in place before the consumer task arrives so it is not designed around a dead internal emitter. Add one test in `Orchestrator.test.ts` confirming that `onStuck` callbacks fire when `transitionRunsToStuck` is called.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** high
- **Reasoning:** FIND-SPRINT-017-2's own suggested_action ends with "leave the inline emitter — it correctly isolates the dead-event surface from the renderer and matches the 'no speculative wiring' decision. This finding is a forward-looking reminder, not a blocker" — the proposal flips that explicit guidance into preemptive subscription wiring with no current consumer.
- **Counterfactual:** Would flip to IMPLEMENT only when a concrete `runs:stuck` consumer task (stream-parser-to-main or admin-UI epic) is queued in the same sprint so the API shape is co-designed with the consumer.

### B4. Create `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts` and consolidate five scattered test logger helpers
- **Summary:** Five or more orchestrator test files each define their own local `makeLogger`/`makeSilentLogger`/`nullLogger` helper returning a `LoggerLike` with vi.fn spies or no-ops — a shared fixture would eliminate the boilerplate and give all test sites a consistent spy API.
- **Source-Sprint:** SPRINT-017
- **Source:** FIND-SPRINT-017-12 (sprint-code-reviewer; TASK-586 touched `Orchestrator.test.ts` and `stuckDetector.test.ts`; TASK-607 added `makeSilentLogger` in `cyboflow.test.ts`; TASK-636 touched `workflowRegistry.test.ts`)
- **Problem:** The following files each define their own local logger-like test helper: `main/src/orchestrator/__tests__/workflowRegistry.test.ts` (adds `warnCalls`/`errorCalls` arrays for assertion), `main/src/orchestrator/__tests__/runLauncher.test.ts` (pure vi.fn spies), `main/src/ipc/__tests__/cyboflow.test.ts` (vi.fn spies named `makeSilentLogger`), `tests/helpers/cyboflowTestHarness.ts` (no-op closures), and pre-existing sites in `stuckDetector.test.ts` / `mcpServerLifecycle.test.ts`. Every new orchestrator test that reaches `LoggerLike` copies the same 5-7 lines of vi.fn boilerplate, and minor drift accumulates across the copies. The production-side `makeLoggerLike` in `loggerAdapter.ts` (TASK-608) wraps a real `Logger` instance and is not suitable for test use. There is no shared test fixture for `LoggerLike`.
- **Proposed direction:** Add `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts` exporting `makeSpyLogger(): LoggerLike & { calls: Array<{ level: 'log' | 'warn' | 'error'; message: string; ctx?: unknown }> }`. The implementation should use `vi.fn()` for each method and push to the shared `calls` array on each invocation — this is the superset of what `workflowRegistry.test.ts` needs (assertion-friendly `calls` array) and what the other sites need (vi.fn for `.toHaveBeenCalledWith` / `.toHaveBeenCalledTimes`). Migrate all five existing local copies in a single commit: update import paths, remove local declarations. For `cyboflowTestHarness.ts` (no-op closures), document whether silent or spy behavior is preferred there. Per `docs/CODE-PATTERNS.md §Extract-shared-utility refactors`, the plan must grep for all local `makeLogger\|makeSilentLogger\|nullLogger` sites before declaring completeness and list any intentional exclusions.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** low
- **Reasoning:** Grep confirms 6 distinct local `makeLogger`/`makeSilentLogger`/`nullLogger` helpers across `stuckDetector.test.ts:147`, `runLauncher.test.ts:39`, `workflowRegistry.test.ts:42`, `ipc/__tests__/cyboflow.test.ts:47`, `mcpServerLifecycle.test.ts:104`, and `tests/helpers/cyboflowTestHarness.ts:32` — the proposed `__test_fixtures__/loggerLikeSpy.ts` mirrors the established `dbAdapter.ts` fixture pattern, but harm is purely cosmetic so confidence is low.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the workflowRegistry.test.ts-style `calls` array were structurally incompatible with the vi.fn-based assertions used by runLauncher.test.ts / cyboflow.test.ts, forcing the fixture to ship two divergent surfaces.

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the shared `dbAdapter` test fixture in `docs/CODE-PATTERNS.md`
- **Summary:** Add a Shared Utilities entry for `main/src/orchestrator/__test_fixtures__/dbAdapter.ts` so new test authors find the canonical fixture instead of cloning local copies (TASK-616 wrote a 7th clone despite the fixture existing).
- **Source-Sprint:** SPRINT-017
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/docs/CODE-PATTERNS.md`
- **Action:** insert-after `### main/src/utils/devDebugLog` block (last entry under `## Shared Utilities`, before `## Recurring Patterns`)
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ -90,6 +90,13 @@
   - **Canonical example:** `main/src/index.ts` console-wrapper overrides and frontend webContents listener.
   
  +### `main/src/orchestrator/__test_fixtures__/dbAdapter`
  +
  +- **Path:** `main/src/orchestrator/__test_fixtures__/dbAdapter.ts`
  +- **Use it for:** Wrapping a `better-sqlite3` `Database` into the `DatabaseLike` (`{ prepare, transaction }`) shape required by orchestrator and tRPC handler tests. Do NOT clone locally — the `: DatabaseLike` return-type annotation is the build-time tripwire that catches future widening of `DatabaseLike`.
  +- **Canonical example:** `main/src/orchestrator/__tests__/workflowRegistry.test.ts`; recurring drift fixed in FIND-SPRINT-017-11.
  +
   ## Recurring Patterns
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `docs/CODE-PATTERNS.md:85-90` already houses the `devDebugLog` Shared Utilities entry but has no `dbAdapter` entry — and `grep -rn "function dbAdapter"` shows 6 local clones across `main/src/` despite the canonical fixture, including this sprint's new clone in `trpc/__tests__/approvals.test.ts:39`, so a ~7-line doc entry directly addresses a recurring trap.

---

## Reconciled Findings (informational)

_No stale-open findings were found that were actually resolved by a done report's "Findings resolved:" claim. FIND-SPRINT-017-3 was correctly marked `status: resolved` in the findings file itself._

---

## Suppressed — SoloFlow Defects

- **Executor writes findings to wrong sprint file (FIND-SPRINT-017-4)** — FIND-SPRINT-017-4 describes the SoloFlow executor agent using a stale sprint ID when appending to findings files, writing a SPRINT-017 finding to SPRINT-010-findings.md. The second sub-issue (agent classifying an in-scope edit as a deviation because implementation-step prose mentioned a smaller number than the `files_owned` frontmatter list) is also a SoloFlow executor prompt defect. Neither is a project-code convention — both evaporate if this codebase were used with a different workflow tool. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
