---
sprint: SPRINT-010
pending_count: 9
last_updated: "2026-05-15T15:35:00.000Z"
---
# Findings Queue

## FIND-SPRINT-010-1
- **type:** scope_deviation
- **source:** TASK-403 (executor)
- **severity:** low
- **status:** open
- **location:** shared/types/approvals.ts
- **description:** Created parallel-execution stub (TASK-401 owns canonical version). Required to make PendingApprovalCard typecheck in the isolated worktree per orchestrator instructions in TASK-403-plan.md. Stub is overwritten at merge by TASK-401.
- **resolved_by:** 

## FIND-SPRINT-010-2
- **type:** scope_deviation
- **source:** TASK-403 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/src/trpc/client.ts
- **description:** Created parallel-execution stub (TASK-401 owns canonical version). Required to make PendingApprovalCard typecheck in the isolated worktree per orchestrator instructions in TASK-403-plan.md. Stub is overwritten at merge by TASK-401.
- **resolved_by:** 

## FIND-SPRINT-010-3
- **type:** improvement
- **source:** TASK-403 (executor)
- **severity:** low
- **status:** open
- **location:** frontend/package.json
- **description:** The frontend package has no vitest config or devDependencies. migrateLocalStorageKey.test.ts and PendingApprovalCard.test.tsx both exist in frontend/src but cannot be run via pnpm test or any configured script. A follow-up task should add vitest + @testing-library/react + jsdom to frontend devDependencies and create frontend/vitest.config.ts. PendingApprovalCard.test.tsx is written ready for DOM tests once jsdom is available.
- **suggested_action:** Add vitest + @testing-library/react + jsdom to frontend devDependencies; create frontend/vitest.config.ts with jsdom environment; add test script to frontend/package.json
- **resolved_by:** 

## FIND-SPRINT-010-4
- **source:** TASK-402 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** frontend/src/stores/reviewQueueStore.ts (canonical impl owned by TASK-401)
- **description:** ReviewQueueView calls `useReviewQueueStore.getState().init()` inside a useEffect with empty deps. React 19 + StrictMode (enabled in frontend/src/main.tsx) double-invokes mount effects in development, so `init` will fire twice. The TASK-402 plan AC "init called exactly once on mount" is satisfied per-mount, but the TASK-401 canonical `init` implementation MUST be idempotent (safe to call N times — no duplicate IPC subscriptions, no duplicate fetches, no duplicate event listeners). Otherwise dev builds will show doubled state or leaked subscriptions.
- **suggested_action:** When TASK-401 lands the canonical reviewQueueStore.init(), guard against re-entry (e.g. an `initialized` flag in store state, or idempotent .on/.off teardown). Add a comment in init's body noting StrictMode contract.
- **resolved_by:** 

## FIND-SPRINT-010-5
- **source:** TASK-401 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** vitest.config.frontend.ts:3-7,25
- **description:** The header docstring claims the suite "can run in a jsdom/happy-dom browser-like environment" but the config sets `environment: 'node'`. The contradiction will mislead the next executor who tries to add a DOM-touching test under this config. Either change to a DOM environment when one is added (and add the dep), or rewrite the docstring to say "node environment for pure-function tests only".
- **suggested_action:** Update the docstring to match the actual `node` environment, OR plan a follow-up to add jsdom and switch the environment (ties into FIND-SPRINT-010-3).
- **resolved_by:** 

## FIND-SPRINT-010-6
- **source:** TASK-401 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/__tests__/reviewQueueStore.test.ts:90-94
- **description:** The test `pureReplaceAll > 'returns a new array even when items are identical'` asserts `expect(result).not.toBe([A])`. The right-hand side `[A]` is a freshly-allocated array literal, so this assertion is tautologically true regardless of what `pureReplaceAll` returns — it can never fail. The test name implies "reference inequality between input and output" which would require comparing `result` against the original input array, not a fresh literal.
- **suggested_action:** Change to `const replacement = [A]; const result = pureReplaceAll([], replacement); expect(result).not.toBe(replacement);` or drop the assertion.
- **resolved_by:** 

## FIND-SPRINT-010-7
- **source:** TASK-401 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/reviewQueueStore.ts:140
- **description:** `replaceAll(items as Approval[])` — the `as Approval[]` cast is redundant. The orchestrator `listPending` procedure explicitly returns `Promise<Approval[]>`, so `items` is already typed `Approval[]` via tRPC inference. The cast silently masks future drift (e.g. if the procedure return type changes to something else, the cast would hide the error rather than surface it).
- **suggested_action:** Remove the cast: `replaceAll(items);`. If a cast is intentional (e.g. because the procedure's inferred type is wider than `Approval[]`), add a one-line comment explaining why.
- **resolved_by:** 

## FIND-SPRINT-010-8
- **source:** TASK-401 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/events.ts:74-115
- **description:** `eventToAsyncIterable` reinvents Node's built-in `events.on(emitter, eventName, { signal })` (Node ≥18, fully supported on cyboflow's Node 22). The custom impl is ~40 lines with a manual queue/promise dance; the built-in equivalent is one line that yields `unknown[]` (argument tuples) and respects the AbortSignal natively. Worth swapping for less surface area to test/maintain, especially since this helper is used twice in this file.
- **suggested_action:** Replace the body with `for await (const [payload] of events.on(emitter, eventName, { signal })) { yield payload as T; }` and delete the helper. Verify behavior under abort: `events.on` throws `AbortError` on abort, which the async-generator should catch-and-return cleanly.
- **resolved_by:** 

## FIND-SPRINT-010-9
- **source:** TASK-401 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** package.json:60-61
- **description:** Plan AC6 requires "pinned versions" of `@trpc/server`/`@trpc/client` to ensure the v11 subscription leak fix (PR #6161) is present. The package.json uses range `>=11.0.0 <12.0.0`, not a pin. The pnpm lockfile currently resolves to 11.17.0 (well past the fix), so this is functionally fine TODAY, but a fresh install in a different env or after a `pnpm install --force` without lockfile could pull an earlier 11.x. Tightening to `^11.17.0` or exact `11.17.0` would honor AC6 more defensibly.
- **suggested_action:** Change `"@trpc/server": ">=11.0.0 <12.0.0"` and `"@trpc/client": ">=11.0.0 <12.0.0"` to `"^11.17.0"` (or exact `"11.17.0"` for true pinning). Note: this changes only the manifest range, not the resolved version.
- **resolved_by:** 
