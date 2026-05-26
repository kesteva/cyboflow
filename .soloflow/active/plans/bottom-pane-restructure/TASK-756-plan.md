---
id: TASK-756
idea: IDEA-025
status: ready
created: "2026-05-26T00:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/RunBottomPane.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/components/cyboflow/RunChatView.tsx
files_readonly:
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/panels/PanelTabBar.tsx
  - frontend/src/components/cyboflow/__tests__/RunView.test.tsx
acceptance_criteria:
  - criterion: "A new file frontend/src/components/cyboflow/RunBottomPane.tsx exists, exports a named React component RunBottomPane that takes no required props, and renders a three-tab shell with tabs labeled 'Chat', 'Terminal', and 'Data Stream'."
    verification: "test -f frontend/src/components/cyboflow/RunBottomPane.tsx && grep -nE 'export function RunBottomPane|export const RunBottomPane' frontend/src/components/cyboflow/RunBottomPane.tsx"
  - criterion: "RunBottomPane defaults to the 'Data Stream' tab on first render, and renders the existing RunView component verbatim inside that tab's panel (no prop wrapping, no extra props on RunView)."
    verification: "grep -nE \"<RunView ?/>\" frontend/src/components/cyboflow/RunBottomPane.tsx && grep -nE \"useState[<(].*'data-stream'\" frontend/src/components/cyboflow/RunBottomPane.tsx"
  - criterion: "The Terminal tab content is an inline placeholder reading exactly 'Terminal — coming soon' (em-dash). No xterm import, no @xterm/xterm dependency, no TerminalPanel mount."
    verification: "grep -n 'Terminal — coming soon' frontend/src/components/cyboflow/RunBottomPane.tsx && ! grep -nE \"from '@xterm/xterm'|TerminalPanel\" frontend/src/components/cyboflow/RunBottomPane.tsx"
  - criterion: The Chat tab content is an inline JSX placeholder div in this same file (NOT a separately imported RunChatView component). The file frontend/src/components/cyboflow/RunChatView.tsx is not imported and is not created by this task.
    verification: "! grep -nE \"from './RunChatView'|import.*RunChatView\" frontend/src/components/cyboflow/RunBottomPane.tsx && test ! -f frontend/src/components/cyboflow/RunChatView.tsx"
  - criterion: "Tab selection is held in local React state inside RunBottomPane (useState); no new field is added to cyboflowStore, and the file does not call useCyboflowStore for tab state."
    verification: "grep -nE 'useState' frontend/src/components/cyboflow/RunBottomPane.tsx && ! grep -nE 'setActiveTab|activeTab' frontend/src/stores/cyboflowStore.ts"
  - criterion: "CyboflowRoot.tsx no longer mounts <RunView /> directly inside its main content area; it mounts <RunBottomPane /> in that exact location instead. The import of RunView is removed (or kept only if a sibling test still relies on it — it should be removed)."
    verification: "grep -nE '<RunBottomPane ?/>' frontend/src/components/cyboflow/CyboflowRoot.tsx && ! grep -nE '<RunView ?/>' frontend/src/components/cyboflow/CyboflowRoot.tsx"
  - criterion: "Clicking a tab button switches the visible tab panel: the previously active panel is unmounted (or hidden via aria-hidden) and the newly active panel is rendered. Verified by the component test."
    verification: Run pnpm --filter frontend exec vitest run frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx and confirm exit 0.
  - criterion: "The existing CyboflowRoot test 'renders RunView when activeRunId is set and hides the empty-state CTA' continues to pass after the swap, because RunBottomPane defaults to the Data Stream tab which mounts RunView."
    verification: Run pnpm --filter frontend exec vitest run frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx and confirm exit 0.
  - criterion: pnpm --filter frontend typecheck and lint both pass for the new and modified files.
    verification: "pnpm --filter frontend typecheck && pnpm --filter frontend lint"
