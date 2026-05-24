---
sprint: SPRINT-036
pending_count: 1
last_updated: "2026-05-24T16:30:00Z"
---

# Findings Queue

- SPRINT-036 started with missing infra: docker; tests deferred.

## FIND-SPRINT-036-1
- **source:** TASK-735 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/prompt.ts:26, main/src/preload.ts:323, frontend/src/utils/api.ts:399, frontend/src/types/electron.d.ts:207
- **description:** After TASK-735 deleted the `navigateToPrompt` dispatch block in `PromptHistoryModal.tsx`, the `prompts:get-by-id` IPC channel and its full call chain (`API.prompts.getByPromptId` wrapper, preload binding, `ipcMain.handle('prompts:get-by-id', ...)`) have zero remaining consumers in `frontend/src/`. The only call site was the now-removed `try { const response = await API.prompts.getByPromptId(promptItem.id); ... }` block. The handler, wrapper, and type declaration are now dead infrastructure preserved only for symmetry with the deleted dispatch.
- **suggested_action:** Either (a) delete the orphan chain (`ipcMain.handle('prompts:get-by-id', ...)`, the preload binding, the `api.ts` wrapper, and the `prompts.getByPromptId` line in `electron.d.ts`) in a follow-up cleanup task, or (b) mark them with `@cyboflow-hidden` annotations explicitly documenting they are preserved for a future "navigate-to-specific-prompt" feature (per the TASK-735 plan's "Lowest Confidence Area" — re-introducing the listener+routing in CyboflowRoot). Default recommendation: (a), with (b) only if a v2 prompt-navigation feature is on the near roadmap.
- **resolved_by:**
