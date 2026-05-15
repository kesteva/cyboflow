---
sprint: SPRINT-010
pending_count: 12
last_updated: "2026-05-15T18:16:25.660Z"
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

## FIND-SPRINT-010-10
- **type:** scope_deviation
- **source:** TASK-404 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/__tests__/ReviewQueueView.test.tsx
- **description:** Claimed to fix test breakage caused by ReviewQueueView.tsx importing the new useReviewQueueKeyboard hook. The test did not mock the hook, causing trpc-electron initialization error. Required to keep the suite green after the ReviewQueueView change.
- **resolved_by:** verifier — plan-prescribed: TASK-404-plan.md files_owned line 11 lists frontend/src/components/__tests__/ReviewQueueView.test.tsx; not actually a deviation. Also AC-prescribed: keeping the existing suite green is required by the test-strategy baseline.

## FIND-SPRINT-010-11
- **type:** bug
- **source:** TASK-404 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/__tests__/PendingApprovalCard.test.tsx:19
- **description:** Pre-existing TypeScript error: baseApproval fixture is missing required Approval fields runId and status. Discovered during TASK-404 typecheck run. File is owned by TASK-406 which should fix this fixture.
- **suggested_action:** Update baseApproval to include runId: string and status: pending|approved|rejected|expired fields matching the Approval interface in shared/types/approvals.ts
- **resolved_by:** verifier — status-sync: TASK-404 (commit d208b10 added runId: 'run-fixture-id' and status: 'pending' to baseApproval fixture; typecheck now passes). AC-prescribed: pnpm typecheck must pass as ground-truth, and TASK-404 modified PendingApprovalCard.tsx which is the SUT for this test file.

## FIND-SPRINT-010-12
- **type:** improvement
- **source:** TASK-404 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useReviewQueueKeyboard.ts:55-90
- **description:** The y/n branches use `setFocusedIndex(currentIndex => { ...; return currentIndex; })` to read the current focusedIndex from the closure-captured queue without changing state. This abuses the functional-setState API as a state-read primitive — React will still enqueue a state update and run the Object.is bail-out check. The 5-line inline justification comment exists because the pattern is non-obvious. The standard idiom is a ref synced via effect (`const indexRef = useRef(focusedIndex); useEffect(() => { indexRef.current = focusedIndex; }, [focusedIndex]);`) which is briefer, intent-revealing, and avoids the no-op enqueue. Same scope: the keydown effect re-binds the window listener on every queue mutation because `queue` is in its dep array — pinning queue in a ref and using `[]` for the listener effect would be cleaner.
- **suggested_action:** Refactor to use refs for both focusedIndex (so y/n can read it directly) and queue (so the listener registers once per mount). Drop the in-branch explanatory comment when the code becomes self-documenting.
- **resolved_by:** 

## FIND-SPRINT-010-13
- **type:** scope_deviation
- **source:** TASK-405 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/hooks/useReviewQueueKeyboard.ts
- **description:** Claimed to refactor useReviewQueueKeyboard to accept QueueItem[] instead of Approval[]. Required to meet AC: ReviewQueueView passes grouped QueueItem list to the keyboard hook, and the hook must handle group approve/reject via batched Promise.all. Plan step 5 explicitly calls for this refactor in TASK-405.
- **resolved_by:** verifier — plan-prescribed: TASK-405-plan.md files_owned line 12 lists frontend/src/hooks/useReviewQueueKeyboard.ts, and Implementation Step 5 explicitly authorizes "change the hook to accept QueueItem[] and have its y/n handlers do the per-item batched mutate when the focused item is a group. This is a small refactor of TASK-404's hook — make the change in this task as it's part of the grouping integration." Not actually a deviation.

## FIND-SPRINT-010-14
- **type:** scope_deviation
- **source:** TASK-406 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/routers/approvals.ts
- **description:** TASK-254 claims this file but is archived/done. TASK-406 plan requires adding approveRestOfRun mutation to the AppRouter type for typecheck to pass. Edited file directly since TASK-254 has no active worktree and is functionally complete. Claim script returned conflict due to stale in-flight status in plan file.
- **resolved_by:** verifier — AC-prescribed: AC#1 ("`cyboflow.approvals.approveRestOfRun` tRPC mutation exists") plus the test_strategy item for the frontend group-card calling `trpc.cyboflow.approvals.approveRestOfRun.mutate(...)` together require the mutation to be reachable through the orchestrator AppRouter (the actual served router) for frontend typecheck and the group-approve test to pass. Wiring it in `main/src/orchestrator/trpc/routers/approvals.ts` (where `approvalsRouter` is composed into the cyboflow router at `router.ts:17`) is the minimum-diff path to satisfy this. Stale TASK-254 claim is a tooling artifact, not a real concurrency conflict.

