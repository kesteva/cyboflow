---
id: TASK-594
idea: IDEA-014
status: approved
created: 2026-05-14T00:00:00Z
files_owned:
  - main/src/services/streamParser/__tests__/schemas.test.ts
  - main/src/services/streamParser/__tests__/eventRouter.test.ts
  - main/src/services/streamParser/__tests__/messageProjection.test.ts
  - main/src/services/streamParser/__tests__/rawEventsSink.test.ts
  - main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts
  - main/src/services/streamParser/__tests__/sdkMockFactories.ts
files_readonly:
  - main/src/services/streamParser/schemas.ts
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
acceptance_criteria:
  - criterion: "No surviving test file under main/src/services/streamParser/__tests__/ imports fixtures from disk."
    verification: "grep -rn -E \"loadFixture|readFixture|__fixtures__|readFileSync\" main/src/services/streamParser/__tests__/ returns 0 matches"
  - criterion: "schemas.test.ts is migrated to SDK-mock inputs constructed inline (or via the shared factories helper); it no longer reads any JSON fixture from disk."
    verification: "grep -nE \"loadFixture|readFileSync|__fixtures__\" main/src/services/streamParser/__tests__/schemas.test.ts returns 0 matches AND the file is non-empty"
  - criterion: "typedEventNarrowing.test.ts is migrated to SDK-mock inputs constructed inline (or via the shared factories helper); it no longer reads any JSON fixture from disk."
    verification: "grep -nE \"loadFixture|readFileSync|__fixtures__\" main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts returns 0 matches AND the file is non-empty"
  - criterion: "A shared factories module exists at __tests__/sdkMockFactories.ts and exports factory functions for the canonical message shapes used by schemas.test.ts and typedEventNarrowing.test.ts (systemInit, systemApiRetry, systemCompact, assistant, userStringContent, userArrayContent, resultSuccess, resultErrorMaxTurns, resultErrorMaxBudgetUsd, resultErrorDuringExecution, streamEvent)."
    verification: "test -f main/src/services/streamParser/__tests__/sdkMockFactories.ts AND grep -cE \"^export function (systemInit|systemApiRetry|systemCompact|assistant|userStringContent|userArrayContent|resultSuccess|resultErrorMaxTurns|resultErrorMaxBudgetUsd|resultErrorDuringExecution|streamEvent)\\b\" main/src/services/streamParser/__tests__/sdkMockFactories.ts returns 11"
  - criterion: "All surviving parser test suites pass green."
    verification: "pnpm test -- main/src/services/streamParser/__tests__/ exits 0; the run lists schemas.test.ts, eventRouter.test.ts, messageProjection.test.ts, rawEventsSink.test.ts, and typedEventNarrowing.test.ts as PASS"
  - criterion: "Workspace typecheck succeeds."
    verification: "pnpm typecheck exits 0"
  - criterion: "Workspace lint succeeds (no `any` regressions introduced by the factory helper)."
    verification: "pnpm lint exits 0"
  - criterion: "The byte-stream-validation subset of schemas.test.ts is deleted; the substrate-portable describe blocks are preserved verbatim."
    verification: "Open schemas.test.ts and confirm: describe('SystemInitEvent'), describe('SystemApiRetryEvent'), describe('SystemCompactEvent'), describe('AssistantEvent'), describe('UserEvent'), describe('ResultEvent'), describe('StreamEvent'), describe('UnknownStreamEvent fallback'), describe('passthrough'), and describe('exhaustive union coverage') blocks all still exist; no new describe blocks have been added."
