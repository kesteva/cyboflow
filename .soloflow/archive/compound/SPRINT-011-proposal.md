---
sprints: [SPRINT-011]
span_label: SPRINT-011
created: "2026-05-15T00:00:00.000Z"
counters_start:
  ideas: 16
summary:
  cleanups: 5
  backlog_tasks: 4
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-011

SPRINT-011 delivered the review-queue-ui epic (TASK-401..TASK-407): tRPC foundation, ReviewQueueView shell, PendingApprovalCard (single + group), keyboard triage hook (j/k/y/n), oldest-first sort + blocking-pin, `approveRestOfRun` mutation, and dock-badge sync. All 7 tasks done; 0 stuck. Findings span a stub that silently no-ops on group-card Approve, a keyboard/mouse asymmetry on the hot path, two AC-shim files with no production importers, and a stale CODE-PATTERNS.md entry contradicting the current canonical tRPC client path.

---

## A. Clean-up items (execute now)

### A1. Add `CSS.escape()` to the approval-id selector in ReviewQueueView

- **Summary:** `ReviewQueueView.tsx` interpolates `approval.id` directly into a CSS attribute selector string; wrapping it with `CSS.escape()` closes the implicit "id must be selector-safe" coupling between the DB layer and the renderer.
- **Source-Sprint:** SPRINT-011
- **Rationale:** The `approvals.id` column is `TEXT PRIMARY KEY` with no UUID-format constraint (migration 006). Today the orchestrator generates UUIDs, so the risk is zero in practice, but if the id-generation strategy ever changes (e.g., a future migration adds human-readable slugs), a value containing `"`, `]`, or `\` will silently break scroll-to-focused with no test catching it. One-line fix, no behavior delta for current UUIDs. Evidence: FIND-SPRINT-011-6, surfaced by TASK-405 code-reviewer; TASK-405-done.md "Findings Queued" section.
- **Blast radius:** `frontend/src/components/ReviewQueueView.tsx` (1 line), risk: trivial.
- **Source:** FIND-SPRINT-011-6 (TASK-405 code-reviewer)
- **Proposed change:**
  ```diff
  // frontend/src/components/ReviewQueueView.tsx:26
  -      document.querySelector(`[data-approval-id="${itemId(focused)}"]`)
  +      document.querySelector(`[data-approval-id="${CSS.escape(itemId(focused))}"]`)
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `frontend/src/components/ReviewQueueView.tsx:26` — the cited unescaped interpolation exists, no in-flight plan touches it (TASK-611 only rewrites the mount effect lines 17-19), and a 1-line `CSS.escape()` call has near-zero blast radius for a non-zero defense-in-depth win.

---

### A2. Add `.max(9999)` bound and a wire-through test to `setBadgeCount`

- **Summary:** The `setBadgeCount` tRPC mutation has no upper-bound validation on its `count` input and no direct unit test confirming it forwards the value into `ctx.setDockBadge`; adding `.max(9999)` and one `createCaller`-level test documents the contract and closes the layered-test gap.
- **Source-Sprint:** SPRINT-011
- **Rationale:** Without an upper bound, the mutation accepts `Number.MAX_SAFE_INTEGER`; macOS renders it harmlessly but the schema gives no signal about the intended range. The wire-through (mutation → `ctx.setDockBadge`) is covered transitively but not directly — a one-line test would catch any future refactor that breaks the delegation. Evidence: FIND-SPRINT-011-7, surfaced by TASK-407 code-reviewer; TASK-407-done.md "Findings" section.
- **Blast radius:** `main/src/orchestrator/trpc/routers/events.ts` (1-line schema change); `main/src/orchestrator/trpc/__tests__/router.test.ts` (1 new test assertion). Risk: low.
- **Source:** FIND-SPRINT-011-7 (TASK-407 code-reviewer)
- **Proposed change:**
  ```diff
  // main/src/orchestrator/trpc/routers/events.ts — setBadgeCount procedure input
  -  input: z.object({ count: z.number().int().min(0) })
  +  input: z.object({ count: z.number().int().min(0).max(9999) })

  // main/src/orchestrator/trpc/__tests__/router.test.ts — new test (append to suite)
  +  it('setBadgeCount forwards count to setDockBadge', async () => {
  +    const captured: number[] = [];
  +    const caller = createCallerFactory(appRouter)({
  +      ...baseCtx,
  +      setDockBadge: (n: number) => { captured.push(n); },
  +    });
  +    await caller.cyboflow.events.setBadgeCount({ count: 7 });
  +    expect(captured).toEqual([7]);
  +  });
  ```
  *(Adjust `baseCtx` / `createCallerFactory` to match the existing test scaffolding in that file.)*

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `setBadgeCount` schema at `main/src/orchestrator/trpc/routers/events.ts:133` has no max bound and `router.test.ts` has no direct wire-through test for it; the wire-through test is real value (setDockBadge injection pattern already exists at router.test.ts:74-79), and `.max(9999)` is a cheap contract-documentation edit with zero current-caller impact (only `reviewQueueStore.ts:112` sends `queue.length`).
- **Counterfactual:** If the schema cap is rejected as speculative, the wire-through test alone still passes the impact bar.

