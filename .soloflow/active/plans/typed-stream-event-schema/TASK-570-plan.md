---
id: TASK-570
title: Canonicalize block/content types — eliminate tri-package duplication
status: ready
epic: typed-stream-event-schema
source: compound/SPRINT-004-005
source_sprint: SPRINT-004
depends_on: []
files_owned:
  - main/src/types/session.ts
  - frontend/src/types/session.ts
files_readonly:
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/schemas.ts
  - main/src/services/sessionManager.ts
  - frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts
  - frontend/src/components/panels/ai/RichOutputView.tsx
  - docs/CODE-PATTERNS.md
acceptance_criteria:
  - criterion: "`TextContent`, `ToolUseContent`, and `ToolResultContent` in `main/src/types/session.ts` and `frontend/src/types/session.ts` are type aliases pointing at the canonical `TextBlock`/`ToolUseBlock`/`ToolResultBlock` from `shared/types/claudeStream.ts`."
    verification: "grep -nE 'type (TextContent|ToolUseContent|ToolResultContent) = (TextBlock|ToolUseBlock|ToolResultBlock)' main/src/types/session.ts frontend/src/types/session.ts returns >= 6 matches (3 aliases × 2 files)."
  - criterion: "Neither `main/src/types/session.ts` nor `frontend/src/types/session.ts` redeclares the bodies of `TextContent`, `ToolUseContent`, or `ToolResultContent` as `interface` or `type` literal definitions."
    verification: "grep -nE 'interface (TextContent|ToolUseContent|ToolResultContent)' main/src/types/session.ts frontend/src/types/session.ts returns 0 matches."
  - criterion: "`ToolResultContent.content` accepts both wire shapes — plain string AND the array form `Array<{ type: string; text: string }>` — by virtue of being an alias of `ToolResultBlock`."
    verification: "grep -nE 'content: string \\| Array<\\{ type: string; text: string \\}>' shared/types/claudeStream.ts returns 1 match (the canonical), and `pnpm typecheck` passes after the alias change."
  - criterion: "All callsites that previously imported `TextContent`/`ToolUseContent`/`ToolResultContent` from `main/src/types/session` or `frontend/src/types/session` continue to compile without modification."
    verification: "`pnpm typecheck` exits 0 across all workspaces."
  - criterion: "`pnpm typecheck` and `pnpm --filter main exec vitest run` pass."
    verification: "Exit code 0 for both."
estimated_complexity: medium
test_strategy:
  needed: false
  justification: "This task is a purely type-level refactor — no runtime behavior changes. `pnpm typecheck` IS the test. The two `session.ts` files in main and frontend have no sibling `__tests__` directories (grep `main/src/types/__tests__` and `frontend/src/types/__tests__` return zero results), so there are no sibling tests to keep green. Behavioral tests already cover the consumers (e.g. `ClaudeMessageTransformer.ts` tests if any) and will catch any subtle type-narrowing breakage by virtue of failing to compile."
prerequisites: []
---

# Canonicalize block/content types

## Problem

The same domain concept is declared three times:
- `TextBlock` / `ToolUseBlock` / `ToolResultBlock` / `ThinkingBlock` —
  `shared/types/claudeStream.ts:17-50` (canonical).
- `TextContent` / `ToolUseContent` / `ToolResultContent` —
  `main/src/types/session.ts:88-105`.
- `TextContent` / `ToolUseContent` / `ToolResultContent` —
  `frontend/src/types/session.ts:1-19`.

The legacy definitions also drop a real wire-shape: `ToolResultContent.content`
is typed as `string` (both legacy copies), while `ToolResultBlock.content` is
correctly typed as `string | Array<{ type: string; text: string }>`. The array
form is real (research §1 + Zod schema confirm `toolResultContentSchema` is a
`z.union([z.string(), z.array(...)])`); the legacy types silently widen-by-omission
and force callers to defensive-stringify.

This violates `docs/CODE-PATTERNS.md`'s shared-types contract.

## Proposed Direction (Implementation Steps)

1. **Pre-flight grep** to enumerate consumers of the legacy types:
   ```
   grep -rEn "TextContent|ToolUseContent|ToolResultContent" main/src frontend/src shared --include='*.ts' --include='*.tsx' | grep -v node_modules
   ```
   Capture the list — anything in `files_owned` is in scope to edit; anything
   in `files_readonly` is a consumer that must continue to compile.

