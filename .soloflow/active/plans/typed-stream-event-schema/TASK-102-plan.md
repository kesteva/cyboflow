---
id: TASK-102
idea_id: IDEA-003
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/streamParser/schemas.ts
  - main/package.json
files_readonly:
  - shared/types/claudeStream.ts
  - frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - docs/cyboflow_system_design.md
  - main/src/services/mcpPermissionServer.ts
  - main/tsconfig.json
  - main/vitest.config.ts
acceptance_criteria:
  - criterion: File main/src/services/streamParser/schemas.ts exists and exports a Zod schema named `claudeStreamEventSchema` plus a parser function `parseClaudeStreamEvent`.
    verification: "grep -nE 'export const claudeStreamEventSchema|export function parseClaudeStreamEvent' main/src/services/streamParser/schemas.ts returns 2 matches."
  - criterion: The schema is a Zod discriminated union (or equivalent — see rejected alternatives) covering all 7 wire variants from shared/types/claudeStream.ts.
    verification: "grep -cE 'system.*init|system.*api_retry|system.*compact|assistant|^\\s+user|result.*success|stream_event' main/src/services/streamParser/schemas.ts returns at least 7 distinct variant declarations (count via `grep -E 'z\\.object\\(' main/src/services/streamParser/schemas.ts | wc -l` returns >= 7)."
  - criterion: Every variant schema uses `.passthrough()` so unknown fields do not cause validation to fail.
    verification: "grep -nE '\\.passthrough\\(\\)' main/src/services/streamParser/schemas.ts returns at least 7 matches (one per variant)."
  - criterion: "Tool-result content is encoded as `z.union([z.string(), z.array(...)])` for the user variant."
    verification: "grep -nE 'z\\.union\\(\\s*\\[\\s*z\\.string\\(\\)' main/src/services/streamParser/schemas.ts returns at least one match within the user variant block."
  - criterion: "`parseClaudeStreamEvent` never throws. On schema-mismatch input, it returns an `UnknownStreamEvent` (`{ kind: '__unknown__', raw: <original-json> }`) instead of propagating a ZodError."
    verification: "grep -nE \"kind: '__unknown__'|'__unknown__'\" main/src/services/streamParser/schemas.ts returns at least one match inside the parseClaudeStreamEvent function body; grep -nE 'safeParse|catch' main/src/services/streamParser/schemas.ts confirms non-throwing path."
  - criterion: "Result variant subtype is encoded as `z.enum([...all 4 subtypes...])`."
    verification: "grep -nE \"z\\.enum\\(\\s*\\[\\s*'success'\" main/src/services/streamParser/schemas.ts returns at least one match AND grep -E \"'success'|'error_max_turns'|'error_max_budget_usd'|'error_during_execution'\" main/src/services/streamParser/schemas.ts returns all 4 literals."
  - criterion: Schema output is assignable to the ClaudeStreamEvent union type from shared/types/claudeStream.ts (compile-time check).
    verification: "grep -nE \"satisfies ClaudeStreamEvent|: ClaudeStreamEvent\" main/src/services/streamParser/schemas.ts returns at least one match. `cd main && pnpm typecheck` exits 0."
  - criterion: "`zod` is declared as a direct dependency in main/package.json (not just a transitive)."
    verification: "node -e \"const pkg=require('./main/package.json'); process.exit(pkg.dependencies && pkg.dependencies.zod ? 0 : 1)\" exits 0."
  - criterion: "`pnpm install` runs cleanly after the package.json edit, resolving zod to a version compatible with @modelcontextprotocol/sdk's transitive zod (currently ^3.23.8 / 3.25.76 per pnpm-lock.yaml)."
    verification: pnpm install --frozen-lockfile=false exits 0 and the locked zod version in pnpm-lock.yaml satisfies the new constraint (run `pnpm why zod --filter main` returns the direct dependency on the new line plus the transitive line from @modelcontextprotocol/sdk).
  - criterion: "`pnpm --filter main typecheck` and `pnpm --filter main lint` both exit 0."
    verification: "cd main && pnpm typecheck && pnpm lint exits 0."
depends_on:
  - TASK-101
estimated_complexity: medium
epic: typed-stream-event-schema
test_strategy:
  needed: false
  justification: "This task produces Zod schemas and a non-throwing parser wrapper. Behavioral verification — that parsing a real Claude `system/init` JSON yields a `SystemInitEvent`, that parsing malformed input yields an UnknownStreamEvent, that all 4 result subtypes round-trip cleanly — is the explicit responsibility of TASK-103, which writes the fixture-driven test suite. Splitting tests across both tasks would duplicate fixtures and create coordination overhead; consolidating them in TASK-103 is the cleaner boundary. A minimal smoke `parseClaudeStreamEvent({})` returning `{ kind: '__unknown__' }` is implicit in the criteria above (verified by code inspection) but does not need a dedicated test file in this task."