depends_on: []
estimated_complexity: low
epic: bottom-pane-restructure
test_strategy:
  needed: true
  justification: "Net-new component with clearly testable behaviors (default tab, switching, placeholder content, RunView mount). Two existing sibling tests in the same directory (CyboflowRoot.test.tsx, RunView.test.tsx) require parity verification — CyboflowRoot.test.tsx in particular asserts RunView renders the runId after setActiveRun, which now flows through RunBottomPane's default Data Stream tab. Both tests must remain green."
  targets:
    - behavior: "RunBottomPane renders three tab buttons with text 'Chat', 'Terminal', and 'Data Stream'."
      test_file: frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx
      type: component
    - behavior: "Data Stream is the default active tab; <RunView /> is mounted on first render (assert via runId text after setActiveRun)."
      test_file: frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx
      type: component
    - behavior: "Clicking the 'Terminal' tab hides the Data Stream panel and shows the literal text 'Terminal — coming soon'."
      test_file: frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx
      type: component
    - behavior: "Clicking the 'Chat' tab hides the Data Stream panel and shows the inline Chat placeholder content (data-testid='run-bottom-pane-chat-placeholder')."
      test_file: frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx
      type: component
    - behavior: "Existing assertion: with activeRunId set to 'run-abc-999', the CyboflowRoot renders text 'run-abc-999' (still satisfied via RunBottomPane → Data Stream → RunView)."
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
---
# RunBottomPane three-tab shell (Data Stream + Terminal stub + Chat placeholder)

## Objective

Introduce a thin tab-switching wrapper component, `RunBottomPane`, that replaces the direct `<RunView />` mount in `CyboflowRoot`. The shell exposes three tabs — Chat (inline placeholder), Terminal (inline "coming soon" stub), and Data Stream (renders the existing `RunView` verbatim) — with Data Stream as the default. This establishes the structural foundation for IDEA-025's downstream slices (`RunChatView`, mode-gated chat input, AskUserQuestionCard) without changing any backend behavior, IPC contract, or store shape.

## Implementation Steps

1. **Create `frontend/src/components/cyboflow/RunBottomPane.tsx`** (new file). Layout:
   - At the top of the file, define a local component `LocalTabBar` (not exported from the module) following the research recommendation: ~30 lines of Tailwind, props `{ tabs: ReadonlyArray<{ id: TabId; label: string }>; activeTab: TabId; onTabChange: (id: TabId) => void }`. Render each tab as a `<button role="tab" aria-selected={…} data-testid={\`run-bottom-pane-tab-${tab.id}\`}>` with classNames matching the project's existing button styling (use `bg-bg-secondary`, `text-text-primary`, `border-border-primary` from the design tokens visible in `RunView.tsx`). Active tab gets a border-bottom highlight; inactive tabs are `text-text-secondary`.
   - Define a local string-literal union: `type TabId = 'chat' | 'terminal' | 'data-stream'`.
   - Export a named function component `RunBottomPane()` with no required props.
   - Inside the component, hold tab state with `const [activeTab, setActiveTab] = useState<TabId>('data-stream')`.
   - Render a vertical flex container: `<LocalTabBar>` on top, `<div role="tabpanel" className="flex-1 overflow-auto">` below.
   - Conditionally render exactly one of three branches based on `activeTab`:
     - `'data-stream'` → `<RunView />` (imported from `./RunView`). No props. No wrapper div that interferes with RunView's own layout.
     - `'terminal'` → `<div data-testid="run-bottom-pane-terminal-placeholder" className="p-4 text-sm text-text-secondary">Terminal — coming soon</div>`. Use a real em-dash (U+2014), not two hyphens.
     - `'chat'` → `<div data-testid="run-bottom-pane-chat-placeholder" className="p-4 text-sm text-text-secondary">Chat — coming soon</div>`. Inline JSX only; do NOT import any `RunChatView` symbol — that file is the responsibility of TASK-761.
   - Add a file-header doc comment explaining: "Three-tab shell wrapping the run view content. Tab state is local; cyboflowStore is unchanged. Chat and Terminal tabs are placeholders to be filled by TASK-761 (RunChatView) and a future Terminal-integration task."

