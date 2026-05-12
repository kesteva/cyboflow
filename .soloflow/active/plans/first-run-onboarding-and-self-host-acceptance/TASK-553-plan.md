---
id: TASK-553
idea: IDEA-012
idea_id: IDEA-012
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - frontend/src/components/StatusBar.tsx
  - frontend/src/components/StatusBar.test.tsx
  - frontend/src/components/McpHealthIndicator.tsx
  - frontend/src/stores/mcpHealthStore.ts
  - frontend/src/App.tsx
files_readonly:
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
  - main/src/orchestrator/index.ts
  - frontend/src/utils/api.ts
acceptance_criteria:
  - criterion: "A StatusBar component is rendered at the bottom of the app shell inside App.tsx and contains a McpHealthIndicator child."
    verification: "grep -n 'StatusBar' frontend/src/App.tsx returns at least one import and one JSX usage; grep -n 'McpHealthIndicator' frontend/src/components/StatusBar.tsx returns at least one import and one JSX usage."
  - criterion: "McpHealthIndicator displays a colored dot (green = healthy, yellow = starting/degraded, red = error/stopped) reflecting state from the mcpHealthStore Zustand slice."
    verification: "Read frontend/src/components/McpHealthIndicator.tsx; verify the rendered color attribute or className depends on the store's status enum value, which is one of 'healthy' | 'starting' | 'error'."
  - criterion: "The store is fed by tRPC subscription cyboflow.events.onMcpHealth OR the existing app-boot health-check IPC, whichever the cyboflow-mcp-server epic exposes; the connection is documented in the implementation."
    verification: "grep -n 'cyboflow.events.onMcpHealth\\|mcp:health\\|onMcpHealth' frontend/src/stores/mcpHealthStore.ts returns at least one subscription wiring."
  - criterion: "Clicking the indicator opens a diagnostics dialog/popover listing: last health-check timestamp, last error message (if any), and the subprocess PID if available."
    verification: "grep -n 'Diagnostics\\|diagnostics' frontend/src/components/McpHealthIndicator.tsx returns one match; clicking the indicator in a test triggers a popover render (component test)."
  - criterion: "On initial mount before the first health event arrives, status defaults to 'starting' (yellow) — never 'healthy' (green) without an actual probe."
    verification: "Unit test in StatusBar.test.tsx: render with empty store → assert dot is yellow/starting variant."
depends_on: [TASK-535]
estimated_complexity: medium
epic: first-run-onboarding-and-self-host-acceptance
test_strategy:
  needed: true
  justification: "Status semantics (when is it green vs yellow vs red?) are the AC and would silently drift if untested. The default-to-yellow rule especially is easy to break by changing a store initializer."
  targets:
    - behavior: "Defaults to 'starting' (yellow) on cold mount with no events received"
      test_file: "frontend/src/components/StatusBar.test.tsx"
      type: component
    - behavior: "Transitions to 'healthy' (green) when store status is set to healthy"
      test_file: "frontend/src/components/StatusBar.test.tsx"
      type: component
    - behavior: "Transitions to 'error' (red) when store status is set to error and exposes the error message in the diagnostics popover"
      test_file: "frontend/src/components/StatusBar.test.tsx"
      type: component
---

# MCP Server Health Indicator in App Status Bar

## Objective

Surface CyboflowMcpServer subprocess health (green/yellow/red dot) in a persistent status bar at the bottom of the app shell, with a click-to-open diagnostics affordance showing the last health check timestamp, last error, and PID. This pairs with the `cyboflow-mcp-server` epic's app-boot health check (ROADMAP-001.md line 156) to give the user a continuous, first-run-visible signal that the MCP outbound bridge is alive. Without this indicator, a crashed MCP subprocess silently degrades Claude's ability to read queue state and the user has no way to notice until a tool call fails.

## Implementation Steps

1. Create `frontend/src/stores/mcpHealthStore.ts` — Zustand slice with:
   - State: `status: 'starting' | 'healthy' | 'error'`, `lastCheckedAt: number | null`, `lastError: string | null`, `pid: number | null`.
   - Default state: `{ status: 'starting', lastCheckedAt: null, lastError: null, pid: null }`.
   - Action: `setHealth(payload: Partial<state>)` merging the patch into state.
   - On store creation, subscribe to `window.electronAPI.events.onMcpHealth?.(...)` (tRPC subscription bridged through the existing electronAPI events surface as set up by `orchestrator-and-trpc-router` epic). If the orchestrator emits via IPC channel `mcp:health` instead, fall back to `window.electron.on('mcp:health', ...)`. The cyboflow-mcp-server epic owns the emission path; this task consumes whichever it provides.

