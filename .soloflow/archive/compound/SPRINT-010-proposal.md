---
sprints: [SPRINT-010]
span_label: SPRINT-010
created: 2026-05-15T19:00:00.000Z
counters_start:
  ideas: 0
summary:
  cleanups: 7
  backlog_tasks: 9
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-010

SPRINT-010 delivered the review-queue-ui epic in seven tasks (TASK-401..TASK-407): tRPC v11 foundation, ReviewQueueView left-rail shell, PendingApprovalCard, j/k/y/n keyboard hook, oldest-first sort + blocking-pin + grouping, per-run `approveRestOfRun` mutation, and dock-badge sync. All seven tasks completed. The sprint-code-reviewer identified 12 open findings after merge; the per-task code reviewers added 8 more. Resolved-check: FIND-10, 11, 13, 14, 15, 16 are confirmed resolved (done reports cite resolution). The remaining 22 findings (FIND-1/2 are self-resolving parallel-stub notes; see Reconciled Findings) feed the buckets below.

---

## A. Clean-up items (execute now)

### A1. Fix tautological assertion in reviewQueueStore test
- **Summary:** `pureReplaceAll` test asserts `result !== [A]` where `[A]` is a fresh literal — the assertion can never fail and does not test what the name claims.
- **Source-Sprint:** SPRINT-010
- **Rationale:** A permanently-green assertion gives false confidence. The test is named "returns a new array even when items are identical" implying reference inequality between input and output, but the comparison target is not the input.
- **Blast radius:** `frontend/src/stores/__tests__/reviewQueueStore.test.ts` line 92 only. Risk: trivial.
- **Source:** FIND-SPRINT-010-6 (TASK-401 code-reviewer)
- **Proposed change:**
  ```diff
  -  it('returns a new array even when items are identical', () => {
  -    const result = pureReplaceAll([A], [A]);
  -    expect(result).not.toBe([A]); // reference inequality
  +  it('returns a new array even when items are identical', () => {
  +    const replacement = [A];
  +    const result = pureReplaceAll([], replacement);
  +    expect(result).not.toBe(replacement); // reference inequality between input and output
       expect(result).toHaveLength(1);
     });
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** confirmed at `frontend/src/stores/__tests__/reviewQueueStore.test.ts:91-92` — `expect(result).not.toBe([A])` compares against a fresh array literal so the assertion is tautologically true; fix is 3 lines in one test file with zero blast radius.

---

### A2. Remove redundant `as Approval[]` cast in reviewQueueStore
- **Summary:** `replaceAll(items as Approval[])` in reviewQueueStore's `init()` path silently masks future type drift — `items` is already `Approval[]` via tRPC inference.
- **Source-Sprint:** SPRINT-010
- **Rationale:** The cast suppresses the TypeScript signal that would surface if the `listPending` return type ever widens. Removing it costs nothing and keeps the type-checker honest.
- **Blast radius:** `frontend/src/stores/reviewQueueStore.ts` line 170 only. Risk: trivial.
- **Source:** FIND-SPRINT-010-7 (TASK-401 code-reviewer)
- **Proposed change:**
  ```diff
  -        replaceAll(items as Approval[]);
  +        replaceAll(items);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** confirmed at `frontend/src/stores/reviewQueueStore.ts:170` (`replaceAll(items as Approval[])`) and the orchestrator's `listPending.query()` already returns `Promise<Approval[]>` per `main/src/orchestrator/trpc/routers/approvals.ts:30`, so the cast is pure noise and removing it restores type-checker signal at trivial cost.

---

