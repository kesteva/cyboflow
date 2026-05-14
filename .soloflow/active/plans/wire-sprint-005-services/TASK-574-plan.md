---
id: TASK-574
title: Consolidate streamParser logger interfaces into shared ILogger
status: ready
epic: wire-sprint-005-services
source: compound/SPRINT-004-005
source_sprint: SPRINT-005
depends_on: []
files_owned:
  - main/src/services/streamParser/types.ts
  - main/src/services/streamParser/jsonParser.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/streamParser.ts
  - main/src/services/streamParser/completionDetector.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/index.ts
files_readonly:
  - main/src/utils/logger.ts
  - main/src/services/streamParser/__tests__/jsonParser.test.ts
  - main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts
  - main/src/services/streamParser/__tests__/streamParser.test.ts
  - main/src/services/streamParser/__tests__/completionDetector.test.ts
  - main/src/services/streamParser/__tests__/rawEventsSink.test.ts
  - main/src/services/streamParser/__tests__/messageProjection.test.ts
acceptance_criteria:
  - criterion: "A new file `main/src/services/streamParser/types.ts` exists and exports a single `ILogger` interface with the union of methods needed across the streamParser pipeline: `warn(message: string): void; info?(message: string): void; verbose?(message: string): void;`. The exact shape is structurally compatible with the project's `main/src/utils/logger.ts` `Logger` class so a real `Logger` instance is assignable to `ILogger`."
    verification: "grep -nE 'export interface ILogger' main/src/services/streamParser/types.ts returns 1 match; the interface body includes `warn(`, `info?(`, and `verbose?(`."
  - criterion: "Each of the six per-file logger interfaces is REMOVED from its origin file: `IWarnLogger` (jsonParser.ts), `IDebugLogger` (typedEventNarrowing.ts), `IStreamParserLogger` (streamParser.ts), `ICompletionDetectorLogger` (completionDetector.ts), `IRawEventsSinkLogger` (rawEventsSink.ts), `IMessageProjectionLogger` (messageProjection.ts). Each file's class constructor now accepts `ILogger | undefined` (or a narrower `Pick<ILogger, 'warn'>` alias) from the shared `./types` module."
    verification: "grep -nE 'export interface (IWarnLogger|IDebugLogger|IStreamParserLogger|ICompletionDetectorLogger|IRawEventsSinkLogger|IMessageProjectionLogger)' main/src/services/streamParser/ returns 0 matches across the streamParser directory."
  - criterion: "The barrel export `main/src/services/streamParser/index.ts` exports `ILogger` from `./types` and no longer re-exports the six removed per-file logger types."
    verification: "grep -nE \"export type \\{ ILogger \\} from './types'\" main/src/services/streamParser/index.ts returns 1 match; grep -nE 'export type \\{ (IWarnLogger|IDebugLogger|IStreamParserLogger|ICompletionDetectorLogger|IRawEventsSinkLogger|IMessageProjectionLogger) \\}' main/src/services/streamParser/index.ts returns 0 matches."
  - criterion: "All sibling tests (`jsonParser.test.ts`, `typedEventNarrowing.test.ts`, `streamParser.test.ts`, `completionDetector.test.ts`, `rawEventsSink.test.ts`, `messageProjection.test.ts`) continue to pass without modification. Each test instantiates its class with an inline-object mock logger that satisfies the new `ILogger` shape (the existing inline mocks already satisfy the union)."
    verification: "`pnpm --filter main exec vitest run main/src/services/streamParser/__tests__/` exits 0."
  - criterion: "`pnpm typecheck` passes."
    verification: "Exit code 0."
