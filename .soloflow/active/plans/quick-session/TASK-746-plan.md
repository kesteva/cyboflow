---
id: TASK-746
idea: IDEA-024
status: in-flight
created: "2026-05-23T00:00:00Z"
files_owned:
  - main/src/preload.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/utils/api.ts
files_readonly:
  - main/src/ipc/session.ts
  - main/src/types/session.ts
  - frontend/src/utils/__tests__/ipcResponseType.test.ts
  - .soloflow/active/plans/quick-session/TASK-744-plan.md
acceptance_criteria:
  - criterion: "main/src/preload.ts exposes window.electronAPI.sessions.createQuick wired to ipcRenderer.invoke('sessions:create-quick', request)"
    verification: "grep -n \"sessions:create-quick\" main/src/preload.ts returns exactly one line, and that line is inside the contextBridge.exposeInMainWorld('electronAPI', ...).sessions block; grep -n \"createQuick:\" main/src/preload.ts returns exactly one match referencing the same channel"
  - criterion: "frontend/src/types/electron.d.ts declares sessions.createQuick with a return type whose T matches TASK-744's handler runtime payload (no double-cast required at call sites)"
    verification: "grep -n \"createQuick\" frontend/src/types/electron.d.ts returns exactly one signature line under the sessions block. Cross-check: the declared Promise<IPCResponse<T>> T must equal the return-data shape TASK-744's handler emits (executor reads the merged handler before drafting the type)."
  - criterion: "frontend/src/utils/api.ts exports API.sessions.createQuick(request) that delegates to window.electronAPI.sessions.createQuick with no local IPCResponse redeclaration and no inline {success;data?;error?} shape"
    verification: "grep -n \"createQuick\" frontend/src/utils/api.ts returns exactly one method definition; grep -nE \"interface IPCResponse|interface\\s+\\{\\s*success\" frontend/src/utils/api.ts returns only line 10 and no new hits"
  - criterion: No NEW local IPCResponse declarations introduced in frontend/src/ outside the two canonical sites
    verification: "grep -rn \"interface IPCResponse\" frontend/src returns exactly two lines — frontend/src/types/electron.d.ts:27 and frontend/src/utils/api.ts:10 — unchanged from the pre-task baseline"
  - criterion: frontend typecheck passes with the new createQuick signature
    verification: "cd frontend && pnpm typecheck exits 0"
  - criterion: main typecheck passes with the new preload createQuick wrapper
    verification: "cd main && pnpm typecheck exits 0 (or root `pnpm typecheck` exits 0)"
  - criterion: Existing IPCResponse type-contract test still passes (no regression in type contract)
    verification: "cd frontend && pnpm test -- ipcResponseType exits 0"
depends_on:
  - TASK-744
estimated_complexity: low
epic: quick-session
test_strategy:
  needed: false
  justification: "This task adds only type declarations and an IPC pass-through wrapper. The behavior is verified by (a) tsc typecheck, which catches T-parity mismatches at compile time, and (b) the existing `frontend/src/utils/__tests__/ipcResponseType.test.ts` type-contract test which protects the IPCResponse<T> default. Adding a unit test that calls window.electronAPI.sessions.createQuick would require mocking the entire Electron preload bridge for one delegated invoke call — the test would only assert that a pass-through method passes through, which adds maintenance cost without catching real failure modes. The actual behavioral verification of sessions:create-quick lives in TASK-744 (handler unit test) and TASK-747/TASK-748 (frontend integration of the new wrapper)."
---
# Wire sessions:create-quick into preload and electron.d.ts type declarations

## Objective

Expose the `sessions:create-quick` IPC channel (implemented in TASK-744) through the renderer-facing surfaces so the frontend tasks (TASK-747, TASK-748, TASK-749) can call it with full TypeScript coverage. This is a pure bridge-and-types task: add `createQuick` to `main/src/preload.ts`'s `electronAPI.sessions`, the matching method signature in `frontend/src/types/electron.d.ts`'s `ElectronAPI.sessions` block, and the `API.sessions.createQuick` client wrapper in `frontend/src/utils/api.ts`. The declared `T` in `Promise<IPCResponse<T>>` MUST match the runtime payload shape returned by TASK-744's handler.

## Implementation Steps

