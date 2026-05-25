---
id: TASK-741
sprint: SPRINT-036
epic: testing-infrastructure
status: done
summary: "Canonicalize tRPC mock target across 10 renderer test files (shim → canonical)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-741 — Done

## Summary
Pure literal-text sweep: swapped `vi.mock('…/utils/trpcClient', …)` → `vi.mock('…/trpc/client', …)` in 10 renderer test files (per-file path-depth correction per the plan's table). Factory bodies preserved verbatim. The shim at `frontend/src/utils/trpcClient.ts` is intentionally left intact for a separate production-side follow-up task.

## Verification
- `pnpm --filter frontend test` → 322/322 pass.
- AC1: 0 hits for `utils/trpcClient` mocks.
- AC2: 12 hits for `trpc/client` mocks (10 swept + setup.ts + CyboflowRoot.test.tsx).
- AC3: Shim file unchanged (`export { trpc } from '../trpc/client';`).
- AC4: Frontend test suite green.
- AC5: Diff scope: only the 10 owned test files.
- Visual verification: not_applicable — test-file refactor.

## Code Review
CLEAN. Behavior-preserving by construction — canonical export `{ trpc }` matches the shim's single binding.

## Commit
- `a34f65e` — `refactor(TASK-741): canonicalize tRPC mock target from utils/trpcClient shim to trpc/client`
