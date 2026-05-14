---
sprints: [SPRINT-007]
span_label: SPRINT-007
created: "2026-05-14T00:00:00.000Z"
counters_start:
  ideas: 0
summary:
  cleanups: 8
  backlog_tasks: 4
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-007

## A. Clean-up items (execute now)

### A1. Fix `router.test.ts` to assert `METHOD_NOT_SUPPORTED` instead of `NOT_IMPLEMENTED`
- **Summary:** Ten tests in the tRPC router test suite fail because they still assert the old `NOT_IMPLEMENTED` error code after the implementation migrated to `METHOD_NOT_SUPPORTED` in SPRINT-006.
- **Source-Sprint:** SPRINT-007
- **Rationale:** The test suite is currently broken on `main` — `isNotImplemented` at line 29 and the literal at line 124 both check for `NOT_IMPLEMENTED`, but `throwNotImplemented` in `trpc.ts:43` now throws `METHOD_NOT_SUPPORTED`. Every tRPC procedure test that relies on `isNotImplemented` fails. Two-line fix restores a passing suite.
- **Blast radius:** `main/src/orchestrator/trpc/__tests__/router.test.ts` only. Risk: trivial (test-only change).
- **Source:** FIND-SPRINT-007-1 (surfaced by TASK-573 verifier); pre-existing on `main` at commit b257f7a.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/trpc/__tests__/router.test.ts

  // Line 29 — isNotImplemented predicate
  -  return err instanceof TRPCError && err.code === 'NOT_IMPLEMENTED';
  +  return err instanceof TRPCError && err.code === 'METHOD_NOT_SUPPORTED';

  // Line 124 — literal assertion
  -  expect(someErr.code).toBe('NOT_IMPLEMENTED');
  +  expect(someErr.code).toBe('METHOD_NOT_SUPPORTED');
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed on disk — `router.test.ts:29` checks `err.code === 'NOT_IMPLEMENTED'` and `:124` asserts the same literal, while `trpc.ts:43` throws `code: 'METHOD_NOT_SUPPORTED'`; the suite is currently broken on main and the two-line fix restores it.

---

