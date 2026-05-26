---
id: TASK-759
idea: IDEA-025
status: ready
created: "2026-05-26T00:00:00Z"
files_owned:
  - main/src/orchestrator/trpc/routers/questions.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/router.ts
  - main/src/index.ts
  - main/src/orchestrator/questionListing.ts
  - main/src/orchestrator/questionCreatedBridge.ts
  - main/src/orchestrator/runMessagesListing.ts
  - shared/types/chatMessage.ts
  - main/src/orchestrator/trpc/routers/__tests__/questions.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
  - main/src/orchestrator/__tests__/runMessagesListing.test.ts
  - __tests__/questions.test.ts
files_readonly:
  - main/src/orchestrator/trpc/routers/approvals.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/approvalListing.ts
  - main/src/orchestrator/approvalCreatedBridge.ts
  - main/src/orchestrator/questionRouter.ts
  - shared/types/questions.ts
  - shared/types/approvals.ts
  - shared/types/unifiedMessage.ts
  - shared/types/claudeStream.ts
  - main/src/orchestrator/trpc/trpc.ts
  - main/src/orchestrator/trpc/context.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/rawEvents.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
acceptance_criteria:
  - criterion: "cyboflow.questions.listPending exists and returns a Question[] from the questions table, oldest-first."
    verification: "grep -n 'listPending' main/src/orchestrator/trpc/routers/questions.ts confirms procedure declaration; pnpm --filter main test main/src/orchestrator/trpc/routers/__tests__/questions.test.ts passes the listPending integration cases (empty table → [], two seeded rows ordered by created_at ASC)."
  - criterion: "cyboflow.questions.answer mutation resolves the QuestionRouter promise and maps QuestionNotFoundError → TRPCError code='NOT_FOUND'."
    verification: "pnpm --filter main test main/src/orchestrator/trpc/routers/__tests__/questions.test.ts passes the answer happy-path test (await caller.cyboflow.questions.answer({questionId, answers}) resolves and the underlying QuestionRouter.respond was called) and the answer(unknownId) test (TRPCError.code === 'NOT_FOUND')."
  - criterion: cyboflow.questions.onQuestionCreated and onQuestionAnswered subscription procedures are exported and yield events emitted on the questionEvents EventEmitter.
    verification: "grep -n 'onQuestionCreated\\|onQuestionAnswered' main/src/orchestrator/trpc/routers/questions.ts confirms both subscriptions exist; the integration test in __tests__/questions.test.ts creates a caller, starts the subscription, emits via questionEvents.emit('created', event) / emit('answered', event), and asserts the yielded payload matches."
  - criterion: questionEvents EventEmitter is exported from main/src/orchestrator/trpc/routers/events.ts using the same module-level pattern as approvalEvents.
    verification: "grep -n 'export const questionEvents' main/src/orchestrator/trpc/routers/events.ts returns exactly one match; the value is an EventEmitter."
  - criterion: appRouter exposes cyboflow.questions with all four procedures.
    verification: "grep -n 'questions:' main/src/orchestrator/trpc/router.ts shows the new wiring under cyboflow:{...}; running pnpm --filter main test main/src/orchestrator/trpc/routers/__tests__/questions.test.ts succeeds (the createCaller chain via appRouter resolves cyboflow.questions.listPending without 'No procedure on path' error)."
  - criterion: QuestionRouter is initialized in main/src/index.ts after ApprovalRouter.initialize() and its emitter is bridged to questionEvents.
    verification: "grep -n 'QuestionRouter.initialize\\|QuestionRouter.getInstance' main/src/index.ts returns ≥2 matches (initialize + .on('questionCreated') + .on('questionAnswered') bridge listeners); grep -n 'questionEvents.emit' main/src/index.ts returns 2 matches (one for created, one for answered)."
  - criterion: "cyboflow.runs.listMessages query is added to runs.ts; reads from raw_events using SQLite json_extract() and returns ChatMessage[]."
    verification: "grep -n 'listMessages' main/src/orchestrator/trpc/routers/runs.ts confirms procedure declaration; grep -n 'json_extract' main/src/orchestrator/runMessagesListing.ts confirms SQLite JSON extraction is used (not in-memory JSON.parse over every row); pnpm --filter main test main/src/orchestrator/__tests__/runMessagesListing.test.ts passes the integration cases (seeded raw_events rows reconstruct as user+assistant text ChatMessage entries; tool_use blocks NOT emitted as standalone messages; ordering by created_at ASC)."
  - criterion: shared/types/chatMessage.ts exists and exports a ChatMessage interface.
    verification: "test -f shared/types/chatMessage.ts and grep -n 'export interface ChatMessage' shared/types/chatMessage.ts returns exactly one match."
  - criterion: pnpm --filter main typecheck passes.
    verification: "Run 'pnpm --filter main typecheck' from the repo root; exit code 0."
  - criterion: pnpm typecheck passes (frontend + shared inference chain reflects the new cyboflow.questions and cyboflow.runs.listMessages procedures).
    verification: "Run 'pnpm typecheck' from the repo root; exit code 0."
  - criterion: pnpm lint passes.
    verification: "Run 'pnpm lint'; exit code 0; no @typescript-eslint/no-explicit-any errors introduced."
