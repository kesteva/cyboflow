---
id: TASK-758
idea: IDEA-025
status: ready
created: "2026-05-26T00:00:00Z"
files_owned:
  - main/src/orchestrator/questionRouter.ts
  - main/src/orchestrator/questionCreatedBridge.ts
  - main/src/orchestrator/preToolUseHookHelper.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/__tests__/questionRouter.test.ts
  - main/src/orchestrator/__tests__/questionCreatedBridge.test.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - claudeCodeManager.ts
  - questionRouter.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/approvalCreatedBridge.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
  - main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts
  - shared/types/questions.ts
  - shared/types/approval.ts
  - shared/types/approvals.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/database/migrations/010_questions.sql
  - .soloflow/active/research/IDEA-025-research.md
acceptance_criteria:
  - criterion: "main/src/orchestrator/questionRouter.ts exports a singleton class QuestionRouter with static initialize(db, getQueueForRun), static getInstance(), static _resetForTesting(), instance methods requestQuestion(runId, toolUseId, questions, socketReply), respond(questionId, answer), clearPendingForRun(runId), recoverStaleAwaitingInput(), and getPending()."
    verification: "grep -nE 'class QuestionRouter|static initialize|static getInstance|static _resetForTesting|requestQuestion\\(|respond\\(|clearPendingForRun\\(|recoverStaleAwaitingInput\\(|getPending\\(' main/src/orchestrator/questionRouter.ts shows all nine declarations."
  - criterion: "QuestionRouter uses its own per-run PQueue map (questionQueues) distinct from RunQueueRegistry, with a getQuestionQueue(runId) helper, matching the deadlock-safety invariant documented in approvalRouter.ts §3."
    verification: "grep -nE 'questionQueues|new PQueue' main/src/orchestrator/questionRouter.ts shows the per-run PQueue map declaration and instantiation. A header comment block in questionRouter.ts cites the same deadlock invariant (string match: 'self-deadlock' or 'no-recursive-enqueue')."
  - criterion: "QuestionRouter.requestQuestion writes the questions row and updates workflow_runs.status to 'awaiting_input' inside a single db.transaction() guarded by WHERE id=? AND status='running' on the UPDATE. The transaction throws RunNotRunningError when changes=0."
    verification: "grep -n 'awaiting_input' main/src/orchestrator/questionRouter.ts shows the status transition. grep -n 'transaction' main/src/orchestrator/questionRouter.ts shows the wrapping txn. grep -n 'RunNotRunningError' main/src/orchestrator/questionRouter.ts shows the guard."
  - criterion: "QuestionRouter.respond updates workflow_runs.status from 'awaiting_input' back to 'running' inside a guarded UPDATE (WHERE id=? AND status='awaiting_input'), writes answer_json + answered_at to the questions row, resolves the pending promise with the user's QuestionAnswer payload, and emits 'questionAnswered'."
    verification: "grep -nE \"UPDATE workflow_runs SET status = 'running'.*WHERE id = \\? AND status = 'awaiting_input'\" main/src/orchestrator/questionRouter.ts shows the guarded update. grep -n \"questionAnswered\" main/src/orchestrator/questionRouter.ts shows the event emit."
  - criterion: "QuestionRouter.clearPendingForRun(runId) is synchronous (returns void), resolves each pending entry with a synthetic empty-answers payload, runs a guarded UPDATE on questions (WHERE id=? AND status='pending'), swallows DB errors with console.warn, and emits 'questionAnswered' per cleared entry."
    verification: "grep -nE 'clearPendingForRun.*runId.*string.*\\):\\s*void' main/src/orchestrator/questionRouter.ts shows the signature. grep -nE \"WHERE id = \\? AND status = 'pending'\" main/src/orchestrator/questionRouter.ts shows the guarded update."
  - criterion: "main/src/orchestrator/questionCreatedBridge.ts exports buildQuestionCreatedEvent(request, db) that resolves workflowName via the same JOIN pattern as buildApprovalCreatedEvent and returns a QuestionCreatedEvent with non-throwing missing-row fallback that emits console.warn."
    verification: "grep -nE 'export function buildQuestionCreatedEvent' main/src/orchestrator/questionCreatedBridge.ts shows the export. grep -n 'JOIN workflows' main/src/orchestrator/questionCreatedBridge.ts shows the JOIN."
  - criterion: "main/src/services/panels/claude/claudeCodeManager.ts makePreToolUseHook branches on pretool.tool_name === 'AskUserQuestion' before delegating; the AskUserQuestion branch calls QuestionRouter.getInstance().requestQuestion(...) and returns { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { questions, answers } } }. The non-AskUserQuestion path still calls routePreToolUseThroughApprovalRouter."
    verification: "grep -nE \"tool_name === 'AskUserQuestion'\" main/src/services/panels/claude/claudeCodeManager.ts shows the branch. grep -nE 'QuestionRouter.getInstance\\(\\)\\.requestQuestion' main/src/services/panels/claude/claudeCodeManager.ts shows the routing call. grep -nE 'permissionDecision: .allow.' main/src/services/panels/claude/claudeCodeManager.ts shows the allow output. grep -nE 'updatedInput:' main/src/services/panels/claude/claudeCodeManager.ts shows the updatedInput field. grep -nE 'routePreToolUseThroughApprovalRouter' main/src/services/panels/claude/claudeCodeManager.ts still appears for the non-AskUserQuestion path."
  - criterion: "claudeCodeManager.runSdkQuery's finally block calls QuestionRouter.getInstance().clearPendingForRun(panelId) immediately after the existing ApprovalRouter.getInstance().clearPendingForRun(panelId) call."
    verification: "grep -nC2 'QuestionRouter.getInstance\\(\\)\\.clearPendingForRun\\(panelId\\)' main/src/services/panels/claude/claudeCodeManager.ts shows the call adjacent to (within 2 lines of) the existing ApprovalRouter clearPendingForRun call."
  - criterion: "claudeCodeManager.buildSdkOptions sets sdkOptions.toolConfig = { askUserQuestion: { previewFormat: 'markdown' } } unconditionally (regardless of permissionMode)."
    verification: "grep -nE \"toolConfig:.*askUserQuestion.*previewFormat:.*'markdown'\" main/src/services/panels/claude/claudeCodeManager.ts shows the option (the match may span lines; allow grep -n 'toolConfig' AND grep -n \"previewFormat: 'markdown'\" both to return at least one hit in claudeCodeManager.ts)."
  - criterion: "preToolUseHookHelper.ts is unchanged in behavior for the non-AskUserQuestion path — its public signature (routePreToolUseThroughApprovalRouter) and ApprovalRouter delegation are untouched; the AskUserQuestion logic lives in claudeCodeManager.makePreToolUseHook, not in this helper."
    verification: "grep -nE 'export async function routePreToolUseThroughApprovalRouter' main/src/orchestrator/preToolUseHookHelper.ts shows the signature unchanged. grep -n 'AskUserQuestion' main/src/orchestrator/preToolUseHookHelper.ts returns zero hits."
  - criterion: "Unit tests in main/src/orchestrator/__tests__/questionRouter.test.ts cover: (a) requestQuestion inserts questions row + sets workflow_runs.status='awaiting_input' in a single transaction; (b) respond returns workflow_runs.status='running' and writes answer_json; (c) two concurrent requestQuestion calls for the same runId are serialized by the per-run queue; (d) clearPendingForRun resolves pending entries with empty-answers payload and updates DB rows."
    verification: "grep -nE \"it\\(.*('requestQuestion|'respond|'concurrent|'clearPendingForRun)\" main/src/orchestrator/__tests__/questionRouter.test.ts shows at least four matching it() blocks. pnpm --filter main vitest run questionRouter exits 0."
  - criterion: "Unit tests in main/src/orchestrator/__tests__/questionCreatedBridge.test.ts cover positive workflowName resolution, missing-row fallback (returns workflowName='' with console.warn, no throw), and field completeness on the returned QuestionCreatedEvent."
    verification: "grep -nE \"it\\(.*(positive|missing-row|field completeness)\" main/src/orchestrator/__tests__/questionCreatedBridge.test.ts shows at least three matching it() blocks. pnpm --filter main vitest run questionCreatedBridge exits 0."
  - criterion: "Both questionRouter.test.ts and questionCreatedBridge.test.ts use createTestDb({ includeQuestionsTable: true }) (or equivalent option) to load migration 010's schema; createTestDb signature in orchestratorTestDb.ts gains an opt-in includeQuestionsTable boolean that applies migration 010's CREATE TABLE questions + workflow_runs CHECK-constraint recreate on top of GATE_SCHEMA. GATE_SCHEMA itself is unchanged so the GATE_SCHEMA parity test in __test_fixtures__/__tests__/orchestratorTestDb.test.ts still passes."
    verification: "grep -nE 'includeQuestionsTable' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts shows the option. grep -nE 'CREATE TABLE.*questions' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts OR the option dispatches to migration-010 SQL applied after GATE_SCHEMA. pnpm --filter main vitest run orchestratorTestDb exits 0 (parity test still green)."
  - criterion: "pnpm --filter main typecheck exits 0 — the file compiles standalone with the standalone-typecheck invariant preserved (no imports from 'electron', 'better-sqlite3', or main/src/services/*) in questionRouter.ts and questionCreatedBridge.ts."
    verification: "grep -nE \"from 'electron'|from 'better-sqlite3'|from '\\.\\./services/\" main/src/orchestrator/questionRouter.ts main/src/orchestrator/questionCreatedBridge.ts returns zero matches. pnpm --filter main typecheck exits 0."
  - criterion: "pnpm test:unit exits 0 with no regression in the existing approval-router test suite, claudeCodeManager wiring suite, or the GATE_SCHEMA parity test."
    verification: "pnpm test:unit exits 0."
