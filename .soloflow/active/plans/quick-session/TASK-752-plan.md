---
id: TASK-752
idea: SPRINT-037-compound
status: ready
created: 2026-05-25T00:00:00Z
files_owned:
  - frontend/src/hooks/useQuickSession.ts
  - frontend/src/hooks/__tests__/useQuickSession.test.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
files_readonly:
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/services/panelApi.ts
  - frontend/src/types/session.ts
  - main/src/preload.ts
  - main/src/ipc/session.ts
  - .soloflow/active/findings/SPRINT-037-findings.md
  - .soloflow/archive/done/quick-session/TASK-747-done.md
  - .soloflow/archive/done/quick-session/TASK-748-done.md
acceptance_criteria:
  - criterion: "A new hook `useQuickSession` exists in frontend/src/hooks/useQuickSession.ts and exposes typed { start, isStarting, error }"
    verification: "grep -n 'export function useQuickSession' frontend/src/hooks/useQuickSession.ts returns a match"
  - criterion: "useQuickSession routes through API.sessions.createQuick (TASK-746 wrapper), then panelApi.createPanel, then setActiveQuickSession"
    verification: "grep -n 'API.sessions.createQuick\\|panelApi.createPanel\\|setActiveQuickSession' frontend/src/hooks/useQuickSession.ts returns three or more matches"
  - criterion: "WorkflowPicker.tsx no longer references window.electronAPI.sessions.createQuick"
    verification: "grep -n 'window.electronAPI.sessions.createQuick' frontend/src/components/cyboflow/WorkflowPicker.tsx returns 0 matches"
  - criterion: "CyboflowRoot.tsx no longer references window.electronAPI.sessions.createQuick"
    verification: "grep -n 'window.electronAPI.sessions.createQuick' frontend/src/components/cyboflow/CyboflowRoot.tsx returns 0 matches"
  - criterion: "Both call sites import and use useQuickSession"
    verification: "grep -n 'useQuickSession' frontend/src/components/cyboflow/WorkflowPicker.tsx frontend/src/components/cyboflow/CyboflowRoot.tsx returns at least two matches"
  - criterion: "CyboflowRoot regression tests assert panelApi.createPanel called AND activeQuickSessionId set after picker selection (both Chat and Terminal)"
    verification: "pnpm --filter frontend test -- CyboflowRoot exits 0; new it() blocks for chat-full-lifecycle and terminal-full-lifecycle present"
  - criterion: "useQuickSession unit test covers success and failure paths"
    verification: "pnpm --filter frontend test -- useQuickSession exits 0"
  - criterion: "Existing WorkflowPicker Quick Chat / Quick Terminal tests still pass"
    verification: "pnpm --filter frontend test -- WorkflowPicker exits 0"
  - criterion: "pnpm typecheck && pnpm lint exit 0"
    verification: "pnpm typecheck && pnpm lint exit 0"
depends_on: []
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: "FIND-SPRINT-037-3 documents that CyboflowRoot's Quick button silently produces orphan worktrees because handlePickQuickMode skips panelApi.createPanel and setActiveQuickSession. The existing CyboflowRoot Quick Session tests assert the createQuick call but NOT the full lifecycle — that gap is exactly what let the bug ship. New regression tests close that gap. The new hook is non-trivial shared logic that warrants dedicated unit tests."
  targets:
    - behavior: "useQuickSession success path: createQuick resolves → panelApi.createPanel called with correct args → setActiveQuickSession called → onSuccess invoked → isStarting returns to null"
      test_file: "frontend/src/hooks/__tests__/useQuickSession.test.tsx"
      type: unit
    - behavior: "useQuickSession failure path: createQuick returns { success: false, error } → error state populated; setActiveQuickSession NOT called; panelApi.createPanel NOT called"
      test_file: "frontend/src/hooks/__tests__/useQuickSession.test.tsx"
      type: unit
    - behavior: "CyboflowRoot Chat pick: panelApi.createPanel called with type='claude' AND activeQuickSessionId set"
      test_file: "frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx"
      type: component
    - behavior: "CyboflowRoot Terminal pick: panelApi.createPanel called with type='terminal' and initialState.cwd=worktreePath AND activeQuickSessionId set"
      test_file: "frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx"
      type: component
