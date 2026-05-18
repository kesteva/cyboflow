---
id: TASK-629
idea: SPRINT-014-COMPOUND
status: ready
created: "2026-05-17T00:00:00Z"
files_owned:
  - main/src/utils/devDebugLog.ts
  - main/src/utils/devDebugLog.test.ts
  - main/src/index.ts
files_readonly:
  - .soloflow/archive/done/crystal-cuts-and-rebrand/TASK-566-done.md
acceptance_criteria:
  - criterion: "devDebugLog.ts exports `formatConsoleArgs(args: unknown[]): string`"
    verification: "grep -nE 'export function formatConsoleArgs' main/src/utils/devDebugLog.ts returns exactly 1 match"
  - criterion: "All 5 console overrides in main/src/index.ts call formatConsoleArgs(args)"
    verification: "grep -nE 'formatConsoleArgs\\(args\\)' main/src/index.ts returns at least 5 matches"
  - criterion: "Inline duplicated args-to-string formatter is eliminated from console overrides"
    verification: "grep -cE 'args\\.map\\(arg' main/src/index.ts returns at most 1 (the renderer-error handler at index.ts:236 may retain its own formatter)"
  - criterion: "Error-instance extraction (`args.find(arg => arg instanceof Error)`) preserved in console.error and console.warn callers"
    verification: "grep -nE 'args\\.find\\(arg => arg instanceof Error\\)' main/src/index.ts returns at least 2 matches"
  - criterion: "devDebugLog.test.ts has new tests for formatConsoleArgs (string, object, Error, circular, null/undefined)"
    verification: "cd main && pnpm vitest run src/utils/devDebugLog.test.ts exits 0 with >= 8 tests"
  - criterion: "pnpm typecheck and pnpm lint pass"
    verification: "pnpm typecheck && pnpm lint exit 0"
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "Adds a public formatter on the dev-debug logging path with branches (object/Error/circular) that are easy to regress."
  targets:
    - behavior: "joins string args with single spaces"
      test_file: main/src/utils/devDebugLog.test.ts
      type: unit
    - behavior: "JSON-stringifies plain objects with 2-space indent"
      test_file: main/src/utils/devDebugLog.test.ts
      type: unit
    - behavior: "renders Error instances as `Error: {message}\\nStack: {stack}`"
      test_file: main/src/utils/devDebugLog.test.ts
      type: unit
    - behavior: "handles circular-structure objects without throwing"
      test_file: main/src/utils/devDebugLog.test.ts
      type: unit
    - behavior: "handles null/undefined via String()"
      test_file: main/src/utils/devDebugLog.test.ts
      type: unit
---
# Extract formatConsoleArgs to deduplicate 5 console-override formatters in index.ts

## Objective

TASK-566 centralized path and log-line formatting into devDebugLog.ts but left ~60 lines of duplicated args-to-string formatter code across the 5 console method overrides (log/error/warn/info/debug) in main/src/index.ts. Extract `formatConsoleArgs(args: unknown[]): string` alongside the existing devDebugLog helpers and collapse the 5 overrides to use it.

## Implementation Steps

1. **Read `main/src/index.ts:245-437`** to confirm the formatter shape. `console.log` uses a simpler version; the other 4 (error, warn, info, debug) use the full version with Error formatting and circular-structure try/catch. Promote all 5 to the full version (Error + circular) — strict improvement.

2. **Add `formatConsoleArgs` to `main/src/utils/devDebugLog.ts`** alongside existing helpers:
   ```ts
   export function formatConsoleArgs(args: unknown[]): string {
     return args
       .map((arg) => {
         if (typeof arg === 'object' && arg !== null) {
           if (arg instanceof Error) {
             return `Error: ${arg.message}\nStack: ${arg.stack}`;
           }
           try {
             return JSON.stringify(arg, null, 2);
           } catch {
             return `[Object with circular structure: ${arg.constructor?.name || 'Object'}]`;
           }
         }
         return String(arg);
       })
       .join(' ');
   }
   ```

3. **Update index.ts import** to include `formatConsoleArgs`.

4. **Replace each of the 5 inline formatters** with `const message = formatConsoleArgs(args);`. Leave the `args.find(arg => arg instanceof Error)` extraction in place at console.error and console.warn — that's orthogonal (passing Error to logger.error), not part of string formatting.

5. **Extend devDebugLog.test.ts** with 5 new test cases per test_strategy.targets.

6. **Run `pnpm typecheck && pnpm lint && cd main && pnpm vitest run src/utils/devDebugLog.test.ts`** — all 0/green.

## Hardest Decision

Whether to promote `console.log`'s simpler formatter to the full Error+circular version. Promoting is a strict improvement — chose promotion. Manual confirmation step in `pnpm dev` is the safety net.

## Lowest Confidence Area

The `args.map(arg` match count AC allows ≤1 to permit the legitimate renderer-error handler formatter at index.ts:236 (separate concern from the 5 console overrides). Verify count before reporting COMPLETED.