depends_on:
  - TASK-757
estimated_complexity: high
epic: ask-user-question-roundtrip
test_strategy:
  needed: true
  justification: "QuestionRouter is the load-bearing main-process pivot for the entire AskUserQuestion round-trip; the hook intercept, status transition guards, per-run serialization, and DB writes must each be exercised under unit-test conditions before TASK-759 wires tRPC on top. The bridge has the same missing-row failure mode as the approval bridge and warrants the same coverage."
  targets:
    - behavior: "requestQuestion inserts a questions row (status='pending') and sets workflow_runs.status='awaiting_input' atomically in a single transaction (guarded by status='running')"
      test_file: main/src/orchestrator/__tests__/questionRouter.test.ts
      type: unit
    - behavior: "respond writes answer_json + answered_at, transitions workflow_runs.status back to 'running' under the awaiting_input guard, and resolves the pending promise with the user's QuestionAnswer payload"
      test_file: main/src/orchestrator/__tests__/questionRouter.test.ts
      type: unit
    - behavior: Two concurrent requestQuestion calls for the same runId are serialized by the per-run questionQueues (no overlapping transactions; serial ordering preserved)
      test_file: main/src/orchestrator/__tests__/questionRouter.test.ts
      type: unit
    - behavior: "clearPendingForRun(runId) resolves each pending entry's promise with a synthetic empty-answers payload, runs the guarded UPDATE on questions, swallows DB errors, and emits questionAnswered"
      test_file: main/src/orchestrator/__tests__/questionRouter.test.ts
      type: unit
    - behavior: respond on a question whose run was concurrently canceled (status no longer awaiting_input) does NOT revive the run and still resolves the awaiting caller with a synthetic empty payload
      test_file: main/src/orchestrator/__tests__/questionRouter.test.ts
      type: unit
    - behavior: buildQuestionCreatedEvent resolves workflowName via JOIN when the workflow_runs row exists
      test_file: main/src/orchestrator/__tests__/questionCreatedBridge.test.ts
      type: unit
    - behavior: "buildQuestionCreatedEvent returns workflowName='' with console.warn (no throw) when the workflow row is missing"
      test_file: main/src/orchestrator/__tests__/questionCreatedBridge.test.ts
      type: unit
    - behavior: "buildQuestionCreatedEvent populates id, runId, toolUseId, questions, createdAt, and status='pending' on the returned QuestionCreatedEvent"
      test_file: main/src/orchestrator/__tests__/questionCreatedBridge.test.ts
      type: unit
