---
id: TASK-572
title: Wire orphan pipeline classes into production (umbrella)
status: in-flight
epic: wire-sprint-005-services
source: compound/SPRINT-004-005
source_sprint: SPRINT-005
depends_on:
  - TASK-568
  - TASK-573
  - TASK-574
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
files_readonly:
  - main/src/services/streamParser/streamParser.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/completionDetector.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/index.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/cyboflow/transitions.ts
  - main/src/services/cyboflow/stateMachine.ts
  - main/src/database/database.ts
  - shared/types/cyboflow.ts
  - .soloflow/active/plans/wire-sprint-005-services/EPIC-wire-sprint-005-services.md
acceptance_criteria:
  - criterion: "`ClaudeStreamParser` is instantiated in `claudeCodeManager.ts` and fed from the PTY data handler so every spawned Claude session has a live pipeline that parses stdout chunks into `ClaudeStreamEvent`s and dispatches them via `EventRouter`."
    verification: "grep -nE 'new ClaudeStreamParser|new EventRouter' main/src/services/panels/claude/claudeCodeManager.ts returns >= 2 matches; grep -nE '\\.feed\\(' main/src/services/panels/claude/claudeCodeManager.ts returns >= 1 match inside the onData / parseCliOutput callback path."
  - criterion: "`RawEventsSink` is attached to the EventRouter for each spawned run, persisting every event into the `raw_events` table."
    verification: "grep -nE 'new RawEventsSink|\\.attachToRouter\\(' main/src/services/panels/claude/claudeCodeManager.ts returns >= 1 match each."
  - criterion: "`CompletionDetector` is instantiated per run; `signalChildExited()` fires on PTY exit, `signalStdoutEof()` fires on stdout end, and `signalParserDrained()` fires after `parser.flush()` completes."
    verification: "grep -nE 'new CompletionDetector|signalChildExited\\(\\)|signalStdoutEof\\(\\)|signalParserDrained\\(\\)' main/src/services/panels/claude/claudeCodeManager.ts returns >= 4 matches across the spawn + onExit + drain paths."
  - criterion: End-to-end grep gate — every SPRINT-005 orphan class has at least one production callsite.
    verification: "Run `grep -rEn 'MessageProjection|CompletionDetector|RawEventsSink|assertTransitionAllowed|transitionToAwaitingReview|ClaudeStreamParser' main/src --include='*.ts' | grep -v __tests__ | grep -v 'streamParser/messageProjection.ts' | grep -v 'streamParser/completionDetector.ts' | grep -v 'streamParser/rawEventsSink.ts' | grep -v 'streamParser/streamParser.ts' | grep -v 'streamParser/index.ts' | grep -v 'cyboflow/stateMachine.ts' | grep -v 'cyboflow/transitions.ts'`. Result must include >= 1 hit for each of the 6 symbols: `MessageProjection`, `CompletionDetector`, `RawEventsSink`, `assertTransitionAllowed`, `transitionToAwaitingReview`, `ClaudeStreamParser`."
  - criterion: "The dependent child tasks have all landed: TASK-568 (B1 — MessageProjection in IPC), TASK-573 (B6 — assertTransitionAllowed in transitions.ts), TASK-574 (B7 — ILogger consolidation)."
    verification: "ls .soloflow/archive/done/wire-sprint-005-services/TASK-568-done.md .soloflow/archive/done/wire-sprint-005-services/TASK-573-done.md .soloflow/archive/done/wire-sprint-005-services/TASK-574-done.md returns 3 file paths with exit 0 (existence check). [If a child landed in a different epic folder, adjust the path accordingly.]"
  - criterion: "`pnpm typecheck` and `pnpm --filter main exec vitest run` pass."
    verification: Exit code 0 for both.
  - criterion: "A new session created via the UI produces rows in `raw_events` for each stream-json event from the Claude CLI; `select count(*) from raw_events where run_id = ?` is > 0 after a fresh session completes."
    verification: "Manual smoke: `pnpm dev`, create + run a session, then inspect the SQLite DB at `~/Library/Application Support/cyboflow/cyboflow.db` (macOS) with `sqlite3 cyboflow.db 'select event_type, count(*) from raw_events group by event_type;'` and confirm at least one row per active event_type."
estimated_complexity: high
test_strategy:
  needed: true
  justification: The new wiring threads through `claudeCodeManager.ts` (an actively-tested file with sibling test `main/src/services/__tests__/claudeCodeManagerPermissions.test.ts`). Wiring a parser+sink+detector into the spawn path can subtly break the existing permission-mode test by changing the constructor surface. A focused integration test of the wiring also locks the contract that future refactors must preserve.
  targets:
    - behavior: A spawn call instantiates ClaudeStreamParser+EventRouter+RawEventsSink+CompletionDetector and fed PTY data results in raw_events rows + UnifiedMessage emissions.
      test_file: main/src/services/__tests__/claudeCodeManagerWiring.test.ts
      type: integration
    - behavior: "The existing claudeCodeManagerPermissions.test.ts continues to assert that permissionMode='ignore' throws (no constructor-shape regression)."
      test_file: main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
      type: unit
