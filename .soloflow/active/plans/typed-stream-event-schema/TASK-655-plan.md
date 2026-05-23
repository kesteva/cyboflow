---
id: TASK-655
idea: IDEA-003
status: ready
created: "2026-05-19T00:00:00Z"
files_owned:
  - shared/utils/extractToolResultText.ts
  - frontend/src/utils/toolFormatter.ts
  - frontend/src/utils/formatters.ts
  - frontend/src/utils/toolFormatter.test.ts
  - main/src/utils/toolFormatter.ts
files_readonly:
  - shared/types/claudeStream.ts
  - frontend/src/types/session.ts
  - main/src/types/session.ts
  - main/src/utils/formatters.ts
  - main/src/utils/formatters.test.ts
acceptance_criteria:
  - criterion: Neither toolFormatter.ts file declares a local `interface ToolResult` shadow type.
    verification: "grep -nE \"^interface ToolResult\\b\" frontend/src/utils/toolFormatter.ts main/src/utils/toolFormatter.ts returns 0 matches."
  - criterion: "Both toolFormatter.ts files import `ToolResultBlock` from `shared/types/claudeStream.ts` and use it in `formatToolInteraction`'s signature."
    verification: "grep -nE \"ToolResultBlock\" frontend/src/utils/toolFormatter.ts main/src/utils/toolFormatter.ts each show at least one import and one parameter usage."
  - criterion: "Shared helper `extractToolResultText` exists at `shared/utils/extractToolResultText.ts`, returns string, handles both branches of `ToolResultBlock['content']`."
    verification: "test -f shared/utils/extractToolResultText.ts && grep -nE \"export function extractToolResultText\" shared/utils/extractToolResultText.ts && grep -nE \"typeof content === 'string'\" shared/utils/extractToolResultText.ts each return at least one match."
  - criterion: "All previously-unsafe callsites route through `extractToolResultText` before string ops (`JSON.parse`, `.includes`, `${...}`, `.split`, `makePathsRelative`)."
    verification: "grep -nE \"toolResult\\.content\\.(includes|split)|JSON\\.parse\\(toolResult\\.content\\)|makePathsRelative\\(toolResult\\.content\" frontend/src/utils/toolFormatter.ts main/src/utils/toolFormatter.ts returns 0 matches; grep -nE \"\\$\\{item\\.content\\}\" frontend/src/utils/formatters.ts returns 0 matches."
  - criterion: "`extractToolResultText` imported and used in all three consumer files."
    verification: "grep -nE \"extractToolResultText\" frontend/src/utils/toolFormatter.ts frontend/src/utils/formatters.ts main/src/utils/toolFormatter.ts each return at least one import and one call."
  - criterion: New test file `frontend/src/utils/toolFormatter.test.ts` exists and covers the array-content branch.
    verification: "test -f frontend/src/utils/toolFormatter.test.ts && `pnpm --filter frontend test -- toolFormatter` exits 0."
  - criterion: "All workspace tests, typecheck, and lint pass."
    verification: "`pnpm --filter frontend test`, `pnpm --filter main test`, `pnpm typecheck`, `pnpm lint` all exit 0."
depends_on: []
estimated_complexity: medium
epic: typed-stream-event-schema
test_strategy:
  needed: true
  justification: frontend/src/utils/toolFormatter.ts has zero existing test coverage and 10+ array-unsafe callsites. A new vitest file is the durable regression artifact.
  targets:
    - behavior: "formatToolInteraction with a Bash tool result whose content is `[{type:'text', text:'fatal: bad refspec'}]` produces output containing 'fatal' and is tinted as '✗ Failed'."
      test_file: frontend/src/utils/toolFormatter.test.ts
      type: unit
    - behavior: formatToolInteraction with array-form content does not throw on JSON.parse for Read-tool results.
      test_file: frontend/src/utils/toolFormatter.test.ts
      type: unit
    - behavior: formatToolInteraction with plain-string content matches pre-task baseline (regression check).
      test_file: frontend/src/utils/toolFormatter.test.ts
      type: unit
    - behavior: "Orphaned array-form tool_result renders as readable text, not [object Object]."
      test_file: frontend/src/utils/toolFormatter.test.ts
      type: unit
    - behavior: "extractToolResultText handles string, array-of-text-blocks, and empty array."
      test_file: frontend/src/utils/toolFormatter.test.ts
      type: unit
prerequisites: []
---
# Fix frontend ToolResultContent unsafe callsites and delete shadow interface ToolResult declarations

## Objective

TASK-570 widened `ToolResultBlock.content` from `string` to `string | Array<{type: string; text: string}>` to match the real Claude wire format. Two local `interface ToolResult { content: string }` shadow declarations re-narrow the type at the function boundary, hiding 10+ string-only operations from TypeScript. Result: silent runtime breakage when array-form content arrives (JSON.parse throws, `.includes('error:')` returns false silently — Bash error-tinting becomes dead code — template interpolation renders `[object Object]`). This task deletes the shadow interfaces, introduces a shared `extractToolResultText` helper, routes every unsafe callsite through it, and adds the missing frontend test file as a permanent regression gate.

