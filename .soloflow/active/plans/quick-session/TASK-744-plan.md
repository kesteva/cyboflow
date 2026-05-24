---
id: TASK-744
idea: IDEA-024
status: in-flight
created: "2026-05-23T00:00:00Z"
files_owned:
  - main/src/ipc/session.ts
  - main/src/types/session.ts
  - main/src/ipc/__tests__/sessionQuickCreate.test.ts
files_readonly:
  - main/src/services/taskQueue.ts
  - main/src/services/worktreeManager.ts
  - main/src/services/sessionManager.ts
  - main/src/database/database.ts
  - main/src/database/models.ts
  - main/src/ipc/types.ts
  - main/src/preload.ts
  - frontend/src/types/electron.d.ts
  - main/src/ipc/__tests__/sessionJsonMessages.test.ts
acceptance_criteria:
  - criterion: "`main/src/types/session.ts` exports a `CreateSessionRequest` that includes optional `quickSession?: boolean` and optional `branchName?: string` fields; existing fields (prompt, toolType, projectId, etc.) are unchanged."
    verification: "grep -n 'quickSession\\?:\\s*boolean' main/src/types/session.ts returns a match inside the CreateSessionRequest interface; grep -n 'branchName\\?:\\s*string' main/src/types/session.ts returns a match inside the same interface; pnpm --filter main exec tsc --noEmit exits 0."
  - criterion: "`main/src/ipc/session.ts` registers a new `sessions:create-quick` IPC handler that accepts a `CreateSessionRequest`, validates `projectId` is set (rejecting with a clear error message when absent), generates a `quick-YYYYMMDD-HHmmss` UTC branch name when `branchName` is not provided, and delegates to `taskQueue.createSession` with `prompt: ''`, `toolType` taken from the request (defaulting to 'claude'), and the generated/supplied name passed as `worktreeTemplate`."
    verification: "grep -n \"ipcMain.handle('sessions:create-quick'\" main/src/ipc/session.ts returns exactly one match; grep -n 'No project specified' main/src/ipc/session.ts returns a match inside the new handler block; pnpm --filter main test sessionQuickCreate exits 0."
  - criterion: "A pure helper `generateQuickWorktreeBranchName(now?: Date): string` is exported from `main/src/ipc/session.ts`, returns strings matching `/^quick-\\d{8}-\\d{6}$/`, and uses UTC components (`getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCHours`, `getUTCMinutes`, `getUTCSeconds`) — never local-time getters."
    verification: "grep -n 'export function generateQuickWorktreeBranchName' main/src/ipc/session.ts returns a match; grep -nE 'getUTC(FullYear|Month|Date|Hours|Minutes|Seconds)' main/src/ipc/session.ts returns at least six matches; pnpm --filter main test sessionQuickCreate exits 0."
  - criterion: "Created quick sessions persist with `run_id IS NULL` in the sessions table — relies on the existing DatabaseService.createSession INSERT (owned by TASK-745) which omits run_id from its column list, so the migration's NULL default applies. This task does NOT modify the database layer."
    verification: "pnpm --filter main test sessionQuickCreate exits 0; the test fixture confirms a created quick session's stored row has run_id null."
  - criterion: "The handler returns `{ success: true, data: { jobId: string, sessionId: string, worktreePath: string } }` on success and `{ success: false, error: string }` on validation/creation failure. This is INTENTIONALLY richer than the existing `sessions:create` response — frontend tasks (TASK-747, TASK-748) need `sessionId` and `worktreePath` to navigate and bootstrap a panel without a follow-up IPC. The handler must await TaskQueue.createSession to resolve and read the session row (or attach a one-shot completion listener on the job) before responding."
    verification: "grep -nE 'jobId|sessionId|worktreePath' main/src/ipc/session.ts inside the new handler block returns at least three matches; main/src/ipc/__tests__/sessionQuickCreate.test.ts asserts the success-shape contains all three fields."
