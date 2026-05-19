---
id: TASK-659
idea: IDEA-019
status: ready
created: 2026-05-19T00:00:00Z
files_owned:
  - frontend/src/components/panels/TerminalPanel.tsx
  - frontend/src/hooks/useAddTerminalShortcut.ts
  - frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts
files_readonly:
  - frontend/src/contexts/SessionContext.tsx
  - frontend/src/components/panels/PanelTabBar.tsx
  - frontend/src/components/ProjectView.tsx
  - frontend/src/components/SessionView.tsx
  - frontend/src/App.tsx
  - frontend/src/hooks/useReviewQueueKeyboard.ts
  - frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
  - shared/types/panels.ts
  - frontend/src/types/panelComponents.ts
acceptance_criteria:
  - criterion: "TerminalPanel renders a thin header bar above the xterm viewport that displays the current working directory."
    verification: "grep -n 'data-testid=\"terminal-cwd-breadcrumb\"' frontend/src/components/panels/TerminalPanel.tsx returns at least one match and the element renders panel.state.customState.cwd (with fallback to SessionContext.workingDirectory)."
  - criterion: "The cwd shown in the header is read from panel.state.customState.cwd when present, falling back to SessionContext.workingDirectory; the value 'process.cwd()' is never rendered as a fallback."
    verification: "grep -n 'process.cwd' frontend/src/components/panels/TerminalPanel.tsx is restricted to the existing panels:initialize call site (the header rendering code path must not reference process.cwd)."
  - criterion: "A new hook useAddTerminalShortcut is exported from frontend/src/hooks/useAddTerminalShortcut.ts and registers a window-level keydown handler that fires its callback for Cmd+Shift+Backquote (Mac) / Ctrl+Shift+Backquote (Win/Linux)."
    verification: "grep -n 'export function useAddTerminalShortcut' frontend/src/hooks/useAddTerminalShortcut.ts returns a match and the file contains the key literal '`' plus shiftKey + (metaKey || ctrlKey) checks."
  - criterion: "The shortcut hook ignores the keystroke when focus is inside an input, textarea, or contentEditable element (mirrors the focus-guard convention from useReviewQueueKeyboard)."
    verification: "Vitest run of frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts passes; the test suite includes a case asserting the callback is NOT invoked when target is HTMLInputElement / HTMLTextAreaElement / contentEditable."
  - criterion: "No existing keyboard shortcut in App.tsx, SessionView.tsx, or any frontend keydown handler binds to Cmd/Ctrl+Shift+Backquote."
    verification: "grep -rn \"key === '\\`'\" frontend/src and grep -rn 'Backquote' frontend/src return no matches outside frontend/src/hooks/useAddTerminalShortcut.ts and its test."
  - criterion: "Typecheck and lint pass for all owned files."
    verification: "pnpm typecheck and pnpm lint exit 0."
depends_on: [TASK-657]
estimated_complexity: low
epic: standalone-terminal-panels
test_strategy:
  needed: true
  justification: "The new useAddTerminalShortcut hook is a self-contained piece of behavior (window keydown registration + focus guards + modifier combo matching) that is straightforwardly unit-testable, and the project already has a strong precedent for testing keyboard-shortcut hooks (frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts). The TerminalPanel header is a pure render addition with no sibling test file in frontend/src/components/panels/ — no existing tests there to keep green."
  targets:
    - behavior: "Cmd+Shift+Backquote invokes the callback exactly once (Mac path)."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts"
      type: unit
    - behavior: "Ctrl+Shift+Backquote invokes the callback exactly once (Win/Linux path)."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts"
      type: unit
    - behavior: "Plain Backquote (no modifiers) does NOT invoke the callback."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts"
      type: unit
    - behavior: "Cmd+Shift+T does NOT invoke the callback (regression guard — confirms we are not colliding with the dev-mode TokenTest binding in App.tsx)."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts"
      type: unit
    - behavior: "Callback is not invoked when document.activeElement is an HTMLInputElement / HTMLTextAreaElement / contentEditable element."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts"
      type: unit
    - behavior: "The listener is removed on unmount (no callback fires after the rendered hook is unmounted)."
      test_file: "frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts"
      type: unit
---

# Add cwd breadcrumb header to TerminalPanel and add-terminal keyboard shortcut

## Objective