### A2. Remove `@deprecated IWarnLogger` alias from `jsonParser.ts` and update the test import
- **Summary:** A `@deprecated` bridge alias `IWarnLogger` in `jsonParser.ts` is dead production code; the only consumer is `jsonParser.test.ts`, which can be updated to import `ILogger` directly from `./types`.
- **Source-Sprint:** SPRINT-007
- **Rationale:** TASK-574 deleted the original `IWarnLogger` interface from the production surface but left a `@deprecated` re-export alias in `jsonParser.ts:14-15` because the test file was in `files_readonly`. The alias is now the only reference that keeps a stale name alive. Three occurrences of `IWarnLogger` in the test can be replaced with `Pick<ILogger, 'warn'>` (already structurally equivalent — no runtime change). Deleting the alias removes the deprecation notice and the dead export.
- **Blast radius:** `main/src/services/streamParser/jsonParser.ts:14-15`, `main/src/services/streamParser/__tests__/jsonParser.test.ts:11,17,28,98`. Risk: trivial (types only, no logic change).
- **Source:** FIND-SPRINT-007-2 (surfaced by TASK-574 code-reviewer).
- **Proposed change:**
  ```diff
  // main/src/services/streamParser/jsonParser.ts

  // Remove lines 14-15:
  -/** @deprecated Use ILogger from './types' instead. */
  -export type IWarnLogger = Pick<ILogger, 'warn'>;

  // ---

  // main/src/services/streamParser/__tests__/jsonParser.test.ts

  // Line 11 — update import:
  -import type { IWarnLogger } from '../jsonParser';
  +import type { ILogger } from '../types';

  // Lines 17, 28, 98 — replace IWarnLogger annotation with Pick<ILogger, 'warn'>:
  // e.g.  (IWarnLogger & { ... })  →  (Pick<ILogger, 'warn'> & { ... })
  // Exact substitution: s/IWarnLogger/Pick<ILogger, 'warn'>/g in the three type positions
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms `IWarnLogger` is referenced only at its `@deprecated` declaration in `jsonParser.ts:15` and the four test sites in `jsonParser.test.ts` (11, 17, 28, 98) — no production consumer, so dropping the bridge alias is a pure type-rename with zero blast radius.

---

### A3. Add `validatePanelExists` guard to the `panels:get-json-messages` IPC handler
- **Summary:** The `panels:get-json-messages` handler is the only panel-keyed IPC in `session.ts` that accepts a `panelId` without first validating the panel exists, unlike every neighbouring handler.
- **Source-Sprint:** SPRINT-007
- **Rationale:** FIND-SPRINT-007-3 confirmed this is a pre-existing inconsistency. Handlers `panels:get-output` (line 884), `panels:send-input` (line 994), and `panels:stop-claude` all call `validatePanelExists` as a first guard. `panels:get-json-messages` (line 929) skips it, so an invalid panelId passes through to `sessionManager.getPanelOutputs`. The pattern is identical across neighbouring handlers — the fix is a three-line insertion.
- **Blast radius:** `main/src/ipc/session.ts:929-947` (the `panels:get-json-messages` handler body). Risk: low (defensive guard only; valid callers are unaffected).
- **Source:** FIND-SPRINT-007-3 (surfaced by TASK-568 code-reviewer).
- **Proposed change:**
  ```diff
  // main/src/ipc/session.ts — inside the panels:get-json-messages handler try block

   ipcMain.handle('panels:get-json-messages', async (_event, panelId: string) => {
     try {
       console.log(`[IPC] panels:get-json-messages called for panel: ${panelId}`);

  +    const panelValidation = validatePanelExists(panelId);
  +    if (!panelValidation.valid) {
  +      logValidationFailure('panels:get-json-messages', panelValidation);
  +      return createValidationError(panelValidation);
  +    }
  +
       if (!sessionManager.getPanelOutputs) {
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `session.ts:884` (`panels:get-output`) and `:994` (`panels:send-input`) both call `validatePanelExists` first, while `:929` (`panels:get-json-messages`) skips it — a three-line insertion restores the consistent neighbour pattern with no behaviour change for valid callers.

---

### A4. Fix `setSharedDb` setter signature to accept `null` (or add `clearSharedDb` helper)
- **Summary:** `ClaudeCodeManager.setSharedDb()` accepts only non-null `Database.Database` but the static field is `| null`, forcing the test's `afterEach` reset to use a `null as unknown as Database.Database` cast that lies to TypeScript.
- **Source-Sprint:** SPRINT-007
- **Rationale:** FIND-SPRINT-007-8 identified this as a compile-time lie: the setter signature and the field type disagree, so the test has to bypass type-checking to reset state. The simplest fix is to widen the setter to accept `null`. An alternative is a dedicated `clearSharedDb()` method — either eliminates the cast.
- **Blast radius:** `main/src/services/panels/claude/claudeCodeManager.ts:74`, `main/src/services/__tests__/claudeCodeManagerWiring.test.ts:184`. Risk: trivial (no behavior change, type-only fix).
- **Source:** FIND-SPRINT-007-8 (surfaced by TASK-572 code-reviewer).
- **Proposed change (option a — widen setter):**
  ```diff
  // main/src/services/panels/claude/claudeCodeManager.ts:74
  -  static setSharedDb(db: Database.Database): void {
  +  static setSharedDb(db: Database.Database | null): void {

  // main/src/services/__tests__/claudeCodeManagerWiring.test.ts:184
  -    ClaudeCodeManager.setSharedDb(null as unknown as Database.Database);
  +    ClaudeCodeManager.setSharedDb(null);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed: `claudeCodeManager.ts:68` declares `sharedDb: Database.Database | null` but `:74`'s setter signature is `db: Database.Database`, forcing two `null as unknown as Database.Database` casts in `claudeCodeManagerWiring.test.ts:184,279` — widening the setter eliminates the type lie at zero behavioural cost.

---

### A5. Fix `schemas.ts` module JSDoc — `_typeCheck` is module-local, not an export
- **Summary:** The top-of-module JSDoc in `schemas.ts` incorrectly describes `_typeCheck` as an export; it is a module-local `const` used only for a compile-time assignability check.
- **Source-Sprint:** SPRINT-007
- **Rationale:** FIND-SPRINT-007-10 notes that a reader skimming the module header gets a false impression of the public surface. The fix is a one-line wording change. The actual export is only `claudeStreamEventSchema`.
- **Blast radius:** `main/src/services/streamParser/schemas.ts:6-10` (JSDoc comment only). Risk: trivial.
- **Source:** FIND-SPRINT-007-10 (surfaced by TASK-575 code-reviewer).
- **Proposed change:**
  ```diff
  // main/src/services/streamParser/schemas.ts:6-10
  - * This module exports:
  - *   - `claudeStreamEventSchema` — the Zod schema that defines the full wire-event
  - *     union. Use `.safeParse()` only through the narrower below.
  - *   - `_typeCheck` — compile-time TS↔Zod drift bridge that fails to compile if the
  - *     schema output drifts from the `ClaudeStreamEvent` type.
  + * This module exports:
  + *   - `claudeStreamEventSchema` — the Zod schema that defines the full wire-event
  + *     union. Use `.safeParse()` only through the narrower below.
  + *
  + * Compile-time check (module-local, not exported):
  + *   - `_typeCheck` — TS↔Zod drift bridge that fails to compile if the schema output
  + *     drifts from the `ClaudeStreamEvent` type.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed: `schemas.ts:6-10` says "This module exports: ... `_typeCheck`" but `_typeCheck` is a module-local `const` (not exported) — a documentation-only wording fix with no risk and no broader implications.

---

### A6. Rewrite the misleading `try/catch` comment in `claudeCodeManager.ts` around `assertTransitionAllowed`
- **Summary:** The comment inside the `detector.on('complete')` try/catch claims it is guarding against "no workflow_runs row exists yet," which misrepresents what `assertTransitionAllowed` actually checks — it is a pure literal-table lookup, not a DB query.
- **Source-Sprint:** SPRINT-007
- **Rationale:** FIND-SPRINT-007-12 identified a cross-task pattern: TASK-572 and TASK-573 both wrapped `assertTransitionAllowed` calls in try/catch with a comment suggesting the function might fail because no DB row exists. It cannot — it only throws if the `(from, to)` pair is absent from `ALLOWED_TRANSITIONS`. Since `('running', 'completed')` is a valid pair, the call is unreachable-throw in production. The catch is effectively dead. Rewriting the comment to accurately describe what is being checked prevents future contributors from concluding there is a live DB guard here when there is not. This is a documentation-only change; no logic is altered.
- **Blast radius:** `main/src/services/panels/claude/claudeCodeManager.ts:335-343` (comment edit only). Risk: trivial.
- **Source:** FIND-SPRINT-007-12 (surfaced by SPRINT-007 sprint-code-reviewer; suspected TASK-572, TASK-573).
- **Proposed change:**
  ```diff
  // main/src/services/panels/claude/claudeCodeManager.ts:334-343

     detector.on('complete', (payload: CompletionPayload) => {
  -    // Pre-flight: verify the 'running -> completed' transition is legal before cleanup.
  -    // Fail-soft: no workflow_runs row exists yet (panelId placeholder), so we catch any error.
  +    // Compile-time legality check: assertTransitionAllowed is a pure lookup in
  +    // ALLOWED_TRANSITIONS and does NOT query the DB.  With hardcoded literal args
  +    // ('running' → 'completed' is a valid pair), this call never throws in practice.
  +    // The try/catch is retained as a belt-and-suspenders guard against future
  +    // refactors that change the literals; it is not a row-existence guard.
       try {
         assertTransitionAllowed('running', 'completed', payload.runId);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `claudeCodeManager.ts:336` — the comment claims "no workflow_runs row exists yet" is why the catch exists, but `assertTransitionAllowed` is a pure literal-table lookup with hardcoded `'running' → 'completed'` args, so the catch is unreachable in practice; rewriting prevents future contributors from chasing a phantom DB guard.

---

### A7. Add cross-reference JSDoc comments linking the parallel read/write event paths
- **Summary:** The parallel write-path (claudeCodeManager pipeline → raw_events) and read-path (projectStoredOutputs → session_outputs) are intentionally co-existing until a Day-3 renderer migration, but neither code site documents the other, leaving a seam invisible to future contributors.
- **Source-Sprint:** SPRINT-007
- **Rationale:** FIND-SPRINT-007-14 identified that both `projectStoredOutputs` in `session.ts:24-30` and `parseCliOutput` in `claudeCodeManager.ts:206-212` run parallel paths that will eventually be consolidated. A contributor who touches only one path has no hint the other exists or what the planned cutover looks like. Two JSDoc additions — one in each file — convert the implicit cross-task dependency into an explicit, discoverable note.
- **Blast radius:** `main/src/ipc/session.ts:24-31` (JSDoc), `main/src/services/panels/claude/claudeCodeManager.ts:206-208` (comment). Risk: trivial (docs only).
- **Source:** FIND-SPRINT-007-14 (surfaced by SPRINT-007 sprint-code-reviewer; suspected TASK-568, TASK-572).
- **Proposed change:**
  ```diff
  // main/src/ipc/session.ts — projectStoredOutputs JSDoc (around line 24)
   /**
    * Project an ordered array of raw stored outputs into UnifiedMessage[].
  + *
  + * NOTE — legacy read path: this helper reads from session_outputs (written by the
  + * inline JSON-emit branch in claudeCodeManager.parseCliOutput).  The parallel
  + * pipeline (ClaudeStreamParser → EventRouter → RawEventsSink → raw_events table,
  + * also wired in claudeCodeManager) is the intended long-term read source once the
  + * renderer migrates from panels:get-json-messages to the EventRouter/tRPC path
  + * (Day-3 cutover — TBD task ID).  Do NOT merge these paths until that migration lands.
    */

  // main/src/services/panels/claude/claudeCodeManager.ts — parseCliOutput pipeline block (lines 206-208)
  -    // Feed the raw line through the pipeline parser (non-destructive: also feeds EventRouter/RawEventsSink).
  -    // The existing emit-as-json path below is preserved in parallel until Day-3 migrates the
  -    // renderer to consume from EventRouter via tRPC.
  +    // Feed the raw line through the pipeline parser (non-destructive: also feeds EventRouter/RawEventsSink).
  +    // The emit-as-json path below is preserved in parallel until Day-3 migrates the
  +    // renderer to consume from EventRouter via tRPC (see projectStoredOutputs in
  +    // main/src/ipc/session.ts, which is the current read-path consumer of session_outputs).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed the parallel paths exist (`session.ts:32-78` `projectStoredOutputs` reads from `session_outputs`; `claudeCodeManager.ts:206-212` writes the inline JSON branch alongside the pipeline) — pure doc additions that make the implicit Day-3 cutover seam explicit at near-zero cost.

---

### A8. Add `@cyboflow-hidden` annotation to `tryTransitionToAwaitingReview` in `claudeCodeManager.ts`
- **Summary:** The private method `tryTransitionToAwaitingReview` is intentionally unwired in v1 (a Day-3 integration point) but lacks the `@cyboflow-hidden` annotation that would flag it to future prune tooling.
- **Source-Sprint:** SPRINT-007
- **Rationale:** FIND-SPRINT-007-9 identified that this method exists solely to satisfy AC#4's grep gate and will only be called once `workflow_runs` rows are auto-created on Claude spawn. Without the `@cyboflow-hidden` marker, a future cleanup pass or a `soloflow-dev:prune` scan would see a private method with zero in-class callers and could delete it as dead code. The annotation costs one comment line and protects the forward-looking integration point. (The broader CODE-PATTERNS.md update for forward-looking placeholders is tracked separately in C1.)
- **Blast radius:** `main/src/services/panels/claude/claudeCodeManager.ts:367` (one comment insertion). Risk: trivial.
- **Source:** FIND-SPRINT-007-9 (surfaced by TASK-572 code-reviewer).
- **Proposed change:**
  ```diff
  // main/src/services/panels/claude/claudeCodeManager.ts — above tryTransitionToAwaitingReview (~line 367)

  +  // @cyboflow-hidden: Day-3 integration point — no workflow_runs rows exist yet in v1.
  +  // Re-enable by routing from ApprovalRouter.recordToolRequest() → tryTransitionToAwaitingReview()
  +  // once workflow_runs rows are auto-created on Claude spawn (TASK-302 territory).
   /**
    * Attempt to record a tool-use approval request for a running Claude process.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed via grep: `tryTransitionToAwaitingReview` has zero in-class callers (only the declaration at `claudeCodeManager.ts:379`), satisfies only an AC#4 grep gate, and is a real prune-tool footgun without the marker; the C1/C2 doc updates in this same proposal also broaden the convention to cover this forward-looking case.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Replace static `sharedDb` injector in `ClaudeCodeManager` with constructor DI
- **Summary:** `ClaudeCodeManager.sharedDb` is a static singleton injector chosen as a fallback to avoid constructor surface changes; replacing it with a constructor `db` parameter would align with the rest of the codebase's dependency-injection pattern and eliminate the silent-degradation no-op risk.
- **Source-Sprint:** SPRINT-007
- **Source:** FIND-SPRINT-007-7 (surfaced by TASK-572 verifier).
- **Problem:** The static pattern was authorized by the TASK-572 plan as an intentional fallback, but carries known downsides documented at `claudeCodeManager.ts:68-76`: (a) cross-instance state leak in tests requires explicit `afterEach` reset; (b) the `null` branch silently degrades `RawEventsSink` to a no-op, which could hide a wiring regression if `setSharedDb` is not called on a future entry path; (c) it diverges from the constructor-DI pattern used by other services in `main/src/services/`. The static approach was chosen to avoid disturbing the single caller of the constructor, which is `claudePanelManager.ts:39`, and to avoid ripple through the `AbstractAIPanelManager` / `BaseAIPanelHandler` inheritance chain (both collapse candidates per CLAUDE.md).
- **Proposed direction:** Once `AbstractAIPanelManager` / `BaseAIPanelHandler` are collapsed (already a standing cleanup candidate per CLAUDE.md), thread a `db: Database.Database` parameter through the `ClaudeCodeManager` constructor and remove `setSharedDb` / `sharedDb`. The single instantiation site is `claudePanelManager.ts:39` — the DatabaseService handle is available there at construction time. The `claudePanel.ts:260` call site that currently calls `setSharedDb` post-initialization would be replaced by passing `db` directly to the constructor. An integration test should assert that a missing `db` argument is an explicit error (not a silent no-op). Relevant files: `main/src/services/panels/claude/claudeCodeManager.ts:68-88`, `main/src/services/panels/claude/claudePanelManager.ts:39`, `main/src/ipc/claudePanel.ts:260`, `main/src/services/__tests__/claudeCodeManagerWiring.test.ts`.
- **Scope:** small (contingent on AbstractAIPanelManager collapse being done first or in the same task).

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed both downsides are real (`claudeCodeManager.ts:309-310` silently degrades RawEventsSink to null when `sharedDb` is unset; `claudePanel.ts:260` is the lone production caller, and `AbstractAIPanelManager`/`BaseAIPanelHandler` are still in place per CLAUDE.md:21), so sequencing this as a backlog task gated on the collapse is correctly framed — refine, do not execute now.
- **Counterfactual:** If the AbstractAIPanelManager collapse never lands, downgrade to a smaller "explicit-error-on-missing-db" hardening that does not require constructor surgery.

---

### B2. Resolve the divergent `sessions:get-json-messages` handler — migrate or delete
- **Summary:** The legacy `sessions:get-json-messages` IPC handler uses raw stream-json spreading while the newer `panels:get-json-messages` uses `projectStoredOutputs()`, creating two handlers with different payload shapes; the session-keyed one has no UI caller and is a dormant regression risk.
- **Source-Sprint:** SPRINT-007
- **Source:** FIND-SPRINT-007-11 (surfaced by SPRINT-007 sprint-code-reviewer; suspected TASK-568).
- **Problem:** TASK-568 wired `projectStoredOutputs()` into `panels:get-json-messages` (`main/src/ipc/session.ts:929`) and exposed it on `window.electronAPI.panels.getJsonMessages`. The parallel `sessions:get-json-messages` handler at `main/src/ipc/session.ts:1236` still does a legacy raw spread (`{...jsonData, timestamp}` at lines 1300-1305) and is exposed on `window.electronAPI.sessions.getJsonMessages` via `main/src/preload.ts:209`. The frontend entry point `frontend/src/utils/api.ts:89` exists but has no component caller. If any future caller is added to the session-keyed path, the FIND-SPRINT-005-9 `.some`-of-undefined crash returns because the payload lacks `.segments`. The two handlers now diverge and the session-keyed one is unguarded.
- **Proposed direction:** Audit callers: confirm `sessions.getJsonMessages` has no renderer consumer. If confirmed, delete the `sessions:get-json-messages` handler in `session.ts`, the `sessions.getJsonMessages` preload binding in `preload.ts:209`, and the `api.ts:89` frontend binding — this removes the footgun entirely (option b per FIND-SPRINT-007-11). If an active caller is discovered, migrate the handler to call `projectStoredOutputs()` on the panel branch (lines 1245-1248). Single small commit either way. Files: `main/src/ipc/session.ts:1236-1310`, `main/src/preload.ts:209`, `frontend/src/utils/api.ts:89`.
- **Scope:** small.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Grep confirms the divergence is real (`session.ts:1300-1305` does the legacy `{...jsonData, timestamp}` spread, while `:929` runs `projectStoredOutputs`) and no renderer caller consumes `window.electronAPI.sessions.getJsonMessages` (`api.ts:89` is the only binding) — the FIND-SPRINT-005-9 `.some`-of-undefined regression returning if a future caller is added is a concrete dormant footgun that delete-or-migrate eliminates in one small commit.

---

### B3. Add `processLine(line: string)` entry point to `ClaudeStreamParser` to eliminate double line-buffering
- **Summary:** The current pipeline wiring causes every Claude SDK output line to traverse two `LineBufferer` instances — one in `AbstractCliManager` and one inside `ClaudeStreamParser.feed()` — which is redundant and wastes one buffer allocation per event.
- **Source-Sprint:** SPRINT-007
- **Source:** FIND-SPRINT-007-13 (surfaced by SPRINT-007 sprint-code-reviewer; suspected TASK-572).
- **Problem:** `AbstractCliManager.setupProcessHandlers` already splits PTY data on newlines and calls `parseCliOutput(line + '\n', panelId, sessionId)` once per complete line (`main/src/services/panels/cli/AbstractCliManager.ts:658-672`). `claudeCodeManager.ts:211` then calls `pipeline.parser.feed(data)`, which feeds the already-split line into `ClaudeStreamParser.feed()` which runs it through its own `LineBufferer` again (`streamParser.ts:47-49`). The inner `LineBufferer` sees one complete line + empty trailing segment, processes correctly, retains nothing — so the result is correct — but the double allocation is unnecessary. `ClaudeStreamParser.processLines` is already private and takes `string[]`.
- **Proposed direction:** Add a `processLine(line: string): void` method to `ClaudeStreamParser` (`main/src/services/streamParser/streamParser.ts`) that calls `this.processLines([line])` directly, bypassing `LineBufferer`. Update `claudeCodeManager.ts:211` to call `pipeline.parser.processLine(data)` instead of `pipeline.parser.feed(data)`. Keep `feed(chunk: string)` as the raw-chunk entry point for callers that consume un-split streams. Add a unit test confirming `processLine` dispatches without double-buffering. No behavior change.
- **Scope:** small.

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed double-buffering at `AbstractCliManager.ts:660-676` (already splits on `\n`) and `streamParser.ts:47-49` (re-buffers via `LineBufferer`), but the proposal explicitly admits "Functionally correct" — this is a one-buffer-allocation-per-line micro-optimization promoted to a backlog task on a single sprint's review, fails the proportionality bar against the cost of a new public method + test + caller migration.
- **Counterfactual:** If profiling under load showed the inner `LineBufferer` allocation as a hot path, this would clear the bar.

---

### B4. Add a spy logger to `claudeCodeManagerWiring.test.ts` and cover the ILogger wire from manager to pipeline
- **Summary:** The wiring test instantiates `ClaudeCodeManager` with `undefined` for the logger, leaving the `logger?.warn()` branches added by TASK-572 in the manager and its pipeline classes entirely uncovered by the test suite.
- **Source-Sprint:** SPRINT-007
- **Source:** FIND-SPRINT-007-15 (surfaced by SPRINT-007 sprint-code-reviewer; suspected TASK-572, TASK-574).
- **Problem:** `main/src/services/__tests__/claudeCodeManagerWiring.test.ts:176` passes `undefined` as the second constructor argument (logger). As a result, the `logger?.warn(...)` and `logger?.info?.()` paths in `claudeCodeManager.ts:311-312, 340-342, 374-376` — wired by TASK-572 to propagate to the underlying pipeline classes — are never exercised. A mis-wiring (e.g., passing a non-ILogger object) would not be caught. `jsonParser.test.ts` already has a `makeLoggerSpy` factory that creates a conforming spy; the same approach can be reused here.
- **Proposed direction:** Introduce a `makeLoggerSpy()` helper in `claudeCodeManagerWiring.test.ts` (or import from the streamParser test utilities if factored out) that returns a `vitest` spy object conforming to `ILogger`. Pass it as the second constructor arg. Add at least one assertion that the logger's `warn` method is called when the `complete` handler fires on a state-machine violation — this covers the TASK-572 wire path from `ClaudeCodeManager` through to the underlying `ILogger` surface. Reference pattern: `main/src/services/streamParser/__tests__/jsonParser.test.ts` (makeLoggerSpy).
- **Scope:** small.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed at `claudeCodeManagerWiring.test.ts:176` the manager is instantiated with `undefined` for the logger arg, so the `logger?.warn(...)` paths added by TASK-572 at `claudeCodeManager.ts:340-342, 385-387` are exercised nowhere; the `makeLoggerSpy` pattern from `jsonParser.test.ts:17` is a ready-to-reuse precedent, so the test-coverage gap closes cheaply.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Broaden the root CLAUDE.md `@cyboflow-hidden` description to cover forward-looking placeholders
- **Summary:** Update the one-line `@cyboflow-hidden` rule in the root CLAUDE.md so it no longer restricts the marker to Crystal-preserved code, matching the expanded template in `docs/CODE-PATTERNS.md`.
- **Source-Sprint:** SPRINT-007
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/CLAUDE.md`
- **Action:** edit-line CLAUDE.md:17
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  // CLAUDE.md — line 17 (single-paragraph rule)
  -Code that is intentionally unreachable in cyboflow v1 (but preserved from the Crystal baseline for future re-enablement) is marked with `@cyboflow-hidden`. Do NOT delete such code; do NOT add the marker to actively-called code. See `docs/CODE-PATTERNS.md` for the annotation template and canonical examples (`main/src/services/worktreeManager.ts:472`, `frontend/src/components/SessionView.tsx:14`).
  +Code that is intentionally unreachable in cyboflow v1 is marked with `@cyboflow-hidden` — either Crystal-baseline code preserved for future re-enablement OR a forward-looking placeholder awaiting a later integration task. Do NOT delete such code; do NOT add the marker to actively-called code. See `docs/CODE-PATTERNS.md` for the annotation template and canonical examples in both categories.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `CLAUDE.md:17` currently restricts the marker to "preserved from the Crystal baseline," but TASK-572 just produced a forward-looking placeholder (`tryTransitionToAwaitingReview`) that the existing rule excludes — broadening the one-line description matches the real second category that has now materialised, paired with C2 for the template details.

---

### C2. Expand the `@cyboflow-hidden` template in CODE-PATTERNS.md to cover forward-looking placeholders
- **Summary:** The CODE-PATTERNS.md template currently scopes `@cyboflow-hidden` to "preserved-but-disconnected code"; widen it to also cover fresh-cyboflow code intentionally unwired until a later sprint (e.g. `tryTransitionToAwaitingReview` from TASK-572).
- **Source-Sprint:** SPRINT-007
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/docs/CODE-PATTERNS.md`
- **Action:** edit `@cyboflow-hidden annotation` section
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  // docs/CODE-PATTERNS.md — `@cyboflow-hidden annotation` section

   ### `@cyboflow-hidden` annotation

  -Mark preserved-but-disconnected code (kept for future re-enablement) at the top of the file
  -(whole-component case) or immediately above the first function of the disconnected group
  -(partial-file case). Always include a one-sentence re-enable hint pointing at the call site
  -to restore.
  +Mark intentionally-unreachable code at the top of the file (whole-component case) or
  +immediately above the first function of the disconnected group (partial-file case).
  +Always include a one-sentence re-enable hint pointing at the call site (or upstream
  +caller / epic for forward-looking placeholders) to restore.
  +
  +Two valid categories:
  +1. **Crystal-preserved** — code kept from the `stravu/crystal` baseline, disabled in v1.
  +2. **Forward-looking placeholder** — fresh cyboflow code unwired until a later sprint's
  +   integration task lands (e.g. satisfies a grep gate for a Day-N epic).

   ```
   // @cyboflow-hidden: <what is unreachable> in cyboflow v1.
   // Re-enable by <restoring specific call site or JSX usage>.
   ```

  -- **Canonical examples:** `main/src/services/worktreeManager.ts:472` (method-group),
  -  `frontend/src/components/SessionView.tsx:14` (import-line)
  +- **Canonical examples (Crystal-preserved):** `main/src/services/worktreeManager.ts:472`
  +  (method-group), `frontend/src/components/SessionView.tsx:14` (import-line)
  +- **Canonical example (forward-looking placeholder):**
  +  `main/src/services/panels/claude/claudeCodeManager.ts` — `tryTransitionToAwaitingReview`
  +  (Day-3 ApprovalRouter integration point)
   - **Audit tool:** `grep -rn '@cyboflow-hidden' main/src frontend/src` lists all
  -  preserved-but-inactive surfaces.
  +  inactive surfaces (both categories).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `docs/CODE-PATTERNS.md:107-122` currently only documents the Crystal-preserved category; the proposed split (two named categories + a forward-looking canonical example pointing at `tryTransitionToAwaitingReview`) matches the change in C1 and the real example in A8, giving future agents a discoverable home for the second pattern.