---

### A3. Make the `approveRestOfRun` orchestrator stub throw `NOT_IMPLEMENTED` instead of returning fake success

- **Summary:** The `approveRestOfRun` stub in `main/src/orchestrator/trpc/routers/approvals.ts` currently returns `{ decided: 0 }` and logs a message, so a user clicking group-card Approve silently no-ops while the UI removes cards — changing the stub to throw `TRPCError(NOT_IMPLEMENTED)` surfaces the gap at the button rather than hiding it.
- **Source-Sprint:** SPRINT-011
- **Rationale:** FIND-SPRINT-011-8 identifies a sprint-level cross-task bug: TASK-403 wired the group-card Approve button to this stub, TASK-406 unit-tested only the handler function (bypassing the tRPC layer), and the sprint verifier validated against a stubbed `electronTRPC` that returned stub data. The net effect is that any production group-card Approve click silently no-ops without updating the DB. Throwing `NOT_IMPLEMENTED` is the lowest-friction safety fix until `ctx.db` is wired in the approval-router epic (tracked in B3). Evidence: FIND-SPRINT-011-8 (sprint-code-reviewer).
- **Blast radius:** `main/src/orchestrator/trpc/routers/approvals.ts:101-107` (2-line change). Risk: low — converts a silent failure to a visible one, which is strictly safer.
- **Source:** FIND-SPRINT-011-8 (SPRINT-011 sprint-code-reviewer)
- **Proposed change:**
  ```diff
  // main/src/orchestrator/trpc/routers/approvals.ts
  +import { TRPCError } from '@trpc/server';
   ...
   approveRestOfRun: protectedProcedure
     .input(z.object({ runId: z.string() }))
     .mutation(async ({ input, ctx }): Promise<ApproveRestOfRunResult> => {
       void ctx;
       // TODO(approval-router epic): once ctx.db is wired, delegate to:
       //   import { approveRestOfRunHandler } from '../../../trpc/routers/approvals';
       //   return approveRestOfRunHandler(ctx.db, input.runId);
  -    console.log(`[approvals.approveRestOfRun] STUB — runId=${input.runId}`);
  -    return { decided: 0 };
  +    throw new TRPCError({
  +      code: 'NOT_IMPLEMENTED',
  +      message: `approveRestOfRun is not wired yet (approval-router epic). runId=${input.runId}`,
  +    });
     }),
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed the stub at `main/src/orchestrator/trpc/routers/approvals.ts:99-108` returns fake-success `{ decided: 0 }` while `PendingApprovalCard.tsx:120` and the planned TASK-612 keyboard handler both wire group-card Approve to this mutation — converting to a visible `NOT_IMPLEMENTED` error is strictly safer than the current silent no-op and is the FIND-SPRINT-011-8 short-term mitigation while the approval-router epic (TASK-301..305, 569, 580-583) wires `ctx.db`.
- **Counterfactual:** Would flip to DONT_IMPLEMENT only if the approval-router epic were demonstrably about to ship in the same window — but EPIC-approval-router-and-permission-fix lists 9 dependent tasks not yet executed.

---

### A4. Align vi.mock paths in two test files to match the SUT's actual import path

- **Summary:** `PendingApprovalCard.test.tsx` and `useReviewQueueKeyboard.test.ts` mock `'../../trpc/client'` while the production files they test import from `'../utils/trpcClient'`; aligning the mock paths to the SUT's actual import prevents silent interception failures if the canonical/shim split is ever resolved.
- **Source-Sprint:** SPRINT-011
- **Rationale:** Both styles happen to intercept correctly today because of Vitest ESM hoisting and the shim's single re-export line, but the test suite now has two competing conventions for the same dependency. `reviewQueueStore.test.ts` uses `vi.mock("../../utils/trpcClient", ...)` (the SUT import path); the other two use `vi.mock("../../trpc/client", ...)`. A new contributor copying either template will pick the wrong one half the time, and if B1 resolves FIND-SPRINT-011-1 by reverting to `utils/trpcClient` as canonical, the `trpc/client` mocks would silently stop intercepting. Evidence: FIND-SPRINT-011-9 (SPRINT-011 sprint-code-reviewer).
- **Blast radius:** `frontend/src/components/__tests__/PendingApprovalCard.test.tsx:86` (1 string change); `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts:27` (1 string change). Risk: low — tests must still pass (all 99/99 green after the change).
- **Source:** FIND-SPRINT-011-9 (SPRINT-011 sprint-code-reviewer)
- **Proposed change:**
  ```diff
  // frontend/src/components/__tests__/PendingApprovalCard.test.tsx:86
  -vi.mock('../../trpc/client', () => ({
  +vi.mock('../../utils/trpcClient', () => ({

  // frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts:27
  -vi.mock('../../trpc/client', () => ({
  +vi.mock('../../utils/trpcClient', () => ({
  ```
  Run `pnpm --filter frontend test` after — 99/99 must remain green.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed both mock-path mismatches at `PendingApprovalCard.test.tsx:86` and `useReviewQueueKeyboard.test.ts:27` (both mock `'../../trpc/client'` while SUTs at `PendingApprovalCard.tsx:4` and `useReviewQueueKeyboard.ts:2` import from `'../utils/trpcClient'`); TASK-612 step 3 fixes the keyboard half but leaves the PendingApprovalCard half — so this item still has standalone value, and a 1-string edit per file has near-zero cost.

---

### A5. Update keyboard `y` group handler to use `approveRestOfRun` (mirrors mouse path)

- **Summary:** The `y` key handler in `useReviewQueueKeyboard.ts` fans out N parallel `approve.mutate` calls for group items while the group-card Approve button issues one atomic `approveRestOfRun.mutate`; replacing the hook's group branch with `approveRestOfRun` makes keyboard and mouse paths semantically identical.
- **Source-Sprint:** SPRINT-011
- **Rationale:** FIND-SPRINT-011-3 identifies that TASK-406 updated the card but not the hook. The hook's own header comment at line 23 explicitly flags this as a TASK-406 follow-up ("TASK-406 will replace this with a single atomic per-run mutation"). For the rote-approval flow (IDEA-009), the keyboard path is the dominant one, so the inconsistency lands on the hot path. The `n` (reject) branch can stay on `Promise.all` — there is no `rejectRestOfRun` mutation yet (that is B4). Evidence: FIND-SPRINT-011-3 (TASK-403 code-reviewer), TASK-403-done.md "Findings Queued."
- **Blast radius:** `frontend/src/hooks/useReviewQueueKeyboard.ts` (lines 97-102 replaced, line 23 comment updated); `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts` (1 new test assertion mirroring `PendingApprovalCard.test.tsx:291-300`). Risk: low.
- **Source:** FIND-SPRINT-011-3 (TASK-403 code-reviewer)
- **Proposed change:**
  ```diff
  // frontend/src/hooks/useReviewQueueKeyboard.ts — header comment update (line 23)
  - * For group items, y/n issue one mutation per member via Promise.all (batched).
  - * TASK-406 will replace this with a single atomic per-run mutation.
  + * For group items, y issues one atomic approveRestOfRun mutation (per-run scope).
  + * n still fans out per-item reject calls (no rejectRestOfRun mutation yet — see B4).

  // frontend/src/hooks/useReviewQueueKeyboard.ts — group branch of 'y' case
        } else {
  -       void Promise.all(
  -         focused.items.map((a) =>
  -           trpc.cyboflow.approvals.approve.mutate({ approvalId: a.id }),
  -         ),
  -       );
  +       void trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId: focused.runId });
        }

  // frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts — new test
  // (append next to the existing 'y approves a single item' test)
  +  it('y on a group item calls approveRestOfRun exactly once with the group runId', async () => {
  +    // render with a group item in queue, press 'y', assert approveRestOfRun called once
  +    // with { runId: groupItem.runId }, approve.mutate never called.
  +    // Mirror the pattern at PendingApprovalCard.test.tsx:291-300.
  +  });
  ```
  *(Fill in the test body following the existing hook test scaffolding pattern.)*

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** high
- **Reasoning:** Fully duplicated by in-flight `.soloflow/active/plans/review-queue-ui/TASK-612-plan.md` (status: ready), whose objective, implementation steps 1-5, and AC criteria match this item verbatim — including the doc-comment update at line 23, the group-`y`→`approveRestOfRun` swap, and the new keyboard-test case. Applying A5 would create a merge conflict with TASK-612 when it executes.
- **Counterfactual:** Would flip to IMPLEMENT only if TASK-612 were cancelled or significantly descoped — neither is indicated.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Resolve tRPC client canonical/shim inversion and align CODE-PATTERNS.md

- **Summary:** `docs/CODE-PATTERNS.md` still documents `frontend/src/utils/trpcClient.ts` as the canonical `createTRPCProxyClient` site, but TASK-401 reversed the direction — `trpc/client.ts` is now canonical and `utils/trpcClient.ts` is the shim — leaving the documentation actively misleading.
- **Source-Sprint:** SPRINT-011
- **Source:** FIND-SPRINT-011-1 (TASK-401 verifier), also surfaced in TASK-404-done.md open findings list.
- **Problem:** After TASK-401 (commit `bf6f4f0`), the canonical `createTRPCProxyClient<AppRouter>` call lives in `frontend/src/trpc/client.ts` and `frontend/src/utils/trpcClient.ts` is a one-line re-export shim. But `docs/CODE-PATTERNS.md:60-66` still instructs agents to import from `utils/trpcClient` as "the" canonical path and warns against a "second instance or re-export shim." The singleton invariant is preserved (exactly one `createTRPCProxyClient` call exists), so this is not a runtime bug — but any executor reading CODE-PATTERNS.md will get the directionality backwards. There are two resolution options: (1) accept TASK-401's direction — update CODE-PATTERNS.md to name `trpc/client.ts` as canonical, update the three consumer imports (`PendingApprovalCard.tsx`, `useReviewQueueKeyboard.ts`, `reviewQueueStore.ts`) from `../utils/trpcClient` to `../trpc/client`, and update test mocks accordingly; or (2) revert TASK-401's direction — restore `utils/trpcClient.ts` as canonical, make `trpc/client.ts` the shim again, update the two test mock paths from `../../trpc/client` to `../../utils/trpcClient` (after A4 those will already be aligned). The singleton invariant must be preserved in either case.
- **Proposed direction:** Option 2 (revert to `utils/trpcClient` as canonical) is lower-friction: the three production consumers already import from `utils/trpcClient`, so no consumer-import churn is needed — only the file contents swap back and the CODE-PATTERNS.md entry is confirmed accurate. This also makes A4's mock-path alignment consistent without additional work. Confirm that after the swap all 99 frontend tests and `pnpm typecheck` remain green. Update the `### frontend/src/utils/trpcClient` section in CODE-PATTERNS.md to drop the "or re-export shim" parenthetical now that the shim is on the `trpc/client.ts` side.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The proposed direction (revert to `utils/trpcClient` canonical) actively contradicts in-flight `TASK-615-plan.md`, which accepts `trpc/client.ts` as canonical and adds DO-NOT-EXPAND warnings to the `main/src/trpc/` shim tree under that same assumption — and the simpler fix (one-sentence CODE-PATTERNS.md update naming `frontend/src/trpc/client.ts` as canonical) does not need a backlog task. The CODE-PATTERNS.md update belongs as a one-line edit in C1 or its own bullet, not a planned task.
- **Counterfactual:** Would flip to IMPLEMENT if framed as a docs-only update (one CODE-PATTERNS.md edit + drop the "shim" parenthetical) rather than a code-swap task touching tests and consumers.

---

### B2. Remove or rationalize the AC-shim re-export files in `main/src/trpc/routers/`

- **Summary:** `main/src/trpc/routers/approvals.ts` and `main/src/trpc/routers/events.ts` were created by TASK-401 solely to satisfy plan AC grep commands against paths that no longer host live router definitions; the events shim has zero callers and can be deleted outright, while the approvals file also hosts `approveRestOfRunHandler` (the planned wiring point for the approval-router epic) and needs a deliberate relocation decision.
- **Source-Sprint:** SPRINT-011
- **Source:** FIND-SPRINT-011-2 (TASK-401 code-reviewer), TASK-401-done.md "Findings" section.
- **Problem:** The live router definitions for `approvals` and `events` reside in `main/src/orchestrator/trpc/routers/{approvals,events}.ts` and are composed via `main/src/orchestrator/trpc/router.ts`. The two files in `main/src/trpc/routers/` exist only because the TASK-401 plan's AC verification commands greppe'd those paths. `grep -rn "trpc/routers/approvals|trpc/routers/events" main/src` returns zero production importers outside the shim files themselves. The `events.ts` shim is a pure re-export with no original logic — it is dead code. The `approvals.ts` shim contains the real `approveRestOfRunHandler` implementation plus a `approvalsRouter` re-export; the handler is not imported anywhere today but will be imported once `ctx.db` is wired in the approval-router epic (the TODO comment at `orchestrator/trpc/routers/approvals.ts:104` points to it). Deleting `approvals.ts` would require relocating `approveRestOfRunHandler` before the approval-router epic can wire it.
- **Proposed direction:** (1) Delete `main/src/trpc/routers/events.ts` immediately (zero logic, zero callers). (2) Move `approveRestOfRunHandler` from `main/src/trpc/routers/approvals.ts` into `main/src/orchestrator/trpc/routers/approvals.ts` directly (where the TODO comment will import it from), then delete the now-empty shim. Update the three existing `approveRestOfRunHandler` test imports in `main/src/trpc/__tests__/approvals.test.ts` to the new path. Add or update a comment in `main/src/orchestrator/trpc/routers/approvals.ts` documenting that `main/src/orchestrator/trpc/routers/` is the canonical home for all approvals router logic. This work is naturally bundled with B3 (wiring `ctx.db`) since both touch the orchestrator approvals router.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Directly conflicts with in-flight `.soloflow/active/plans/approval-router-and-permission-fix/TASK-615-plan.md` which takes the opposite approach (keep the orphan tree, add DO-NOT-EXPAND warnings, assign eventual collapse to the approval-router epic). Picking the deletion path now while TASK-615 picks the keep-and-warn path creates a direct epic-boundary conflict; the approval-router epic explicitly owns the eventual collapse decision (TASK-615 line 40).
- **Counterfactual:** Would flip to IMPLEMENT only if TASK-615 were cancelled and the approval-router epic explicitly delegated the orphan-tree collapse to a separate task.

---

### B3. Wire `ctx.db` into the orchestrator context to activate `approveRestOfRun`

- **Summary:** The `approveRestOfRun` tRPC mutation exposed to the renderer is a stub that always returns `{ decided: 0 }` because `ctx.db` is not yet injected into the orchestrator tRPC context; wiring `ctx.db` is the approval-router epic's payoff and makes group-card Approve functional end-to-end.
- **Source-Sprint:** SPRINT-011
- **Source:** FIND-SPRINT-011-8 (SPRINT-011 sprint-code-reviewer); also `main/src/orchestrator/trpc/routers/approvals.ts:99-108` TODO comment.
- **Problem:** TASK-406 implemented `approveRestOfRunHandler` and unit-tested it in isolation with an injected DB, but the tRPC mutation at `main/src/orchestrator/trpc/routers/approvals.ts:99-108` is a stub. The `ContextDeps` interface (`main/src/orchestrator/trpc/context.ts`) currently includes `setDockBadge` but not `db`. The approval-router epic must add `db: DatabaseLike` to `ContextDeps`, inject the real `better-sqlite3` instance in `main/src/index.ts` alongside `setDockBadge`, and replace the stub body with a call to `approveRestOfRunHandler(ctx.db, input.runId)`. A3 (in Bucket A) should land first to convert the stub from fake-success to `NOT_IMPLEMENTED` — this prevents silent data loss until B3 ships. After wiring, add an integration-level test that invokes the procedure via `createCaller` with a real test-DB instance and asserts `decided > 0`.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** high
- **Reasoning:** This IS the approval-router epic — `.soloflow/active/plans/approval-router-and-permission-fix/EPIC-approval-router-and-permission-fix.md` plus TASK-301..305, 569, 580-583, 615 already own ctx.db wiring and stub-replacement, and TASK-615 explicitly names the eventual `approveRestOfRunHandler` consumption as the epic's payoff. Adding a parallel B3 backlog task would duplicate IDEA-007 / epic scope without surfacing anything the epic doesn't already track.
- **Counterfactual:** Would flip to IMPLEMENT only if the epic were closed/cancelled and no successor existed.

---

### B4. Introduce `rejectRestOfRun` mutation to make approve/reject symmetric for group items

- **Summary:** The group-card Approve path is now atomic per-run (`approveRestOfRun`), but the group-card Reject button and keyboard `n` handler still fan out N per-item `reject.mutate` calls; adding a `rejectRestOfRun` mutation + handler closes the asymmetry on both the hot keyboard path and the mouse path.
- **Source-Sprint:** SPRINT-011
- **Source:** FIND-SPRINT-011-10 (SPRINT-011 sprint-code-reviewer); also FIND-SPRINT-011-3 (which explicitly notes `n` must stay on `Promise.all` "for now" because `rejectRestOfRun` does not exist).
- **Problem:** TASK-406's scope was approve-only by plan. The consequence (only visible at the sprint level) is that approve and reject now have different atomicity guarantees for group items: one atomic mutation vs. N parallel mutations with partial-failure exposure. For the rote-approval flow (IDEA-009), the keyboard path is dominant, and a partial-failure reject on a 10-tool group is exactly as user-hostile as a partial approve — and potentially worse if the reject was intended to halt a destructive action. There is no `rejectRestOfRun` procedure at the orchestrator level, no handler function at the main/trpc level, and no `rejectRestOfRun` input type in `shared/types/approvals.ts`. All three must be added symmetrically to the existing approve stack.
- **Proposed direction:** (1) Add `RejectRestOfRunInput` / `RejectRestOfRunResult` to `shared/types/approvals.ts` (mirrors `ApproveRestOfRunInput` / `ApproveRestOfRunResult`). (2) Add `rejectRestOfRunHandler(db, runId, message?)` in `main/src/trpc/routers/approvals.ts` (or its post-B2 new home) mirroring `approveRestOfRunHandler` but setting `status='rejected'` and capturing an optional message. (3) Add `rejectRestOfRun: protectedProcedure` to the orchestrator approvals router (stub or live depending on when B3 lands). (4) Update the `n`-key group branch in `useReviewQueueKeyboard.ts` to call `rejectRestOfRun.mutate({ runId: focused.runId })` (also resolves the remaining asymmetry noted in A5). (5) Update the group-card Reject button in `PendingApprovalCard.tsx` symmetrically. (6) Add unit tests mirroring the approve equivalents at `approvals.test.ts` and `PendingApprovalCard.test.tsx:291-300`. Coordinate with B2 (handler file location) and B3 (ctx.db wiring) so all three ship together in the approval-router epic.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed no `rejectRestOfRun` symbol exists anywhere in `main/src/`, `frontend/src/`, or `shared/types/approvals.ts`; the asymmetry is real (TASK-406's atomic approve commit + `useReviewQueueKeyboard.ts:114-117` per-item reject fan-out), and a backlog task that scopes the symmetric work into the approval-router epic is the right vehicle — but the proposed direction must be coordinated with TASK-615 (it should NOT live in the orphan `main/src/trpc/` tree) and with B3-as-epic so no orphan file is created.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the approval-router epic explicitly declares reject symmetry out of scope or if a parallel idea already exists.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add "Frontend Test Conventions" section to `docs/CODE-PATTERNS.md`

- **Summary:** Two test-authoring rules discovered in SPRINT-011 — explicit `afterEach(cleanup)` for window-listener hooks, and mock-at-SUT-import-path convention for tRPC — belong in CODE-PATTERNS.md so future executors do not rediscover them through broken tests.
- **Source-Sprint:** SPRINT-011
- **Target file:** `docs/CODE-PATTERNS.md`
- **Status:** ready
- **source_item:** C1
- **Reviewer notes:** kept ready; compressed from ~40 lines to ~14 — dropped the inlined `setup.ts` code block (already in the codebase) and the verbose explanation paragraphs, kept just the rule + canonical-example pointer for each sub-rule.
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ -154,4 +154,18 @@
   - **Canonical example:** `scripts/configure-build.js`, `scripts/configure-build.test.js`
   - **Env-var contract:** see `docs/signing/APPLE_DEVELOPER_SETUP.md`.

  +## Frontend Test Conventions
  +
  +### `afterEach(cleanup)` is mandatory in vitest setup
  +
  +`frontend/src/test/setup.ts` explicitly registers `afterEach(() => cleanup())`. The
  +vitest `globals: true` + `@testing-library/react@^16` combo does NOT auto-register
  +cleanup — without it, `renderHook` calls that attach `window`/`document` listeners
  +accumulate across tests (test N fires N handlers per key press). Do NOT remove that
  +line. Hooks with global listeners should include a multi-render regression test —
  +see `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts`.
  +
  +### Mock tRPC at the SUT's own import path
  +
  +`vi.mock(...)` must use the exact specifier the SUT imports (e.g. `'../../utils/trpcClient'`),
  +not the canonical client file it re-exports from. Mocking the re-export target works only
  +by accident of ESM hoisting and breaks silently if the shim direction is ever flipped.
  +Canonical example: `frontend/src/stores/__tests__/reviewQueueStore.test.ts:22`.
  +
   `/soloflow:compound` will append patterns extracted from completed sprints to this file over time.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Both sub-rules are evidence-grounded: `frontend/src/test/setup.ts:2-4` currently has the explicit `afterEach(cleanup)` line that FIND-SPRINT-011-4 establishes as load-bearing (no auto-register from @testing-library/react@16), and FIND-SPRINT-011-9 documents three test files with two conflicting mock-path conventions for the same SUT-import — exactly the recurring trap CODE-PATTERNS.md exists to prevent. The 14-line diff carries no rule-drift (every claim matches current code) and pays attention-budget for every future frontend test author.

---

### C2. Note that renderer requires full Electron for visual verification

- **Summary:** One-paragraph note appended to "Common Commands" clarifying the Vite renderer cannot bootstrap standalone — visual verification of frontend UI requires `pnpm dev` (full Electron), not `pnpm --filter frontend dev`.
- **Source-Sprint:** SPRINT-011
- **Target file:** `CLAUDE.md`
- **Status:** ready
- **source_item:** C2
- **Reviewer notes:** kept ready but significantly narrowed from a multi-step procedure section into a single inline paragraph. MCP-tool-specific fallback steps are agent-workflow guidance and don't belong in CLAUDE.md; the `cyboflow-frontend-debug.log` fallback is already documented in the next section; `pnpm dev` is already in Common Commands. Only the non-obvious, project-specific fact (renderer is not standalone-bootable) is preserved.
- **Diff:**
  ```diff
  --- a/CLAUDE.md
  +++ b/CLAUDE.md
  @@ -32,6 +32,8 @@

   Platform packaging (`pnpm build:mac:arm64`, `pnpm build:linux`, etc.) — see `package.json` `scripts`.

  +Visual verification of any frontend UI change requires `pnpm dev` (full Electron). The Vite renderer at `http://localhost:4521` cannot bootstrap standalone — it depends on `preload`-injected `electronTRPC` and will error without the main process. For headless validation when capture is unavailable, read `cyboflow-frontend-debug.log` (see below).
  +
   ## Frontend/Backend Debug Logs (dev mode)
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** FIND-SPRINT-011-5 documents the exact failure mode (verifier subagents hitting ERR_CONNECTION_REFUSED at localhost:4521 on every UI-affecting task) and the proposed one-paragraph insertion is appropriately narrow — Step 2.5 already trimmed it from a multi-step procedure section to a single paragraph naming the non-obvious project-specific fact, with no rule-drift against existing CLAUDE.md content.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the docs already covered this in a sibling file (`docs/ARCHITECTURE.md` or `docs/cyboflow_system_design.md`) — neither does, per the proposal context.

---

## Reconciled Findings (informational)

- **FIND-SPRINT-011-4** — listed as `status: open` in the findings file but claimed resolved by TASK-404 in `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/review-queue-ui/TASK-404-done.md` ("Resolved: FIND-SPRINT-011-4 — fixed in b722b59"). The setup.ts patch is confirmed applied; the CODE-PATTERNS.md documentation portion of the finding remains open and is addressed by C1 above. The sprint-closer's reconciliation step did not patch the finding's `status` field — this is the normal drift this cross-check exists to catch.

---

## Suppressed — SoloFlow Defects

- **Auto-start dev server from `verification.visual_web` config** — FIND-SPRINT-011-5 includes a suggestion to extend `.soloflow/config.json` with a `verification.dev_server` block that the verifier auto-starts when the port is not responding. This is a SoloFlow verifier behavioral change, not a project convention. Suppressed from Bucket C (tester mode is off). Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
