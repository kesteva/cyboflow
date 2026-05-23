---
id: TASK-656
idea: SPRINT-020
status: in-flight
created: "2026-05-19T00:00:00Z"
files_owned:
  - main/src/services/streamParser/schemas.ts
  - .soloflow/active/plans/typed-stream-event-schema/TASK-571-plan.md
files_readonly:
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/__tests__/schemas.test.ts
  - main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts
  - .soloflow/active/findings/SPRINT-020-findings.md
acceptance_criteria:
  - criterion: "A design decision is recorded at the top of this file (Selected option: 1 / 2 / 3) by the human-in-the-loop before any code change is committed."
    verification: "grep -nE '^Selected option:' .soloflow/active/plans/typed-stream-event-schema/TASK-656-plan.md returns exactly one match with a numeric value."
  - criterion: "Following the selected option, the `_reverseCheck` bridge in `main/src/services/streamParser/schemas.ts` either (Option 1) has a comment explicitly acknowledging the optional-field gap, or (Option 2) is removed in favor of `export type ClaudeStreamEvent = z.infer<...>`, or (Option 3) compiles with the bare `z.infer<typeof claudeStreamEventSchema>` form."
    verification: "Per-option grep: Option 1 → grep -n 'optional-field' main/src/services/streamParser/schemas.ts ≥ 1; Option 2 → grep -nE 'export type ClaudeStreamEvent = z\\.infer' shared/types/claudeStream.ts = 1 AND old hand-authored interfaces gone; Option 3 → grep -nE 'const _reverseCheck: z\\.infer<typeof claudeStreamEventSchema>' schemas.ts = 1."
  - criterion: "TASK-571 is closed: either marked done with an amended AC (Option 1), or superseded by this task with a settle-task human_needed → done transition (Options 2/3)."
    verification: "grep -nE 'status: (done|superseded)' .soloflow/active/plans/typed-stream-event-schema/TASK-571-plan.md returns 1 match."
  - criterion: "`pnpm typecheck` and `pnpm --filter main exec vitest run` pass."
    verification: Exit code 0 for both.
depends_on: []
estimated_complexity: medium
epic: typed-stream-event-schema
test_strategy:
  needed: false
  justification: The decision is itself the work product. Code changes that follow the decision are all type-only or schema-shape-only; `pnpm typecheck` is the verification command and the existing `schemas.test.ts` round-trips already cover the runtime path.
prerequisites: []
---
# Resolve the _reverseCheck bidirectional drift-detection gap

> Selected option: 3 — Drop `.passthrough()` in non-leaf schemas.
> Decided 2026-05-19 (kesteva). Rationale: smallest path that achieves the plan's primary goal of catching both required- and optional-field drift in both directions. The trade-off of losing silent absorption of unknown SDK fields at non-leaf schemas is acceptable / arguably a feature — new SDK fields will surface as `__unknown__` variants via the existing narrower fallback, forcing a deliberate schema update rather than silent drift.

## Problem

TASK-571's AC1 specified a `const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as ClaudeStreamEvent` compile-time bridge. The verbatim form is unimplementable because `.passthrough()` schemas add `[k: string]: unknown` to all inferred object types and the concrete TS interfaces in `shared/types/claudeStream.ts` (files_readonly) lack index signatures, producing `TS2322`.

The executor's workaround — wrap with `DeepKnownFields<z.infer<...>>` to recursively strip the index signatures — compiles, but empirically does NOT catch optional-field TS→Zod drift. Adding `bogus_optional_drift?: string` to a TS interface produces ZERO typecheck errors. `_reverseCheck` adds essentially zero net drift-detection vs `_typeCheck` alone for the optional-field case (FIND-SPRINT-020-3).

TASK-571 sits in human-review-queue (bucket: decisions, severity medium) and cannot merge until a design path is chosen.

## Three options with concrete trade-offs

### Option 1 — Accept the gap (smallest scope)

Keep `DeepKnownFields<z.infer<...>>` as-is. Update TASK-571's plan to allow the form. Add a JSDoc comment block above `_reverseCheck` that explicitly acknowledges the optional-field gap and points at FIND-SPRINT-020-3.

**Blast radius:** 2 files — `main/src/services/streamParser/schemas.ts` (comment), `.soloflow/active/plans/typed-stream-event-schema/TASK-571-plan.md` (AC1 rewrite).
**Catches required-field drift:** YES (`_typeCheck` direction).
**Catches optional-field drift:** NO. Documented gap.

### Option 2 — Eliminate the drift surface (largest scope)

`export type ClaudeStreamEvent = z.infer<typeof claudeStreamEventSchema>` in `shared/types/claudeStream.ts`. Delete the hand-authored variant interfaces. Zod becomes the single source of truth.

**Blast radius:** ~16 importing files, ~62 `ClaudeStreamEvent` references in 14 files, ~181 variant/block type references in 16 files → roughly 243 typecheck-sensitive sites. 6 switch sites at risk for Zod 3.x discriminatedUnion inference narrowing fixups (see existing comment block in `schemas.ts:233-241`).
**Catches required-field drift:** N/A — drift surface gone.
**Catches optional-field drift:** N/A — drift surface gone.
**Cost:** wide refactor; reverting is non-trivial.

### Option 3 — Drop `.passthrough()` in non-leaf schemas (medium)

Remove `.passthrough()` from outer union-member schemas (13 outer call-sites in `schemas.ts`, ~18 nested preserved). Update read-only `schemas.test.ts:357-375` and `typedEventNarrowing.test.ts:100-105` (their passthrough-preservation assertions). The verbatim AC1 form then compiles and catches optional drift in both directions.

**Blast radius:** `schemas.ts` (~13 lines removed), `schemas.test.ts` (~20 lines updated), `typedEventNarrowing.test.ts` (~5 lines updated).
**Catches required-field drift:** YES.
**Catches optional-field drift:** YES.
**Cost:** loses `.passthrough()` extensibility at non-leaf schemas — future schema-extension contributors must add fields to the schema explicitly. This is arguably a feature.

## Recommended path (advisory)

Option 3 is the smallest path that achieves the plan's primary goal. Option 1 is the cheapest if the bidirectional optional-field guarantee is not load-bearing. Option 2 is architecturally cleanest but is the largest blast radius and carries known Zod 3.x inference quirks.

## Acceptance Criteria

(See frontmatter.) The first AC is the human decision; the second is option-specific.

## Hardest Decision

The decision *is* the hardest part. Once chosen, the implementation is mechanical for Options 1 and 3, and a coordinated sweep for Option 2.

## Rejected Alternatives

- **Runtime drift test instead of compile-time bridge** — Zod's discriminated unions don't expose a flat `.shape` for introspection; the test would reverse-engineer Zod internals.
- **Two compile-time bridges layered (`DeepKnownFields` + `DeepOptionalFields`)** — quickly degenerates into infinite type recursion as the union grows.

## Lowest Confidence Area

Whether the existing `schemas.test.ts` `.passthrough()` assertion is load-bearing for any production runtime behavior (Option 3). The test asserts the wire-format tolerates unknown fields without throwing; if downstream code depends on `.passthrough()` to silently absorb new SDK fields, removing it requires re-validating the SDK contract. Worth checking before committing to Option 3.
