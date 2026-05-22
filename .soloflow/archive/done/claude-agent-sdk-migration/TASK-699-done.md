---
id: TASK-699
sprint: SPRINT-030
epic: claude-agent-sdk-migration
status: done
summary: "Remove dead api_retry / compact renderer branches in RunView; transform legacy tests to assert UnknownEventRow routing"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-699 — Done

Removed the unreachable `api_retry` / `compact` subtype branches from `SystemEventRow` in `frontend/src/components/cyboflow/RunView.tsx`. Post-TASK-681, `systemUnionSchema` no longer recognizes those subtypes, so the narrower rejects them and the renderer envelope arrives with `type: 'unknown'`. The two `SystemEventRow` branches that handled them were dead code.

Trimmed `SystemApiRetryEvent` and `SystemCompactEvent` from the renderer's type imports and from the `SystemEventRow` payload cast union. New TASK-696 branches (hook_started, hook_response, status) preserved in the union; `compact_boundary`, `init`, and the fallback are untouched. The shared interfaces remain exported from `shared/types/claudeStream.ts` per the TASK-681 retention rationale.

Transformed the two existing RunView unit tests (`routes a system/api_retry…`, `routes a system/compact…`) to assert that retired payloads now route to `UnknownEventRow` with the visible "Unrecognized event" label — locking in the post-narrowing contract end-to-end.

Tests: frontend 277/277 pass. typecheck 0. lint 0 errors.
