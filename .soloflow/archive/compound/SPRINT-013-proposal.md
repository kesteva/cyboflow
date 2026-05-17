---
sprints: [SPRINT-013]
span_label: SPRINT-013
created: 2026-05-17T18:00:00.000Z
counters_start:
  ideas: 16
summary:
  cleanups: 4
  backlog_tasks: 8
  claude_md: 0
  code_patterns: 3
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-013

## A. Clean-up items (execute now)

### A1. Drop spurious `db.transaction()` wrapper in `transitionToStuck`
- **Summary:** `transitionToStuck` wraps a single UPDATE in a transaction that adds no atomicity benefit and forces an ugly double-cast; remove it.
- **Source-Sprint:** SPRINT-013
- **Rationale:** A lone UPDATE is already atomic in SQLite. The idempotency guard is the `WHERE id = ? AND status = 'awaiting_review'` predicate, not the transaction. The wrapper also forces the awkward `(txn as () => { changes: number })()` double-cast on the call site, which is a readability hazard for future editors.
- **Blast radius:** `main/src/orchestrator/stuckDetector.ts` lines 258–267 only. Risk: trivial.
- **Source:** FIND-SPRINT-013-4 (TASK-501 code-reviewer)
- **Proposed change:**
  ```diff
  // stuckDetector.ts ~line 258
  - private transitionToStuck(approvalId: string, reason: StuckReason): boolean {
  -   const result = this.db.transaction(() => {
  -     const { changes } = (this.db.prepare(
  -       `UPDATE approvals SET status = 'stuck', stuck_reason = ?, stuck_detected_at = ?
  -        WHERE id = ? AND status = 'awaiting_review'`
  -     ) as () => { changes: number })();
  -     return { changes };
  -   })();
  -   return result.changes > 0;
  - }
  + private transitionToStuck(approvalId: string, reason: StuckReason): boolean {
  +   const { changes } = this.db
  +     .prepare(
  +       `UPDATE approvals SET status = 'stuck', stuck_reason = ?, stuck_detected_at = ?
  +        WHERE id = ? AND status = 'awaiting_review'`
  +     )
  +     .run(JSON.stringify(reason), Date.now(), approvalId);
  +   return changes > 0;
  + }
  ```
  *(Exact parameter binding order should be confirmed against the current implementation — the diff captures the structural change.)*

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `main/src/orchestrator/stuckDetector.ts:258-267` — the `db.transaction(() => { ... })()` wraps a single UPDATE (no atomicity benefit) and forces the ugly `(txn as () => { changes: number })()` double-cast at line 267; trivial 6-line edit in one isolated method.

### A2. Hoist four static `db.prepare()` calls to constructor-cached fields
- **Summary:** Four SQL statements are re-prepared on every scan tick or per approval row in `StuckDetector`; hoisting them to `readonly` constructor fields is cleaner and clearly cheaper.
- **Source-Sprint:** SPRINT-013
- **Rationale:** `db.prepare()` inside `scan()` and `classifyStaleApproval()` runs on every 60s tick (or every approval row for the stale-approval query). The SQL is entirely static. better-sqlite3 has internal caching so the cost is small, but hoisting to `private readonly` fields makes the intent explicit and removes any caching ambiguity.
- **Blast radius:** `main/src/orchestrator/stuckDetector.ts` — constructor + 4 call sites. Risk: low.
- **Source:** FIND-SPRINT-013-5 (TASK-501 code-reviewer)
- **Proposed change:**
  ```diff
  // In StuckDetector class body — add four private readonly fields:
  + private readonly stmtStaleApprovals: Database.Statement;
  + private readonly stmtSelfDeadlockCount: Database.Statement;
  + private readonly stmtCrossRunApprovals: Database.Statement;
  + private readonly stmtTransitionToStuck: Database.Statement;

  // In constructor, after db is set:
  + this.stmtStaleApprovals = this.db.prepare(`SELECT ... FROM approvals WHERE ...`);
  + this.stmtSelfDeadlockCount = this.db.prepare(`SELECT COUNT(*) ...`);
  + this.stmtCrossRunApprovals = this.db.prepare(`SELECT ... FROM approvals WHERE ...`);
  + this.stmtTransitionToStuck = this.db.prepare(`UPDATE approvals SET status = 'stuck' ...`);

  // Replace each inline db.prepare(...).run/get/all call with the corresponding stmt field.
  ```
  *(Read the existing four `db.prepare()` call bodies for the exact SQL strings.)*

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed: four static SQL `db.prepare()` calls at `stuckDetector.ts:153, 219, 229, 259` re-prepare every 60s tick / per-row; better-sqlite3's internal cache makes the perf gain marginal, but the hoist is a clean isolated refactor in one file and removes ambiguity for future readers.
- **Counterfactual:** would flip to DONT_IMPLEMENT if the file structure made constructor-field additions touch significantly more than the cited four call sites.