### A3. Fix misleading vitest.config.frontend.ts docstring
- **Summary:** The root `vitest.config.frontend.ts` header claims it "can run in a jsdom/happy-dom browser-like environment" but the config sets `environment: 'node'`.
- **Source-Sprint:** SPRINT-010
- **Rationale:** The contradiction will mislead the next executor who tries to add a DOM-touching test under this config. (Note: this item is superseded if A3/B5 dual-config consolidation is executed — but the docstring fix is correct regardless.)
- **Blast radius:** `vitest.config.frontend.ts` lines 3-7 comment only. Risk: trivial.
- **Source:** FIND-SPRINT-010-5 (TASK-401 code-reviewer)
- **Proposed change:**
  ```diff
  - * Covers tests in frontend/src/ that can run in a jsdom/happy-dom browser-like
  - * environment without the full Vite/Electron dev server.  Tests in this suite
  - * use pure functions only (no IPC, no Electron context).
  + * Covers tests in frontend/src/ that run in a Node environment (no DOM).
  + * Pure-function tests only — no IPC, no Electron context, no DOM APIs.
  + * DOM-touching tests run under the frontend-local config (frontend/vite.config.ts
  + * test block, jsdom environment) via `pnpm --filter frontend test`.
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** B5 proposes deleting `vitest.config.frontend.ts` outright, so editing its docstring is throw-away work — if B5 is implemented the file is gone, and if B5 is skipped the contradiction can be fixed in the same future cleanup, so this item is either redundant or premature.
- **Counterfactual:** if B5 is rejected and the dual-config is kept as-is for the long haul, this docstring fix should land instead.

---

### A4. Move `syncBadge` call out of Zustand `set()` callbacks in `addApproval`/`removeApproval`
- **Summary:** `syncBadge` (a tRPC mutation side-effect) is fired inside the `set()` callback of `addApproval` and `removeApproval`, which React 18+ StrictMode will double-invoke in development, causing two badge mutations per state change.
- **Source-Sprint:** SPRINT-010
- **Rationale:** The `replaceAll` reducer already follows the correct pattern (calls `syncBadge` outside `set()`). Making all three reducers structurally consistent eliminates the StrictMode double-fire and makes the side-effect placement self-documenting. The mutations are idempotent so this is not a correctness bug today, but the pattern is brittle against any future middleware that retries setters.
- **Blast radius:** `frontend/src/stores/reviewQueueStore.ts` lines 127-146. Risk: low (pure refactor; test coverage exists for reducers).
- **Source:** FIND-SPRINT-010-17 (TASK-407 verifier)
- **Proposed change:**
  ```diff
   addApproval: (approval) => {
  -  set((state) => {
  -    if (state.queue.some((a) => a.id === approval.id)) {
  -      return state;
  -    }
  -    const next = [...state.queue, approval];
  -    syncBadge(next);
  -    return { queue: next };
  -  });
  +  const state = get();
  +  if (state.queue.some((a) => a.id === approval.id)) return;
  +  const next = [...state.queue, approval];
  +  set({ queue: next });
  +  syncBadge(next);
   },

   removeApproval: (id) => {
  -  set((state) => {
  -    const next = state.queue.filter((a) => a.id !== id);
  -    if (next.length === state.queue.length) return state;
  -    syncBadge(next);
  -    return { queue: next };
  -  });
  +  const state = get();
  +  const next = state.queue.filter((a) => a.id !== id);
  +  if (next.length === state.queue.length) return;
  +  set({ queue: next });
  +  syncBadge(next);
   },
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** confirmed at `frontend/src/stores/reviewQueueStore.ts:127-147` — `syncBadge` is fired inside the `set()` callback for `addApproval`/`removeApproval` while `replaceAll` (line 149-153) already does it outside; aligning all three reducers eliminates the StrictMode double-fire and removes a real cross-reducer inconsistency at low cost.

---

