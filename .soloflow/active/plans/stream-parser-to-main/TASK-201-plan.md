---
id: TASK-201
idea: IDEA-005
idea_id: IDEA-005
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/services/streamParser/index.ts
  - main/src/services/streamParser/lineBufferer.ts
  - main/src/services/streamParser/jsonParser.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/streamParser.ts
  - main/src/services/streamParser/__tests__/lineBufferer.test.ts
  - main/src/services/streamParser/__tests__/jsonParser.test.ts
  - main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts
  - main/src/services/streamParser/__tests__/eventRouter.test.ts
  - main/src/services/streamParser/__tests__/streamParser.test.ts
files_readonly:
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/schemas.ts
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "main/src/services/streamParser/ exists with five module files: lineBufferer.ts, jsonParser.ts, typedEventNarrowing.ts, eventRouter.ts, streamParser.ts, plus an index.ts barrel export."
    verification: "ls main/src/services/streamParser/ shows all six .ts files; node -e \"console.log(Object.keys(require('./dist/main/src/services/streamParser')))\" lists ClaudeStreamParser, EventRouter, LineBufferer, JSONParser, TypedEventNarrowing after pnpm run build:main."
  - criterion: "LineBufferer preserves partial trailing lines across chunk boundaries; feeding 'abc\\ndef\\ngh' followed by 'ij\\n' yields lines ['abc', 'def', 'ghij']."
    verification: "pnpm --filter main test -- lineBufferer.test.ts passes; test asserts the documented chunk-boundary case and an empty-tail case explicitly."
  - criterion: "JSONParser drops malformed JSON lines with a WARN log and never throws. Feeding ['{\"type\":\"system\"}', 'not-json', '{\"type\":\"assistant\"}'] yields two parsed objects and one logged warning."
    verification: "pnpm --filter main test -- jsonParser.test.ts passes; test uses a logger spy to assert exactly one warn() call with the malformed payload truncated to 200 chars; no exception propagates."
  - criterion: "TypedEventNarrowing validates each parsed object against the Zod schema from IDEA-003 (main/src/services/streamParser/schemas.ts). Valid events return their typed variant; unknown discriminants fall through to the unknown catch-all (never throw, never drop)."
    verification: "pnpm --filter main test -- typedEventNarrowing.test.ts passes; test feeds a captured system/init fixture, a captured assistant/tool_use fixture, and a synthetic {type:'not_a_real_type'} payload; first two narrow to their tagged variant, third narrows to {kind:'unknown', raw:{...}}."
  - criterion: "EventRouter exposes per-runId fanout via EventEmitter. Subscribers registered with router.on(runId, handler) only receive events for that runId; broadcast to runId 'A' does not invoke a runId 'B' handler."
    verification: "pnpm --filter main test -- eventRouter.test.ts passes; test registers two handlers on two distinct runIds, dispatches three events, asserts each handler received only its own."
  - criterion: "ClaudeStreamParser orchestrates the pipeline: it accepts raw stdout chunks via .feed(chunk) and emits typed events to its EventRouter. End-to-end test with a fixture stream produces the same event sequence regardless of how the chunks are split."
    verification: "pnpm --filter main test -- streamParser.test.ts passes; test feeds the same captured fixture in 1-byte chunks, in 1024-byte chunks, and in a single chunk, then asserts the three resulting event arrays deep-equal each other."
  - criterion: "Parse errors are logged with logger.warn(), never with logger.error() or thrown. The pipeline continues processing subsequent lines after any malformed input."
    verification: "grep -n \"throw\" main/src/services/streamParser/jsonParser.ts main/src/services/streamParser/typedEventNarrowing.ts returns no matches; jsonParser.test.ts asserts logger.warn is called and logger.error is not, for malformed input."