estimated_complexity: low
test_strategy:
  needed: false
  justification: "This is a type-surface consolidation — no runtime behavior changes. Six sibling tests exist (jsonParser.test.ts, typedEventNarrowing.test.ts, streamParser.test.ts, completionDetector.test.ts, rawEventsSink.test.ts, messageProjection.test.ts). Each test already instantiates the class under test with an inline-object mock logger (e.g. `{ warn: vi.fn() }`). The new ILogger union is structurally compatible — `Pick<ILogger, 'warn'>` is exactly the shape those mocks already satisfy. Tests are guaranteed green if the type-surface change preserves: (1) parameter position of logger in each constructor (yes, last param in all 6), (2) optionality (yes, all 6 are optional). If a test fails after the refactor, it's a real bug not a mock-drift issue. Sibling-test scan satisfied: all 6 sibling tests are explicitly listed in files_readonly and the constructor surface is preserved by step 4's discipline."
prerequisites: []
---

# Consolidate streamParser logger interfaces

## Problem

Six per-file logger interfaces exist in `main/src/services/streamParser/`:
- `IWarnLogger` — `jsonParser.ts:13` — `{ warn(msg: string): void }`
- `IDebugLogger` — `typedEventNarrowing.ts:13` — `{ verbose?(msg: string): void }`
- `IStreamParserLogger` — `streamParser.ts:18` — `{ warn(msg: string): void; verbose?(msg: string): void }`
- `ICompletionDetectorLogger` — `completionDetector.ts:25` — `{ info(msg: string): void; warn(msg: string): void }`
- `IRawEventsSinkLogger` — `rawEventsSink.ts:30` — `{ warn(msg: string): void }`
- `IMessageProjectionLogger` — `messageProjection.ts:26` — `{ warn(msg: string): void }`

Three are structurally identical (`IWarnLogger`, `IRawEventsSinkLogger`,
`IMessageProjectionLogger`). All six can be reduced to method-projections
of a single `ILogger` union shape. The project's actual `Logger` class
(`main/src/utils/logger.ts:16`) already implements `warn`, `info`,
`verbose`, `error` — all `(message: string) => void`. The new `ILogger`
should be a structural projection of that class, so a real `Logger`
instance is assignable.

## Proposed Direction (Implementation Steps)

1. **Pre-flight grep** (completeness gate):
   ```
   grep -nE 'export interface (IWarnLogger|IDebugLogger|IStreamParserLogger|ICompletionDetectorLogger|IRawEventsSinkLogger|IMessageProjectionLogger)' main/src/services/streamParser/
   ```
   Records the six current declarations. After the refactor, the same
   grep must return 0 matches.

2. **Create the shared types module.** New file
   `main/src/services/streamParser/types.ts`:

   ```ts
   /**
    * Shared types for the streamParser pipeline.
    *
    * ILogger is structurally compatible with main/src/utils/logger.ts's Logger class —
    * any real Logger instance is assignable. Use Pick<ILogger, 'warn'> in classes
    * that only need warn() to keep the contract explicit.
    */
   export interface ILogger {
     warn(message: string): void;
     info?(message: string): void;
     verbose?(message: string): void;
   }
   ```

3. **Refactor each of the six implementation files.** Pattern per file:
   - Delete the `export interface I<Name>Logger { … }` block.
   - At the top, add `import type { ILogger } from './types';`
   - Update the class constructor's logger parameter type from
     `I<Name>Logger | undefined` to either `ILogger | undefined` (if the
     class uses multiple methods) or `Pick<ILogger, 'warn'> | undefined`
     (if it only uses `warn`).
   - The private field's type follows the same pattern.

   Specifically:
   - **jsonParser.ts**: `Pick<ILogger, 'warn'> | undefined`.
   - **typedEventNarrowing.ts**: `Pick<ILogger, 'verbose'> | undefined`
     (note: existing interface is verbose-only; preserve the narrow surface).
   - **streamParser.ts**: `ILogger | undefined` (uses warn + verbose).
   - **completionDetector.ts**: `ILogger | undefined` (uses info + warn).
     Note: the existing `ICompletionDetectorLogger` has `info` as REQUIRED,
     while the shared `ILogger.info` is OPTIONAL. Keep the existing
     behavior — `completionDetector.ts:132,153` already uses `logger?.info`
     (optional chaining), so the optional-on-shared-interface is fine.
   - **rawEventsSink.ts**: `Pick<ILogger, 'warn'> | undefined`.
   - **messageProjection.ts**: `Pick<ILogger, 'warn'> | undefined`.

