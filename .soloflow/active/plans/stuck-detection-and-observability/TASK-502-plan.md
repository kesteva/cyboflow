---
id: TASK-502
idea: IDEA-011
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/components/ReviewQueue/StuckBadge.tsx
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - frontend/src/stores/reviewQueueSlice.ts
  - main/src/orchestrator/router/runs.ts
  - main/src/orchestrator/__tests__/cancelAndRestart.test.ts
  - shared/types/stuckDetection.ts
files_readonly:
  - main/src/orchestrator/stuckDetector.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/index.ts
  - main/src/services/worktreeManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - frontend/src/components/ReviewQueue/ReviewQueueView.tsx
  - frontend/src/utils/api.ts
  - shared/types/models.ts
  - docs/cyboflow_system_design.md
acceptance_criteria:
  - criterion: "`<PendingApprovalCard />` renders a `<StuckBadge />` with text 'STUCK' plus a tooltip showing the `stuck_reason` whenever the card's underlying run has `workflow_runs.status === 'stuck'`."
    verification: "`grep -n 'StuckBadge' frontend/src/components/ReviewQueue/PendingApprovalCard.tsx` returns the import and JSX usage; React component test renders the card with a fixture run in `status: 'stuck'` and asserts the badge is in the DOM via `getByText('STUCK')`."
  - criterion: "Cards for stuck runs are visually distinguished from normal cards via a Tailwind class delta (e.g., `border-red-500` or equivalent), not via inline styles."
    verification: Component test renders one stuck card and one running card; asserts the stuck card root element has a className containing `red` (or the agreed alert color); the running card does not.
  - criterion: "A `Cancel and restart` button is rendered only when the card's run is `stuck`. Clicking it calls a tRPC mutation `cyboflow.runs.cancelAndRestart({ runId })`."
    verification: "Component test using a mocked API client asserts the button is absent for a `running` run, present for a `stuck` run; clicking the button calls `api.cyboflow.runs.cancelAndRestart` with the correct runId."
  - criterion: "`runs.cancelAndRestart` tRPC mutation in `main/src/orchestrator/router/runs.ts` runs under the per-run `p-queue` and executes in order: (a) `approvalRouter.clearPendingForRun(runId)` (which sends socket deny replies for every pending approval), (b) kill the Claude PTY via `claudeManager.stop(sessionId)`, (c) `UPDATE workflow_runs SET status = 'canceled' WHERE id = ?`, (d) create a new `workflow_runs` row with the same `workflow_id`, `project_id`, `prompt`, and worktree path (worktree is preserved, not destroyed), (e) return the new `runId`."
    verification: "Integration test in `cancelAndRestart.test.ts` simulates a stuck run with one pending approval; calls the mutation; asserts the pending approval row's status transitions to `denied` (via the deny socket path), the old run's status is `canceled`, a new run row exists with the same `workflow_id` and `prompt`, the worktree path is unchanged, and the mutation's return value is the new runId."
  - criterion: "The cancel-and-restart deny step uses `approvalRouter.clearPendingForRun(runId)` rather than reimplementing socket deny logic. If `clearPendingForRun` does not exist with that exact name on `ApprovalRouter` (owned by the `approval-router-and-permission-fix` epic), the mutation calls whichever named method the router exposes for 'send deny on socket and mark approval expired/denied for runId' — the plan's verification command names the exact symbol the dependency exposes."
    verification: "`grep -n 'clearPendingForRun\\|denyAllForRun\\|cancelPendingForRun' main/src/orchestrator/router/runs.ts` returns a call site to the named router method; the integration test verifies the deny replies were sent before the PTY was killed by asserting a spy on the deny method was called before a spy on `claudeManager.stop`."
  - criterion: "`reviewQueueSlice` Zustand store subscribes to the `runs:stuck` event via the existing tRPC subscription (`cyboflow.events.onApprovalCreated` or a new `onRunStatusChanged`) and updates the matching queue item's `runStatus` field to `'stuck'` reactively. The card re-renders within one event loop tick of the event arriving."
    verification: "Component test attaches a real Zustand store, calls the slice's `applyStuckEvent({ runId })` reducer directly, asserts the matching queue item's `runStatus` flips to `'stuck'` and a re-render occurs (verified via React Testing Library `rerender` or `waitFor`)."
  - criterion: Worktree preservation is the v1 default for cancel-and-restart. The mutation does NOT call `worktreeManager.remove(...)`. The new run reuses the existing worktree path.
    verification: "Integration test asserts after `cancelAndRestart` runs, `fs.existsSync(<worktreePath>) === true` and `worktreeManager.remove` (mocked) was never called."
