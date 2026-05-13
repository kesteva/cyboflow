---
id: TASK-103
idea_id: IDEA-003
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/streamParser/__fixtures__/system_init.json
  - main/src/services/streamParser/__fixtures__/system_api_retry.json
  - main/src/services/streamParser/__fixtures__/system_compact.json
  - main/src/services/streamParser/__fixtures__/assistant.json
  - main/src/services/streamParser/__fixtures__/user_string_content.json
  - main/src/services/streamParser/__fixtures__/user_array_content.json
  - main/src/services/streamParser/__fixtures__/result_success.json
  - main/src/services/streamParser/__fixtures__/result_error_max_turns.json
  - main/src/services/streamParser/__fixtures__/result_error_max_budget_usd.json
  - main/src/services/streamParser/__fixtures__/result_error_during_execution.json
  - main/src/services/streamParser/__fixtures__/stream_event.json
  - main/src/services/streamParser/__fixtures__/README.md
  - main/src/services/streamParser/__tests__/schemas.test.ts
files_readonly:
  - main/src/services/streamParser/schemas.ts
  - shared/types/claudeStream.ts
  - main/vitest.config.ts
  - main/src/test/setup.ts
  - main/src/services/__tests__/gitStatusManager.test.ts
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: "11 wire-format JSON fixture files exist under main/src/services/streamParser/__fixtures__/, one per variant (the 4 result subtypes plus the other 7 variants, with user split into string-content and array-content cases)."
    verification: "ls main/src/services/streamParser/__fixtures__/*.json | wc -l prints 11; each file passes `node -e 'JSON.parse(require(\"fs\").readFileSync(\"<file>\", \"utf-8\"))'` without error."
  - criterion: "A fixture README documents each fixture's source (real capture vs synthetic) and the exact `claude` command used to capture real fixtures."
    verification: "test -f main/src/services/streamParser/__fixtures__/README.md AND grep -nE 'claude -p|--output-format stream-json' main/src/services/streamParser/__fixtures__/README.md returns at least one match AND grep -nE 'real|synthetic' main/src/services/streamParser/__fixtures__/README.md returns at least 2 matches."
  - criterion: Test file main/src/services/streamParser/__tests__/schemas.test.ts exists with at least 13 distinct `it(...)` / `test(...)` blocks.
    verification: "grep -cE \"^\\s*(it|test)\\(\" main/src/services/streamParser/__tests__/schemas.test.ts returns >= 13."
  - criterion: "Every fixture file is loaded and parsed in the test suite; each fixture has at least one assertion that `parseClaudeStreamEvent(fixture).type === <expected>` (or `.kind === '__unknown__'` for the catch-all case)."
    verification: "grep -nE 'parseClaudeStreamEvent\\(' main/src/services/streamParser/__tests__/schemas.test.ts returns >= 11 matches."
  - criterion: "Test suite includes a dedicated case asserting that parsing malformed input (missing `type` field, garbage object, primitive) returns `{ kind: '__unknown__', raw: ... }` and does not throw."
    verification: "grep -nE \"'__unknown__'|kind.*unknown\" main/src/services/streamParser/__tests__/schemas.test.ts returns at least one match in a block whose `it(...)` description references 'unknown' or 'malformed' or 'catch-all'."
  - criterion: "Test suite includes a TypeScript exhaustive-check assertion: a `switch (event.type)` block that, if any wire variant were dropped from the union, would fail to compile (uses the `assertNever` helper from shared/types/claudeStream.ts)."
    verification: "grep -nE 'assertNever' main/src/services/streamParser/__tests__/schemas.test.ts returns at least one match."
  - criterion: "Test suite includes a case asserting `.passthrough()` works — when a fixture is mutated to add an unknown field, parsing still succeeds AND the unknown field is preserved on the parsed object."
    verification: "grep -nE 'passthrough|unknown.*field|unrecognized' main/src/services/streamParser/__tests__/schemas.test.ts returns at least one match in the context of a passing assertion (not just a comment)."
  - criterion: "Test suite includes both string-content and array-content cases for the user (tool_result) variant, both asserting they parse to the `user` type."
    verification: "grep -nE 'user_string_content|user_array_content' main/src/services/streamParser/__tests__/schemas.test.ts returns at least 2 matches."
  - criterion: All 4 result subtypes have explicit assertions on `event.subtype`.
    verification: "grep -nE \"'success'|'error_max_turns'|'error_max_budget_usd'|'error_during_execution'\" main/src/services/streamParser/__tests__/schemas.test.ts returns >= 4 matches."
  - criterion: "`pnpm --filter main test streamParser` exits 0 with all fixture tests green."
    verification: "cd main && pnpm test -- streamParser exits 0; output reports >= 13 passing tests."
