---
id: TASK-749
idea: IDEA-024
status: ready
created: 2026-05-23T00:00:00Z
files_owned:
  - frontend/src/components/SessionListItem.tsx
  - frontend/src/components/__tests__/SessionListItem.test.tsx
files_readonly:
  - frontend/src/types/session.ts
  - main/src/ipc/session.ts
  - main/src/database/database.ts
  - main/src/types/session.ts
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/stores/sessionStore.ts
  - frontend/src/stores/navigationStore.ts
  - frontend/src/contexts/ContextMenuContext.tsx
  - frontend/src/utils/api.ts
  - frontend/src/test/setup.ts
  - frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
  - frontend/vitest.config.ts
  - .soloflow/active/ideas/IDEA-024.md
acceptance_criteria:
  - criterion: "SessionListItem renders a visible 'Quick' badge for sessions with session.runId === null (or undefined when the column is absent on legacy rows)."
    verification: "grep -n 'Quick' frontend/src/components/SessionListItem.tsx returns at least one match inside a conditional gated on session.runId being nullish; new test 'renders Quick badge when session.runId is null' in frontend/src/components/__tests__/SessionListItem.test.tsx passes."
  - criterion: "SessionListItem does NOT render the 'Quick' badge for sessions with a non-null session.runId."
    verification: "Test 'does not render Quick badge when session.runId is set' passes."
  - criterion: "Archive, rename, and favorite handlers fire successfully on a session with session.runId === null — no frontend code path throws or short-circuits because of the nullish runId."
    verification: "Three tests in SessionListItem.test.tsx confirm each handler fires with the session's id."
  - criterion: "The Quick badge uses the same visual idiom as the existing '(main)' marker — a small inline span with a muted text size."
    verification: "grep -n 'Quick' frontend/src/components/SessionListItem.tsx shows the badge rendered as a <span> sibling of the existing isMainRepo span, with classNames in the same family."
  - criterion: "No untyped 'any' is introduced."
    verification: "pnpm --filter frontend lint exits 0; pnpm --filter frontend typecheck exits 0."
  - criterion: "Test file invokes the verifier's unit chain successfully."
    verification: "pnpm --filter frontend test -- --run SessionListItem exits 0 and all five SessionListItem tests are reported as passing."
depends_on: [TASK-745, TASK-746]
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: "This task adds new conditional UI (the Quick badge) and verifies three context-menu actions remain correct on null-run sessions. No sibling tests exist for SessionListItem today, so creating the file is the only way to lock the new behavior."
  targets:
    - behavior: "Quick badge is rendered when session.runId is null"
      test_file: "frontend/src/components/__tests__/SessionListItem.test.tsx"
      type: component
    - behavior: "Quick badge is NOT rendered when session.runId is a non-null string"
      test_file: "frontend/src/components/__tests__/SessionListItem.test.tsx"
      type: component
    - behavior: "Archive button on a null-runId session invokes API.sessions.delete(session.id) after the user confirms in the ConfirmDialog"
      test_file: "frontend/src/components/__tests__/SessionListItem.test.tsx"
      type: component
    - behavior: "Rename action (triggered via inline edit, Enter key) on a null-runId session invokes API.sessions.rename(session.id, newName)"
      test_file: "frontend/src/components/__tests__/SessionListItem.test.tsx"
      type: component
    - behavior: "Favorite button on a null-runId session invokes API.sessions.toggleFavorite(session.id)"
      test_file: "frontend/src/components/__tests__/SessionListItem.test.tsx"
      type: component
---

# Add Quick badge to SessionListItem and verify session list actions on null-run sessions

## Objective

Quick sessions (introduced by TASK-743…TASK-748) are created with `run_id = NULL` in the `sessions` table. They appear in the sidebar through the existing `sessions:get-all-with-projects` path without modification, but they are visually indistinguishable from flow-owned sessions. This task adds a small "Quick" badge to `SessionListItem.tsx` rendered when `session.runId` is nullish, and locks in a regression test that confirms the three session-list actions (archive, rename, toggle-favorite) continue to work when `runId` is null.

## Implementation Steps

1. Read `frontend/src/components/SessionListItem.tsx` to confirm the existing `(main)` badge pattern: an inline `<span>` sibling of `{session.name}` inside the same flex row. The Quick badge mirrors this exact shape.

