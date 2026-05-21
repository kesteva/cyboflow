---
id: TASK-676
idea: SPRINT-025-compounder
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - main/src/orchestrator/__test_fixtures__/rawEvents.ts
  - main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts
  - main/src/orchestrator/__tests__/runEventBridge.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/services/streamParser/__tests__/rawEventsSink.test.ts
files_readonly:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts
acceptance_criteria:
  - criterion: "The shared raw_events fixture lives at `main/src/orchestrator/__test_fixtures__/rawEvents.ts` (canonical orchestrator fixture directory), and the old path `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` no longer exists."
    verification: "Run both: `test -f main/src/orchestrator/__test_fixtures__/rawEvents.ts` (exit 0) and `! test -e main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` (exit 0). Also: `ls main/src/orchestrator/__tests__/__fixtures__ 2>&1` should return the directory missing or empty (excluding leftover sibling files; today the directory only contains rawEvents.ts so the directory itself can be removed)."
  - criterion: "There are zero remaining inline copies of the raw_events DDL across the test suite — all three previously-duplicated copies (runEventBridge.test.ts, runExecutor.test.ts, rawEventsSink.test.ts) import from the shared fixture."
    verification: "Run `grep -rn 'CREATE TABLE.*raw_events' main/src/` and confirm the only match is in `main/src/orchestrator/__test_fixtures__/rawEvents.ts` (1 hit) and `main/src/database/migrations/006_cyboflow_schema.sql` (production source of truth). No matches in any `*.test.ts` file."
  - criterion: "Every test file that previously had an inline `RAW_EVENTS_DDL`, `makeDb()`, or `countRows()` helper now imports `RAW_EVENTS_DDL`, `makeRawEventsDb`, and `countRawEvents` from `'../../__test_fixtures__/rawEvents'` (for orchestrator tests) or the appropriate relative path."
    verification: "Run `grep -rn \"from .*__test_fixtures__/rawEvents\" main/src/` and confirm at least 3 matches: runEventBridge.test.ts, runExecutor.test.ts, rawEventsSink.test.ts (the last imports via a deeper relative path)."
  - criterion: All affected test files continue to pass after the refactor — no behavioral change introduced.
    verification: Run `pnpm --filter @cyboflow/main test -- runEventBridge.test.ts runExecutor.test.ts rawEventsSink.test.ts` from the repo root; exit code 0.
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "This refactor moves shared test fixtures and updates 3 importing test files. The 3 test files themselves serve as the regression test — they must continue to pass with identical behavior. Existing sibling tests in the same directories (e.g. dbAdapter.ts, loggerLikeSpy.ts) are already imported via the canonical __test_fixtures__/ path, so the move aligns with the established convention."
  targets:
    - behavior: runEventBridge.test.ts continues to pass with the imported shared fixture.
      test_file: main/src/orchestrator/__tests__/runEventBridge.test.ts
      type: integration
    - behavior: runExecutor.test.ts continues to pass with the imported shared fixture.
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: integration
    - behavior: rawEventsSink.test.ts continues to pass after replacing its inline DDL/makeDb/countRows with shared fixture imports.
      test_file: main/src/services/streamParser/__tests__/rawEventsSink.test.ts
      type: integration
---
# Complete raw_events DDL deduplication: align fixture path with __test_fixtures__/ convention and remove the fourth inline copy

## Objective

Finish the raw_events DDL consolidation started by TASK-665. Two structural issues remain: (1) the shared fixture sits at `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts`, diverging from the established orchestrator convention `main/src/orchestrator/__test_fixtures__/` (where `dbAdapter.ts` and `loggerLikeSpy.ts` already live); (2) `main/src/services/streamParser/__tests__/rawEventsSink.test.ts` still has its own inline copy of the DDL, `makeDb()`, and `countRows()`. After this task there must be exactly one source of truth for the raw_events fixture and one canonical fixture directory.

## Implementation Steps

1. **Sweep grep for completeness gate.** Before any edit, capture the current state of inline DDL copies and import paths:
   ```bash
   grep -rn 'CREATE TABLE.*raw_events' main/src/
   grep -rn '__fixtures__/rawEvents' main/src/
   grep -rn '__test_fixtures__/rawEvents' main/src/
   ```
   Expected before: 3 inline `CREATE TABLE.*raw_events` hits in test files (runEventBridge.test.ts, runExecutor.test.ts NO — it already imports — rawEventsSink.test.ts) plus the production migration; 2 imports from `__fixtures__/rawEvents` (runEventBridge.test.ts, runExecutor.test.ts). After this task: 0 `CREATE TABLE.*raw_events` in test files, 0 imports from `__fixtures__/rawEvents`, 3 imports from `__test_fixtures__/rawEvents`.

2. **Move the fixture file** to the canonical directory:
   - Source: `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts`
   - Destination: `main/src/orchestrator/__test_fixtures__/rawEvents.ts` (new file)
   - The file content is preserved verbatim. Update only the top-of-file JSDoc reference to reflect the new path if necessary (line 9 currently reads `main/src/database/migrations/006_cyboflow_schema.sql` which is the production source — no change needed).
   - Delete the source file at `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts`.
   - If the `__fixtures__/` directory becomes empty after deletion (it should — the directory currently only contains `rawEvents.ts`), remove the directory.

