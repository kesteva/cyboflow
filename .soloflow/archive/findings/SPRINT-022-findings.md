---
sprint: SPRINT-022
pending_count: 6
last_updated: "2026-05-19T22:39:56.264Z"
---
# Findings Queue

## FIND-SPRINT-022-1
- **source:** SPRINT-022 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runEventBridge.ts:12,main/src/orchestrator/runExecutor.ts:180
- **description:** Stale line-number cross-references in JSDoc/inline comments across both touched files — both reference the bridge filter as runEventBridge.ts:158, but after the TASK-664 skipPersistence refactor the actual filter is at line 185. Specifically: (a) runEventBridge.ts:12 — JSDoc header: "the bridge filter at :158 keys on raw runId". (b) runExecutor.ts:180 — inline invariant comment: "The bridge filter at runEventBridge.ts:158 keys on raw runId". Both references became stale during the same sprint they describe, because TASK-664 added ~25 lines above the filter site after TASK-663 wrote the comments. Future readers grepping for the cited line will land on unrelated code.
- **suggested_action:** Replace line-number refs in doc comments with a stable anchor: either (a) the function name ("the panelId filter inside bridgeEvents() onOutput"), or (b) a code-search snippet ("the `p.panelId !== runId` guard"). Apply both at runEventBridge.ts:12 and runExecutor.ts:180. Optional: add a lint rule or pre-commit check that flags `.ts:\d+` patterns in JSDoc inside the orchestrator/ tree.
- **resolved_by:** 






Suspected tasks: TASK-663 (wrote both comments), TASK-664 (shifted the filter location without updating refs)

## FIND-SPRINT-022-2
- **source:** SPRINT-022 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runExecutor.ts:315-316,main/src/orchestrator/__tests__/runExecutor.test.ts:172
- **description:** Stale "synthetic" terminology surviving the TASK-663 invariant rename. TASK-663 aligned panelId === runId === sessionId and explicitly killed the synthesis abstraction, but two callouts still describe panelId as synthesized:
- **suggested_action:** (1) runExecutor.ts:315-316 — rewrite JSDoc to: "@param _panelId The panel ID (per invariant, equals runId; unused by the bridge which keys directly on runId).". (2) runExecutor.test.ts:172 — rename describe label to "RunExecutor.execute — happy path (panelId/sessionId alignment)" matching the test name at line 173.
- **resolved_by:** 





  - runExecutor.ts:315-316 JSDoc on bridgeEvents(): "@param _panelId The synthetic panel ID used by ClaudeCodeManager (unused by the bridge which uses runId directly)."
  - runExecutor.test.ts:172 describe label: "RunExecutor.execute — happy path (panelId/sessionId synthesis)"

No behavior bug, but it now reads as if panelId is still a derived/synthetic identifier when in fact the whole point of TASK-663 was to remove that derivation. Per-task reviewer flagged these in round 2 IMPROVEMENTS_NEEDED but TASK-663 ran out of retry budget.

Suspected tasks: TASK-663

## FIND-SPRINT-022-3
- **source:** SPRINT-022 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts:691-699,main/src/orchestrator/__tests__/runEventBridge.test.ts:32-40
- **description:** Duplicated test-fixture scaffolding across the two orchestrator test files introduced/touched by this sprint. Both tests now define their own copy of:
- **suggested_action:** Extract a shared test fixture at main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts (or similar) exporting: (a) `RAW_EVENTS_DDL` constant, (b) `makeRawEventsDb(): Database.Database` factory, (c) `countRows(db, runId): number` helper. Import from both runEventBridge.test.ts and runExecutor.test.ts. This is the canonical Vitest pattern for fixture sharing in this repo (see existing __fixtures__/ folders elsewhere) and keeps the schema source-of-single-truth one edit away when the real migration changes.
- **resolved_by:** 




  - `RAW_EVENTS_DDL` (identical CREATE TABLE for raw_events) — runExecutor.test.ts:691-699 and runEventBridge.test.ts:32-40. The runExecutor copy is named `RAW_EVENTS_DDL_EXEC` but is otherwise byte-identical.
  - An in-memory `Database(":memory:")` + `pragma("foreign_keys = OFF")` + `db.exec(DDL)` setup block (runExecutor.test.ts:738-740 and runEventBridge.test.ts:100-105).
  - A `countRows(db, runId)` style assertion. runEventBridge.test.ts has a real helper at :108-113; runExecutor.test.ts inlines the same SELECT COUNT(*) query at :828-830 and :1307-1309.

TASK-663 added the first inline copy; TASK-664 added the second. Per-task reviewers saw only their own slice and so neither could spot the cross-task duplication. Future orchestrator unit tests will copy whichever sibling file they grep for and the drift will compound.

Suspected tasks: TASK-663, TASK-664