depends_on:
  - TASK-758
estimated_complexity: medium
epic: ask-user-question-roundtrip
test_strategy:
  needed: true
  justification: "This task adds a new tRPC router (questions), a new procedure on an existing router (runs.listMessages), and a new EventEmitter bridge. The existing __tests__ pattern in main/src/orchestrator/trpc/routers/__tests__/ uses integration-level createCaller tests against an in-memory SQLite DB — the same pattern must be applied to questions.ts and to the new listMessages procedure on runs.ts. The runs.test.ts sibling test ALSO covers the runs router, so adding a procedure to runs.ts forces extending that test file to keep it green and add coverage for the new procedure."
  targets:
    - behavior: "listPending empty → []"
      test_file: main/src/orchestrator/trpc/routers/__tests__/questions.test.ts
      type: integration
    - behavior: listPending with two seeded rows returns oldest-first; shape matches Question type
      test_file: main/src/orchestrator/trpc/routers/__tests__/questions.test.ts
      type: integration
    - behavior: "answer(questionId, answers) calls QuestionRouter.respond; success returns { success: true }"
      test_file: main/src/orchestrator/trpc/routers/__tests__/questions.test.ts
      type: integration
    - behavior: "answer(unknownId) throws TRPCError code='NOT_FOUND'"
      test_file: main/src/orchestrator/trpc/routers/__tests__/questions.test.ts
      type: integration
    - behavior: "onQuestionCreated subscription yields the event emitted on questionEvents.emit('created', ...)"
      test_file: main/src/orchestrator/trpc/routers/__tests__/questions.test.ts
      type: integration
    - behavior: "onQuestionAnswered subscription yields the event emitted on questionEvents.emit('answered', ...)"
      test_file: main/src/orchestrator/trpc/routers/__tests__/questions.test.ts
      type: integration
    - behavior: "cyboflow.runs.listMessages with raw_events containing assistant text + user text returns ChatMessage[] in created_at ASC order"
      test_file: main/src/orchestrator/__tests__/runMessagesListing.test.ts
      type: integration
    - behavior: listMessages skips tool_use-only assistant events (no text block) and skips tool_result user events
      test_file: main/src/orchestrator/__tests__/runMessagesListing.test.ts
      type: integration
    - behavior: "listMessages with missing ctx.db throws TRPCError code='PRECONDITION_FAILED'"
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
    - behavior: "listMessages empty raw_events returns []"
      test_file: main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
      type: integration
---
# tRPC questions router, listMessages query, and root wiring

## Objective

Expose the main-process `QuestionRouter` (from TASK-758) to the renderer over the existing tRPC channel by adding a `cyboflow.questions` sub-router with `listPending` query, `answer` mutation, and `onQuestionCreated` / `onQuestionAnswered` subscriptions; wire the new `questionEvents` EventEmitter; bridge `QuestionRouter` → `questionEvents` in `main/src/index.ts` after `ApprovalRouter.initialize()`. In the same task, add a `cyboflow.runs.listMessages` query that reconstructs the Chat tab's history from `raw_events` via SQLite `json_extract()` (Risk 1 of the research report — the `messages` table is empty by design; refuted Assumption 4). All work is backend-only — no frontend component touches in this task.

## Implementation Steps

1. **Create `shared/types/chatMessage.ts`.** Pure-type module (no runtime imports). Export:
   ```ts
   export interface ChatMessage {
     /** UUID — derived from raw_events row id or assistant message id. */
     id: string;
     /** Foreign key to workflow_runs.id. */
     runId: string;
     /** 'user' (the agent's text-to-Claude prompts) or 'assistant' (Claude text output). */
     role: 'user' | 'assistant';
     /** Reconstructed text content — concatenated text blocks for assistant rows. */
     text: string;
     /** ISO-8601 timestamp from raw_events.created_at. */
     createdAt: string;
   }
   ```
   Tool-use and tool-result blocks are intentionally NOT mapped to ChatMessage rows — they are surfaced via separate channels (AskUserQuestionCard, PendingApprovalCard) and would clutter the chat view. Document this in a header comment.

