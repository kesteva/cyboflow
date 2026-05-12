---
epic: stuck-detection-and-observability
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-011]
---

# Stuck Detection and Observability

## Objective

Detect cross-run and self-deadlock failure modes that the inherited Crystal substrate cannot otherwise surface — a workflow run blocked on an approval whose reviewer is itself blocked on another run — and turn them into a recoverable, user-actionable state. Adds the minimum observability surface that prevents the 1-day self-host bar from being killed by silent hangs.

## Scope

- In scope:
  - 60-second periodic scan of pending approvals older than 5 minutes
  - Classification of stale approvals into `self_deadlock`, `cross_run_deadlock`, `orphan_pty`, or `stale_socket` reasons
  - `workflow_runs.status = 'stuck'` transitions co-written with a `stuck_reason` column
  - UI: distinct visual state on `<PendingApprovalCard />` and the run list when status is `stuck`
  - Cancel-and-restart action: sends socket deny replies (via `ApprovalRouter.clearPendingForRun`), kills the Claude PTY, and offers a fresh run with the same prompt
  - macOS notification on first stuck detection per session; suppressed thereafter to prevent fatigue
  - Read-only "why is this run stuck?" inspector modal showing the latest 10 `raw_events` rows plus the pending approval payload and detected deadlock reason
- Out of scope:
  - Auto-recovery (auto-canceling stuck runs) — every recovery is user-initiated in v1
  - Configurable thresholds / poll interval UI — both are hardcoded constants for v1
  - Stuck-detection telemetry beyond the inspector (no aggregate dashboard)
  - Worktree preservation choice for cancel-and-restart — v1 always preserves the worktree (escalated open question, see TASK-502)

## Success Signal

A synthetic cross-run deadlock — two runs each awaiting a tool result that requires the other run's approval — is flagged as `stuck` within 6 minutes of the first approval going stale; the queue card shows a distinct visual state; the user clicks cancel-and-restart and the original run's pending approvals receive socket `deny` replies cleanly, the PTY exits, and a fresh run starts from the same prompt; only the first stuck transition per session fires a notification; the inspector modal shows the 10 most recent stream events plus the pending approval payload.
