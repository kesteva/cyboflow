---
id: TASK-672
idea: IDEA-SPRINT-024-compound
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - frontend/src/types/electron.d.ts
  - frontend/src/utils/api.ts
  - frontend/src/components/panels/ai/MessagesView.tsx
  - frontend/src/components/panels/ai/RichOutputView.tsx
files_readonly:
  - main/src/ipc/session.ts
  - shared/types/unifiedMessage.ts
  - frontend/src/types/session.ts
  - frontend/src/components/panels/ai/transformers/MessageTransformer.ts
  - main/src/services/streamParser/messageProjection.ts
acceptance_criteria:
  - criterion: "frontend/src/types/electron.d.ts:316 declares `getJsonMessages: (panelId: string) => Promise<IPCResponse<UnifiedMessage[]>>` (NOT `ClaudeJsonMessage[]`)."
    verification: "grep -n 'getJsonMessages' frontend/src/types/electron.d.ts shows the line returning `Promise<IPCResponse<UnifiedMessage[]>>` and the file imports `UnifiedMessage` from `'../../../shared/types/unifiedMessage'`."
  - criterion: "frontend/src/utils/api.ts's getJsonMessages wrapper resolves to Promise<IPCResponse<UnifiedMessage[]>> via inference; no ClaudeJsonMessage reference remains in the wrapper."
    verification: "grep -n 'ClaudeJsonMessage' frontend/src/utils/api.ts returns 0 matches."
  - criterion: "The inline `as unknown as UnifiedMessage` cast in frontend/src/components/panels/ai/MessagesView.tsx is removed."
    verification: "grep -n 'as unknown as UnifiedMessage' frontend/src/components/panels/ai/MessagesView.tsx returns 0 matches."
  - criterion: "The inline `as unknown as UnifiedMessage[]` cast in frontend/src/components/panels/ai/RichOutputView.tsx is removed."
    verification: "grep -n 'as unknown as UnifiedMessage' frontend/src/components/panels/ai/RichOutputView.tsx returns 0 matches."
  - criterion: "No new TypeScript errors are introduced in either workspace."
    verification: "Run `pnpm typecheck` from the repo root and confirm exit 0."
  - criterion: "Existing frontend tests remain green and lint passes."
    verification: "Run `pnpm --filter frontend test` and confirm exit 0. Run `pnpm lint` and confirm exit 0."
  - criterion: "The TODO comments referencing FIND-SPRINT-024-4 are removed."
    verification: "grep -rn 'FIND-SPRINT-024-4' frontend/src returns 0 matches."
  - criterion: "Out-of-scope: the MessagesView session_info detection path is NOT reworked — only the type-level rewiring and cast removal land in this task."
    verification: "Manual diff against HEAD~1 — only the cast removal and minimal typing adjustments."
depends_on: []
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "The IPC type alignment is verified primarily by TypeScript — once the cast is removed, any consumer that depended on `ClaudeJsonMessage` shape will surface as a compile error. No new test cases are needed; there are no existing unit tests for MessagesView.tsx or RichOutputView.tsx. The acceptance criteria's `pnpm typecheck` + `pnpm --filter frontend test` invocations are the primary verification."
  targets:
    - behavior: "frontend typecheck succeeds with the new type signature (verifies no caller is broken by removing the `ClaudeJsonMessage` declaration)."
      test_file: "frontend/tsconfig.json (via `pnpm --filter frontend exec tsc --noEmit`)"
      type: integration
---

# Fix stale IPC type declaration for panels:get-json-messages

## Objective

Correct the type lie at the renderer/main IPC boundary for `panels:get-json-messages`. The declaration in `frontend/src/types/electron.d.ts:316` says the handler returns `Promise<IPCResponse<ClaudeJsonMessage[]>>`, but the production handler at `main/src/ipc/session.ts:937-961` returns `UnifiedMessage[]` via `projectStoredOutputs` → `MessageProjection`. This mismatch forced commit bb926cd in TASK-637 to revert to passing UnifiedMessage[] through unchanged with inline `as unknown as UnifiedMessage` casts and TODO comments. This task aligns the declared type with the runtime return value and removes the casts. Scope is intentionally narrow per the FIND-SPRINT-024-4 skeptic counterfactual — the MessagesView session_info detection rework (FIND-SPRINT-024-5) is deferred.

## Implementation Steps

1. **Confirm the runtime contract.** Read `main/src/ipc/session.ts:937-961` and `projectStoredOutputs` to confirm the handler returns `{ success: true, data: UnifiedMessage[] }`. Read `shared/types/unifiedMessage.ts` to confirm the export shape.

2. **Update the type declaration in `frontend/src/types/electron.d.ts`.**
   - Add `import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';` near the existing imports.
   - At line 316, change `Promise<IPCResponse<ClaudeJsonMessage[]>>` to `Promise<IPCResponse<UnifiedMessage[]>>`.
   - If `ClaudeJsonMessage` is now unused, remove from the import set.

3. **Update the wrapper in `frontend/src/utils/api.ts`.** The wrapper's inferred return type flows from step 2; no body edit unless an explicit annotation needs updating. Also remove any `ClaudeJsonMessage` references in this file.

4. **Remove the cast in `MessagesView.tsx`.** The block around lines 36-47 currently casts `rawMsg as unknown as UnifiedMessage`. After the type fix, `rawMsg` is already a `UnifiedMessage`. Drop the cast and the TODO comment. Do NOT modify session_info handling — that is FIND-SPRINT-024-5 scope, deferred.

5. **Remove the cast in `RichOutputView.tsx`.** Lines around 207-215 cast `outputResponse.data as unknown as UnifiedMessage[]`. Drop the cast and the TODO. Keep surrounding sort / sequence unchanged.

6. **Run `pnpm typecheck`** — must exit 0.

7. **Run `pnpm --filter frontend test`** — must exit 0.

8. **Run `pnpm lint`** — must exit 0. Remove any now-unused imports.

9. **Manual visual smoke (recommended).** Start `pnpm dev` and confirm both views still render messages.

## Acceptance Criteria

See frontmatter.

## Hardest Decision

Keeping scope narrow per FIND-SPRINT-024-4's skeptic counterfactual. The temptation is to also rework `MessagesView` session_info handling (FIND-SPRINT-024-5) since both findings share the same type-lie origin. But IDEA-017 (claude-agent-sdk-migration's renderer cutover) may retire MessagesView/RichOutputView entirely.

## Rejected Alternatives

- **Also fix FIND-SPRINT-024-5 in this task.** Rejected per skeptic counterfactual.
- **Keep `ClaudeJsonMessage[]` declaration but rename the handler.** Doesn't fix downstream cast burden.
- **Introduce a union type encompassing both shapes.** Runtime only returns `UnifiedMessage[]`.

## Lowest Confidence Area

Whether the `msg.timestamp ?? ''` fallback in MessagesView is needed once `UnifiedMessage.timestamp` is typed as a required string. Keep the fallback; TS may warn it's redundant — minor.