depends_on:
  - TASK-501
estimated_complexity: medium
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "Two integration surfaces — the cancel-and-restart mutation orchestrating four ordered side effects, and the UI's reactive response to a stuck-state transition — both have multiple branches that warrant explicit tests."
  targets:
    - behavior: Stuck badge renders only for stuck runs
      test_file: frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
      type: component
    - behavior: Cancel-and-restart button renders only for stuck runs and calls the correct mutation
      test_file: frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
      type: component
    - behavior: reviewQueueSlice applies stuck event reactively
      test_file: frontend/src/stores/__tests__/reviewQueueSlice.test.ts
      type: unit
    - behavior: "cancelAndRestart mutation: deny socket replies → kill PTY → cancel old run → create new run, worktree preserved"
      test_file: main/src/orchestrator/__tests__/cancelAndRestart.test.ts
      type: integration
---
# Stuck-run UI surface and cancel-and-restart recovery

## Objective

Surface the `stuck` workflow-run state on the cross-workflow review queue with a distinct visual badge on `<PendingApprovalCard />` and a recovery action (`Cancel and restart`) that drives the orchestrator-side cleanup: socket deny replies via `ApprovalRouter.clearPendingForRun`, PTY kill via `ClaudeCodeManager.stop`, old-run cancellation, and a fresh run row pointing at the same worktree and prompt. Closes the user-actionable loop the IDEA describes — recoverable rather than terminal.

## Implementation Steps

