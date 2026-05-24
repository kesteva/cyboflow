---
id: TASK-741
idea: SPRINT-035-compound
status: in-flight
created: "2026-05-23T12:00:00Z"
files_owned:
  - frontend/src/stores/__tests__/reviewQueueSlice.test.ts
  - frontend/src/stores/__tests__/reviewQueueStore.test.ts
  - frontend/src/stores/__tests__/mcpHealthStore.test.ts
  - frontend/src/components/OnboardingCard.test.tsx
  - frontend/src/components/ReviewQueue/__tests__/StuckInspectorModal.test.tsx
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
  - frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
  - frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx
  - frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
  - frontend/src/hooks/__tests__/useStuckNotifications.test.ts
files_readonly:
  - frontend/src/trpc/client.ts
  - frontend/src/utils/trpcClient.ts
  - frontend/src/test/setup.ts
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
acceptance_criteria:
  - criterion: All 10 owned files mock the canonical `…/trpc/client` path (NOT the `…/utils/trpcClient` shim).
    verification: "grep -rnE \"vi\\.mock\\(['\\\"][^'\\\"]*utils/trpcClient['\\\"]\" frontend/src --include='*.ts' --include='*.tsx' returns 0 hits"
  - criterion: "Each owned file contains a `vi.mock('…/trpc/client', ...)` call at the correct relative-path depth."
    verification: "grep -rnE \"vi\\.mock\\(['\\\"][^'\\\"]*trpc/client['\\\"]\" frontend/src --include='*.ts' --include='*.tsx' shows at least 11 hits (10 owned files + the existing global setup.ts and CyboflowRoot.test.tsx)"
  - criterion: The shim at `frontend/src/utils/trpcClient.ts` is unchanged (file presence preserved for backwards compatibility).
    verification: "test -f frontend/src/utils/trpcClient.ts && grep -n \"export { trpc } from '../trpc/client'\" frontend/src/utils/trpcClient.ts shows the single re-export line unchanged"
  - criterion: "`pnpm --filter frontend test` exits 0 with all renderer tests passing."
    verification: pnpm --filter frontend test exits with code 0; vitest summary shows the 10 owned files passing
  - criterion: Production renderer code that imports `trpc` from `utils/trpcClient` is NOT modified (this task is test-only).
    verification: "git diff --name-only after the task touches only files under frontend/src/**/__tests__/ AND frontend/src/components/OnboardingCard.test.tsx — no non-test renderer files appear in the diff"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "This task IS a sweep across 10 existing test files — each file's behavior is preserved (the vi.mock factory shape is unchanged, only the mock target string moves from the shim path to the canonical path). Success is measured by `pnpm --filter frontend test` exiting 0 (the existing assertions in all 10 files validate the swap end-to-end). No new tests need to be authored; no behavior added. Sibling-test scan was performed for each owned file's parent directory — every match is itself one of the owned files; no neighbor depends on the local mock target."
---
# Canonicalize tRPC mock target across 9 renderer test files

## Objective

The canonical tRPC client lives at `frontend/src/trpc/client.ts`; the shim at `frontend/src/utils/trpcClient.ts` is a single-binding `export { trpc } from '../trpc/client';`. The global test setup (`frontend/src/test/setup.ts:13`) and the post-SPRINT-035 `CyboflowRoot.test.tsx:32` both mock the canonical path. **10** renderer test files mock the shim instead. Today the divergence is harmless (the shim is a pure re-export), but the day the shim grows logic, the patterns diverge and one set of tests stops seeing the modified surface. This task sweeps all 10 files to the canonical mock target.

