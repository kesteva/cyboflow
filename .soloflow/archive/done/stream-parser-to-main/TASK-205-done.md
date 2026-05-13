---
id: TASK-205
sprint: SPRINT-005
epic: stream-parser-to-main
status: done
summary: "Move renderer ClaudeMessageTransformer parsing to main-process MessageProjection; renderer becomes identity stub"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-205 — Done Report

## Summary

Eliminated renderer-side stream-json parsing. The 464-line `ClaudeMessageTransformer.ts` in the renderer has been reduced to a 22-line `@cyboflow-stub` identity passthrough. The parsing logic was ported to a new `main/src/services/streamParser/messageProjection.ts` that consumes the typed `ClaudeStreamEvent` union from TASK-201 and emits `UnifiedMessage` objects via a streaming `project(event)` method (one event in, zero-or-more messages out). The instance maintains state (`toolResults`, `parentToolMap`, `allToolCalls`) across calls instead of the old 3-pass batched approach.

The `UnifiedMessage` / `MessageSegment` / `ToolCall` / `ToolResult` types are now single-homed at `shared/types/unifiedMessage.ts`. Both main (messageProjection.ts) and the renderer (MessageTransformer.ts re-export shim) import from there — no duplicated definitions.

## Changes

- `shared/types/unifiedMessage.ts` (new — single-source contract)
- `main/src/services/streamParser/messageProjection.ts` (new — 327 lines, streaming projection class)
- `main/src/services/streamParser/__tests__/messageProjection.test.ts` (new — 21 tests including the FIND-SPRINT-005-10 fix for warn-payload assertion)
- `frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts` (reduced 464 → 22 lines; @cyboflow-stub)
- `frontend/src/components/panels/ai/transformers/MessageTransformer.ts` (re-exports from shared/types/unifiedMessage.ts; was in files_readonly but reclaimed via claim-file.js per the plan's step-1 prescription — FIND-SPRINT-005-8 logged and resolved)

## Commits

- `a206d27` — `feat(TASK-205): create shared/types/unifiedMessage.ts and update MessageTransformer re-exports`
- `3213a9d` — `feat(TASK-205): add MessageProjection class and behavior parity tests`
- `693e928` — `feat(TASK-205): reduce ClaudeMessageTransformer to identity stub`
- `beb4822` — `test(TASK-205): add out-of-order, error, parent-link, and warn-payload tests`

## Verification

- Tests: 21/21 messageProjection cases pass; 180/180 main workspace total.
- Typecheck: PASS across main, frontend, shared.
- Lint: 0 errors.
- Per-task visual: skipped (parallel/serial mode).
- AC-6 grep `JSON.parse|tool_use|ContentBlock|tool_result` against the stub: 0 parsing matches.

## Deferred / Out-of-scope

- **FIND-SPRINT-005-9 (severity: high, queued under bucket:testing)**: `MessageProjection` is not yet wired into the data path that feeds the renderer. `panels:get-json-messages` in `main/src/ipc/session.ts:869` still returns raw stream-json, which the identity-stub transformer hands to `RichOutputView.tsx:230` and triggers a TypeError when accessing `message.segments`. This wiring is explicitly out of scope per the plan's "Out of scope: orchestrator integration is deferred to a future epic" note. The deferred-action entry instructs the user to manually start a Claude session post-merge and either accept the transient state or fast-track a wiring patch.
- **FIND-SPRINT-005-8**: TASK-205's plan-prescribed scope deviation (`MessageTransformer.ts` was in files_readonly but had to be modified for step 1). Resolved.

## Notes

- The OLD transformer's 3-pass batched architecture is replaced by a streaming class. Tests confirm out-of-order arrival (tool_result before tool_use), tool-result error status, and sub-agent parent/child wiring all work correctly under streaming semantics.
- Transport remains Crystal's existing IPC channel (`outputEventName`). tRPC migration is a separate epic; the UnifiedMessage contract is transport-agnostic so the renderer side won't need touching when it lands.
