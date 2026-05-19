---
sprints: ["SPRINT-022"]
span_label: SPRINT-022
created: "2026-05-19T22:55:00.000Z"
counters_start:
  ideas: 18
summary:
  cleanups: 4
  backlog_tasks: 2
  claude_md: 0
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-022

## A. Clean-up items (execute now)

### A1. Replace stale `:158` line-number cross-references with stable code anchors
- **Summary:** Two comments in `runEventBridge.ts` and `runExecutor.ts` cite the bridge filter as `:158`, but after TASK-664 added ~25 lines above it the guard now lives at line 185 — future readers grepping the cited number will land on unrelated code.
- **Source-Sprint:** SPRINT-022
- **Rationale:** The references became stale within the same sprint that wrote them (TASK-663 wrote the comments; TASK-664 shifted the filter site). The fix is a trivial text swap to a stable function-name anchor that cannot drift.
- **Blast radius:** Two files (`main/src/orchestrator/runEventBridge.ts:12`, `main/src/orchestrator/runExecutor.ts:180`), comment-only edits, risk: trivial.
- **Source:** FIND-SPRINT-022-1; confirmed by `grep "bridge filter at.*:158"` returning hits at `runEventBridge.ts:12` and `runExecutor.ts:180` while the actual `p.panelId !== runId` guard now sits at `runEventBridge.ts:185`.
- **Proposed change:**
  ```diff
  # runEventBridge.ts:12  (inside the module-level JSDoc block)
  -   RunExecutor.execute() passes panelId = runId (no prefix), and the bridge filter at :158
  +   RunExecutor.execute() passes panelId = runId (no prefix), and the `p.panelId !== runId` guard

  # runExecutor.ts:180  (inline invariant comment)
  -   // The bridge filter at runEventBridge.ts:158 keys on raw runId; ApprovalRouter's
  +   // The `p.panelId !== runId` guard in bridgeEvents() keys on raw runId; ApprovalRouter's
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms both `:158` references still exist at `runEventBridge.ts:12` and `runExecutor.ts:180` while the actual `p.panelId !== runId` guard now lives at `runEventBridge.ts:185`, so the stale anchors will mislead any future reader who greps the cited line.

---

### A2. Fix stale "synthesis" describe label and JSDoc surviving the TASK-663 invariant rename
- **Summary:** A `describe` label in `runExecutor.test.ts` and a `@param` JSDoc in `runExecutor.ts` still describe `panelId` as "synthetic/synthesized", contradicting the TASK-663 invariant that explicitly removed that derivation.
- **Source-Sprint:** SPRINT-022
- **Rationale:** The stale terminology reverses the conceptual intent of TASK-663: readers see "synthetic" and infer panelId is still derived, which is exactly what the sprint fixed. TASK-663's code-reviewer flagged both in round 2 but the task ran out of retry budget.
- **Blast radius:** Two files (`main/src/orchestrator/__tests__/runExecutor.test.ts:172`, `main/src/orchestrator/runExecutor.ts:315-316`), comment/label-only edits, risk: trivial.
- **Source:** FIND-SPRINT-022-2; confirmed by `grep "panelId/sessionId synthesis"` hitting `runExecutor.test.ts:172` and inspection of `runExecutor.ts:315-316` showing the old `@param _panelId The synthetic panel ID` wording.
- **Proposed change:**
  ```diff
  # runExecutor.test.ts:172
  -describe('RunExecutor.execute — happy path (panelId/sessionId synthesis)', () => {
  +describe('RunExecutor.execute — happy path (panelId/sessionId alignment)', () => {

  # runExecutor.ts:315-316  (JSDoc on bridgeEvents())
  - * @param _panelId The synthetic panel ID used by ClaudeCodeManager (unused
  - *                 by the bridge which uses runId directly).
  + * @param _panelId The panel ID (per invariant, equals runId; unused by the bridge
  + *                 which keys directly on runId).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep finds `synthetic`/`synthesis` survivors at `runExecutor.ts:315` (JSDoc) and `runExecutor.test.ts:172` (describe label), directly contradicting the TASK-663 invariant that explicitly removed the panelId derivation; reviewer round 2 already flagged these and ran out of retry budget.

---

### A3. Add cross-pointer comments between the two dual-pipeline single-INSERT assertion tests
- **Summary:** `runEventBridge.test.ts` and `runExecutor.test.ts` independently assert the same `countRows === 1` invariant through parallel pipelines with no comment linking them, so a future change to the invariant will not obviously require updating both.
- **Source-Sprint:** SPRINT-022
- **Rationale:** FIND-SPRINT-022-4 notes both tests have value (one tests the `bridgeEvents()` option contract in isolation; one drives the full `RunExecutor.execute()` pipeline) but the shared load-bearing assertion needs a cross-pointer so maintainers know to update both in lock-step. This is a comment-only insertion — zero behavioral risk.
- **Blast radius:** Two test files (`main/src/orchestrator/__tests__/runEventBridge.test.ts` ~line 686, `main/src/orchestrator/__tests__/runExecutor.test.ts` ~line 715`), comment-only, risk: trivial.
- **Source:** FIND-SPRINT-022-4; TASK-663 added the runExecutor-side test; TASK-664 added the runEventBridge-side test; per-task reviewers each saw only their own slice.
- **Proposed change:**
  ```diff
  # runEventBridge.test.ts — inside the "dual-pipeline single-INSERT guarantee" describe block, before the test body
  + // Sibling: runExecutor.test.ts "source arg: lifecycleTransitions.running()..." exercises the same
  + // countRows === 1 guarantee through the full RunExecutor pipeline. This test isolates the
  + // bridgeEvents() skipPersistence option contract. If this invariant changes, update both.

  # runExecutor.test.ts — inside the corresponding "source arg: lifecycleTransitions.running()" test, near the countRows assertion (~line 823)
  + // Sibling: runEventBridge.test.ts "dual-pipeline single-INSERT guarantee" tests this same invariant
  + // in isolation (bridgeEvents() only). Both must be updated together if the storage contract changes.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Both sibling assertions confirmed (`countRows(realDb, SP_RUN_ID).toBe(1)` at `runEventBridge.test.ts:727` and `rawRow.cnt.toBe(1)` at `runExecutor.test.ts:831`); comment-only insertion has near-zero cost and the asymmetric naming (`RAW_EVENTS_DDL` vs `RAW_EVENTS_DDL_EXEC`) actively masks the cross-file link from grep.

---

### A4. Replace protected-member bracket reach-back with outer-scope spawner reference
- **Summary:** The TASK-663 regression test at `runExecutor.test.ts:1281` accesses the protected `RunExecutor.spawner` field via bracket notation (`executor['spawner']`), which bypasses TypeScript's access modifier — every other test in the same file holds the spawner from the construction call site.
- **Source-Sprint:** SPRINT-022
- **Rationale:** The bracket-notation pattern effectively casts through `protected`, creates a maintenance inconsistency against lines 180-181 and 287 of the same file, and was flagged by the code-reviewer as a stylistic nit deferred only due to retry budget. The fix is a three-line hoist.
- **Blast radius:** One test file (`main/src/orchestrator/__tests__/runExecutor.test.ts` ~lines 1269-1282`), test-only edit, risk: trivial.
- **Source:** FIND-SPRINT-022-5; TASK-663 done report — "spawner reach-back stylistic nit. Out of retry budget."
- **Proposed change:**
  ```diff
  # runExecutor.test.ts — negative-path describe block (~line 1269)

  - // ...construct executor, then:
  - const spawner = executor['spawner'] as ClaudeSpawnerLike;
  - (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockImplementation(...)

  + // Hoist spawner before passing to constructor (matches convention at lines 180-181, 287):
  + const spawner = makeSpawner();
  + const executor = new TestableRunExecutor(spawner, registry, makeLogger(), publisher, db, source);
  + (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockImplementation(...)
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `executor['spawner'] as ClaudeSpawnerLike` at `runExecutor.test.ts:1281` reaches around the `protected readonly spawner` declared at `runExecutor.ts:129`, and the proposed hoist exactly matches the existing convention at `runExecutor.test.ts:180-181` and `:287`; test-only, single-file, trivial.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Extract shared raw_events test fixture from the two orchestrator test files
- **Summary:** `runExecutor.test.ts` and `runEventBridge.test.ts` each define a byte-identical `RAW_EVENTS_DDL` constant, an in-memory `Database` setup block, and a `countRows()` helper — extracting these into a shared fixture file eliminates the source-of-truth split before a third test copies either.
- **Source-Sprint:** SPRINT-022
- **Source:** FIND-SPRINT-022-3; TASK-663 added `RAW_EVENTS_DDL_EXEC` + inline setup at `runExecutor.test.ts:691-699,738-740,828-830,1307-1309`; TASK-664 added the identical `RAW_EVENTS_DDL` + `makeDb()` + `countRows()` at `runEventBridge.test.ts:32-40,100-113`.
- **Problem:** The `raw_events` schema DDL is now defined twice (`RAW_EVENTS_DDL` at `runEventBridge.test.ts:32` and `RAW_EVENTS_DDL_EXEC` at `runExecutor.test.ts:691` — byte-identical bodies). The `countRows()` function is defined once at `runEventBridge.test.ts:108-113` and inlined three times in `runExecutor.test.ts` (lines 828-830, 1307-1309). When the production migration (`006_cyboflow_schema.sql`) gains or drops a column, a maintainer will need to find and update all copies. Per-task reviewers each saw only their own file and neither could spot the cross-task duplication; the `runExecutor` copy is even named differently (`RAW_EVENTS_DDL_EXEC`) masking the match.
- **Proposed direction:** Create `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` exporting: (a) `RAW_EVENTS_DDL` — the canonical CREATE TABLE statement, kept in sync with `006_cyboflow_schema.sql`; (b) `makeRawEventsDb(): Database.Database` — `new Database(':memory:')` + `pragma('foreign_keys = OFF')` + `db.exec(RAW_EVENTS_DDL)`; (c) `countRows(db: Database.Database, runId: string): number` — the SELECT COUNT(*) helper. Then update `runEventBridge.test.ts` and `runExecutor.test.ts` to import from this fixture, removing their local definitions. The `__fixtures__` directory does not yet exist in the orchestrator test tree and will need to be created. Note: the fixtures module imports `better-sqlite3` (a native module); the existing `pnpm electron:rebuild` prerequisite documented in `CLAUDE.md` applies.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Duplication is real and confirmed — byte-identical DDL at `runEventBridge.test.ts:32` and `runExecutor.test.ts:691` (the latter renamed `RAW_EVENTS_DDL_EXEC` masking the match), with `countRows()` once at `runEventBridge.test.ts:108` and inlined at `runExecutor.test.ts:828` plus another COUNT(*) site, so a `006_cyboflow_schema.sql` schema change today requires multi-site updates; backlog refinement is the right scope, not now-execute.
- **Counterfactual:** If refinement reveals the helpers diverge in subtle ways (e.g. `foreign_keys` pragma differences between callers), drop to DONT_IMPLEMENT — premature consolidation of near-duplicates would hide real differences.

---

### B2. Make `BridgeEventsOptions.db` optional when `skipPersistence` is true
- **Summary:** `BridgeEventsOptions.db` is non-optional even though its value is explicitly unused when `skipPersistence === true`, forcing every test that wants skip-persistence behaviour to fabricate a stub or allocate a real `:memory:` database it never reads.
- **Source-Sprint:** SPRINT-022
- **Source:** FIND-SPRINT-022-6; TASK-664 added five new `skipPersistence` tests in `runEventBridge.test.ts`, each carrying a workaround (either a throwing-stub `db` or a real `:memory:` db allocated purely to satisfy the type).
- **Problem:** `runEventBridge.ts:44-45` declares `db: Database.Database` (required). The JSDoc comment at lines 72-74 explicitly says the value is unused when `skipPersistence === true` and that this is a back-compat holdover. Five new tests in `runEventBridge.test.ts` must either supply `{ prepare: () => { throw new Error('should not be called'); } } as unknown as Database.Database` (a casting hack) or allocate a real `:memory:` database they never read. A future caller wanting renderer-only event forwarding (e.g. a read-only viewer panel) will face the same allocation burden. This is an ergonomics issue, not a behavioral defect — but it will compound with each new skip-persistence caller.
- **Proposed direction:** In `main/src/orchestrator/runEventBridge.ts`: change line 45 to `db?: Database.Database;`; add an early runtime guard inside `bridgeEvents()` after destructuring — throw a descriptive error when `skipPersistence` is falsy and `db` is undefined (preserves the back-compat guarantee for production callers that always supply `db`); update the JSDoc on `db` to reflect the new conditional contract. In `runEventBridge.test.ts`: the five `skipPersistence` tests that currently fabricate a throwing-stub or unused `:memory:` db can drop the `db` field from their options objects entirely. Also audit whether `runExecutor.ts:bridgeEvents()` (which passes `skipPersistence: true`) can drop its own `db` pass-through — it currently passes `this.db` which is fine, but once `db` is optional the guard in the interface should document that callers must still supply it for non-skip cases.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `runEventBridge.ts:45` declares `db: Database.Database` as required while the JSDoc at `:72-74` openly admits the value is unused when `skipPersistence === true` and is only a back-compat holdover; the type signature contradicts the documented contract, and five new skipPersistence tests already carry workaround stubs to satisfy it.
- **Counterfactual:** If refinement uncovers a production caller (beyond `RunExecutor.bridgeEvents`) that depends on the current required typing, drop to DONT_IMPLEMENT — the back-compat surface may be wider than the JSDoc claims.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

_No items._

---

## Reconciled Findings (informational)

No stale-open / already-resolved drift detected. Neither TASK-663-done.md nor TASK-664-done.md contains a `**Findings resolved:**` line referencing any FIND-SPRINT-022-* ID. All six findings were correctly left `status: open` by the sprint closer and are triaged above.
