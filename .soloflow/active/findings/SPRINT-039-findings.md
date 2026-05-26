---
sprint: SPRINT-039
pending_count: 1
last_updated: "2026-05-26T21:27:25.142Z"
---
# Findings Queue

## FIND-SPRINT-039-1
- **source:** TASK-756 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md
- **description:** Recurring TCC-grant gap: Peekaboo MCP server_status reports Screen Recording=granted but Accessibility=not granted, AND live image() capture fails with "The user declined TCCs for application, window, display capture" even on screen:0 / frontmost / by-PID-window. This recurs across SPRINT-031..SPRINT-039 (TASK-655, TASK-715, TASK-752, now TASK-756). Compounder candidate: docs/VISUAL-VERIFICATION-SETUP.md should explicitly call out that BOTH permissions must be granted to the MCP host process (the binary actually issuing the CGDisplay / CGWindow calls), not just to Cyboflow.app or Warp, and include a one-shot diagnostic command. Currently each verifier session re-discovers the gap, escalates to the queue, then proceeds with skipped_unable.
