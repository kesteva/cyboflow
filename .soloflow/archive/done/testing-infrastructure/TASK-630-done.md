---
id: TASK-630
sprint: SPRINT-015
epic: testing-infrastructure
status: done
summary: "Replaced IPCResponse<T = any> with <T = unknown> across declarations; audited 120+ Promise<IPCResponse> sites + ~13 as IPCResponse casts; cascaded explicit types through 22 caller files; added type-contract regression tests"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-630 — Done

Flipped `IPCResponse<T = any>` to `<T = unknown>` in both canonical declaration sites (`frontend/src/types/electron.d.ts` and `frontend/src/utils/api.ts`), removed the `eslint-disable @typescript-eslint/no-explicit-any` directives that masked the default. Added an `IPCDataResponse<T>` helper type for channels with guaranteed data on success.

Audited ~120 `Promise<IPCResponse>` declarations in `electron.d.ts`, mapping each to a concrete type (`Session[]`, `AppConfig`, `GitCommands`, `ExecutionDiff[]`, `SessionOutput[]`, etc.) or `IPCResponse<unknown>` with a `// Caller does not consume .data` comment where genuinely dynamic. Replaced 4 bare `as IPCResponse` casts in `DiscordPopup.tsx` with `as IPCResponse<unknown>`. Updated `GitErrorResponse` to `extends IPCResponse<unknown>` with rationale comment.

Cascading type narrowing required updates in 20 caller files (project tree views, panels, hooks). Notably resolved FIND-SPRINT-015-7 (TASK-598 left frontend `workflowId: number` while runtime moved to `string`) by aligning `cyboflowApi.ts` and `WorkflowPicker.tsx`.

`pnpm typecheck && pnpm lint` exit 0. 12/12 component tests pass. Test-writer added 4 new type-contract assertions in `frontend/src/utils/__tests__/ipcResponseType.test.ts` using vitest's `expectTypeOf` (no new tooling).

Sprint-code-reviewer queued 4 minor findings for compound: FIND-SPRINT-015-11 (duplicate local IPCResponse declarations), 12 (double-cast pattern in AI panel views), 13 (IPCDataResponse soundness — discriminated union recommended), 14 (latent cast-without-narrow at DraggableProjectTreeView.tsx:1199).

Commits:
- `6ace44e` — feat(TASK-630): change IPCResponse<T=any> default to <T=unknown>
- `c8685d2` — feat(TASK-630): add IPCDataResponse helper + concrete type args for all IPC methods
- `11ed6aa` — fix(TASK-630): add missing additionalPaths field to frontend AppConfig type
- `aa5ad09` — fix(TASK-630): align WorkflowPicker + cyboflowApi to string workflowId
- `785e860` — fix(TASK-630): narrow IPC response.data casts in component layer
- `0cb6f31` — fix(TASK-630): narrow IPC response.data casts in panels + hooks
- `64a780a` — test(TASK-630): add IPCResponse<T=unknown> type-contract regression tests