### A5. Switch dock-badge clear from `before-quit` to `will-quit`
- **Summary:** The `before-quit` handler that clears the dock badge fires before a second `before-quit` handler that may cancel the quit — leaving the badge at 0 while the app continues running.
- **Source-Sprint:** SPRINT-010
- **Rationale:** Electron's `will-quit` event fires only after all `before-quit` `event.preventDefault()` opportunities have passed, meaning the app is definitely going to exit. Registering the badge clear there eliminates the badge-zeroed-but-app-still-running edge case. One-line change.
- **Blast radius:** `main/src/index.ts` lines 766-768. Risk: trivial.
- **Source:** FIND-SPRINT-010-18 (TASK-407 code-reviewer)
- **Proposed change:**
  ```diff
  -app.on('before-quit', () => {
  +app.on('will-quit', () => {
     dockBadgeService.setBadgeCount(0);
   });
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** confirmed at `main/src/index.ts:766-768` (badge-clear handler) and `:770-799` (the second `before-quit` handler that can `event.preventDefault()` on active archive tasks) — the badge clears before the cancel check, so the "Wait" path leaves the app running with a stale 0 badge; switching to `will-quit` is one line and the Electron-idiomatic fix.

---

### A6. Consolidate tRPC client import path — delete `frontend/src/trpc/client.ts` shim
- **Summary:** Two import paths resolve to the same tRPC singleton (`frontend/src/utils/trpcClient.ts` canonical and `frontend/src/trpc/client.ts` re-export shim); delete the shim and update the three consumer files.
- **Source-Sprint:** SPRINT-010
- **Rationale:** The shim was added by TASK-401 because TASK-403/404 plans specified `../trpc/client`. Now that the sprint is merged, the shim only fragments the import convention. Both paths resolve to the same singleton so there is no correctness risk; deleting the shim cuts the surface area and restores the pre-sprint single-convention state.
- **Blast radius:** `frontend/src/trpc/client.ts` (delete), `frontend/src/components/PendingApprovalCard.tsx` line 4, `frontend/src/hooks/useReviewQueueKeyboard.ts` line 2, `frontend/src/trpc/` directory (remove if empty after deletion). Risk: low (mechanical find-and-replace; typecheck confirms correctness).
- **Source:** FIND-SPRINT-010-23 (SPRINT-010 sprint-code-reviewer)
- **Proposed change:**
  ```diff
  # 1. Delete frontend/src/trpc/client.ts (and frontend/src/trpc/ if now empty)

  # 2. In frontend/src/components/PendingApprovalCard.tsx:
  -import { trpc } from '../trpc/client';
  +import { trpc } from '../utils/trpcClient';

  # 3. In frontend/src/hooks/useReviewQueueKeyboard.ts:
  -import { trpc } from '../trpc/client';
  +import { trpc } from '../utils/trpcClient';
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** confirmed `frontend/src/trpc/client.ts` is a bare re-export shim of `../utils/trpcClient`, used by exactly two production files (`PendingApprovalCard.tsx:4`, `useReviewQueueKeyboard.ts:2`) — deleting the shim restores the single pre-sprint convention with mechanical risk and pairs cleanly with C1.

---

