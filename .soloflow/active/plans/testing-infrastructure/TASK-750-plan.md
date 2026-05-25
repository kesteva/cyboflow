---
id: TASK-750
idea: SPRINT-036-compound
status: in-flight
created: "2026-05-24T00:00:00Z"
files_owned:
  - frontend/src/utils/trpcClient.ts
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/stores/mcpHealthStore.ts
  - frontend/src/stores/reviewQueueSlice.ts
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/components/ReviewQueue/StuckInspectorModal.tsx
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - frontend/src/hooks/useReviewQueueKeyboard.ts
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - frontend/src/trpc/client.ts
  - frontend/src/test/setup.ts
  - frontend/src/stores/__tests__/reviewQueueStore.test.ts
  - docs/CODE-PATTERNS.md
  - docs/ARCHITECTURE.md
  - docs/ARCHITECTURE-diagram.md
files_readonly:
  - .soloflow/archive/done/testing-infrastructure/TASK-741-done.md
  - .soloflow/active/compound/SPRINT-036-proposal.md
  - CLAUDE.md
acceptance_criteria:
  - criterion: The shim file frontend/src/utils/trpcClient.ts is deleted.
    verification: "test ! -e frontend/src/utils/trpcClient.ts"
  - criterion: "No file under frontend/src imports from '../utils/trpcClient' or any depth-variant relative path of it."
    verification: "grep -rnE \"from ['\\\"][.][./]*utils/trpcClient['\\\"]\" frontend/src --include='*.ts' --include='*.tsx' returns 0 matches (exit code 1)."
  - criterion: "No remaining renderer-source reference to the string 'utils/trpcClient' in import, mock, or doc-comment form."
    verification: "grep -rn 'utils/trpcClient' frontend/src returns 0 matches (exit code 1)."
  - criterion: "Canonical-client JSDoc and stale path comments are scrubbed across frontend/src/trpc/client.ts, frontend/src/test/setup.ts, and frontend/src/stores/__tests__/reviewQueueStore.test.ts."
    verification: "grep -n 'utils/trpcClient' frontend/src/trpc/client.ts frontend/src/test/setup.ts frontend/src/stores/__tests__/reviewQueueStore.test.ts returns 0 matches."
  - criterion: "Docs (CODE-PATTERNS.md, ARCHITECTURE.md, ARCHITECTURE-diagram.md) reflect frontend/src/trpc/client.ts as the canonical tRPC client path with no stale references."
    verification: "grep -n 'utils/trpcClient' docs/CODE-PATTERNS.md docs/ARCHITECTURE.md docs/ARCHITECTURE-diagram.md returns 0 matches."
  - criterion: Frontend vitest suite is green after the migration.
    verification: "pnpm --filter frontend test exits 0; passing count >= 322."
  - criterion: Typecheck and lint pass across all workspaces.
    verification: pnpm typecheck exits 0; pnpm lint exits 0.
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "Pure import-path / re-export refactor. The shim's only export is `{ trpc }`, which is identical to the canonical export from frontend/src/trpc/client.ts. TASK-741 already canonicalized every sibling vitest spec's mock target to '../…/trpc/client', so the import-path swap in the SUTs leaves the mock target untouched. Running the existing frontend vitest suite is the regression gate; no new test cases would meaningfully exercise behavior already covered by the 322 passing tests."
prerequisites: []
---
# Delete `utils/trpcClient` shim and migrate production importers to canonical `trpc/client`

## Objective

Eliminate the backwards-compat re-export at `frontend/src/utils/trpcClient.ts` so the renderer has a single, canonical tRPC client path at `frontend/src/trpc/client.ts`. TASK-741 swept the 10 test-side `vi.mock` targets to the canonical path; this task finishes the migration by updating 8 production callers + 1 lingering test-file value-import, deleting the shim, and refreshing 3 doc files plus the JSDoc/comment references in `trpc/client.ts`, `test/setup.ts`, and `reviewQueueStore.test.ts`. The shim's only binding is `export { trpc } from '../trpc/client'`, so the change is behavior-preserving by construction.

## Implementation Steps

1. **Completeness gate — pre-flight grep.** Run both greps now; you'll re-run them at the end:
   ```
   grep -rnE "from ['\"][.][./]*utils/trpcClient['\"]" frontend/src --include='*.ts' --include='*.tsx'
   grep -rn 'utils/trpcClient' frontend/src docs
   ```
   The first grep MUST return exactly the 9 caller lines listed below. The second additionally surfaces JSDoc/comment references that must be cleared.

