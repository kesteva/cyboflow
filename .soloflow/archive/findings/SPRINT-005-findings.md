---
sprint: SPRINT-005
pending_count: 17
last_updated: "2026-05-13T22:18:26.282Z"
---
# Findings Queue

## FIND-SPRINT-005-1
- **source:** TASK-151 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/database/migrations/
- **description:** With the new file-based migration runner from TASK-151, every app boot now emits ~18 `console.warn` lines for legacy non-prefixed `.sql` files (`add_archived_field.sql`, `add_build_commands.sql`, `add_claude_session_id.sql`, etc.) that live in `main/src/database/migrations/` as historical documentation but are never executed (they predate the inline-migration era and have no corresponding hook). The warns are spec'd by the plan (AC #2 says "files without a matching numeric prefix are skipped (logged at WARN)") and the runner behaves correctly, but the resulting log noise is permanent and risks masking legitimate warnings about typos in real future cyboflow migrations.
- **suggested_action:** Either (a) move the 18 legacy non-prefixed `.sql` files into `main/src/database/migrations/legacy/` (a subdir the runner does not scan), or (b) demote the per-file warn to a single aggregated `console.debug` ("Skipped N non-numeric migration files: …") at the end of the directory scan. Option (a) is cleaner and matches the `@cyboflow-hidden` convention's intent (preserve but quarantine). Verify `copy:assets` still ships these files (or stop shipping them) before merging the move.
- **resolved_by:** 

## FIND-SPRINT-005-2
- **source:** TASK-155 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:392-481
- **description:** The "existing-install path" test (AC-2) simulates a pre-TASK-151 upgrade by first running `initialize()` against a brand-new DB (which both executes the inline migrations AND writes the `file_migration_applied:003/004/005` backfill markers via `runFileBasedMigrations`), THEN deleting the 006 marker + dropping the 5 Cyboflow tables, THEN running `initialize()` a second time. By the time the second `initialize()` runs, the `file_migration_applied:003/004/005` markers already exist on disk from the first call, so the test's assertions (a) that the markers are present only verify they persist across reboots — they do NOT verify the auto-backfill behaviour the AC describes (i.e. a DB that has the legacy inline-migration markers like `unified_panel_settings_migrated` but zero `file_migration_applied:*` entries gets its 003/004/005 backfill flags written by `runFileBasedMigrations` on first encounter). The test passes and the end-state is correct, but the failure-mode coverage diverges from the spec.
- **suggested_action:** Refactor the existing-install test to (a) manually pre-seed `user_preferences` with only the legacy markers (`auto_commit_migrated`, `claude_panels_migrated`, `diff_panels_migrated`, `unified_panel_settings_migrated` = 'true') AND pre-create the inline-migration-era tables (tool_panels, claude_panel_state, etc.) on a raw SQLite DB without calling `initialize()`, (b) then for the first time call `DatabaseService.initialize()` and assert that the `file_migration_applied:003/004/005` markers appear AND no errors occur. This isolates the auto-backfill path from the normal first-init path that incidentally also writes those markers.
- **resolved_by:** 

## FIND-SPRINT-005-3
- **source:** TASK-155 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:25
- **description:** Two unused imports added: `writeFileSync` and `mkdirSync` from `node:fs`. ESLint reports them as `no-unused-vars` warnings. Doesn't fail lint (project has 230 pre-existing warnings, 0 errors) but adds noise.
- **suggested_action:** Remove `writeFileSync, mkdirSync` from the import list on line 25 of `main/src/database/__tests__/cyboflowSchema.test.ts`.
- **resolved_by:** 

## FIND-SPRINT-005-4
- **source:** TASK-154 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/cyboflow/stateMachine.ts:39
- **description:** `isTransitionAllowed` contains a no-op type assertion: `(ALLOWED_TRANSITIONS[from] as readonly WorkflowRunStatus[]).includes(to)`. The indexed access `ALLOWED_TRANSITIONS[from]` already has type `readonly WorkflowRunStatus[]` (the value type of `Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>`), and `Array.prototype.includes` accepts a `WorkflowRunStatus` argument without complaint under the project's TS target (ES2022, strict). The cast neither widens nor narrows the type. ESLint does not enable `@typescript-eslint/no-unnecessary-type-assertion`, so the rule does not fire; this is purely visual noise. Removing it does not affect behaviour or type safety.
- **suggested_action:** Replace `return (ALLOWED_TRANSITIONS[from] as readonly WorkflowRunStatus[]).includes(to);` with `return ALLOWED_TRANSITIONS[from].includes(to);` and re-run `pnpm typecheck` to confirm.
- **resolved_by:** 

