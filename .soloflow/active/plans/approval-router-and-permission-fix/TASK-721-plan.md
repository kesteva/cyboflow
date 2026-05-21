---
id: TASK-721
idea: SPRINT-029-compound
status: ready
source_sprint: SPRINT-029
created: 2026-05-21T00:00:00Z
files_owned:
  - shared/utils/approvals.ts
  - main/src/index.ts
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/__tests__/sharedApprovalsUtils.test.ts
files_readonly:
  - shared/types/approvals.ts
  - main/tsconfig.json
  - frontend/tsconfig.json
  - .soloflow/active/findings/SPRINT-029-findings.md
  - .soloflow/active/compound/SPRINT-029-proposal.md
acceptance_criteria:
  - criterion: "New module shared/utils/approvals.ts exists exporting PAYLOAD_PREVIEW_MAX_LEN=512 (const literal) and truncatePayloadPreview(raw: string): string."
    verification: "test -f shared/utils/approvals.ts AND grep -nE 'export (const|function) (PAYLOAD_PREVIEW_MAX_LEN|truncatePayloadPreview)' shared/utils/approvals.ts | wc -l outputs at least 2 AND grep -n 'PAYLOAD_PREVIEW_MAX_LEN = 512' shared/utils/approvals.ts returns exactly 1 match."
  - criterion: "Bridge in main/src/index.ts calls truncatePayloadPreview, no more inline `512` literal in the truncation context."
    verification: "grep -n 'truncatePayloadPreview' main/src/index.ts returns at least 1 match AND grep -nE 'payloadJson\\.length > 512' main/src/index.ts returns 0 matches"
  - criterion: "listPending in main/src/orchestrator/trpc/routers/approvals.ts calls truncatePayloadPreview."
    verification: "grep -n 'truncatePayloadPreview' main/src/orchestrator/trpc/routers/approvals.ts returns at least 1 match AND grep -nE 'payloadPreviewRaw\\.length > 512' main/src/orchestrator/trpc/routers/approvals.ts returns 0 matches"
  - criterion: "Repo-wide: no production file outside shared/utils/approvals.ts references the bare 512 literal in a payloadPreview context."
    verification: "grep -rnE '(payloadJson|payloadPreviewRaw|payloadPreview)[^=]*\\b512\\b' main/src frontend/src shared --exclude-dir=__tests__ --exclude-dir=dist returns 0 matches"
  - criterion: "New vitest suite main/src/__tests__/sharedApprovalsUtils.test.ts pins 4 cases (constant=512; 512 passes through; 513 truncates to 512; empty string passes)."
    verification: "test -f main/src/__tests__/sharedApprovalsUtils.test.ts AND pnpm --filter main test sharedApprovalsUtils exits 0"
  - criterion: pnpm typecheck (main + frontend) + pnpm lint + pnpm --filter main test all exit 0.
    verification: "pnpm --filter main typecheck && pnpm --filter frontend typecheck && pnpm --filter main lint && pnpm --filter main test"
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "The point of the refactor is to lock the 512-char invariant in one place. Without a pinned unit test, a future change to the literal can silently re-introduce drift — exactly the FIND-SPRINT-029-9 class of bug. Boundary cases (512 vs 513) cannot be caught by typecheck."
  targets:
    - behavior: "PAYLOAD_PREVIEW_MAX_LEN is exactly 512"
      test_file: main/src/__tests__/sharedApprovalsUtils.test.ts
      type: unit
    - behavior: "truncatePayloadPreview returns input unchanged when length === 512"
      test_file: main/src/__tests__/sharedApprovalsUtils.test.ts
      type: unit
    - behavior: "truncatePayloadPreview truncates to 512 chars when length === 513"
      test_file: main/src/__tests__/sharedApprovalsUtils.test.ts
      type: unit
    - behavior: "truncatePayloadPreview returns empty string unchanged"
      test_file: main/src/__tests__/sharedApprovalsUtils.test.ts
      type: unit
---

# Extract shared truncatePayloadPreview helper + PAYLOAD_PREVIEW_MAX_LEN constant

## Objective

Eliminate the cross-task data-drift risk in FIND-SPRINT-029-9 by replacing the two independent 512-char truncation expressions (main/src/index.ts:706-714 SSE bridge from TASK-694, and main/src/orchestrator/trpc/routers/approvals.ts:85-87 listPending from TASK-706) with a single named helper exported from shared/utils/approvals.ts.

## Implementation Steps

1. **Create shared/utils/approvals.ts** (new file, runtime-pure, no imports):
   ```ts
   /** Pure runtime utility sibling of shared/types/approvals.ts. NO imports — leaf module. */
   export const PAYLOAD_PREVIEW_MAX_LEN = 512;
   export function truncatePayloadPreview(raw: string): string {
     return raw.length > PAYLOAD_PREVIEW_MAX_LEN ? raw.slice(0, PAYLOAD_PREVIEW_MAX_LEN) : raw;
   }
   ```

2. **Update main/src/index.ts**: add `import { truncatePayloadPreview } from '../../shared/utils/approvals';`. Replace inline ternary with `payloadPreview: truncatePayloadPreview(payloadJson),`.

3. **Update main/src/orchestrator/trpc/routers/approvals.ts**: add the same import (relative depth `../../../../../shared/utils/approvals`). Replace inline ternary with `payloadPreview: truncatePayloadPreview(row.payloadPreviewRaw),`.

4. **Create main/src/__tests__/sharedApprovalsUtils.test.ts** with 4 cases pinning the constant + boundary behavior (512 passes, 513 truncates, empty passes).

5. Run `pnpm --filter main typecheck && pnpm --filter frontend typecheck && pnpm --filter main lint && pnpm --filter main test`.

6. Final sweep: `grep -rnE '(payloadJson|payloadPreviewRaw|payloadPreview)[^=]*\b512\b' main/src frontend/src shared --exclude-dir=__tests__` returns 0.

## Hardest Decision

shared/utils/approvals.ts (new file) vs extending shared/types/approvals.ts. Chose new file: the type module's header explicitly says "NO runtime imports"; adding runtime exports violates that invariant. New sibling preserves both invariants at the cost of one file.

## Rejected Alternatives

- Put helper in shared/types/approvals.ts: violates "NO runtime imports" invariant.
- Put in main/src/orchestrator/payloadPreview.ts: closes the door on frontend reusing the constant.
- Inline constant, extract only function: duplication is half of what FIND-029-9 calls out.
- Skip unit test, rely on integration: doesn't catch off-by-one (`>` vs `>=`).

## Coordination with TASK-720 (B3)

TASK-720 (workflowName fix) lands first; its helper inlines its own 512 constant. After TASK-721 lands, TASK-720's helper is updated to import truncatePayloadPreview/PAYLOAD_PREVIEW_MAX_LEN from shared/utils/approvals.ts.

## Lowest Confidence Area

The completeness-sweep grep assumes no other production file currently uses `512` literal in a payloadPreview context. Step 1's grep confirms exactly two hits at plan time. If another task lands first, executor must add that file to files_owned.
