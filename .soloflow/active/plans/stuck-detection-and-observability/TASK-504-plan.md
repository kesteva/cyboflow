---
id: TASK-504
idea: IDEA-011
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/components/ReviewQueue/StuckInspectorModal.tsx
  - frontend/src/components/ReviewQueue/__tests__/StuckInspectorModal.test.tsx
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - main/src/orchestrator/router/runs.ts
  - main/src/orchestrator/__tests__/inspectorQueries.test.ts
files_readonly:
  - frontend/src/components/ui/Modal.tsx
  - shared/types/stuckDetection.ts
  - shared/types/models.ts
  - main/src/orchestrator/stuckDetector.ts
  - main/src/services/database.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
acceptance_criteria:
  - criterion: "`<PendingApprovalCard />` renders a `Why stuck?` button beneath the StuckBadge when the card's runStatus is `'stuck'`. Clicking opens the `<StuckInspectorModal />`."
    verification: "Component test on the card asserts the button is absent for non-stuck runs and present for stuck runs; clicking the button toggles a state that mounts `<StuckInspectorModal />`."
  - criterion: "`<StuckInspectorModal />` calls a tRPC query `cyboflow.runs.getStuckInspection({ runId })` on mount and renders a loading state while pending."
    verification: Component test asserts the modal mounts with a loading indicator visible before the mocked query resolves; asserts the query was called with the correct `runId`.
  - criterion: "`getStuckInspection` returns `{ runId, stuckReason, stuckDetectedAt, pendingApproval: { toolName, input, createdAt }, recentEvents: RawEvent[] }` where `recentEvents` is the latest 10 rows from `raw_events` for that `run_id` ordered by `id DESC`."
    verification: "Backend integration test in `inspectorQueries.test.ts` inserts 15 `raw_events` rows for a stuck run plus one pending approval; calls the query; asserts `recentEvents.length === 10` and the rows are the highest 10 ids in descending order; asserts `pendingApproval` matches the inserted approval; asserts `stuckReason` matches the run's column value."
  - criterion: "The modal renders three sections in this order: (1) detected reason (with the human-readable mapping from TASK-503's reason map), (2) pending approval (tool name in monospace, input payload as collapsed JSON), (3) recent events (each row showing `event_type`, timestamp, and a one-line payload preview)."
    verification: "Component test renders the modal with fixture data; asserts `getByText('Detected reason')`, `getByText('Pending approval')`, `getByText('Recent events')` appear in DOM order via Testing Library's `getAllByRole('heading')` index check."
  - criterion: "The modal is read-only — no Approve, Reject, or Cancel buttons inside it. It is a diagnostic surface, not a recovery surface (the card already exposes Cancel and restart from TASK-502)."
    verification: "Component test renders the modal and asserts the absence of any button with text matching `/Approve|Reject|Cancel and restart/i`. The only interactive element is the modal's close affordance (inherited from `<Modal />`)."
  - criterion: "The query handler scopes to the requesting principal (`ctx.principal.userId === 'local'` for v1) and refuses to return data for a run the principal does not own — even though v1 is solo and this is always true, the check is structurally present for forward compatibility with the auth principal the `orchestrator-and-trpc-router` epic establishes."
    verification: "`grep -n 'ctx\\.principal\\|userId' main/src/orchestrator/router/runs.ts` shows the principal is consulted inside `getStuckInspection`; backend test injects a principal with a non-`local` userId and asserts the query throws or returns an unauthorized error."
depends_on:
  - TASK-501
  - TASK-502
estimated_complexity: low
epic: stuck-detection-and-observability
test_strategy:
  needed: true
  justification: "Two surfaces: a backend query that joins three tables with an explicit row-limit and ordering, and a modal UI with a documented section order and a documented read-only invariant. Each invariant has a small but real failure mode worth testing."
  targets:
    - behavior: getStuckInspection returns latest 10 raw_events plus pending approval and stuck metadata
      test_file: main/src/orchestrator/__tests__/inspectorQueries.test.ts
      type: integration
    - behavior: getStuckInspection enforces principal scoping
      test_file: main/src/orchestrator/__tests__/inspectorQueries.test.ts
      type: integration
    - behavior: "Why stuck? button visible only for stuck runs, opens modal"
      test_file: frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
      type: component
    - behavior: "Modal renders three sections in correct order, in loading state initially, and is read-only"
      test_file: frontend/src/components/ReviewQueue/__tests__/StuckInspectorModal.test.tsx
      type: component
---
# Why-stuck inspector modal (read-only diagnostic)

## Objective

Give the user a one-click diagnostic view that explains *why* a run is flagged stuck: the classification reason from `StuckDetector`, the pending approval payload that triggered the wait, and the latest 10 `raw_events` rows for the run. Read-only — recovery actions stay on the queue card (TASK-502). This is the "debuggability without full observability infrastructure" surface the IDEA describes.

## Implementation Steps