depends_on:
  - TASK-101
  - TASK-102
estimated_complexity: high
epic: typed-stream-event-schema
test_strategy:
  needed: true
  justification: "This task is the test task — it produces both the fixture corpus AND the test suite that validates TASK-101's union and TASK-102's schemas against real Claude wire output. Without these tests, the union and schemas have no behavioral coverage."
  targets:
    - behavior: Each real-captured fixture parses cleanly via parseClaudeStreamEvent and narrows to the expected variant.
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: "Malformed input (missing type, garbage, primitives) returns UnknownStreamEvent without throwing."
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: All 4 result subtypes narrow correctly via discriminated subtype.
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: tool_result.content accepts both string and array forms (per research §1 inconsistency).
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: .passthrough() preserves unknown fields on each variant.
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: Compile-time exhaustive switch using assertNever covers all wire variants (forward-compatibility tripwire).
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
prerequisites:
  - check: "command -v claude >/dev/null 2>&1"
    fix: npm install -g @anthropic-ai/claude-code
    description: "Capturing real fixtures requires the claude CLI on PATH. If unavailable, the executor may hand-craft fixtures using the shape documented in architecture research §1, but real-captured fixtures are strongly preferred for the 7 documented variants."
    blocking: false
  - check: "test -n \"$ANTHROPIC_API_KEY\" || test -f ~/.claude/config.json"
    fix: Set ANTHROPIC_API_KEY env var or run `claude login`.
    description: "Capturing real fixtures requires a usable Claude credential. Without it, only synthetic fixtures are possible."
    blocking: false
---
# Fixture-Driven Unit Tests Against Real Stream-JSON Output

## Objective

Capture one real JSON line per `ClaudeStreamEvent` variant from a live `claude -p --output-format
stream-json --verbose --include-partial-messages` invocation, check them into the repository as
JSON fixtures, and write a Vitest suite that parses each fixture through
`parseClaudeStreamEvent` (from TASK-102) and asserts both correct variant narrowing and
acceptance-criteria-level correctness (subtype enumeration, tool_result content shape,
passthrough behavior, exhaustive switch coverage). Where a real capture is impractical
(`system/compact` requires a long session; the 3 non-success result subtypes require deliberate
failure injection), use synthetic fixtures and document the choice in the fixtures README.

This task closes the feedback loop on the parser-boundary contract: if Anthropic changes the
wire format, these tests fail loudly, and the catch-all variant absorbs the breakage
gracefully until the schema is updated.

## Implementation Steps

1. **Create the fixtures directory.** `main/src/services/streamParser/__fixtures__/`. Add a
   README.md that documents:
   - The exact capture command: `claude -p "Print 'hello world' then exit" --output-format
     stream-json --verbose --include-partial-messages > raw_stream.jsonl`
   - The capture process: run the command, then `jq -c 'select(...)' raw_stream.jsonl` to
     extract one line per variant.
   - Which fixtures are real captures vs synthetic, and why each synthetic was needed.
   - The Anthropic Claude Code version used for capture (`claude --version` output).
   - A note that fixtures should be re-captured roughly quarterly to detect wire-format drift.