### A7. Pin tRPC package versions from range to `^11.17.0`
- **Summary:** `@trpc/server` and `@trpc/client` in `package.json` use `>=11.0.0 <12.0.0` instead of `^11.17.0`, which could resolve an earlier 11.x without a lockfile.
- **Source-Sprint:** SPRINT-010
- **Rationale:** Plan AC6 requires "pinned versions" to ensure the v11 subscription leak fix (PR #6161, present in 11.17.0) is always installed. The lockfile currently resolves to 11.17.0 so this is functionally correct today, but the range allows a fresh install without lockfile to pull an earlier 11.x. Two-character change, zero behavior change.
- **Blast radius:** `package.json` lines 60-61. Risk: trivial.
- **Source:** FIND-SPRINT-010-9 (TASK-401 code-reviewer)
- **Proposed change:**
  ```diff
  -  "@trpc/server": ">=11.0.0 <12.0.0",
  +  "@trpc/server": "^11.17.0",
  -  "@trpc/client": ">=11.0.0 <12.0.0",
  +  "@trpc/client": "^11.17.0",
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** confirmed at root `package.json:60-61` (`>=11.0.0 <12.0.0`) and AC6 explicitly requires pinned versions for the v11.17 subscription-leak fix; note that `frontend/package.json:24` carries the same open range for `@trpc/client` and should be tightened in the same edit to fully satisfy AC6.
- **Counterfactual:** if the orchestrator decides AC6 is satisfied by lockfile resolution alone, this is a no-op.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix subscription leak — wire `init()` unsubscribe return in ReviewQueueView
- **Summary:** `ReviewQueueView` discards the unsubscribe function returned by `init()`, leaking the `onApprovalCreated` tRPC subscription on every remount and under React StrictMode's double-invoke in development.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-19 (SPRINT-010 sprint-code-reviewer); FIND-SPRINT-010-4 (TASK-402 code-reviewer)
- **Problem:** `ReviewQueueView.tsx` line 18 calls `useReviewQueueStore.getState().init()` and discards the return value. `init()` returns `() => void` (an unsubscribe callback per the type declaration at `reviewQueueStore.ts:92`). Without returning it from the `useEffect`, React never calls it between the two mounts that StrictMode performs in development, so the first subscription leaks. In production, any future remount of ReviewQueueView (route change, parent re-key) will stack a second live subscription on the same store — `addApproval` will fire N times per server event for N remounts, producing duplicate queue entries. The store has no internal `initialized` guard and no internal unsubscribe stash, so the only protection is the useEffect cleanup contract.
- **Proposed direction:** Change the mount effect to the React-cleanup form: `useEffect(() => useReviewQueueStore.getState().init(), [])`. Additionally, add an `initialized` flag inside `reviewQueueStore.init()` that makes re-entry a no-op (returns the existing unsubscribe immediately without firing a second `listPending` fetch or a second subscription). The guard handles the StrictMode sequence: first mount starts a subscription and stores the unsubscribe; cleanup calls unsubscribe; second mount detects `initialized === false` (reset by the cleanup) and starts fresh. Combine both changes in a single task since they are interdependent.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** confirmed at `ReviewQueueView.tsx:17-19` (init return value discarded) and `reviewQueueStore.ts:210-212` (init returns an unsubscribe), with StrictMode active at `main.tsx:25-31`; this is a real subscription leak that compounds on every remount, and was flagged independently by two reviewers (FIND-19 and FIND-4).

---

### B2. Fix keyboard `y` on group card to use `approveRestOfRun` (match mouse semantics)
- **Summary:** Pressing `y` on a group card fires N per-item `approve` mutations, but clicking Approve on the same card fires a single atomic `approveRestOfRun` — the fix TASK-406 introduced for mouse clicks was not applied to the keyboard path.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-20 (SPRINT-010 sprint-code-reviewer; TASK-404 + TASK-406 as suspected tasks)
- **Problem:** `useReviewQueueKeyboard.ts:74-79` handles a group `y` keypress with `Promise.all(focused.items.map(a => trpc.cyboflow.approvals.approve.mutate({ approvalId: a.id })))`. This is the pre-TASK-406 approach that TASK-406 explicitly replaced on the mouse path (PendingApprovalCard line 120: `trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId })`). Keyboard users bypass the per-run lock and fire N racing mutations — the whole point of TASK-406 (IDEA-009 slice 8) was to avoid exactly this race. The reject path correctly stays as `Promise.all` since there is no `rejectRestOfRun` mutation.
- **Proposed direction:** In `useReviewQueueKeyboard.ts`, swap the group `y` branch to call `trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId: focused.runId })` mirroring `PendingApprovalCard`. This also sets up for B3 (shared helper extraction) — once both approve paths use `approveRestOfRun`, extracting `approveQueueItem` / `rejectQueueItem` is straightforward. Update `useReviewQueueKeyboard.test.ts` to assert the correct mutation is called for group approve.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** confirmed `useReviewQueueKeyboard.ts:74-79` uses `Promise.all` of per-item `approve.mutate` while `PendingApprovalCard.tsx:120` uses the atomic `approveRestOfRun.mutate({ runId })` — the keyboard path bypasses the per-run lock that TASK-406/IDEA-009 slice 8 explicitly introduced to avoid the bulk-decision race.

---

### B3. Extract shared `approvalActions.ts` helper to eliminate approve/reject duplication
- **Summary:** Approve and reject mutation logic (single vs group `kind` switch, `approveRestOfRun` vs per-item) is duplicated across `PendingApprovalCard` and `useReviewQueueKeyboard` — adding any new input mode would copy it again.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-21 (SPRINT-010 sprint-code-reviewer; TASK-403, TASK-404, TASK-405, TASK-406)
- **Problem:** Both `frontend/src/components/PendingApprovalCard.tsx:118-129` and `frontend/src/hooks/useReviewQueueKeyboard.ts:69-101` contain identical four-case switches: single-approve, single-reject, group-approve (post-TASK-406: `approveRestOfRun`), group-reject (`Promise.all`). After B2 is applied, the keyboard group-approve path will also switch to `approveRestOfRun`, making the duplication even more visible. Any future input mode (touch, command palette, context menu) will duplicate the switch a third time.
- **Proposed direction:** Create `frontend/src/utils/approvalActions.ts` exporting two async functions: `approveQueueItem(item: QueueItem): Promise<void>` and `rejectQueueItem(item: QueueItem): Promise<void>`. Each encapsulates the `single | group` switch and picks the right mutation. Both `PendingApprovalCard` and `useReviewQueueKeyboard` call those instead of their inline switch. Update both test files to mock `approvalActions` at the module boundary rather than the `trpc` client directly — this yields a cleaner seam for optimistic store updates later. Dependency: B2 should land first so the canonical `approveRestOfRun` group path is in place before extraction.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** only two callsites (`PendingApprovalCard.tsx:118-129` and `useReviewQueueKeyboard.ts:69-101`) duplicate the ~8-line switch, and the "future input mode (touch, command palette)" justification is speculative — adding a new module to deduplicate two callers is overengineered relative to the actual maintenance burden, and after B2 lands the duplication is well-bounded.
- **Counterfactual:** if a third input mode (command palette, touch) appears in a future sprint, the extraction becomes proportional.

---

### B4. Fix init unsubscribe subscription leak and add reconnect strategy for `reviewQueueStore`
- **Summary:** When the `onApprovalCreated` subscription errors out, `connectionStatus` is set to `disconnected` with a comment "Callers should call init() again" — but no caller does, requiring a renderer reload to recover.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-27 (SPRINT-010 sprint-code-reviewer; TASK-401 + TASK-407)
- **Problem:** `reviewQueueStore.ts:202-206`: on subscription error, `setConnectionStatus('disconnected')` is called. Neither the `init()` body nor `ReviewQueueView` observes `disconnected` to trigger a retry. `connectionStatus` is stored in state but never read in the UI (ReviewQueueView reads `s.queue` only). Consequences: (1) any transient tRPC connection drop requires a full renderer reload to recover; (2) the dock badge stays at its last value indefinitely if no further add/remove/replaceAll mutation fires (chains into FIND-010-18 / A5). The same dead-end applies to the `listPending` failure path (line 173-176).
- **Proposed direction:** Add an exponential-backoff reconnect inside `init()` on the subscription `onError` path (e.g. retry at 1s/2s/4s/8s capped at 30s, using `setTimeout`). On the `listPending` rejection path, apply the same retry. Reset the retry counter when the subscription successfully connects. Add a small "Reconnecting…" indicator to `ReviewQueueView` that renders when `connectionStatus === 'disconnected'` (the field already exists in state). Optionally expose a `reconnect()` action for a future manual "Reload" button. Dependency: B1 (subscription cleanup contract) should land first to avoid the retry spawning multiple un-cleaned subscriptions.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** the tRPC channel is local Electron IPC (per `frontend/src/utils/trpcClient.ts:14`), which does not "drop" in normal operation — no stuck report, finding, or user-facing issue cites an actual disconnect — so building an exponential-backoff state machine + UI banner is speculative future-proofing at medium scope, and renderer reload remains a viable manual recovery.
- **Counterfactual:** if a stuck report surfaces showing a real disconnect requiring manual reload, the reconnect machinery becomes proportional.

---

### B5. Consolidate dual frontend vitest configurations into a single canonical config
- **Summary:** Two vitest configurations pick up the same frontend test files with conflicting `environment` settings — the root `vitest.config.frontend.ts` uses `node` while `frontend/vite.config.ts` uses `jsdom` — creating a silent footgun for any test that drops the per-file `// @vitest-environment jsdom` pragma.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-22 (SPRINT-010 sprint-code-reviewer; TASK-401, TASK-402, TASK-403)
- **Problem:** Root `vitest.config.frontend.ts:25` sets `environment: 'node'` and includes `frontend/src/**/*.{test,spec}.{ts,tsx}`. `frontend/vite.config.ts:17-21` sets `environment: 'jsdom'` and a `setupFiles` that imports `@testing-library/jest-dom`. RTL/DOM tests only work under the root config because each of the four DOM-touching test files has a `// @vitest-environment jsdom` per-file pragma. Drop that pragma and the suite silently breaks. Two scripts target the same suite via different paths (`pnpm test:unit:frontend` at root vs `pnpm --filter frontend test`). CI and documentation will diverge.
- **Proposed direction:** Delete `vitest.config.frontend.ts` from the repo root and the `test:unit:frontend` root script from `package.json`. The canonical runner is `pnpm --filter frontend test` (or `pnpm --filter frontend test:watch`). Remove the per-file `// @vitest-environment jsdom` pragmas from all four DOM-touching test files once `jsdom` is the single default via `frontend/vite.config.ts`. Verify no other root-level script or CI step references `test:unit:frontend`. This also closes the FIND-SPRINT-010-3 gap (the jsdom env was added to `frontend/vite.config.ts` by TASK-402, so the infrastructure is already correct — only the orphan root config needs removal).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** confirmed `vitest.config.frontend.ts:25` uses `environment: 'node'` while `frontend/vite.config.ts:19` uses `jsdom`, and three test files (`PendingApprovalCard.test.tsx`, `ReviewQueueView.test.tsx`, `useReviewQueueKeyboard.test.ts`) currently rely on the per-file `// @vitest-environment jsdom` pragma to bridge them — drop the pragma and a future executor's test silently breaks; grep finds no CI/docs reference to the root `test:unit:frontend` script, so deletion is safe.