prerequisites:
  - check: "grep -q 'better-sqlite3' main/package.json"
    fix: pnpm --filter main add better-sqlite3
    description: RawEventsSink requires better-sqlite3; this should already be declared but the umbrella wiring will fail at runtime if not.
    blocking: true
  - check: test -f main/src/database/migrations/006_cyboflow_schema.sql
    fix: git log --oneline -- main/src/database/migrations/006_cyboflow_schema.sql
    description: "The raw_events table is created by 006_cyboflow_schema.sql; absent migration means the sink's INSERTs will fail."
    blocking: true
---
# Wire orphan pipeline classes into production (umbrella)

## Problem

Six classes introduced in SPRINT-005 have ZERO production callsites today:
`MessageProjection`, `CompletionDetector`, `RawEventsSink`,
`assertTransitionAllowed`, `transitionToAwaitingReview`,
`transitionFromAwaitingReview` — plus the full parser pipeline
`ClaudeStreamParser`/`EventRouter`/`TypedEventNarrowing` is not connected to
`claudeCodeManager.handleClaudeOutput`. Confirmed via:

```
grep -rEn "MessageProjection|CompletionDetector|RawEventsSink|assertTransitionAllowed|transitionToAwaitingReview" main/src \
  | grep -v __tests__ \
  | grep -v streamParser/ \
  | grep -v cyboflow/stateMachine.ts \
  | grep -v cyboflow/transitions.ts
```

returns zero hits. Until wiring lands: (a) the Claude panel crash persists
in any path not covered by TASK-568, (b) `raw_events` is never populated,
(c) completion detection falls back to PTY exit (no triple-gate or watchdog),
(d) the state-machine guard is never consulted in production.

This is the umbrella task. Three children (TASK-568, TASK-573, TASK-574)
deliver pieces and land first. This task delivers the remaining pieces —
`ClaudeStreamParser` instantiation in the PTY callback, `RawEventsSink`
attachment, `CompletionDetector` signal threading — and verifies the
end-to-end grep gate.

## Proposed Direction (Implementation Steps)

1. **Wait for children to merge.** TASK-568, TASK-573, TASK-574 are the
   dependencies; their `done` reports must exist before this task starts.
   Confirm via the AC #5 ls check.

2. **Pre-flight grep** (completeness gate):
   ```
   grep -rEn 'MessageProjection|CompletionDetector|RawEventsSink|assertTransitionAllowed|transitionToAwaitingReview|ClaudeStreamParser' main/src --include='*.ts' | grep -v __tests__ | grep -v 'streamParser/' | grep -v 'cyboflow/stateMachine.ts' | grep -v 'cyboflow/transitions.ts'
   ```
   Records the starting state. Same grep, re-run, drives AC #4.

3. **Decide the per-run wiring lifecycle.** Each spawned Claude run needs
   a fresh `ClaudeStreamParser` + `EventRouter` + `RawEventsSink` +
   `CompletionDetector`. The natural lifecycle is keyed by `panelId` (the
   key `claudeCodeManager.processes` already uses). Add a parallel `Map`:
   ```ts
   private readonly pipelines = new Map<string, {
     parser: ClaudeStreamParser;
     router: EventRouter;
     sink: RawEventsSink;
     detector: CompletionDetector;
     runId: string;
   }>();
   ```

4. **Wire instantiation in the spawn path.** In `claudeCodeManager.ts`,
   inside `spawnCliProcess` / the overridden Claude-specific spawn method
   (or override `setupProcessHandlers` if needed), after the PTY process is
   created and before output starts flowing:
   - Derive a `runId`. If the panel is already mapped to a `workflow_runs.id`
     (Day-3 epic territory), use that. If not, use the `panelId` as a
     placeholder runId — the schema's CHECK constraints permit any TEXT
     value and a future task will tighten this when workflow_runs rows are
     auto-created.
   - Instantiate `const router = new EventRouter();`
   - Instantiate `const parser = new ClaudeStreamParser(runId, router, this.logger);`
   - Instantiate `const sink = new RawEventsSink(this.db, this.logger);`
     where `this.db` is the better-sqlite3 handle. If `claudeCodeManager`
     doesn't currently hold a DB handle, inject one via the constructor
     (extend the constructor signature and update the single caller in
     `claudePanelManager.ts` — that caller is `files_readonly` here, so add
     it to `files_owned` when the executor needs the change).
   - Call `sink.attachToRouter(router, runId);`
   - Instantiate `const detector = new CompletionDetector(runId, 30_000, this.logger);`
   - Store the tuple in `pipelines.set(panelId, {parser, router, sink, detector, runId});`

