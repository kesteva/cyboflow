---
sprint: SPRINT-011
pending_count: 6
last_updated: "2026-05-15T18:35:00.000Z"
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