2. **Capture real fixtures.** Run a simple prompt to elicit `system/init`, at least one `assistant`
   with a `tool_use` content block, at least one `user` with a `tool_result` (both string- and
   array-content forms if possible), `result` with `subtype: 'success'`, and several `stream_event`
   variants. Save each as a single-line JSON file with a trailing newline. File names:
   - `system_init.json` — captured
   - `assistant.json` — captured (must include a tool_use block AND a text block in the content array per research §1's mixed-content note)
   - `user_string_content.json` — captured
   - `user_array_content.json` — captured if possible; synthetic otherwise (research §1: content is sometimes array, depends on Claude version)
   - `result_success.json` — captured
   - `stream_event.json` — captured

3. **Author synthetic fixtures for hard-to-trigger variants.** Document in the README that these
   are synthetic and based on architecture research §1's documented field set:
   - `system_api_retry.json` — synthetic (requires rate-limit injection to capture; synth based on research §1 schema)
   - `system_compact.json` — synthetic (research §1: only fires on long sessions; use the exact `subtype` string that emerges from research — start with `'compact'`; if TASK-103's actual capture surfaces a different value like `'context_compacted'`, update TASK-101 and reconcile)
   - `result_error_max_turns.json` — synthetic (requires `--max-turns` exhaustion)
   - `result_error_max_budget_usd.json` — synthetic (requires `--max-budget` exhaustion)
   - `result_error_during_execution.json` — synthetic (requires Claude to crash mid-run)

   Each synthetic fixture must include the discriminant fields (`type` + `subtype` where
   applicable) and the documented required fields from research §1, but may use placeholder
   values for variable fields (e.g. `"duration_ms": 1234`, `"total_cost_usd": 0.05`).

4. **Create the test file** `main/src/services/streamParser/__tests__/schemas.test.ts`. Use the
   same import style as `main/src/services/__tests__/gitStatusManager.test.ts`
   (`import { describe, it, expect } from 'vitest'`). Header imports:

   ```ts
   import { describe, it, expect } from 'vitest';
   import { readFileSync } from 'node:fs';
   import { join } from 'node:path';
   import { parseClaudeStreamEvent } from '../schemas';
   import type { ClaudeStreamEvent } from '@shared/types/claudeStream';
   import { assertNever } from '@shared/types/claudeStream';
   ```

   Add a small `loadFixture(name: string): unknown` helper that does
   `JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf-8'))` so each
   `it(...)` block reads its fixture by filename. Keeping the helper local (not a shared util)
   avoids dragging an export surface into `schemas.ts`.

5. **Author one `describe()` block per wire variant.** Eight top-level blocks, mirroring the
   union in TASK-101. Inside each, at least one `it()` round-trips the corresponding fixture(s)
   through `parseClaudeStreamEvent` and asserts the discriminant + key fields:

   - `describe('SystemInitEvent', ...)` — load `system_init.json`, assert `event.type === 'system'`
     and `event.subtype === 'init'`, then narrow and assert `event.session_id`, `event.cwd`,
     `event.model`, `Array.isArray(event.tools)`, and that `event.permissionMode` is present as
     a camelCase key (the documented wire-spec exception from TASK-101).
   - `describe('SystemApiRetryEvent', ...)` — load `system_api_retry.json`, assert
     `event.type === 'system'` and `event.subtype === 'api_retry'`, then assert
     `typeof event.attempt === 'number'` and `typeof event.max_retries === 'number'`.
   - `describe('SystemCompactEvent', ...)` — load `system_compact.json`, assert
     `event.type === 'system'` and `event.subtype === 'compact'`. Note in a comment that the
     ClaudeMessageTransformer uses subtype `context_compacted` for its renderer-side handling,
     but the wire literal is `compact` per research §1; this test pins the wire literal.
   - `describe('AssistantEvent', ...)` — load `assistant.json`, assert `event.type === 'assistant'`,
     then walk `event.message.content` and assert it contains at least one block matching
     `block.type === 'tool_use'` and at least one matching `block.type === 'text'` (the
     mixed-content array case from research §1).
   - `describe('UserEvent', ...)` — TWO `it()` blocks: one loads `user_string_content.json` and
     asserts `event.type === 'user'` with `typeof event.message.content[0].content === 'string'`;
     the other loads `user_array_content.json` and asserts the same `event.type` with
     `Array.isArray(event.message.content[0].content)`. Both blocks reference the fixture
     filenames in the assertion text so the AC grep gate (`grep -nE 'user_string_content|user_array_content'`)
     passes.
   - `describe('ResultEvent', ...)` — FOUR `it()` blocks, one per subtype. Each loads its
     fixture (`result_success.json`, `result_error_max_turns.json`,
     `result_error_max_budget_usd.json`, `result_error_during_execution.json`) and asserts
     `event.type === 'result'` plus the exact subtype literal (`expect(event.subtype).toBe('success')`,
     etc.). These four literal-equality assertions satisfy the result-subtypes AC.
   - `describe('StreamEvent', ...)` — load `stream_event.json`, assert `event.type === 'stream_event'`
     and `typeof event.event.type === 'string'` (e.g. `'message_start'`, `'content_block_delta'`).
   - `describe('UnknownStreamEvent fallback', ...)` — see step 6.

6. **Add a "rejects unknown payload" test.** Inside `describe('UnknownStreamEvent fallback', ...)`,
   add at least three `it()` blocks asserting the parser never throws:
   - `it('returns __unknown__ for payload with type: never_seen_before', ...)` — pass
     `{ type: 'never_seen_before', foo: 'bar' }`. Assert the result narrows to
     `{ kind: '__unknown__', raw: <the original object> }`, that `expect(() => parseClaudeStreamEvent(...)).not.toThrow()`,
     and that the original payload is preserved on `result.raw`.
   - `it('returns __unknown__ for missing type field', ...)` — pass `{ foo: 'bar' }`.
   - `it('returns __unknown__ for primitives and malformed input', ...)` — call
     `parseClaudeStreamEvent(null)`, `parseClaudeStreamEvent(42)`, `parseClaudeStreamEvent('string')`
     and assert each returns `kind: '__unknown__'` without throwing.

   These cover the AC requiring "missing `type` field, garbage object, primitive" → `__unknown__`.

7. **Add the field-preservation / camelCase exception test.** Inside `describe('SystemInitEvent', ...)`
   (or a dedicated `describe('wire-format casing', ...)` block), assert that after parsing
   `system_init.json`, the parsed object exposes the key literally as `permissionMode`
   (camelCase) — not as `permission_mode`. Use `expect(Object.keys(event)).toContain('permissionMode')`
   and `expect(event).not.toHaveProperty('permission_mode')`. This pins the documented wire-spec
   exception from TASK-101's AC.

8. **Add a passthrough preservation test.** In a dedicated `describe('passthrough', ...)` block,
   take the parsed `system_init.json` fixture, mutate the raw JSON to add a synthetic unknown
   field (e.g. `future_unannounced_field: 'lorem'`), re-parse, and assert
   `expect(event).toHaveProperty('future_unannounced_field', 'lorem')`. This is the AC requiring
   "when a fixture is mutated to add an unknown field, parsing still succeeds AND the unknown
   field is preserved on the parsed object."

9. **Add the compile-time exhaustive switch.** In a dedicated `describe('exhaustive union coverage', ...)`
   block, add an `it()` block that defines an inline function:

   ```ts
   function summarize(event: ClaudeStreamEvent): string {
     switch (event.type) {
       case 'system': return `system/${event.subtype}`;
       case 'assistant': return 'assistant';
       case 'user': return 'user';
       case 'result': return `result/${event.subtype}`;
       case 'stream_event': return 'stream_event';
       default:
         // If a new variant is added to ClaudeStreamEvent without being handled here,
         // tsc --noEmit will fail to compile this line. The catch-all UnknownStreamEvent
         // is reached via the `kind` discriminant branch below.
         if ('kind' in event && event.kind === '__unknown__') return 'unknown';
         return assertNever(event);
     }
   }
   ```

   Call `summarize` against every loaded fixture and assert the return strings are non-empty.
   The runtime assertion is incidental; the load-bearing check is the `assertNever` line that
   only typechecks if the union is fully covered.

10. **Grep verifications.** After authoring, run the AC grep gates directly to confirm:
    - `grep -cE "^\s*(it|test)\(" main/src/services/streamParser/__tests__/schemas.test.ts` — must return ≥ 13.
    - `grep -nE "parseClaudeStreamEvent\(" main/src/services/streamParser/__tests__/schemas.test.ts` — must return ≥ 11 matches.
    - `grep -nE "'__unknown__'|kind.*unknown" main/src/services/streamParser/__tests__/schemas.test.ts` — must hit at least one block whose `it(...)` description references "unknown" or "malformed" or "catch-all".
    - `grep -nE "assertNever" main/src/services/streamParser/__tests__/schemas.test.ts` — must hit ≥ 1.
    - `grep -nE "passthrough|unknown.*field|unrecognized" main/src/services/streamParser/__tests__/schemas.test.ts` — must hit ≥ 1 in a passing assertion context (not a comment).
    - `grep -nE "user_string_content|user_array_content" main/src/services/streamParser/__tests__/schemas.test.ts` — must hit ≥ 2.
    - `grep -nE "'success'|'error_max_turns'|'error_max_budget_usd'|'error_during_execution'" main/src/services/streamParser/__tests__/schemas.test.ts` — must hit all four literals.
    - `ls main/src/services/streamParser/__fixtures__/*.json | wc -l` — must print 11.

11. **Run the suite.** `cd main && pnpm test -- streamParser`. Exit 0, ≥ 13 passing tests.

## Acceptance Criteria

All ten frontmatter AC entries above must hold. The eleven JSON fixtures exist and each parses
as valid JSON. The fixtures README documents the exact `claude -p --output-format stream-json`
capture command and labels each fixture as real or synthetic. The test file holds ≥ 13 `it(...)`
blocks invoking `parseClaudeStreamEvent` ≥ 11 times across the fixture set. The four result
subtypes each get an explicit equality assertion on `event.subtype`. The user variant is
covered with both string-content and array-content fixtures. A dedicated catch-all block
asserts malformed input (missing `type`, garbage object, primitives) returns
`{ kind: '__unknown__', raw: ... }` without throwing. A passthrough block confirms unknown
fields survive parsing. An exhaustive-switch block uses `assertNever` so the file fails to
compile if the union grows without test coverage. `pnpm --filter main test streamParser`
exits 0.

## Test Strategy

This task IS the test suite — it produces the contract tests that make TASK-101 (TS union) and
TASK-102 (Zod schemas) trustworthy. The targets:

- **Per-variant parse round-trip.** Every wire variant gets a fixture and at least one
  assertion that `parseClaudeStreamEvent(fixture).type` matches the expected discriminant.
  This is the lowest-level contract: given a real Claude payload, our parser produces a typed
  event of the right variant.
- **Subtype enumeration on result.** The four result subtypes are the most failure-prone area
  (Anthropic could rename `error_max_turns` to something else in a CLI patch release). Each
  subtype gets its own fixture and its own equality assertion against the literal string. If
  Anthropic renames any of them, exactly one test fails and points directly at the offending
  subtype.
- **tool_result.content shape duality.** Research §1 notes that `user.message.content[].content`
  is sometimes a string and sometimes an array of `{ type, text }`. Both forms get fixtures and
  both forms get parsing assertions; this prevents a future "we only accept strings" regression.
- **Catch-all safety.** Unknown `type` values, missing `type`, primitives, and arbitrary garbage
  all route to `{ kind: '__unknown__', raw }`. This is the firewall: even if Anthropic ships a
  brand-new variant tomorrow, the orchestrator pipeline keeps flowing and we log the unknown
  payload for later schema-update review.
- **Passthrough preservation.** Unknown fields on a known variant are preserved (not stripped).
  If Anthropic adds a new optional field to `system/init`, our parser carries it through to
  downstream consumers (e.g. the `raw_events` table writer) instead of silently dropping it.
- **Compile-time exhaustiveness.** The `assertNever` switch is the tripwire: any future PR that
  adds a new variant to `ClaudeStreamEvent` without extending the switch fails `tsc --noEmit`.

Together these tests form the contract firewall between Anthropic's CLI wire-format evolution
and our internal pipeline. Without them, schema drift would land silently and surface as
mysterious downstream bugs (missing fields in the UI, broken DB writes, dropped events) weeks
later. With them, drift either fails CI or routes through the catch-all variant where it gets
logged and triaged.

## Hardest Decision

**Real captured fixtures vs hand-written synthetic fixtures.** Real captures are the
gold standard: they reflect what the CLI actually emits today, byte-for-byte, including
fields that aren't yet documented in any spec. They also rot — Anthropic ships CLI updates,
the wire format drifts in minor ways, the fixture becomes stale, and tests pass against a
6-month-old snapshot while production breaks against the current CLI. Hand-written
fixtures are the inverse: they encode exactly what the schema claims, are forever in sync
with TASK-101's union, and make the test author's intent obvious in code review — but they
miss undocumented fields and can drift in the opposite direction (the schema says X, the
fixture says X, the wire actually says Y). The choice for this task is hybrid: capture real
fixtures for the 6 variants that are easy to elicit (`system/init`, `assistant`,
`user_string_content`, `user_array_content` where possible, `result_success`, `stream_event`),
and hand-write the 5 that require fault injection or long-session triggering
(`system/api_retry`, `system/compact`, the three error result subtypes). The fixtures README
labels each so the next executor knows which to re-capture quarterly and which to update by
hand when TASK-101's union changes.

## Rejected Alternatives

- **Use Anthropic's published SDK types (`@anthropic-ai/sdk`) as the fixture source of truth.**
  Rejected — the SDK types describe the API request/response shapes, not the CLI's
  `stream-json` wire format. The CLI wire format is documented only in the SamSaffron gist
  referenced by research §1 plus the architecture research itself; there is no first-party
  TypeScript artifact we can reuse. Pulling SDK types would actively mislead because the
  field casing, event names, and subtype enumeration all differ from CLI output.
- **Snapshot testing (Vitest `toMatchSnapshot`) over explicit field assertions.** Rejected —
  snapshots make the failure mode "the JSON changed somewhere, please re-bless" which is
  noisy and hides the load-bearing claims of the contract. Explicit `expect(event.subtype).toBe('success')`
  fails with a clear message pointing at the offending field. Snapshots would also rot
  silently if a developer reflexively runs `vitest -u` after any CLI update.
- **Generate fixtures dynamically by spawning `claude -p` inside the test.** Rejected — would
  introduce network dependency, API key requirement, non-deterministic test runs, and CI
  cost. The whole point of fixtures is offline determinism. The "re-capture quarterly" cadence
  in the README is the explicit safety valve against drift.
- **Skip TS-only assertions (rely on Zod runtime tests only).** Rejected — `assertNever` is
  the only check that catches "PR adds new variant, forgets to extend consumers." Without it,
  a missing branch would compile and silently break at runtime months later.

## Lowest Confidence Area

**Fixture realism vs current Claude CLI behavior in 2026.** The architecture research §1
captures the wire format as of the research date, but the `claude` CLI is a moving target —
Anthropic ships updates frequently and the wire format has changed at least once in the
public history (the `stream_event` discriminant was renamed from `delta` at some point per
the SamSaffron gist). The fixtures committed in this task reflect the CLI version available
when the executor runs the capture, not necessarily what production users see today.
**Verification path:** during execution, the executor MUST record `claude --version` output
in the fixtures README. After the task ships, set a reminder to re-run the capture roughly
quarterly; diff the new capture against the committed fixture and, if the diff is
non-trivial, file a follow-up task to update TASK-101's union, TASK-102's schemas, and the
fixture set in lockstep. If the executor cannot run a real capture at all (no `claude` CLI
available, no credentials), the synthetic-fixture path documented in step 3 is the fallback
and the fixtures README must label every fixture as synthetic with the schema source cited
(research §1, line references).