2. **Migrate the 8 production callers.** Replace each import line — preserve path depth:

   | File | Current → New (suffix-only) |
   |---|---|
   | `frontend/src/components/DraggableProjectTreeView.tsx:10` | `'../utils/trpcClient'` → `'../trpc/client'` |
   | `frontend/src/stores/mcpHealthStore.ts:38` | `'../utils/trpcClient'` → `'../trpc/client'` |
   | `frontend/src/stores/reviewQueueSlice.ts:34` | `'../utils/trpcClient'` → `'../trpc/client'` |
   | `frontend/src/stores/reviewQueueStore.ts:29` | `'../utils/trpcClient'` → `'../trpc/client'` |
   | `frontend/src/hooks/useReviewQueueKeyboard.ts:2` | `'../utils/trpcClient'` → `'../trpc/client'` |
   | `frontend/src/components/cyboflow/WorkflowPicker.tsx:10` | `'../../utils/trpcClient'` → `'../../trpc/client'` |
   | `frontend/src/components/ReviewQueue/StuckInspectorModal.tsx:17` | `'../../utils/trpcClient'` → `'../../trpc/client'` |
   | `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx:19` | `'../../utils/trpcClient'` → `'../../trpc/client'` |

3. **Migrate the lingering value-import in tests.** `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx:92` still imports the `trpc` binding through the shim. Update to `'../../../trpc/client'`. Line 32 of the same file already mocks the canonical path (TASK-741), so the new import resolves to the existing mock.

4. **Refresh the JSDoc in `frontend/src/trpc/client.ts`** (around lines 23-29). Remove both references to the shim — only document the canonical import.

5. **Update the stale comment in `frontend/src/test/setup.ts`** (lines 6-11): change `vi.mock('…/trpcClient')` → `vi.mock('…/trpc/client')`.

6. **Update the stale comment in `frontend/src/stores/__tests__/reviewQueueStore.test.ts`** (lines 23-26): rewrite the four-line block to describe the canonical path; the existing `vi.mock('../../trpc/client', …)` factory on line 27 stays.

7. **Delete the shim:** `rm frontend/src/utils/trpcClient.ts`.

8. **Update `docs/CODE-PATTERNS.md`** — retitle the `frontend/src/utils/trpcClient` block (lines 78-83) to `frontend/src/trpc/client` and adjust the path; update the in-line example specifier on line 362 from `'../../utils/trpcClient'` to `'../../trpc/client'`.

9. **Update `docs/ARCHITECTURE.md`** (lines 165-178): replace `utils/trpcClient.ts` references with `trpc/client.ts`.

10. **Update `docs/ARCHITECTURE-diagram.md`** line 34: change the mermaid node label `TrpcClient[utils/trpcClient.ts…]` to `TrpcClient[trpc/client.ts…]`.

11. **Re-run the completeness greps** (step 1) — both must exit 1 with zero output. Also verify `test ! -e frontend/src/utils/trpcClient.ts`.

12. **Run AC gates:** `pnpm --filter frontend test` (≥ 322 pass), `pnpm typecheck` (0), `pnpm lint` (0).

## Acceptance Criteria

See frontmatter.

## Test Strategy

No new tests. Pure import-path swap of a single re-export. TASK-741 already canonicalized every sibling vitest mock target, so the existing 322 tests exercise the post-migration code path with zero modification. The frontend vitest suite is the regression gate.

## Hardest Decision

**Include doc/JSDoc/comment refresh in the same task, or split?** Folded in because (a) the doc edits are mechanical string replacements with zero behavioral risk, (b) leaving them stale guarantees the shim re-emerges in a future sprint (this exact regression already happened — see SPRINT-010 finding and SPRINT-011 proposal), and (c) keeping documentation invariants in lockstep with the deletion is the entire point of the cleanup.

## Rejected Alternatives

- **Keep the shim, update docs only.** Rejected — the canonical-vs-shim split has caused recurring confusion across multiple sprints. The reverse-shim was already flipped once. Flipping the documented canonical path without deleting the dangling shim creates the current mess.
- **Delete the shim, defer the doc cleanup.** Rejected — AC3 (zero `utils/trpcClient` references in `frontend/src`) requires touching the JSDoc + test setup comment anyway.
- **Replace the shim with a runtime `throw`.** Rejected — typecheck catches missed imports; runtime throw adds zero safety in a typed codebase.

## Lowest Confidence Area

`CyboflowRoot.test.tsx` is the only spec where this task simultaneously edits an import and indirectly affects the mocked `trpc` binding. If some test-file ordering issue exists where the existing `vi.mock('…/trpc/client', …)` factory relies on a shim-side-effect, the spec could regress. Mitigation: AC7 (frontend test run) is the gate; revert is the fallback.