2. **Swap the mount point in `frontend/src/components/cyboflow/CyboflowRoot.tsx`:**
   - Replace `import { RunView } from './RunView';` (currently line 14) with `import { RunBottomPane } from './RunBottomPane';`.
   - Replace `<RunView />` (currently line 137) with `<RunBottomPane />`. The surrounding ternary on `activeRunId !== null` stays exactly as-is — empty-state CTA semantics are unchanged.
   - Do NOT touch the panel surface block (lines 153–177) or any other part of the file.

3. **Create `frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx`** (new file). Mirror the mock setup used in `RunView.test.tsx` (the same `cyboflowApi` mock — `subscribeToStreamEvents: vi.fn(() => vi.fn())`). Also stub `HTMLElement.prototype.scrollIntoView` in `beforeEach`, since the Data Stream tab mounts RunView which calls `scrollIntoView`. Test cases:
   - "renders three tabs with labels Chat, Terminal, Data Stream" — assert `getByRole('tab', { name: 'Chat' })`, `getByRole('tab', { name: 'Terminal' })`, `getByRole('tab', { name: 'Data Stream' })` all present.
   - "defaults to Data Stream tab and mounts RunView" — call `useCyboflowStore.getState().setActiveRun('run-xyz')`, render, assert `screen.getByText('run-xyz')` is in the document (proves RunView mounted).
   - "clicking Terminal tab shows 'Terminal — coming soon' placeholder and hides RunView" — fire click on the Terminal tab button, assert `screen.getByText('Terminal — coming soon')` is present and `screen.queryByText('run-xyz')` is null.
   - "clicking Chat tab shows the inline chat placeholder and hides RunView" — fire click on the Chat tab button, assert `screen.getByTestId('run-bottom-pane-chat-placeholder')` is present and `screen.queryByText('run-xyz')` is null.
   - "clicking Data Stream tab after switching away restores RunView" — switch to Terminal, then back to Data Stream, assert `screen.getByText('run-xyz')` again.

4. **Update `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx`** if and only if the test fails after the swap. The existing assertion `screen.getByText('run-abc-999')` should still pass because RunBottomPane defaults to Data Stream which mounts RunView — verify by running the test. If any failure surfaces (typical risk: lookup of `<RunView>` element type if any test reached into the tree by class/component query — none observed in current test), update the test to query for the rendered `run-abc-999` text or the new `data-testid="run-bottom-pane-tab-data-stream"`. Do NOT relax assertions; preserve every existing expect call.

5. **Verify and report:**
   - Run `pnpm --filter frontend exec vitest run frontend/src/components/cyboflow/__tests__/RunBottomPane.test.tsx` — must exit 0.
   - Run `pnpm --filter frontend exec vitest run frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx` — must exit 0.
   - Run `pnpm --filter frontend exec vitest run frontend/src/components/cyboflow/__tests__/RunView.test.tsx` — must exit 0 (unchanged file, regression check).
   - Run `pnpm --filter frontend typecheck` — must exit 0.
   - Run `pnpm --filter frontend lint` — must exit 0.

## Acceptance Criteria

1. `RunBottomPane.tsx` exists, exports a named `RunBottomPane` component, renders three tabs (Chat / Terminal / Data Stream).
2. Default tab is Data Stream; `<RunView />` is mounted on first render with no extra props.
3. Terminal tab content is exactly the literal text "Terminal — coming soon" with no xterm or TerminalPanel imports.
4. Chat tab content is an inline placeholder div; no `RunChatView` import; the file `RunChatView.tsx` is not created.
5. Tab state is local React `useState`; `cyboflowStore` is not modified.
6. `CyboflowRoot.tsx` mounts `<RunBottomPane />` in place of `<RunView />` and the `RunView` import is removed.
7. The existing CyboflowRoot test asserting `'run-abc-999'` after `setActiveRun` continues to pass.
8. New RunBottomPane.test.tsx covers default-tab, tab-switch, placeholder content, and round-trip back to Data Stream.
9. `pnpm --filter frontend typecheck` and `pnpm --filter frontend lint` both pass.

## Test Strategy