---

### B6. Replace custom `eventToAsyncIterable` with Node's built-in `events.on`
- **Summary:** `eventToAsyncIterable` in `main/src/orchestrator/trpc/routers/events.ts` reinvents ~40 lines of queue/promise machinery that Node ≥18 provides as a one-liner via `events.on(emitter, eventName, { signal })`.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-8 (TASK-401 code-reviewer)
- **Problem:** `events.ts:74-115` contains a hand-rolled async generator with a manual queue, a pending-promise resolver, and `AbortSignal` wiring. Node 18+ (cyboflow targets Node 22) provides `events.on(emitter, eventName, { signal })` which is a fully spec-compliant async iterable, throws `AbortError` on abort, and is maintained by the Node core team. The custom impl is used twice in the file and has no tests of its own (correctness is implicitly verified by the subscription integration tests). Reducing to the built-in removes ~35 lines and eliminates a class of subtle bugs (queue ordering, promise resolution races) from the surface.
- **Proposed direction:** Replace `eventToAsyncIterable`'s body with `for await (const [payload] of events.on(emitter, eventName, { signal })) { yield payload as T; }`. Add a `try/catch` around the loop that catches `AbortError` and returns cleanly (matches current abort behavior). Import `events` from Node's built-in `node:events` module. Delete the helper after both call sites are inlined. Verify with existing subscription integration tests.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** the custom `eventToAsyncIterable` at `events.ts:74-115` just shipped working and is covered by integration tests — swapping to `events.on` is a low-risk refactor for cleanliness, but with no concrete bug or maintenance pain cited, it's churn on a hot subscription path for a stylistic win; defer until the helper actually causes friction.
- **Counterfactual:** if a queue-ordering or abort race surfaces in stuck reports, the built-in becomes proportional.

