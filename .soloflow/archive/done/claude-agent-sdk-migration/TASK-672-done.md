---
id: TASK-672
sprint: SPRINT-026
epic: claude-agent-sdk-migration
status: done
summary: "Align getJsonMessages IPC declaration to UnifiedMessage[]; remove `as unknown as UnifiedMessage` casts and FIND-SPRINT-024-4 TODOs."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-672 — Done

Aligned the renderer-side declared return type of `panels:get-json-messages` with the main handler's actual runtime shape. The handler (`main/src/ipc/session.ts:937-961`) returns `UnifiedMessage[]` via `projectStoredOutputs`; the renderer declared `ClaudeJsonMessage[]`, which forced inline `as unknown as UnifiedMessage[]` double-casts in `MessagesView.tsx` and `RichOutputView.tsx` (commit bb926cd from TASK-637 documented this as a workaround pending FIND-SPRINT-024-4).

Resolves FIND-SPRINT-024-4. Scope held narrow per skeptic counterfactual — MessagesView session_info detection rework (FIND-SPRINT-024-5) remains deferred to a future task.

## Changes
- `frontend/src/types/electron.d.ts`: added `import type { UnifiedMessage } from '../../../shared/types/unifiedMessage'`; removed `ClaudeJsonMessage` from the `./session` import; changed `getJsonMessages` declaration from `Promise<IPCResponse<ClaudeJsonMessage[]>>` to `Promise<IPCResponse<UnifiedMessage[]>>`.
- `frontend/src/components/panels/ai/MessagesView.tsx`: removed the `as unknown as UnifiedMessage` cast block and the FIND-SPRINT-024-4 TODO; cleaned up the now-unused `UnifiedMessage` import from `./transformers/MessageTransformer`.
- `frontend/src/components/panels/ai/RichOutputView.tsx`: removed the `as unknown as UnifiedMessage[]` cast and the FIND-SPRINT-024-4 TODO; simplified `allMessages.push(...)` call.
- `frontend/src/components/panels/ai/parseJsonMessage.ts`: stale jsdoc comment referencing FIND-SPRINT-024-4 removed (AC7-mandated zero-match; verifier marked the scope deviation resolved).

## Verification
- `pnpm typecheck` — clean (main, frontend, shared).
- `pnpm --filter frontend test` — 18 files / 237 tests pass.
- `pnpm lint` — 0 errors (307 pre-existing warnings, none in the touched files).
- All eight ACs verified by the shadow-verifier.

## Visual
- `visual_mobile: skipped_user_preference` — `verification.visual_mobile=false` in `.soloflow/config.json`.
- `visual_web: skipped_unable` — Electron renderer requires `_electron.launch` infrastructure not exposed to the verifier subagent (deferred item appended to review queue, `dedup_key: visual_web_unavailable`).

## Commits
- 5dd3e91 — fix(TASK-672): align getJsonMessages IPC type declaration to UnifiedMessage[]
