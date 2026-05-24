---
id: TASK-748
idea: IDEA-024
status: ready
created: "2026-05-23T00:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/hooks/useAddQuickSessionShortcut.ts
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/hooks/__tests__/useAddQuickSessionShortcut.test.ts
files_readonly:
  - frontend/src/hooks/useAddTerminalShortcut.ts
  - frontend/src/hooks/useAddClaudeShortcut.ts
  - frontend/src/hooks/useAddTerminalPanel.ts
  - frontend/src/hooks/useEnsureClaudePanel.ts
  - frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts
  - frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/components/ui/Modal.tsx
  - main/src/types/session.ts
acceptance_criteria:
  - criterion: "A Quick Session button is rendered in the CyboflowRoot header row, immediately adjacent to the existing 'Choose workflow' button (same flex container), with data-testid='open-quick-session-picker' and accessible name 'Quick Session'."
    verification: "grep -n 'data-testid=\"open-quick-session-picker\"' frontend/src/components/cyboflow/CyboflowRoot.tsx returns exactly one match."
  - criterion: "When projectId === null, the Quick Session button renders with the disabled attribute set, carries the title attribute 'Select a project to start a quick session', and clicking it does NOT open the mode picker or invoke window.electronAPI.sessions.createQuick."
    verification: "A vitest case in CyboflowRoot.test.tsx renders with projectId={null}, asserts the button is disabled, asserts the title attribute matches, fires a click, and asserts no mode-picker UI appears and no createQuick mock is invoked."
  - criterion: "When projectId is a number, clicking the Quick Session button reveals an inline mode picker presenting exactly two choices labeled 'Chat' and 'Terminal'. Clicking outside the picker or pressing Escape dismisses it without invoking createQuick."
    verification: "A vitest case renders with projectId={1}, clicks Quick Session, asserts Chat/Terminal appear, dispatches Escape, asserts both are removed and createQuick was not invoked."
  - criterion: "Selecting 'Chat' from the mode picker invokes window.electronAPI.sessions.createQuick with { projectId, toolType: 'claude' } exactly once."
    verification: "A vitest case renders with projectId={42}, clicks Quick Session then Chat, awaits the handler, asserts createQuick was called once with projectId: 42 and toolType: 'claude'."
  - criterion: "Selecting 'Terminal' from the mode picker invokes window.electronAPI.sessions.createQuick with { projectId, toolType: 'none' } exactly once."
    verification: Analogous vitest case for Terminal.
  - criterion: "The Cmd+Shift+S (Mac) / Ctrl+Shift+S (Win/Linux) keyboard shortcut opens the same inline mode picker that the header button opens, gated by the same projectId !== null guard."
    verification: "grep -n 'useAddQuickSessionShortcut' frontend/src/components/cyboflow/CyboflowRoot.tsx returns at least one import and one call site. A vitest case in frontend/src/hooks/__tests__/useAddQuickSessionShortcut.test.ts uses renderHook + fireEvent.keyDown with metaKey/shiftKey to fire the callback."
  - criterion: "The useAddQuickSessionShortcut hook file exists at frontend/src/hooks/useAddQuickSessionShortcut.ts and exports a single named function with the signature (onTrigger: () => void, opts?: { enabled?: boolean }): void."
    verification: "test -f frontend/src/hooks/useAddQuickSessionShortcut.ts; grep -nE 'export function useAddQuickSessionShortcut\\(' returns exactly one match."
  - criterion: The useAddQuickSessionShortcut hook honors the focus guard and the enabled=false escape hatch.
    verification: frontend/src/hooks/__tests__/useAddQuickSessionShortcut.test.ts contains test cases mirroring useAddTerminalShortcut.test.ts and all pass.
  - criterion: "`pnpm --filter frontend test` passes with the new and updated test cases. `pnpm --filter frontend typecheck` passes (no `any` usage in the new hook or new test cases)."
    verification: Both commands exit 0.
depends_on:
  - TASK-746
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: "This task ships user-facing UI (header button, mode picker, disabled state) and a new keyboard-shortcut hook. CyboflowRoot.test.tsx MUST be updated because its current tests rely on the exact DOM shape of the header row. A new sibling test for useAddQuickSessionShortcut is added alongside the analogous useAddTerminalShortcut.test.ts."
  targets:
    - behavior: "Quick Session button is rendered next to Choose workflow with the correct testid, label, and disabled+title-tooltip behavior when projectId is null."
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: Clicking Quick Session opens an inline Chat/Terminal mode picker; Escape and outside-click dismiss it without invoking the IPC.
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: "Selecting Chat invokes createQuick with toolType='claude'; selecting Terminal invokes it with toolType='none'."
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: "useAddQuickSessionShortcut fires on Cmd+Shift+S (Mac) and Ctrl+Shift+S (Win/Linux), respects focus guards, honors opts.enabled=false, and cleans up on unmount."
      test_file: frontend/src/hooks/__tests__/useAddQuickSessionShortcut.test.ts
      type: unit
---
# Add Quick Session header button and keyboard shortcut to CyboflowRoot

## Objective