---

### B7. Tighten global keyboard shortcut scoping in `useReviewQueueKeyboard`
- **Summary:** The `window` keydown listener fires `y`/`n` approve/reject mutations even when the user is focused inside a Radix dropdown, modal, or other custom focus trap — not just native `<input>` elements.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-26 (SPRINT-010 sprint-code-reviewer; TASK-404, TASK-405)
- **Problem:** `useReviewQueueKeyboard.ts:46-53` guards against `HTMLInputElement`, `HTMLTextAreaElement`, and `contentEditable` elements. It does NOT guard against: (1) focus inside Radix UI focus traps (dropdowns, modals, popovers) which route keydown to non-input elements; (2) the reviewer-queue view being non-visible/non-focused while mounted (ReviewQueueView is always-mounted in `App.tsx:364`); (3) plain `n` coinciding with natural dialog navigation. The hook fires for the entire app lifetime regardless of which panel the user is looking at.
- **Proposed direction:** Choose the smallest safe scope. Recommended option: add a guard that `document.activeElement === document.body || document.activeElement === null` before responding to j/k/y/n. This requires the user to have clicked away from any focused element before keyboard shortcuts fire — consistent with how Vim-style shortcuts typically work. Alternatively, require the review-queue rail container to have `tabIndex={0}` and check that `document.activeElement` is inside the rail before handling any key. Update the existing `useReviewQueueKeyboard.test.ts` to cover the focus-guard branch.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** confirmed `useReviewQueueKeyboard.ts:46-53` only guards HTMLInputElement/HTMLTextAreaElement/contenteditable, while `ReviewQueueView` is always-mounted (App.tsx) so y/n fire app-wide for the entire session — a Radix dropdown or `n` in a Confirm dialog will dispatch real approve/reject mutations against pending items, which is a concrete mis-approval risk worth the small focus-guard fix.