---
# QuestionRouter Singleton, PreToolUse Hook Intercept, and SDK toolConfig Wiring

## Objective

Implement the main-process half of the AskUserQuestion round-trip. Create `QuestionRouter` (a singleton mirroring `ApprovalRouter` line-for-line for shape: per-run PQueue, pending Map, requestQuestion/respond/clearPendingForRun/recoverStaleAwaitingInput, EventEmitter for `questionCreated`/`questionAnswered`); create `questionCreatedBridge.ts` to enrich the in-memory request with workflowName for the renderer event; surgically branch `claudeCodeManager.makePreToolUseHook` to route `tool_name === 'AskUserQuestion'` to `QuestionRouter` and return the SDK's `updatedInput: { questions, answers }` shape; wire `clearPendingForRun` into `runSdkQuery`'s finally block; and enable `Options.toolConfig.askUserQuestion.previewFormat = 'markdown'` so the model emits `preview` strings. tRPC procedures and renderer wiring are out of scope (TASK-759 / TASK-760). DB schema (questions table, awaiting_input status) is out of scope (TASK-757).

## Implementation Steps

1. **Confirm dependencies are landed.** TASK-757 must already have created `shared/types/questions.ts` (exporting `QuestionRequest`, `QuestionAnswer`, `Question`, `QuestionCreatedEvent`, `QuestionAnsweredEvent`, `QuestionPayload`) and `main/src/database/migrations/010_questions.sql` (creating the `questions` table and recreating `workflow_runs` with the `awaiting_input` value added to the status CHECK constraint). If either is missing, stop and re-coordinate — do not write any of the files below speculatively.