depends_on: [TASK-592, TASK-593]
estimated_complexity: medium
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "The test suite IS the deliverable for this task. The surviving parser tests must continue to exercise the substrate-independent invariants (variant narrowing, event routing, message projection, raw-events persistence) against inline SDK-mock inputs after the fixture-on-disk pattern is removed."
  targets:
    - behavior: "Variant narrowing across all 7 wire variants + passthrough + catch-all + assertNever exhaustive coverage continues to pass with inline SDK-mock inputs."
      test_file: "main/src/services/streamParser/__tests__/schemas.test.ts"
      type: unit
    - behavior: "TypedEventNarrowing.narrow() round-trips system/init, assistant/tool_use, result/success, unknown discriminants, and passthrough fields with inline SDK-mock inputs."
      test_file: "main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts"
      type: unit
    - behavior: "Per-runId fanout isolation, teardown, clearRun, and re-attach semantics remain green."
      test_file: "main/src/services/streamParser/__tests__/eventRouter.test.ts"
      type: unit
    - behavior: "MessageProjection.project() output parity across 21 cases remains green."
      test_file: "main/src/services/streamParser/__tests__/messageProjection.test.ts"
      type: unit
    - behavior: "RawEventsSink happy-path persistence, fail-soft on INSERT error, unknown-variant column mapping, dispose teardown, re-attach idempotence, and large-payload preservation remain green."
      test_file: "main/src/services/streamParser/__tests__/rawEventsSink.test.ts"
      type: integration
    - behavior: "Shared factory functions produce objects that satisfy the existing ClaudeStreamEvent discriminated union (compile-time check via typecheck)."
      test_file: "main/src/services/streamParser/__tests__/sdkMockFactories.ts"
      type: unit
---

# Migrate surviving stream-parser tests to SDK-mock fixtures

## Objective

After TASK-592 deletes the byte-stream parser plumbing along with the `__fixtures__/*.json` directory, two surviving test files (`schemas.test.ts` and `typedEventNarrowing.test.ts`) still consume those fixtures via `loadFixture(name)` and `readFileSync`. This task re-shapes their inputs from "on-disk JSON parsed at test time" to "inline, typed SDK-mock objects constructed via shared factory functions," removes every remaining `__fixtures__` reference, and confirms the four other consumer test files (`eventRouter.test.ts`, `messageProjection.test.ts`, `rawEventsSink.test.ts`) remain green — they already use inline typed inputs and will not be modified. The substrate-independent assertions survive verbatim; only the input shape changes.

## Implementation Steps

1. **Completeness gate — re-run the sweep grep BEFORE marking COMPLETED.** Execute `grep -rn -E "loadFixture|readFixture|__fixtures__|readFileSync" main/src/services/streamParser/__tests__/` from the repo root. The expected result at task end is zero matches.

2. **Confirm the four "no-op" consumer test files are already fixture-free.** Run grep against eventRouter / messageProjection / rawEventsSink test files. Expect zero matches. Do NOT modify these files; they are listed in `files_owned` only as a safety net.

3. **Create the shared factories module at `main/src/services/streamParser/__tests__/sdkMockFactories.ts`.** Required factory function exports (exact names — the AC grep depends on them):
   - `systemInit(overrides?: Partial<SystemInitEvent>): SystemInitEvent`
   - `systemApiRetry(overrides?: Partial<SystemApiRetryEvent>): SystemApiRetryEvent`
   - `systemCompact(overrides?: Partial<SystemCompactEvent>): SystemCompactEvent`
   - `assistant(overrides?: Partial<AssistantEvent>): AssistantEvent`
   - `userStringContent(overrides?: Partial<UserEvent>): UserEvent`
   - `userArrayContent(overrides?: Partial<UserEvent>): UserEvent`
   - `resultSuccess(overrides?: Partial<ResultEvent>): ResultEvent`
   - `resultErrorMaxTurns(overrides?: Partial<ResultEvent>): ResultEvent`
   - `resultErrorMaxBudgetUsd(overrides?: Partial<ResultEvent>): ResultEvent`
   - `resultErrorDuringExecution(overrides?: Partial<ResultEvent>): ResultEvent`
   - `streamEvent(overrides?: Partial<StreamEvent>): StreamEvent`

   Implementation pattern (sample):
   ```ts
   import type {
     SystemInitEvent,
     SystemApiRetryEvent,
     SystemCompactEvent,
     AssistantEvent,
     UserEvent,
     ResultEvent,
     StreamEvent,
   } from '../../../../../shared/types/claudeStream';

   export function systemInit(overrides: Partial<SystemInitEvent> = {}): SystemInitEvent {
     return {
       type: 'system',
       subtype: 'init',
       session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
       cwd: '/Users/dev/projects/myapp',
       model: 'claude-opus-4-5',
       tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
       mcp_servers: [],
       permissionMode: 'bypassPermissions',
       apiKeySource: 'ANTHROPIC_API_KEY',
       claude_code_version: '1.0.0',
       ...overrides,
     };
   }
   ```
   Source the literal values from the (about-to-be-deleted) `__fixtures__/*.json` files. If fixtures are already gone, pull values from the test assertions in `schemas.test.ts` which mirror them, or `git show` on deleted paths.