---

### B8. Clarify or collapse the orphan `main/src/trpc/` subtree
- **Summary:** `main/src/trpc/` is a parallel router tree with no live production consumers — all imports of its files come from the `__tests__/` directory, not from any production code path.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-24 (SPRINT-010 sprint-code-reviewer; TASK-401, TASK-406)
- **Problem:** `main/src/trpc/index.ts`, `context.ts`, and `routers/approvals.ts` exist purely as a home for the `approveRestOfRunHandler` and its tests. The orchestrator `approvals.approveRestOfRun` mutation already has a TODO pointing at this handler, but the handler is never wired into any served router. TASK-406 confirmed the intent (removed the orphan `approveRestOfRunRouter`) — the canonical path is the orchestrator. Without a docstring warning, a future executor will add new routers to `main/src/trpc/` instead of `main/src/orchestrator/trpc/routers/`, silently growing an unserved subtree.
- **Proposed direction:** Option A (preferred): inline `approveRestOfRunHandler` directly into `main/src/orchestrator/trpc/routers/approvals.ts` behind a `// TODO ctx.db wired` guard (replacing the current stub). Move `main/src/trpc/__tests__/approvals.test.ts` to `main/src/orchestrator/trpc/__tests__/` or fold into the existing orchestrator approvals test. Delete `main/src/trpc/` entirely. Option B (deferred): add a `// DO NOT ADD NEW ROUTERS HERE — all live routes live in main/src/orchestrator/trpc/routers/` warning to `main/src/trpc/index.ts` and leave the handler in place until the approval-router epic consumes it.
- **Scope:** small (option A) or trivial (option B)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** confirmed via grep that `main/src/trpc/` has zero production imports outside `__tests__/` and that the orchestrator approveRestOfRun stub's TODO (`main/src/orchestrator/trpc/routers/approvals.ts:103-105`) explicitly points at this handler — the subtree is parked for the active approval-router epic, so Option B (the trivial docstring warning) is the proportional fix and prevents future executors from growing it.
- **Counterfactual:** Option A is only justified if the approval-router epic plans confirm the handler will live at the orchestrator path, not the `main/src/trpc/` path.

---

