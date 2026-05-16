---
id: TASK-403
idea: IDEA-009
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/components/PendingApprovalCard.tsx
  - frontend/src/components/__tests__/PendingApprovalCard.test.tsx
  - frontend/src/utils/approvalFormatters.ts
files_readonly:
  - shared/types/approvals.ts
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/trpc/client.ts
  - frontend/src/components/ui/Button.tsx
  - .soloflow/active/research/ROADMAP-001-research-user-needs.md
acceptance_criteria:
  - criterion: "`<PendingApprovalCard />` accepts an Approval prop and renders workflow name, tool name, payload preview, rationale (if present), and age"
    verification: "grep -n 'workflowName\\|toolName\\|payloadPreview\\|rationale\\|createdAt' frontend/src/components/PendingApprovalCard.tsx returns matches for all five fields rendered as visible text"
  - criterion: Card renders Approve and Reject buttons that invoke trpc.cyboflow.approvals.approve and .reject mutations with the approval id
    verification: "grep -n 'cyboflow.approvals.approve\\|cyboflow.approvals.reject' frontend/src/components/PendingApprovalCard.tsx returns both calls; Button onClick handlers wired"
  - criterion: "Age is computed from createdAt and rendered as a human-readable relative time (e.g. '2m', '14m', '1h')"
    verification: "grep -n 'formatAge\\|relativeTime' frontend/src/utils/approvalFormatters.ts returns the formatter; PendingApprovalCard imports it"
  - criterion: "Payload preview truncates long content (e.g. file edits, long bash commands) to ~200 chars with a 'show more' affordance or ellipsis"
    verification: "grep -n 'truncate\\|substring\\|slice\\(0' frontend/src/utils/approvalFormatters.ts returns the truncation helper"
  - criterion: "Rationale text is rendered above the payload preview when present, in a muted style to differentiate from the payload itself"
    verification: "grep -n 'rationale' frontend/src/components/PendingApprovalCard.tsx shows it rendered with a distinct className (e.g. 'text-text-muted')"
  - criterion: "Card has data-approval-id={approval.id} and role='listitem' for keyboard-nav targeting in TASK-404"
    verification: "grep -n 'data-approval-id\\|role=\"listitem\"' frontend/src/components/PendingApprovalCard.tsx returns matches"
depends_on:
  - TASK-401
  - TASK-402
estimated_complexity: medium
epic: review-queue-ui
test_strategy:
  needed: true
  justification: "Card has formatting logic (age, truncation), conditional rendering (rationale present/absent), and async button handlers — each needs verification"
  targets:
    - behavior: Renders all five context fields when fully populated
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
      type: component
    - behavior: Approve button click invokes approve mutation with correct id
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
      type: component
    - behavior: "Age formatter produces '2m' for 120s delta, '1h' for 3600s, '<1m' for <60s"
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
      type: unit
    - behavior: Payload preview truncation at ~200 chars
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx
      type: unit
---
# PendingApprovalCard with Full Approval Context

## Objective

Implement the `<PendingApprovalCard />` component (replacing the placeholder stub from TASK-402) with the full context UI: workflow name, tool name, payload preview, Claude's rationale, age, and Approve/Reject buttons. This is IDEA-009 slice 2 — "enough context for the user to approve confidently without reading raw payloads." Per user-needs research §4, the rationale + tool name + payload preview triad is the friction reducer that makes the 93%-rote-approval flow effortless.

## Implementation Steps

1. Create `frontend/src/utils/approvalFormatters.ts`:
   - Export `formatAge(createdAt: string): string` — returns `'<1m'` for <60s, `'Nm'` for <60min, `'Nh'` for <24h, `'Nd'` otherwise. Pure function.
   - Export `truncatePayload(payload: string, maxLen = 200): { text: string; truncated: boolean }` — slices the string, returns `truncated: true` when the original exceeded `maxLen`. Pure function.