A net-new `RunBottomPane.test.tsx` covers the five behaviors enumerated in the frontmatter `targets[]`. Reuse the `cyboflowApi` mock + `scrollIntoView` stub pattern from `RunView.test.tsx` so the Data Stream tab's RunView mount does not require real IPC or fail on missing DOM APIs. The existing `CyboflowRoot.test.tsx` is exercised as a regression gate — its `run-abc-999` assertion must keep passing because Data Stream is the default tab and Data Stream mounts RunView. If `CyboflowRoot.test.tsx` requires any change, restrict it to swapping the import surface (e.g. preserving the rendered-text assertions), never weakening behavior coverage.

`RunView.test.tsx` is intentionally NOT modified and is listed read-only — RunView's own contract is unchanged by this task; verifying its test still passes is a regression check, not a target.

## Hardest Decision

**Where to put the `LocalTabBar` component.** Options considered: (a) inline as a private function inside `RunBottomPane.tsx`, (b) sibling file `frontend/src/components/cyboflow/LocalTabBar.tsx`, (c) general-purpose `frontend/src/components/ui/TabBar.tsx`. Chose (a) inline because the research report explicitly recommends "alongside `RunBottomPane`" and warns against premature generalization (the existing `PanelTabBar` is bloated precisely because it absorbed too many concerns). Inline keeps the surface small, scoped to the three-tab use case, and avoids creating an unused public component. If a future IDEA introduces a second three-tab-style shell, promoting to `components/ui/` is a trivial mechanical refactor.

## Rejected Alternatives

- **Reuse `PanelTabBar`:** Rejected — it is bound to `ToolPanel` types, supports closeable/renameable panels, git-branch display, and panel-context dropdowns. None of those features apply here, and forcing this use case through `PanelTabBar`'s prop surface would require extending its discriminated `context` union and adding a third variant. Research confirmed it is "not reusable at the lightweight three-tab local-state level". Would reconsider only if a second future surface needs the same three-tab pattern with closeable behavior.
- **Hold tab state in `cyboflowStore`:** Rejected per the scope_summary's explicit "cyboflowStore is not changed" constraint and because tab state is a pure UI concern with no cross-component subscribers. Would reconsider if a sibling component needed to programmatically switch tabs (e.g. auto-switch to Chat when an `AskUserQuestionCard` arrives — but that is TASK-761's call to make at that time).
- **Create `RunChatView.tsx` here as an empty stub:** Rejected because the task skeleton explicitly forbids it ("This task does NOT create RunChatView.tsx") and TASK-761 owns that file's creation. Creating an empty stub here would force a non-overlap conflict with TASK-761's `files_owned`. Inline JSX in the Chat tab is the contracted placeholder.
- **Add `aria-hidden` instead of conditional rendering for non-active tabs:** Rejected — RunView starts a stream subscription via the cyboflowStore singleton on mount but does not stop it; mounting it once and hiding it costs nothing extra. However, leaving the Terminal/Chat placeholders mounted-but-hidden adds no value. Conditional render keeps the tree minimal and matches React idiom. Would reconsider if RunView accumulated mount-time cost (e.g. heavy DOM, third-party libs).

## Lowest Confidence Area

Whether the existing `CyboflowRoot.test.tsx` test "renders RunView when activeRunId is set and hides the empty-state CTA" passes unchanged. The assertion `screen.getByText('run-abc-999')` targets the runId rendered inside RunView. Since RunBottomPane defaults to Data Stream which mounts RunView, the text should still appear — but if React's reconciliation, Strict Mode, or any cyboflowStore subscription timing causes RunView to mount slightly later (e.g. behind a `Suspense` or async load), the assertion could become flaky. Mitigation: the test is synchronous and uses `getByText` (not `findByText`), so it expects the text to be present on the first render commit. RunBottomPane uses synchronous `useState('data-stream')` with no `Suspense` boundary, so the mount should be synchronous. If a failure surfaces, switching to `findByText` (async) is the lowest-disruption fix. The Step 4 instruction acknowledges this and gates any test edit on actually observing a failure rather than pre-emptively weakening assertions.
