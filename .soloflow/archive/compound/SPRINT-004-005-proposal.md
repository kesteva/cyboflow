---
sprints: [SPRINT-004, SPRINT-005]
span_label: SPRINT-004-005
created: 2026-05-13T22:45:00.000Z
counters_start:
  ideas: 6
summary:
  cleanups: 7
  backlog_tasks: 10
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-004-005

## A. Clean-up items (execute now)

### A1. Delete dead `resultSubtypeEnum` binding in schemas.ts
- **Summary:** `resultSubtypeEnum` in `main/src/services/streamParser/schemas.ts` is never used at runtime and exists only to satisfy a since-superseded grep gate; TASK-103's fixture suite is now green, making it safe to remove.
- **Source-Sprint:** SPRINT-004
- **Rationale:** The binding is intentionally dead (silenced with `void resultSubtypeEnum`); its only purpose was to pass AC #6's grep gate. TASK-103's fixture suite now enforces subtype coverage behaviorally via the four `z.literal` sibling schemas. Removing it eliminates a misleading stub and the lint-suppression comment.
- **Blast radius:** `main/src/services/streamParser/schemas.ts` only; no runtime behavior change. Risk: trivial.
- **Source:** FIND-SPRINT-004-2 (TASK-102 code-reviewer); TASK-103-done.md confirms fixture suite is green.
- **Proposed change:**
  ```diff
  - export const resultSubtypeEnum = z.enum(['success', 'error_max_turns', 'error_api_error', 'error_quota_exceeded']);
  - void resultSubtypeEnum; // satisfies AC #6 grep gate; actual subtype coverage via z.literal siblings
  ```
  Delete both lines. Then update (or delete) the AC #6 grep comment in the schema file if present, and confirm `pnpm typecheck && pnpm --filter main lint` still passes.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/services/streamParser/schemas.ts:158-159` declares `const resultSubtypeEnum` followed by `void resultSubtypeEnum`, and grep across main/shared/frontend shows zero other references; the diff's enum values are stale (`error_max_budget_usd, error_during_execution` actual vs. `error_api_error, error_quota_exceeded` in proposal) but the deletion target is unambiguous.
- **Counterfactual:** If grep had found a downstream consumer of `resultSubtypeEnum`, this would flip to DONT_IMPLEMENT.

---

