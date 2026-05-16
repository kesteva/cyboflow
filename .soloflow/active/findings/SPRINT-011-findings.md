---
sprint: SPRINT-011
pending_count: 9
last_updated: "2026-05-16T03:38:57.727Z"
---
# Findings Queue

SPRINT-011 started with missing infra: docker; tests deferred.

## FIND-SPRINT-011-1
- **source:** TASK-401 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/CODE-PATTERNS.md:60-66 (also frontend/src/trpc/client.ts and frontend/src/utils/trpcClient.ts)
- **description:** TASK-401 recreated `frontend/src/trpc/client.ts` as the canonical `createTRPCProxyClient` instance and reduced `frontend/src/utils/trpcClient.ts` to a re-export shim. This REVERSES the SPRINT-010 sprint-closer consolidation (commits 805cd42 + e8cc5ac) that explicitly deleted `trpc/client.ts` and documented `utils/trpcClient.ts` as the canonical path in CODE-PATTERNS.md (lines 60-66). The TASK-401 plan was authored before SPRINT-010's consolidation and its `files_owned` includes `frontend/src/trpc/client.ts`, so the recreation is plan-prescribed — but CODE-PATTERNS.md now contradicts the implementation. Singleton invariant is preserved (only ONE `createTRPCProxyClient` call exists, confirmed via grep), so this is not a runtime bug — it is a documentation / convention divergence. Consumers (`PendingApprovalCard.tsx`, `useReviewQueueKeyboard.ts`, `reviewQueueStore.ts`) still import from `../utils/trpcClient` (the shim), so the codebase now has the import directionality inverted from what CODE-PATTERNS.md describes.
- **suggested_action:** Decide which path is canonical and align all three artifacts: (a) the implementation file containing the `createTRPCProxyClient` call, (b) consumer imports across the codebase, and (c) the `### frontend/src/utils/trpcClient` section in docs/CODE-PATTERNS.md. Either: (1) update CODE-PATTERNS.md to describe `frontend/src/trpc/client.ts` as canonical and update the three consumer imports to match; OR (2) revert TASK-401's swap, restore `utils/trpcClient.ts` as the canonical, make `trpc/client.ts` the shim again, and update the two test mock paths (`PendingApprovalCard.test.tsx:86`, `useReviewQueueKeyboard.test.ts:26`) from `'../../trpc/client'` to `'../../utils/trpcClient'` — the original incomplete change in SPRINT-010 that triggered the test failure TASK-401 was solving.