### B9. Make stub Approve/Reject mutations visually acknowledging until approval-router epic lands
- **Summary:** Clicking Approve or Reject fires stubs that always return `{ decided: 0 }` with no UX feedback — the spinner stops but the card stays in the queue indefinitely, which looks like a bug.
- **Source-Sprint:** SPRINT-010
- **Source:** FIND-SPRINT-010-28 (SPRINT-010 sprint-code-reviewer; TASK-401, TASK-406)
- **Problem:** `main/src/orchestrator/trpc/routers/approvals.ts:99-108`: `approveRestOfRun` returns `{ decided: 0 }` (documented stub). Neither `approve`, `reject`, nor `approveRestOfRun` emit an `onApprovalDecided` event, so no `removeApproval` fires in the store, and the card stays visible after the user clicks. The Busy spinner resets and the card sits there — indistinguishable from a backend error. Manual testers will file bug reports. The plan explicitly defers the real implementation to the approval-router epic.
- **Proposed direction:** Have the stub mutations emit `approvalEvents.emit('onApprovalDecided', ...)` for each affected `approvalId` before returning — this fires `removeApproval` in the store and makes the card disappear, closing the visual loop without requiring any DB writes. Specifically: `approve` stub emits `{ approvalId: input.approvalId, decision: 'approved' }`; `reject` stub emits the same with `decision: 'rejected'`; `approveRestOfRun` needs the IDs from in-memory queue state (the orchestrator can query `approvalEvents`'s current state from the store or accept a simple no-op with a TODO noting that removal will be event-driven once ctx.db is wired). This approach preserves the visual contract for QA without coupling to a real DB, and the real implementation simply replaces the stub body.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** the proposed fix doesn't actually close the loop — grep of `frontend/src` shows no subscriber wires `onApprovalDecided` to `removeApproval` (the store only subscribes to `onApprovalCreated` at `reviewQueueStore.ts:184`), so emitting from the stub would change nothing the user sees without also adding a frontend subscription; the approval-router epic in `.soloflow/active/plans/approval-router-and-permission-fix/` is the canonical owner of this loop closure.
- **Counterfactual:** if the proposed direction is expanded to also wire the renderer-side `onApprovalDecided` subscription, the impact bar might clear — but at that point it overlaps the approval-router epic.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document canonical tRPC client import path in CLAUDE.md
- **Summary:** Add a `trpcClient` entry to `docs/CODE-PATTERNS.md` "Shared Utilities" so the canonical import path is documented alongside `api.ts` / `cyboflowApi.ts`, preventing future executors from re-adding the `frontend/src/trpc/client.ts` shim.
- **Source-Sprint:** SPRINT-010
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after `frontend/src/utils/api` section (before `migrateLocalStorageKey`)
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
   ### `frontend/src/utils/api`
   ...
     Once epic 6 lands, `cyboflowApi.ts` is deleted or replaced by a tRPC client wrapper.

  +### `frontend/src/utils/trpcClient`
  +
  +- **Path:** `frontend/src/utils/trpcClient.ts`
  +- **Use it for:** All tRPC calls from the renderer. Import as `import { trpc } from '<relative>/utils/trpcClient'`.
  +- **Why single-source:** tRPC v11 subscriptions register IPC listeners per `createTRPCProxyClient` instance — a second instance (or re-export shim) causes duplicate event delivery.
  +- **Canonical example:** `frontend/src/stores/reviewQueueStore.ts`
  +
   ### `frontend/src/utils/migrateLocalStorageKey`
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** TASK-401 had to add the `frontend/src/trpc/client.ts` shim specifically because TASK-403/404 plans referenced `../trpc/client` against the pre-existing `../utils/trpcClient` convention — that exact mistake will recur for the next epic that touches tRPC without a documented anchor, and the doc insertion pairs naturally with A6 (delete the shim).

---

### C2. Document frontend test file placement convention in CLAUDE.md
- **Summary:** Add a rule to CLAUDE.md declaring that frontend tests live in `__tests__/` subdirectories adjacent to their SUT directory, and that the canonical test runner is `pnpm --filter frontend test`.
- **Source-Sprint:** SPRINT-010
- **Status:** redundant
- **source_item:** C2
- **Reason:** `docs/CODE-PATTERNS.md:10-12` already documents the `__tests__/` colocation convention project-wide ("Unit tests live in `__tests__/` subdirectories next to the file under test"); the `pnpm --filter frontend test` runner is derivable from `frontend/package.json` and does not warrant CLAUDE.md budget. The legacy `migrateLocalStorageKey.test.ts` outlier is a single pre-existing file that will not mislead future executors when the canonical convention is already stated.

---

## Reconciled Findings (informational)

The following findings had `status: open` in the findings file but were confirmed resolved by done reports. The sprint-closer's reconciliation step likely did not patch them. No action required.

- FIND-SPRINT-010-1 — parallel-execution stub `shared/types/approvals.ts` (TASK-403 scope note). Self-resolving: TASK-401 is the canonical owner; stub is overwritten at merge. No live artifact remains.
- FIND-SPRINT-010-2 — parallel-execution stub `frontend/src/trpc/client.ts` (TASK-403 scope note). Self-resolving: same as above. (Note: A6 proposes deleting the shim that TASK-401 left behind, which is a separate concern from the TASK-403 stub that was overwritten at merge.)