### A3. Fix logger.warn stack loss and `hasClientForSession` naming inconsistency in StuckDetector
- **Summary:** `StuckDetector.scan()` logs errors as `String(err)` (losing the stack trace), and the interface method `hasClientForSession` uses "session" while the schema uses `run_id`; both are one-line fixes.
- **Source-Sprint:** SPRINT-013
- **Rationale:** (a) `String(err)` loses the stack trace, which is important during v1 self-host where this error path may fire unexpectedly. (b) `hasClientForSession(runId: string)` uses "session" in name but "run" in parameter — callers must mentally translate. The DB schema consistently uses `run_id`, so renaming to `hasClientForRun` is the right direction.
- **Blast radius:** `main/src/orchestrator/stuckDetector.ts` — 2 lines. Risk: trivial.
- **Source:** FIND-SPRINT-013-6 (TASK-501 code-reviewer)
- **Proposed change:**
  ```diff
  // ~line 174 in scan():
  - this.logger.warn('[StuckDetector] scan failed', { error: String(err) });
  + this.logger.warn('[StuckDetector] scan failed', { error: err instanceof Error ? err.stack : String(err) });

  // In PermissionServerLike interface and StuckDetectorDeps:
  - hasClientForSession(runId: string): boolean;
  + hasClientForRun(runId: string): boolean;
  // Update all call sites (likely 1–2) accordingly.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Both confirmed in `main/src/orchestrator/stuckDetector.ts` — `String(err)` at line 174 drops the stack, and `hasClientForSession` is defined at line 47, called at line 205 with one test consumer at `stuckDetector.test.ts:166` — a 3-callsite rename with zero blast radius beyond the test.

### A4. Remove two unused TypeScript declarations causing baseline `TS6133` errors
- **Summary:** Two pre-existing unused-variable errors in `nodeFinder.ts` and `shellDetector.ts` surface on every `pnpm --filter frontend typecheck` run, burdening every future verifier with a "pre-existing baseline failure" note.
- **Source-Sprint:** SPRINT-013
- **Rationale:** `'pattern' is declared but its value is never read` (nodeFinder.ts:42) and `'findExecutable' is declared but its value is never read` (shellDetector.ts:105) are pre-existing since commit `beccb21` (TASK-003). Frontend typecheck includes the main package via project refs, so these surface on every frontend verification pass. Removing or prefixing with `_` silences the noise permanently.
- **Blast radius:** `main/src/utils/nodeFinder.ts:42`, `main/src/utils/shellDetector.ts:105`. Risk: trivial (removing unused declarations cannot break callers).
- **Source:** FIND-SPRINT-013-8 second occurrence (TASK-551 verifier, confirmed pre-existing)
- **Proposed change:**
  ```diff
  // main/src/utils/nodeFinder.ts:42 — remove or prefix the unused `pattern` variable:
  - const pattern = ...;
  + // delete the line, or: const _pattern = ...;  // unused, kept for doc purposes

  // main/src/utils/shellDetector.ts:105 — remove or prefix the unused `findExecutable`:
  - const findExecutable = ...;
  + // delete the line, or: const _findExecutable = ...;
  ```
  *(Read both files at those lines before editing to confirm the exact declaration form.)*

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed by live `pnpm --filter frontend typecheck` run — both `TS6133` errors fire (`'pattern' is declared but its value is never read` at `nodeFinder.ts:42` and `'findExecutable' is declared but its value is never read` at `shellDetector.ts:105`); both are trivially removable (the `pattern` local in nodeFinder is unused as the loop iterates `entries`, and `findExecutable` is a dead static method in ShellDetector with no callers).

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Wire the stuck-detection UI surface (3 disconnects make the whole epic invisible at runtime)
- **Summary:** The entire stuck-detection epic (TASK-501–504) produces zero observable UI behavior because three independent wiring steps were never completed; a follow-up task must connect them before any of the sprint's stuck UI is reachable.
- **Source-Sprint:** SPRINT-013
- **Source:** FIND-SPRINT-013-21 (sprint-code-reviewer)
- **Problem:** Three independent disconnects keep the stuck-detection UI unreachable:
  1. `frontend/src/components/ReviewQueueView.tsx:3` imports `PendingApprovalCard` from `./PendingApprovalCard` (the base Crystal-era card), not from `./ReviewQueue/PendingApprovalCard` (the new stuck-detection-aware variant). The new card's `StuckBadge`, "Why stuck?" button, and "Cancel and restart" button never appear.
  2. `useReviewQueueSlice` (`frontend/src/stores/reviewQueueSlice.ts`) is not imported by any non-test consumer. Its `subscribeToStuckEvents()` action is never called from `App.tsx` or any view, so the `runs:stuck` subscription is never established and `runStatusMap` stays empty.
  3. `setCancelAndRestartDeps()` (`main/src/orchestrator/trpc/routers/runs.ts:40`) is never called anywhere in `main/src/`. Even if the Cancel button were rendered, the mutation would throw `METHOD_NOT_SUPPORTED`.
- **Proposed direction:** Create a single wiring task that: (1) updates `ReviewQueueView.tsx:3` to import from `./ReviewQueue/PendingApprovalCard` and threads `runStatus` and `stuckReason` props from the slice's `runStatusMap`; (2) mounts `useReviewQueueSlice`'s `subscribeToStuckEvents()` action once at app top-level (inside `App.tsx` alongside `useStuckNotifications`, with cleanup); (3) calls `setCancelAndRestartDeps({ db, approvalRouter, runQueues, claudeManagerStop })` from `main/src/index.ts` during bootstrap after the orchestrator is constructed. The task should also add a `useRunStatus(runId)` selector to make it easy for `PendingApprovalCard` to read from the slice. Note: `clearPendingForRun` is still a stub until TASK-304 — document this as a known limitation and consider adding a WARN log when the stub runs (see B8).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** All three disconnects verified — `ReviewQueueView.tsx:3` imports `./PendingApprovalCard` (Crystal-era), `useReviewQueueSlice` has zero non-test consumers per grep, and `setCancelAndRestartDeps` is defined at `runs.ts:40` but never called from any `main/src/index.ts` or bootstrap; without this wiring task the entire SPRINT-013 stuck-detection UI epic ships invisible.

### B2. Fix `useStuckNotifications` StuckDetectedEvent schema divergence
- **Summary:** `useStuckNotifications.ts` redeclares a local `StuckDetectedEvent` interface with a different shape than the canonical one emitted by the orchestrator, making the notification body produce `"undefined"` strings when TASK-254 wires the real event bus.
- **Source-Sprint:** SPRINT-013
- **Source:** FIND-SPRINT-013-22 (sprint-code-reviewer), FIND-SPRINT-013-2 (TASK-503 verifier)
- **Problem:** `useStuckNotifications.ts:22–28` locally re-declares `StuckDetectedEvent` as `{ runId; sessionId; workflowName; reason: StuckReasonKind (plain string) }`. The orchestrator (`shared/types/stuckDetection.ts:42–51`, `stuckDetector.ts:270–276`) emits `{ runId; approvalId; reason: StuckReason (object `{kind:…}`); detectedAt }`. The fields `sessionId` and `workflowName` do not exist. `reason` is treated as a plain string in the `stuckReasonText()` switch at line 149, but the real payload sends an object. The existing test suite passes because tests construct events from the hook's own re-declared type and never see the real wire shape. `reviewQueueSlice.ts` already correctly imports the canonical type — the divergence is hook-only.
- **Proposed direction:** In `useStuckNotifications.ts`: (1) delete lines 22–28 (the locally-redeclared interface); (2) `import type { StuckDetectedEvent, StuckReason } from '../../../shared/types/stuckDetection'`; (3) change `stuckReasonText(kind: StuckReasonKind)` to `stuckReasonText(reason: StuckReason)` and switch on `reason.kind`; (4) replace `sessionId` as the suppression key with `runId` (which exists in the canonical shape); (5) remove `workflowName` from the notification body or fetch it via a store lookup by `runId`. Update the 6 unit tests to construct events using the canonical `StuckDetectedEvent` type. This also coordinates with the TASK-254 cleanup in B3 (the `StuckEventsClient` cast through `unknown` should be removed in the same pass once TASK-254 lands).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `useStuckNotifications.ts:22-28` — the locally-declared `StuckDetectedEvent` has `sessionId` + `workflowName` fields that do not exist in the canonical shape at `shared/types/stuckDetection.ts`, and `stuckReasonText(kind: StuckReasonKind)` at line 42 takes a plain string while the real wire payload sends `reason: { kind: ... }`; will produce `"undefined"` in toast text the moment TASK-254 wires the real bus.

### B3. Consolidate duplicate `StuckEventsClient` shim after TASK-254 lands
- **Summary:** Two files (`useStuckNotifications.ts` and `reviewQueueSlice.ts`) each declare an identical `StuckEventsClient` forward-looking interface and the same `as unknown as StuckEventsClient` cast; consolidate to one shim so the TASK-254 cleanup is a single-file edit.
- **Source-Sprint:** SPRINT-013
- **Source:** FIND-SPRINT-013-24 (sprint-code-reviewer), FIND-SPRINT-013-2 (TASK-503 verifier), FIND-SPRINT-013-12 (TASK-502 verifier)
- **Problem:** TASK-502 and TASK-503 each declared the same 5-line interface independently. When TASK-254 lands the typed `onStuckDetected` subscription, two separate files need the identical edit. If one file adds a `runId` filter and the other does not, the two consumers silently desync. This is a near-miss: the per-task code-reviewer sees only one file, so neither flagged the duplication.
- **Proposed direction:** Create `frontend/src/utils/stuckEventsShim.ts` exporting a typed `getStuckEventsClient()` helper that encapsulates the `trpc.cyboflow.events as unknown as StuckEventsClient` cast and the interface declaration. Both `useStuckNotifications.ts` and `reviewQueueSlice.ts` import from the shim instead. When TASK-254 lands, the typed subscription replaces the shim in exactly one file. This task should be scheduled to land **before** TASK-254 to reduce that cleanup's blast radius.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The duplication is real (identical 5-line `StuckEventsClient` interface + cast at `useStuckNotifications.ts:60-70` and `reviewQueueSlice.ts:46-56`), but creating a new shim file solves a problem TASK-254 will erase entirely in one sweep — and the consolidation work is itself a 2-file edit that the TASK-254 cleanup also has to touch, so the net cost is roughly equal and the new file becomes garbage on day one.
- **Counterfactual:** would flip to IMPLEMENT if TASK-254 were known to be deferred more than 2 sprints, making the desync-risk window meaningfully long.

### B4. Persist `reason` and `detectedAt` in `reviewQueueSlice` and surface `detectedAt` in `StuckBadge` tooltip
- **Summary:** `applyStuckEvent` silently discards the `reason` and `detectedAt` parameters it receives, so `StuckBadge` can never render the full tooltip the plan specified ("reason · relative time").
- **Source-Sprint:** SPRINT-013
- **Source:** FIND-SPRINT-013-11 (TASK-502 verifier), FIND-SPRINT-013-10 (TASK-502 verifier)
- **Problem:** `reviewQueueSlice.ts:89` calls `applyStuckEvent(runId, reason, detectedAt)` but the reducer only writes `'stuck'` to `runStatusMap` — the `reason` and `detectedAt` arguments are received but discarded. `StuckBadge.tsx:41–50` renders only the `stuck_reason` string via the native `title` attribute; it was planned to also show a relative time from `stuck_detected_at`. Neither enrichment is possible until the slice stores the data.
- **Proposed direction:** Add `runReasonMap: Record<string, StuckReason>` and `runDetectedAtMap: Record<string, number>` fields to the slice state (parallel to `runStatusMap`). Update `applyStuckEvent` to write all three maps. Add a `useRunStuckDetails(runId)` selector that returns `{ reason, detectedAt }`. Add an optional `detectedAt?: number` prop to `StuckBadge`; format it with `formatAge` (or equivalent) and append to the `title` string as `"<reason-label> · <relativeTime>"`. Update `PendingApprovalCard` to pass `detectedAt` from the new selector. Also consider dropping the unused parameters from `applyStuckEvent`'s current signature if this task is deferred (to make the discard explicit).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `reviewQueueSlice.ts:131` — `applyStuckEvent: ({ runId }) => { ... }` destructures only `runId` and discards `reason`/`detectedAt`; `StuckBadge.tsx:18-25` has no `detectedAt` prop and the title attribute only renders `reason`; plan-prescribed "(relative time)" enrichment is unreachable until the slice stores the data.

### B5. Fix mouse-click approve/reject not dismissing the onboarding card
- **Summary:** Clicking the Approve or Reject button on a `PendingApprovalCard` does not call `dismissOnboarding()`, so the onboarding card stays visible for mouse-only users until they either click "Got it" or use keyboard navigation.
- **Source-Sprint:** SPRINT-013
- **Source:** FIND-SPRINT-013-15 (TASK-551 verifier), FIND-SPRINT-013-14 (TASK-551 code-reviewer)
- **Problem:** AC3 of TASK-551 states the card should dismiss when "clicking Got it button OR approving/rejecting any queue item." The current implementation only dismisses on (a) "Got it" button click and (b) keyboard y/n keypress via `ReviewQueueView`'s keydown listener. Mouse clicks on the Approve/Reject buttons in `PendingApprovalCard.tsx:120,127,150,156` fire the mutation but do not call `dismissOnboarding()`. For mouse-only users the card is not permanently blocked (the preference is written on first keyboard interaction) but it does not dismiss until they use the keyboard.
- **Proposed direction:** Add an optional `onDecide?: () => void` prop to `PendingApprovalCard` and call it from the approve and reject mutation `onSuccess` callbacks. Wire it from `ReviewQueueView` to call `dismissOnboarding()` then `setOnboardingDismissed(true)`. This also resolves the duplicated key-listener guard noted in FIND-SPRINT-013-14: once `PendingApprovalCard` has `onDecide`, the separate `window.keydown` listener in `ReviewQueueView` can be replaced by passing an `onDecide` callback into `useReviewQueueKeyboard` (invoked from the y/n switch arms), eliminating the duplicate guard logic.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `PendingApprovalCard.tsx:148-158` (single) and `:118-128` (group) — both `handleApprove`/`handleReject` fire the mutation but never call `dismissOnboarding()`; only the `ReviewQueueView.tsx:58-84` keydown listener dismisses, leaving mouse-only users with a stale card. The same task also resolves the duplicate keydown-guard logic flagged in B's neighbouring concerns.

### B6. Consolidate dual MCP health polling loops and reconcile the status enum split
- **Summary:** Two independent 5-second polling loops run against the same `cyboflow:mcp-health` IPC channel (one in the new `mcpHealthStore`, one in the pre-existing `useMcpHealth` hook), and two different status enums map the same four wire states to different UI vocabulary; consolidate before TASK-535 lands.
- **Source-Sprint:** SPRINT-013
- **Source:** FIND-SPRINT-013-19 (TASK-553 verifier), FIND-SPRINT-013-25 (sprint-code-reviewer)
- **Problem:** `frontend/src/stores/mcpHealthStore.ts` (TASK-553) polls `cyboflow:mcp-health` every 5s and uses a three-value `McpHealthStatus` enum (`healthy | starting | error`). `frontend/src/hooks/useMcpHealth.ts` (pre-existing) polls the same channel on the same interval and uses a four-value `McpServerHealth.status` enum (`running | starting | failed | stopped`). `Sidebar.tsx` renders a dot driven by the hook; the new `StatusBar`/`McpHealthIndicator` renders a dot driven by the store. At runtime two 5s timers fire against the same IPC handler and show two MCP dots. If this is not consolidated before TASK-535 lands the push subscription, both consumers will need to be migrated.
- **Proposed direction:** Schedule as part of the TASK-535 epic or as a prerequisite task. Define a single canonical UI-side enum in `shared/types/mcpHealth.ts` (e.g., `McpHealthUiStatus: 'healthy' | 'starting' | 'error'`). Make `mcpHealthStore` the single owner of the subscription/polling; refactor `useMcpHealth` to read from `mcpHealthStore` rather than polling independently. Make a product-side decision on which MCP dot location wins (sidebar vs status bar); either remove the other or keep both UIs fed from the single store. Update `Sidebar.tsx` accordingly.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed dual implementations: `mcpHealthStore.ts` and `useMcpHealth.ts` both `setInterval(tick, 5000)` against `cyboflow:mcp-health`, with two divergent enums (`healthy|starting|error` vs `running|starting|failed|stopped`) and two UI dots in `Sidebar.tsx` + `StatusBar`; consolidating before TASK-535 lands the push subscription avoids migrating two consumers.

### B7. Add regression test for `cancelAndRestart` `changes === 0` race branch
- **Summary:** The `changes === 0` guard inside `cancelAndRestartHandler`'s transaction catches a concurrent terminal-state race, but no test exercises it — the guard should be locked in with a regression test.
- **Source-Sprint:** SPRINT-013
- **Source:** FIND-SPRINT-013-17 (TASK-502 verifier)
- **Problem:** `main/src/orchestrator/cancelAndRestartHandler.ts` contains a `changes === 0` guard inside `db.transaction()` that throws when a run was concurrently moved to a terminal state between the row-fetch guard and the UPDATE. The round-2 transaction wrap (commit `20e1e3a`) introduced this guard, but the 13 existing tests in `cancelAndRestart.test.ts` cover only: the happy path, the noOp-on-terminal-status path (row-fetch guard fires), and the `claudeManagerStop` rejection branches. The race-branch guard has no test.
- **Proposed direction:** Add one test case in `main/src/orchestrator/__tests__/cancelAndRestart.test.ts` that stubs the `db.prepare(...).run()` response to return `{ changes: 0 }` for the UPDATE statement (after the row-fetch returns a non-terminal row). Assert that the handler throws with the expected message and that the new-run INSERT is NOT called (i.e., the transaction rolls back). This directly locks in the invariant added in round 2 and prevents silent regression if a future edit drops the guard.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** high
- **Reasoning:** The test already exists — `cancelAndRestart.test.ts:356` `it('throws when UPDATE finds changes=0 (concurrent terminal transition race)', ...)` directly exercises this exact path via a `racingDb` wrapper that pre-cancels the run before the guarded UPDATE; FIND-SPRINT-013-17 was written against round-2 state that has since been resolved.
- **Counterfactual:** would flip to IMPLEMENT only if the existing test were found to skip the INSERT-not-fired assertion (it does assert by inspecting DB state).

### B8. Track `clearPendingForRun` stub dependency and add a WARN log
- **Summary:** `cancelAndRestartHandler` calls `approvalRouter.clearPendingForRun(runId)` which is a documented no-op until TASK-304 lands, meaning cancel-and-restart leaves Claude waiting on the socket; the handler should log a warning when the stub runs.
- **Source-Sprint:** SPRINT-013
- **Source:** FIND-SPRINT-013-26 (sprint-code-reviewer)
- **Problem:** `cancelAndRestartHandler.ts:122` calls `approvalRouter.clearPendingForRun(runId)`, which is documented as `// Silent no-op until then` at `approvalRouter.ts:328–337`. Once cancel-and-restart is wired per B1 and the Cancel button becomes reachable, pressing it will stop the Claude process but not send deny-replies on the socket — Claude waits for a response that never arrives. The PTY exit behavior then depends on Claude SDK retry/timeout logic. This is not blocking for v1 (the button is currently invisible per B1, and the test suite uses a fake `approvalRouter`), but once B1 wires the UI the dependency becomes live.
- **Proposed direction:** In `cancelAndRestartHandler.ts`, add a one-line `logger?.warn('[cancelAndRestart] clearPendingForRun is a no-op until TASK-304 lands — deny-replies will not be sent')` immediately after the `clearPendingForRun` call (or detect via an `_isStub` marker on the injected dependency if one is added). Add a comment in the plan for B1 noting that TASK-304 must land before cancel-and-restart can be considered fully correct, and gate the Cancel button's availability accordingly (or document the known limitation in the UI tooltip). Track TASK-304 as a hard dependency on the B1 wiring task.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed: `cancelAndRestartHandler.ts:122` calls `approvalRouter.clearPendingForRun(runId)` and `approvalRouter.ts:328` is a documented no-op (`// Silent no-op until then`); once B1 wires the Cancel button, pressing it leaves Claude waiting on the socket — a one-line WARN log at the call site is proportional, and tracking TASK-304 as a B1 dependency prevents shipping an incorrect feature.
- **Counterfactual:** would flip to DONT_IMPLEMENT if the WARN log were paired with a new dependency-injection marker or new file rather than the proposed one-liner.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the canonical shared-type label-map pattern in CODE-PATTERNS.md
- **Summary:** Two files shipped identical stuck-reason label maps with divergent wording because no canonical pattern exists for shared-type label maps; codify "label maps for `shared/types/` discriminants live with the type, not in each consumer."
- **Source-Sprint:** SPRINT-013
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after "shared/types/cliPanels.ts — CLI-specific panel types"
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
   - `shared/types/cliPanels.ts` — CLI-specific panel types
  +
  +**Label maps for shared-type discriminants** belong next to the type (same file
  +or a companion `*Labels.ts` in `shared/types/`), keyed by `Record<Union['kind'], string>`
  +so adding a new variant breaks the map at compile time. Never duplicate the map in a
  +component and a hook — see `frontend/src/components/ReviewQueue/StuckInspectorModal.tsx`
  +and `frontend/src/hooks/useStuckNotifications.ts` (SPRINT-013 divergence) for the
  +anti-pattern.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed divergence: `StuckInspectorModal.tsx:27-32` declares verbose labels while `useStuckNotifications.ts:42-49` declares short labels for the same four variants with different wording — and adding a fifth StuckReason variant would silently miss one site. The proposed rule extends the existing "Shared types as the cross-package contract" section and codifies a recurring trap that crossed two tasks in one sprint.
