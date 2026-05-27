---
id: TASK-754
sprint: SPRINT-041
epic: quick-session
status: done
summary: "Persist sessions.run_id on INSERT: added CreateSessionData.run_id field, INSERT column + ?? null bind, and DB round-trip regression tests."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-754 — Persist sessions.run_id on creation

## Outcome

Extended the `sessions` INSERT plumbing so the migration-009 `run_id` column can actually be populated. `CreateSessionData.run_id?: string | null` added; `createSession` writes `data.run_id ?? null` into the new column slot. No live caller passes a non-null `run_id` today — `SessionManager.createSessionWithId` deliberately omits the field with an explanatory comment pointing at the future flow-owned-session seam.

## Changes

- `main/src/database/models.ts` — added `run_id?: string | null` as the last field of `CreateSessionData`.
- `main/src/database/database.ts` — added `run_id` (18th column) + `?` placeholder + `data.run_id ?? null` to `createSession` INSERT/bind list.
- `main/src/services/sessionManager.ts` — added intent comment above `sessionData` literal in `createSessionWithId` documenting why `run_id` is omitted today.
- `main/src/services/__tests__/sessionManagerRunIdMapping.test.ts` — new `'DB round-trip — run_id INSERT persistence'` describe block (Case A: `run_id='flow-001'` round-trip; Case B: no `run_id` → null).

## Commits

- `bba4655` feat(TASK-754): add run_id to CreateSessionData and INSERT column list
- `105a19a` test(TASK-754): add DB round-trip cases for run_id INSERT persistence

## Tests

- Focused: 5/5 in `sessionManagerRunIdMapping.test.ts` (3 mapper + 2 new DB round-trip).
- Full main suite: 733/733 pass.
- `pnpm typecheck`, `pnpm lint`: both exit 0.

## Findings

- FIND-SPRINT-041-1 (verifier) — stale JSDoc at `main/src/ipc/session.ts:312` says createSession omits `run_id`; no longer true. File was readonly for this task. `severity: low`, `type: cleanup`.
- FIND-SPRINT-041-2 (code-reviewer) — `require('better-sqlite3')` IIFE in new test diverges from top-of-file `import` pattern used by sibling tests. `severity: minor`, `type: refactor`.
