---
sprint: SPRINT-010
pending_count: 22
last_updated: "2026-05-15T18:41:18.764Z"
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

## FIND-SPRINT-010-19
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/ReviewQueueView.tsx:17-19
- **description:** Subscription cleanup is dropped — init() unsubscribe never wired.
- **suggested_action:** Capture and return the unsubscribe in ReviewQueueView’s effect: `useEffect(() => useReviewQueueStore.getState().init(), []);` — the React-style `return` form. Additionally (or alternatively), add an `initialized` flag inside the store so re-entering `init()` is a no-op + add re-init logic guarded against StrictMode double-invoke (composes with FIND-SPRINT-010-4 which already flagged StrictMode idempotency).
- **resolved_by:** 










```tsx
useEffect(() => {
  useReviewQueueStore.getState().init();
}, []);
```

TASK-401 designed `init()` to return an unsubscribe function (reviewQueueStore.ts:90, :210). TASK-402 mounted ReviewQueueView with the useEffect above and discards the return value. Consequences:

1. Under React 19 StrictMode (enabled in main.tsx — see FIND-SPRINT-010-4), the effect runs twice on mount in dev; the first init() subscription is leaked because no cleanup happens between the two mounts.
2. On any future production remount of ReviewQueueView (route change, parent re-key), the previous tRPC `onApprovalCreated` subscription leaks. Over time, multiple subscriptions stack up and addApproval fires N times per server event, causing duplicate queue entries.
3. The store itself does not dedupe subscriptions (no `initialized` guard, no internal unsubscribe stash).

Does not surface in tests because the test suite mocks the store and never exercises the real `init()` + `subscribe` pair.

Suspected tasks: TASK-401, TASK-402

## FIND-SPRINT-010-20
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/hooks/useReviewQueueKeyboard.ts:74-79
- **description:** Keyboard y/n on a group does N individual mutations; mouse Approve uses `approveRestOfRun`. Inconsistent semantics between input paths.
- **suggested_action:** In useReviewQueueKeyboard, swap the group y branch to call `trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId: focused.runId })` to match PendingApprovalCard. The reject path can stay as Promise.all since there is no `rejectRestOfRun` mutation (intentional per FIND-SPRINT-010 — only approve has the batched form). Then collapse the duplicated approve+reject mutation logic between PendingApprovalCard and useReviewQueueKeyboard into a shared helper (e.g. `frontend/src/utils/approvalActions.ts` exporting `approveItem(item)` and `rejectItem(item)` taking QueueItem).
- **resolved_by:** 









useReviewQueueKeyboard.ts:74-79 (y on a group):
```ts
void Promise.all(
  focused.items.map((a) =>
    trpc.cyboflow.approvals.approve.mutate({ approvalId: a.id }),
  ),
);
```

PendingApprovalCard.tsx:120 (mouse Approve on a group):
```ts
void trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId })
```

TASK-404 introduced the per-item batched approach for the keyboard hook before TASK-406 added the atomic `approveRestOfRun` mutation. TASK-406 updated `PendingApprovalCard` but did NOT update `useReviewQueueKeyboard`, so the two input modalities now have different transactional semantics:

- Mouse: one mutation, atomic-per-run (handler does per-row UPDATE under withLock — see main/src/trpc/routers/approvals.ts:46).
- Keyboard y: N parallel mutations, no per-run lock, no `{ decided }` return value, races on the orchestrator stub.

The whole point of TASK-406 (IDEA-009 slice 8) was to avoid the N-mutation race. Keyboard users currently bypass that fix.

Suspected tasks: TASK-404, TASK-406

## FIND-SPRINT-010-21
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/PendingApprovalCard.tsx:118-129 and frontend/src/hooks/useReviewQueueKeyboard.ts:69-101
- **description:** Approve/reject mutation logic is duplicated across PendingApprovalCard (TASK-403/405/406) and useReviewQueueKeyboard (TASK-404/405). Both files contain:
- **suggested_action:** Extract a shared module `frontend/src/utils/approvalActions.ts` exposing:
- **resolved_by:** 








1. `if (item.kind === single) trpc.approvals.approve.mutate({ approvalId })`
2. `else Promise.all(items.map(a => trpc.approvals.approve.mutate({ approvalId: a.id })))` — for reject branch in both
3. Identical reject branch with `.reject` substituted