depends_on:
  - TASK-743
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: "The new handler introduces a UTC timestamp generator, project-id validation, and a no-prompt delegation path through TaskQueue.createSession. The branch-name generator is a pure helper that must be unit-tested for UTC correctness and format invariance. The handler boundary itself is best exercised at the helper-extraction seam (per the existing sessionJsonMessages.test.ts pattern), avoiding deep DI mocking."
  targets:
    - behavior: "generateQuickWorktreeBranchName returns a string matching ^quick-\\d{8}-\\d{6}$ for a fixed input Date"
      test_file: main/src/ipc/__tests__/sessionQuickCreate.test.ts
      type: unit
    - behavior: "generateQuickWorktreeBranchName uses UTC components (not local time) — feeding a Date constructed via Date.UTC(2026, 4, 23, 15, 27, 58) returns 'quick-20260523-152758' regardless of host timezone"
      test_file: main/src/ipc/__tests__/sessionQuickCreate.test.ts
      type: unit
    - behavior: "generateQuickWorktreeBranchName zero-pads month/day/hour/minute/second to two digits each (e.g. month 1 → '01', second 5 → '05')"
      test_file: main/src/ipc/__tests__/sessionQuickCreate.test.ts
      type: unit
---
# Implement sessions:create-quick IPC handler and worktree scaffolding

## Objective

Add a backend entry point that lets the frontend create a session without selecting a flow. The handler auto-generates a `quick-YYYYMMDD-HHmmss` (UTC) worktree branch name, delegates to the existing `TaskQueue.createSession` machinery with an empty prompt and the requested `toolType`, and produces a session row with `run_id = NULL`. No flow / WorkflowRun is created. This is the single backend prerequisite for slices 2-4 of IDEA-024.

## Implementation Steps

1. **Extend `CreateSessionRequest`** in `main/src/types/session.ts` (currently lines 56-74). Add two optional fields at the end of the interface:
   - `quickSession?: boolean;` — marker indicating the request originated from a quick-session entry point.
   - `branchName?: string;` — explicit worktree branch name. When provided, the handler uses it verbatim; when absent, the handler generates `quick-YYYYMMDD-HHmmss` at handler entry.

2. **Add the UTC branch-name generator** in `main/src/ipc/session.ts`, exported from the module (not inside `registerSessionHandlers`):

   ```ts
   export function generateQuickWorktreeBranchName(now: Date = new Date()): string {
     const pad = (n: number) => String(n).padStart(2, '0');
     const y = now.getUTCFullYear();
     const mo = pad(now.getUTCMonth() + 1);
     const d = pad(now.getUTCDate());
     const h = pad(now.getUTCHours());
     const mi = pad(now.getUTCMinutes());
     const s = pad(now.getUTCSeconds());
     return `quick-${y}${mo}${d}-${h}${mi}${s}`;
   }
   ```

3. **Register the `sessions:create-quick` handler** in `main/src/ipc/session.ts`, inside `registerSessionHandlers`, placed immediately after the existing `sessions:create` handler block. The handler must:
   - Accept `(request: CreateSessionRequest)`.
   - Validate `request.projectId` is set; if not, return `{ success: false, error: 'No project specified. Quick sessions require a projectId.' }`.
   - Validate `taskQueue` is initialized.
   - Resolve the target project via `databaseService.getProject(request.projectId)`; return `{ success: false, error: 'Project not found' }` if missing.
   - Compute `branchName = request.branchName ?? generateQuickWorktreeBranchName()`.
   - Resolve `toolType: 'claude' | 'none' = request.toolType ?? 'claude'`.
   - Call `taskQueue.createSession({ prompt: '', worktreeTemplate: branchName, permissionMode: request.permissionMode, projectId: targetProject.id, folderId: request.folderId, baseBranch: request.baseBranch, autoCommit: request.autoCommit, toolType, commitMode: request.commitMode, commitModeSettings: request.commitModeSettings, claudeConfig: request.claudeConfig })`.
   - **Resolve the created session before returning.** TaskQueue.createSession returns a `Job` whose completion produces the persisted session row. Either (a) `await job.finished()` on the underlying queue, or (b) register a one-shot listener on the session-creation event and resolve with the new `sessionId` + `worktreePath`. Both `sessionManager.getSession(sessionId)` and the project-resolved `worktreePath` should be available synchronously by the time the job completes (worktree creation happens before SessionManager.createSession returns).
   - Return `{ success: true, data: { jobId: job.id, sessionId: session.id, worktreePath: session.worktreePath } }`.
   - Wrap in the same try/catch as `sessions:create`, reusing the gitError destructuring.

