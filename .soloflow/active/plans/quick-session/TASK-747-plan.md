---
id: TASK-747
idea: IDEA-024
status: in-flight
created: "2026-05-23T00:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
files_readonly:
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/hooks/useAddTerminalPanel.ts
  - frontend/src/hooks/useEnsureClaudePanel.ts
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/types/session.ts
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/services/panelApi.ts
  - .soloflow/active/ideas/IDEA-024.md
acceptance_criteria:
  - criterion: "WorkflowPicker renders two new buttons labelled exactly 'Quick Chat' and 'Quick Terminal' below the existing Start Run button, inside the same flex column."
    verification: "grep -nE \"Quick (Chat|Terminal)\" frontend/src/components/cyboflow/WorkflowPicker.tsx returns at least two matches AND the new frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx test 'renders Quick Chat and Quick Terminal buttons' passes."
  - criterion: "Clicking 'Quick Chat' invokes window.electronAPI.sessions.createQuick with { projectId, toolType: 'claude' }, and clicking 'Quick Terminal' invokes it with { projectId, toolType: 'none' }."
    verification: The new frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx tests assert the mocked createQuick was called once with the expected payload.
  - criterion: "After the IPC returns successfully, the WorkflowPicker calls cyboflowStore navigation (setActiveRun OR setActiveQuickSession if TASK-745 has shipped it) so the picker modal closes."
    verification: "Test 'Quick Chat success path closes picker and navigates' asserts that onWorkflowStarted is called with the returned session.id; cyboflowStore active state is updated."
  - criterion: "After Quick Chat resolves with a session that has worktreePath populated, the WorkflowPicker invokes a panel-init callback that creates a Claude panel via panelApi.createPanel; after Quick Terminal it invokes panelApi.createPanel with terminal type and cwd = worktreePath."
    verification: Tests assert mocked panelApi.createPanel was called with the correct payload shape exactly once per click.
  - criterion: Both new buttons are disabled whenever isStarting is true or either quick action is in flight.
    verification: "Test 'Quick Chat button is disabled while the quick-create IPC is in flight' asserts disabled state."
  - criterion: "On IPC failure, the existing red `role=\"alert\"` <p> renders the error message and neither store navigation nor panelApi.createPanel is called."
    verification: "Test 'Quick Chat surfaces IPC error and does not navigate' asserts (a) screen.findByRole('alert') contains the error, (b) no navigation happens, (c) panelApi.createPanel was not called."
  - criterion: The component does not introduce any new ad-hoc `interface IPCResponse` declarations or `as unknown as X` double-casts.
    verification: "grep -nE 'interface IPCResponse|as unknown as' frontend/src/components/cyboflow/WorkflowPicker.tsx returns 0 matches AND `pnpm --filter frontend typecheck` exits 0."
depends_on:
  - TASK-746
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: "New user-facing UI affordance with non-trivial IPC + store + panelApi side effects; the only existing cyboflow test file (CyboflowRoot.test.tsx) does not cover WorkflowPicker's button-handler logic and adding the new behaviour without a dedicated spec would leave the click → IPC → setActiveRun → panel-create flow unverified."
  targets:
    - behavior: "Renders 'Quick Chat' and 'Quick Terminal' buttons below the Start Run button."
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
      type: component
    - behavior: "Quick Chat click calls window.electronAPI.sessions.createQuick with { projectId, toolType: 'claude' }."
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
      type: component
    - behavior: "Quick Terminal click calls window.electronAPI.sessions.createQuick with { projectId, toolType: 'none' }."
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
      type: component
    - behavior: Successful quick-create updates cyboflowStore and fires onWorkflowStarted.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
      type: component
    - behavior: Quick Chat creates a Claude panel via panelApi.createPanel; Quick Terminal creates a terminal panel with cwd = worktreePath.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
      type: component
    - behavior: Quick buttons are disabled while their IPC is in flight.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
      type: component
    - behavior: IPC failure surfaces error message in the existing role=alert region and aborts navigation + panel creation.
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
      type: component
---
# Add Quick Chat / Quick Terminal buttons to WorkflowPicker

## Objective

Extend `WorkflowPicker.tsx` with two new buttons — "Quick Chat" and "Quick Terminal" — rendered below the existing Start Run button. Each button creates a quick session via the `sessions:create-quick` IPC handler (introduced by TASK-744, wired through preload + electron.d.ts by TASK-746), then bootstraps the appropriate panel (Claude for chat, terminal for terminal-only) and navigates to the new session through the cyboflowStore. The buttons inherit the picker's existing `projectId !== null` guard.

## Implementation Steps

1. **Confirm the TASK-746 contract.** Open `frontend/src/types/electron.d.ts` and confirm that the `sessions` block declares `createQuick: (request: CreateSessionRequest) => Promise<IPCResponse<{ jobId: string; sessionId: string; worktreePath: string }>>`. TASK-744 was amended to return all three fields so this task can navigate + bootstrap a panel without a follow-up IPC. If the declared `T` is the older `{ jobId }` shape, TASK-746 has not yet absorbed the TASK-744 amendment — stop and reconcile.