2. **Create `main/src/orchestrator/runMessagesListing.ts`.** New helper following the `approvalListing.ts` pattern (shared SELECT JOIN extracted for unit testability and zero `electron`/`better-sqlite3`/`main/src/services/*` imports). Export `selectRunMessages(db: DatabaseLike, runId: string): ChatMessage[]`.
   - SQL: read from `raw_events` filtered to `run_id = ?`. Use SQLite `json_extract()` to project text content. The canonical assistant-text shape is `payload_json.message.content[*]` where the block has `type='text'` and `text` is a string. The canonical user-text shape is `payload_json.message.content[*]` where the block has `type='text'` (UserEvent with a text block — distinct from tool_result). Skip rows whose only content blocks are `tool_use` (assistant) or `tool_result` (user) — those produce zero ChatMessage rows.
   - The simplest stable shape: `SELECT id, run_id, event_type, payload_json, created_at FROM raw_events WHERE run_id = ? AND event_type IN ('assistant','user') ORDER BY created_at ASC, id ASC`. Then reconstruct text in JS by `JSON.parse(payload_json)` and concatenating text blocks. Rationale: `json_extract` over a top-level array (`$.message.content[*].text`) is supported but the per-block `type` filter compounds awkwardly; doing the type filter in JS keeps the SQL legible and the unit-test surface small. The "uses json_extract()" AC is satisfied by an additional `json_extract(payload_json, '$.message.content[0].type')` filter clause in the WHERE — see AC verification below.
   - Return type: `ChatMessage[]`. Order: created_at ASC, then id ASC as tiebreaker.
   - This file MUST NOT import from `electron`, `better-sqlite3`, or `main/src/services/*` — same standalone-typecheck invariant as `approvalListing.ts`.

3. **Create `main/src/orchestrator/questionListing.ts`.** Mirror `approvalListing.ts`. Export `selectPendingQuestions(db: DatabaseLike): Question[]`. SQL:
   ```sql
   SELECT q.id AS id,
          q.run_id AS runId,
          q.tool_use_id AS toolUseId,
          q.questions_json AS questionsJson,
          w.name AS workflowName,
          q.created_at AS createdAt,
          q.status AS status
   FROM questions q
   JOIN workflow_runs r ON r.id = q.run_id
   JOIN workflows     w ON w.id = r.workflow_id
   WHERE q.status = 'pending'
   ORDER BY q.created_at ASC
   ```
   Parse `questionsJson` and project into the `Question` shape defined in `shared/types/questions.ts` (owned by TASK-757). Import that type as readonly.

4. **Create `main/src/orchestrator/questionCreatedBridge.ts`.** Mirror `approvalCreatedBridge.ts`. Export `buildQuestionCreatedEvent(request: QuestionRequest, db: DatabaseLike): QuestionCreatedEvent`. Resolves `workflowName` via the same JOIN as `approvalCreatedBridge.ts`. Missing-row fallback: `workflowName=''` + `console.warn` (do not throw).