Four copies of the same `single | group → fire mutation(s)` switch live in the two files. Adding a fourth input mode (touch, command palette, etc.) would copy this same logic again. Resolving FIND-SPRINT-010-20 (the keyboard/mouse semantic drift) would expose this duplication even more sharply because the y-key branch would gain the same `approveRestOfRun` fork that the card already has.

Suspected tasks: TASK-403, TASK-404, TASK-405, TASK-406

```ts
export async function approveQueueItem(item: QueueItem): Promise<void>
export async function rejectQueueItem(item: QueueItem): Promise<void>
```

Both functions encapsulate the `single | group` switch and pick `approveRestOfRun` vs single-mutation accordingly. PendingApprovalCard and useReviewQueueKeyboard both call those — three lines each instead of an 8-line inline switch. Bonus: a single seam to add optimistic store updates later.

## FIND-SPRINT-010-22
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** vitest.config.frontend.ts (root) and frontend/vite.config.ts
- **description:** Two coexisting frontend vitest configurations with conflicting `environment` settings. Both pick up the same six test files (96 tests) but apply different defaults.
- **suggested_action:** Pick one canonical config. Recommend keeping `frontend/vite.config.ts`’s test block (jsdom + setup file) since it matches the actual test surface, and deleting `vitest.config.frontend.ts` + the `test:unit:frontend` root script. Update README/CLAUDE.md to point all frontend test runs at `pnpm --filter frontend test`. Drop the per-file `// @vitest-environment jsdom` pragmas once jsdom is the single default.
- **resolved_by:** 







Root `vitest.config.frontend.ts:25`:
```ts
environment: node,
include: [frontend/src/**/*.{test,spec}.{ts,tsx}],
```

`frontend/vite.config.ts:17-21`:
```ts
test: {
  globals: true,
  environment: jsdom,
  setupFiles: [./src/test/setup.ts],
}
```

Three symptoms emerge from the dual configuration:

1. RTL/DOM tests work under the root config ONLY because the four DOM-touching test files each start with `// @vitest-environment jsdom` per-file pragma. Drop the pragma and the suite breaks on the root config but passes on the frontend config. Silent footgun.
2. `setupFiles: [./src/test/setup.ts]` (imports `@testing-library/jest-dom`) is wired only under `frontend/vite.config.ts`. The root config provides no setup, so `toBeInTheDocument()` works under `frontend/vite.config.ts` but would fail under the root config IF any test omitted the pragma AND the root config had jsdom. Two parallel test environments with diverging assertion vocabulary is a maintenance liability.
3. Two scripts now point at the same suite via different paths: `pnpm test:unit:frontend` (root) vs `pnpm --filter frontend test` (frontend). CI / docs / agents will pick whichever they see first.

TASK-401 added the root config; TASK-402/403 added the frontend-local config to support RTL.

Suspected tasks: TASK-401, TASK-402, TASK-403

## FIND-SPRINT-010-23
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/trpc/client.ts and frontend/src/utils/trpcClient.ts
- **description:** Two coexisting tRPC client import paths for the same singleton.
- **suggested_action:** Pick one path. Recommend canonical `frontend/src/utils/trpcClient.ts` (pre-existing convention noted in its docstring). Update PendingApprovalCard.tsx and useReviewQueueKeyboard.ts to import from there, delete `frontend/src/trpc/client.ts` and the now-empty `frontend/src/trpc/` directory. Add a one-line note to root CLAUDE.md (or frontend/CLAUDE.md if you scope it) declaring `../utils/trpcClient` as the canonical path so future executors don’t re-add the shim.
- **resolved_by:** 






- `frontend/src/utils/trpcClient.ts` — canonical, defines `trpc = createTRPCProxyClient(...)`.
- `frontend/src/trpc/client.ts` — re-export shim added by TASK-401 because TASK-403/404 plans specified `import { trpc } from ../trpc/client`.

At HEAD, three files use the re-export and one (reviewQueueStore.ts) uses the canonical path:
```
frontend/src/stores/reviewQueueStore.ts:29 → ../utils/trpcClient   (canonical)
frontend/src/components/PendingApprovalCard.tsx:4 → ../trpc/client  (shim)
frontend/src/hooks/useReviewQueueKeyboard.ts:2 → ../trpc/client    (shim)
```

Both resolve to the same module so this is not a correctness bug (the shim docstring confirms the singleton invariant). But it does fragment the import convention across two paths in the same epic and inflates surface area for future renames. The codebase had ONE convention before TASK-401; the sprint left it with TWO.

Suspected tasks: TASK-401, TASK-403, TASK-404

