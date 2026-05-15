---
id: TASK-402
sprint: SPRINT-010
epic: review-queue-ui
status: done
summary: "ReviewQueueView shell + always-visible 360px left rail in App.tsx wrapped in ErrorBoundary with queue-specific 'Review queue error — restart app' fallback; vitest + jsdom + RTL test scaffolding"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-402 — Done

## What landed

- **`frontend/src/components/ReviewQueueView.tsx`** — 360px left-rail shell. Subscribes via Zustand selector; `init()` once on mount; empty state "No pending approvals"; renders `<PendingApprovalCard>` per item.
- **`frontend/src/components/ErrorBoundary.tsx`** — widened `fallback` signature to accept `errorInfo: React.ErrorInfo | null`; removed null guard so custom fallback fires on first render after a throw (legitimate bug fix — `getDerivedStateFromError` runs before `componentDidCatch`).
- **`frontend/src/App.tsx`** — mounted `<ErrorBoundary fallback=...><ReviewQueueView /></ErrorBoundary>` before existing `<Sidebar />` in the root flex container.
- **`frontend/vite.config.ts`** — added vitest config (jsdom).
- **`frontend/package.json`** — `test` and `test:watch` scripts + devDependencies (vitest, @vitest/ui, jsdom, @testing-library/{react,dom,jest-dom,user-event}).
- **`frontend/src/test/setup.ts`** — vitest global setup importing jest-dom matchers.
- **`frontend/src/components/__tests__/ReviewQueueView.test.tsx`** — 8 component tests (empty state, init-once, populated render, ErrorBoundary fallback, header text, pending count, populated negative-empty assertion).

## PARALLEL-STUB files (overwritten at merge by canonical owners)

- `shared/types/approvals.ts` (owned by TASK-401)
- `frontend/src/stores/reviewQueueStore.ts` (owned by TASK-401)
- `frontend/src/components/PendingApprovalCard.tsx` (owned by TASK-403)

All three carry `PARALLEL-STUB:` marker at line 1.

## Verification

- pnpm test: PASS 8/8
- pnpm typecheck: clean across all workspaces
- pnpm lint: 0 errors (303 pre-existing warnings unrelated)

## Visual

Skipped per parallel-mode protocol. Sprint-level verification will exercise the left-rail visually.