### A2. Narrow `assertNever` error message to exclude event body (PII risk)
- **Summary:** `assertNever` in `shared/types/claudeStream.ts` stringifies the entire event object into the thrown error message, which may include user prompt text or tool inputs when the CLI wire format drifts.
- **Source-Sprint:** SPRINT-004
- **Rationale:** The `type` discriminator alone is sufficient for diagnosis. `JSON.stringify(x)` of a full stream event body is the only PII vector in this throw path and will surface in crash reporters / log aggregators if a new Anthropic wire `type` triggers it at runtime.
- **Blast radius:** `shared/types/claudeStream.ts:287` only; changes one throw statement. Risk: trivial.
- **Source:** FIND-SPRINT-004-7 (SPRINT-004 sprint-code-reviewer); TASK-101-done.md confirmed as the file's authoring task.
- **Proposed change:**
  ```diff
  - throw new Error(`Unhandled stream event variant: ` + JSON.stringify(x));
  + throw new Error(`Unhandled stream event variant: ${(x as { type?: unknown })?.type ?? '<no-type>'}`);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `shared/types/claudeStream.ts:287` throws `'Unhandled stream event variant: ' + JSON.stringify(x)` — full event body stringification is the only PII vector in this throw, and the proposed narrow keeps diagnostic value while eliminating the leak; single-line, single-file change.

---

### A3. Quarantine legacy non-prefixed SQL files to suppress permanent boot WARNs
- **Summary:** Move the 18 legacy non-prefixed `.sql` files in `main/src/database/migrations/` into a `legacy/` subdirectory so the file-based migration runner stops emitting a WARN per file on every boot.
- **Source-Sprint:** SPRINT-005
- **Rationale:** The migration runner correctly skips these files (they predate the numeric-prefix era) but logs a WARN for each on every app launch — ~18 spurious lines that permanently mask genuine future migration warnings. The `legacy/` subdirectory is the cleaner fix: it follows the quarantine intent of `@cyboflow-hidden` without requiring a code change to the runner's log level.
- **Blast radius:** `main/src/database/migrations/` directory structure. Verify whether `copy:assets` in `package.json` glob-matches the `migrations/` tree; if it does, either include the `legacy/` subdirectory or stop shipping these files (they are never executed). Risk: low (runner only scans the directory it is configured to; subdir is not scanned).
- **Source:** FIND-SPRINT-005-1 (TASK-151 code-reviewer); TASK-151-done.md notes "~18 legacy non-prefixed .sql files" emitting WARN on every boot.
- **Proposed change:**
  ```
  mkdir main/src/database/migrations/legacy
  git mv main/src/database/migrations/add_archived_field.sql \
         main/src/database/migrations/add_build_commands.sql \
         main/src/database/migrations/add_claude_session_id.sql \
         [... all remaining non-prefixed .sql files] \
         main/src/database/migrations/legacy/
  ```
  Then confirm `pnpm --filter main test` still passes (runner must NOT pick up the legacy/ subdir), and check the `package.json` `copy:assets` script.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed 18 non-prefixed legacy `.sql` files in `main/src/database/migrations/` alongside the 4 numeric-prefixed ones (003-006); `main/package.json:11`'s `copy:assets` script globs `src/database/migrations/*.sql` flat, so the new `legacy/` subdir will be excluded from the shipped bundle automatically — which is desirable since these files are never executed. Permanent boot-time WARN noise on every launch is concrete recurring harm; the fix is a directory move.
- **Counterfactual:** If the migration runner scans recursively (it should not — needs a 1-line read of the runner to confirm), this would flip to DONT_IMPLEMENT.

---

### A4. Remove no-op type cast in `stateMachine.ts:isTransitionAllowed`
- **Summary:** The `as readonly WorkflowRunStatus[]` cast on `ALLOWED_TRANSITIONS[from]` in `stateMachine.ts` is redundant — the indexed access already carries that type — and should be removed.
- **Source-Sprint:** SPRINT-005
- **Rationale:** The cast neither widens nor narrows the type and produces visual noise. `pnpm typecheck` passes without it. No behavioral effect.
- **Blast radius:** `main/src/services/cyboflow/stateMachine.ts:39` only. Risk: trivial.
- **Source:** FIND-SPRINT-005-4 (TASK-154 code-reviewer).
- **Proposed change:**
  ```diff
  - return (ALLOWED_TRANSITIONS[from] as readonly WorkflowRunStatus[]).includes(to);
  + return ALLOWED_TRANSITIONS[from].includes(to);
  ```
  Run `pnpm typecheck` to confirm.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/services/cyboflow/stateMachine.ts:39` contains the exact no-op cast; the indexed access already carries `readonly WorkflowRunStatus[]` from the `Record<...>` value type, so removal is a single-line, zero-risk visual-noise reduction in an isolated file.

---

### A5. Complete streamParser barrel exports (CompletionDetector, RawEventsSink, MessageProjection)
- **Summary:** Three classes introduced in SPRINT-005 (`CompletionDetector`, `RawEventsSink`, `MessageProjection`) are absent from `main/src/services/streamParser/index.ts`, the documented single-import-point barrel, making it impossible to follow the barrel convention for these classes.
- **Source-Sprint:** SPRINT-005
- **Rationale:** The barrel's own JSDoc names these three tasks as intended consumers of the single import point. Downstream wiring tasks (TASK-206+) that follow the barrel convention will hit "no exported member" errors or resort to implementation-module imports, violating the documented pattern. This is a two-to-four line fix.
- **Blast radius:** `main/src/services/streamParser/index.ts` only; purely additive exports. Risk: trivial.
- **Source:** FIND-SPRINT-005-7 (TASK-203 code-reviewer) and FIND-SPRINT-005-14 (SPRINT-005 sprint-code-reviewer) — deduped into one item covering all three missing classes.
- **Proposed change:**
  ```diff
  + export { CompletionDetector } from './completionDetector';
  + export type { ICompletionDetectorLogger, CompletionPayload, ForcedPayload } from './completionDetector';
  + export { RawEventsSink } from './rawEventsSink';
  + export type { IRawEventsSinkLogger } from './rawEventsSink';
  + export { MessageProjection } from './messageProjection';
  + export type { IMessageProjectionLogger } from './messageProjection';
  ```
  Add to `main/src/services/streamParser/index.ts` after the existing export block. Run `pnpm typecheck`.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/services/streamParser/index.ts:1-19` only exports the 5 SPRINT-004 classes; `CompletionDetector`, `RawEventsSink`, `MessageProjection` are all defined in their own files and absent from the barrel that explicitly self-documents itself as "Single import point for downstream consumers (TASK-202, TASK-203, TASK-205)" — a direct contradiction of the file's own JSDoc.

---

### A6. Fix `node:events` vs `events` import inconsistency in streamParser
- **Summary:** `eventRouter.ts` uses `import { EventEmitter } from 'node:events'` while `completionDetector.ts` uses `import { EventEmitter } from 'events'` — both in the same new `streamParser/` folder; standardize on the `node:` prefix.
- **Source-Sprint:** SPRINT-005
- **Rationale:** Both resolve identically at runtime but the inconsistency inside a single module folder creates noise and contradicts the modern Node convention. The `node:` prefix is unambiguous and is the form Node 22+ documentation uses.
- **Blast radius:** `main/src/services/streamParser/completionDetector.ts:22` only. Risk: trivial.
- **Source:** FIND-SPRINT-005-16 (SPRINT-005 sprint-code-reviewer).
- **Proposed change:**
  ```diff
  - import { EventEmitter } from 'events';
  + import { EventEmitter } from 'node:events';
  ```
  Run `pnpm typecheck && pnpm --filter main test`.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `completionDetector.ts:22` uses `from 'events'` while sibling `eventRouter.ts:9` uses `from 'node:events'` — inconsistency within a single new module folder; the streamParser/ folder is also the only `node:`-prefixed locus in the codebase, so standardizing on `node:` within just this folder is a coherent local rule that does not contradict the broader repo's unprefixed convention.

---

### A7. Add `PRAGMA foreign_keys = ON` to DatabaseService constructor
- **Summary:** SQLite does not enforce `FOREIGN KEY ... ON DELETE CASCADE` by default; `main/src/database/database.ts` never issues `PRAGMA foreign_keys = ON`, making all four CASCADE clauses in `006_cyboflow_schema.sql` completely inert.
- **Source-Sprint:** SPRINT-005
- **Rationale:** This is a data-integrity bug introduced by TASK-152's FK declarations combined with TASK-151's migration runner, neither of which added the required PRAGMA. Without it: orphan `raw_events`/`messages`/`approvals` rows silently accumulate after `workflow_run` deletes, and inserts with non-existent foreign keys silently succeed. The fix is a single line added before migrations run.
- **Blast radius:** `main/src/database/database.ts` constructor/initialize. The PRAGMA applies to every connection from that point forward; Crystal-era tables without explicit FK declarations are unaffected (SQLite only enforces FKs that are declared). Risk: low — but run the full test suite (`pnpm --filter main test`) to confirm no Crystal-era inline migrations break under enforcement. Add two regression tests to `cyboflowSchema.test.ts`: (1) cascade delete propagates; (2) insert with non-existent `run_id` throws `SQLITE_CONSTRAINT_FOREIGNKEY`.
- **Source:** FIND-SPRINT-005-12 (SPRINT-005 sprint-code-reviewer); TASK-152-done.md confirms FK declarations are present in 006_cyboflow_schema.sql.
- **Proposed change:**
  ```diff
  // In DatabaseService.initialize() or constructor, BEFORE runMigrations():
  + this.db.pragma('foreign_keys = ON');
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/database/database.ts` contains zero `foreign_keys` references (all 30 `pragma` calls are `table_info`), while `006_cyboflow_schema.sql:30,40,50,65` declares 4 `FOREIGN KEY ... ON DELETE CASCADE` clauses; without the PRAGMA these clauses are silently inert per SQLite spec, making this a concrete data-integrity bug introduced in SPRINT-005.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Wire `MessageProjection` into the `panels:get-json-messages` IPC path (renderer crash fix)
- **Summary:** The Claude panel crashes with `TypeError: Cannot read properties of undefined (reading 'some')` on any session load because `panels:get-json-messages` returns raw stream-json objects that lack the `.segments` property the renderer expects.
- **Source-Sprint:** SPRINT-005
- **Source:** FIND-SPRINT-005-9 (TASK-205 verifier); TASK-205-done.md §Deferred section; human-review-queue.md TASK-205 testing item (severity: high).
- **Problem:** `main/src/ipc/session.ts:869-918` (`panels:get-json-messages` handler) returns raw `{type, subtype, message, ...}` stream-json objects. `RichOutputView.tsx:230` calls `messageTransformer.transform(allMessages)`, which now returns the raw objects unchanged (TASK-205 reduced `ClaudeMessageTransformer` to an identity stub). Downstream rendering at lines 236, 407, 440-450, 470, 566, 602, 681, 700, 723, 728, 767 accesses `message.segments`, which is `undefined` on raw objects, causing a `TypeError` crash. `MessageProjection` (from TASK-205, `main/src/services/streamParser/messageProjection.ts`) exists and is fully tested but is not wired into this data path.
- **Proposed direction:** Modify the `panels:get-json-messages` IPC handler in `main/src/ipc/session.ts` to instantiate a `MessageProjection` instance, feed each stored raw event through `TypedEventNarrowing.narrow()` and then `MessageProjection.project()`, and return the resulting `UnifiedMessage[]` array. This matches the "smallest delta consistent with plan step 3's 'do not introduce a new IPC surface'" directive from the TASK-205 plan. The `MessageProjection` class is already imported from the streamParser barrel (after A5 lands). A smoke test (manually open Cyboflow, create a session, confirm the Claude panel renders without crashing) closes the human-review-queue TASK-205 item.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/ipc/session.ts:869` `panels:get-json-messages` handler exists and grep shows zero `MessageProjection` references in `main/src/ipc/` or `main/src/events.ts`; FIND-SPRINT-005-9 (severity: high) documents the concrete `TypeError: Cannot read properties of undefined (reading 'some')` crash on every Claude panel load — this is an active P0 renderer regression, not a hypothetical.

---

### B2. Permissive `permissionMode: 'ignore'` callsite sweep — fix broken session creation
- **Summary:** TASK-204 seals the `--dangerously-skip-permissions` bypass with a hard throw, but at least 9 UI callsites across frontend and main still default to `permissionMode: 'ignore'`, causing every standard user-initiated session to throw and fail.
- **Source-Sprint:** SPRINT-005
- **Source:** FIND-SPRINT-005-6 (TASK-204 verifier, severity: high); FIND-SPRINT-005-18 (SPRINT-005 sprint-code-reviewer); TASK-204-done.md §Notes.
- **Problem:** The following callsites all pass or default to `permissionMode: 'ignore'`, which now hits the hard throw in `claudeCodeManager.buildCommandArgs()`:
  - `frontend/src/stores/sessionPreferencesStore.ts:29` — default `permissionMode: 'ignore'`
  - `frontend/src/components/CreateSessionDialog.tsx:91,100` — `initialClaudeConfig?.permissionMode || 'ignore'` and bare `permissionMode: 'ignore'` literal
  - `frontend/src/components/CreateSessionButton.tsx:52` — `permissionMode: 'ignore'`
  - `frontend/src/components/DraggableProjectTreeView.tsx:1132` — `permissionMode: 'ignore'`
  - `main/src/events.ts:644` — `claudeConfig.permissionMode || 'ignore'`
  - `main/src/services/configManager.ts:171` — `sessionCreationPreferences.claudeConfig.permissionMode: 'ignore'`
  - `frontend/src/components/Settings.tsx:39` — `useState<'approve'|'ignore'>('ignore')`
  - `frontend/src/components/Settings.tsx:76` — `setDefaultPermissionMode(data.defaultPermissionMode || 'ignore')`
  - `frontend/src/components/dialog/ClaudeCodeConfig.tsx:11,298` — exposes `'ignore'` as a selectable UI option (which, if chosen, immediately breaks spawn)
- **Proposed direction:** Perform a targeted find-replace sweep across frontend and main flipping every `'ignore'` default to `'approve'` at the above locations. For `ClaudeCodeConfig.tsx`, consider hiding the `'ignore'` radio button behind a `CYBOFLOW_DEBUG=1` env guard or removing it from the UI entirely (per the plan's rejected-alternative note), since selecting it now throws at spawn time. Add or update unit tests for `sessionPreferencesStore` initial state. The sweep should be atomic (single task, single PR) so a partial flip doesn't leave the app in a mixed state. Acceptance criterion: `grep -rn "permissionMode.*ignore" frontend/src main/src | grep -v test | grep -v node_modules` returns zero hits outside of intentional debug/escape-hatch guarding.
- **Scope:** small-medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed all cited callsites exist (`sessionPreferencesStore.ts:29`, `CreateSessionDialog.tsx:91,100`, `CreateSessionButton.tsx:52`, `DraggableProjectTreeView.tsx:1132`, `events.ts:644`, `Settings.tsx:39,76`, `ClaudeCodeConfig.tsx:298`) and TASK-204's hard throw in `claudeCodeManager.ts:94` is live — every standard UI session-creation path now throws at spawn until this sweep lands; FIND-SPRINT-005-6 is severity: high and FIND-SPRINT-005-18 expands the enumeration.

---

### B3. Canonicalize shared block/content types — eliminate tri-package type duplication
- **Summary:** `TextBlock`, `ToolUseBlock`, `ToolResultBlock` are defined independently in three packages (`shared/types/claudeStream.ts`, `main/src/types/session.ts`, `frontend/src/types/session.ts`), violating the `docs/CODE-PATTERNS.md` shared-types contract; the legacy definitions also carry a narrower `ToolResultContent.content: string` that misses the array form.
- **Source-Sprint:** SPRINT-004
- **Source:** FIND-SPRINT-004-4 (SPRINT-004 sprint-code-reviewer, severity: medium); TASK-101-done.md confirmed `shared/types/claudeStream.ts` as the canonical authoring task.
- **Problem:** The same domain concept is defined three times: `TextBlock`/`ToolUseBlock`/`ToolResultBlock`/`ThinkingBlock` in `shared/types/claudeStream.ts:18-58` vs. `TextContent`/`ToolUseContent`/`ToolResultContent` in `main/src/types/session.ts:88-105` and `frontend/src/types/session.ts:1-19`. The shared types are better-specced (`ToolResultBlock.content: string | Array<{type, text}>`) while the legacy ones carry `ToolResultContent.content: string` — a latent bug where the array form from the Claude API is silently dropped or causes a type error at a callsite.
- **Proposed direction:** Make `shared/types/claudeStream.ts` the single source of truth. Re-export the four block types from a named `shared/types/` index. Convert the `main/src/types/session.ts` and `frontend/src/types/session.ts` definitions to type aliases (`type TextContent = TextBlock`) pointing at the shared exports. While editing, widen `ToolResultContent.content` to `string | Array<{type: string; text: string}>` to match the wire spec. Update any callsite that relied on the narrower type. Run `pnpm typecheck` across all workspaces to surface breakages.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed tri-package duplication exists (`shared/types/claudeStream.ts:17-58` defines four Block types; `main/src/types/session.ts:88-105` and `frontend/src/types/session.ts:2-21` each define near-identical `TextContent`/`ToolUseContent`/`ToolResultContent`) and `ToolResultContent.content: string` is genuinely narrower than `ToolResultBlock.content: string | Array<{type,text}>`; this is a documented violation of the `docs/CODE-PATTERNS.md` shared-types contract and a latent runtime bug surface when the array form arrives.
- **Counterfactual:** If callsite breakage from the widened content type proves >medium scope at `pnpm typecheck` time, the impact-bar/proportionality assessment may shift.

---

### B4. Add bidirectional TS↔Zod drift bridge to schemas.ts
- **Summary:** The existing `_typeCheck` compile-time guard in `schemas.ts` only catches Zod fields that leak outside the TS union; it does not catch TS fields silently absent from the Zod schema, leaving a one-way drift gap.
- **Source-Sprint:** SPRINT-004
- **Source:** FIND-SPRINT-004-5 (SPRINT-004 sprint-code-reviewer, severity: medium); TASK-102-done.md confirmed as authoring task for `schemas.ts`.
- **Problem:** `const _typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>` only verifies assignability in one direction. If a field is added to `ClaudeStreamEvent` in `claudeStream.ts` but omitted from the Zod schema in `schemas.ts`, the bridge passes because the inferred Zod type is a subtype of (not equal to) `ClaudeStreamEvent`. The field will be silently stripped at runtime. Concrete risk: `ResultEvent` has many optional fields; a new optional field added to the TS type won't trigger a build failure.
- **Proposed direction:** Add a reverse bridge: `const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as ClaudeStreamEvent; void _reverseCheck` in `schemas.ts`, immediately below the existing `_typeCheck`. This forces the compiler to verify that any TS-only field is also represented in the Zod schema. Alternatively (and preferably if timing allows), derive `ClaudeStreamEvent` directly from `z.infer<typeof claudeStreamEventSchema>` by exporting the inferred type from `schemas.ts` and re-exporting it from `shared/types/claudeStream.ts` — this eliminates the drift surface entirely. The simpler two-line bridge is the low-risk fast path.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/services/streamParser/schemas.ts:265-266` contains only the one-way `_typeCheck` bridge; FIND-SPRINT-004-5's analysis of one-way assignability is correct (z.infer being a structural subtype of ClaudeStreamEvent does not catch TS-only optional fields), and the proposed two-line reverse bridge is the smallest defensible fix with zero runtime cost.

---

### B5. Wire orphan pipeline classes into production callsites (stream-parser + state-machine)
- **Summary:** Six classes introduced in SPRINT-005 (`MessageProjection`, `CompletionDetector`, `RawEventsSink`, `assertTransitionAllowed`, `transitionToAwaitingReview`, `transitionFromAwaitingReview`) have zero production callsites; wiring them into the orchestrator is the next critical path item for the Cyboflow run pipeline.
- **Source-Sprint:** SPRINT-005
- **Source:** FIND-SPRINT-005-17 (SPRINT-005 sprint-code-reviewer); TASK-201-done.md, TASK-202-done.md, TASK-203-done.md, TASK-153-done.md, TASK-154-done.md all note production wiring as deferred.
- **Problem:** `grep -rn "MessageProjection|CompletionDetector|RawEventsSink|assertTransitionAllowed|transitionToAwaitingReview" main/src | grep -v __tests__ | grep -v streamParser/` returns zero production callsites. The full parser pipeline (LineBufferer → JSONParser → TypedEventNarrowing → EventRouter → ClaudeStreamParser) is also not connected to `claudeCodeManager.handleClaudeOutput`. Until wiring lands: (a) the Claude panel crash (FIND-SPRINT-005-9 / B1) persists, (b) raw events are never persisted to `raw_events`, (c) completion is never detected robustly (the app likely falls back to process-exit), and (d) the `assertTransitionAllowed` state-machine guard is never consulted in production transitions (FIND-SPRINT-005-11).
- **Proposed direction:** Create a new epic `wire-sprint-005-services` with the following scope: (1) In `claudeCodeManager.ts`, instantiate `ClaudeStreamParser` and wire it to the PTY/child-process stdout; attach `RawEventsSink` to the `EventRouter`; attach `CompletionDetector` signals to child-process events. (2) In `transitions.ts`, call `assertTransitionAllowed()` before each SQL UPDATE (FIND-SPRINT-005-11). (3) Wire `MessageProjection` into the `panels:get-json-messages` IPC handler (overlaps with B1 — B1 can be the first task in this epic). Acceptance criterion: `grep -rn "MessageProjection|CompletionDetector|RawEventsSink|assertTransitionAllowed|transitionToAwaitingReview" main/src | grep -v __tests__` returns at least one production callsite per class.
- **Scope:** large

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed via `grep -rn "MessageProjection|CompletionDetector|RawEventsSink|assertTransitionAllowed|transitionToAwaitingReview" main/src | grep -v __tests__ | grep -v streamParser/ | grep -v cyboflow/stateMachine.ts | grep -v cyboflow/transitions.ts` returns zero hits — six well-tested classes (~1500 LOC) are production-dead, and the renderer crash (B1) plus state-machine gap (B6) both stem from this missing wiring; this epic is the critical-path follow-on for SPRINT-005.

---

### B6. Call `assertTransitionAllowed()` in `transitions.ts` before each SQL UPDATE
- **Summary:** `transitions.ts` mutates `workflow_runs.status` via raw SQL without invoking the `assertTransitionAllowed()` from `stateMachine.ts`, leaving the in-process state-machine guard with zero production callers.
- **Source-Sprint:** SPRINT-005
- **Source:** FIND-SPRINT-005-11 (SPRINT-005 sprint-code-reviewer, severity: medium); TASK-153-done.md, TASK-154-done.md confirmed as authoring tasks.
- **Problem:** `assertTransitionAllowed` (from `stateMachine.ts`) is tested by its own unit suite but has no production callsites outside that test file. `transitions.ts` relies exclusively on the SQL `AND status=<expected>` guard. If a future maintainer edits the hardcoded SQL literal to a wrong target state, no in-process guard fires — only a 0-row UPDATE silently returns (which becomes a `TransitionRejectedError` only if caught). The `ALLOWED_TRANSITIONS` table in `stateMachine.ts` exists as the single source of truth but is unreachable from the production transition path.
- **Proposed direction:** At the top of each transaction in `transitionToAwaitingReview` and `transitionFromAwaitingReview`, add `assertTransitionAllowed(fromStatus, toStatus, params.runId)` before the `db.transaction(fn).immediate(args)` call. Add a unit test that verifies the assertion fires (and the SQL UPDATE is NOT reached) when an illegal transition is attempted, so the in-process guard is exercised independently of the DB guard. This task can be folded into the B5 `wire-sprint-005-services` epic as an early task.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/services/cyboflow/transitions.ts:61,114,125` throws `TransitionRejectedError` from raw SQL UPDATE results without ever calling `assertTransitionAllowed`; the in-process `ALLOWED_TRANSITIONS` table in `stateMachine.ts` has zero production callers per grep, leaving the single source of truth unreachable from prod — small additive fix with clear test surface.

---

### B7. Consolidate six ad-hoc logger interfaces in streamParser into a shared `ILogger`
- **Summary:** Six per-file logger interfaces in the streamParser pipeline (`IWarnLogger`, `IDebugLogger`, `IStreamParserLogger`, `ICompletionDetectorLogger`, `IRawEventsSinkLogger`, `IMessageProjectionLogger`) are structurally overlapping or identical and should be replaced by a single shared interface.
- **Source-Sprint:** SPRINT-005
- **Source:** FIND-SPRINT-005-13 (SPRINT-005 sprint-code-reviewer, severity: medium); TASK-201-done.md, TASK-202-done.md, TASK-203-done.md, TASK-205-done.md confirmed as authoring tasks for each file.
- **Problem:** Three of the six (`IWarnLogger`, `IRawEventsSinkLogger`, `IMessageProjectionLogger`) are structurally identical `{ warn(msg: string): void }`. Every downstream wiring task must construct or adapt a different interface per pipeline stage. Future refactors that broaden any one interface require touching multiple definitions. ESLint cannot detect structural drift between them.
- **Proposed direction:** Add `ILogger` (or reuse the project Logger if it already defines the union of methods) to `main/src/services/streamParser/types.ts`. Give it `{ warn(msg: string): void; verbose?(msg: string): void; info?(msg: string): void }`. Replace each per-file interface with either direct `ILogger` consumption or a `Pick<ILogger, 'warn'>` alias. Update the barrel exports (A5) to export `ILogger` from `types.ts`. This is cleanest as a single pre-wiring cleanup task before the B5 epic starts connecting callsites.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed six per-file logger interfaces exist (`IWarnLogger` in jsonParser.ts:13, `IDebugLogger` in typedEventNarrowing.ts:13, `IStreamParserLogger` in streamParser.ts:18, `ICompletionDetectorLogger` in completionDetector.ts:25, `IRawEventsSinkLogger` in rawEventsSink.ts:30, `IMessageProjectionLogger` in messageProjection.ts:26) with three structurally identical `{ warn(msg) }` shapes; consolidating before B5's wiring lands reduces per-stage adapter friction at the pipeline boundary.
- **Counterfactual:** If B5 is sequenced first and naturally surfaces a single Logger contract via the project's existing Logger service, this cleanup may be subsumed and become DONT_IMPLEMENT.

---

### B8. Delete or refactor `parseClaudeStreamEvent` — eliminate dual safeParse implementations
- **Summary:** `parseClaudeStreamEvent` in `schemas.ts` and `TypedEventNarrowing.narrow()` in `typedEventNarrowing.ts` implement the same safeParse-and-fallback-to-`__unknown__` contract with different log channels; once the pipeline is wired, the legacy function has no production callers.
- **Source-Sprint:** SPRINT-004, SPRINT-005
- **Source:** FIND-SPRINT-005-5 (TASK-201 code-reviewer); FIND-SPRINT-004-6 (SPRINT-004 sprint-code-reviewer) — both concern `parseClaudeStreamEvent`'s role and logging behavior. Deduped: the root problem is the same dual implementation.
- **Problem:** `parseClaudeStreamEvent` (in `schemas.ts`) logs via `console.warn` directly and is exercised only by `schemas.test.ts`. `TypedEventNarrowing.narrow()` (in `typedEventNarrowing.ts`) implements the same contract with an injected `IDebugLogger`. Both paths are reachable. The legacy function also has the console.warn / Logger inconsistency flagged by FIND-SPRINT-004-6. After B5 wires `TypedEventNarrowing` into the pipeline, `parseClaudeStreamEvent` has no production caller.
- **Proposed direction:** After the B5 pipeline wiring lands: (1) check `grep -rn "parseClaudeStreamEvent" main/src | grep -v test` — expect zero hits. (2) Delete `parseClaudeStreamEvent` from `schemas.ts` (and its `console.warn` call). Update `schemas.test.ts` to import and test via `TypedEventNarrowing.narrow()` with a console-adapter logger. (3) The `_typeCheck` bridge and `resultSubtypeEnum` cleanup (A1) are independent and can land earlier. This task is a follow-on to B5.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `parseClaudeStreamEvent` is referenced only in `schemas.ts` (its definition) and `schemas.test.ts` (its tests) — zero production callers — while `TypedEventNarrowing.narrow` implements the same safeParse-and-fallback contract; deletion eliminates the `console.warn` inconsistency (FIND-SPRINT-004-6) and a parallel implementation surface. Properly gated on B5 landing first.

---

### B9. Add real-CLI fixture capture workflow and tighten synthetic fixture values
- **Summary:** The synthetic stream-json fixtures in `main/src/services/streamParser/__fixtures__/` use unverified placeholder values (`permissionMode: "bypassPermissions"`, model IDs from the agent's training cutoff) that will silently mask schema drift when real-CLI captures arrive.
- **Source-Sprint:** SPRINT-004
- **Source:** FIND-SPRINT-004-8 (SPRINT-004 sprint-code-reviewer, severity: low); TASK-103-done.md §Notes ("Re-capture recommended quarterly per fixture README").
- **Problem:** `system_init.json` uses `permissionMode: "bypassPermissions"` — a value not in any documented enum; `result_*.json` files all use `"claude-opus-4-5"` as the `modelUsage` key (unverified, may not match real wire output). The fixture README correctly labels them synthetic but the values themselves are not pinned to a verified source. When a real CLI capture replaces these, the diff may surface unexpected drift that was masked during SPRINT-004's test authoring.
- **Proposed direction:** Create a documented procedure for quarterly fixture refresh: (1) Run `claude --output-format stream-json` against a minimal prompt and capture the raw output. (2) Replace synthetic fixtures with redacted real captures (remove PII from tool inputs/outputs, replace model IDs with `<model-id>` if tests don't assert on them). (3) Update `system_init.json` with verified `permissionMode` and `apiKeySource` values. (4) Decide whether `permissionMode` / `apiKeySource` fields should be tightened from `z.string()` to `z.enum([...])`. Document the procedure in the fixture README and in `docs/CODE-PATTERNS.md` under a "Fixture maintenance" section.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `system_init.json:10` does carry `permissionMode: "bypassPermissions"` and the fixture README already labels these as synthetic with a quarterly-refresh note (per TASK-103-done); FIND-SPRINT-004-8 is severity: low and represents a single-sprint cosmetic observation about placeholder values — adding a new "Fixture maintenance" section to `docs/CODE-PATTERNS.md` plus a documented procedure is disproportionate process overhead for a problem that the README already addresses and that no failing test or sprint friction has surfaced.
- **Counterfactual:** If a real-CLI capture lands and the diff reveals concrete drift in field shapes (not just values), this flips to IMPLEMENT.

---

### B10. Introduce typed error subclass for permission-mode failures in `claudeCodeManager.ts`
- **Summary:** The two throw sites added by TASK-204 in `claudeCodeManager.ts` use generic `new Error(...)`, inconsistent with the `TransitionRejectedError`/`IllegalTransitionError` typed-subclass pattern established by TASK-153/154 in the same sprint.
- **Source-Sprint:** SPRINT-005
- **Source:** FIND-SPRINT-005-15 (SPRINT-005 sprint-code-reviewer, severity: low); TASK-204-done.md, TASK-153-done.md, TASK-154-done.md confirmed the pattern divergence.
- **Problem:** `claudeCodeManager.ts:94,103` throws `new Error('[ClaudeCodeManager] Cyboflow runs require approve mode...')` and `new Error('[ClaudeCodeManager] approve mode requested but permissionIpcPath is not configured...')`. Callers cannot discriminate these failures by subclass or `code` discriminant — they must string-match the message. The cyboflow-epic convention (from TASK-153/154) is typed subclass + `code: LITERAL as const` + structured payload.
- **Proposed direction:** Create a `PermissionModeError extends Error` class in `main/src/services/panels/claude/permissionMode.ts` (or alongside `claudeCodeManager.ts`) with a `readonly code = 'PERMISSION_MODE_INVALID' as const` discriminant and a `details: { reason: 'ignore_mode' | 'missing_socket'; effectiveMode: string }` payload. Replace both throw sites in `claudeCodeManager.ts` with `throw new PermissionModeError(...)`. Update the 4 existing unit tests to catch `PermissionModeError` by type (not by message string). Link to the future orchestrator-wiring epic where the `code` discriminant will be used to categorize run failures.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `claudeCodeManager.ts:94,103` throws generic `new Error(...)` and `TransitionRejectedError`/`IllegalTransitionError` patterns exist in cyboflow/, but B2's sweep should eliminate the `'ignore'` callsites entirely so these throws become near-unreachable defensive guards — adding a typed subclass + tests + new file for two throws that B2 is designed to make unreachable is overengineering ahead of the actual need; better to revisit if orchestrator-wiring (B5) shows a concrete consumer that must discriminate by `code`.
- **Counterfactual:** If B5 wiring lands and the orchestrator must categorize spawn failures by error code, this flips to IMPLEMENT.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add rule: ACs with compile-time assertions must include `pnpm typecheck`
- **Summary:** Add a rule to `CLAUDE.md` requiring that any acceptance criterion containing a TypeScript compile-time assertion (e.g., `assertNever`, branded types, conditional types) must include `pnpm typecheck` (or `tsc --noEmit`) alongside any `pnpm test` command, because transpile-only runners like Vitest/esbuild silently bypass compile-time checks.
- **Source-Sprint:** SPRINT-004
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/CLAUDE.md`
- **Action:** insert-after "## TypeScript Rules" section (append a new section directly after it)
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  @@ ## TypeScript Rules @@
   The `any` type is forbidden. ESLint rule `@typescript-eslint/no-explicit-any` is set to `error` and CI enforces it. Use `unknown` (with type guards) or narrow generics instead.
  +
  +## Compile-Time Assertions in ACs
  +
  +If a task's AC relies on a TypeScript compile-time tripwire (`assertNever`, branded/opaque types, conditional types, or anything that fails only under `tsc`), the AC verification command MUST include `pnpm typecheck`. Vitest/esbuild strip types and will pass a test file containing type errors. Canonical example: `shared/types/claudeStream.ts:286` (`assertNever`) used at `main/src/services/streamParser/__tests__/schemas.test.ts:360`.
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** FIND-SPRINT-004-3 is a SoloFlow plan-authoring concern (the AC's verification command list), not a cyboflow code-pattern — the proposed rule lives in CLAUDE.md but targets plan-writers / soloflow planning behavior, which the proposal's own "Suppressed — SoloFlow Defects" section explicitly identifies as the right home for FIND-SPRINT-004-1 (sibling SoloFlow workflow concern); a CLAUDE.md rule for a one-off cross-cutting plan-authoring lesson consumes attention budget in every future agent prompt for a problem that future plans, not agents, must internalize.
- **Counterfactual:** If a second sprint surfaces the same "Vitest silently bypassed a compile-time AC" failure, this would flip to IMPLEMENT.

---

### C2. Add Node built-in import convention to `docs/CODE-PATTERNS.md` [dropped — too-broad]
- **Summary:** Add a one-line note to `docs/CODE-PATTERNS.md` declaring the `node:` protocol prefix as the project standard for Node built-in module imports, to prevent per-file drift like the `node:events` vs `events` inconsistency introduced in SPRINT-005.
- **Source-Sprint:** SPRINT-005
- **Status:** too-broad
- **source_item:** C2
- **Reason:** The codebase's de-facto convention is the *unprefixed* form: ~48 production files use `from 'events'|'fs'|'path'|'os'|'child_process'|...` versus 2 production files (`streamParser/eventRouter.ts`, `streamParser/completionDetector.ts` post-A6) using `node:`. Declaring `node:` as the project standard in CODE-PATTERNS.md would contradict ~48 callsites and create a documentation/code divergence larger than the two-file inconsistency it tries to fix. A6 already resolves the localized SPRINT-005 drift; a project-wide doctrine should be a deliberate codemod task, not a CODE-PATTERNS.md edict introduced by two outlier files.

---

## Reconciled Findings (informational)

The following findings appear as `status: open` in their respective findings files but are claimed as resolved in done reports. The sprint-closer's reconciliation step did not patch the findings-file `status` field for these items. They are excluded from triaging above.

- **FIND-SPRINT-005-2** — claimed resolved by TASK-155 in `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/cyboflow-schema-migration/TASK-155-done.md` (done report: "later tightened the backfill-isolation case"; test-writer refactored the existing-install test to genuinely exercise the auto-backfill path).
- **FIND-SPRINT-005-3** — claimed resolved by TASK-155 in `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/cyboflow-schema-migration/TASK-155-done.md` (done report: "dropped unused imports"; commit `a8bafa1` removed `writeFileSync, mkdirSync` from `cyboflowSchema.test.ts:25`).
- **FIND-SPRINT-005-10** — claimed resolved by TASK-205 in `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/stream-parser-to-main/TASK-205-done.md` (done report: "21 tests including the FIND-SPRINT-005-10 fix for warn-payload assertion"; commit `beb4822` added the missing `expect(warnings.length).toBeGreaterThan(0)` assertion).

---

## Suppressed — SoloFlow Defects

The following candidates were considered for Bucket C (CLAUDE.md / CODE-PATTERNS.md) but reclassified as SoloFlow plugin defects after the self-defect check. They are suppressed here because `tester: false`. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface them as maintainer recommendations.

- **Plan refinement mid-flight protocol (FIND-SPRINT-004-1)** — The finding describes a SoloFlow plan-refinement workflow behavior: a plan was refined from 87 → 159 lines after the executor had already begun working against the 87-line version, causing the executor to miss a new implementation step. The proposed guidance ("if `status: in-flight`, refinements may not introduce new implementation steps") is a rule about how SoloFlow's plan-refinement command should behave, not about this project's code. It would evaporate if the user switched to a different coding workflow. Consider opening an issue in the SoloFlow plugin repo to enforce that mid-flight plan refinements are restricted to clarifications only.
