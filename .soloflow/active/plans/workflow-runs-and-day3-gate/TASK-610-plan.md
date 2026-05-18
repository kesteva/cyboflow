---
id: TASK-610
idea: SPRINT-009-compound
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - main/src/ipc/cyboflow.ts
files_readonly:
  - main/src/utils/logger.ts
  - main/src/orchestrator/types.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "makeLoggerLike's info/warn/error/debug methods accept and forward the optional `context` second argument by stringifying it as JSON when present"
    verification: "grep -nE 'ctx\\?: |context\\?:|JSON.stringify' main/src/ipc/cyboflow.ts returns at least 4 matches in the makeLoggerLike body (one per level: info, warn, error, debug)"
  - criterion: "When context is undefined/null/empty, no extra trailing whitespace or token is appended (the message is logged as-is)"
    verification: "grep -nE 'ctx \\? .*JSON.stringify' main/src/ipc/cyboflow.ts returns at least 3 matches showing the ternary `ctx ? \\`${msg} ${JSON.stringify(ctx)}\\` : msg` pattern"
  - criterion: The fix is bounded to the inline shim in cyboflow.ts; the Logger class signatures remain unchanged
    verification: "grep -nE 'info\\(message: string\\)|warn\\(message: string, error\\?: Error\\)' main/src/utils/logger.ts returns the unchanged signatures (no new `context` parameter on the Logger class)"
  - criterion: Existing tests still pass (no semantic regression)
    verification: pnpm --filter main test exits 0
depends_on: []
estimated_complexity: low
epic: workflow-runs-and-day3-gate
test_strategy:
  needed: false
  justification: "makeLoggerLike is a private function inside main/src/ipc/cyboflow.ts with no existing test coverage (it isn't exported, and cyboflow.test.ts uses its own makeSilentLogger fixture). Adding a unit test would require either exporting makeLoggerLike (bloating the surface) or constructing a real `services` object with a real `Logger` (heavy fixture). The fix is a 4-line edit per existing pattern, easy to code-review. The behavior is exercised end-to-end by any cyboflow IPC handler that calls registry.seed() with a context arg — the existing logger.warn call in WorkflowRegistry.seed (which DOES pass a context) is the live consumer, so any regression would surface as missing context in the log file at runtime."
---
# Fix makeLoggerLike() — forward the context second argument

## Objective

`main/src/ipc/cyboflow.ts:46-51` defines `makeLoggerLike` as a `LoggerLike` adapter over the `Logger` class, but each forwarded method drops the `context` parameter on the floor: `info: (msg) => logger.info(msg)`. Callers like `WorkflowRegistry.seed` (line 124-127) pass a context object with `path` and `error` fields that never make it to the log file. Per the finding, the fix is a bounded inline shim: stringify the context when present and append it to the message. Do NOT widen the `Logger` class signature — keep the change inside `makeLoggerLike`.

## Implementation Steps

1. Open `main/src/ipc/cyboflow.ts:34-52`. The current `makeLoggerLike` body has:
   ```ts
   const logger = services.logger;
   return {
     info:  (msg) => logger.info(msg),
     warn:  (msg) => logger.warn(msg),
     error: (msg) => logger.error(msg),
     debug: (msg) => console.debug(msg),
   };
   ```
2. Replace each forwarder to accept and forward the optional context arg:
   ```ts
   const logger = services.logger;
   const fmt = (msg: string, ctx?: Record<string, unknown>) =>
     ctx && Object.keys(ctx).length > 0 ? `${msg} ${JSON.stringify(ctx)}` : msg;
   return {
     info:  (msg, ctx) => logger.info(fmt(msg, ctx)),
     warn:  (msg, ctx) => logger.warn(fmt(msg, ctx)),
     error: (msg, ctx) => logger.error(fmt(msg, ctx)),
     debug: (msg, ctx) => console.debug(fmt(msg, ctx)),
   };
   ```
3. Verify the `LoggerLike` interface signatures (`main/src/orchestrator/types.ts:42-45`) accept `(message: string, context?: Record<string, unknown>) => void` for all four methods — they do, so the tightened signatures here are compatible.
4. Verify the no-context fallback path also works:  the inner `if (!services.logger)` branch (lines 35-42) already forwards context correctly to `console.info`/`console.warn`/etc.; no change needed there.
5. Cross-task coordination: if TASK-608 (B11) lands FIRST and moves `makeLoggerLike` to `main/src/orchestrator/loggerAdapter.ts`, this task's edit must apply to the new file location. If TASK-610 lands first, TASK-608's move must include this fix in the moved body. Either order is fine; just verify the resulting `makeLoggerLike` function (wherever it lives post-merge) has both fixes.
6. Run `pnpm --filter main test` and `pnpm --filter main typecheck`. Both must pass.
7. Manual smoke (optional): set `services.logger` to a real `Logger` instance, call `loggerLike.warn('test message', { runId: 'abc', error: 'xyz' })`, and confirm the on-disk log file contains the line `WARN: test message {"runId":"abc","error":"xyz"}`.

## Acceptance Criteria

See frontmatter. The fix is intentionally narrow: 4 method bodies + a `fmt` helper, contained entirely in `makeLoggerLike`. No `Logger` class change, no new exports.

## Test Strategy

`needed: false` — see frontmatter justification. The fix is exercised at runtime by `WorkflowRegistry.seed`'s WARN call when a workflow .md file is missing (a path that TASK-601 will also exercise). Adding a unit test for the private adapter is more cost than benefit.

## Hardest Decision

Whether to JSON-stringify the context vs. append it as a `key=value` flat string. Picked JSON.stringify because (a) it preserves nested structure (a context with `error: { message, stack }` doesn't lose information), (b) it matches the convention used by `console.info(msg, ctx)` in JavaScript, (c) it's parseable by log aggregation tools. The cost is slightly noisier log lines; acceptable given the existing log file is line-oriented JSON-friendly.

## Rejected Alternatives

- **Widen the `Logger` class to accept `(message: string, context?: Record<string, unknown>)`.** Rejected per the finding — bounded inline shim is the right scope. Widening Logger would ripple through every call site of `logger.info/warn/error` in the codebase, most of which don't pass context.
- **Use `util.inspect` instead of `JSON.stringify` for nicer formatting of Errors and circular refs.** Rejected because `util.inspect` is a heavier dep and the typical context shapes in this codebase are plain objects without circular refs. JSON.stringify is sufficient.

## Lowest Confidence Area

Whether `JSON.stringify` will throw on a context object containing an `Error` instance (Errors don't serialize nicely — they become `{}`). The finding's example call site (`WorkflowRegistry.seed` line 124-127) passes `error: err instanceof Error ? err.message : String(err)` — already a string — so the immediate consumer is safe. If a future call site passes a raw Error object, `JSON.stringify` will return `{}` and lose the error content; that future task should pre-stringify or use a custom replacer. Add a one-line comment in `fmt` warning about Error serialization.
