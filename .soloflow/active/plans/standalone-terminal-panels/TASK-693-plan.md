---
id: TASK-693
idea: IDEA-020
status: ready
created: "2026-05-20T23:00:00Z"
files_owned:
  - frontend/src/hooks/useAddClaudeShortcut.ts
  - frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
  - frontend/src/components/panels/PanelTabBar.tsx
  - frontend/src/types/panelComponents.ts
  - frontend/src/components/ProjectView.tsx
  - tests/standalone-terminal-panels.spec.ts
  - frontend/src/components/SessionView.tsx
files_readonly:
  - frontend/src/hooks/useAddTerminalShortcut.ts
  - frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts
  - frontend/src/App.tsx
acceptance_criteria:
  - criterion: A new file frontend/src/hooks/useAddClaudeShortcut.ts exists and exports a function named useAddClaudeShortcut.
    verification: "test -f frontend/src/hooks/useAddClaudeShortcut.ts && grep -q 'export function useAddClaudeShortcut' frontend/src/hooks/useAddClaudeShortcut.ts"
  - criterion: "useAddClaudeShortcut matches event.key === 'C' OR event.code === 'KeyC' with shiftKey AND (metaKey OR ctrlKey), and applies the same focus guards as useAddTerminalShortcut."
    verification: "grep -Eq \"event.key !== 'C'.*event.code !== 'KeyC'\" frontend/src/hooks/useAddClaudeShortcut.ts && grep -q 'shiftKey' frontend/src/hooks/useAddClaudeShortcut.ts && grep -q '(event.metaKey || event.ctrlKey)' frontend/src/hooks/useAddClaudeShortcut.ts && grep -q 'isContentEditable' frontend/src/hooks/useAddClaudeShortcut.ts"
  - criterion: PanelTabBarProps interface declares an optional onAddClaude callback.
    verification: "grep -nE 'onAddClaude\\??: \\(\\) => void' frontend/src/types/panelComponents.ts"
  - criterion: "PanelTabBar renders a button with aria-label 'Add Claude panel' inside the trailing-edge action row."
    verification: "grep -q 'aria-label=\"Add Claude panel\"' frontend/src/components/panels/PanelTabBar.tsx && grep -q 'handleAddClaude' frontend/src/components/panels/PanelTabBar.tsx"
  - criterion: "ProjectView wires onAddClaude={ensureClaudePanel} and registers useAddClaudeShortcut(ensureClaudePanel)."
    verification: "grep -q 'onAddClaude={ensureClaudePanel}' frontend/src/components/ProjectView.tsx && grep -q 'useAddClaudeShortcut(ensureClaudePanel)' frontend/src/components/ProjectView.tsx"
  - criterion: frontend/src/components/SessionView.tsx is unchanged (out of scope per IDEA-020).
    verification: "git diff --name-only HEAD -- frontend/src/components/SessionView.tsx | wc -l | grep -q '^0$'"
  - criterion: "A vitest suite at useAddClaudeShortcut.test.ts exists and exercises Mac path, Linux path, modifier guard, focus guards, opts.enabled, and unmount cleanup."
    verification: "cd frontend && pnpm exec vitest run src/hooks/__tests__/useAddClaudeShortcut.test.ts"
  - criterion: Existing useAddTerminalShortcut tests still pass (regression guard).
    verification: "cd frontend && pnpm exec vitest run src/hooks/__tests__/useAddTerminalShortcut.test.ts"
  - criterion: Typecheck and lint pass.
    verification: "pnpm typecheck && pnpm lint"
  - criterion: "Visual verification: '+ Claude' button appears next to '+ Terminal'; clicking opens a Claude panel (activating existing if present); Cmd/Ctrl+Shift+C does the same; '+ Terminal' remains unaffected."
    verification: "Manual capture via pnpm dev. Screenshot to test-results/add-claude-button.png. Cross-check cyboflow-frontend-debug.log for any '[ProjectView]' errors."
