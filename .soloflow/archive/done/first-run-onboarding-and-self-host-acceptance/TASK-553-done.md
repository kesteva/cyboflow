---
id: TASK-553
sprint: SPRINT-013
epic: first-run-onboarding-and-self-host-acceptance
status: done
summary: "Add MCP server health indicator in a new app-shell StatusBar; Zustand store polls existing cyboflow:mcp-health IPC every 5s, dot color (green/yellow/red) reflects mapped status, click opens diagnostics popover; defaults to 'starting' (yellow) on cold mount."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-553 — MCP server health indicator

Delivered:

- `frontend/src/stores/mcpHealthStore.ts` — Zustand slice. Status enum `'healthy' | 'starting' | 'error'`, default `starting`. `subscribeToMcpHealth()` polls the existing `cyboflow:mcp-health` IPC handler every 5s (TASK-535's tRPC subscription does not exist yet — FIND-SPRINT-013-18 tracks the planned migration). Maps `McpServerHealth` (`'starting' | 'running' | 'failed' | 'stopped'`) to the three UI values.
- `frontend/src/components/McpHealthIndicator.tsx` — colored dot (`bg-green-500` / `bg-yellow-400` with pulse on `starting` / `bg-red-500`) inside a button that opens a `role="dialog"` popover. Popover shows Status, Last checked, PID (or 'unknown'), Last error in red monospaced if present. Closes on outside-click and Escape.
- `frontend/src/components/StatusBar.tsx` — `h-6 shrink-0` footer flex bar with "Cyboflow" muted label on the left and `<McpHealthIndicator />` on the right.
- `frontend/src/App.tsx` — outer container changed to `flex-col`; existing app row wrapped in `flex-1 flex overflow-hidden`; `<StatusBar />` rendered as final child; `subscribeToMcpHealth()` wired in `useEffect` with cleanup.
- `frontend/src/components/StatusBar.test.tsx` — 3 component tests (cold-mount yellow, healthy green + popover text, error red + error message in popover).

Verifier APPROVED. Code-reviewer CLEAN with 2 minor cosmetic notes (unused exported `setHealth` action, identity `STATUS_LABEL` map). Two open improvement findings logged: FIND-SPRINT-013-18 (push subscription when TASK-535 lands), FIND-SPRINT-013-19 (duplicate polling with the pre-existing `useMcpHealth.ts` hook + Sidebar.tsx dot — to consolidate in TASK-535), FIND-SPRINT-013-20 (transient lastError visibility window).
