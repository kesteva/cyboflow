---
epic: workflow-progress-visualization
created: 2026-05-26T16:30:00Z
status: active
originating_ideas: [IDEA-026]
---

# Workflow Progress Visualization — Right Rail Timeline and Active Canvas

## Objective

Deliver the two protoflow visualization surfaces inside cyboflow: a 296px right rail with a Workflow Progress timeline tab (vertical phase feed + step log lines), and a horizontal phase-column canvas (~46% top of run view) with step cards, SVG edges, and an animated rust token. Both surfaces consume the workflow-phase-model epic's tRPC surface for live data.

## Scope

- In scope:
  - CyboflowRoot layout restructure to flex-row with left content column + 296px right rail
  - `RunRightRail.tsx` with Workflow Progress / File Explorer (placeholder) / Diff (placeholder) tabs
  - `WorkflowProgressTimeline.tsx` with phase headers, state-keyed step items, log lines, and pulse animation
  - `WorkflowCanvas.tsx` with phase columns, step cards in all state variants including frosted-glass done overlay and human/optional variants
  - SVG edge overlay (solid same/cross-phase + dashed loopback edges) via bare DOM measurement and ResizeObserver
  - RAF-animated 4px rust token traveling along the current edge
  - `useWorkflowPhaseState` hook wiring canvas and timeline to live tRPC subscriptions
- Out of scope:
  - Protoflow paper-cream palette global restyle (separate IDEA)
  - File Explorer tab content (placeholder only)
  - Diff tab content (placeholder only)
  - Workflow editor / Direction-A modal (separate IDEA)

## Success Signal

With a workflow run active in cyboflow, the right rail's Workflow Progress tab shows the correct phase/step states updating in real time, and the canvas shows the phase columns with the rust token advancing along edges as steps transition, all using existing cyboflow Tailwind tokens.

## External Dependencies

TASK-767 (CyboflowRoot restructure) must be sequenced AFTER TASK-761 and TASK-762 land (per-run-chat-surface sprint), since those tasks reference CyboflowRoot.tsx as `files_readonly`.

## Tasks

- TASK-767 — Restructure CyboflowRoot layout and build RunRightRail shell with 3 tabs
- TASK-768 — Build WorkflowProgressTimeline component wired to live tRPC phase state
- TASK-769 — Build WorkflowCanvas shell with phase columns and step cards in all state variants
- TASK-770 — Add SVG edge overlay and RAF-animated rust token to WorkflowCanvas
- TASK-771 — Wire WorkflowCanvas to live tRPC phase state driving card states and token position