Add a thin header bar inside `TerminalPanel` that displays the session's current working directory (read from `panel.state.customState.cwd`, falling back to `SessionContext.workingDirectory`), and provide a reusable keyboard-shortcut hook (`useAddTerminalShortcut`) that `ProjectView` and `SessionView` (owned by TASK-658) import to wire a global keystroke to the same `onAddTerminal` callback that backs the visible `+` button. The shortcut binding is `Cmd+Shift+Backquote` (Mac) / `Ctrl+Shift+Backquote` (Win/Linux) — chosen because the IDEA's suggested `Cmd+Shift+T` is already bound in `App.tsx` to a dev-only TokenTest dialog (a hard conflict the IDEA's medium-confidence assumption #6 flagged).

This task ships the hook and the header. TASK-658 imports the hook in `ProjectView`/`SessionView` (see the consumer-contract section at the bottom). T3's DAG dependency is on T1 (cwd-routing fix) because the header reads `panel.state.customState.cwd`, which T1 makes authoritative. T3 has no dependency on T2's button.

## Implementation Steps

1. **Audit existing Backquote bindings (completeness gate; re-run before reporting COMPLETED).**

   ```bash
   grep -rn "key === '\`'" frontend/src
   grep -rn 'Backquote' frontend/src
   ```

   Expected output before this task: no matches. Expected output after this task: matches only in `frontend/src/hooks/useAddTerminalShortcut.ts` and its sibling test. If matches appear anywhere else, the shortcut binding has drifted and the executor must reconcile before completing.

2. **Create `frontend/src/hooks/useAddTerminalShortcut.ts`.** New file. Model the structure on `frontend/src/hooks/useReviewQueueKeyboard.ts` (same focus-guard convention, same ref-pin pattern for the callback, single `useEffect` that registers a window-level `keydown` listener and cleans up on unmount). Signature:

   ```ts
   export function useAddTerminalShortcut(
     onAddTerminal: () => void,
     opts?: { enabled?: boolean }
   ): void
   ```

   Behavior contract:
   - Listener guards (top-down, mirroring `useReviewQueueKeyboard`):
     1. If `opts?.enabled === false`, return early.
     2. Require `event.shiftKey && (event.metaKey || event.ctrlKey)` (NOT `altKey`).
     3. Match on the backtick — check both `event.key === '`'` AND `event.code === 'Backquote'` (the latter covers keyboard layouts where Shift+Backquote yields `~`).
     4. Focus guard: ignore when target is `HTMLInputElement`, `HTMLTextAreaElement`, or has `isContentEditable`. Do NOT add the broader `document.activeElement !== document.body` guard that `useReviewQueueKeyboard` uses — this shortcut needs to fire even when a panel button has focus.
     5. On match: `event.preventDefault()`, then invoke the latest callback via a ref.
   - Pin `onAddTerminal` in a `useRef` updated in a no-deps `useEffect` so the keydown listener can be registered once with an empty dep array and never goes stale.

3. **Create `frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts`.** New file. Use `vitest` + `@testing-library/react`'s `renderHook` + `@testing-library/dom`'s `fireEvent`, exactly as `useReviewQueueKeyboard.test.ts` does. Test cases (one `it` block each):
   - Mac path: `fireEvent.keyDown(window, { key: '`', code: 'Backquote', metaKey: true, shiftKey: true })` invokes the callback exactly once.
   - Windows/Linux path: same with `ctrlKey: true` instead of `metaKey: true`.
   - Plain Backquote (no modifiers) does NOT invoke the callback.
   - `Cmd+Shift+T` (key: `'T'`, metaKey + shiftKey) does NOT invoke the callback (explicit regression guard against drifting back to the IDEA's original suggestion which would collide with `App.tsx`'s TokenTest binding).
   - Focus guard: render an `HTMLInputElement`, focus it, dispatch the shortcut — callback NOT invoked. Repeat for `HTMLTextAreaElement` and a `contentEditable` div.
   - `opts.enabled === false` suppresses the callback.
   - Unmounting the hook removes the listener (dispatch after unmount — callback NOT invoked).

4. **Add the breadcrumb header to `TerminalPanel.tsx`.** Modify the final JSX (the `return` block at line 267). Wrap the existing `<div ref={terminalRef} ... />` and loading overlay in a vertical flex container, and prepend a header bar:

   ```tsx
   const displayCwd =
     (panel.state?.customState as TerminalPanelState | undefined)?.cwd
     ?? workingDirectory
     ?? '';
   ```

   Render the header as a single-row, fixed-height div (e.g. `h-6 px-2`, surface-secondary background, border-bottom). Inside, show a small folder/terminal icon (import `Folder` from `lucide-react`), the displayCwd in `font-mono text-xs`, and apply `data-testid="terminal-cwd-breadcrumb"` to the row. Use `title={displayCwd}` so the full path is accessible on hover when truncated. The xterm container below it must still fill remaining space (`flex-1 min-h-0`) so xterm's ResizeObserver continues to fit the viewport correctly.

   Read `TerminalPanelState` from `shared/types/panels.ts` for the cast (line 19) — DO NOT use `any`. Add the import alongside the existing imports at the top of the file: `import type { TerminalPanelState } from '../../../../shared/types/panels';` (mirror the relative path style used elsewhere in `frontend/src/components/panels/`).

   Crucially, the loading overlay (`!isInitialized` block, line 270) must remain a sibling of the xterm container so it overlays the terminal area only, not the new header.

5. **Verify no contradiction with the existing `panels:initialize` cwd argument.** Line 70 of `TerminalPanel.tsx` currently passes `cwd: workingDirectory || process.cwd()`. After TASK-657 lands, the customState.cwd is the authoritative source — but that fix is owned by T1, NOT this task. This task does NOT modify line 70. If the customState.cwd is missing at render time (e.g. while T1 is incomplete), the header still degrades gracefully to `workingDirectory` → empty string. Confirm by running step 1's grep and visually inspecting the final TerminalPanel return block.

6. **Run validation.**

   ```bash
   pnpm --filter frontend exec vitest run src/hooks/__tests__/useAddTerminalShortcut.test.ts
   pnpm typecheck
   pnpm lint
   ```

   All must exit 0.

## Acceptance Criteria

- TerminalPanel renders a header bar (`data-testid="terminal-cwd-breadcrumb"`) above the xterm viewport that displays the cwd.
- The cwd is sourced from `panel.state.customState.cwd` with `SessionContext.workingDirectory` as fallback; `process.cwd()` is NOT in the header rendering code path.
- `useAddTerminalShortcut` is exported from `frontend/src/hooks/useAddTerminalShortcut.ts`.
- The hook fires its callback for Cmd+Shift+Backquote (Mac) and Ctrl+Shift+Backquote (Win/Linux), is suppressed when focus is inside input/textarea/contentEditable, and is suppressed by `opts.enabled === false`.
- The hook does NOT fire for Cmd/Ctrl+Shift+T (the dev-mode TokenTest binding in `App.tsx` is preserved untouched).
- No existing keydown handler in `frontend/src/` binds Cmd/Ctrl+Shift+Backquote prior to this task — verified by the step-1 grep returning no pre-existing matches.
- Vitest, typecheck, and lint all pass.

## Test Strategy

Six unit-test cases live in `frontend/src/hooks/__tests__/useAddTerminalShortcut.test.ts` and exercise the hook in isolation via `renderHook` + `fireEvent.keyDown(window, ...)`. The test file follows the established pattern in `useReviewQueueKeyboard.test.ts`: vitest + jsdom, no IPC bridge needed, no tRPC mock needed (the hook does not call tRPC).

The TerminalPanel header is a pure render addition with no behavior beyond reading two existing fields and rendering text. No sibling test exists in `frontend/src/components/panels/` (verified via the Glob in refinement). A snapshot or component test for the header is intentionally NOT proposed — it would add noise without catching anything the AC's grep doesn't already catch. The integration check (header actually shows the right path when a real terminal panel opens) is the visual-verification step in TASK-658's manual smoke test and the eventual sprint-level smoke.

## Hardest Decision

**The shortcut binding.** The IDEA proposed `Cmd+Shift+T`. A grep of `frontend/src/App.tsx` showed that this exact combo is already bound (lines 326-339) to toggle a dev-only `TokenTest` dialog. Three options:

- (a) Keep `Cmd+Shift+T` and remove the TokenTest binding. **Rejected** — TokenTest is dev infrastructure that engineers use; removing it is out of scope for this idea.
- (b) Keep `Cmd+Shift+T` and have both fire (TokenTest in dev, Add Terminal everywhere). **Rejected** — in dev mode the user would get both behaviors at once, which is a UX bug.
- (c) Pick a different binding. **Chosen.** `Cmd+Shift+Backquote` is mnemonic (backtick is the shell-keyword character in markdown; many editors already use Ctrl+Backquote to focus an integrated terminal — VS Code's binding is `Ctrl+\``), unbound across `frontend/src/`, and avoids reshuffling existing dev tooling.

The second hardest decision was **where the keydown handler lives**. The decomposer's hints listed only `TerminalPanel.tsx` as owned, but TerminalPanel only exists *after* an Add-Terminal action — the shortcut to *open* it cannot live inside it. Three options:

- (i) Register the listener inside `TerminalPanel.tsx`. **Rejected** — circular; the panel doesn't exist when the user first presses the shortcut.
- (ii) Add the keydown handler directly to `ProjectView.tsx` / `SessionView.tsx`. **Rejected** — TASK-658 already owns those files; T3 would have to swap ownership across the boundary, which the prompt explicitly warns against.
- (iii) Create a new owned hook `useAddTerminalShortcut.ts` that T2 imports. **Chosen.** It cleanly separates the keyboard-shortcut behavior from both the panel and the views, mirrors the existing `useReviewQueueKeyboard` pattern, and is straightforwardly unit-testable.

## Rejected Alternatives

- **`Cmd+Shift+T` for the binding** — rejected because `App.tsx:328` already owns it (dev-mode TokenTest toggle). Would change my mind only if the TokenTest dialog is removed in a separate task first; that is out of scope here.
- **Listing the header element as a Maestro / Playwright assertion** — rejected. cyboflow has no Maestro suite, and the existing Playwright E2E does not exercise terminal panels. A unit test on the hook + an AC grep on the header markup is sufficient coverage for T3's scope; the visual smoke happens in T2's manual verification.
- **Skipping the focus guard for `contentEditable`** — rejected. The xterm.js viewport itself does not use contentEditable, but other panels (e.g. the eventual review-queue or chat input) do, and the shortcut should not fire while the user is typing in any editable surface. The cost of the extra check is negligible.
- **Using `useReviewQueueKeyboard`'s broader `document.activeElement !== document.body` guard** — rejected. That guard is correct for j/k/y/n triage keys but would block the Add-Terminal shortcut when, say, the panel tab bar's `Add Terminal` button (added by T2) has focus from a prior click. Cmd-modified shortcuts should fire globally; only direct text-input focus should suppress them.

## Lowest Confidence Area

The interaction between the new header bar's height and `xterm`'s `FitAddon.fit()` is the highest-risk piece. `xterm` measures the parent container's dimensions and assumes it owns all of them; adding a sibling header above the terminal viewport requires the xterm container to be wrapped in a flex layout with `flex-1 min-h-0` so the ResizeObserver triggered fit picks up the *remaining* height after the header is laid out. If the wrapper styling is off, xterm may render at the wrong row count on first open or after a window resize, with no error — only a visual mis-fit. Manual visual verification via `pnpm dev` is required in TASK-658's smoke (the panel-open path is exercised there). If a fit regression appears, the fix is to inspect the xterm container's computed height in DevTools and ensure both the wrapper and the xterm `<div>` participate in the flex chain correctly; do NOT remove the `ResizeObserver.observe(terminalRef.current)` call in `TerminalPanel.tsx`.

## Consumer contract for TASK-658

T2 must import the hook in BOTH `ProjectView.tsx` and `SessionView.tsx` (or in a common parent) and pass the same `onAddTerminal` callback that backs T2's `+` button:

```tsx
import { useAddTerminalShortcut } from '../hooks/useAddTerminalShortcut';
// inside ProjectView / SessionView body:
useAddTerminalShortcut(handleAddTerminal);
```

TASK-658's plan has been updated to encode this contract — its `files_readonly` includes `frontend/src/hooks/useAddTerminalShortcut.ts` and its acceptance criteria require `useAddTerminalShortcut` to be invoked in both views. The DAG runs T1 → T3 → T2 so the hook exists before T2 imports it.

Also documented for the IDEA: assumption #6 ("Cmd+Shift+T has no existing conflict") is **invalidated** — `frontend/src/App.tsx:328` already binds it for the dev-mode TokenTest dialog. The binding has been changed to Cmd+Shift+Backquote in this plan. The IDEA file does not need to be edited (the planner's decision supersedes the assumption), but downstream documentation and any user-facing changelog should reference the actual binding shipped.
