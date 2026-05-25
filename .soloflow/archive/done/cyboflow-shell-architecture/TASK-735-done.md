---
id: TASK-735
sprint: SPRINT-036
epic: cyboflow-shell-architecture
status: done
summary: "Remove dead navigateToPrompt CustomEvent dispatch and delete orphan PromptHistory.tsx."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-735 — Done

## Summary
Removed the `window.dispatchEvent(new CustomEvent('navigateToPrompt', ...))` block from `PromptHistoryModal.tsx` (no listener since TASK-691), deleted the standalone orphan `PromptHistory.tsx` (233 LOC, zero importers), and scrubbed the stale `PromptHistory` comment from `electron.d.ts:205`. Modal session-switch + onClose preserved. Resolves FIND-SPRINT-034-13.

## Verification
- `pnpm --filter frontend test` → 322/322 pass.
- `pnpm typecheck` → 0 errors.
- `pnpm lint` → 0 errors.
- All six acceptance-criterion checks pass.
- Visual verification: not_applicable — dispatch was a no-op; modal UX (session-switch + close) unchanged.

## Code Review
CLEAN. One out-of-scope finding queued (FIND-SPRINT-036-1: now-orphan `prompts:get-by-id` IPC chain in main/src/) — left for a future task since it crosses `files_owned` boundaries.

## Commit
- `c429b61` — `feat(TASK-735): remove dead navigateToPrompt dispatch and delete orphan PromptHistory.tsx`
