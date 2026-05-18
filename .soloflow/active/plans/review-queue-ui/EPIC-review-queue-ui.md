---
epic: review-queue-ui
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-009]
---

# Epic: Review Queue UI

## Objective

Ship the load-bearing UI surface of Cyboflow: a workspace-scoped, always-visible review queue that aggregates pending tool-use approvals from every running workflow, with keyboard-first triage, oldest-first sort, blocking-pin for slow approvals, repeated-approval collapse, scoped per-run "approve rest", explicit no-global-approve-all, dock-badge binding, and a React error boundary. This is the single pane the entire fork exists to deliver (system design §1, §5.7). When done, a user can clear a queue of 15 items in under 60 seconds using only the keyboard, never miss a stalled approval, and never accidentally bulk-approve a destructive operation.

## Scope

- **In scope:**
  - `<ReviewQueueView />` left-rail shell wrapped in an ErrorBoundary
  - `<PendingApprovalCard />` with workflow + tool + payload + rationale + age + Approve/Reject
  - Keyboard navigation: j/k navigate, y/n decide, visible focus, input-element guards
  - Default sort: oldest createdAt first
  - Pin items in awaiting_review > 3 min with "blocked Nm" badge
  - Collapse repeated approvals (same run + same tool + same payload signature) into a count card
  - Per-run `approveRestOfRun` mutation; group-card Approve uses it
  - Per-run `rejectRestOfRun` mutation; group-card Reject and keyboard `n` use it
  - Explicit absence of any global approve-all symbol (sweep test enforces)
  - `reviewQueueStore` Zustand slice with full-state resync on mount and on tRPC reconnect
  - tRPC v11 router scaffolding (`cyboflow.approvals`, `cyboflow.events`) — the contract layer this epic produces
  - macOS dock badge bound to queue length with reconnect-resync
  - React error boundary with queue-specific fallback ("Review queue error — restart app")

- **Out of scope:**
  - The `ApprovalRouter` orchestrator service that actually creates approvals and replies on the permission socket (owned by IDEA-008 / a future approval-router epic). This epic stubs the create/decide path and consumes whatever the orchestrator produces.
  - Filter-by-workflow, search, prioritization beyond the blocking-pin
  - Auto-approval policies, AI-assisted triage, allowlist UI
  - Cross-machine sync, team queues, auth — out of v1 entirely
  - Linux/Windows dock-badge equivalents — v1 is macOS

## Success Signal

A solo developer on their first 1-day self-host runs 3-5 parallel SoloFlow workflows. Over the day they encounter ~50 approval events. They clear the queue in ~5 focused minutes of keyboard triage (j/k/y/n). The dock badge accurately tracks pending count even across one renderer reload during development. At least one approval gets pinned as blocking during the day and they catch it before the run silently hangs. No accidental bulk-approve incidents. No JS exceptions take the queue down. They report the queue "feels like the product" — not a feature, but the thing.
