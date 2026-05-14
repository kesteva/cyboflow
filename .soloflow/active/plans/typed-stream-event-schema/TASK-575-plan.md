---
id: TASK-575
title: Delete parseClaudeStreamEvent after pipeline wiring lands
status: ready
epic: typed-stream-event-schema
source: compound/SPRINT-004-005
source_sprint: SPRINT-004, SPRINT-005
depends_on: [TASK-572]
files_owned:
  - main/src/services/streamParser/schemas.ts
  - main/src/services/streamParser/__tests__/schemas.test.ts
files_readonly:
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/index.ts
acceptance_criteria:
  - criterion: "Pre-flight gate (must pass before edits) — `parseClaudeStreamEvent` has zero production callers."
    verification: "grep -rn 'parseClaudeStreamEvent' main/src --include='*.ts' | grep -v __tests__ | grep -v 'streamParser/schemas.ts' returns 0 matches."
  - criterion: "`parseClaudeStreamEvent` is removed from `main/src/services/streamParser/schemas.ts` (including its leading JSDoc, the function body, and the `console.warn` call inside it)."
    verification: "grep -n 'export function parseClaudeStreamEvent' main/src/services/streamParser/schemas.ts returns 0 matches; grep -n 'console.warn' main/src/services/streamParser/schemas.ts returns 0 matches."
  - criterion: "`schemas.test.ts` is updated to exercise `TypedEventNarrowing.narrow()` instead of `parseClaudeStreamEvent`. The same fixture coverage (≥11 fixtures, every wire variant, both tool_result content shapes, all 4 result subtypes, malformed input, primitive inputs, passthrough preservation) is preserved."
    verification: "grep -nE 'new TypedEventNarrowing|narrower\\.narrow\\(' main/src/services/streamParser/__tests__/schemas.test.ts returns >= 11 matches (one per former parseClaudeStreamEvent call); grep -n 'parseClaudeStreamEvent' main/src/services/streamParser/__tests__/schemas.test.ts returns 0 matches."
  - criterion: "The doc comment at the top of `schemas.ts` is updated to reflect that runtime validation is provided by `TypedEventNarrowing.narrow()` (consumed via the streamParser barrel), not by a `parseClaudeStreamEvent` function in this file."
    verification: "grep -n 'parseClaudeStreamEvent' main/src/services/streamParser/schemas.ts returns 0 matches; the file's top-of-module JSDoc references `TypedEventNarrowing` instead."
  - criterion: "`pnpm typecheck` and `pnpm --filter main exec vitest run main/src/services/streamParser/__tests__/schemas.test.ts` pass."
    verification: "Exit code 0 for both."
estimated_complexity: low
test_strategy:
  needed: true
  justification: "The sibling test `schemas.test.ts` is the single consumer of `parseClaudeStreamEvent` and must be rewritten as part of this task — the old test surface dies with the function. The rewrite is functionally equivalent (same fixtures, same assertions, different entry point) but is mandatory."
  targets:
    - behavior: "Each of the 11+ fixtures parses through `TypedEventNarrowing.narrow()` and produces the same narrowed event variant the old `parseClaudeStreamEvent` produced."
      test_file: "main/src/services/streamParser/__tests__/schemas.test.ts"
      type: unit
    - behavior: "Malformed / unknown-discriminant input falls through to `{ kind: '__unknown__', raw }` via `narrow()`, matching the prior `parseClaudeStreamEvent` contract."
      test_file: "main/src/services/streamParser/__tests__/schemas.test.ts"
      type: unit
prerequisites:
  - check: "ls .soloflow/archive/done/wire-sprint-005-services/TASK-572-done.md 2>/dev/null"
    fix: "Wait for TASK-572 (B5 — pipeline wiring) to complete before starting this task. Re-run `grep -rn 'parseClaudeStreamEvent' main/src --include='*.ts' | grep -v __tests__ | grep -v 'streamParser/schemas.ts'` — must return 0 production matches."
    description: "B8 is gated on B5: deleting parseClaudeStreamEvent before pipeline wiring lands would leave the legacy function as the only safeParse path, which is the opposite of the desired end state."
    blocking: true
---

# Delete parseClaudeStreamEvent — eliminate dual safeParse implementations

## Problem

Two implementations of the same safeParse-and-fallback-to-`__unknown__`
contract exist:
- `parseClaudeStreamEvent` in `main/src/services/streamParser/schemas.ts:270`
  — logs via `console.warn` directly; exercised only by `schemas.test.ts`.
- `TypedEventNarrowing.narrow()` in
  `main/src/services/streamParser/typedEventNarrowing.ts:35` — same
  contract; logs via an injected `IDebugLogger.verbose()`.

The legacy `parseClaudeStreamEvent` carries the `console.warn`-vs-`Logger`
inconsistency flagged by FIND-SPRINT-004-6. After B5 wires
`TypedEventNarrowing` into the production pipeline, the legacy function has
no production caller. Keeping both invites a future agent to call the
legacy function (with its console.warn channel) instead of going through
the narrower.

## Proposed Direction (Implementation Steps)