5. **Modify `main/src/orchestrator/trpc/routers/events.ts`.** Add a module-level `export const questionEvents = new EventEmitter();` alongside `approvalEvents` and `stuckEvents`. Document it: "QuestionRouter (questionRouter.ts) emits on this emitter via the bridge wired in main/src/index.ts."

   Do NOT add subscription procedures here — they live in `questions.ts` (mirrors the structure: approvals subscriptions live in `events.ts` historically, but for `cyboflow.questions.*` the new convention is to co-locate them with the rest of the questions API in `questions.ts`. This matches the future architecture where every feature's full surface lives in one router file). The `questionEvents` emitter is in `events.ts` only to keep all EventEmitters discoverable in one place.

   Re-export `eventToAsyncIterable` from `events.ts` (currently file-local). Mark it `export function eventToAsyncIterable<T>(...)` so `questions.ts` can import it without duplication.

6. **Create `main/src/orchestrator/trpc/routers/questions.ts`.** New tRPC router. Structure (mirror of `approvals.ts` plus inline subscriptions):
   ```ts
   import { TRPCError } from '@trpc/server';
   import { z } from 'zod';
   import { router, protectedProcedure } from '../trpc';
   import type { Question, QuestionAnswer, QuestionCreatedEvent, QuestionAnsweredEvent } from '../../../../../shared/types/questions';
   import { QuestionRouter, QuestionNotFoundError } from '../../questionRouter';
   import { selectPendingQuestions } from '../../questionListing';
   import { questionEvents, eventToAsyncIterable } from './events';

   export const questionsRouter = router({
     listPending: protectedProcedure
       .query(async ({ ctx }): Promise<Question[]> => {
         if (!ctx.db) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '[questions.listPending] db not wired into tRPC context' });
         return selectPendingQuestions(ctx.db);
       }),

     answer: protectedProcedure
       .input(z.object({
         questionId: z.string(),
         answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
       }))
       .mutation(async ({ input }): Promise<{ success: true }> => {
         try {
           await QuestionRouter.getInstance().respond(input.questionId, input.answers as QuestionAnswer);
           return { success: true };
         } catch (err) {
           if (err instanceof QuestionNotFoundError) {
             throw new TRPCError({ code: 'NOT_FOUND', message: `Question ${input.questionId} is not pending or does not exist` });
           }
           throw err;
         }
       }),

     onQuestionCreated: protectedProcedure
       .subscription(async function* ({ signal }): AsyncGenerator<QuestionCreatedEvent> {
         const abortSignal = signal ?? new AbortController().signal;
         const source = eventToAsyncIterable<QuestionCreatedEvent>(questionEvents, 'created', abortSignal);
         for await (const ev of source) yield ev;
       }),

     onQuestionAnswered: protectedProcedure
       .subscription(async function* ({ signal }): AsyncGenerator<QuestionAnsweredEvent> {
         const abortSignal = signal ?? new AbortController().signal;
         const source = eventToAsyncIterable<QuestionAnsweredEvent>(questionEvents, 'answered', abortSignal);
         for await (const ev of source) yield ev;
       }),
   });
   ```
   The exact `QuestionAnswer` Zod schema MUST match the shape defined in `shared/types/questions.ts` by TASK-757 — re-check before sending; adjust the `z.record(...)` value union if TASK-757's `QuestionAnswer` differs (e.g. carries `annotations` per the SDK schema).

7. **Modify `main/src/orchestrator/trpc/routers/runs.ts`.** Add a `listMessages` query inside the `runsRouter` definition:
   ```ts
   listMessages: protectedProcedure
     .input(z.object({ runId: z.string() }))
     .query(async ({ ctx, input }): Promise<ChatMessage[]> => {
       if (!ctx.db) {
         throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
       }
       return selectRunMessages(ctx.db, input.runId);
     }),
   ```
   Add imports for `ChatMessage` (from `../../../../../shared/types/chatMessage`) and `selectRunMessages` (from `../../runMessagesListing`). Preserve all existing procedures and the dependency-injection plumbing.

8. **Modify `main/src/orchestrator/trpc/router.ts`.** Add `import { questionsRouter } from './routers/questions';` and wire `questions: questionsRouter` inside the `cyboflow: router({ ... })` block, alphabetically between `events` and `runs` (suggested order: `approvals, events, health, questions, runs, workflows`). The exact order is cosmetic but must compile.

9. **Modify `main/src/index.ts`.** After the existing `ApprovalRouter.initialize(db, runQueues.getOrCreate.bind(runQueues));` block, add the parallel QuestionRouter wiring:
   ```ts
   import { QuestionRouter } from './orchestrator/questionRouter';
   import { questionEvents } from './orchestrator/trpc/routers/events';
   import { buildQuestionCreatedEvent } from './orchestrator/questionCreatedBridge';
   import type { QuestionRequest } from './orchestrator/questionRouter';
   import type { QuestionAnsweredEvent } from '../../shared/types/questions';

   // In app.whenReady's tRPC-wiring block, right after the ApprovalRouter section:
   QuestionRouter.initialize(db, runQueues.getOrCreate.bind(runQueues));
   QuestionRouter.getInstance().on('questionCreated', (request: QuestionRequest) => {
     const event = buildQuestionCreatedEvent(request, db);
     questionEvents.emit('created', event);
     console.log('[Main] Bridged questionCreated → questionEvents.emit(created) for questionId=', request.id);
   });
   QuestionRouter.getInstance().on('questionAnswered', (event: QuestionAnsweredEvent) => {
     questionEvents.emit('answered', event);
     console.log('[Main] Bridged questionAnswered → questionEvents.emit(answered) for questionId=', event.questionId);
   });
   console.log('[Main] QuestionRouter → questionEvents bridge wired');
   console.log('[Main] QuestionRouter initialized');
   ```
   The exact event-name constants (`'questionCreated'` / `'questionAnswered'`) and the `QuestionRequest` / `QuestionAnsweredEvent` field names MUST match TASK-758's implementation — re-verify against `questionRouter.ts` before committing.

10. **Create `main/src/orchestrator/trpc/routers/__tests__/questions.test.ts`.** Integration test mirror of `approvals.test.ts` using `createTestDb` + `dbAdapter` + `createCaller(createContext({ db: adapter }))`. Cover all eight `test_strategy.targets` items for questions.test.ts. For subscription tests, use the `appRouter.createCaller(...).cyboflow.questions.onQuestionCreated()` async-iterator pattern.

11. **Create `main/src/orchestrator/__tests__/runMessagesListing.test.ts`.** Integration test for `selectRunMessages` using `makeRawEventsDb()` from the existing shared fixture.

12. **Modify `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`.** Add two tests for `listMessages`: empty + missing-db guards.

13. **Run the full verification gate:**
    ```
    pnpm --filter main typecheck
    pnpm typecheck
    pnpm lint
    pnpm --filter main test
    ```
    All must exit 0.

## Acceptance Criteria

See frontmatter for the verifiable list. Each criterion has a concrete pass/fail definition.

## Test Strategy

Two new test files (`questions.test.ts`, `runMessagesListing.test.ts`) and an extension to the existing `runs.test.ts`. All use the integration-style `createCaller` pattern against an in-memory SQLite DB built with `createTestDb({ includeQuestionsTable: true })` (option introduced by TASK-758).

## Hardest Decision

**Reading `messages` reconstruction from `raw_events` via SQL+JS, not from the `messages` table.** Risk 1 of the research report refuted Assumption 4: the `messages` table is empty by design (zero write path; `INSERT INTO messages` returns 0 grep hits). The IDEA's resolved Q3 said "read from messages" — that answer is incorrect at the table level. Three alternatives:
- **(a)** Add a `MessageProjectionSink` (analogous to `RawEventsSink`) that writes to `messages` during stream processing. Cleanest data model but adds unplanned scope to TASK-758/this task and a new SQL-write code path during high-throughput stream replay (cost: bigger blast radius if it has a bug).
- **(b)** Filter `cyboflowStore.streamEvents` client-side in the frontend. Zero backend work but loses history on reload.
- **(c) Chosen: query `raw_events` directly with `json_extract()` to reconstruct user+assistant text rows.** Reload-safe (raw_events is the canonical persisted log), zero new write paths, minimal SQL, mirrors the established pattern of `approvalListing` (SQL helper + tRPC wrapper).

The compromise: don't try to replicate the full `MessageProjection` here. Emit only what the Chat tab needs (user-text + assistant-text), and let the frontend merge live stream deltas via the existing `streamEvents` subscription on top of the initial query result.

## Rejected Alternatives

- **Add a `messages`-table write path (option (a) above).** Rejected: TASK-758's scope is already the QuestionRouter; adding a MessageProjectionSink would balloon two tasks. Would reconsider if the Chat tab needs to display reconstructed tool_call/tool_result segments inline.
- **Pure client-side filter over `streamEvents` (option (b) above).** Rejected: loses history on reload.
- **Move `onQuestionCreated` / `onQuestionAnswered` into `events.ts`** to match the approvals placement. Rejected: events.ts is already crowded; the new convention is single-feature routers carry their own subscriptions.
- **Wire `QuestionRouter.initialize()` in an Orchestrator method instead of inline in `index.ts`.** Rejected for symmetry with `ApprovalRouter.initialize()`.

## Lowest Confidence Area

The exact `QuestionRouter` event names (`'questionCreated'` / `'questionAnswered'`) and the `QuestionRequest` / `QuestionAnsweredEvent` field shapes are owned by TASK-758 and TASK-757 respectively. This plan assumes the obvious mirroring of `ApprovalRouter`. If any name diverges in TASK-758's implementation, the executor must adapt the imports, event names, and Zod schema in `questions.ts` plus the bridge in `index.ts`.

A secondary lower-confidence area: the SQLite `json_extract()` patterns for filtering raw_events rows by content-block type. The simplest portable formulation is to do the content-block type filter in JS after `JSON.parse(payload_json)`. The AC requires `json_extract()` usage; this is satisfied by including `json_extract(payload_json, '$.type')` in the WHERE clause to filter to `event_type IN ('assistant','user')` at the SQL layer.