1. **Read TASK-744's plan and handler signature first.** Open `.soloflow/active/plans/quick-session/TASK-744-plan.md` and `main/src/ipc/session.ts` (search for `ipcMain.handle('sessions:create-quick'`) and record the exact success-path return shape. TASK-744 returns `{ success: true, data: { jobId: string; sessionId: string; worktreePath: string } }`, so `T = { jobId: string; sessionId: string; worktreePath: string }`. Use the actual shape from the handler — do not assume.

2. **Define the request type.** The IDEA specifies: no user prompt; `toolType: 'claude' | 'none'`; `projectId: number`. TASK-744 reuses `CreateSessionRequest` (extended with `quickSession?: boolean` and `branchName?: string`). Import that exact symbol from `../types/session` in `preload.ts` and from the frontend equivalent in `electron.d.ts` / `api.ts`. Do NOT redeclare a parallel shape.

3. **Edit `main/src/preload.ts`.** Locate the existing `sessions:` block inside `contextBridge.exposeInMainWorld('electronAPI', { … })`. Immediately after the existing `create:` line, insert:
   ```ts
   createQuick: (request: CreateSessionRequest): Promise<IPCResponse<{ jobId: string; sessionId: string; worktreePath: string }>> =>
     ipcRenderer.invoke('sessions:create-quick', request),
   ```
   - Do NOT add a separate `IPCResponse` redeclaration — reuse the local interface declared at preload.ts line 170 (this preload-local interface is intentional per CLAUDE.md; this task does NOT take on the broader preload cleanup).

4. **Edit `frontend/src/types/electron.d.ts`.** Locate the `sessions: { … }` block inside `interface ElectronAPI`. Immediately after the existing `create:` line, insert:
   ```ts
   createQuick: (request: CreateSessionRequest) => Promise<IPCResponse<{ jobId: string; sessionId: string; worktreePath: string }>>;
   ```
   - The `T` argument MUST match what was used in step 3's preload return type.

5. **Edit `frontend/src/utils/api.ts`.** Locate the `static sessions = { … }` block. Immediately after the existing `create()` method, insert:
   ```ts
   async createQuick(request: CreateSessionRequest) {
     if (!isElectron()) throw new Error('Electron API not available');
     return window.electronAPI.sessions.createQuick(request);
   },
   ```

6. **Run the parity audits.**
   - `grep -rn "interface IPCResponse" frontend/src` — MUST return exactly the two pre-existing lines.
   - `grep -n "sessions:create-quick" main/src/preload.ts` — MUST return exactly one line.
   - `grep -n "createQuick" main/src/preload.ts frontend/src/types/electron.d.ts frontend/src/utils/api.ts` — MUST return exactly three matches.

7. **Run typecheck.** `cd frontend && pnpm typecheck` and `cd main && pnpm typecheck` — both MUST exit 0.

8. **Run the IPCResponse type-contract regression test.** `cd frontend && pnpm test -- ipcResponseType` — MUST exit 0.

## Acceptance Criteria

See frontmatter.

## Test Strategy

No new tests authored. Justification: this task adds only type declarations and a one-line IPC pass-through wrapper. The behavior is verified by (a) `tsc` typecheck (catches T-parity mismatches at compile time across all three edit sites), and (b) the existing `frontend/src/utils/__tests__/ipcResponseType.test.ts` type-contract test, which guards the `IPCResponse<T = unknown>` default that this task depends on.

## Hardest Decision

What return-type `T` to declare for `createQuick`'s `IPCResponse<T>`. Chose `IPCResponse<{ jobId: string; sessionId: string; worktreePath: string }>` to mirror `sessions:create`'s shape — TASK-744's plan returns `{ jobId: job.id }` on success. Step 1 of Implementation Steps explicitly directs the executor to read TASK-744's handler before drafting the type, and the typecheck gates in step 7 will catch any mismatch at compile time across all three edit sites simultaneously.

## Rejected Alternatives

- **Add the createQuick wrapper to the existing `create` method via an overload.** Rejected — the IDEA-024 design specifies a separate `sessions:create-quick` channel.
- **Refactor `main/src/preload.ts` to import `IPCResponse` from `frontend/src/utils/api.ts`.** Rejected — cleanup deferred to a future task per CLAUDE.md.
- **Use `IPCDataResponse<{ jobId: string }>` (data required) instead.** Rejected — quick-session creation can fail; `IPCResponse` correctly models that.

## Lowest Confidence Area

The exact return-data shape of TASK-744's `sessions:create-quick` handler. Step 1 of Implementation Steps explicitly forces the executor to re-read `main/src/ipc/session.ts` before drafting the type, and the typecheck gates in step 7 will catch any mismatch.