1. **Pre-flight gate (BLOCKING)** — re-run the no-caller check:
   ```
   grep -rn 'parseClaudeStreamEvent' main/src --include='*.ts' | grep -v __tests__ | grep -v 'streamParser/schemas.ts'
   ```
   Must return 0 matches. If non-zero, STOP — TASK-572 has not fully
   wired the new pipeline, deletion is premature.

2. **Open `main/src/services/streamParser/schemas.ts`:**
   - Delete the `parseClaudeStreamEvent` function (lines ~270-290).
   - Delete its leading JSDoc block.
   - Delete the `console.warn(...)` call inside it.
   - Update the top-of-module JSDoc (lines 1-10) to remove the
     `parseClaudeStreamEvent` reference. Replace with something like:
     ```ts
     /**
      * Runtime validation layer for Claude Code's `stream-json` wire events.
      *
      * Type contract: `shared/types/claudeStream.ts`
      *
      * Exports the `claudeStreamEventSchema` Zod schema and compile-time
      * drift bridges (`_typeCheck`, `_reverseCheck`). For runtime parsing of
      * stream events, consume `TypedEventNarrowing.narrow()` from the
      * streamParser barrel — that is the production single-implementation of
      * the safeParse contract.
      */
     ```
   - Keep `claudeStreamEventSchema` (the schema), `_typeCheck`, and
     `_reverseCheck` (added by TASK-571 if landed; otherwise just
     `_typeCheck`).

3. **Rewrite `main/src/services/streamParser/__tests__/schemas.test.ts`:**
   - Replace `import { parseClaudeStreamEvent } from '../schemas';` with:
     ```ts
     import { TypedEventNarrowing } from '../typedEventNarrowing';
     ```
     (or via the barrel: `import { TypedEventNarrowing } from '..';`)
   - At the top of the describe block, add a shared narrower:
     ```ts
     const narrower = new TypedEventNarrowing(/* no logger — silent narrow */);
     ```
   - For each existing `parseClaudeStreamEvent(raw)` call, replace with
     `narrower.narrow(raw)`. The return type and contract are identical.
   - The compile-time exhaustive-switch test that uses `assertNever` (around
     line 360) stays — it imports `assertNever` from `shared/types/claudeStream`,
     not from `schemas.ts`.
   - The malformed-input tests assert non-throw — `narrower.narrow()` has
     the same never-throw contract.

4. Run `pnpm typecheck` and
   `pnpm --filter main exec vitest run main/src/services/streamParser/__tests__/schemas.test.ts`.
   Both must pass.

5. **Re-run the step-1 grep** PLUS a `parseClaudeStreamEvent` grep across
   the whole repo to confirm no stragglers:
   ```
   grep -rn 'parseClaudeStreamEvent' main/src frontend/src shared --include='*.ts' --include='*.tsx'
   ```
   Expected: 0 matches.

## Acceptance Criteria

(See frontmatter.)

## Test Strategy

Rewrite `schemas.test.ts` to import and exercise `TypedEventNarrowing.narrow()`
instead of `parseClaudeStreamEvent`. Same fixture corpus, same assertions,
different entry point. The test_strategy targets in frontmatter enumerate
the two behavioral classes (fixture-driven variant narrowing + malformed
input fall-through to `__unknown__`).

## Hardest Decision

**Whether `schemas.test.ts` should be deleted entirely or rewritten.**
The test file's premise was "exercise `parseClaudeStreamEvent`" — once that
function is gone, the test file's title is wrong. Two paths:
- **(A) Rewrite in place** (chosen). Same fixture coverage, just different
  call site. The fixtures themselves remain valuable. Title/comments
  updated.
- **(B) Delete `schemas.test.ts` entirely and merge its fixtures into
  `typedEventNarrowing.test.ts`.** Cleaner end state — there's already a
  `typedEventNarrowing.test.ts`, so the consolidation is natural. But it's
  ~360 lines of merge work and risks losing test cases in translation.

(A) is the smaller-blast-radius option and preserves the fixture-driven
test as a contract-locking suite for the schema itself (independent of
the narrower wrapper).

## Rejected Alternatives

- **Keep `parseClaudeStreamEvent` as a thin wrapper around
  `TypedEventNarrowing.narrow()`.** Considered. It would resolve the
  `console.warn` inconsistency (by routing the wrapper through a real
  Logger). But it preserves the dual-import-surface and lets future
  agents pick the older one. The compounder explicitly recommends deletion
  after wiring lands. Would flip only if a downstream consumer that we
  cannot retire keeps importing the wrapper.
- **(B) above — full test-file merge.** Rejected for scope.

## Lowest Confidence Area

The top-of-module JSDoc rewrite (step 2). The exact text isn't load-bearing
and the executor should use judgment. The risk is that the new doc
under-sells what's left in `schemas.ts` (still the canonical Zod schema
and the two drift bridges) and a future maintainer wonders why this file
exists. The rewrite should explicitly call out: (1) `claudeStreamEventSchema`
is the runtime validation, (2) `_typeCheck`/`_reverseCheck` are the
TS↔Zod drift bridges, (3) production callers go through `TypedEventNarrowing`.