depends_on: []
estimated_complexity: medium
epic: stream-parser-to-main
test_strategy:
  needed: true
  justification: "This is the core parser pipeline. Each module has nontrivial state (LineBufferer holds partial lines; JSONParser swallows errors; TypedEventNarrowing branches on discriminants; EventRouter routes per-runId). Unit tests are mandatory to lock the chunk-boundary contract and the never-throw contract."
  targets:
    - behavior: "LineBufferer preserves partial trailing lines across chunk boundaries; handles empty input; handles a single chunk with no newline."
      test_file: "main/src/services/streamParser/__tests__/lineBufferer.test.ts"
      type: unit
    - behavior: "JSONParser parses valid JSON, drops malformed input with a WARN, never throws."
      test_file: "main/src/services/streamParser/__tests__/jsonParser.test.ts"
      type: unit
    - behavior: "TypedEventNarrowing routes known discriminants to their variant and unknown ones to the catch-all; uses .passthrough() so extra fields survive."
      test_file: "main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts"
      type: unit
    - behavior: "EventRouter fans out per-runId; handlers do not cross-talk; .removeAllListeners(runId) cleanly tears down a run."
      test_file: "main/src/services/streamParser/__tests__/eventRouter.test.ts"
      type: unit
    - behavior: "ClaudeStreamParser end-to-end: same fixture stream produces identical event sequences regardless of chunk size."
      test_file: "main/src/services/streamParser/__tests__/streamParser.test.ts"
      type: integration
---

# Create main/src/services/streamParser/ parsing pipeline

## Objective

Build the four-stage main-process parser pipeline (LineBufferer → JSONParser → TypedEventNarrowing → EventRouter) that converts Claude Code's raw stdout chunks into typed, per-run events. This is the foundational module other tasks in this epic build on; it must be chunk-boundary-safe, never-throw, and per-runId isolated.

## Implementation Steps

1. Create `main/src/services/streamParser/lineBufferer.ts`. Export a `LineBufferer` class with one method `feed(chunk: string): string[]`. Implementation maintains a private `buffer` string; on each `feed` call, append chunk, split on `'\n'`, hold the last element back as the new buffer, and return all preceding non-empty lines (trimmed of `\r` for CRLF safety). Add a `.flush(): string[]` method that returns and clears any remaining buffered content (for use by completion detector in TASK-202).

2. Create `main/src/services/streamParser/jsonParser.ts`. Export a `JSONParser` class with constructor `(logger?: Logger)`. Method `parse(line: string): unknown | null` runs `JSON.parse(line)` inside a try/catch. On catch, call `this.logger?.warn(\`[streamParser] dropped malformed JSON line: \${line.substring(0, 200)}\`)` and return `null`. The class MUST NOT throw — the catch path is the only exit on failure. Never log to `logger.error()` for parse failures; this is by design (per IDEA-005 constraint: "Parse errors drop with WARN, never throw into the event loop").

3. Create `main/src/services/streamParser/typedEventNarrowing.ts`. Import the Zod schema and `ClaudeStreamEvent` union from `main/src/services/streamParser/schemas.ts` (created by IDEA-003 / TASK family before this epic — listed in `files_readonly`). Export `TypedEventNarrowing` class with method `narrow(parsed: unknown): ClaudeStreamEvent`. Use `claudeStreamEventSchema.safeParse(parsed)`. If success, return `result.data`. If failure (schema mismatch but valid JSON), return `{ kind: 'unknown', raw: parsed }` — do NOT throw, do NOT drop. Log a debug-level message for unknown variants (helpful but not noisy).

4. Create `main/src/services/streamParser/eventRouter.ts`. Export `EventRouter` extending Node's `EventEmitter`. Two methods: `emitForRun(runId: string, event: ClaudeStreamEvent): void` calls `this.emit(runId, event)`; `onRun(runId: string, handler: (event: ClaudeStreamEvent) => void): () => void` calls `this.on(runId, handler)` and returns a teardown function that calls `this.off(runId, handler)`. Add `clearRun(runId: string): void` that calls `this.removeAllListeners(runId)` for shutdown safety.

5. Create `main/src/services/streamParser/streamParser.ts`. Export `ClaudeStreamParser` class with constructor `(runId: string, router: EventRouter, logger?: Logger)`. Internal state: a `LineBufferer`, a `JSONParser`, and a `TypedEventNarrowing` instance. Method `feed(chunk: string): void` runs the chunk through `lineBufferer.feed(chunk)`, then for each line calls `jsonParser.parse(line)`; if non-null, calls `typedEventNarrowing.narrow(parsed)` and dispatches via `router.emitForRun(this.runId, typedEvent)`. Method `flush(): void` runs the same pipeline on any line still buffered (used by completion gate). The parser MUST NOT throw — wrap the per-line loop in a try/catch that logs `logger.warn` and continues to the next line (defensive against bugs in narrowing).