2. Create `frontend/src/components/McpHealthIndicator.tsx`:
   - Reads `useMcpHealthStore()`.
   - Renders a 8px circular dot: green for `healthy`, yellow for `starting`, red for `error`. Use Tailwind classes (bg-green-500 / bg-yellow-400 / bg-red-500) plus a subtle pulse animation on `starting`.
   - Wraps the dot in a button. On click, opens a popover (existing project pattern: use the in-tree dialog/popover primitives — check `frontend/src/components/ui/` for what's available; if no popover exists, render a small `<div>` portal with absolute positioning).
   - Popover content: 3 lines — "Status: {healthy|starting|error}", "Last checked: {Intl.DateTimeFormat formatted timestamp or 'never'}", "PID: {pid or 'unknown'}". If `lastError`, render a 4th line with the error in red-text small monospaced.

3. Create `frontend/src/components/StatusBar.tsx`:
   - A horizontal flex container, `h-6`, dark background, full-width, fixed at the bottom of the app shell.
   - Left side: small "Cyboflow" label (low-key, text-text-muted).
   - Right side: `<McpHealthIndicator />`.
   - Designed as a future extension point: other indicators (active runs count, queue depth) can join later. v1 ships only the MCP indicator.

4. Modify `frontend/src/App.tsx`:
   - Import `StatusBar`.
   - Inside the root flex container, change layout to `flex-col` so the existing `flex` row sits above a `StatusBar`. Render `<StatusBar />` as the final child below `<ContextMenuProvider>`'s row content. Take care: the existing layout uses `h-screen flex overflow-hidden` — wrap the existing sidebar+session row in a `flex-1` container and add the bar below.

5. Create `frontend/src/components/StatusBar.test.tsx` with three component tests using a mocked store:
   - Cold mount with default state → yellow dot, popover text shows "starting".
   - Set store to healthy → green dot, popover shows "healthy" + timestamp.
   - Set store to error with message → red dot, popover shows error message.

6. The orchestrator/MCP subprocess code (`main/src/orchestrator/mcpServer/cyboflowMcpServer.ts`) is OWNED by epic 10 (`cyboflow-mcp-server`) which this task depends on. This task ONLY consumes the health event channel that epic exposes. Do not modify main-process MCP code from this task — if the event channel name is unclear, read the cyboflow-mcp-server plan/code and adapt.

## Acceptance Criteria

See frontmatter. The 'starting' default rule is the most important — a misleadingly green dot when the subprocess never actually launched is a worse failure than yellow.

## Test Strategy

Three component tests in `StatusBar.test.tsx` covering the three status states. Mock `useMcpHealthStore` (or render a real store with seeded state) and assert dot color + popover text.

## Hardest Decision

Whether to own the main-process emission path in this task or only consume it. Picked CONSUME-ONLY. Rationale: the `cyboflow-mcp-server` epic (TASK-535 dep) already covers "App-boot health check: if the MCP server fails to start, surface a clear error rather than silently disabling outbound tools" (ROADMAP-001.md line 156). It must emit health somewhere. This task's job is to render that emission. If the dep epic did not emit an ongoing health signal (only a one-shot boot check), this task should escalate back to refine epic 10's scope — but as planned, the indicator should subscribe to whatever channel epic 10 produces.

## Rejected Alternatives

- Polling the MCP subprocess from the renderer with a setInterval. Rejected — duplicates the orchestrator's already-existing knowledge of the subprocess state, and renderer-driven polling is the wrong pattern per the design doc's "renderer never writes" principle (and by extension, "renderer never owns subprocess lifecycle decisions").
- Putting the indicator in the sidebar header instead of a dedicated status bar. Rejected — a status bar gives a stable extension surface for future indicators (run count, queue depth, network/auth status) without re-laying out the sidebar.

## Lowest Confidence Area

The exact event channel name and payload shape from `cyboflow-mcp-server`. The plan above subscribes to two fallback names (`onMcpHealth` via tRPC events bridge or `mcp:health` via electron IPC). If neither matches what epic 10 actually ships, the executor will need a small adapter. This is acceptable risk because epic 10 lands before this task per the dependency.