2. **Create `main/src/orchestrator/questionRouter.ts`.** Copy the structure of `main/src/orchestrator/approvalRouter.ts` verbatim and adapt each section:
   - Top-of-file invariant comment block: copy verbatim from approvalRouter.ts §1–§5 with these substitutions: "approvals" → "questions", "ApprovalRouter" → "QuestionRouter", "awaiting_review" → "awaiting_input", and append a §6 noting that the user's answer flows back to the SDK through the `PreToolUse` hook's `updatedInput: { questions, answers }` payload (NOT through an injected tool_result), citing `.soloflow/active/research/IDEA-025-research.md` "Answered Questions".
   - Imports: `EventEmitter` from `node:events`, `randomUUID` from `node:crypto`, `PQueue` from `p-queue`, `DatabaseLike` from `./types`, and `QuestionRequest`, `QuestionAnswer` types from `../../../shared/types/questions`. NO imports from `electron`, `better-sqlite3`, or `main/src/services/*` — standalone-typecheck invariant.
   - Errors: `RunNotRunningError` (re-use semantics, duplicate class name is fine here since this file is independent — declare a parallel `RunNotRunningError` class to avoid coupling to approvalRouter) and `QuestionNotFoundError`.
   - `PendingEntry`: `{ request: QuestionRequest; socketReply: (answer: QuestionAnswer) => void; resolve: (answer: QuestionAnswer) => void; reject: (err: unknown) => void; }`.
   - `class QuestionRouter extends EventEmitter` with:
     - `private static instance: QuestionRouter | null = null;`
     - `private pending = new Map<string, PendingEntry>();`
     - `private questionQueues = new Map<string, PQueue>();` plus a `getQuestionQueue(runId)` helper.
     - Constructor `(private readonly db: DatabaseLike, _getQueueForRun: (runId: string) => PQueue)` — the second arg is retained for parity with ApprovalRouter even though the per-run queue lives inside this class.
     - `static initialize(db, getQueueForRun): QuestionRouter`, `static getInstance(): QuestionRouter`, `static _resetForTesting(): void`.
     - `async requestQuestion(runId: string, toolUseId: string, questions: QuestionPayload[], socketReply: (answer: QuestionAnswer) => void): Promise<QuestionAnswer>` — generates `questionId = randomUUID()`, builds a `QuestionRequest`, captures resolve/reject in a Promise, enqueues the txn on `getQuestionQueue(runId)`. The txn: (1) `UPDATE workflow_runs SET status='awaiting_input', updated_at=? WHERE id=? AND status='running'` — throw `RunNotRunningError` if `changes === 0`; (2) `INSERT INTO questions (id, run_id, tool_use_id, questions_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`. After commit, set `this.pending.set(questionId, entry)` and `this.emit('questionCreated', request)`. Return the promise.
     - `async respond(questionId: string, answer: QuestionAnswer): Promise<void>` — fast-path lookup (throw `QuestionNotFoundError` if absent). Enqueue on the run's questionQueue; re-fetch the entry (silent no-op if already settled); `this.pending.delete(questionId)`; guarded `UPDATE workflow_runs SET status='running', updated_at=? WHERE id=? AND status='awaiting_input'`. If `changes === 0` (run was canceled concurrently), set the questions row to status='timed_out' (no schema change needed — TASK-757's questions table supports 'pending'|'answered'|'timed_out' per the IDEA's slice 2 description) and resolve the promise with a synthetic empty-answers payload. Otherwise: `UPDATE questions SET status='answered', answered_at=?, answer_json=? WHERE id=?`, call `resolve(answer)`, call `socketReply(answer)`, and `this.emit('questionAnswered', { questionId, answer, decision: 'answered' })`.
     - `clearPendingForRun(runId: string): void` — synchronous; iterate `this.pending` collecting entries where `entry.request.runId === runId`; for each: delete from map, run guarded `UPDATE questions SET status='timed_out', answered_at=? WHERE id=? AND status='pending'` inside a try/catch that warns on failure, resolve the promise with `{ answers: {} } as QuestionAnswer`, emit `'questionAnswered'`. Do NOT call `socketReply`.
     - `recoverStaleAwaitingInput(): number` — boot-time recovery mirroring `recoverStaleAwaitingReview` in approvalRouter.ts. Transition workflow_runs with status='awaiting_input' to 'failed' with `error_message='app_restart'`, flip orphaned pending questions to 'timed_out'. Return the count.
     - `getPending(): QuestionRequest[]` — snapshot for the renderer subscription.

