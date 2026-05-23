---
sprint: SPRINT-034
findings_count:
  critical: 0
  important: 2
  minor: 2
---

# Sprint Code Review: SPRINT-034

## Scope
- Base: f793b15ca3fa129a0f5158548328b649ab100a4e
- Tasks reviewed: [TASK-617, TASK-618, TASK-619, TASK-620, TASK-621, TASK-655, TASK-656, TASK-689, TASK-690, TASK-691]
- Files changed: 74 (1824 insertions, 6911 deletions across src; dominated by TASK-689/690/691 deletion sweep)
- Cross-task hotspots:
  - `frontend/src/utils/toolFormatter.ts` + `frontend/src/utils/formatters.ts` — touched by TASK-655 while TASK-691 removed their only consumers
  - `frontend/src/components/PromptHistory.tsx` + `PromptHistoryModal.tsx` — TASK-691 stripped comment hints without deleting the dead event dispatch
  - `main/src/services/panels/claude/claudeCodeManager.ts` — TASK-619 hardened a code path that has no production trigger (TASK-620, TASK-621 wired the same downstream surface)
  - `package.json` — TASK-618 widened asarUnpack scope past the single required file

## Findings queued

4 new findings appended to `.soloflow/active/findings/SPRINT-034-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=2, minor=2.

### Important
- **FIND-SPRINT-034-12** — Dead `frontend/src/utils/toolFormatter.ts` (541 LOC) + `formatJsonForWeb` are hardened by TASK-655 but have zero production callers after TASK-691's SessionView deletion. Two near-identical 600-line files (frontend + main) are kept in sync needlessly.
- **FIND-SPRINT-034-13** — `navigateToPrompt` CustomEvent dispatched from PromptHistory[Modal] but no listener exists post-TASK-691; TASK-691 removed the comment hint without removing the dispatch, silently breaking prompt-history navigation UX.

### Minor
- **FIND-SPRINT-034-14** — `build.asarUnpack` glob `mcpServer/**/*.js` (TASK-618) unpacks 3 extra files (`mcpQueryHandler`, `mcpServerLifecycle`, `scriptPath`) that don't need to be outside ASAR, creating on-disk duplicates of bundled code.
- **FIND-SPRINT-034-15** — The cyboflow MCP entry path (TASK-619/620/621 epic) has no production trigger in v1 — `OrchSocketProvider.getSocketPath()` throws "not yet wired (epic 7)"; the eager-resolve fix lacks an end-to-end exercise until epic 7 lands.

## Notes
- Convention check: no documented-CLAUDE.md violations across the changed files. The `@cyboflow-hidden` annotation is correctly applied to remaining preserved-but-unused methods (worktreeManager.ts:502, updated comment by TASK-691).
- Cross-cutting store-action sweep: no store actions that reset multiple fields were added or modified across the sprint; nothing to grep.
- Security: no new external surface, no auth bypass, no input-validation regressions. TASK-617's sentinel rejection (`runId === 'orchestrator'`) closes a real FK-violation/abuse vector — good cross-task hygiene.
- Per-task findings already in the queue (FIND-1 through FIND-11) are preserved unchanged.