- **Counterfactual:** would flip to DONT_IMPLEMENT if a similar rule already lived in CODE-PATTERNS.md (none found).

### C2. Document the single-keyboard-listener rule in CODE-PATTERNS.md
- **Summary:** `ReviewQueueView` added a second `window.keydown` listener replicating the modifier-key + input-focus guards already in `useReviewQueueKeyboard`; codify "extend the existing hook, do not add a parallel listener."
- **Source-Sprint:** SPRINT-013
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** create-section "### Single keyboard-listener rule" under "Frontend Test Conventions"
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
   Canonical example: `frontend/src/stores/__tests__/reviewQueueStore.test.ts:22`.
  +
  +### Single keyboard-listener rule
  +
  +When a hook already registers a `window`/`document` keydown listener with modifier-key
  +and input-focus guards (e.g. `useReviewQueueKeyboard`), do NOT add a second listener in
  +a consumer component for an extra key handler. Extend the hook with an optional callback
  +parameter and invoke it from the existing switch arm — keeps guard logic single-sourced.
  +Anti-pattern: `frontend/src/components/ReviewQueueView.tsx` (SPRINT-013, pending B5 refactor).
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** low
- **Reasoning:** The anti-pattern is real and confirmed at `ReviewQueueView.tsx:58-84` (duplicates the modifier/input-focus guards already in `useReviewQueueKeyboard.ts:65-74`), but B5 will physically remove this pattern from the codebase, leaving the new CODE-PATTERNS.md entry pointing at "pending refactor" code that no longer exists post-merge — and there is only one current consumer of `useReviewQueueKeyboard`, so frequency of future agents repeating this trap is unverified. Rules cost attention budget on every future agent prompt; a one-off keyboard collision does not yet meet the recurring-trap bar.
- **Counterfactual:** would flip to IMPLEMENT if a second window-keydown hook were planned (e.g. a global command palette) where the trap could recur.