3. **Update the import in `main/src/orchestrator/__tests__/runEventBridge.test.ts`** (currently line 26):
   ```ts
   // Before
   import { makeRawEventsDb, countRawEvents } from './__fixtures__/rawEvents';
   // After
   import { makeRawEventsDb, countRawEvents } from '../__test_fixtures__/rawEvents';
   ```

4. **Update the import in `main/src/orchestrator/__tests__/runExecutor.test.ts`** (currently line 681):
   ```ts
   // Before
   import { makeRawEventsDb, countRawEvents } from './__fixtures__/rawEvents';
   // After
   import { makeRawEventsDb, countRawEvents } from '../__test_fixtures__/rawEvents';
   ```

5. **Refactor `main/src/services/streamParser/__tests__/rawEventsSink.test.ts`** to use the shared fixture. The current inline definitions (lines 26-34 `RAW_EVENTS_DDL`, lines 99-105 `makeDb`, lines 107-112 `countRows`) must be deleted and replaced with imports.
   - Add an import near the top of the file:
     ```ts
     import { makeRawEventsDb, countRawEvents } from '../../../orchestrator/__test_fixtures__/rawEvents';
     ```
   - Delete the inline `const RAW_EVENTS_DDL = ...` block (lines 26-34) and its preceding comment block (lines 21-25).
   - Delete the inline `function makeDb()` (lines 99-105). Update all in-file callers from `makeDb()` to `makeRawEventsDb()` — there are 3 call sites at approximately lines 135, 186, and any others in the file. Use grep to enumerate before editing.
   - Delete the inline `function countRows(db, runId)` (lines 107-112). Update all in-file callers from `countRows(...)` to `countRawEvents(...)` — there are multiple call sites; enumerate with `grep -n 'countRows(' main/src/services/streamParser/__tests__/rawEventsSink.test.ts` before editing.
   - The `selectRows` helper at lines 119-123 is unique to this file (not in the shared fixture) — leave it inline.
   - The `RawEventRow` interface at lines 114-117 is unique to this file — leave it inline.

6. **Re-run the sweep grep from step 1** as a completeness gate:
   ```bash
   grep -rn 'CREATE TABLE.*raw_events' main/src/
   grep -rn 'makeDb\b' main/src/services/streamParser/__tests__/rawEventsSink.test.ts
   grep -rn 'countRows\b' main/src/services/streamParser/__tests__/rawEventsSink.test.ts
   grep -rn '__fixtures__/rawEvents' main/src/
   ```
   Expected: 1 hit each for the first 3 (only the production migration / no test-level hits / no test-level hits); 0 hits for the last.

7. **Run the affected test files** to confirm no behavioral regression:
   ```bash
   pnpm --filter @cyboflow/main test -- runEventBridge.test.ts runExecutor.test.ts rawEventsSink.test.ts
   ```

8. **Run the full main workspace test suite** to catch any other importer of the old path (the sweep grep in step 1 should already have surfaced any, but the suite is the final guarantee):
   ```bash
   pnpm --filter @cyboflow/main test
   ```

## Acceptance Criteria

See frontmatter. One canonical fixture at `main/src/orchestrator/__test_fixtures__/rawEvents.ts`, three importers updated, zero remaining inline DDL copies in test files, all affected tests passing.

## Test Strategy

This is a structural refactor with zero intended behavior change. The 3 affected test files act as their own regression tests — if any helper rename or import path is wrong, vitest will fail at module-resolution time. No new tests are added.

## Hardest Decision

**Whether to also relocate `selectRows` and `RawEventRow` from `rawEventsSink.test.ts` into the shared fixture.** Decision: leave them inline. `selectRows` returns only 2 of 5 raw_events columns (event_type, payload_json), tailored to that file's assertions; moving it would require a generic column-set or two variants, both worse than keeping it adjacent to its use. The fixture's job is the DDL + the most-shared helpers (`makeRawEventsDb`, `countRawEvents`); per-file query helpers stay local. This matches the established pattern with `dbAdapter.ts` (shared) vs per-file Statement wrappers.

## Rejected Alternatives

- **Keep the fixture at `__tests__/__fixtures__/` and migrate the existing canonical fixtures (`dbAdapter.ts`, `loggerLikeSpy.ts`) DOWN to match it.** Rejected — those two are already imported from at least 2 sites each via the `__test_fixtures__/` path. Moving them would create more churn than the proposed direction.
- **Leave the fixture path divergence and only deduplicate the rawEventsSink.test.ts inline copy.** Rejected because the IDEA explicitly flags the path divergence as a primary issue. A half-fix would leave the next contributor uncertain which path to use.
- **Create a `shared/test-fixtures/` directory at repo root and put `rawEvents.ts` there.** Rejected as out-of-scope and inconsistent with the existing convention. The orchestrator fixtures are intentionally scoped to the orchestrator package boundary.

## Lowest Confidence Area

The exact import path from `rawEventsSink.test.ts` to the shared fixture. The file lives at `main/src/services/streamParser/__tests__/rawEventsSink.test.ts` and the fixture will be at `main/src/orchestrator/__test_fixtures__/rawEvents.ts`. The relative path is `../../../orchestrator/__test_fixtures__/rawEvents`. If TypeScript's `rootDir`/`baseUrl` config in the main workspace prefers a different resolution (e.g. a path alias like `@orchestrator/...`), the import should use that alias instead. Mitigation: if vitest fails the file with "cannot find module", check `main/tsconfig.json` and `main/vitest.config.ts` for path aliases and use them.