4. **Update the barrel `index.ts`:**
   - Remove the six `export type { I<Name>Logger } from './<file>';` lines.
   - Add `export type { ILogger } from './types';`
   - The seven class exports (`LineBufferer`, `JSONParser`,
     `TypedEventNarrowing`, `EventRouter`, `ClaudeStreamParser`,
     `CompletionDetector`, `RawEventsSink`, `MessageProjection`) stay
     unchanged.
   - The two payload-type exports from completionDetector
     (`CompletionPayload`, `ForcedPayload`) stay unchanged.

5. **Run `pnpm typecheck`.** Expected: 0 errors. If a test or downstream
   caller imported any of the deleted interfaces by name, the typecheck
   surfaces it — add the file to `files_owned` if needed and update the
   import to use `ILogger`.

6. **Run `pnpm --filter main exec vitest run main/src/services/streamParser/__tests__/`.**
   Expected: all six sibling tests green. Mocks like `{ warn: vi.fn() }`
   structurally satisfy `Pick<ILogger, 'warn'>`.

7. **Re-run the step-1 grep.** Expected: 0 matches.

## Acceptance Criteria

(See frontmatter.)

## Test Strategy

No new tests authored. Six sibling tests exist and the refactor is type-only:
the inline mocks in each test (`{ warn: vi.fn() }`, `{ info: vi.fn(),
warn: vi.fn() }`, etc.) already structurally satisfy the new `ILogger`
projections. See test_strategy.justification for the sibling-test analysis.

## Hardest Decision

**Whether to require this task BEFORE B5 (TASK-572) lands or AFTER.** The
compounder's skeptic note flags that "If B5 is sequenced first and naturally
surfaces a single Logger contract via the project's existing Logger service,
this cleanup may be subsumed and become DONT_IMPLEMENT." However:
- B5 wires `claudeCodeManager` into the parser pipeline; if `claudeCodeManager`
  passes its existing `Logger` directly to each class, each class needs to
  accept `Logger` or a compatible shape — that compatibility is *exactly*
  what `ILogger` formalizes.
- If we land this task FIRST, B5's wiring is one line cleaner per
  instantiation site (no per-class adapter struct).
- If we land this task AFTER B5, the consolidation either (a) was already
  forced naturally by B5's instantiation needs (no per-class interfaces
  anymore, this task is a no-op) or (b) B5 wrote six adapter calls and now
  this task removes them.

Chosen: keep this task **before** B5 (no `depends_on` in either direction;
both can land in parallel). If B5 lands first, this task's first step is
a re-run of the grep to confirm the consolidation is still needed.

## Rejected Alternatives

- **Re-export `Logger` directly from `main/src/utils/logger.ts` as the
  canonical type.** Tempting but creates an upward dependency from the
  streamParser module on `utils/logger.ts`. The streamParser module is
  designed to be Logger-instance-agnostic (its constructors take an
  interface, never a `Logger`). Keeping `ILogger` as a structural
  projection preserves that decoupling.
- **One interface per method shape (warn-only, warn+info, warn+verbose,
  verbose-only, etc.).** That's effectively what the current six
  interfaces do, just with worse names. `Pick<ILogger, 'warn'>` and
  friends accomplish the same with one source declaration.
- **Defer until B5 reveals the natural contract.** Rejected per the
  hardest-decision analysis above.

## Lowest Confidence Area

The `completionDetector.ts` decision: existing
`ICompletionDetectorLogger.info` is REQUIRED, but the new
`ILogger.info` is OPTIONAL. The body of `completionDetector.ts` uses
`this.logger?.info(...)` (line 132) — optional chaining — so the
optionality narrowing is a runtime no-op. But this *widens* the contract
for callers (they can now pass a logger without `info`). If any consumer
relied on type-safety that `info` would always be present, that breaks.
Current consumers (zero — orphan class) make this irrelevant. If B5 lands
first and `claudeCodeManager` passes its real `Logger` (which has `info`),
the consumer is fine.
