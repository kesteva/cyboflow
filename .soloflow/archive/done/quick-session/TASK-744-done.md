---
id: TASK-744
sprint: SPRINT-037
epic: quick-session
status: done
summary: "Added sessions:create-quick IPC handler, UTC branch-name generator, and listener correlation fix; 3 unit tests cover generator format/UTC/zero-padding."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-744 — sessions:create-quick IPC handler

## What changed

- `main/src/types/session.ts` — extended `CreateSessionRequest` with optional `quickSession?: boolean` and `branchName?: string` fields.
- `main/src/ipc/session.ts` — exported `generateQuickWorktreeBranchName(now?: Date): string` (UTC components only, returns `quick-YYYYMMDD-HHmmss`); registered the `sessions:create-quick` ipcMain handler that validates projectId, resolves the project, computes the branch name, delegates to `taskQueue.createSession({ prompt: '', worktreeTemplate, toolType, ... })`, awaits a filtered `session-created` event correlated against the branch name (tolerating `ensureUniqueNames` `-<n>` suffix), and returns `{ jobId, sessionId, worktreePath }` on success.
- `main/src/ipc/__tests__/sessionQuickCreate.test.ts` — 3 unit tests covering generator format invariance, UTC correctness, and zero-padding.

## Code-review round

One IMPROVEMENTS_NEEDED cycle: the initial `sessionManager.once('session-created', ...)` listener was identity-blind and would cross-fire under concurrent `sessions:create-quick` calls (same silent-failure class as FIND-SPRINT-024-4). Fix in commit `e119e30` replaces `once` with a filtered `on` listener that matches `worktreePath` against `/${branchName}` or `/${branchName}-<n>`.

## Tests

- 3/3 new unit tests pass (`pnpm --filter main test sessionQuickCreate`).
- Main workspace suite: 651/651 (pre-fix); typecheck clean post-fix.

## Verification

Verifier subagent stalled twice on infrastructure (API socket timeout). L1/L2 verification performed manually:
- All 5 AC `grep` checks pass against the diff.
- Unit suite green; tsc clean.
- No UI surface (backend IPC) → visual gates not applicable.

## Notes for downstream tasks

- TASK-747 / TASK-748 should consume the returned `sessionId` + `worktreePath` directly without a follow-up IPC round-trip.
- Two MINOR code-review items accepted (review_retry_max=1 cap): (1) duplicate gitError extraction block could be hoisted into a shared helper if a third session-creation endpoint is added; (2) listener-correlation logic is reasonable to extract into a named helper for future direct unit testing.