4. **Rewrite `schemas.test.ts` to use the factories.** Replace each `const raw = loadFixture('NAME.json')` call with the corresponding factory invocation. Delete the `loadFixture` helper, `readFileSync`/`join` imports. Add factory imports.

   The `passthrough` test becomes `const mutated = { ...systemInit(), future_unannounced_field: 'lorem' };`.

   The `exhaustive union coverage` test's `fixtures` array becomes `[factory, expectedSummary]` tuples.

   Do NOT rename, delete, or add any `describe` block.

5. **Rewrite `typedEventNarrowing.test.ts` to use the factories.** Replace each `loadFixture` call with `systemInit()`, `assistant()`, `resultSuccess()` etc. Delete the helper and imports.

6. **Do NOT modify `eventRouter.test.ts`, `messageProjection.test.ts`, or `rawEventsSink.test.ts`.** Touch them only if step 7's full-suite run reveals a TypeScript breakage.

7. **Run the full parser test suite as the primary gate.** Execute `pnpm test -- main/src/services/streamParser/__tests__/` from the repo root. Every test file in `test_strategy.targets` must report PASS. Vitest exit code must be 0.

8. **Run workspace-wide gates.** `pnpm typecheck` and `pnpm lint` from the repo root. Both must exit 0. No `any` usage in factories.

9. **Re-run the completeness sweep grep from step 1.** Confirm zero matches across the five test files.

## Acceptance Criteria

1. Sweep gate returns zero matches.
2. `schemas.test.ts` migrated.
3. `typedEventNarrowing.test.ts` migrated.
4. Factories module exists and exports the 11 named factory functions.
5. All parser tests pass green.
6. `pnpm typecheck` exits 0.
7. `pnpm lint` exits 0.
8. No describe-block churn in `schemas.test.ts`.

## Test Strategy

The test suite IS the deliverable. The executor must run `pnpm test -- main/src/services/streamParser/__tests__/` and confirm all five test files pass green against the new inline SDK-mock inputs. The factories module itself does not need its own behavioral tests — its correctness is proven transitively by the migrated test files compiling and passing.

## Hardest Decision

**Whether to inline the SDK-mock objects directly into each test file or extract a shared factory module.** Inlining is simpler but produces two near-identical copies of the 11 message shapes. Chose the factory-module approach because: (a) the EPIC envisions further SDK-backed tests; (b) the factories use `Partial<T>` overrides so per-test customization stays terse; (c) failure-mode isolation — if a future SDK retarget changes a wire field name, exactly one file needs updating.

## Rejected Alternatives

1. **Delete `schemas.test.ts` outright.** Rejected: the 10 describe blocks cover substrate-independent invariants. Deleting them would lose load-bearing coverage.
2. **Inline mock objects per-test (no factory module).** Rejected for the reasons above.
3. **Move fixtures to a new on-disk JSON location.** Explicitly forbidden by the task scope.
4. **Convert factories to `vi.fn()` mock builders.** Overkill — the factories produce plain typed objects.

## Lowest Confidence Area

**Whether `pnpm test -- main/src/services/streamParser/__tests__/` glob-filtering will exclude `streamParser.test.ts` if T6 has not actually deleted it by the time this task runs.** TASK-592 is declared a dependency, but if T6 only deletes the parser source and leaves the test file orphaned, the suite will fail. Mitigation: if `streamParser.test.ts` still exists when this task starts, the executor should treat that as a scope deviation from TASK-592 and flag rather than silently delete it.

A secondary uncertainty: the SDK retarget in T3 may rename fields in `shared/types/claudeStream.ts`. The factory bodies will need adjustment. Mitigation: factories import from `shared/types/claudeStream.ts` and rely on TypeScript narrowing — any field-shape drift surfaces as a typecheck failure immediately.