1. Create `frontend/src/components/ReviewQueue/StuckBadge.tsx`. Small Tailwind-styled pill with the literal text `STUCK` and a tooltip rendering the `stuck_reason` and `stuck_detected_at` (relative time). Reuses existing UI primitives from `frontend/src/components/ui/` (Badge, Tooltip) — do not reinvent.
2. Modify `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx` (created by the `review-queue-ui` epic; this task is permitted to add the stuck-state surface even though the file is in another epic's primary scope — coordinate via the depends_on graph). Add: (a) read the run's status from the queue store, (b) render `<StuckBadge />` and an alert-color border class when `runStatus === 'stuck'`, (c) render a `Cancel and restart` button beneath the existing Approve/Reject buttons, visible only when stuck.
3. Implement the button's click handler: call `api.cyboflow.runs.cancelAndRestart({ runId })`. Use the existing `frontend/src/utils/api.ts` wrapper.
4. Modify `frontend/src/stores/reviewQueueSlice.ts` (also a `review-queue-ui` epic primary). Add a `runStatus` field to each queue item, defaulted from the approval's joined `workflow_runs.status`. Add an `applyStuckEvent({ runId, reason, detectedAt })` reducer that updates every queue item whose `runId` matches. Subscribe to the tRPC subscription that carries `runs:stuck` events (likely `cyboflow.events.onRunStatusChanged` — coordinate with the `orchestrator-and-trpc-router` epic on the exact subscription name; if it does not exist, add a new `cyboflow.events.onStuckDetected` procedure in this task's router file).
5. Create `main/src/orchestrator/router/runs.ts` if it does not already exist (file should be created by `orchestrator-and-trpc-router`; if it exists, ADD the procedure rather than overwrite). Define `cancelAndRestart` as a tRPC mutation taking `{ runId: z.string() }`.
6. Mutation body, executed inside the per-run `p-queue` for `runId` (use the registry the orchestrator epic established):
   1. Look up the run: `SELECT * FROM workflow_runs WHERE id = ?`. If status is already `canceled` / `failed` / `completed`, return `{ noOp: true, reason: 'already_terminal' }`.
   2. Call `approvalRouter.clearPendingForRun(runId)` (or the equivalent method the ApprovalRouter exposes — see Acceptance Criteria caveat for verification). This sends socket deny replies for every pending approval and marks each approval row `status = 'denied'` (or `expired`, depending on the router's convention).
   3. Call `claudeManager.stop(sessionId)` (or `kill`, whichever method the inherited Crystal class exposes — `main/src/services/panels/claude/claudeCodeManager.ts` is readonly; consult it).
   4. `UPDATE workflow_runs SET status = 'canceled', canceled_at = ? WHERE id = ? AND status IN ('stuck', 'awaiting_review')`. Status guard prevents reviving a terminal run.
   5. Generate a new `runId`, `INSERT INTO workflow_runs (id, workflow_id, project_id, prompt, worktree_path, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)` reusing the canceled row's `workflow_id`, `project_id`, `prompt`, and `worktree_path`.
   6. Return `{ newRunId }`.
7. **Worktree preservation:** the mutation does not call `worktreeManager.remove`. The open question in the IDEA ("preserve or destroy worktree?") is decided here as **preserve** for v1, on the user-needs grounds that the worktree may contain partially-completed work the user wants to inspect. v2 can add an explicit "Cancel and discard worktree" variant.
8. Add an integration test in `main/src/orchestrator/__tests__/cancelAndRestart.test.ts`. Mock `claudeManager`, mock `approvalRouter` (or use the real one with a stub socket), use real DB. Assert the four side effects in order via spies and final DB state.
9. Add the component tests in `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx` covering badge rendering, button visibility, and click → mutation call. Use the project's existing component-testing setup (React Testing Library); if none exists yet for this directory, scaffold one matching `frontend/src/components/ui/__tests__/` if present, otherwise inherit Vite's vitest defaults.
10. Add the slice test in `frontend/src/stores/__tests__/reviewQueueSlice.test.ts` for the `applyStuckEvent` reducer.

## Acceptance Criteria

Each criterion above must pass. The hardest one is the ordered side-effect verification in step 6 — the test uses spies to assert deny-replies happen **before** PTY kill, because killing the PTY first would orphan Claude on the socket and the run could not exit cleanly.

## Test Strategy

Three test files:

- `PendingApprovalCard.test.tsx`: render the card with fixture data, mock the api module, assert UI states and click behavior. Covers two acceptance criteria.
- `reviewQueueSlice.test.ts`: instantiate the slice, dispatch `applyStuckEvent`, assert state shape. Covers one acceptance criterion.
- `cancelAndRestart.test.ts`: real in-memory DB with migrations 006 + 007 applied; mocked `claudeManager` and `approvalRouter` (or `ApprovalRouter` constructed against a stub socket server); the test drives the mutation end-to-end and asserts (i) deny called before PTY kill, (ii) DB state changes (old run canceled, new run inserted), (iii) worktreeManager.remove never called.

## Hardest Decision

**Worktree preservation vs destruction on cancel-and-restart.** This was the explicit open question in IDEA-011. Three options were considered:

1. **Preserve always (chosen).** New run reuses the worktree path. Pro: zero data loss; user can `git diff` the worktree to see what was in-flight. Con: worktree may have stale `node_modules`/build artifacts from the canceled run; the new Claude process may be confused by partial state.
2. **Destroy always.** New run gets a fresh worktree. Pro: clean slate. Con: any partially-completed work — files Claude wrote before getting stuck — is gone.
3. **Surface a confirmation dialog.** User picks per-cancel. Pro: correct UX. Con: adds a modal to a recovery flow the user already perceives as a failure, and adds branching complexity to this task that pushes it over the 1-day budget.

Chose option 1. The user-needs research called out that "permanent data loss" is the highest-harm failure mode; cancel-and-restart should be the lowest-friction recovery action available, and destroying user-visible work is the wrong default. v2 can add option 3 as a confirmation step if user feedback demands it.

## Rejected Alternatives

- **Make Cancel-and-restart available on all runs, not just stuck.** Rejected: the cross-workflow review queue already has a per-card Reject action; adding a global Cancel-and-restart muddies the affordance hierarchy. Stuck is the recovery state the action exists to address.
- **Auto-cancel-and-restart on stuck detection without user click.** Rejected: stuck classification has known false-positive cases (the v1 cross_run_deadlock heuristic per TASK-501's Lowest Confidence). Auto-canceling a falsely-flagged run would destroy in-progress work; user-in-the-loop preserves the product thesis.
- **Use Crystal's existing `permissionManager.clearPendingRequests`** instead of `approvalRouter.clearPendingForRun`. Rejected: `permissionManager.ts:80` does not send deny replies on the socket — it just emits an internal response event. The Crystal implementation is exactly the bug the `approval-router-and-permission-fix` epic fixes; this task must use the new router method.

## Lowest Confidence Area

The exact name of the `ApprovalRouter` deny method (`clearPendingForRun` vs `cancelPendingForRun` vs `denyAllForRun`) and the exact name of the tRPC subscription procedure for stuck events both depend on decisions the `approval-router-and-permission-fix` and `orchestrator-and-trpc-router` epics make. This task takes the IDEA's name (`clearPendingForRun`) as authoritative; if the upstream epic ships a different name, this task's verification commands must be updated to match. The fallback (documented in step 6) is to consult the router's exported surface at integration time and use whatever method has the documented semantic of "send deny on socket and mark approval expired/denied for every pending approval belonging to runId."