2. Edit `main/src/types/session.ts`:
   - Add at the top (just after the existing imports):
     ```ts
     import type { TextBlock, ToolUseBlock, ToolResultBlock } from '../../../shared/types/claudeStream';
     ```
   - Replace the `interface TextContent { … }` body with:
     ```ts
     /** @deprecated import { TextBlock } from 'shared/types/claudeStream' directly. */
     export type TextContent = TextBlock;
     ```
   - Same pattern for `ToolUseContent` → `ToolUseBlock` and `ToolResultContent`
     → `ToolResultBlock`.
   - The `MessageContent` discriminated union on line 107 stays as-is (it
     still composes `TextContent | ToolUseContent | ToolResultContent`, which
     now compose into the canonical block types).

3. Edit `frontend/src/types/session.ts`:
   - Add at the top:
     ```ts
     import type { TextBlock, ToolUseBlock, ToolResultBlock } from '../../../shared/types/claudeStream';
     ```
   - Replace the three `interface` declarations (lines 2-19) with the same
     three `export type … = …Block` aliases as step 2.

4. Run `pnpm typecheck` from the repo root. Expected: 0 type errors.

   **If `pnpm typecheck` fails**, the most likely cause is a callsite that
   depended on the narrower `content: string` shape of `ToolResultContent`.
   For each error:
   - If the callsite reads `.content` and assumes a string, narrow with a
     type guard: `typeof block.content === 'string' ? block.content : JSON.stringify(block.content)`.
     There's existing precedent for this exact guard in
     `main/src/services/streamParser/messageProjection.ts:271`.
   - Add the changed callsite to `files_owned` and proceed.

5. Run `pnpm --filter main exec vitest run` to confirm no behavioral
   regression at the test layer.

6. **Pre-flight grep** completeness gate (re-run):
   ```
   grep -nE 'interface (TextContent|ToolUseContent|ToolResultContent)' main/src/types/session.ts frontend/src/types/session.ts
   ```
   Must return 0 matches before reporting COMPLETED.

## Acceptance Criteria

(See frontmatter.)

## Test Strategy

No new tests — this is a type-only refactor. `pnpm typecheck` is the
acceptance gate. No sibling tests exist in `main/src/types/__tests__/` or
`frontend/src/types/__tests__/` (both directories do not exist; verified via
`Glob`).

## Hardest Decision

**Type alias vs. canonical re-export.** Two options:
- **(A) Alias in place** (chosen): keep the legacy names as
  `export type TextContent = TextBlock` so existing imports
  `import type { TextContent } from '@/types/session'` continue to work
  unchanged. Zero churn at consumers.
- **(B) Delete the legacy names, mass-rewrite imports.** Cleaner end state,
  much larger blast radius — the grep in step 1 likely returns 20+
  callsites across both packages, all of which would need touching.

(A) is the explicit recommendation in the compounder proposal ("Convert the
… definitions to type aliases pointing at the shared exports"). The
`@deprecated` JSDoc tag prompts future maintainers toward the canonical
name without breaking today's callers. (B) becomes a follow-up sweep that
can be scheduled independently when product wants the cleanup.

## Rejected Alternatives

- **(B) above — full rewrite of all consumers.** Rejected because the
  scope balloons unpredictably (callsite count is sprint-team-time
  dependent on a survey we have not done) and the win — one less
  deprecation tag — is small. Would flip if the alias caused a real
  type-narrowing pitfall, which it doesn't because the alias is structural.
- **Move all four block types into `frontend/src/types/session.ts` (frontend
  as source of truth).** Rejected — `shared/types/` is the cyboflow-spec
  source of truth for wire formats per `docs/CODE-PATTERNS.md`. Moving
  canonical types into a workspace-specific package would reverse that
  convention.

## Lowest Confidence Area

The `MessageContent` union on `main/src/types/session.ts:107` —
`export type MessageContent = TextContent | ToolUseContent | ToolResultContent`.
This now resolves structurally to `TextBlock | ToolUseBlock | ToolResultBlock`.
That equals (but is not identity-equal to) the assistant content block
union from `shared/types/claudeStream.ts:118` which is
`Array<TextBlock | ToolUseBlock | ThinkingBlock>` (note `ThinkingBlock` is
in the assistant union but NOT in `MessageContent`). If a consumer does
`(content as MessageContent)` on assistant-event content that contains a
`ThinkingBlock`, that cast was already lossy pre-refactor — this task
does not fix it (out of scope) but the executor should not be alarmed by
that asymmetry.