3. **Create `main/src/orchestrator/questionCreatedBridge.ts`.** Mirror `approvalCreatedBridge.ts`:
   - Export `buildQuestionCreatedEvent(request: QuestionRequest, db: DatabaseLike): QuestionCreatedEvent`.
   - Run the same `SELECT w.name AS name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?` lookup wrapped in try/catch; on missing row or DB error, set `workflowName = ''` and `console.warn` (do NOT throw).
   - Return `{ question: { id: request.id, runId: request.runId, workflowName, toolUseId: request.toolUseId, questions: request.questions, createdAt: new Date(request.timestamp).toISOString(), status: 'pending' } }` (final shape comes from `shared/types/questions.ts` — match whatever `QuestionCreatedEvent` shape TASK-757 ships).
   - Standalone-typecheck invariant: NO imports from electron / better-sqlite3 / services.

4. **Branch `main/src/services/panels/claude/claudeCodeManager.ts` `makePreToolUseHook`.** Current code (line 530–536) calls `routePreToolUseThroughApprovalRouter` unconditionally. Rewrite to:
   ```ts
   private makePreToolUseHook(panelId: string): HookCallback {
     const loggerLike = makeLoggerLike(this.logger);
     return async (input, _toolUseId, _ctx) => {
       const pretool = input as PreToolUseHookInput;
       if (pretool.tool_name === 'AskUserQuestion') {
         return this.routeAskUserQuestion(pretool, panelId, loggerLike);
       }
       return routePreToolUseThroughApprovalRouter(pretool, panelId, 'ClaudeCodeManager', loggerLike);
     };
   }
   ```
   Add a private helper:
   ```ts
   private async routeAskUserQuestion(
     pretool: PreToolUseHookInput,
     panelId: string,
     loggerLike: LoggerLike,
   ): Promise<HookJSONOutput> {
     try {
       const input = pretool.tool_input as { questions: QuestionPayload[] };
       const answer = await QuestionRouter.getInstance().requestQuestion(
         panelId,
         pretool.tool_use_id,
         input.questions,
         () => {},
       );
       return {
         hookSpecificOutput: {
           hookEventName: 'PreToolUse' as const,
           permissionDecision: 'allow' as const,
           updatedInput: { questions: input.questions, answers: answer.answers, ...(answer.annotations ? { annotations: answer.annotations } : {}) },
         },
       };
     } catch (err) {
       loggerLike.error(
         `[ClaudeCodeManager] AskUserQuestion hook failed: ${err instanceof Error ? err.message : String(err)}`,
       );
       return {
         hookSpecificOutput: {
           hookEventName: 'PreToolUse' as const,
           permissionDecision: 'deny' as const,
           permissionDecisionReason: 'Internal question-router error',
         },
       };
     }
   }
   ```
   Add the import `import { QuestionRouter } from '../../../orchestrator/questionRouter';` near the existing `ApprovalRouter` import (line 13). Also import the `QuestionPayload` type from `../../../../../shared/types/questions`. Keep `routePreToolUseThroughApprovalRouter` imported and called for the non-AskUserQuestion branch — no change to `preToolUseHookHelper.ts`.