## FIND-SPRINT-010-24
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/trpc/ (entire subtree)
- **description:** `main/src/trpc/` is an orphan parallel router tree with zero production consumers.
- **suggested_action:** Two options for the next compounder pass: (a) inline `approveRestOfRunHandler` into `main/src/orchestrator/trpc/routers/approvals.ts` directly behind a `// TODO ctx.db wired` guard — collapse the orphan tree entirely; OR (b) leave it as-is and add a docstring NOTE to `main/src/trpc/index.ts` saying ‘this subtree is dormant until the approval-router epic — do NOT add new routers here, add them to main/src/orchestrator/trpc/routers/’ so executors aren’t tempted to grow it.
- **resolved_by:** 





Files in the subtree:
- `main/src/trpc/index.ts` — re-exports router/protectedProcedure from `orchestrator/trpc/trpc`
- `main/src/trpc/context.ts` — re-exports createContext from `orchestrator/trpc/context`
- `main/src/trpc/routers/approvals.ts` — exports `approveRestOfRunHandler`
- `main/src/trpc/__tests__/approvals.test.ts` — tests the handler directly

Production grep:
```
grep -rn main/src/trpc main/src --include=*.ts | grep -v __tests__
→ (no live imports anywhere)
```

The orchestrator’s `approvals.approveRestOfRun` mutation contains a TODO pointing at this subtree (orchestrator/trpc/routers/approvals.ts:104) but currently returns a `{ decided: 0 }` stub. So:

- The HANDLER is tested in isolation but never reached at runtime.
- The re-export shims (`index.ts`, `context.ts`) exist only so the handler-file imports compile.
- TASK-406 already removed the orphan `approveRestOfRunRouter` from this directory (commit 6012a32) — confirming the intent that the orchestrator should remain canonical.

Not wrong (the approval-router epic will consume it), but it’s an extra surface that costs maintenance until then. A misread of the docstrings could cause an executor to add MORE files here instead of the canonical orchestrator path.

Suspected tasks: TASK-401, TASK-406