Note on count: the compound proposal listed 9 files, but `reviewQueueStore.test.ts:27` and `reviewQueueSlice.test.ts:25` are both in the proposal — that's 10 distinct files. All 10 are listed in `files_owned` and verified by `grep -rnE "vi\\.mock\\(['\"][^'\"]*utils/trpcClient['\"]" frontend/src` pre-flight (run at refinement time, returned exactly 10 matches).

## Implementation Steps

1. **Pre-flight grep — confirm the file list is exhaustive and current.** Run as step 1 of the executor's work:
   ```
   grep -rnE "vi\.mock\(['\"][^'\"]*utils/trpcClient['\"]" frontend/src --include='*.ts' --include='*.tsx'
   ```
   Every matching file path MUST appear in `files_owned`. If any new match has been introduced since this plan was authored, ADD it to the sweep (and surface as a finding so the plan can be amended) — do not silently skip.

2. **For each owned file, perform a literal-text rewrite.** The mock target string lives inside a `vi.mock('…relative-path…', ...)` call. The shim's path always ends in `utils/trpcClient`; replace it with `trpc/client` adjusting the relative-depth segment count. Use the per-file table below as the authoritative mapping (already validated against current file locations):

   | File | Current target | New target |
   |---|---|---|
   | `frontend/src/stores/__tests__/reviewQueueSlice.test.ts` | `'../../utils/trpcClient'` | `'../../trpc/client'` |
   | `frontend/src/stores/__tests__/reviewQueueStore.test.ts` | `'../../utils/trpcClient'` | `'../../trpc/client'` |
   | `frontend/src/stores/__tests__/mcpHealthStore.test.ts` | `'../../utils/trpcClient'` | `'../../trpc/client'` |
   | `frontend/src/components/OnboardingCard.test.tsx` | `'../utils/trpcClient'` | `'../trpc/client'` |
   | `frontend/src/components/ReviewQueue/__tests__/StuckInspectorModal.test.tsx` | `'../../../utils/trpcClient'` | `'../../../trpc/client'` |
   | `frontend/src/components/__tests__/ReviewQueueView.test.tsx` | `'../../utils/trpcClient'` | `'../../trpc/client'` |
   | `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx` | `'../../../utils/trpcClient'` | `'../../../trpc/client'` |
   | `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx` | `'../../utils/trpcClient'` | `'../../trpc/client'` |
   | `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts` | `'../../utils/trpcClient'` | `'../../trpc/client'` |
   | `frontend/src/hooks/__tests__/useStuckNotifications.test.ts` | `'../../utils/trpcClient'` | `'../../trpc/client'` |

   Replace ONLY the literal string inside the `vi.mock(...)` first argument. Do NOT alter the factory function (second argument) or any other part of the test. The mocks today return `{ trpc: { ... } }` and that shape is identical to what `trpc/client.ts` actually exports — no factory shape change needed.

3. **Do NOT modify production code.** `frontend/src/utils/trpcClient.ts` stays intact (the shim is still imported by production code; sweeping production callers is explicitly out of scope per the proposal — this task is the test-side canonicalization only).

4. **Run the renderer suite:** `pnpm --filter frontend test`. Must exit 0. The 10 sweep targets are exercised; if any test fails after the sweep, the most likely cause is a factory-shape regression where the mock factory's `trpc` shape is stricter than `trpc/client`'s actual export (since `trpc/client` re-exports through `createTRPCProxyClient`, both old and new mock paths produce the same effective `trpc` symbol — failures here indicate a stale factory in the test file, not a sweep problem; surface as a finding).

5. **Post-sweep verification — gate before reporting COMPLETED:**
   - `grep -rnE "vi\\.mock\\(['\"][^'\"]*utils/trpcClient['\"]" frontend/src --include='*.ts' --include='*.tsx'` → must return 0 hits.
   - `git diff --name-only` → must only list files in `frontend/src/**/__tests__/` plus `frontend/src/components/OnboardingCard.test.tsx`. Any non-test file in the diff is a scope deviation.

## Acceptance Criteria

- 0 `vi.mock('…/utils/trpcClient', …)` calls remain in `frontend/src`.
- All 10 owned files mock `'…/trpc/client'` at the correct relative depth.
- The shim file at `frontend/src/utils/trpcClient.ts` is unchanged.
- `pnpm --filter frontend test` exits 0.
- Diff scope: test files only.

## Test Strategy

Pure mechanical sweep. The factory body inside each `vi.mock(...)` is preserved verbatim — only the import-specifier string changes. The 10 files' own existing assertions are the regression check (a successful `pnpm --filter frontend test` proves the swap is behavior-preserving).

## Hardest Decision

**Sweep the 10 mocks OR delete the shim and update both prod and test callers in one task.** The proposal listed both. Chose sweep-only because: (1) deleting the shim requires touching production renderer code (`grep -rn "from .*utils/trpcClient" frontend/src --include='*.ts' --include='*.tsx'` likely turns up ~5-15 prod call sites), expanding the task's blast radius; (2) the canonical-mock change alone closes the divergence-on-day-the-shim-grows-logic risk that motivates the work; (3) shim deletion is a clean second task that can land independently with full test coverage already in canonical position.

## Rejected Alternatives

- **Delete the shim and sweep all callers (prod + test) in one task.** Rejected — broader surface, slower review, no incremental risk-reduction. Would reconsider as a follow-up task with `depends_on: [TASK-741]`.
- **Modify the shim to no longer be a pure re-export (preserve `vi.mock('…/utils/trpcClient', ...)` semantics).** Rejected — opposite of the goal; cements the divergence.
- **Sweep production callers but leave tests on the shim.** Rejected — the divergence-when-shim-grows risk runs both directions; the failure mode the proposal targets is specifically test-side, so test-side is the right fix.

## Lowest Confidence Area

Whether any of the 10 files have a factory body whose mock shape diverges from `trpc/client`'s actual exports in a way that the shim's pure re-export accidentally masked. Concretely: if a test mocks `vi.mock('…/utils/trpcClient', () => ({ trpc: { somethingNotOnTheCanonical: vi.fn() } }))`, swapping to canonical does NOT change the runtime behavior (the mock still satisfies the `import { trpc } from '…'` site), but if a TypeScript-level shape check ever runs against the mocked module, the divergence surfaces. Risk is low because `vi.mock` factories are not type-checked by default, but the executor should treat any post-sweep test failure as a signal to inspect that file's factory shape against the canonical export.