5. **Add `clearPendingForRun` for QuestionRouter in `runSdkQuery`'s finally block.** Open `claudeCodeManager.ts` line 385–398 (the `finally` block). Insert immediately after the existing `ApprovalRouter.getInstance().clearPendingForRun(panelId);` line:
   ```ts
   QuestionRouter.getInstance().clearPendingForRun(panelId);
   ```
   Update the surrounding comment to mention both routers.

6. **Enable `toolConfig.askUserQuestion.previewFormat = 'markdown'` in `buildSdkOptions`.** Open `claudeCodeManager.ts` line 405–432 (`buildSdkOptions`). Add inside the `sdkOptions: Options = { ... }` initializer, after `settingSources: ['project'],` and before the conditional `hooks` spread:
   ```ts
   toolConfig: {
     askUserQuestion: {
       previewFormat: 'markdown' as const,
     },
   },
   ```
   This is unconditional — even with `permissionMode: 'ignore'` (which omits the PreToolUse hook), the model can still emit `AskUserQuestion` and the SDK's built-in handler is the consumer; setting `previewFormat` does not couple to the hook path. Reference: sdk.d.ts line 5642–5656 (ToolConfig type) and research report "Best Practices — AskUserQuestion Interception".

7. **Extend the orchestrator test-DB fixture.** Open `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`. Add a new option to `CreateTestDbOptions`:
   ```ts
   /**
    * If true, additionally apply migration 010 (questions table + workflow_runs
    * status='awaiting_input'). Implemented as additive SQL on top of
    * GATE_SCHEMA — must NOT mutate GATE_SCHEMA itself or the parity test
    * in __tests__/orchestratorTestDb.test.ts will drift.
    */
   includeQuestionsTable?: boolean;
   ```
   In `createTestDb`, after the optional `includeStuckDetectedAt` block, add:
   ```ts
   if (options?.includeQuestionsTable) {
     // Read and apply migration 010 verbatim — single source of truth for the
     // questions schema and the workflow_runs CHECK-constraint recreate.
     const fs = require('node:fs');
     const path = require('node:path');
     const migration010Path = path.resolve(__dirname, '../../database/migrations/010_questions.sql');
     const sql = fs.readFileSync(migration010Path, 'utf8');
     db.exec(sql);
   }
   ```
   Do NOT modify GATE_SCHEMA. The parity test (`__tests__/orchestratorTestDb.test.ts`) keeps using zero-arg `createTestDb()` and stays green.