depends_on: []
estimated_complexity: low
epic: standalone-terminal-panels
test_strategy:
  needed: true
  justification: "Sibling test useAddTerminalShortcut.test.ts (200 lines) directly covers the analogous hook. Mirroring it for useAddClaudeShortcut is mandatory under rule 5b sibling-test scan: a new keyboard hook with no test coverage diverges from epic precedent."
  targets:
    - behavior: "Mac path: Cmd+Shift+C invokes callback exactly once"
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: "Linux/Windows path: Ctrl+Shift+C invokes callback exactly once"
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: "Modifier-and-key guards: plain C, Cmd+Shift+T, Cmd+C without shift do NOT fire"
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: "Focus guards: input, textarea, contentEditable suppress the shortcut"
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
    - behavior: opts.enabled gating + unmount cleanup
      test_file: frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts
      type: unit
---
# Add '+ Claude' button and Cmd/Ctrl+Shift+C shortcut to project panel tab bar

## Objective

Wire a discoverable '+ Claude' affordance to the project (main-repo) panel tab bar — both a button (mirroring the existing '+ Terminal' button) and a Cmd/Ctrl+Shift+C keyboard shortcut hook — that calls the existing `ensureClaudePanel()` in `ProjectView.tsx:159`. Closes the discoverability gap surfaced during SPRINT-026 smoke testing where the only path to a new Claude panel was a git Pull/Push side effect. The underlying `panelApi.createPanel({ type: 'claude' })` plumbing already exists; this task is pure UI wiring. SessionView (worktree-run context) is explicitly out of scope.

## Implementation Steps

1. **Create `frontend/src/hooks/useAddClaudeShortcut.ts`**. Mirror the structure of `useAddTerminalShortcut.ts` exactly:
   - Function name: `useAddClaudeShortcut`.
   - Parameter name: `onAddClaude`.
   - Key match: `event.key !== 'C' && event.code !== 'KeyC'` (uppercase 'C' — matches the convention in `App.tsx:337`, since shifted ASCII letters arrive as uppercase in `event.key`).
   - JSDoc: reference "Cmd+Shift+C" / "Ctrl+Shift+C"; note no conflict with App.tsx's Cmd+Shift+T, useSessionView's Cmd+Shift+D/R, or DraggableProjectTreeView's Cmd+Shift+N.
   - Preserve the focus-guard contract verbatim (suppress inside HTMLInputElement / HTMLTextAreaElement / isContentEditable).

2. **Create `frontend/src/hooks/__tests__/useAddClaudeShortcut.test.ts`**. Mirror `useAddTerminalShortcut.test.ts` with C/KeyC substitutions. Six describe blocks: Mac, Linux, modifier-and-key guards, focus guard, opts.enabled, cleanup on unmount.

3. **Extend `PanelTabBarProps` in `frontend/src/types/panelComponents.ts`**:
   ```ts
   onAddClaude?: () => void | Promise<void>;
   ```

4. **Wire the '+ Claude' button into `PanelTabBar.tsx`**:
   - Destructure `onAddClaude` from props.
   - Add `handleAddClaude` callback memoized on `[onAddClaude]`, mirroring `handleAddTerminal` at line 88: bail when `!onAddClaude`, invoke `onAddClaude()`, `.catch()` with `console.error('[PanelTabBar] Failed to add claude panel:', err)`.
   - Extend the trailing-action gating predicate at line 256: include `onAddClaude` in the OR chain.
   - Inside the action row, add `{onAddClaude && (<button ...>)}` block AFTER the existing `{onAddTerminal && ...}` block. Reuse the exact className from '+ Terminal'. Render `<Plus className="w-4 h-4" />` followed by `<MessageSquare className="w-4 h-4" />` (both icons already imported at line 2). aria-label and title: "Add Claude panel". Include `<span className="sr-only">`.

