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
   