8. **Write `main/src/orchestrator/__tests__/questionRouter.test.ts`.** Model after `approvalRouter.test.ts`. Cases:
   - `requestQuestion inserts questions (pending) and sets workflow_runs to awaiting_input` — uses `createTestDb({ includeQuestionsTable: true })`, `seedRun(db, { id: runId, status: 'running' })`, calls `requestQuestion`, awaits the queue, asserts DB state.
   - `respond writes answer_json + answered_at and transitions workflow_runs back to running` — full happy path including assertion that the awaiting promise resolves with the user's answer.
   - `two concurrent requestQuestion calls for the same runId are serialized by the per-run queue` — fire two requests sequentially without await, assert they commit serially.
   - `clearPendingForRun resolves pending entries with empty-answers payload and updates DB rows to status='timed_out'`.
   - `respond after run is canceled does NOT revive the run and resolves the awaiting caller with empty-answers payload`.
   - Reset the singleton in `afterEach` via `QuestionRouter._resetForTesting()`.

9. **Write `main/src/orchestrator/__tests__/questionCreatedBridge.test.ts`.** Model after `approvalCreatedBridge.test.ts`. Cases:
   - `positive resolution: returns workflowName from DB when workflow row exists`.
   - `missing-row fallback: returns workflowName='' with console.warn, does not throw`.
   - `field completeness: id, runId, toolUseId, questions, createdAt, status='pending' all populated`.
   Use `createTestDb({ includeQuestionsTable: true })` so the questions table exists, though buildQuestionCreatedEvent only reads from workflow_runs/workflows.

10. **Run the full verifier gate.** From the repo root: `pnpm --filter main typecheck` then `pnpm test:unit`. Both must exit 0 with no new failures. Investigate any pre-existing failures separately; do NOT modify them in this task.

11. **Final guard — re-grep for AC parity.** Run each grep from the Acceptance Criteria block above against the modified tree. Confirm every grep returns the expected hits before marking COMPLETED.

## Acceptance Criteria

See frontmatter for the verifiable list. Each criterion is restated with pass/fail definition. The `pnpm test:unit` gate is the catch-all — any wiring error surfaces there.

## Test Strategy

See `test_strategy` in frontmatter. Two new test files (`questionRouter.test.ts`, `questionCreatedBridge.test.ts`) mirror their approval-router counterparts case-for-case. Both use the new `createTestDb({ includeQuestionsTable: true })` option that applies migration 010's SQL on top of GATE_SCHEMA without mutating GATE_SCHEMA itself. The wiring change in `claudeCodeManager.ts` is exercised indirectly by the existing `claudeCodeManagerWiring.test.ts` (`pnpm test:unit` runs it); no new wiring tests are required for TASK-758 because the hook branch is structurally trivial and the end-to-end PreToolUse path is verified at the wiring layer in subsequent tasks (TASK-759 onwards adds the tRPC procedures and broader integration coverage). If `claudeCodeManagerWiring.test.ts` flags a regression after this task's edits, that is a real signal — not a flake — and must be fixed before COMPLETED.

## Hardest Decision

**Whether to extract a shared `routeAskUserQuestion` helper into `preToolUseHookHelper.ts` (parallel to `routePreToolUseThroughApprovalRouter`) or keep the branch inline in `claudeCodeManager.makePreToolUseHook`.**

