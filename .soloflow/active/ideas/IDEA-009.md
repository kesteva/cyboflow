---
id: IDEA-009
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 2 — Review Queue and Self-Host"
roadmap_epic: "review-queue-ui"
slices:
  - title: "<ReviewQueueView /> as always-visible primary UI surface"
    description: "Workspace-scoped left rail or top tab. Never hidden during normal operation. The headline differentiator UI."
    value_statement: "The single pane the entire fork exists to deliver"
  - title: "<PendingApprovalCard /> with full context"
    description: "Workflow name, tool name (e.g. 'Bash'), payload preview (command or file edit), Claude's preceding rationale text, age, Approve/Reject buttons."
    value_statement: "Enough context for the user to approve confidently without reading raw payloads"
  - title: "Keyboard navigation: j/k to move, y/n to approve/reject"
    description: "Vim/Superhuman pattern. Visible focus indicator. Targeted at 60-second clear of a 15-item queue."
    value_statement: "Effortless rote approval; the 93%-approval-rate use case is the primary one"
  - title: "Oldest-pending-first sort"
    description: "Default sort ascending by created_at. The oldest pending approval is the most-delayed run; clearing it first unblocks the longest-paused workflow."
    value_statement: "Bottleneck-first triage by default"
  - title: "Pin items awaiting >3min as 'blocked' at top"
    description: "Items whose run has been in awaiting_review > 3 minutes get pinned to top with a 'blocked Nm' age badge. Prevents silent-hang from a forgotten approval."
    value_statement: "Highest-pri visual treatment for the highest-harm failure mode"
  - title: "Collapse repeated approvals from same run + same tool/payload signature"
    description: "Show 'npm test (×7 in this run)' as one card with Approve-all-in-this-run / Reject-all-in-this-run. Reduces queue length 30-50% on a typical sprint run. Addresses the rajiv.com 14-identical-prompts failure mode."
    value_statement: "Primary fatigue-reduction feature; not a v2 nice-to-have"
  - title: "Per-run 'approve rest of this run' (scoped, NOT global)"
    description: "Per-run action approves all remaining pending in that specific run. Safe because the user has context about what one run is doing."
    value_statement: "Speed without the bulk-delete trap of a global approve-all"
  - title: "NO global approve-all in v1 — deliberate omission"
    description: "Risks accidental prune bulk-delete during sprint approval clearing. Highest-harm failure mode per user-needs research. Per-run approve-rest is the safe alternative."
    value_statement: "Eliminates the highest-harm UX failure mode"
  - title: "reviewQueueSlice Zustand store + tRPC subscription with full-state resync"
    description: "Subscribe to cyboflow.events.onApprovalCreated for live updates. On mount, query cyboflow.approvals.listPending for full state. On renderer reload, resync the full snapshot (don't trust delta-only)."
    value_statement: "Survives renderer reloads without queue desync"
  - title: "Dock badge bound to queue.length with reconnect-resync"
    description: "macOS dock badge = pending approval count. Resync on tRPC reconnect to prevent desync (badge says 3 pending; queue is empty)."
    value_statement: "Glanceable headline affordance; the visual handle for the whole product thesis"
  - title: "React error boundary wrapping <ReviewQueueView />"
    description: "Catches and renders 'Review queue error — restart app' on JS exceptions. Inherited Crystal codebase has zero error boundaries — this is a 30-min add with outsized safety value."
    value_statement: "A queue-UI crash doesn't block all approvals; restart is still possible"
open_questions: []
assumptions:
  - "Always-visible left rail fits within the 1366px-min display constraint typical of laptops. Verify during the 1-day self-host."
research_recommendation: not_needed
research_rationale: "User-needs research was extensive: keyboard UX patterns (claude-control, Superhuman), collapse-repeated motivation (rajiv.com), no-global-approve-all reasoning, error-boundary gap. All concrete."
---

# Review Queue UI

## Raw Input

Generated from ROADMAP-001, Phase "Phase 2 — Review Queue and Self-Host", Epic "review-queue-ui".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

User-needs research (§3, §4, §5) drove every UX decision in this epic. Risks research §12 surfaced the React error boundary gap.

## Slices

See frontmatter `slices` field. Eleven slices covering: view shell, card content, keyboard, sort, blocking-pin, collapse-repeated, per-run-approve-rest, no-global-approve-all, store + resync, dock badge, error boundary.

## Open Questions

None.

## Assumptions

- Always-visible rail layout works on 1366px-wide displays; verify during self-host.
