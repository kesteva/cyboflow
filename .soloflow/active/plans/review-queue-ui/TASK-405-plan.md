---
id: TASK-405
idea: IDEA-009
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/utils/reviewQueueSelectors.ts
  - frontend/src/utils/__tests__/reviewQueueSelectors.test.ts
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/components/PendingApprovalCard.tsx
files_readonly:
  - shared/types/approvals.ts
  - frontend/src/utils/approvalFormatters.ts
  - frontend/src/trpc/client.ts
  - .soloflow/active/research/ROADMAP-001-research-user-needs.md
acceptance_criteria:
  - criterion: "`sortQueueOldestFirst` selector returns approvals sorted ascending by createdAt"
    verification: "Unit test: input [{ createdAt: '2026-05-11T10:00' }, { createdAt: '2026-05-11T09:00' }] → output sorted as 09:00, 10:00"
  - criterion: "`partitionBlockingItems` selector returns `{ blocking: Approval[], normal: Approval[] }` where blocking = items with age > 3 minutes"
    verification: "Unit test: input with one 4-minute-old and one 1-minute-old approval → blocking contains only the 4-minute one"
  - criterion: "`groupRepeatedApprovals` selector collapses approvals from same runId + same (toolName + payloadSignature) into a group object `{ kind: 'group', runId, toolName, payloadSignature, count, items: Approval[] }`"
    verification: "Unit test: input with 7 identical approvals (same runId, toolName='Bash', payload='npm test') → output is one group with count: 7; input with 3 unique → output 3 single items"
  - criterion: "Final composed selector `selectQueueView` returns items in the order [blocking-pinned (oldest-first within), normal (oldest-first within)] with grouping applied within each section"
    verification: "Unit test: mixed input with 1 blocking 4-min item and 5 normal items → output starts with blocking, then normal in oldest-first order"
  - criterion: "PendingApprovalCard supports grouped variant: when `approval` is a group, shows 'npm test (×7 in this run)' as the tool name and renders a single Approve/Reject pair that fires the group action"
    verification: "grep -n 'kind === .group.\\|isGroup\\|×\\|x.*in this run' frontend/src/components/PendingApprovalCard.tsx returns matches; grep -n 'count' frontend/src/components/PendingApprovalCard.tsx shows the count rendered"
  - criterion: "Blocking pinned items show a 'blocked Nm' badge using the formatAge helper"
    verification: "grep -n 'blocked' frontend/src/components/PendingApprovalCard.tsx returns the badge string; verified to render on items with isBlocking prop true"
  - criterion: "ReviewQueueView consumes selectQueueView and renders the pinned section above the normal section, each with a section header ('Blocking' / 'Pending')"
    verification: "grep -n 'Blocking\\|Pending' frontend/src/components/ReviewQueueView.tsx returns both section headers"
depends_on:
  - TASK-401
  - TASK-402
  - TASK-403
  - TASK-404
estimated_complexity: high
epic: review-queue-ui
test_strategy:
  needed: true
  justification: "Three pure selectors with non-trivial sort/partition/group logic — each branch needs verification, and these power the visual ordering of the entire queue"
  targets:
    - behavior: sortQueueOldestFirst sorts ascending by createdAt
      test_file: frontend/src/utils/__tests__/reviewQueueSelectors.test.ts
      type: unit
    - behavior: "partitionBlockingItems splits at >3min age threshold"
      test_file: frontend/src/utils/__tests__/reviewQueueSelectors.test.ts
      type: unit
    - behavior: groupRepeatedApprovals collapses same-run + same-signature into groups with count
      test_file: frontend/src/utils/__tests__/reviewQueueSelectors.test.ts
      type: unit
    - behavior: selectQueueView composes sort + partition + group correctly
      test_file: frontend/src/utils/__tests__/reviewQueueSelectors.test.ts
      type: unit
    - behavior: PendingApprovalCard renders group variant with count and group-level actions
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
      type: component
---
# Oldest-First Sort + Blocking-Pin (>3min) + Collapse Repeated Approvals

## Objective

Implement the three triage affordances that turn a raw approval list into a usable queue: (1) oldest-first default sort so the longest-blocked run gets cleared first (IDEA slice 4); (2) pin items in `awaiting_review > 3 min` to the top with a "blocked Nm" badge (IDEA slice 5, addresses the silent-hang failure mode named in user-needs research §5 and risks research §4); (3) collapse repeated approvals from the same run + same tool + same payload signature into a single card with × count (IDEA slice 6, addresses the rajiv.com 14-identical-prompts failure mode). All three are pure selectors composed in the order: sort → partition (blocking vs normal) → group within each section. The PendingApprovalCard learns a "group" variant. The per-run "approve rest" action it requires is implemented in TASK-406.

## Implementation Steps

1. Create `frontend/src/utils/reviewQueueSelectors.ts`:
   - Export `type QueueItem = { kind: 'single'; approval: Approval; isBlocking: boolean } | { kind: 'group'; runId: string; toolName: string; payloadSignature: string; items: Approval[]; isBlocking: boolean }`.
   - Export `payloadSignature(payload: string): string` — for v1, a simple normalized hash: trim, lowercase, take first 100 chars. Pure function. (Future: SHA-256 of normalized form, but unnecessary for v1.)
   - Export `sortQueueOldestFirst(items: Approval[]): Approval[]` — pure, returns new array sorted ascending by `createdAt`.
   - Export `partitionBlockingItems(items: Approval[], now: number, thresholdMs = 3 * 60 * 1000): { blocking: Approval[]; normal: Approval[] }` — pure, splits by age.
   - Export `groupRepeatedApprovals(items: Approval[]): QueueItem[]` — pure, groups consecutive same-runId + same-(toolName + payloadSignature) approvals. Items that don't repeat stay as `kind: 'single'`. NOTE: only groups WITHIN the same run; never groups across different runs (per IDEA slice 6's explicit scoping).
   - Export `selectQueueView(items: Approval[], now: number): { blocking: QueueItem[]; normal: QueueItem[] }`:
     ```ts
     const sorted = sortQueueOldestFirst(items);
     const { blocking, normal } = partitionBlockingItems(sorted, now);
     return {
       blocking: groupRepeatedApprovals(blocking).map(g => ({ ...g, isBlocking: true })),
       normal: groupRepeatedApprovals(normal).map(g => ({ ...g, isBlocking: false })),
     };
     ```