4. **Document the architectural decision** in a JSDoc block on the new handler explaining: (a) we delegate to `TaskQueue.createSession` with `prompt: ''` to keep worktree+session lifecycle single-sourced; (b) `prompt === ''` causes TaskQueue to skip prompt-related setup; (c) `db.createSession` omits `run_id` from its INSERT column list, so the row naturally gets `run_id = NULL` per TASK-743's migration default; (d) second-precision branch-name collisions are resolved by `TaskQueue.ensureUniqueNames`.

5. **Create the test file** at `main/src/ipc/__tests__/sessionQuickCreate.test.ts` following the structure of the existing `sessionJsonMessages.test.ts`. Three `it()` blocks covering the three test_strategy targets:
   1. **Format invariance**: assert `generateQuickWorktreeBranchName(new Date(Date.UTC(2026, 4, 23, 15, 27, 58)))` returns `'quick-20260523-152758'`.
   2. **UTC correctness**: assert the regex `/^quick-\d{8}-\d{6}$/` matches a default `generateQuickWorktreeBranchName()` call.
   3. **Zero-padding**: assert `generateQuickWorktreeBranchName(new Date(Date.UTC(2026, 0, 5, 3, 4, 5)))` returns `'quick-20260105-030405'`.

6. **Sanity-check via typecheck and unit suite**: run `pnpm --filter main exec tsc --noEmit` and `pnpm --filter main test sessionQuickCreate`.

## Acceptance Criteria

1. `CreateSessionRequest` gains `quickSession?: boolean` and `branchName?: string`; tsc clean.
2. A `sessions:create-quick` IPC handler is registered, validates projectId, and delegates to `taskQueue.createSession` with `prompt: ''`.
3. `generateQuickWorktreeBranchName` is exported, returns the `quick-YYYYMMDD-HHmmss` format, and uses UTC getters exclusively.
4. New quick sessions persist with `run_id IS NULL` via the existing database INSERT.
5. Handler returns the same `{ success, data: { jobId } | error }` shape as `sessions:create`.

## Test Strategy

Three pure unit tests cover the generator's format, UTC correctness, and zero-padding. The handler itself is intentionally NOT tested in this task — the existing `sessionJsonMessages.test.ts` precedent only tests pure helpers extracted from `session.ts`, and the handler's logic reduces to (a) validation guards already covered by existing handlers and (b) a thin delegation to `taskQueue.createSession`. End-to-end coverage of the IPC round trip lands in TASK-749's session-list integration verification.

## Hardest Decision

Whether to add a `quickSession` flag to `TaskQueue.createSession`'s job data and centralize quick-vs-normal handling there, OR layer the quick-session contract on top of TaskQueue's existing public surface from the handler. Chose **layer at the handler**, treating `TaskQueue.createSession({ prompt: '', worktreeTemplate: <quick-name>, toolType, ... })` as the load-bearing primitive. TaskQueue already short-circuits prompt-related work when `prompt === ''` and accepts an explicit `worktreeTemplate`, so the quick-session shape is already expressible without new TaskQueue parameters. The decomposer also did not include `taskQueue.ts` in `files_owned_hint`, indicating the boundary was deliberate.

## Rejected Alternatives

1. **Write a parallel minimal handler that calls `WorktreeManager.createWorktree` + `SessionManager.createSession` directly, bypassing TaskQueue.** Rejected: duplicates the queue's mutex, project-resolution, and uniqueness-suffix logic.
2. **Generate the timestamp inside `TaskQueue.createSession`.** Rejected: the `branchName` field exists precisely to keep the timestamp deterministic at handler entry, so tests and the orchestrator can inject fixed timestamps.
3. **Use `crypto.randomUUID()` instead of a UTC timestamp.** Rejected: user locked in `quick-YYYYMMDD-HHmmss` (UTC) as Q2's answer.
4. **Add a handler-level retry loop on collision.** Rejected: `TaskQueue.ensureUniqueNames` already appends `-<counter>` suffixes.

## Lowest Confidence Area

The interaction between `toolType: 'claude'` + `prompt: ''` and downstream panel auto-creation. TaskQueue.createSession's panel-start block is gated by `if (prompt && prompt.trim().length > 0)`, so an empty-prompt 'claude' quick session correctly skips Claude panel auto-start. The existing `sessions:input` handler will create a Claude panel on demand when the user sends their first message. If TASK-747/TASK-749 discover that an explicit empty Claude panel must be pre-created at quick-session creation time, this handler will need a follow-up to call `panelManager.createPanel(...)` after `taskQueue.createSession` resolves.