2. Replace `frontend/src/components/PendingApprovalCard.tsx` (overwrite the stub from TASK-402) with full implementation:
   - Props: `{ approval: Approval }`.
   - Outer container: `<div data-approval-id={approval.id} role="listitem" className="px-4 py-3 border-b border-border-primary hover:bg-surface-hover focus-within:ring-2 focus-within:ring-accent-primary cursor-default">`.
   - Header row: workflow name + tool name + age (right-aligned). Workflow name in `text-xs text-text-muted`, tool name in `text-sm font-semibold text-text-primary` (e.g., "Bash", "Edit"), age as `<span class="ml-auto text-xs text-text-muted">{formatAge(approval.createdAt)}</span>`.
   - Rationale (conditional): if `approval.rationale` is non-null/non-empty, render `<p class="text-xs italic text-text-muted my-2">{approval.rationale}</p>`.
   - Payload preview: `<pre class="text-xs font-mono bg-bg-tertiary px-2 py-1 rounded overflow-hidden">{truncated.text}{truncated.truncated && '…'}</pre>`. Apply `truncatePayload(approval.payloadPreview)`.
   - Action row: two `<Button>` from `./ui/Button`: "Approve" (variant=primary) and "Reject" (variant=secondary). Wire `onClick` handlers that call `trpc.cyboflow.approvals.approve.mutate({ approvalId: approval.id })` and `.reject.mutate({ approvalId: approval.id })` respectively. Use the trpc client from `frontend/src/trpc/client.ts`.
   - Disable buttons while mutation is in flight (local `useState<boolean>` for the busy state).
3. Write component + unit tests in `frontend/src/components/__tests__/PendingApprovalCard.test.tsx`:
   - Full render with a fixture Approval → assert all five fields visible.
   - Render without rationale → assert no italic paragraph.
   - Click Approve → assert `trpc.cyboflow.approvals.approve.mutate` called with `{ approvalId: 'fixture-id' }`. Mock the trpc client.
   - Unit test `formatAge` directly: `Date.now() - 120000` → `'2m'`; `Date.now() - 3600000` → `'1h'`; `Date.now() - 30000` → `'<1m'`.
   - Unit test `truncatePayload`: input of 300 chars with `maxLen: 200` → `{ text: <200 chars>, truncated: true }`; input of 50 chars → `{ text: <50 chars>, truncated: false }`.

## Acceptance Criteria

- Five context fields rendered (workflow, tool, payload, rationale conditionally, age).
- Approve/Reject buttons invoke tRPC mutations.
- Age and payload-truncation utilities are pure and unit-tested.
- Card carries `data-approval-id` and `role="listitem"` for the keyboard-nav task.

## Test Strategy

Four tests as listed in `targets`. Mock the tRPC client by injecting a fake module. The age and truncate helpers are pure functions — direct unit tests, no mocking.

## Hardest Decision

**Where to put the formatters: in the component file or a separate utility module.** Separate module (`utils/approvalFormatters.ts`) wins because: (a) `formatAge` and `truncatePayload` are reused by the blocking-pin / collapsed-card logic in TASK-405, (b) unit-testing pure functions is cheaper than rendering a component, (c) splitting keeps the card component focused on layout.

## Rejected Alternatives

- **Tooltip-on-hover for full payload instead of truncate.** Rejected for v1 because keyboard-first triage (TASK-404) doesn't trigger hover; users would never see the full payload. A "show more" inline expansion is a v1.1 candidate.
- **Render syntax-highlighted code for bash/file-edit payloads.** Rejected as scope creep; the truncated `<pre>` is sufficient for the rote-approval flow.
- **Inline status (approving / approved / rejected) on the card.** Rejected because the card disappears from the queue on decision (handled by the subscription stream removing the approval). The transient busy-disable state is enough.

What would change my mind: if self-host shows users repeatedly trying to read past the 200-char truncation for shell commands, raise `maxLen` to 400 or add an expand button.

## Lowest Confidence Area

The exact rationale field semantics. System design §5.7 mentions "Claude's preceding rationale text" but the stream-parser side (out of this epic's scope) decides what gets stored in `approval.rationale`. If the field is empty for most approvals during self-host, the card will look bare. Consider a fallback like "(no rationale provided)" or hide the section entirely — current plan hides it. Adjust based on real data.