5. **Wire the affordance in `ProjectView.tsx`**:
   - Add import: `import { useAddClaudeShortcut } from '../hooks/useAddClaudeShortcut';`
   - After existing `useAddTerminalShortcut(handleAddTerminal);` at line 195, add: `useAddClaudeShortcut(ensureClaudePanel);`.
   - In `<PanelTabBar context="project" ... />` block (lines 362–369), add prop `onAddClaude={ensureClaudePanel}`.
   - Activate-existing semantics: modify `ensureClaudePanel` (line 159) to first search `sessionPanels` for an existing `type === 'claude'` panel and route through `handlePanelSelect(existing)` if found. Add `sessionPanels` and `handlePanelSelect` to the useCallback dep array. Pull/Push handlers (lines 198–218) already pre-check; their double-check after this change is harmless.

6. **Add Playwright coverage** to `tests/standalone-terminal-panels.spec.ts`. New `test.describe('Add Claude Button — PanelTabBar', ...)` block mirroring the three Add Terminal tests: aria-label visibility, click creates new Claude tab (screenshot to `test-results/add-claude-project.png`), Enter key activation. Reuse existing `dismissOnboarding` and `navigateToFirstProject` helpers.

7. **Visual verification.** `pnpm build:main && pnpm dev`. Select a project. Click '+ Claude' → Claude panel materializes. Press Cmd+Shift+C → same. With Claude panel open, click '+ Claude' again → focus moves to existing panel (no duplicate). '+ Terminal' button + Cmd+Shift+Backquote shortcut remain functional.

8. **Final guards.** Run `pnpm typecheck && pnpm lint && (cd frontend && pnpm exec vitest run src/hooks/__tests__/useAddClaudeShortcut.test.ts src/hooks/__tests__/useAddTerminalShortcut.test.ts)`.

## Acceptance Criteria

See frontmatter.

## Test Strategy

Mirror the existing `useAddTerminalShortcut.test.ts` retargeting the key match to 'C' / 'KeyC'. Six describe blocks. No mock setup beyond jsdom. Playwright additions give end-to-end DOM coverage for button rendering, click activation, keyboard activation.

## Hardest Decision

**Whether to modify `ensureClaudePanel` to activate-existing semantics in this task.** The IDEA's Q4 default is "activate existing if present" and the function name itself implies that contract. Two options: (1) modify `ensureClaudePanel` now (chosen) — adds 3-line find-and-activate check; (2) leave create-only and add the check in a new wrapper — rejected, creates two slightly-different "ensure" functions. Chosen because Pull/Push paths already perform the same external find-or-create pattern, so internalizing it makes them cleaner without changing observable behavior.

## Rejected Alternatives

- **Implement only the button, defer the shortcut.** Rejected — IDEA explicitly resolved Q2 to Cmd+Shift+C symmetric with `useAddTerminalShortcut`. Reconsider if OS-level binding conflict surfaces.
- **Add the affordance to SessionView in the same task.** Rejected per IDEA-020 hard boundary — SessionView is out-of-scope.
- **Use `event.key === 'c'` (lowercase).** Rejected — every existing internal Cmd+Shift+<letter> binding uses uppercase form (what browsers emit for shifted letters).
- **Always-create-new semantics (Q4 candidate 2).** Rejected — single-Claude-panel-per-session invariant matches the rest of the codebase.

## Lowest Confidence Area

**OS-level binding conflicts for Cmd+Shift+C on Linux/Windows.** macOS doesn't bind globally. Some Linux DEs (rare) and some browser extensions bind Ctrl+Shift+C to "inspect element"; Electron doesn't surface devtools in production. Fallback if visual verification surfaces a conflict: swap to Cmd+Shift+J or Cmd+Shift+L. Second concern: activate-existing modification interacting with the `panel:created` event listener at line 297 — there's a benign window where `addPanel` is called twice for the same panel, but the existing dedup comment at line 291 suggests it's handled.
