---
id: TASK-794
idea: IDEA-028
status: done
created: 2026-05-27T12:00:00.000Z
files_owned:
  - frontend/src/components/cyboflow/SessionCreatePrDialog.tsx
  - frontend/src/utils/api.ts
  - main/src/ipc/git.ts
  - main/src/preload.ts
  - frontend/src/types/electron.d.ts
files_readonly:
  - frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx
  - frontend/src/components/cyboflow/SessionActionToast.tsx
  - frontend/src/components/ErrorDialog.tsx
  - main/src/ipc/session.ts
  - main/src/services/worktreeManager.ts
  - frontend/src/components/CommitDialog.tsx
  - frontend/src/components/ui/Modal.tsx
  - frontend/src/components/ui/Button.tsx
  - main/src/utils/commandExecutor.ts
  - main/src/ipc/app.ts
acceptance_criteria:
  - criterion: "IPC handler 'sessions:get-remote-url' exists in main/src/ipc/git.ts and returns the origin remote URL for a session's worktree"
    verification: "grep -n 'sessions:get-remote-url' main/src/ipc/git.ts returns a match inside an ipcMain.handle call"
  - criterion: "Preload bridge exposes getRemoteUrl method on sessions namespace"
    verification: "grep -n 'getRemoteUrl' main/src/preload.ts returns a match mapping to 'sessions:get-remote-url'"
  - criterion: "ElectronAPI type declaration includes getRemoteUrl in sessions interface"
    verification: "grep -n 'getRemoteUrl' frontend/src/types/electron.d.ts returns a match inside the sessions block"
  - criterion: "API.sessions.getRemoteUrl wrapper exists in api.ts"
    verification: "grep -n 'getRemoteUrl' frontend/src/utils/api.ts returns a match inside the sessions static object"
  - criterion: "SessionCreatePrDialog.tsx exists and exports a SessionCreatePrDialog component"
    verification: "grep -n 'export function SessionCreatePrDialog' frontend/src/components/cyboflow/SessionCreatePrDialog.tsx returns 1 match"
  - criterion: "Dialog calls gitPush, then getRemoteUrl, parses a GitHub remote URL to construct a /compare/{branch} URL, and opens it via shell.openExternal"
    verification: "grep -n 'openExternal' frontend/src/components/cyboflow/SessionCreatePrDialog.tsx returns at least 1 match"
  - criterion: "On successful push+openExternal, calls API.sessions.delete to archive the session"
    verification: "grep -n 'API.sessions.delete' frontend/src/components/cyboflow/SessionCreatePrDialog.tsx returns at least 1 match"
  - criterion: "If remote URL is not a recognized GitHub URL, shows fallback with branch name"
    verification: "grep -n 'branch' frontend/src/components/cyboflow/SessionCreatePrDialog.tsx returns matches showing fallback copy display"
  - criterion: "On failure, ErrorDialog is shown and sessions:delete is NOT called"
    verification: "Read SessionCreatePrDialog.tsx and verify the delete call is inside the success path only"
  - criterion: "TypeScript compiles with no errors for all modified files"
    verification: "pnpm typecheck exits 0"
depends_on: [TASK-792]
estimated_complexity: medium
epic: session-lifecycle-actions
test_strategy:
  needed: false
  justification: "New file with no existing sibling tests covering it. IPC handler is a thin pass-through. The api.ts change is a 3-line wrapper. Component tests can be added in a follow-up."
---

# Add sessions:get-remote-url IPC and implement Create PR flow

## Objective

Wire a new `sessions:get-remote-url` IPC channel that returns the origin remote URL and branch name for a session's worktree, then build `SessionCreatePrDialog` that pushes the branch, parses the GitHub origin URL to construct a `/compare/{branch}` URL, opens it in the default browser, and archives the session.

## Implementation Steps

1. **Add `sessions:get-remote-url` IPC handler in `main/src/ipc/git.ts`** — runs `git remote get-url origin` and `git branch --show-current` in the worktree path. Returns `{ success: true, data: { remoteUrl, branchName } }`.

2. **Add preload bridge in `main/src/preload.ts`** — `getRemoteUrl: (sessionId: string) => ipcRenderer.invoke('sessions:get-remote-url', sessionId)`

3. **Add type declaration in `frontend/src/types/electron.d.ts`** — `getRemoteUrl: (sessionId: string) => Promise<IPCResponse<{ remoteUrl: string; branchName: string }>>`

4. **Add API wrapper in `frontend/src/utils/api.ts`** — `API.sessions.getRemoteUrl(sessionId)`

5. **Create `frontend/src/components/cyboflow/SessionCreatePrDialog.tsx`** with:
   - Props: `isOpen`, `onClose`, `sessionId`, `sessionName`, `onSuccess`, `onError`
   - Multi-step flow: confirm → pushing → opening → done
   - On confirm: push branch → get remote URL → parse GitHub URL → open compare URL → delete session → show toast
   - GitHub URL parser: handles HTTPS (`https://github.com/{owner}/{repo}`) and SSH (`git@github.com:{owner}/{repo}`) forms
   - Non-GitHub fallback: show branch name in copyable block with manual instructions
   - Error handling: show error, don't delete

## Acceptance Criteria

1. `sessions:get-remote-url` IPC handler returns remote URL and branch name
2. Full IPC chain wired: handler → preload → electron.d.ts → api.ts
3. Happy path: push → parse GitHub → open compare URL → delete → toast
4. Non-GitHub fallback with branch name display
5. Error path: no delete on failure
6. `pnpm typecheck` passes
