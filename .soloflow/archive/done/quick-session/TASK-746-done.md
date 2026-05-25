---
id: TASK-746
sprint: SPRINT-037
epic: quick-session
status: done
summary: "Wired sessions:create-quick into preload.ts, electron.d.ts, and api.ts with T-parity to TASK-744's handler return shape."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-746 — Wire sessions:create-quick into preload + types

## What changed

- `main/src/preload.ts` — added `createQuick: (request: CreateSessionRequest) => Promise<IPCResponse<{ jobId; sessionId; worktreePath }>>` in `electronAPI.sessions` after `create:`.
- `frontend/src/types/electron.d.ts` — added matching `createQuick` signature in `ElectronAPI.sessions`.
- `frontend/src/utils/api.ts` — added `API.sessions.createQuick(request)` with `isElectron()` guard.

## Verification

- L1 grep ACs all pass (one IPC channel reference, one createQuick signature per file, two canonical IPCResponse declarations unchanged).
- `pnpm typecheck` (root, all workspaces) exits 0.
- `pnpm test -- ipcResponseType` (frontend) exits 0 — IPCResponse type-contract regression test unchanged.

## Code review

CLEAN — no findings. T-parity confirmed: handler at `main/src/ipc/session.ts:380` returns `{ jobId: job.id, sessionId: session.id, worktreePath: session.worktreePath }`; all three declarations type `T` as `{ jobId: string; sessionId: string; worktreePath: string }`.

## Tests added

None — plan explicitly opts out (`test_strategy.needed: false`). Behavior is verified at compile time by `tsc` across all three edit sites simultaneously, plus the existing `ipcResponseType` type-contract test.
