---
id: TASK-776
sprint: SPRINT-041
epic: per-run-chat-surface
status: done
summary: "RunChatView.mergedTimeline now deduplicates historical+live overlap (assistant id-set, user timestamp gate); +2 regression tests."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-776 — Deduplicate overlapping historical + live events

## Outcome

Closed FIND-SPRINT-039-11: duplicate chat bubbles eliminated. Assistant events dedup by `payload.message.id ↔ ChatMessage.id`; user events drop by timestamp ≤ latest historical createdAt. Empty-history sentinel `''` preserves no-op behavior for all pre-existing tests.

## Changes

- `frontend/src/components/cyboflow/RunChatView.tsx` — mergedTimeline useMemo body rewritten with dedup pass + comment block.
- `frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx` — +2 tests (assistant id dedup, post-history user passthrough), ChatMessage import added, mockListMessages typed.

## Commits

- `d47d081` feat(TASK-776): deduplicate historical + live event overlap in RunChatView.mergedTimeline

## Tests

- pnpm --filter frontend test: 515/515 (RunChatView.test.tsx 13/13, +2 over baseline).
- typecheck/lint: clean.

## Visual

- visual_web/visual_macos skipped_unable (recurring Electron-preload + Peekaboo TCC.db host-process issues).
- Deferred items queued (visual_macos_unavailable / visual_web_unavailable dedup keys).

## Findings

- FIND-SPRINT-041-3 (verifier) — recurring Peekaboo Accessibility/TCC.db host-process gap; for compounder follow-up.