## FIND-SPRINT-010-15
- **type:** scope_deviation
- **source:** TASK-407 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/routers/events.ts
- **description:** TASK-407 plan listed main/src/trpc/routers/events.ts in files_owned, but the actual events router lives at main/src/orchestrator/trpc/routers/events.ts. Attempted to claim via claim-file.js but got conflict_with: TASK-254 (stale — TASK-254 is archived/done per git log). Added setBadgeCount mutation directly to the orchestrator events router, which is the correct canonical location for cyboflow.events.setBadgeCount. The plan-specified path main/src/trpc/routers/events.ts does not exist and would require wiring into the app router (also claimed by stale TASK-254). Stale claim in claim-file registry is a tooling artifact, not a real concurrency conflict.
- **resolved_by:** verifier — plan-prescribed by intent: Plan Step 2 explicitly says "Wire it under the existing cyboflow router as `cyboflow.events.setBadgeCount`" and provides the exact mutation snippet. The cited path `main/src/trpc/routers/events.ts` does not exist (main/src/trpc/ is a re-export shim); the orchestrator events router is the only producer of `cyboflow.events.*`, so editing it is the only way to satisfy the plan's intent. Not a real deviation — the plan author named a non-existent file.

## FIND-SPRINT-010-16
- **type:** anti-pattern
- **source:** TASK-407 (verifier)
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/trpc/routers/events.ts:6-14
- **description:** The events router file's own docstring declares "Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or main/src/services/*." (ROADMAP-001 §6.3 — the orchestrator subtree must be extractable to a standalone Node process for the team-tier v2 target). The new `import { dockBadgeService } from '../../../services/dockBadgeService';` line directly violates the invariant — `dockBadgeService` imports `electron`. TypeScript does not enforce the invariant today (no separate tsconfig project gate), so `pnpm typecheck` passes, but the orchestrator extraction goal is now blocked at this file until the dep is inverted. Plan Step 2 authorized putting `setBadgeCount` here, but the plan did not account for the standalone invariant declared in the very file it directed edits to.
- **suggested_action:** Invert the dependency: expose a `setDockBadge` callback on the orchestrator deps interface (OrchestratorDeps in main/src/orchestrator/types.ts), inject `dockBadgeService.setBadgeCount` from main/src/index.ts when constructing the Orchestrator, and have the events router call `ctx.deps.setDockBadge(input.count)` instead of importing the concrete service. Alternative: move setBadgeCount out of the orchestrator router and back to a new main/src/trpc/routers/dock.ts wired into a separate non-orchestrator sub-router. Either approach restores the invariant. Compounder should propose whichever fits the team-tier extraction plan better.
- **resolved_by:** TASK-407

## FIND-SPRINT-010-17
- **type:** anti-pattern
- **source:** TASK-407 (verifier)
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/reviewQueueStore.ts:127-147
- **description:** `syncBadge(next)` is called inside the `set((state) => { ... })` callback for both `addApproval` and `removeApproval`. Zustand setters are expected to be pure functions of (state) → new state; firing side effects (tRPC mutations) inside them means React 18+ StrictMode (enabled in frontend/src/main.tsx per FIND-SPRINT-010-4) will invoke the setter twice in dev and fire two tRPC mutations per state change. The mutations are idempotent (setting badge=3 twice is harmless), so functionally OK, but the pattern is brittle: any future Zustand middleware that retries setters (e.g. persist with rehydration, devtools time-travel) will multiply the side effect. The `replaceAll` reducer (line 149) calls syncBadge OUTSIDE the setter — that's the correct pattern.
- **suggested_action:** Move syncBadge out of the set() callback for addApproval/removeApproval. Idiom: compute the `next` array, call set({ queue: next }), then call syncBadge(next) — same as replaceAll already does. Also makes the three reducers structurally consistent.

## FIND-SPRINT-010-18
- **type:** bug
- **source:** TASK-407 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** main/src/index.ts:762-764
- **description:** The new `app.on('before-quit', () => dockBadgeService.setBadgeCount(0))` is registered before the existing `app.on('before-quit', async (event) => …)` handler that conditionally calls `event.preventDefault()` when archive tasks are in progress. Node fires `before-quit` listeners in registration order, so the badge is cleared FIRST, then the second handler may cancel the quit by showing the "Archive Tasks In Progress" dialog. If the user picks "Wait", the app keeps running with a now-cleared dock badge while pending approvals are still in the queue. The badge stays at 0 until the next addApproval/removeApproval/replaceAll mutation re-syncs it — meaning an idle queue (no further mutations) will display an incorrect 0 badge indefinitely until the user clicks an approval, reloads, or quits. Low severity because (a) the archive-tasks-in-progress + pending-approvals + Wait-chosen combination is rare, and (b) any subsequent mutation self-heals. But the fix is one line.
- **suggested_action:** Either (a) move the dock-clear call inside the existing async handler AFTER the `event.preventDefault()` branch returns, so it only runs when the app is actually quitting; OR (b) gate the dock-clear on `app.on('will-quit', …)` (fires after all preventDefault checks have passed); OR (c) re-sync the badge from `useReviewQueueStore.getState().queue.length` if the second handler cancels the quit. Option (b) is the simplest — `will-quit` is the Electron-idiomatic event for "the app is definitely going to exit now."
- **resolved_by:** 