2. **Add necessary imports to `WorkflowPicker.tsx`:**
   ```ts
   import { API } from '../../utils/api';
   import { panelApi } from '../../services/panelApi';
   import type { Session } from '../../types/session';
   ```

3. **Add state for in-flight tracking.** After `const [isStarting, setIsStarting] = useState(false);`:
   ```ts
   const [isQuickStarting, setIsQuickStarting] = useState<null | 'claude' | 'none'>(null);
   ```

4. **Add a `handleQuickStart` handler.** Define above the `return`:
   ```ts
   const handleQuickStart = async (toolType: 'claude' | 'none') => {
     if (isQuickStarting !== null || isStarting) return;
     setError(null);
     setIsQuickStarting(toolType);
     try {
       const result = await window.electronAPI.sessions.createQuick({ projectId, toolType });
       if (!result.success || !result.data) {
         throw new Error(result.error ?? 'Failed to create quick session');
       }
       const { sessionId, worktreePath } = result.data;
       if (toolType === 'claude') {
         await panelApi.createPanel({ sessionId, type: 'claude' });
       } else {
         await panelApi.createPanel({
           sessionId,
           type: 'terminal',
           title: 'Terminal',
           initialState: { cwd: worktreePath },
         });
       }
       // TODO(TASK-745): if cyboflowStore gains setActiveQuickSession, switch to it.
       useCyboflowStore.getState().setActiveRun(sessionId);
       onWorkflowStarted?.(sessionId);
     } catch (err: unknown) {
       setError(err instanceof Error ? err.message : 'Failed to create quick session');
     } finally {
       setIsQuickStarting(null);
     }
   };
   ```

5. **Render the two buttons below the existing Start Run button.** Inside the returned `<div className="flex flex-col gap-3">`, immediately after the Start Run button:
   ```tsx
   <div className="mt-2 flex flex-col gap-2 border-t border-border-primary pt-3">
     <p className="text-xs text-text-secondary">Or start without a workflow:</p>
     <div className="flex gap-2">
       <button
         onClick={() => handleQuickStart('claude')}
         disabled={isQuickStarting !== null || isStarting}
         className="flex-1 rounded border border-interactive bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
         data-testid="quick-chat-button"
       >
         Quick Chat
       </button>
       <button
         onClick={() => handleQuickStart('none')}
         disabled={isQuickStarting !== null || isStarting}
         className="flex-1 rounded border border-interactive bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
         data-testid="quick-terminal-button"
       >
         Quick Terminal
       </button>
     </div>
   </div>
   ```

6. **Create the new test file** `frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx`. Mirror the mock setup used in the sibling `CyboflowRoot.test.tsx`. Implement one `it(...)` per `test_strategy.targets[].behavior` entry above.

7. **Run the verification gate.** Execute:
   ```
   pnpm --filter frontend test -- frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
   pnpm --filter frontend test -- CyboflowRoot.test.tsx
   pnpm --filter frontend typecheck
   ```

## Acceptance Criteria

See frontmatter. The two enforcement levers are (a) the new `frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx` (must be green) and (b) the visible-string grep on the source file.

## Test Strategy

See frontmatter `test_strategy`. Seven test cases covering button presence, IPC invocation shape for both toolTypes, store + onWorkflowStarted side-effects on success, panel-create dispatch for both toolTypes, in-flight disabled state, and IPC-failure error surfacing.

## Hardest Decision

Whether to use `useAddTerminalPanel` / `useEnsureClaudePanel` hooks vs. calling `panelApi.createPanel` directly. Chose direct `panelApi.createPanel` — the hooks assume the panel surface is already mounted for the target session, which is not true at quick-create time. Calling the hooks would no-op visually until `usePanelSurface` re-keys on `setActiveRun`.

## Rejected Alternatives

- **Add a new `useCreateQuickSession` hook.** Would centralize the pattern with TASK-748. Rejected for this task because the skeleton scopes WorkflowPicker only.
- **Call `useAddTerminalPanel(session)` / `useEnsureClaudePanel(session)` after IPC success.** See Hardest Decision.
- **Defer the panel-create to TASK-748 / TASK-749 and only fire navigation here.** Would shrink the diff but the user expectation per IDEA slice 2 is that clicking Quick Chat produces a session with a Claude panel visible.

## Lowest Confidence Area

The cyboflowStore navigation contract. This plan calls `setActiveRun(session.sessionId)` — passing a session id into an action whose parameter is documented as a runId and which starts a `subscribeToStreamEvents` against that value. The IDEA endorses this approach with the understanding TASK-745 may add `activeQuickSessionId`. The executor should leave the TODO comment so a follow-up swap is easy if TASK-745 ships first.

Second-order concern: TASK-744's return shape is `{ jobId }`, not `{ sessionId, worktreePath }`. If TASK-744 does not return enough information to navigate to the new session, this task needs to extend the IPC return shape OR poll the existing session-stream events. Surface this to TASK-744's executor at integration time — preferred fix is for TASK-744 to also return `sessionId` and `worktreePath` in the success payload.