## FIND-SPRINT-010-25
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/utils/migrateLocalStorageKey.test.ts vs frontend/src/**/__tests__/*
- **description:** Test-file placement convention drift across the sprint.
- **suggested_action:** Pick one convention and document it. Recommend `__tests__/` subfolders (the majority pattern now) since it visually separates source from tests in tree views. Move migrateLocalStorageKey.test.ts → migrateLocalStorageKey/__tests__/migrateLocalStorageKey.test.ts or simply frontend/src/utils/__tests__/migrateLocalStorageKey.test.ts. Add one line to CLAUDE.md under a new ‘Test placement’ section.
- **resolved_by:** 




Pre-existing in frontend/src/: `migrateLocalStorageKey.test.ts` lives alongside its SUT in `frontend/src/utils/`.

All six tests added this sprint live under sibling `__tests__/` directories:
```
frontend/src/stores/__tests__/reviewQueueStore.test.ts
frontend/src/utils/__tests__/reviewQueueSelectors.test.ts
frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
frontend/src/components/__tests__/PendingApprovalCard.test.tsx
frontend/src/components/__tests__/ReviewQueueView.test.tsx
frontend/src/utils/__tests__/approvalFormatters.test.ts
```

No documented convention exists in CLAUDE.md or docs/. The split is mild but predictable — the next executor will guess based on whichever file they read first. Tooling does not care (both paths match the vitest include glob).

Suspected tasks: TASK-401, TASK-402, TASK-403, TASK-404, TASK-405, TASK-406

## FIND-SPRINT-010-26
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useReviewQueueKeyboard.ts:41-112
- **description:** Plain-key (j/k/y/n) global window keydown listener is mounted unconditionally for the lifetime of the ReviewQueueView, with input-guard limited to native HTML elements.
- **suggested_action:** Either (a) scope the hook to fire only when the review rail has focus (require the rail to have `tabIndex={0}` and check `document.activeElement` is inside the rail before responding); OR (b) require a leader key (e.g. `g` for ‘goto queue’ then `y` to approve) — Superhuman’s actual pattern; OR (c) restrict to when at least one approval is focused AND `document.activeElement === document.body`. Option (c) is the smallest diff.
- **resolved_by:** 



The guard at line 46-53 catches:
- `target instanceof HTMLInputElement`
- `target instanceof HTMLTextAreaElement`
- `target instanceof HTMLElement && (target.isContentEditable || target.contentEditable === true)`

This covers the common Monaco-editor case (Monaco renders a hidden textarea) and xterm.js (also uses a textarea). But plain-key shortcuts on `window` are still risky:

1. Focus inside a custom focus-trap (Radix dropdown, modal) can route keydown to a non-input element. The hook fires y/n there, dispatching mutations the user did not intend.
2. The hook is mounted for the WHOLE app lifetime (ReviewQueueView is always-visible per App.tsx:364). There is no scoping to ‘when the review queue is the active panel’, so pressing y while the user is reading a long Bash output in the session view will still approve the focused approval.
3. Plain `n` is the natural keystroke for ‘no’ in dialogs (Confirm dialogs already trap Escape but not `n`).

The per-task code reviewer caught a related but narrower issue in FIND-SPRINT-010-12 (functional-setState abuse). This is the broader scoping concern that only shows when the hook is viewed in context with the always-mounted left rail.

Suspected tasks: TASK-404, TASK-405

## FIND-SPRINT-010-27
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/reviewQueueStore.ts:161-213 (init), 173-176 + 202-206 (disconnected paths)
- **description:** `init()` has no reconnect strategy when it fails. Two failure paths both call `setConnectionStatus(disconnected)` without any retry logic:
- **suggested_action:** Add an exponential-backoff reconnect inside `init()` on the subscription onError path (e.g. retry at 1s/2s/4s/8s capped). Render a small ‘Reconnecting…’ banner in ReviewQueueView when `connectionStatus === disconnected` (currently set but unread). Optional: expose `reconnect()` so a future ‘Reload’ button can wire to it.
- **resolved_by:** 


listPending failure (line 173-176):
```ts
.catch((err: unknown) => {
  console.error([reviewQueueStore] listPending failed:, err);
  setConnectionStatus(disconnected);
});
```

Subscription error (line 202-206):
```ts
onError: (err: unknown) => {
  console.error([reviewQueueStore] onApprovalCreated subscription error:, err);
  setConnectionStatus(disconnected);
  // Callers should call init() again to reconnect.
},
```

Neither path nor the ReviewQueueView mount effect observes the `disconnected` state. The comment ‘Callers should call init() again to reconnect’ has no live caller. So:

- Renderer reload required to recover from any transient tRPC connection drop.
- `connectionStatus` is set but never rendered (ReviewQueueView reads `s.queue` only).

Pure-function tests pass because they never exercise the action. The dock-badge fail-mode chains here: `disconnected` → no further mutations → badge stays at last value forever (overlap with FIND-SPRINT-010-18).

Suspected tasks: TASK-401, TASK-407

## FIND-SPRINT-010-28
- **source:** SPRINT-010 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/approvals.ts:99-108 and frontend/src/components/PendingApprovalCard.tsx:118-122
- **description:** Silent stub: clicking Approve on a group card fires a mutation that always returns `{ decided: 0 }` and never surfaces an error to the user.

orchestrator/trpc/routers/approvals.ts:
```ts
approveRestOfRun: protectedProcedure
  .input(z.object({ runId: z.string() }))
  .mutation(async ({ input, ctx }) => {
    void ctx;
    console.log(`[approvals.approveRestOfRun] STUB — runId=${input.runId}`);
    return { decided: 0 };
  }),
```

PendingApprovalCard.tsx:
```ts
void trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId })
  .finally(() => { setBusy(false); });
```

No `.then` consumes the `{ decided }` result, no toast/log communicates that nothing happened. The same shape applies to the single-approve stubs in this file (`approve` and `reject` both return `{ success: true }` after just logging). Until the approval-router epic lands, every Approve/Reject click in the UI is a silent no-op.

This is pre-arranged by the plan — the docstring says ‘full implementation lands in the approval-router epic’. But the UX behavior at HEAD is: user clicks Approve, the spinner stops, the card stays in the queue indefinitely (no `removeApproval` is fired because no `onApprovalDecided` event is emitted by the stub). That looks like a bug to anyone running the app today.

Suspected tasks: TASK-401, TASK-406
- **suggested_action:** Until the approval-router epic lands, either: (a) tag the Approve/Reject buttons as ‘(stub) Approve’ when the live stub is in effect, gated by a build flag; OR (b) have the stub mutations also emit `cyboflow.events.onApprovalDecided` so the card actually disappears (matches the visual contract the user expects, even though no DB row is updated); OR (c) accept the current behavior and document it in the v1 README so manual testers don’t file bug reports against this surface. Option (b) is the cleanest because it preserves the loop closure for visual smoke tests until approval-router lands.
- **resolved_by:** 