5. **Wire data ingestion.** In the PTY `onData` callback (currently in
   `AbstractCliManager.setupProcessHandlers` at line 660), the chunk is
   already being parsed line-by-line into events. The simplest insertion
   point is to override `parseCliOutput` (the Claude-specific version at
   `claudeCodeManager.ts:169`) to ALSO feed the raw chunk through
   `pipeline.parser.feed(line + '\n')`. Keep the existing emit-as-`json`
   path intact for now — both paths are non-destructive (the parser feeds
   the EventRouter/RawEventsSink; the JSON emit feeds the existing IPC).

   *Approach trade-off:* the alternative is to remove the parseCliOutput
   path and have the renderer consume EventRouter via tRPC; that is the
   eventual end state but Day-3-gate territory. For this task, keep both
   paths.

6. **Wire CompletionDetector signals.** In `setupProcessHandlers`'s
   `onExit` handler (line 679), after `parser.flush()`:
   - `pipeline.detector.signalStdoutEof()` — buffer is drained, stream ended.
   - `pipeline.parser.flush()` — drain any partial line.
   - `pipeline.detector.signalParserDrained()` — parser queue is empty.
   - `pipeline.detector.signalChildExited()` — process is gone.
   - Listen on `pipeline.detector` for `'complete'` and `'forced'`; on
     either, call `pipeline.sink.dispose(runId)`,
     `pipeline.router.clearRun(runId)`, `pipeline.detector.dispose()`,
     and `this.pipelines.delete(panelId)`.

7. **Wire cleanup in `killProcess`** (line ~224 in AbstractCliManager).
   Override or post-hook so when a panel is killed, the pipeline tuple
   for that panelId is also disposed (same cleanup as step 6's complete/forced
   listener).

8. **Author the wiring integration test.**
   `main/src/services/__tests__/claudeCodeManagerWiring.test.ts`:
   - Spawn a mock PTY (use the `events` library to mock onData/onExit).
   - Feed canned stream-json lines through the mock PTY.
   - Assert: rows appear in an in-memory `raw_events` table; the
     `CompletionDetector` emits `'complete'` after all three signals;
     killing the panel cleans up the pipeline.

9. **Re-run pre-flight grep** from step 2. Confirm ≥ 6 matches across the 6
   named symbols.

10. **Manual smoke** to satisfy AC #7: `pnpm dev`, create a session,
    inspect the SQLite DB for rows in `raw_events`.

## Acceptance Criteria

(See frontmatter.)

## Test Strategy

- New integration test `main/src/services/__tests__/claudeCodeManagerWiring.test.ts`
  using a mock PTY + in-memory better-sqlite3 to exercise the parser→router
  →sink→detector→cleanup loop end-to-end.
- The existing `claudeCodeManagerPermissions.test.ts` must remain green
  — the new constructor surface must be backward-compatible (add optional
  parameters with defaults; don't break existing call sites).

## Hardest Decision

**runId derivation when no `workflow_runs` row exists yet.** The schema's
`raw_events.run_id` is TEXT NOT NULL with no FK enforcement until
PRAGMA foreign_keys=ON lands (A7). So we have flexibility. Two choices:
- **(A) Use `panelId` as the runId placeholder** (chosen). Zero coordination
  with the Day-3 workflow-runs epic. Rows accumulate keyed by panelId;
  future migration can re-key once workflow_runs rows are auto-created.
- **(B) Auto-create a workflow_runs row when a Claude panel spawns.**
  Cleaner — every Claude run gets a proper runId. But it requires
  reaching into the workflow-runs-and-day3-gate epic territory and
  picking a workflow_id (which has its own complexity).

(A) is the pragmatic Day-2 choice. The future migration is straightforward
(a single `UPDATE raw_events SET run_id = <new-uuid> WHERE run_id = <panelId>`
when the workflow_runs row is backfilled).

## Rejected Alternatives

- **Single global `EventRouter` keyed by runId on every emit.** Considered
  — would save the per-run instantiation. Rejected because per-run routers
  give cleaner lifecycle (the existing `EventRouter.clearRun()` and the
  RawEventsSink's per-run teardown both assume per-run isolation).
- **Skip the `RawEventsSink` wiring for this sprint and only wire the
  parser+router.** Rejected because then AC #4's grep gate fails and the
  raw_events table stays empty — the Day-3 review queue UI depends on
  raw_events being populated.
- **Inject a `WorkflowRunService` and route through it.** The right end-state
  but blocked on the same workflow-runs-and-day3-gate territory as
  alternative (B) above. Deferred.

## Lowest Confidence Area

**`claudeCodeManager.ts` DB handle injection** (step 4). The constructor
currently takes `sessionManager`, `logger`, `configManager`. Adding a
`db: Database.Database` parameter touches `claudePanelManager.ts:39`
(the single instantiation site per Grep results) and possibly the
`AbstractAIPanelManager` scaffolding. If that surface is more invasive
than expected, the fallback is to defer DB injection: instead of
`new RawEventsSink(this.db, …)`, use `databaseService.getInstance().db`
(if a singleton exists) or import a getter from
`main/src/database/database.ts`. The executor should check whether
`databaseService` exposes a singleton before plumbing a constructor
parameter through three layers.
