---
id: IDEA-011
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 2 — Review Queue and Self-Host"
roadmap_epic: "stuck-detection-and-observability"
slices:
  - title: "60s periodic scan of stale pending approvals"
    description: "Cron-like interval scans `approvals` WHERE status=pending AND created_at < now() - 5min. Runs once per minute. Each stale candidate is evaluated for stuck-state."
    value_statement: "Cheap polling that catches cross-run deadlocks within 6 minutes"
  - title: "Detect self-deadlock and cross-run deadlock patterns"
    description: "For each stale approval, check: (a) same run has another pending approval (self-deadlock?), (b) Claude PTY is still alive (not crashed-and-orphaned), (c) socket is still connected. Transition workflow_runs to status=stuck with stuck_reason describing which case."
    value_statement: "Identifies the specific failure mode so the user can act on it"
  - title: "UI: stuck runs distinct visual state + cancel-and-restart action"
    description: "On the queue card and in the run list, stuck runs have a distinct color/icon. Action: cancel-and-restart deletes the run, sends socket deny replies, and offers to create a fresh run with the same prompt."
    value_statement: "Recoverable rather than terminal; user-actionable"
  - title: "Notification on first stuck detection per session (collapsed thereafter)"
    description: "macOS notification fires on first detection in a session, then suppresses for subsequent. Prevents notification fatigue per user-needs research."
    value_statement: "User sees stuck state without being spammed"
  - title: "Minimal 'why is this run stuck?' inspector"
    description: "Modal showing latest 10 raw_events for the stuck run + the pending approval payload + which deadlock case was detected. Read-only diagnostic view."
    value_statement: "Debuggability without full observability infrastructure"
open_questions:
  - "Should cancel-and-restart preserve the worktree, or destroy and recreate? Affects whether incomplete work is recoverable."
assumptions:
  - "60-second poll interval is a reasonable trade-off between detection latency and CPU cost. Tunable post-MVP."
research_recommendation: not_needed
research_rationale: "Design doc §5.7 specifies the 5-minute threshold. Risks research §12 flagged the observability gap. The implementation is straightforward."
---

# Stuck Detection and Observability

## Raw Input

Generated from ROADMAP-001, Phase "Phase 2 — Review Queue and Self-Host", Epic "stuck-detection-and-observability".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

Design doc §5.7 mandates 5-minute cross-run deadlock detection. User-needs research §5 elaborated the user-side impact (invisible deadlock manual diagnosis can take 30+ minutes).

## Slices

See frontmatter `slices` field. Five slices: periodic scan, deadlock classification, UI surfacing + recovery action, notification, inspector view.

## Open Questions

- Cancel-and-restart worktree handling — preserve or destroy?

## Assumptions

- 60s polling is acceptable for v1; tunable later.
