---
id: TASK-673
idea: IDEA-SPRINT-024-compound
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - main/src/services/cliManagerFactory.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/index.ts
  - main/src/ipc/session.ts
  - main/src/services/cliToolRegistry.ts
acceptance_criteria:
  - criterion: "In main/src/services/cliManagerFactory.ts, the `claudeManagerFactory` closure performs a structural duck-type check on `additionalOptions.db` BEFORE the cast to `Database.Database`. The check verifies (a) the value is truthy AND (b) `typeof value.prepare === 'function'`. A failure of either check throws a TypeError naming the specific failure mode."
    verification: "grep -nE 'typeof.*prepare.*function' main/src/services/cliManagerFactory.ts returns at least 1 hit inside registerClaudeTool; the surrounding code shows the check fires before `new ClaudeCodeManager(...)`."
  - criterion: The thrown TypeError messages are distinct between missing-db and wrong-shape-db so logs reveal which precondition failed.
    verification: "Missing-db path throws message containing 'requires `db`'; wrong-shape path throws message containing '.prepare' or 'Database instance'."
  - criterion: "The existing 'constructor throws TypeError when db is undefined' test in claudeCodeManagerWiring.test.ts continues to pass unchanged."
    verification: "Run `cd main && pnpm exec vitest run src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` and confirm exit 0 with that test still green."
  - criterion: "New tests assert the cliManagerFactory duck-type guard fires for wrong-shape db (object lacking .prepare, primitive)."
    verification: "grep -nE 'duck-type guard|prepare.*not a function|wrong-shape db' main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts returns at least 1 hit. The new tests pass."
  - criterion: Full main vitest suite remains green.
    verification: "Run `cd main && pnpm exec vitest run` and confirm exit 0."
  - criterion: main typecheck passes.
    verification: Run `pnpm --filter main typecheck` and confirm exit 0.
  - criterion: "Out-of-scope: option (b) per the FIND-SPRINT-024-13 skeptic — typed `ClaudeAdditionalOptions` interface — is NOT introduced. The factory signature continues to accept `additionalOptions?: unknown`."
    verification: "grep -n 'additionalOptions?: unknown' main/src/services/cliManagerFactory.ts still returns at least 1 hit."
depends_on: []
estimated_complexity: low
epic: wire-sprint-005-services
test_strategy:
  needed: true
  justification: "This task adds a runtime guard whose failure mode is silent (without the guard, a wrong-shape db propagates downstream and surfaces as a cryptic `db.prepare is not a function` at the first RawEventsSink write). The guard MUST be tested with wrong-shape inputs to prove it fires. The canonical home for ClaudeCodeManager wiring tests is claudeCodeManagerWiring.test.ts, which already hosts the sibling missing-db test."
  targets:
    - behavior: "cliManagerFactory's claude tool factory throws TypeError when additionalOptions.db is a plain object lacking .prepare."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
      type: unit
    - behavior: "cliManagerFactory's claude tool factory continues to throw TypeError when additionalOptions.db is undefined OR additionalOptions itself is undefined."
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
      type: unit
---
# Add structural duck-type guard for additionalOptions.db cast in cliManagerFactory

## Objective

Tighten the runtime contract for `cliManagerFactory`'s claude-tool factory closure (`main/src/services/cliManagerFactory.ts:170-187`) so that passing a non-`Database` value as `additionalOptions.db` fails at the factory boundary with an explicit TypeError, rather than propagating downstream to the first `RawEventsSink.handleEvent` INSERT and surfacing as a cryptic `db.prepare is not a function`. Today the factory checks only `if (!db)` after casting; a caller passing `{ db: "not-a-db" }` bypasses this. Scope is option (a) per the FIND-SPRINT-024-13 skeptic; option (b) — typed `ClaudeAdditionalOptions` interface — is deferred.

## Implementation Steps

1. **Audit current callers.** Confirm `main/src/index.ts:478-486` passes a real Database, and `main/src/ipc/session.ts:102-112` passes `additionalOptions: {}` (no db key). Run a global search:
   ```
   grep -rnE "createManager.*'claude'|createManager\(.*claude" main/src --include='*.ts'
   ```

2. **Add the duck-type guard in `cliManagerFactory.ts`.** Replace the body around lines 177-181:
   ```ts
   const options = additionalOptions as Record<string, unknown> | undefined;
   const dbCandidate = options?.db;
   if (!dbCandidate) {
     throw new TypeError('[CliManagerFactory] claude tool requires `db` in additionalOptions');
   }
   if (
     typeof dbCandidate !== 'object' ||
     typeof (dbCandidate as { prepare?: unknown }).prepare !== 'function'
   ) {
     throw new TypeError(
       '[CliManagerFactory] claude tool: additionalOptions.db must be a better-sqlite3 Database instance (received a value lacking a .prepare() method)',
     );
   }
   const db = dbCandidate as Database.Database;
   ```
   Order matters: the existing `!db` check fires first preserving the missing-db message for the session.ts fallback path.

3. **Sanity-check the guard does not change correct-path behavior.** `databaseService.getDb()` returns a `Database.Database` with a `.prepare` method — both checks pass.

4. **Add new tests to `claudeCodeManagerWiring.test.ts`** under a new `describe` block:
   - Test 1: empty `additionalOptions` → TypeError containing 'requires `db`'.
   - Test 2: undefined `additionalOptions` → same.
   - Test 3: `{ db: { foo: 'bar' } }` → TypeError naming the wrong-shape failure.
   - Test 4: `{ db: 'not-a-db' }` (primitive) → TypeError on the duck-type check (the `typeof !== 'object'` arm).
   Reset the `CliManagerFactory` singleton in `afterEach` via `await instance.shutdown()`.

5. **Run targeted test file:** `cd main && pnpm exec vitest run src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts --reporter=verbose`. Confirm 6 existing + 4 new tests pass.

6. **Run full main vitest.** `cd main && pnpm exec vitest run` exit 0.

7. **Run typecheck.** `pnpm typecheck` exit 0.

8. **Run lint.** `pnpm lint` exit 0.

## Acceptance Criteria

See frontmatter.

## Hardest Decision

Where to host the new tests. Chose `claudeCodeManagerWiring.test.ts` (sibling to the existing missing-db test) over creating a new `cliManagerFactory.test.ts` file: locality of test reasoning beats strict module-to-file mapping for a small auxiliary test set.

## Rejected Alternatives

- **Option (b): typed `ClaudeAdditionalOptions` interface.** Rejected per skeptic — the cli tool registry hosts ONE concrete tool factory; type duplication is hypothetical until a second tool lands.
- **Make the guard fail-soft (log a warning and proceed).** Rejected — silent failure is exactly the bug FIND-SPRINT-024-13 flags.
- **Move the guard into ClaudeCodeManager's constructor.** Rejected — factory is the cast site; constructor already has a TypeError-on-undefined check.
- **Use `instanceof Database`.** Rejected — `Database` is a type-only import; runtime check needs duck-typing.

## Lowest Confidence Area

The `afterEach` singleton reset via `CliManagerFactory.getInstance().shutdown()` may interact with other tests in the suite that share the singleton. Step 6's full `vitest run` surfaces any cross-file dependence.