## FIND-SPRINT-022-4
- **source:** SPRINT-022 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runEventBridge.test.ts:707-734,main/src/orchestrator/__tests__/runExecutor.test.ts:738-832
- **description:** Overlapping dual-pipeline single-INSERT assertion across the two test files. Both tests independently simulate ClaudeCodeManager.runSdkQuery's EventRouter + RawEventsSink pipeline and assert exactly one raw_events row is inserted when the bridge has skipPersistence: true:
- **suggested_action:** Keep both tests but make the relationship explicit: add a comment in each test pointing at the sibling and naming what aspect each covers. Suggested phrasing for the runEventBridge.test.ts copy: "// Sibling: runExecutor.test.ts 'source arg: lifecycleTransitions.running()' exercises the same guarantee through the full RunExecutor pipeline. This test isolates the bridgeEvents() option contract." Optional follow-up: if a third test in the orchestrator/__tests__/ tree ends up asserting the same cnt invariant, promote countRows + the CCM-pipeline simulation into the shared fixture proposed in FIND-SPRINT-022-3 to avoid 3-way drift.
- **resolved_by:** 



  - runEventBridge.test.ts "dual-pipeline single-INSERT guarantee" (~:686-734) — calls bridgeEvents() directly, manually emits via ccmRouter.emitForRun(), asserts countRows === 1.
  - runExecutor.test.ts "source arg: lifecycleTransitions.running() fires when source emits output event" (:715-832, especially the assertion block at :823-832) — drives the full RunExecutor.execute() path, wires a parallel listener on the source EventEmitter that mirrors CCM's narrow + emitForRun pipeline, asserts the same countRows === 1.

The runExecutor-side test is the stronger one because it exercises RunExecutor.bridgeEvents()'s actual skipPersistence wiring; the runEventBridge-side test only verifies the option itself. Both have value, but the assertion ("cnt === 1") is the same load-bearing guarantee, written twice. If the invariant changes shape (e.g. CCM owns persistence but bridge gets a per-event audit row), both tests need to be updated in lock-step.

Suspected tasks: TASK-663 (added the runExecutor-side integration test), TASK-664 (added the runEventBridge-side dual-pipeline test)

## FIND-SPRINT-022-5
- **source:** SPRINT-022 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts:1281
- **description:** Protected-modifier reach-back via bracket notation. The new TASK-663 regression test reaches into the executor instance to grab the spawner via bracket indexing:
- **suggested_action:** Replace the bracket-access pattern with the existing outer-scope pattern used elsewhere in this file. Concretely: hoist `const spawner = makeSpawner();` immediately above the `new TestableRunExecutor(...)` call (line 1269), pass that same `spawner` into the constructor, then reuse it on the mockImplementation line. This matches the convention at runExecutor.test.ts:180-181 and avoids casting through the protected modifier.
- **resolved_by:** 


    const spawner = executor['spawner'] as ClaudeSpawnerLike;

This only works because TypeScript treats bracket-indexed property access as effectively `any`/`unknown`, bypassing the `protected` modifier on RunExecutor.spawner. Every other test in this file that needs the spawner holds it from the outer scope at construction time (e.g. line 180-181, line 287). Per-task reviewer flagged as minor stylistic; TASK-663 deferred for retry budget.

Suspected tasks: TASK-663

## FIND-SPRINT-022-6
- **source:** SPRINT-022 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runEventBridge.ts:44-45,72-74
- **description:** BridgeEventsOptions.db API foot-gun introduced by skipPersistence. The interface keeps `db: Database.Database` as a non-optional field even though the JSDoc explicitly says its value is unused when `skipPersistence === true`:

  /** better-sqlite3 database handle used by RawEventsSink for inserts. */
  db: Database.Database;
  ...
  /* `db` remains required in the options type for back-compat; its value is
   * simply unused when skipPersistence === true. */

Production caller (RunExecutor.bridgeEvents) does pass a real db handle. But every test that wants skipPersistence behavior has to either fabricate a stub db (the runEventBridge.test.ts pattern: `prepare: () => throw ...`) or supply a real :memory: db it doesn't actually use. The 5 new skipPersistence tests in TASK-664 all carry one of these workarounds.

This is a minor API ergonomics issue, not a defect. It will compound the moment a third caller wants the bridge for renderer-only forwarding (e.g. a future read-only viewer panel) — they will have to allocate a sqlite handle they never use.

Suspected tasks: TASK-664
- **suggested_action:** Make `db` optional in BridgeEventsOptions and assert at runtime that `db` is present when `skipPersistence !== true`. Concretely: change line 45 to `db?: Database.Database;`, then in bridgeEvents() after destructuring add an early guard that throws when skipPersistence is falsy and db is missing. Update the JSDoc on `db` to reflect the new contract. Tests that currently fabricate a throwing-prepare stub can drop the stub entirely.
- **resolved_by:** 
