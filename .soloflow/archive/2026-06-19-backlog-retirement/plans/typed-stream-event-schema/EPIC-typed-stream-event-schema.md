---
epic: typed-stream-event-schema
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-003]
---

# Typed Stream Event Schema

## Objective

Lock the `ClaudeStreamEvent` parser-boundary contract before any orchestrator code is written.
Produce a TypeScript discriminated union and a Zod runtime schema that together describe every
variant emitted by `claude -p --output-format stream-json --verbose --include-partial-messages`,
with a mandatory `unknown` catch-all so the parser never crashes on schema drift, and a fixture
test suite that asserts the schema matches real Claude Code output today.

This epic is the first day-1 discipline from `docs/cyboflow_system_design.md` §6.1. Everything
downstream (`streamParser.ts`, the orchestrator's event emitter, the `raw_events` table writer,
the renderer's typed subscription) consumes these types — they cannot be refactored later
without rippling through every consumer.

## Scope

- **In scope:**
  - `shared/types/claudeStream.ts` — TypeScript discriminated union with all 7 documented variants plus `unknown` catch-all
  - `main/src/services/streamParser/schemas.ts` — Zod runtime schemas with `.passthrough()` and a `parseClaudeStreamEvent()` helper that never throws
  - Fixture corpus under `main/src/services/streamParser/__fixtures__/` capturing one real example per variant from a live Claude session
  - Vitest test suite under `main/src/services/streamParser/__tests__/` asserting each fixture parses cleanly and TypeScript exhaustive-checks pass
  - Adding `zod` as a direct dependency to `main/package.json` (currently transitive via `@modelcontextprotocol/sdk`)

- **Out of scope:**
  - The actual streamParser implementation (line splitting, JSON parsing, EventEmitter wiring) — that's IDEA-004
  - Migrating `ClaudeMessageTransformer.ts` from renderer to main — that's IDEA-005+
  - Removing the renderer-side `ClaudeRawMessage` interface — that's a follow-up sweep, not part of this epic
  - The `raw_events` table schema or any DB writes — that's a later epic
  - The tRPC router or subscription wiring — separate epic

## Success Signal

A new file in `main/src/services/` can `import { ClaudeStreamEvent } from '@shared/types/claudeStream'`
and `import { parseClaudeStreamEvent } from './streamParser/schemas'`, pass any captured fixture
through `parseClaudeStreamEvent`, get back a fully-typed `ClaudeStreamEvent` (with `kind:
'unknown'` as the safe fallback), and have `tsc --noEmit` verify exhaustive `switch (event.type)`
coverage. `pnpm --filter main test streamParser` is green with at least 8 fixture-driven tests
covering: `system/init`, `system/api_retry`, `system/compact` (synthetic), `assistant`, `user`
(string + array `tool_result.content`), `result` (all 4 subtypes), `stream_event`, and an unknown
top-level type.