1. Add a backend tRPC query in `main/src/orchestrator/router/runs.ts` (shared with TASK-502 which is also adding a mutation to this file — coordinate via depends_on). Procedure `getStuckInspection`, input `z.object({ runId: z.string() })`, output strongly typed.
2. Query body (single transaction or three SELECTs is fine — read-only):
   ```sql
   SELECT id, status, stuck_reason, stuck_detected_at FROM workflow_runs WHERE id = ? AND user_id = ?;
   SELECT id, tool_name, input, created_at FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1;
   SELECT id, event_type, payload, created_at FROM raw_events WHERE run_id = ? ORDER BY id DESC LIMIT 10;
   ```
   Uses the `raw_events(run_id, id)` index established by migration 006.
3. Principal scoping: prefix with `if (ctx.principal.userId !== <run.user_id || 'local'>) throw new TRPCError({ code: 'FORBIDDEN' })`. The principal pattern is set up by the `orchestrator-and-trpc-router` epic; if the principal shape differs from `{ userId }`, adapt to whatever exact field exists on the context.
4. Create `frontend/src/components/ReviewQueue/StuckInspectorModal.tsx`. Props: `{ runId: string; onClose: () => void }`. Uses the existing `<Modal />` primitive from `frontend/src/components/ui/Modal.tsx`. Inside: a `react-query` (or whatever tRPC v11 query hook is wired) call to `api.cyboflow.runs.getStuckInspection({ runId })`.
5. Render three sections with `<h2>` headings: "Detected reason", "Pending approval", "Recent events". Use the same reason-to-human-text mapping TASK-503 establishes (consider extracting to `shared/types/stuckDetection.ts` as a helper if both tasks need it — coordinate).
6. "Recent events" section: render each row as a one-line `<div>` with `event_type` in a monospace tag, relative timestamp, and a short payload preview (e.g., first 80 chars of `JSON.stringify(payload)`). Full payload available on hover or in a nested expand.
7. Modify `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx` (also touched by TASK-502). Add a `Why stuck?` button visible only when `runStatus === 'stuck'`, placed beneath the StuckBadge. Click toggles local state that mounts the modal.
8. Tests in three files (backend integration + two component). See Test Strategy.

## Acceptance Criteria

Each criterion above must pass. The read-only invariant (no Approve/Reject/Cancel buttons inside the modal) is structurally enforced by simply not adding them — but the test guards against future drift, since the diagnostic surface tends to attract scope creep.

## Test Strategy

- `inspectorQueries.test.ts`: in-memory DB with migrations 006 + 007 applied. Insert one stuck `workflow_runs` row, one pending `approvals` row, 15 `raw_events` rows. Call `getStuckInspection`. Assert (a) 10 events returned (b) descending id order (c) pending approval matches (d) reason field matches. Second test: principal with `userId: 'someone-else'` throws.
- `StuckInspectorModal.test.tsx`: render with a mocked api client. Two cases: loading state, loaded state with fixture data. Assert section order, read-only invariant, close behavior.
- `PendingApprovalCard.test.tsx` (additive to TASK-502's tests in the same file): assert `Why stuck?` button visibility and modal-open behavior.

## Hardest Decision

**Whether to expose full `raw_events.payload` JSON or a redacted preview.** Full payload is more useful for debugging but tool-use payloads can contain large file contents, command strings, and occasionally secrets if the user's prompts contain them. Three options:

1. **Full JSON in `<pre>` blocks.** Most useful for debugging, biggest surface for accidental secret exposure if the user screenshots the modal.
2. **80-char preview + click-to-expand.** Balance of usability and exposure (chosen).
3. **Just `event_type` and timestamp, no payload.** Safest but mostly useless — the user could read this from the queue card already.

Chose option 2 with the click-to-expand pattern. Aligns with the user-needs research principle that diagnostic surfaces should be informative without being overwhelming, and matches the existing log/diff UI conventions in the inherited Crystal codebase.

## Rejected Alternatives

- **Show the inspector as a side-panel instead of a modal.** Rejected: the cross-workflow review queue is already a workspace-scoped surface; another permanent panel would compete for screen real estate. A modal is on-demand only.
- **Include a "rerun stuck detection" button in the modal.** Rejected: the periodic scan handles this in ≤60s, and a manual trigger leaks the implementation detail to the user. The IDEA explicitly scopes this to a read-only diagnostic.
- **Show the `stuck_reason` heuristic logic inline (e.g., "this was flagged because another run is also awaiting_review, which is the v1 cross_run_deadlock heuristic").** Rejected as too implementation-leaky for v1. The reason string is sufficient. v2 can add a "heuristic detail" link if user feedback wants it.

## Lowest Confidence Area

Whether the v1 `cross_run_deadlock` heuristic (TASK-501's Lowest Confidence) will produce inspector views that confuse the user — a stuck card pointing at a `conflictingRunId` that is not actually causing the stuck state. The inspector intentionally does not invent a causal narrative; it shows the reason tag plus the raw events and lets the user draw conclusions. If 1-day self-host feedback shows users expect a causal explanation, the fix is in TASK-501 (drop the heuristic or refine it), not here.