Chosen: keep it inline in `claudeCodeManager.ts` as a private `routeAskUserQuestion` method. Rationale:

1. `routePreToolUseThroughApprovalRouter` was extracted because it had TWO call sites (`permissionModeMapper.deferToApprovalRouter` and `claudeCodeManager.makePreToolUseHook`). The AskUserQuestion path has ONE call site — `claudeCodeManager.makePreToolUseHook` — because `permissionModeMapper` operates on the approval/permission axis only. Extracting a helper with one caller is premature abstraction.
2. The AskUserQuestion hook return shape (`updatedInput: { questions, answers }`) is fundamentally different from the approval allow/deny shape — folding both into a single helper would require a discriminated union for the return type and would obscure the SDK contract rather than clarify it.
3. The skeleton's `files_owned_hint` lists `questionRouter.ts` and `questionCreatedBridge.ts`; `preToolUseHookHelper.ts` was a readonly hint. Promoting it to owned-and-modified for a single conditional would inflate the blast radius without payoff. The orchestrator note correctly flagged that the helper file MAY need to be modified, but careful design shows it does NOT — the branch lives one layer up in the hook factory, leaving the helper's existing single-purpose contract intact.

If a future task adds a second consumer of the AskUserQuestion hook path (e.g. `permissionModeMapper` learns to defer questions too), extract then.

## Rejected Alternatives

**(a) Have `QuestionRouter.respond` write the SDK tool_result message directly into the event stream** — rejected because the research report (Answered Questions, Q2) explicitly states the SDK synthesizes the tool_result from `updatedInput.answers`; injecting our own tool_result would either duplicate or conflict with the SDK's own emission. Would only reconsider if the SDK doc behavior changes in a future version — re-validate against `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@*/sdk.d.ts` line 1999–2005 before that.

**(b) Use a single PQueue per `runId` shared across ApprovalRouter and QuestionRouter** — rejected because they have independent semantics (an approval gate and a question can coexist as far as the SDK is concerned; serializing them through one queue would unnecessarily couple two unrelated mutation streams). Would reconsider only if a deadlock or race is observed between concurrent approval+question mutations on the same run — re-evaluate after TASK-759/TASK-760 are integrated.

**(c) Skip the `toolConfig` step (defer it to TASK-760 where the renderer renders previews)** — rejected because without it, the model never emits `preview` fields and the renderer's preview panel in TASK-760 would silently render nothing during integration testing, blocking that task's verification. Keeping it in TASK-758 closes the loop at the SDK options layer. Would reconsider only if `previewFormat: 'markdown'` turns out to interact badly with workflow runs that do not use AskUserQuestion (no evidence today — the field is gated behind a tool the model only emits when prompted).

**(d) Add `routeAskUserQuestion` to `preToolUseHookHelper.ts`** — see Hardest Decision; rejected for the reasons listed there.

## Lowest Confidence Area

**Whether `QuestionRouter.respond` should call `socketReply(answer)` at all.** ApprovalRouter calls `socketReply(decision)` for transport adapters that historically delivered the decision over a Unix socket back to the agent. The SDK PreToolUse path makes `socketReply` a documented no-op (closure `() => {}`), kept only for backward compatibility with any future non-SDK transport. QuestionRouter follows the same pattern, but the IDEA and research confirm the SDK is the only transport for AskUserQuestion (no MCP bridge equivalent). Keeping `socketReply` for parity is harmless but technically dead code. The reviewer may ask to remove it; if so, drop the field from `PendingEntry`, drop the constructor arg from `requestQuestion`, and update the call site in `claudeCodeManager.routeAskUserQuestion` to omit the closure. Tracked as a minor refactor opportunity, not a correctness concern. Either choice ships a working round-trip — picking parity with ApprovalRouter is the conservative call until QuestionRouter's transport surface is fully exercised in TASK-759.
