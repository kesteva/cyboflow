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
   