## FIND-SPRINT-011-2
- **source:** TASK-401 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/trpc/routers/approvals.ts:22; main/src/trpc/routers/events.ts:16; .soloflow/active/plans/review-queue-ui/TASK-401-plan.md (AC verification commands at lines 28-30)
- **description:** TASK-401's acceptance-criteria verification commands `grep -n 'listPending' main/src/trpc/routers/approvals.ts` and `grep -n 'onApprovalCreated' main/src/trpc/routers/events.ts` target file paths that no longer host the live router definitions — those moved to `main/src/orchestrator/trpc/routers/{approvals,events}.ts` and are composed into `appRouter` via `main/src/orchestrator/trpc/router.ts`. To satisfy the AC grep without re-introducing duplicate router definitions, TASK-401 added `main/src/trpc/routers/{approvals,events}.ts` as pure re-export shims (`export { approvalsRouter } from '../../orchestrator/trpc/routers/approvals'`). These re-export files have ZERO production importers (verified via `grep -rn "trpc/routers/approvals\|trpc/routers/events" main/src`) — they exist solely to satisfy the AC grep. The header comments honestly admit this ("Re-export the canonical router so the AC grep finds 'listPending' here"), which is the best the executor could do given the plan, but the underlying pattern is grep-driven dead code: a future reader looking at `main/src/trpc/routers/approvals.ts` will reasonably ask "why does this file exist?" The plan-prescribed file path is the root cause, not the executor.
- **suggested_action:** Pick one of: (1) Delete the two re-export shim files, update CODE-PATTERNS.md (or a future plan's AC) to grep `main/src/orchestrator/trpc/routers/{approvals,events}.ts` directly; (2) Move the live router definitions back into `main/src/trpc/routers/` and have `main/src/orchestrator/trpc/router.ts` import from there — collapses the two-tier structure; (3) Add a single `main/src/orchestrator/trpc/routers/CLAUDE.md` documenting that the orchestrator subtree is the canonical home and the `main/src/trpc/routers/` paths are TASK-401-AC compatibility shims to be removed once a plan-aware grep is available. Option 1 is the cleanest; option 3 is the lowest-friction.

## FIND-SPRINT-011-3
- **source:** TASK-403 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** frontend/src/hooks/useReviewQueueKeyboard.ts:74-80, 92-98
- **description:** TASK-406 introduced `approveRestOfRun` as the atomic per-run approve mutation and wired it into `PendingApprovalCard`'s group-card Approve button. The keyboard-triage hook `useReviewQueueKeyboard` was authored in TASK-404 (before TASK-406) and still uses `Promise.all(items.map((a) => trpc.cyboflow.approvals.approve.mutate(...)))` for `y` on a group item. The hook's own header comment at line 23 explicitly flags this: "TASK-406 will replace this with a single atomic per-run mutation." TASK-406 updated the card but did not update the hook, leaving keyboard `y` semantically and behaviorally divergent from mouse-click Approve on the same group card: keyboard issues N parallel mutations (chatty, no atomic guarantee, partial-failure exposure); mouse issues one `approveRestOfRun` call (atomic per-run, server decides). For the rote-approval flow IDEA-009 targets, the keyboard path is the dominant one — so the inconsistency lands on the hot path.
- **suggested_action:** In `useReviewQueueKeyboard.ts`, replace the group branch of the `y` handler (lines 74-80) with `void trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId: focused.runId })`, mirroring `PendingApprovalCard.handleApprove`. Update the header comment at line 23. Add a hook unit test asserting `y` on a group fires `approveRestOfRun` exactly once with the group's `runId` (mirroring the existing component test at `PendingApprovalCard.test.tsx:291-300`). The `n` (reject) branch can stay on `Promise.all` for now — there is no `rejectRestOfRun` mutation, and TASK-403's card uses the same per-item reject pattern.
- **resolved_by:** 

## FIND-SPRINT-011-4
- **source:** TASK-404 (verifier, round-2)
- **type:** claude-md
- **severity:** medium
- **status:** resolved
- **location:** frontend/src/test/setup.ts; frontend/vite.config.ts (test block)
- **description:** The frontend vitest setup (`frontend/src/test/setup.ts`) only imports `@testing-library/jest-dom` and does NOT register an `afterEach(() => cleanup())` from `@testing-library/react`. With `@testing-library/react@^16` + vitest `globals: true`, auto-cleanup is supposed to detect the global `afterEach` and register itself, but in this project's actual run it does NOT — verified by running `useReviewQueueKeyboard.test.ts`, where every `renderHook` call attaches a window-level `keydown` listener that is never removed between tests. By the 6th test, 6 listeners exist; by the empty-queue test, 15 listeners exist, so a single `press('y')` fires 15 mutations (the empty queue's own no-op, plus 14 leaked listeners from prior tests' non-empty queues). This silently passed in previous PR rounds because earlier hook iterations did not register window-level listeners. Any future hook that uses `addEventListener` on `window`/`document` will exhibit the same leak. The fix is one line in setup.ts: `import { cleanup } from '@testing-library/react'; afterEach(() => cleanup());`. CODE-PATTERNS.md should also document the requirement so this isn't re-discovered each time a window-listener hook is written.
- **suggested_action:** Add to `frontend/src/test/setup.ts`:
- **resolved_by:** verifier — status-sync: TASK-404 (round-3 commit b722b59 applied the prescribed setup.ts patch verbatim; 21/21 hook tests and 99/99 frontend suite green confirm the listener leak is gone). docs/CODE-PATTERNS.md documentation portion remains open for compounder follow-up.




  ```ts
  import { afterEach } from 'vitest';
  import { cleanup } from '@testing-library/react';
  afterEach(() => { cleanup(); });
  ```
  Then document in `docs/CODE-PATTERNS.md` (under a new "Frontend test conventions" subsection) that the project's vitest+`@testing-library/react@16` combination requires explicit `cleanup()` registration and that any window/document-level event listener registered by a hook MUST be exercised by a multi-render test (or a leak-detection test) in CI to catch regressions.

## FIND-SPRINT-011-5
- **source:** TASK-404 (verifier, round-3)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/VISUAL-VERIFICATION-SETUP.md (missing); .soloflow/config.json (verification.visual_web=true)
- **description:** verification.visual_web=true in .soloflow/config.json but the sprint orchestrator does not start a renderer dev server for verifier subagents, so Playwright-MCP navigation to http://localhost:4521 returns ERR_CONNECTION_REFUSED on every verification run that touches frontend UI. Result: every UI-affecting task in this sprint has emitted (or will emit) a visual_web=skipped_unable plus a config_issue queue entry, even though the underlying tooling (Playwright-MCP, the Vite renderer) is fully available. The actual gap is operational: either the verifier needs a documented `pnpm --filter frontend dev:test` startup it can probe and reuse, or visual_web should be flipped to false until orchestrator+verifier coordination on the dev server is in place. The user-memory note `visual_verification_config_rationale.md` records the intent (renderer reachable at http://localhost:4521 in test mode) but the test-mode launcher is not wired into the sprint flow.
- **suggested_action:** Either (a) author docs/VISUAL-VERIFICATION-SETUP.md to document the renderer-start sequence the verifier should probe (e.g. `pnpm --filter frontend dev:test` on port 4521 launched in background before sprint verification, with health-check on `/`), then have the orchestrator launch+teardown it around sprint runs; OR (b) extend .soloflow/config.json with a `verification.dev_server` block (command, port, ready-probe) and have the verifier auto-start it when missing — both options eliminate the per-task `visual_web_unavailable` queue spam this sprint is accumulating. Until either lands, consider flipping visual_web=false to suppress the noise and rely on grep+unit-test ACs (which the TASK-404 plan author chose deliberately).

## FIND-SPRINT-011-6
- **source:** TASK-405 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ReviewQueueView.tsx:26
- **description:** ReviewQueueView interpolates `approval.id` directly into a CSS attribute selector: `document.querySelector(\`[data-approval-id="${itemId(focused)}"]\`)`. The `approvals.id` column schema is `TEXT PRIMARY KEY` (main/src/database/migrations/006_cyboflow_schema.sql:55) — there is no DB-level UUID format constraint. Today the orchestrator generates UUIDs so the practical risk is zero, but if a future code path ever produces an id containing `"`, `]`, or backslash, the selector silently breaks (returns null and the scroll-to-focused effect no-ops) or throws a SyntaxError. Not a security issue — `id` is server-issued, never user-supplied — but a small defense-in-depth gap that could surface as a confusing "keyboard focus works but no auto-scroll" bug if the id-generation strategy ever changes.
- **suggested_action:** Replace the template-literal selector with `CSS.escape()`: `` document.querySelector(`[data-approval-id="${CSS.escape(itemId(focused))}"]`) ``. One-line change, no behavior delta for current UUID ids, and removes the implicit "id must be CSS-selector-safe" coupling between the DB layer and the renderer. Alternatively, attach a ref to each card and look up by Map<id, HTMLElement> — cleaner long-term but a bigger change.
- **resolved_by:** 

## FIND-SPRINT-011-7
- **source:** TASK-407 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/events.ts:133
- **description:** The `setBadgeCount` tRPC mutation validates its input as `z.object({ count: z.number().int().min(0) })` — no upper bound. A renderer (today the only caller is `frontend/src/stores/reviewQueueStore.ts:112` which sends `queue.length`) could in principle send `Number.MAX_SAFE_INTEGER`. macOS' `app.dock.setBadge` accepts arbitrary strings and the dock renders long values harmlessly (visually truncated), so practical risk is zero. Defense-in-depth: an explicit cap (e.g. `.max(9999)`) would document the expected range and reject obviously-bogus values at the boundary. Adjacent quality nit: the procedure has no `createCaller`-based unit test asserting that the mutation forwards `input.count` into `ctx.setDockBadge` — the wire-through is covered transitively by the createContext shape tests in `router.test.ts:62-79` plus the dockBadgeService unit tests, but a one-line direct test would close the layered-test gap.
- **suggested_action:** Either (a) tighten the schema to `z.number().int().min(0).max(9999)` and add a single test in `main/src/orchestrator/trpc/__tests__/router.test.ts` invoking `caller.cyboflow.events.setBadgeCount({ count: 7 })` with a context whose `setDockBadge` captures the call; or (b) leave the schema open but add the wire-through test only. Option (a) is preferred — it documents the contract and exercises the full call path in one change.
- **resolved_by:** 

## FIND-SPRINT-011-8
- **source:** SPRINT-011 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/approvals.ts:99-108 (stub); main/src/trpc/routers/approvals.ts:47-91 (real handler); frontend/src/components/PendingApprovalCard.tsx (button caller)
- **description:** Stub approveRestOfRun tRPC mutation lies about success — TASK-406 added a fully functional approveRestOfRunHandler in main/src/trpc/routers/approvals.ts (mutex-guarded DB writes, per-row error handling, returns { decided: N }), but the tRPC mutation exposed to the renderer at main/src/orchestrator/trpc/routers/approvals.ts:99-108 is a stub that always returns { decided: 0 } and logs [approvals.approveRestOfRun] STUB. The TODO comment at line 103-105 notes the wire-through is gated on ctx.db landing in the approval-router epic. Cross-task consequences only visible at sprint level: (a) TASK-403 wired the PendingApprovalCard group-card Approve button to this mutation; (b) TASK-406 unit-tested only the standalone handler function (main/src/trpc/__tests__/approvals.test.ts), bypassing the tRPC layer; (c) the sprint verifier validated visual_web flow 4 by capturing a single approveRestOfRun call on a stubbed window.electronTRPC, which returned the stub data and looked correct. Net effect: any user click on group-card Approve in a production build silently no-ops (no DB row updated, no approval gate released), yet the UI removes the cards via the subscription event flow because the stub returns { ok: true } — there is no test or CI gate preventing this stub from shipping. Per-task reviewers could not see this because the gap spans three files in three different tasks across two directory subtrees.
- **suggested_action:** Either (a) block ship until the approval-router epic lands by adding a Vitest test in main/src/orchestrator/trpc/__tests__/router.test.ts that asserts caller.cyboflow.approvals.approveRestOfRun({ runId: x }) on a context with a real test DB instance updates DB rows and returns decided>0 (this test will FAIL today and act as a tripwire); OR (b) have the stub throw `TRPCError({ code: NOT_IMPLEMENTED, message: approveRestOfRun is not wired yet })` instead of returning a fake success — this surfaces the gap at the UI button rather than silently failing; OR (c) wire ctx.db into the orchestrator context now so the existing handler can be invoked directly per the TODO. Option (b) is the lowest-risk short-term fix; option (c) is the correct long-term fix and is the natural payoff of the approval-router epic.
- **resolved_by:** 



Suspected tasks: TASK-401, TASK-403, TASK-406

## FIND-SPRINT-011-9
- **source:** SPRINT-011 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts:27; frontend/src/components/__tests__/PendingApprovalCard.test.tsx:86; frontend/src/stores/__tests__/reviewQueueStore.test.ts:22
- **description:** Inconsistent vi.mock paths for the same trpc symbol across SPRINT-011 test files. All three sprint-touched production consumers import from ../utils/trpcClient (the re-export shim): frontend/src/stores/reviewQueueStore.ts:29, frontend/src/components/PendingApprovalCard.tsx:4, frontend/src/hooks/useReviewQueueKeyboard.ts:2. But two of the three test files mock the canonical path: PendingApprovalCard.test.tsx:86 uses `vi.mock("../../trpc/client", ...)` and useReviewQueueKeyboard.test.ts:27 uses the same; reviewQueueStore.test.ts:22 uses `vi.mock("../../utils/trpcClient", ...)`. Both styles happen to intercept correctly today because of Vitest ESM hoisting + the shim s single re-export line, but the test surface now contains two competing conventions for the same dependency. A new contributor copying any one test as a template will pick one convention; if FIND-SPRINT-011-1 is resolved by inverting the canonical direction (option 2 in that finding), the canonical-path mocks would silently stop intercepting. Cross-task footprint: TASK-401 introduced the two-file structure; TASK-403, TASK-404, TASK-406 each added a test file that picked the canonical path; TASK-407 expanded reviewQueueStore.test.ts (the dissenter). Per-task reviewers only see their own test file s mock path — only the sprint-level review sees the divergence.
- **suggested_action:** Pick one mock path convention and apply it consistently. Recommended: align mock paths with the production import path (../utils/trpcClient), since that is the path real callers use — this minimizes coupling between test setup and the canonical/shim distinction. Concretely: update PendingApprovalCard.test.tsx:86 and useReviewQueueKeyboard.test.ts:27 to `vi.mock("../../utils/trpcClient", ...)`. Then add a one-line note in the new frontend/src/test/setup.ts header (or a new docs/CODE-PATTERNS.md "Frontend test conventions" subsection paired with FIND-SPRINT-011-4 follow-up) stating: "Mock trpc at the import-path of the SUT, not the canonical client file. Mocking ../../trpc/client only works by accident of the shim re-export and will break if the canonical path moves." Bundling this fix with FIND-SPRINT-011-4 s docs work makes it one CLAUDE.md/CODE-PATTERNS.md PR.
- **resolved_by:** 


Suspected tasks: TASK-401, TASK-403, TASK-404, TASK-406, TASK-407

## FIND-SPRINT-011-10
- **source:** SPRINT-011 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/approvals.ts (no rejectRestOfRun); frontend/src/hooks/useReviewQueueKeyboard.ts:107-122 (n-key fan-out); frontend/src/components/PendingApprovalCard.tsx (group-card Reject button fan-out)
- **description:** Asymmetric per-run atomicity between approve and reject. TASK-406 introduced approveRestOfRun as an atomic per-run mutation specifically to eliminate partial-failure exposure and chatty IPC for the group-card Approve flow, and it wired the mouse-click handler on the group card to use it. The matching reject path was NOT introduced — there is no rejectRestOfRun mutation, no rejectRestOfRunHandler, and no router stub. Cross-task consequences only visible at sprint level: (a) FIND-SPRINT-011-3 already notes the keyboard hook s y-on-group uses Promise.all approve fan-out and explicitly states the n-key MUST stay on Promise.all because no rejectRestOfRun exists; (b) the group-card Reject button in PendingApprovalCard.tsx similarly fans out N reject mutations per group; (c) the original TASK-406 design rationale (comment at main/src/orchestrator/trpc/routers/approvals.ts:81-85: "global approve-all maps to the highest-harm failure mode") applies symmetrically to reject — a partial-failure reject on a 10-tool group is exactly as user-hostile as a partial approve, and worse in the case where a reject was supposed to halt a destructive action. Per-task reviewers couldn t see this because TASK-406 s scope was approve-only by plan; only the sprint-level view reveals the asymmetric coverage of the group-card UX.

Suspected tasks: TASK-403, TASK-404, TASK-406
- **suggested_action:** Add a sibling rejectRestOfRun procedure + handler matching the approveRestOfRun shape. Concretely: (1) add `rejectRestOfRunHandler(db, runId, message?)` in main/src/trpc/routers/approvals.ts mirroring approveRestOfRunHandler at lines 47-91 but with `status = rejected` and an optional message column; (2) add `rejectRestOfRun: protectedProcedure.input(z.object({ runId: z.string(), message: z.string().optional() })).mutation(...)` in main/src/orchestrator/trpc/routers/approvals.ts after the approveRestOfRun definition, with the same stub-or-real-handler discipline; (3) update FIND-SPRINT-011-3 s suggested fix to also include the n-key keyboard branch using rejectRestOfRun; (4) update the group-card Reject button in PendingApprovalCard.tsx to call rejectRestOfRun, add a Vitest mirroring the existing approveRestOfRun test at PendingApprovalCard.test.tsx:291-300. Combining this with the FIND-SPRINT-011-3 follow-up makes the keyboard/mouse paths symmetric for both approve AND reject in one change.
- **resolved_by:** 