2. Modify `frontend/src/stores/reviewQueueStore.ts`:
   - Add a memoized selector hook `useQueueView(): { blocking: QueueItem[]; normal: QueueItem[] }` — wraps `selectQueueView(state.queue, Date.now())`. Re-evaluate on a 30s timer so the blocking threshold updates as items age. Implement as a `useReviewQueueView()` exported hook that uses `useReviewQueueStore` + `useState`/`useEffect` for the timer.
3. Modify `frontend/src/components/PendingApprovalCard.tsx`:
   - Change prop signature: `{ item: QueueItem; isFocused?: boolean }` (renaming from `approval` to `item`).
   - When `item.kind === 'single'`: render as before, using `item.approval`. Add a "blocked Nm" badge in the header row when `item.isBlocking` is true (use `formatAge` from `approvalFormatters`).
   - When `item.kind === 'group'`: render a different header: `<span>{item.toolName} (×{item.items.length} in this run)</span>`. Show the payload preview from the first item (representative). Approve/Reject buttons fire the group action — for this task, the buttons call `Promise.all(item.items.map(a => trpc.cyboflow.approvals.approve.mutate({ approvalId: a.id })))`. TASK-406 will replace this with a single "approve rest of run" mutation; for now, per-item batched is acceptable and verifiable.
4. Modify `frontend/src/components/ReviewQueueView.tsx`:
   - Replace direct iteration over `queue` with iteration over `useReviewQueueView()`.
   - Render two sections with headers: `<h3>Blocking</h3>` (only if `blocking.length > 0`) and `<h3>Pending</h3>`. Each section maps over its items.
   - The keyboard hook from TASK-404 receives the flat ordered list `[...blocking, ...normal]` so `j`/`k` navigate across both sections naturally.
5. Update `useReviewQueueKeyboard` consumer in `ReviewQueueView.tsx`: pass the flat ordered QueueItem array. (TASK-404's hook works on `Approval[]`; for grouped items, the hook will need to invoke approve/reject on the whole group. Smallest change: change the hook to accept `QueueItem[]` and have its y/n handlers do the per-item batched mutate when the focused item is a group. This is a small refactor of TASK-404's hook — make the change in this task as it's part of the grouping integration.)
6. Write unit tests in `frontend/src/utils/__tests__/reviewQueueSelectors.test.ts` covering: sort with 3 items, partition at the 3-min boundary (one item exactly 180001ms old → blocking, one at 179999ms → normal), grouping of 7 same-signature items, composition correctness (mixed input through selectQueueView).
7. Add a component test in `frontend/src/components/__tests__/PendingApprovalCard.test.tsx` for the group variant (extend the existing test file).

## Acceptance Criteria

All seven criteria above.

## Test Strategy

Four selector unit tests + one component test for the group variant. The selectors are pure functions — direct, no mocking. The component test mocks the trpc client.

## Hardest Decision

**Should grouping happen client-side or server-side?** Client-side wins for v1 because: (a) the server's job is to emit raw approval events; collapsing them in the orchestrator complicates the per-run mutex contract; (b) the user wants to see the count update in real-time as new same-signature approvals arrive — easier with client-side reactive grouping; (c) v2 may want different grouping rules (UI flag) and server-side commits us to one. Cost: the renderer does O(n) on every queue change. With n in the 10-50 range this is irrelevant.

The second hard call: **the 3-minute threshold.** User-needs research §4 says "3–5 minutes is a reasonable threshold for MVP." Choosing 3 because: (a) the cost of a false-positive (item shown as blocking when not yet truly blocking) is low — it gets pinned, the user clears it sooner; (b) the cost of a false-negative (truly blocking item not pinned) is high. Make it a constant in the selector so tuning is a one-line change.

## Rejected Alternatives

- **Group across runs (any same-signature).** Rejected per IDEA slice 6 — same-run scoping is the safety guarantee. Cross-run grouping would let one Approve click decide approvals from runs the user doesn't have context on.
- **Sort newest-first.** Rejected — research clearly favors oldest-first for bottleneck triage.
- **Cryptographic payload hash.** Overkill for v1; the normalized-prefix signature handles the rajiv.com case (same `gcloud logging read` command repeated) reliably.
- **Real-time blocking-threshold recomputation (every render).** Rejected for the 30s-timer approach to avoid recomputing on every keystroke. 30s is well below the 3-min threshold, so the UI never lags the user's mental model.

What would change my mind on grouping placement: if the orchestrator already needs to deduplicate at the storage layer (e.g., to keep `approvals` row count sane), server-side grouping becomes natural and the renderer just consumes it.

## Lowest Confidence Area

The interaction between grouping and the keyboard hook's "y approves the focused item" semantics. When the focused item is a group of 7, pressing y issues 7 mutations. If one fails, the partial-decided state is messy. Mitigation: the group-approve handler logs failures but doesn't roll back successful approvals — Claude has already resumed for those. TASK-406's per-run "approve rest" mutation (single atomic call) replaces this batched approach and is the better long-term answer; this task ships with the batch approach as a stepping stone.