---

# Extract useQuickSession hook + complete CyboflowRoot lifecycle wiring

## Objective

`CyboflowRoot.handlePickQuickMode` calls `createQuick` but skips `panelApi.createPanel`, `setActiveQuickSession`, and navigation — the header Quick button silently creates orphan worktrees. `WorkflowPicker.handleQuickStart` does the full lifecycle correctly. Both call sites duplicate the `{ prompt: '', projectId, toolType }` payload and bypass the dead `API.sessions.createQuick` wrapper. Extract a shared `useQuickSession` hook, replace both call sites, route through the wrapper (killing FIND-SPRINT-037-4's dead-code finding), and add CyboflowRoot lifecycle regression tests.

## Implementation Steps

1. Create `frontend/src/hooks/useQuickSession.ts`. Signature:
   ```ts
   interface UseQuickSessionOptions {
     projectId: number | null;
     onSuccess?: (sessionId: string) => void;
   }
   interface UseQuickSessionReturn {
     start: (toolType: 'claude' | 'none') => Promise<void>;
     isStarting: 'claude' | 'none' | null;
     error: string | null;
   }
   export function useQuickSession(opts: UseQuickSessionOptions): UseQuickSessionReturn;
   ```
   Internals: guard `projectId === null || isStarting !== null`; set `isStarting`; invoke `API.sessions.createQuick({ prompt: '', projectId, toolType })`; on `{ success: false }` throw; on success call `panelApi.createPanel` (type-specific) → `useCyboflowStore.getState().setActiveQuickSession(sessionId)` → `opts.onSuccess?.(sessionId)`. `finally` clear `isStarting`.

2. Refactor `WorkflowPicker.tsx`: delete `isQuickStarting` state + `handleQuickStart`; instantiate `const quickSession = useQuickSession({ projectId, onSuccess: onWorkflowStarted })`; wire buttons to `quickSession.start('claude' | 'none')`; surface `quickSession.error ?? error` in the existing alert.

3. Refactor `CyboflowRoot.tsx`: delete `handlePickQuickMode`; instantiate `const quickSession = useQuickSession({ projectId })`; mode-button handlers become `() => { setIsQuickModePickerOpen(false); void quickSession.start('claude' | 'none'); }`.

4. Create `frontend/src/hooks/__tests__/useQuickSession.test.tsx` with success + failure tests using `renderHook`. Mock `../../utils/api` (`API.sessions.createQuick`), `../../services/panelApi` (`panelApi.createPanel`). Reset store via `useCyboflowStore.getState().clearActiveQuickSession()` in beforeEach.

5. Extend `CyboflowRoot.test.tsx` Quick Session block with two new tests:
   - **Chat full lifecycle**: after Chat click, `panelApi.createPanel` called with `{ sessionId, type: 'claude' }` AND `activeQuickSessionId === sessionId`.
   - **Terminal full lifecycle**: after Terminal click, `panelApi.createPanel` called with `{ sessionId, type: 'terminal', title: 'Terminal', initialState: { cwd: worktreePath } }` AND `activeQuickSessionId === sessionId`.

6. Confirm existing WorkflowPicker tests pass against the refactored implementation (behavior-preservation).

7. `pnpm typecheck && pnpm lint && pnpm --filter frontend test`.

## Acceptance Criteria
See frontmatter.

## Hardest Decision
Whether the hook accepts `onSuccess` callback vs. relying on consumers reading `activeQuickSessionId` from the store. Chose `onSuccess` to preserve `WorkflowPicker`'s existing `onWorkflowStarted` prop with minimum diff.

## Rejected Alternatives
- **Inline duplicated logic without extracting a hook.** Rejected — proposal calls for extraction; single test surface + kills FIND-SPRINT-037-4 dead-code finding.
- **Route through `window.electronAPI.sessions.createQuick` directly.** Rejected — the dead `API.sessions.createQuick` wrapper exists; wiring it kills the dead-code finding for free.

## Lowest Confidence Area
Picker-dismissal ordering in CyboflowRoot — currently dismiss-then-start; matches today's UX. If a future requirement demands picker stay open on error, dismissal moves into `onSuccess` callback.