## Implementation Steps

1. **Pre-flight sweep grep.** Establish baseline (and re-run at the end as completeness gate — all three must return 0):
   ```bash
   grep -nE "^interface ToolResult\b" frontend/src/utils/toolFormatter.ts main/src/utils/toolFormatter.ts
   grep -nE "toolResult\.content\.(includes|split)|JSON\.parse\(toolResult\.content\)|makePathsRelative\(toolResult\.content" frontend/src/utils/toolFormatter.ts main/src/utils/toolFormatter.ts
   grep -nE "\\\$\\{item\\.content\\}" frontend/src/utils/formatters.ts
   ```

2. **Create `shared/utils/extractToolResultText.ts`** (new directory + file):
   ```ts
   import type { ToolResultBlock } from '../types/claudeStream';

   export function extractToolResultText(content: ToolResultBlock['content']): string {
     if (typeof content === 'string') return content;
     if (!Array.isArray(content)) return '';
     return content.map((block) => block.text ?? '').join('');
   }
   ```

3. **Update `frontend/src/utils/toolFormatter.ts`:**
   - Delete `interface ToolResult { ... }` at lines 31-35.
   - Import `ToolResultBlock` and `extractToolResultText`.
   - Change `formatToolInteraction`'s `toolResult` parameter type to `ToolResultBlock | null`.
   - Retype the `as ToolResult[]` cast at line 485 to `as ToolResultBlock[]`.
   - Inside `if (toolResult.content)` (line 281), define `const resultText = extractToolResultText(toolResult.content);` once and reroute every `JSON.parse(toolResult.content)`, `toolResult.content.includes(...)`, `makePathsRelative(toolResult.content)` to use `resultText`.
   - At lines 417-423 (final-status check, OUTSIDE the prior branch), hoist `const resultText2 = toolResult ? extractToolResultText(toolResult.content) : '';` and reroute the 6 `.includes` calls.
   - In the orphaned-tool-result branch (~line 507-518), seed `let content: unknown = extractToolResultText(result.content);`.

4. **Update `main/src/utils/toolFormatter.ts`:** identical shape — delete shadow interface (lines 12-16), import `ToolResultBlock` + helper, retype `ContentItem`'s `tool_result` branch, retype the `is ToolResult` predicate at ~line 619, reroute string ops at lines 257-291 and 391-400 through `resultText`.

5. **Update `frontend/src/utils/formatters.ts:38`** — replace `\`Tool result: ${item.content}\`` with `\`Tool result: ${extractToolResultText(item.content)}\``. Import the helper.

6. **Create `frontend/src/utils/toolFormatter.test.ts`** (new file). Cover the five behaviors in `test_strategy.targets[]`: extractToolResultText input shapes, Bash array-form error-tinting, Read array-form JSON.parse robustness, plain-string regression baseline, and orphaned array-form rendering.

7. **Final verification chain:**
   ```bash
   pnpm --filter frontend test -- toolFormatter   # new file passes
   pnpm --filter frontend test                    # full frontend suite
   pnpm --filter main test                        # full main suite
   pnpm typecheck && pnpm lint
   # re-run step 1 greps — all 0
   ```

## Hardest Decision

**Where to place `extractToolResultText`.** Chose `shared/utils/extractToolResultText.ts` (new directory) over module-local duplication. The helper is consumed in three files across two workspaces; module-local copies would re-create the failure class FIND-SPRINT-020-9 documented (shadow types drifting independently). Placing the helper next to `shared/types/claudeStream.ts` makes the link between the widened wire type and its safe accessor structurally obvious.

## Rejected Alternatives

- **Wrapper class around `ToolResultBlock`** — over-engineered for a 4-line guard.
- **Overload `makePathsRelative` to accept the union** — masks the issue at one site, leaves the 9 others unsafe.
- **Inline the ternary at every callsite** — 10× duplication = the original shadow-interface bug pattern.
- **Delete the `@deprecated` `MessageContent`/`ToolResultContent` re-exports** — much wider scope; flagged as a follow-up in the compound proposal.

## Lowest Confidence Area

The orphaned-tool-result branch (`frontend/src/utils/toolFormatter.ts:484-522`, `main/src/utils/toolFormatter.ts:619-664`) currently routes via `filterBase64Data` + `JSON.stringify` so it is *not* strictly array-unsafe; the change moves orphaned-rendering from `[{"type":"text","text":"foo"}]` (JSON-stringified) to `foo` (extracted concatenation). The test in step 6 asserts the new behavior; if a reviewer prefers the JSON-stringified output, the orphaned branch can selectively preserve it. Worth noting at code-review time.
