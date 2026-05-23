---
id: TASK-571
title: Add bidirectional TS↔Zod drift bridge to schemas.ts
status: deferred
epic: typed-stream-event-schema
source: compound/SPRINT-004-005
source_sprint: SPRINT-004
depends_on: []
files_owned:
  - main/src/services/streamParser/schemas.ts
files_readonly:
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/__tests__/schemas.test.ts
acceptance_criteria:
  - criterion: "A reverse compile-time guard exists immediately below the existing `_typeCheck` declaration in `schemas.ts`, of the form `const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as ClaudeStreamEvent; void _reverseCheck;`. The guard fires a TypeScript error if a field is added to `ClaudeStreamEvent` (`shared/types/claudeStream.ts`) but missing from `claudeStreamEventSchema`."
    verification: "grep -nE 'const _reverseCheck: z\\.infer<typeof claudeStreamEventSchema> = \\{\\} as ClaudeStreamEvent' main/src/services/streamParser/schemas.ts returns exactly 1 match; grep -nE 'void _reverseCheck' main/src/services/streamParser/schemas.ts returns exactly 1 match."
  - criterion: Both compile-time guards (`_typeCheck` and `_reverseCheck`) sit adjacent in `schemas.ts` with a brief JSDoc comment explaining the bidirectional drift contract.
    verification: "grep -nB2 -A1 '_reverseCheck' main/src/services/streamParser/schemas.ts shows a comment explaining the bridge above the declaration."
  - criterion: "`pnpm typecheck` passes (i.e. the schema currently matches the TS union — the reverse bridge is satisfied by the current code)."
    verification: Exit code 0.
  - criterion: "`pnpm --filter main exec vitest run` passes (no behavioral regression)."
    verification: Exit code 0.
estimated_complexity: low
test_strategy:
  needed: false
  justification: "The reverse-check IS the test — it is a compile-time tripwire enforced by `tsc --noEmit` (run via `pnpm typecheck`). A runtime test would only re-prove what the compiler proves. Sibling test `main/src/services/streamParser/__tests__/schemas.test.ts` exists (verified) but its tests exercise `parseClaudeStreamEvent` round-trips, not the drift bridge itself — touching only `schemas.ts` (not exports, signatures, or behavior) cannot affect those tests, so `needed: false` is safe. The CLAUDE.md 'Compile-Time Assertions in ACs' principle applies: `pnpm typecheck` is the verification command."
prerequisites: []
---
# Add bidirectional TS↔Zod drift bridge

## Problem

`main/src/services/streamParser/schemas.ts:256-257` has one-way drift
protection:

```ts
const _typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>;
void _typeCheck;
```

This asserts `z.infer<schema>` is assignable to `ClaudeStreamEvent`. But
`z.infer` is structurally a *subtype* of `ClaudeStreamEvent`, so a field
added to the TS union (e.g. a new optional field on `ResultEvent`) that
is missing from the Zod schema still passes the bridge — the runtime
silently drops the field on parse. Concrete risk: any future Anthropic
wire-spec extension expressed in TS first will be stripped at the schema
layer without a build failure.

## Proposed Direction (Implementation Steps)

1. **Pre-flight probe** (5i: probe-and-reconcile). Confirm the current
   state of `schemas.ts:256-257`:
   ```
   grep -nB1 -A2 '_typeCheck' main/src/services/streamParser/schemas.ts
   ```
   Expected output: lines 252-257 show the comment + `const _typeCheck: …`
   + `void _typeCheck;`. (Probe passed at plan-time. Probe is for the
   executor to confirm before editing.)

2. Open `main/src/services/streamParser/schemas.ts`. Below the existing
   `void _typeCheck;` line (line 257), add:

   ```ts
   // Reverse bridge: assert ClaudeStreamEvent is assignable to z.infer<schema>.
   // Together with _typeCheck above, this forces TS↔Zod to stay structurally
   // equal — fields added to the TS union but missing from the Zod schema
   // (or vice versa) produce a `tsc --noEmit` error at this line.
   const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as ClaudeStreamEvent;
   void _reverseCheck;
   ```

3. Run `pnpm typecheck`. Two possible outcomes:
   - **Exit 0** — TS↔Zod are already in sync. Done.
   - **Exit non-zero with a type error on the `_reverseCheck` line** —
     this is the bridge catching real drift: some field is in
     `ClaudeStreamEvent` but missing from `claudeStreamEventSchema` (or
     a Zod-schema constraint is tighter than the TS type, e.g. a Zod
     `z.string()` vs a TS `string | undefined`). Per planner rule 5i,
     reconcile by either (a) widening the Zod schema, or (b) tightening
     the TS type — but do NOT commit a known-broken bridge. If neither
     side is obviously wrong, stop and report the diff for human review
     (this is an acceptable outcome — the bridge has done its job).

4. Run `pnpm --filter main exec vitest run`. Expected: green. The
   change is type-only; no runtime impact.

5. Commit.

## Acceptance Criteria

(See frontmatter.)

## Test Strategy

No new tests. The reverse-check is a compile-time tripwire. `pnpm typecheck`
verifies it. Per CLAUDE.md "Compile-Time Assertions in ACs", the
verification command list MUST include `pnpm typecheck` and it does.

## Hardest Decision

**Two-line bridge vs. derive `ClaudeStreamEvent` from `z.infer`.** The
compounder offered both paths:
- **(A) Two-line bridge** (chosen): adds `_reverseCheck` next to `_typeCheck`.
  Zero impact on consumers, zero refactor. Drift surface is bounded by the
  bridge but the two definitions still exist independently.
- **(B) `export type ClaudeStreamEvent = z.infer<typeof claudeStreamEventSchema>`.**
  Eliminates the drift surface entirely — Zod becomes the single source of
  truth. Cost: all 50+ consumers of `ClaudeStreamEvent` (in main, shared,
  frontend) now compile-depend on Zod's inferred types, which can be
  brittle when discriminated unions are involved (`z.discriminatedUnion`
  inference has known quirks per the existing comment on line 233-241).
  Bigger blast radius, bigger churn, harder to revert.

(A) is the documented low-risk fast path in the compounder. (B) is
correct end-state design but out of scope for one task.

## Rejected Alternatives

- **(B) above.** Rejected for blast radius and the Zod 3.x quirk noted in
  the existing comment block. Would flip if a subsequent drift incident
  proves the two-line bridge is insufficient — e.g. a field that's
  type-compatible but semantically diverged (Zod accepts a value the TS
  type "permits" but the team didn't intend).
- **Runtime drift test (e.g. `Object.keys(schema.shape)` vs. `keyof`
  TS type).** Considered but rejected: Zod's discriminated unions don't
  expose a flat `.shape` and the test would have to reverse-engineer
  Zod internals. Compile-time guard is cleaner.

## Lowest Confidence Area

Whether step 3 surfaces a real drift error. The compounder claims TS and
Zod are currently in sync, and the file `schemas.ts` was authored against
the TS types in `shared/types/claudeStream.ts` (TASK-102). But the Zod
schema uses `.passthrough()` extensively, which makes it accept *more*
than the TS type declares, while the TS type might declare optional fields
the Zod schema doesn't enumerate. Concrete example: the TS
`SystemInitEvent.claude_code_version?: string` (line 73) is declared in
the Zod schema (`claude_code_version: z.string().optional()` on line 64),
so OK. But every TS interface should be audited. If step 3 surfaces real
drift, the bridge has done its job and the reconciliation is a separate
task — NOT something this plan should silently fix without surfacing.