6. Create `main/src/services/streamParser/index.ts` as a barrel that re-exports `LineBufferer`, `JSONParser`, `TypedEventNarrowing`, `EventRouter`, and `ClaudeStreamParser`. This is the single import point downstream code (TASK-202, TASK-203, TASK-205) uses.

7. Write the five test files listed in `files_owned`. Use vitest (already pinned in `main/package.json`). Tests must use captured stream-json fixtures from the TASK family that builds IDEA-003 — those fixtures will land in `main/src/services/streamParser/__fixtures__/` as part of that epic. If those fixtures are not yet present at task-start time, use small inline JSON literals (one for each discriminant) and add a TODO comment referencing IDEA-003 to swap them in. The chunk-boundary test (in `streamParser.test.ts`) is mandatory regardless of fixture state.

## Acceptance Criteria

- All six new files in `files_owned` exist with TypeScript exports.
- Five test files pass under `pnpm --filter main test`.
- `grep -n "throw" main/src/services/streamParser/jsonParser.ts main/src/services/streamParser/typedEventNarrowing.ts` returns no matches (parser is never-throw by contract).
- The chunk-boundary test in `streamParser.test.ts` is the gate: identical event sequences regardless of how stdout is split.

## Test Strategy

See frontmatter `test_strategy.targets`. Five vitest files, one per module plus one end-to-end. The end-to-end test is the load-bearing one: it asserts the chunk-boundary invariant by feeding the same captured stream three ways (1-byte, 1024-byte, single-chunk) and deep-equaling the resulting event arrays. The never-throw invariant is asserted via a logger spy in `jsonParser.test.ts`. Fixtures from IDEA-003's epic should be reused where available; inline literals are a fallback.

## Hardest Decision

How aggressively to validate against the Zod schema vs. trust the parsed JSON. Chose: ALWAYS run `safeParse` and fall back to `{ kind: 'unknown', raw }` rather than `as` casting. The architecture research §1 documents seven concrete schema gaps in the design doc and `system/compact` is undocumented — defensive narrowing is the only correct posture. The cost is one safeParse per event (microseconds); the benefit is no silent data loss on a new variant.

## Rejected Alternatives

- **Embed the parser inside `claudeCodeManager.parseCliOutput()`** (where Crystal currently does inline `JSON.parse`). Rejected because (a) it conflates parsing with CLI lifecycle, (b) keeping the parser as a standalone class lets TASK-205 reuse it for the renderer migration, (c) Crystal's current `parseCliOutput` already does inline `JSON.parse` and emits raw events — that path will be wired by TASK-202/TASK-203 as a consumer, not gutted. Would change my mind if a Crystal contributor confirmed `parseCliOutput` is the canonical hook for ALL stream-json consumers.
- **Use RxJS observables instead of EventEmitter for fanout.** Rejected because Node's EventEmitter is already a project dependency, the design doc assumes EventEmitter-based fanout (IDEA-005 assumptions), and tRPC v11 subscriptions (used by TASK-205) work natively with async generators that wrap EventEmitter. Adding RxJS would be a new top-level dependency for marginal value.
- **Throw on JSON parse failure and let the caller catch.** Rejected — IDEA-005 explicitly forbids it ("Parse errors drop with WARN, never throw into the event loop"). The constraint is grounded in the risks research §10: an unhandled parser exception during a 1-day self-host kills the orchestrator process and every run.

## Lowest Confidence Area

The exact shape of the `ClaudeStreamEvent` union and the Zod schema names exported from `main/src/services/streamParser/schemas.ts`. Those land in a different IDEA's task family (IDEA-003), which I cannot read at refinement time because those tasks have not been executed yet. I have specified `files_readonly: shared/types/claudeStream.ts` and `main/src/services/streamParser/schemas.ts` to make the dependency explicit, and the implementation imports those names. If IDEA-003's task family names them differently (e.g. `streamEventSchema` instead of `claudeStreamEventSchema`), the executor will need a one-line rename in `typedEventNarrowing.ts`. The risk is small but real.
