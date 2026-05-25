---
sprint: SPRINT-037
pending_count: 2
last_updated: "2026-05-25T13:30:00Z"
---

# Findings Queue
SPRINT-037 started with missing infra: docker; tests deferred.

## FIND-SPRINT-037-1
- **source:** TASK-749 (code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/services/sessionManager.ts:185-221 (convertDbSessionToSession)
- **description:** TASK-749 added `runId?: string | null` to both the frontend and main `Session` interfaces and gated the new `(Quick)` badge in `SessionListItem.tsx` on `session.runId == null`. However, the DB→frontend mapper `convertDbSessionToSession` in `main/src/services/sessionManager.ts` does not copy `run_id` from the DB row onto the returned `Session`. Every session arriving via `sessions:get-all-with-projects` (the path that feeds the sidebar) therefore has `runId === undefined` at runtime, regardless of the DB column's value. Because the badge predicate uses loose equality (`runId == null`), the Quick badge will render on **every** session — including flow-owned ones — silently inverting the intended behavior. The DbSession type (`main/src/database/models.ts:40`) also still omits `run_id`, so the mapper has no typed signal to wire through. This is the same silent-drop pattern as FIND-SPRINT-024-4 / FIND-SPRINT-033-6 documented in CLAUDE.md ("IPC handler ↔ declared T parity"). The five new SessionListItem tests pass because they construct sessions via the fixture directly (bypassing the mapper) — the regression is invisible to unit tests.
- **suggested_action:** Add `run_id?: string | null` to `DbSession` in `main/src/database/models.ts`, then add `runId: dbSession.run_id ?? null,` to `convertDbSessionToSession` in `main/src/services/sessionManager.ts`. Verify with a manual `pnpm dev` smoke pass (which TASK-749's step 10 already called out but did not catch). Consider a regression test that round-trips a quick session and a flow-owned session through `getSessionsForProject` and asserts on `session.runId`.
- **resolved_by:**

## FIND-SPRINT-037-2
- **source:** TASK-750 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/trpc-cutover-and-legacy-tree-cleanup/EPIC-trpc-cutover-and-legacy-tree-cleanup.md:12
- **description:** Active epic plan still describes the renderer as importing the typed tRPC client "via `frontend/src/utils/trpcClient.ts`". TASK-750 deleted that shim and migrated all 8 production callers + 1 test value-import to the canonical `frontend/src/trpc/client.ts`. The epic Context paragraph now references a path that no longer exists. Out-of-diff for TASK-750 (the epic doc is not in `files_owned`), so reporting via the queue rather than blocking the review.
- **suggested_action:** Edit the Context paragraph to reference `frontend/src/trpc/client.ts` instead of `frontend/src/utils/trpcClient.ts`. Single-line string replacement; no other content in the epic needs adjustment.
- **resolved_by:**