## FIND-SPRINT-005-5
- **source:** TASK-201 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:279-299 and main/src/services/streamParser/typedEventNarrowing.ts:35-53
- **description:** `parseClaudeStreamEvent` (in schemas.ts, from IDEA-003's earlier task family) and `TypedEventNarrowing.narrow` (added by TASK-201) implement the same safeParse-and-fallback-to-__unknown__ logic. The legacy function logs via `console.warn` directly; the new class logs via an injected `IDebugLogger`. Both call sites are reachable: schemas.test.ts exercises `parseClaudeStreamEvent`; the pipeline orchestrator wires `TypedEventNarrowing` through `streamParser.ts`. This is not a bug — the executor followed the plan, which prescribed the new class — but it leaves two parallel implementations of the same contract, with two different log channels, and risks divergence in future schema patches.
- **suggested_action:** After TASK-202/203/205 wire the pipeline into actual callers, evaluate whether `parseClaudeStreamEvent` can be deleted (no production code paths use it; only schemas.test.ts). If it must stay, refactor it to delegate to `TypedEventNarrowing.narrow(parsed)` with a console-shaped IDebugLogger, so there is exactly one implementation of the safeParse contract.
- **resolved_by:** 

## FIND-SPRINT-005-6
- **source:** TASK-204 (verifier)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/components/CreateSessionDialog.tsx:91,100; frontend/src/components/CreateSessionButton.tsx:52; frontend/src/components/DraggableProjectTreeView.tsx:1132; frontend/src/stores/sessionPreferencesStore.ts:13,29; frontend/src/components/dialog/ClaudeCodeConfig.tsx:11,298; main/src/events.ts:644; main/src/services/configManager.ts:43,171
- **description:** TASK-204 promoted any session spawn with `permissionMode === 'ignore'` to a hard error inside `claudeCodeManager.buildCommandArgs` (the plan's intentional "loud failure" trap). However, every existing user-initiated session-creation callsite still hardcodes `permissionMode: 'ignore'` as the form default, including the `sessionPreferencesStore` initial state, two callsites in `CreateSessionDialog`, `CreateSessionButton`, `DraggableProjectTreeView`, the `events.ts` quick-create path, and the `claudeConfig.permissionMode` defaults in `configManager.ts` (lines 43 and 171, distinct from the now-fixed top-level `defaultPermissionMode`). Result: when a user creates a session through the standard UI flow without explicitly toggling the permission mode, the spawn will now throw `[ClaudeCodeManager] Cyboflow runs require approve mode; --dangerously-skip-permissions is not allowed.` This is consistent with the plan's "Hardest Decision" (preferred a loud throw over silent coercion to surface stale callsites) and the plan's "Lowest Confidence Area" (anticipated downstream callsites passing 'ignore'). Not a regression in TASK-204's narrow security contract — but production sessions WILL fail until a follow-up callsite sweep flips these defaults to 'approve'.
- **suggested_action:** Open a follow-up task (or attach to the crystal-cuts-and-rebrand epic, which already owns the rebrand sweep) to flip every UI-facing `permissionMode: 'ignore'` default to `'approve'`. Specific edits: (1) `frontend/src/stores/sessionPreferencesStore.ts:29` — change default `permissionMode: 'ignore'` → `'approve'`. (2) `frontend/src/components/CreateSessionDialog.tsx:91,100` and `:241,278` — flip both `initialClaudeConfig?.permissionMode || 'ignore'` and the bare `permissionMode: 'ignore'` literal to `'approve'`. (3) `frontend/src/components/CreateSessionButton.tsx:52` and `DraggableProjectTreeView.tsx:1132` — flip `permissionMode: 'ignore', // Use default permission mode` to `'approve'`. (4) `main/src/events.ts:644` — change `permissionMode: claudeConfig.permissionMode || 'ignore'` to `|| 'approve'`. (5) `main/src/services/configManager.ts:43,171` — flip the two `sessionCreationPreferences.claudeConfig.permissionMode: 'ignore'` defaults to `'approve'`. (6) `frontend/src/components/dialog/ClaudeCodeConfig.tsx` toggle UI may still expose the `'ignore'` choice; consider hiding it behind a debug-only escape hatch per the plan's rejected alternative ("CYBOFLOW_ALLOW_BYPASS=1"). Until this sweep lands, end-to-end session creation through the UI is broken.
- **resolved_by:** 

## FIND-SPRINT-005-7
- **source:** TASK-203 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/index.ts
- **description:** The streamParser barrel (`main/src/services/streamParser/index.ts`) is documented in its own header as the "Single import point for downstream consumers (TASK-202, TASK-203, TASK-205). Import individual classes from this file, not from their implementation modules." It re-exports `LineBufferer`, `JSONParser`, `TypedEventNarrowing`, `EventRouter`, `ClaudeStreamParser` and their logger types — but TASK-203's new `RawEventsSink` class and `IRawEventsSinkLogger` interface are NOT exported through the barrel. Downstream callers in upcoming tasks (TASK-205+) will either import from the implementation module directly (violating the documented convention) or hit a "no exported member" error when following the convention. This is out-of-diff for TASK-203 (the barrel is in `files_readonly`), so it stays a queued finding rather than blocking the review.
- **suggested_action:** Add `export { RawEventsSink } from './rawEventsSink';` and `export type { IRawEventsSinkLogger } from './rawEventsSink';` to `main/src/services/streamParser/index.ts` alongside the existing exports. One-line follow-up; can be folded into the next streamParser task or a tiny TASK-204-prep cleanup.
- **resolved_by:** 

## FIND-SPRINT-005-9
- **source:** TASK-205 (verifier)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/components/panels/ai/RichOutputView.tsx:230 ; frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts:10-11 ; main/src/ipc/session.ts:869-918
- **description:** TASK-205 reduced `ClaudeMessageTransformer` to an identity passthrough (`return rawMessages as UnifiedMessage[]`) but did NOT execute plan step 3 — wiring `MessageProjection` into the data path that feeds the renderer. The renderer fetches messages via `panels:get-json-messages` (main/src/ipc/session.ts:869), which returns unwrapped raw stream-json objects of shape `{type:'system'|'assistant'|'user'|'result', subtype?, message?, ...}`. `RichOutputView.tsx:230` calls `messageTransformer.transform(allMessages)` and sets the result on `messages` state. Downstream rendering accesses `message.segments` (`.some()`, `.forEach()`, `.find()`, `.filter()` — see lines 236, 407, 440-450, 470, 566, 602, 681, 700, 723, 728, 767). On raw stream-json, `message.segments` is `undefined`, so `.some(...)` throws `TypeError: Cannot read properties of undefined (reading 'some')` and the Claude panel will throw at runtime as soon as a user opens it. This is a high-severity functional regression that the parity unit test does not catch (the test exercises `MessageProjection.project()` in isolation; nothing exercises the renderer data path end-to-end). The plan body's AC#5 says renderer correctness "covered by integration smoke once the orchestrator wiring lands", but step 3 of the implementation steps explicitly assigns the wiring to THIS task — these two are contradictory in the plan, and the executor followed AC#5's deferral.
- **suggested_action:** Either (a) modify the `panels:get-json-messages` IPC handler in main/src/ipc/session.ts to instantiate a `MessageProjection` per panel, feed each raw event through `narrow()`+`project()`, and return the projected `UnifiedMessage[]` (smallest delta consistent with plan step 3's "do not introduce a new IPC surface" directive), or (b) wire `MessageProjection` into the orchestrator's session-output ingestion path so messages are stored as projected UnifiedMessage in the DB. Option (a) is the simplest path back to a working Claude panel; option (b) is the architecturally cleaner one. Until one of these lands, the Claude panel will be broken for any session created/loaded after this task merges.
- **resolved_by:** 

## FIND-SPRINT-005-8
- **type:** scope_deviation
- **source:** TASK-205 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/panels/ai/transformers/MessageTransformer.ts
- **description:** required to meet AC: MessageTransformer.ts must re-export UnifiedMessage types from shared/types/unifiedMessage.ts so CodexMessageTransformer and other consumers get the types from the single shared source of truth.
- **resolved_by:** verifier — plan-prescribed: TASK-205 plan step 1 explicitly says "Update `frontend/src/components/panels/ai/transformers/MessageTransformer.ts` to re-export from `shared/types/unifiedMessage.ts` for backward compatibility with other renderer files (CodexMessageTransformer, RichOutputView)."

## FIND-SPRINT-005-10
- **source:** TASK-205 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/__tests__/messageProjection.test.ts:515-528
- **description:** Test 18 ("calls logger.warn on unexpected errors without throwing") only asserts `expect(() => ...).not.toThrow()`. The local `warnings` array captures emitted warn messages, but the test never asserts `expect(warnings.length).toBeGreaterThan(0)` nor checks the warning payload. As written, a future regression where the projection silently swallows errors WITHOUT calling logger.warn would still pass this test. The contract claim in the JSDoc (lines 99-102 of messageProjection.ts: "calls logger.warn on unexpected errors") is therefore not enforced by the test suite.
- **suggested_action:** Add `expect(warnings.length).toBeGreaterThan(0)` and `expect(warnings[0]).toContain('MessageProjection')` after the `.not.toThrow()` assertion in test 18. One-line follow-up; can be folded into the wiring task that consumes FIND-SPRINT-005-9.
- **resolved_by:** 

## FIND-SPRINT-005-11
- **source:** SPRINT-005 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/cyboflow/transitions.ts:46-55,98-109
- **description:** TASK-153 and TASK-154 are not composed — transitions.ts mutates workflow_runs.status via raw SQL (UPDATE workflow_runs SET status=awaiting_review WHERE ... AND status=running) without calling assertTransitionAllowed() from stateMachine.ts. Each task individually passes its plan/tests because (a) the SQL guard AND status=running enforces the source state, and (b) the target state literal is hardcoded. However, the two TASK-153 helpers will silently accept any code that ports the same pattern with a wrong target literal (e.g. completed → queued), because no caller funnels through the in-process ALLOWED_TRANSITIONS table. The stateMachine helpers exist but have ZERO production callers (`grep assertTransitionAllowed` returns nothing outside the test file).
- **suggested_action:** In transitions.ts, before each tx.immediate() call, invoke assertTransitionAllowed(running, awaiting_review, params.runId) and the inverse in transitionFromAwaitingReview. This gives a second line of defense (assertion error if a future maintainer edits the SQL literal incorrectly) and makes the stateMachine module the single source of truth referenced by every transition path. Add a unit test verifying the assertion fires before the SQL UPDATE so the in-process guard is exercised even when the DB guard happens to also reject.
- **resolved_by:** 








Suspected tasks: TASK-153, TASK-154

## FIND-SPRINT-005-12
- **source:** SPRINT-005 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/database/database.ts (DatabaseService constructor); main/src/database/migrations/006_cyboflow_schema.sql:30,40,50,65
- **description:** Migration 006 declares 4 FOREIGN KEY ... ON DELETE CASCADE clauses (workflow_runs.workflow_id → workflows, raw_events.run_id → workflow_runs, messages.run_id → workflow_runs, approvals.run_id → workflow_runs). SQLite, however, does NOT enforce foreign keys by default — `PRAGMA foreign_keys = ON;` must be executed on every connection. A grep of main/src/database/database.ts for `foreign_keys` returns zero hits (only unrelated PRAGMA table_info calls exist). Consequence: (a) all four CASCADE clauses are inert — orphan raw_events/messages/approvals will silently accumulate after a workflow_run delete, and (b) inserts referencing a non-existent workflow_id/run_id will silently succeed. This is a sprint-introduced data-integrity bug: TASK-152 wrote FK declarations under the assumption that Crystals DB layer enforced them; it does not, and no task in this sprint added the PRAGMA.
- **suggested_action:** In DatabaseService constructor (or top of initialize()), add `this.db.pragma(foreign_keys = ON)` BEFORE running any migrations. Add a regression test in cyboflowSchema.test.ts that (1) inserts a workflow_run, (2) inserts a raw_event with run_id matching it, (3) deletes the workflow_run, (4) asserts the raw_event was cascaded away. Also add a negative test asserting that inserting a raw_event with a non-existent run_id throws SQLITE_CONSTRAINT_FOREIGNKEY. Verify the PRAGMA does not break any Crystal-era inline migrations by running the full test suite — Crystals tables may have soft FK declarations that suddenly start failing under enforcement.
- **resolved_by:** 







Suspected tasks: TASK-152, TASK-151

## FIND-SPRINT-005-13
- **source:** SPRINT-005 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/streamParser/{jsonParser.ts:13,typedEventNarrowing.ts:13,streamParser.ts:18,completionDetector.ts:25,rawEventsSink.ts:30,messageProjection.ts:26}
- **description:** The streamParser/ folder added by TASK-201/202/203/205 introduces SIX distinct ad-hoc logger interfaces in 6 files, each defining a slightly different subset of methods:
- **suggested_action:** Add a single `ILogger` interface to `main/src/services/streamParser/types.ts` (or reuse the existing project Logger) with the union of methods (`warn(msg); info?(msg); verbose?(msg)`). Replace the six per-file interfaces with `type IFoo = Pick<ILogger, warn>` or just consume ILogger directly. Doing this in one follow-up cleanup task is cheaper than per-call adapters at each pipeline wiring point.
- **resolved_by:** 






  - IWarnLogger        : { warn(msg) }
  - IDebugLogger       : { verbose?(msg) }
  - IStreamParserLogger: { warn(msg); verbose?(msg) }
  - ICompletionDetectorLogger : { info(msg); warn(msg) }
  - IRawEventsSinkLogger      : { warn(msg) }
  - IMessageProjectionLogger  : { warn(msg) }

None references a shared `ILogger` contract, and at least three (IWarnLogger, IRawEventsSinkLogger, IMessageProjectionLogger) are structurally identical (`{ warn(msg): void }`). Per-task code reviewers only saw their own file. Cross-task effect: every downstream wiring task (TASK-206+) must remember to construct or adapt a different interface per pipeline stage; refactors that broaden a logger contract require touching N interfaces; lint cannot detect when two interfaces drift in ways that no longer satisfy the same concrete Logger.

Suspected tasks: TASK-201, TASK-202, TASK-203, TASK-205

## FIND-SPRINT-005-14
- **source:** SPRINT-005 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/index.ts
- **description:** Extends FIND-SPRINT-005-7 in scope. The streamParser barrel currently exports {LineBufferer, JSONParser, TypedEventNarrowing, EventRouter, ClaudeStreamParser, IWarnLogger, IDebugLogger, IStreamParserLogger}, but THREE sprint-introduced classes are absent: CompletionDetector (TASK-202), RawEventsSink (TASK-203), and MessageProjection (TASK-205). FIND-SPRINT-005-7 noted RawEventsSink alone; the same omission applies to the other two. The barrels own JSDoc says Single import point for downstream consumers (TASK-202, TASK-203, TASK-205). Import individual classes from this file, not from their implementation modules — but consumers cannot follow that rule for the three TASK names explicitly listed.
- **suggested_action:** Add to main/src/services/streamParser/index.ts:
- **resolved_by:** 





Suspected tasks: TASK-202, TASK-203, TASK-205
  export { CompletionDetector } from ./completionDetector;
  export type { ICompletionDetectorLogger, CompletionPayload, ForcedPayload } from ./completionDetector;
  export { RawEventsSink } from ./rawEventsSink;
  export type { IRawEventsSinkLogger } from ./rawEventsSink;
  export { MessageProjection } from ./messageProjection;
  export type { IMessageProjectionLogger } from ./messageProjection;
Fold this into the next wiring task or a tiny pre-cleanup commit.

## FIND-SPRINT-005-15
- **source:** SPRINT-005 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:94,103 vs main/src/services/cyboflow/stateMachine.ts:47 vs main/src/services/cyboflow/transitions.ts:10
- **description:** Error-class design diverges across sprint tasks. TASK-153 (transitions.ts) introduced `TransitionRejectedError extends Error` with a structured `details` payload (runId, expectedStatus, entity) and a discriminant `code: TRANSITION_REJECTED`. TASK-154 (stateMachine.ts) introduced `IllegalTransitionError extends Error` with named `from`, `to`, `runId` fields. Both follow the same pattern: typed subclass + structured payload, named property over JSON-in-message. By contrast TASK-204 added two new throw sites in claudeCodeManager.ts (lines 94 and 103) that use generic `new Error([ClaudeCodeManager] ...)`, losing the chance for callers to discriminate on a code or catch a specific subclass. This is the second time a sprint has shipped error-handling without a typed subclass; the per-task reviewer for TASK-204 didnt flag it because the per-task scope did not include the cyboflow service folder.
- **suggested_action:** Introduce a `PermissionModeError extends Error` (with a `code: PERMISSION_MODE_INVALID` discriminant) in main/src/services/panels/claude/permissionMode.ts (or alongside claudeCodeManager.ts) and use it for both throw sites. This matches the cyboflow-epic convention and lets the orchestrator pattern-match on the code when categorizing run failures (e.g. fail run with reason permission_misconfig rather than swallowing the message in a generic catch). Not urgent — file as a follow-up task tied to the orchestrator-wiring epic.
- **resolved_by:** 




Suspected tasks: TASK-204

## FIND-SPRINT-005-16
- **source:** SPRINT-005 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/eventRouter.ts:9 vs main/src/services/streamParser/completionDetector.ts:22
- **description:** Within the same sprint and same directory, two classes that both extend EventEmitter use different import paths for the same module: TASK-201 (eventRouter.ts) uses `import { EventEmitter } from node:events;` while TASK-202 (completionDetector.ts) uses `import { EventEmitter } from events;`. Both resolve to the same Node built-in, but the project lacks a documented convention for which form to use; the divergence appears inside a single new module folder created in this sprint. Cross-task pattern drift only visible at the sprint level.
- **suggested_action:** Pick one form (the `node:` prefix is the modern, explicit form and is what Node 22+ docs use) and apply it to both files. Optionally add an ESLint rule `unicorn/prefer-node-protocol` or a one-line note in `docs/CODE-PATTERNS.md` declaring the project preference so future tasks in the streamParser folder do not re-introduce the drift.
- **resolved_by:** 



Suspected tasks: TASK-201, TASK-202

## FIND-SPRINT-005-17
- **source:** SPRINT-005 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/{messageProjection.ts,completionDetector.ts,rawEventsSink.ts,streamParser.ts}; main/src/services/cyboflow/{stateMachine.ts,transitions.ts}
- **description:** Cross-sprint orphan-module tracker. The following sprint-introduced classes have ZERO production callsites (verified by `grep -rn ClassName main/src | grep -v __tests__ | grep -v streamParser/` for each):
- **suggested_action:** Compounder: synthesize one new epic wire-streamParser-and-state-machine that takes these six classes and threads them through the existing claudeCodeManager.handleClaudeOutput / panel-output ingestion path. Acceptance criterion: a grep of `MessageProjection|CompletionDetector|RawEventsSink|assertTransitionAllowed|transitionToAwaitingReview` in main/src outside __tests__ returns at least one production callsite per class. Until that epic lands, the FIND-SPRINT-005-9 regression (renderer crash from un-projected raw messages) and the FIND-SPRINT-005-11 state-machine gap remain unresolved.
- **resolved_by:** 


  - MessageProjection         (TASK-205) — only the test file imports it
  - CompletionDetector        (TASK-202) — only the test file imports it
  - RawEventsSink             (TASK-203) — only the test file imports it
  - assertTransitionAllowed   (TASK-154) — only the test file imports it
  - isTransitionAllowed       (TASK-154) — only the test file imports it
  - transitionToAwaitingReview / transitionFromAwaitingReview (TASK-153) — only the test file imports them

ClaudeStreamParser, EventRouter, LineBufferer, JSONParser, TypedEventNarrowing are also unused outside the test folder. Net effect: this sprint added ~1500 LOC of well-tested but production-dead code awaiting follow-up wiring tasks. Each task individually planned for this; the per-task reviewer cannot see the cumulative effect. The risk is that a future sprint forgets to wire one of these (e.g. CompletionDetector vs. just-finish-on-process-exit) and the orchestrator silently degrades to a less robust completion model. Worth flagging now so the compounder can produce a single wire the SPRINT-005 services epic instead of letting them drift into long-tail backlog.

Suspected tasks: TASK-153, TASK-154, TASK-201, TASK-202, TASK-203, TASK-205

## FIND-SPRINT-005-18
- **source:** SPRINT-005 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/Settings.tsx:39,76,292,293,313
- **description:** Extends FIND-SPRINT-005-6 enumeration. The Settings dialog component (frontend/src/components/Settings.tsx) is an additional callsite missed by FIND-SPRINT-005-6 that still defaults to `permissionMode: ignore`. Specifically: line 39 (`useState<approve | ignore>(ignore)`) and line 76 (`setDefaultPermissionMode(data.defaultPermissionMode || ignore)`) seed the Settings form with ignore as the default; lines 292-293 and 313 wire the radio buttons. When a user with no prior config opens Settings and clicks Save without changing the radio, they will write `defaultPermissionMode: ignore` back into the user config, undoing the TASK-204 ConfigManager default flip. This compounds the FIND-SPRINT-005-6 callsite sweep: ANY user who opens Settings and saves becomes a new vector for the broken spawn path.

Suspected tasks: TASK-204
- **suggested_action:** Roll this into the FIND-SPRINT-005-6 sweep. Change line 39 to `useState<approve | ignore>(approve)` and line 76 to `setDefaultPermissionMode(data.defaultPermissionMode || approve)`. Per the FIND-SPRINT-005-6 rejected-alternative note, also consider hiding the ignore radio button entirely (lines 292-293) behind a CYBOFLOW_DEBUG flag or removing it from the UI in the rebrand epic, since selecting ignore now throws at spawn time.
- **resolved_by:** 