### C3. Document the IPC-preference-backed visibility pattern in CODE-PATTERNS.md
- **Summary:** Components gated on an async IPC preference read can flash for one frame on returning-user reload; codify the `loading` / tri-state pattern that suppresses the flash.
- **Source-Sprint:** SPRINT-013
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** create-section "### IPC preference-backed component visibility" under "Recurring Patterns"
- **Status:** ready
- **source_item:** C3
- **Diff:**
  ```diff
   - **Audit tool:** `grep -rn '@cyboflow-hidden' main/src frontend/src` lists all
     inactive surfaces (both categories).
  +
  +### IPC preference-backed component visibility
  +
  +When a component's visibility depends on an async IPC preference (`preferences:get`),
  +track the read result as `boolean | null` in the parent and render nothing while it is
  +`null`. Do NOT initialise the child's own state to "hidden by default" and rely on an
  +async effect to flip it — that produces the correct steady state but a one-frame flash
  +on every page reload for returning users. Consumers: `OnboardingCard`, `Welcome`,
  +`DiscordPopup`, `AnalyticsConsentDialog` (audit via `grep -rln 'preferences:get' frontend/src`).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed multi-consumer pattern: `App.tsx:110,195-197`, `OnboardingCard.tsx:58`, `ReviewQueueView.tsx:44`, `Welcome.tsx:21`, `DiscordPopup.tsx:25` all do async `preferences:get` reads, and the `ReviewQueueView` round-2 fix actually regressed onboarding rendering to a one-frame flash for returning users (per FIND-SPRINT-013-16). The pattern recurs across at least four surfaces, so codifying the `boolean | null` tri-state default has clear future leverage.

---

## Reconciled Findings (informational)

The following findings had `status: open` in the findings file but were cross-checked against done reports. No discrepancies found — none of the open findings are claimed as resolved by any done report's `**Findings resolved:**` line. All open findings above were triaged as written.

One findings-file anomaly noted for the record: the ID `FIND-SPRINT-013-8` appears twice in `SPRINT-013-findings.md` — once as a `status: resolved` scope deviation (TASK-504, `shared/types/stuckInspection.ts`) and once as a `status: open` bug (TS6133 unused variables, TASK-551 verifier). The second occurrence was triaged as open (→ A4). The sprint-closer should deduplicate or renumber on next findings reconciliation.

---

## Suppressed — SoloFlow Defects

No C-items were suppressed during triage. All three C-items above describe project-specific codebase conventions (domain label maps, React hook patterns, IPC preference-backed component patterns) that would remain true if SoloFlow were not in use.
