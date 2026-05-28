---
epic: bottom-pane-restructure
created: 2026-05-26T00:00:00Z
status: complete
originating_ideas: [IDEA-025]
---

# Bottom-Pane Three-Tab Shell

## Objective

Replace cyboflow's current single-view bottom pane (which today renders the raw assistant stream including `tool_use` JSON blocks) with a three-tab `RunBottomPane` (Chat / Terminal / Data Stream) so each tab can be developed and iterated independently without a coordinated UI cutover.

The Data Stream tab preserves today's full-progress stream renderer (`RunView`) verbatim — zero behavior change for the existing observability surface. The Chat and Terminal tabs are placeholders shipped in this epic; their content is filled by the `per-run-chat-surface` epic (Chat) and a future terminal-integration IDEA (Terminal).

## Scope

- In scope:
  - `RunBottomPane` component wrapping `RunView` under the Data Stream tab
  - `LocalTabBar` lightweight tab switcher (~30 lines Tailwind, no external library) co-located with `RunBottomPane`
  - Terminal tab placeholder ("Terminal — coming soon" inline div)
  - Chat tab placeholder (inline JSX, later replaced by `RunChatView` mount in TASK-761)
  - Swap the `<RunView />` mount in `CyboflowRoot` for `<RunBottomPane />`
  - Component tests for default-tab, tab-switching, placeholder content
- Out of scope:
  - `RunChatView` substantive content (owned by `per-run-chat-surface` epic)
  - Terminal tab xterm wiring (future IDEA)
  - `cyboflowStore` state changes — tab selection lives in local React state
  - Workflow progress visualization (future IDEA — the central-pane reshape)

## Success Signal

Electron app shows a three-tab bottom pane; Data Stream renders exactly as before (every existing stream-event spec passes); Terminal shows the placeholder; Chat tab shows a placeholder that is replaced by `RunChatView` in TASK-761; the existing CyboflowRoot test assertion (`'run-abc-999'` appears after `setActiveRun`) continues to pass via RunBottomPane → Data Stream → RunView.

## Tasks

- TASK-756 — RunBottomPane three-tab shell