Surface a persistent, project-aware Quick Session entry point in the CyboflowRoot header so users can start a Chat- or Terminal-only session without opening WorkflowPicker. Add a standalone button next to "Choose workflow" that opens an inline two-option (Chat / Terminal) mode picker, plus a Cmd/Ctrl+Shift+S keyboard shortcut wired through a new `useAddQuickSessionShortcut` hook that mirrors the existing `useAddTerminalShortcut` / `useAddClaudeShortcut` pattern. The button is disabled with a tooltip when no project is selected (Q4 default).

## Implementation Steps

1. **Create the keyboard-shortcut hook** at `frontend/src/hooks/useAddQuickSessionShortcut.ts`. Copy the structure of `useAddClaudeShortcut.ts` verbatim, change function name and key match to 'S' / 'KeyS'.

2. **Create the hook unit tests** at `frontend/src/hooks/__tests__/useAddQuickSessionShortcut.test.ts`. Copy `useAddTerminalShortcut.test.ts` as template; change shortcut firing to S/KeyS with metaKey/ctrlKey + shiftKey; add regression cases for plain S (no modifiers) and Cmd+Shift+C.

3. **Modify CyboflowRoot.tsx imports.** Add:
   ```ts
   import { useAddQuickSessionShortcut } from '../../hooks/useAddQuickSessionShortcut';
   ```
   Ensure `useCallback` and `useEffect` are imported from React.

4. **Add local state for the inline mode picker.** Beneath the existing `isPickerOpen` state:
   ```ts
   const [isQuickModePickerOpen, setIsQuickModePickerOpen] = useState(false);
   ```

5. **Define the quick-session click handler:**
   ```ts
   const handlePickQuickMode = useCallback(async (toolType: 'claude' | 'none') => {
     setIsQuickModePickerOpen(false);
     if (projectId === null) return;
     try {
       await window.electronAPI.sessions.createQuick({ projectId, toolType });
     } catch (err) {
       console.error('[CyboflowRoot] createQuick failed', err);
     }
   }, [projectId]);
   ```

6. **Define the quick-session trigger:**
   ```ts
   const handleOpenQuickPicker = useCallback(() => {
     if (projectId === null) return;
     setIsQuickModePickerOpen((prev) => !prev);
   }, [projectId]);
   ```

7. **Register the keyboard shortcut** below the existing `useAddClaudeShortcut(ensureClaudePanel);` line:
   ```ts
   useAddQuickSessionShortcut(handleOpenQuickPicker, { enabled: projectId !== null });
   ```

8. **Render the Quick Session button in the header.** Inside the existing header flex container, after the "Choose workflow" button, add a relatively-positioned container with the button + inline mode picker.

9. **Wire Escape-key + outside-click dismissal** via a `useEffect` gated on `isQuickModePickerOpen`.

10. **Extend the existing CyboflowRoot test file** with a new `describe('CyboflowRoot — Quick Session', ...)` block containing the four test cases.

11. **Re-run the full sibling test suite.** Execute `pnpm --filter frontend test cyboflow/CyboflowRoot` and `pnpm --filter frontend test hooks/useAddQuickSessionShortcut`. Then `pnpm --filter frontend typecheck`.

## Acceptance Criteria

Reproduced from frontmatter — each criterion has an objective pass/fail verification.

## Test Strategy

Two test surfaces are extended/created:

1. **`frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx`** — append a new `describe('CyboflowRoot — Quick Session', ...)` block. Stub `window.electronAPI.sessions.createQuick` in `beforeEach`.

2. **`frontend/src/hooks/__tests__/useAddQuickSessionShortcut.test.ts`** — new file, parallel to `useAddTerminalShortcut.test.ts`. Mirrors the five describe blocks.

## Hardest Decision

Whether to use the existing `Modal` overlay component or render an inline absolutely-positioned popover. Chose the inline popover — the IDEA explicitly says "Keep it minimal — no new modal component", and two simultaneous modal layers (WorkflowPicker + mode picker) would create confusing dismiss semantics.

Second-hardest: the keyboard shortcut binding. Cmd+Shift+S was chosen because it is mnemonic, unused in the existing codebase, and follows the Cmd+Shift+{letter} convention of the existing shortcuts.

## Rejected Alternatives

1. **Open a full Modal for mode selection** — rejected per the IDEA's explicit "no new modal" directive.
2. **Shortcut jumps straight to Chat** — rejected because IDEA recommends opening the picker so both panel types remain accessible.
3. **Reuse `WorkflowPicker`'s state for the mode picker** — rejected, dismiss semantics would tangle.
4. **Custom `<Tooltip>` component for disabled state** — rejected because the simple `title` attribute satisfies the AC.

## Lowest Confidence Area

The exact runtime shape returned by `window.electronAPI.sessions.createQuick`. The plan does NOT attempt to navigate to the new session in step 5 — that navigation is intentionally left to a follow-up because the cyboflowStore currently keys on `activeRunId` and quick sessions have no run. The test asserts only the IPC call, not any post-call navigation. If the user wants click-to-navigate behavior in v1, that is a follow-up after the cyboflowStore gains an `activeQuickSessionId` slice (TASK-745).