prerequisites:
  - check: "node -e \"const pkg=require('./main/package.json'); process.exit(pkg.dependencies && pkg.dependencies['@modelcontextprotocol/sdk'] ? 0 : 1)\""
    fix: pnpm install --filter main
    description: "Zod is currently a transitive dep through @modelcontextprotocol/sdk. If that dep is missing, zod cannot resolve."
    blocking: true
---
# Zod Schemas + Parser Wrapper for ClaudeStreamEvent

## Objective

Author `main/src/services/streamParser/schemas.ts` — the runtime validation layer that converts
raw parsed JSON objects (one per line of Claude's `stream-json` output) into trusted, typed
`ClaudeStreamEvent` values. Use Zod with `.passthrough()` per variant so unknown fields are
preserved (not stripped) and never cause validation failure. The exported
`parseClaudeStreamEvent(raw: unknown)` function MUST NOT throw on any input — bad JSON, unknown
variant, schema drift — it instead falls through to the `UnknownStreamEvent` catch-all and
returns `{ kind: '__unknown__', raw }`. Add `zod` as an explicit direct dependency of
`main/package.json` (it's currently a transitive of `@modelcontextprotocol/sdk`).

## Implementation Steps

1. **Add zod as a direct dependency.** Edit `main/package.json` and insert `"zod": "^3.23.8"`
   into the `dependencies` block (alphabetical order, between `web-streams-polyfill` and the end,
   or at the appropriate sort point). The version constraint matches what the MCP SDK already
   pulls in (per `pnpm-lock.yaml:3934`). After the edit, run `pnpm install` from repo root to
   refresh the lockfile, then `pnpm --filter main typecheck` to confirm the type resolution path
   sees zod at the top level.

2. **Create the directory and file.** `main/src/services/streamParser/schemas.ts`. The
   `streamParser/` directory does not yet exist; create it. This is the canonical home for the
   parser module — IDEA-004 (streamParser implementation) will add `streamParser/index.ts` later.

3. **Author the file header.** Reference `shared/types/claudeStream.ts` as the type contract.
   Note that this module owns runtime validation; downstream code should consume the typed return
   from `parseClaudeStreamEvent` and never reach for `claudeStreamEventSchema.parse` directly.

4. **Define block-level schemas** (mirroring the block interfaces in TASK-101):
   - `textBlockSchema = z.object({ type: z.literal('text'), text: z.string() }).passthrough()`
   - `toolUseBlockSchema = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.unknown()) }).passthrough()`
   - `thinkingBlockSchema = z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough()`
   - `toolResultContentSchema = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string() }).passthrough())])`
   - `toolResultBlockSchema = z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: toolResultContentSchema, is_error: z.boolean().optional() }).passthrough()`

5. **Define each wire variant schema with `.passthrough()`.** One `z.object({...}).passthrough()`
   per variant, with the discriminant literal(s) on `type` and (for system/result) `subtype`. Use
   `z.literal` for discriminants, `z.string()` / `z.number()` / `z.boolean()` for primitives,
   `z.array(...)` for collections, `z.object({...}).passthrough()` for nested objects, and
   `.optional()` for fields the research notes as inconsistently present.

   Variants to author (one per the union in TASK-101): `systemInitSchema`, `systemApiRetrySchema`,
   `systemCompactSchema`, `assistantEventSchema`, `userEventSchema`, `resultEventSchema`,
   `streamEventSchema`. The result event's subtype must be
   `z.enum(['success', 'error_max_turns', 'error_max_budget_usd', 'error_during_execution'])`.

6. **Compose the union.** Zod's `z.discriminatedUnion` requires a single top-level discriminant
   key and does not nest cleanly when discriminants differ across branches (system has
   `type+subtype`, result has `type+subtype`, others have `type` only). Use this two-stage pattern:

   - **Stage 1 — top-level `z.discriminatedUnion('type', [...])`.** Branches are:
     `assistantEventSchema`, `userEventSchema`, `streamEventSchema`, plus two *composite*
     branches keyed off `type: 'system'` and `type: 'result'`. The composite branches are
     themselves `z.discriminatedUnion('subtype', [...])` covering the inner shapes:
     - `systemUnionSchema = z.discriminatedUnion('subtype', [systemInitSchema, systemApiRetrySchema, systemCompactSchema])`
     - `resultUnionSchema = z.discriminatedUnion('subtype', [resultSuccessSchema, resultErrorMaxTurnsSchema, resultErrorMaxBudgetSchema, resultErrorDuringExecutionSchema])` —
       split the single `resultEventSchema` into four sibling schemas, each pinning `subtype`
       with `z.literal('success')` etc., so the inner discriminated union can dispatch on it.
     The top-level union then has six entries: `[systemUnionSchema, assistantEventSchema,
     userEventSchema, resultUnionSchema, streamEventSchema]` (five if you treat system+result
     as collapsed). Each leaf still has `.passthrough()` so unknown sibling fields survive.

   - **Stage 2 — fallback to `UnknownStreamEvent`.** Inside `parseClaudeStreamEvent`, wrap the
     top-level call in `claudeStreamEventSchema.safeParse(raw)`. On `result.success === true`,
     return `result.data` (TypeScript narrows it to `ClaudeStreamEvent` because the schema is
     declared `satisfies z.ZodType<Exclude<ClaudeStreamEvent, UnknownStreamEvent>>`). On
     `result.success === false`, return `{ kind: '__unknown__', raw: raw as Record<string, unknown> }`.
     The function signature is `parseClaudeStreamEvent(raw: unknown): ClaudeStreamEvent`. It MUST
     NOT throw — no `.parse()`, no rethrow, no `as` cast that bypasses the safeParse boundary.

7. **Export the parser and the schema.**
   ```ts
   export const claudeStreamEventSchema = z.discriminatedUnion('type', [...]);
   export function parseClaudeStreamEvent(raw: unknown): ClaudeStreamEvent {
     const parsed = claudeStreamEventSchema.safeParse(raw);
     if (parsed.success) return parsed.data;
     // Observability: log the unmatched type + run_id (if extractable) before falling through.
     const rawObj = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {};
     const wireType = typeof rawObj.type === 'string' ? rawObj.type : '<missing>';
     const sessionId = typeof rawObj.session_id === 'string' ? rawObj.session_id : '<unknown>';
     // eslint-disable-next-line no-console
     console.warn(`[streamParser] unknown ClaudeStreamEvent variant type=${wireType} session_id=${sessionId}`);
     return { kind: '__unknown__', raw: rawObj };
   }
   ```
   The `console.warn` is the minimal observability surface; IDEA-004 (full streamParser) will
   replace it with the proper Logger, but for this task console.warn keeps the dep graph clean.

8. **Add a `satisfies` compile-time assignability check.** Just before the export, add:
   ```ts
   // Compile-time guarantee that the schema output is assignable to ClaudeStreamEvent.
   // If a wire variant is added to shared/types/claudeStream.ts and not mirrored here, this fails.
   const _typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>;
   void _typeCheck;
   ```
   (Or use the `satisfies` operator on the schema declaration directly if cleaner — both work.)

9. **Verification gates.** After authoring the file:
   - `grep -nE 'export const claudeStreamEventSchema|export function parseClaudeStreamEvent' main/src/services/streamParser/schemas.ts` returns 2 matches.
   - `grep -E 'z\.object\(' main/src/services/streamParser/schemas.ts | wc -l` returns >= 7.
   - `grep -nE '\.passthrough\(\)' main/src/services/streamParser/schemas.ts` returns >= 7 matches.
   - `grep -nE "kind: '__unknown__'" main/src/services/streamParser/schemas.ts` returns >= 1 match.
   - `grep -nE 'safeParse' main/src/services/streamParser/schemas.ts` returns >= 1 match.
   - `cd main && pnpm typecheck && pnpm lint` exits 0.

## Acceptance Criteria

The frontmatter encodes nine grep-level and three exit-code gates; in narrative form they
collapse to: (a) the file exists at `main/src/services/streamParser/schemas.ts` and exports
`claudeStreamEventSchema` plus `parseClaudeStreamEvent`; (b) the schema covers all seven wire
variants from TASK-101 using `z.object({...}).passthrough()` per variant so unknown fields
survive; (c) the user variant's `tool_result.content` is a `z.union([z.string(), z.array(...)])`;
(d) the result variant pins its four subtypes as `z.enum(['success', 'error_max_turns',
'error_max_budget_usd', 'error_during_execution'])` either directly or via four sibling literals
inside a `z.discriminatedUnion('subtype', ...)`; (e) `parseClaudeStreamEvent` uses `.safeParse`
(or `try/catch`) so it never throws — on any mismatch it returns
`{ kind: '__unknown__', raw }`; (f) the schema is statically assignable to `ClaudeStreamEvent`
(`satisfies` or a `_typeCheck` line); (g) `zod` is a direct dependency in `main/package.json`
(not transitive-only); (h) `pnpm install --frozen-lockfile=false`, `pnpm --filter main typecheck`,
and `pnpm --filter main lint` all exit 0. The zod version pin (`^3.23.8`) must match the existing
transitive resolution (`pnpm-lock.yaml:3934`) so no duplicate copies enter the bundle.

## Test Strategy

`test_strategy.needed: false` in the frontmatter. TASK-103 owns the fixture-driven contract suite
(at least eight tests covering: `system/init`, `system/api_retry`, synthetic `system/compact`,
`assistant`, `user` with both string and array `tool_result.content`, all four `result` subtypes,
`stream_event`, and an unknown top-level type). Duplicating those fixtures here would create
coordination cost without changing the verification surface; the schema is verified by TASK-103's
green test run. The only behavioral assertion this task carries is implicit and inspection-only:
`parseClaudeStreamEvent({})` (or any non-matching shape) returns `{ kind: '__unknown__', raw: {} }`
without throwing — verified by reading the `safeParse` branch in step 7, not by a dedicated test
file. `pnpm --filter main typecheck` is the compile-time gate that the schema output is assignable
to `ClaudeStreamEvent`.

## Hardest Decision

**Whether to use `z.discriminatedUnion` (fast, single-key dispatch, no overlap allowed) versus
`z.union` with `.passthrough()` plus a manual `if` ladder for the catch-all.** `discriminatedUnion`
is the documented Zod-recommended path: it's O(1) dispatch instead of O(n) try-each, it produces
much better error messages, and the resulting `z.infer<>` type is a clean TypeScript discriminated
union that lines up directly with `ClaudeStreamEvent` from TASK-101. The cost is that it cannot
natively express a *two-key* discriminant — system and result variants share `type` but differ on
`subtype`. The workaround is nested unions: outer `discriminatedUnion('type', [...])` with the
system and result branches each being an inner `discriminatedUnion('subtype', [...])`. This is
the canonical Zod pattern for hierarchical discriminants and the documented Zod issue
(`colinhacks/zod#1158`) confirms it works. The alternative — flat `z.union([...])` — works but
loses error-message clarity and forces the runtime to attempt every branch in order on every
parse, which becomes measurable on long sessions (10K+ events). Chosen: nested
`discriminatedUnion`. If the nested form fails to compile under Zod 3.23.8 (low-probability but
the lowest-confidence area below), fall back to flat `z.union` with explicit per-branch error
collection.

## Rejected Alternatives

- **Use `zod-to-ts` to generate the TS types from the Zod schemas.** Rejected: TASK-101 already
  owns the canonical hand-written TS types in `shared/types/claudeStream.ts` (consumed by the
  renderer via `shared/`-path imports and by main via the same path). Bidirectional generation
  would create drift between the renderer's view and main's runtime view of the schema; pick one
  source of truth and verify the other via a compile-time `satisfies` check. The TS types are
  the source of truth; the schema is verified against them.
- **Skip Zod entirely; hand-roll discriminant `if`-ladders with manual type guards.** Rejected:
  hand-rolled guards are easy to drift from the TS types (no compile-time link), do not preserve
  unknown fields by default, and require their own test suite per variant. Zod gives us
  `.passthrough()` for free and one schema-update site instead of N guard updates.
- **Use Zod 4 (`zod@4.x`) for its faster discriminated-union performance.** Rejected: the
  transitive zod from `@modelcontextprotocol/sdk` is `^3.23.8` (per `pnpm-lock.yaml:3934`).
  Pinning Zod 4 at the top level would create two copies in the bundle (electron-builder asar
  + main `node_modules`), inflating size and risking instanceof check failures across the
  Zod-version boundary. Re-evaluate when the MCP SDK upgrades to Zod 4.
- **Define one giant `resultEventSchema` with `subtype: z.enum([...])` instead of four sibling
  schemas.** Rejected for the nested-discriminatedUnion path: `z.discriminatedUnion('subtype', ...)`
  requires each branch to pin `subtype` with a `z.literal`, not a `z.enum`. The four-sibling
  decomposition is the cost of using nested discriminated unions. (If we fall back to flat
  `z.union`, the single-enum form would work — but we'd lose the discrimination perf.)

## Lowest Confidence Area

**Whether nested `z.discriminatedUnion` compiles cleanly under Zod 3.23.8 when an inner
discriminated union is itself a branch of an outer discriminated union.** The Zod docs show
discriminated unions composing in this way (issue `colinhacks/zod#1158` and the
`discriminatedUnion-of-discriminatedUnion` test in Zod's own repo confirm it), but the type
inference for the outer union's branch detection can occasionally surface as a
`Type 'ZodDiscriminatedUnion<...>' is not assignable to type 'ZodDiscriminatedUnionOption<...>'`
error in older Zod 3.x lines. Verification path: before authoring all seven variants, prototype
a two-variant nested case (just `systemInitSchema` + `systemApiRetrySchema` wrapped in an outer
`z.discriminatedUnion('type', [innerSystemUnion, assistantEventSchema])`), run
`pnpm --filter main typecheck`, and confirm the inferred type narrows correctly. If it doesn't
compile, the fallback is flat `z.union([...])` with the `parseClaudeStreamEvent` body unchanged
(safeParse still works the same way on `z.union`). The acceptance-criterion `grep` gates do not
depend on which union form is used; both satisfy them.
