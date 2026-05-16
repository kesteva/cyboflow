---
id: TASK-401
sprint: SPRINT-010
epic: review-queue-ui
status: done
summary: "tRPC v11 foundation: cyboflow.approvals + cyboflow.events routers wired into orchestrator appRouter; reviewQueueStore (Zustand) with full-state resync; shared Approval types; vitest config for frontend"
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-401 — Done

## What landed

- **`shared/types/approvals.ts`** — `Approval`, `ApprovalCreatedEvent`, `ApprovalDecidedEvent` interfaces for the wire contract.
- **`main/src/orchestrator/trpc/routers/approvals.ts`** — replaced `throwNotImplemented` stubs with working `listPending` (returns `[]` + warn when table absent), `approve`, `reject` (stub-success).
- **`main/src/orchestrator/trpc/routers/events.ts`** — replaced placeholder iterators with `EventEmitter`-backed `onApprovalCreated`/`onApprovalDecided` subscriptions; exports `approvalEvents` emitter for the future ApprovalRouter epic.
- **`main/src/trpc/{index.ts,context.ts}`** — re-export points for the canonical orchestrator tRPC tree.
- **`frontend/src/trpc/client.ts`** — re-exports `trpc` singleton from `utils/trpcClient`.
- **`frontend/src/stores/reviewQueueStore.ts`** — Zustand store: `queue: Approval[]`, `connectionStatus`, idempotent `addApproval`, no-op-safe `removeApproval`, atomic `replaceAll`, full-state resync `init()` (listPending → replaceAll → subscribe).
- **`frontend/src/stores/__tests__/reviewQueueStore.test.ts`** — 13 unit tests covering the three pure reducers.
- **`vitest.config.frontend.ts`** — claimed via claim-file.js (frontend workspace had no vitest config).
- **`package.json`** — added `test:unit:frontend` script.
- **DELETED:** `main/src/trpc/routers/{approvals,events,cyboflow}.ts` (orphaned tree removed in retry).

## Verification

- pnpm typecheck: PASS (frontend, shared, main)
- pnpm test:unit:frontend: PASS 17/17

## Open findings

- FIND-SPRINT-010-3 (executor improvement: jsdom setup) — resolved by TASK-402 sibling work.
- FIND-SPRINT-010-4 (StrictMode init re-entry — subscription leak under dev double-mount) — deferred follow-up.
- FIND-SPRINT-010-5..9 (5 minor code-review cleanups: vitest config docstring, tautological assertion, redundant cast, custom `eventToAsyncIterable` reinvents `events.on`, version range vs pin) — deferred follow-up.

## Visual

Skipped per parallel-mode protocol (`VISUAL_VERIFY: skip`). Sprint-level verification will run in Step 3.5.