2. Confirm `Session.runId` exists on the frontend `Session` type at `frontend/src/types/session.ts`. TASK-745 owns adding `runId?: string | null` to that interface. If TASK-745 has merged but the field is missing, surface this immediately as a TASK-745 scope deviation.

3. In `SessionListItem.tsx`, immediately after the existing `isMainRepo` span, add a sibling span gated on `session.runId == null` (loose equality covers both `null` and `undefined`):
   ```tsx
   {session.runId == null && (
     <span
       className="ml-1 text-xs text-text-tertiary"
       title="Quick session — not linked to a workflow run"
     >
       Quick
     </span>
   )}
   ```

4. Do not touch any other rendering path. Archive, rename, and favorite handlers already operate purely on `session.id` and `session.name`.

5. Create `frontend/src/components/__tests__/SessionListItem.test.tsx` following the mock pattern established by `Sidebar.mcpHealth.test.tsx` and `ReviewQueueView.test.tsx`:
   - `vi.mock('../../utils/api', ...)` with `API.sessions.{hasRunScript, getRunningSession, delete, rename, toggleFavorite}` returning success shapes.
   - `vi.mock('../../stores/sessionStore', ...)` returning a minimal state.
   - `vi.mock('../../stores/navigationStore', ...)` returning `navigateToSessions`.
   - Wrap renders in the real `ContextMenuProvider`.
   - Stub `window.electronAPI.invoke` per the Sidebar.mcpHealth pattern.

6. Write the five test cases listed in `test_strategy.targets`:
   a. Badge present (null runId).
   b. Badge absent (set runId).
   c. Archive on null-run session invokes `API.sessions.delete`.
   d. Rename on null-run session invokes `API.sessions.rename`.
   e. Favorite on null-run session invokes `API.sessions.toggleFavorite`.

7. Define a `sessionFixture(overrides: Partial<Session>): Session` helper inside the test file. Type explicitly — no `any`.

8. Run `pnpm --filter frontend lint`, `pnpm --filter frontend typecheck`, and `pnpm --filter frontend test -- --run SessionListItem`.

9. Out of scope: any modification to `database.ts`, `main/src/ipc/session.ts`, the frontend `Session` type definition, or backend handlers — all owned by upstream tasks.

10. Read-only smoke check: after implementation, manually verify in `pnpm dev` that creating a quick session via TASK-747/TASK-748 entry points causes the session to appear with the Quick badge.

## Acceptance Criteria

See frontmatter. The Quick badge appears for `runId == null` and is absent for `runId == 'something'`; archive/rename/favorite continue to work; lint + typecheck + the new test file all pass.

## Test Strategy

Five component-level tests in a new `frontend/src/components/__tests__/SessionListItem.test.tsx`. The mocking surface is intentionally minimal. The real `ContextMenuProvider` is used so the rename-via-context-menu test exercises the actual menu-open path. No snapshot tests.

## Hardest Decision

Loose equality (`session.runId == null`) vs. strict (`session.runId === null`). Chose loose equality because IPC serialization through the existing `sessions:get-all-with-projects` path is not guaranteed to preserve SQL NULL as JS `null` — legacy rows that predate TASK-743's migration will have no `runId` property at all and arrive as `undefined`. The cost (a typo elsewhere setting `runId: undefined` would trigger the badge) is acceptable; the benefit (legacy quick-equivalent sessions still get the badge after migration) is real.

## Rejected Alternatives

- **Render the badge inside a new dedicated `<QuickBadge />` component.** Rejected — the existing `(main)` marker is also inline.
- **Use a Lucide icon instead of a text badge.** Rejected — matches the existing text-badge idiom.
- **Add the badge inside StatusIndicator.** Rejected — StatusIndicator's contract is run/process status, not ownership type.
- **Skip the action-verification tests.** Rejected — cost is low and guards against silent regressions when TASK-745 ends up touching these handlers.

## Lowest Confidence Area

Whether the `runId` field on the frontend `Session` interface lands in TASK-745 as `runId` (camelCase, frontend convention) versus `run_id` (snake_case, leaks from the DB column name). The frontend Session type is camelCase everywhere, so `runId` is strongly expected. If TASK-745 ships with `run_id`, this plan's runtime check silently always returns true and EVERY session shows the badge — the first test case will catch this.
