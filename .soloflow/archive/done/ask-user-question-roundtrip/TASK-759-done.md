---
id: TASK-759
sprint: SPRINT-039
epic: ask-user-question-roundtrip
status: done
summary: "Added cyboflow.questions tRPC sub-router (listPending / answer / onQuestionCreated / onQuestionAnswered), cyboflow.runs.listMessages query that reads from raw_events via json_extract, and wired QuestionRouter.initialize + event bridge + recoverStaleAwaitingInput into main/src/index.ts so the sprint branch boots coherently."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-759 — tRPC questions router + listMessages + index.ts boot wiring

## Outcome

- **tRPC `cyboflow.questions` sub-router** in `main/src/orchestrator/trpc/routers/questions.ts` with four procedures: `listPending` (returns `Question[]` oldest-first via `selectPendingQuestions`), `answer` (calls `QuestionRouter.respond`, maps `QuestionNotFoundError` to `TRPCError NOT_FOUND`), `onQuestionCreated` / `onQuestionAnswered` (async-generator subscriptions over the module-level `questionEvents` EventEmitter).
- **`questionEvents` EventEmitter** exported from `main/src/orchestrator/trpc/routers/events.ts`. `eventToAsyncIterable` promoted from file-local to exported.
- **`cyboflow.runs.listMessages`** in `main/src/orchestrator/trpc/routers/runs.ts` — reads from `raw_events` via SQLite `json_extract()` to gate rows; reconstructs user/assistant text in JS. Tool-use and tool-result blocks intentionally NOT mapped (surfaced via the existing approval/question card channels instead).
- **`shared/types/chatMessage.ts`** — new pure-type wire contract.
- **`questionListing.ts`** and **`runMessagesListing.ts`** — new orchestrator helpers, both preserving the standalone-typecheck invariant (no electron/better-sqlite3/services imports).
- **`main/src/index.ts`** — added `QuestionRouter.initialize()` after `ApprovalRouter.initialize()`; wired `questionCreated`/`questionAnswered` event listeners to bridge into `questionEvents`; called `QuestionRouter.recoverStaleAwaitingInput()` at boot BEFORE `setStartRunDeps()` so no run can start before stale-state recovery completes.

## Verification

- All 11 ACs met (verifier APPROVED).
- 703/703 main tests pass; lint 0 errors; typecheck clean across all 3 workspaces (shared/main/frontend — confirming the new tRPC procedure types reach the renderer).
- Sprint branch is now coherent — TASK-758's incoherence (QuestionRouter not initialized at boot) is resolved.

## Findings noted by code review (no blocker)

- Minor stale comment in `runMessagesListing.ts:14` describes a slightly older JSON path than the actual SQL uses. Cosmetic.
- `extractTextFromPayload` + `extractMessageId` re-parse the same `payload_json` twice for assistant rows. Trivial perf opportunity for a future pass; raw_events volumes per run are small.
- `QuestionAnswer.annotations` is declared on `shared/types/questions.ts` but the `answer` mutation's Zod schema does not accept it — silently dropped on the wire. The plan explicitly anticipated this divergence ("adjust the `z.record(...)` value union if TASK-757's QuestionAnswer differs"). TASK-760 (AskUserQuestionCard) will either widen the Zod schema or remove the field from shared/types. A regression test (test 7 in questions.test.ts) now documents the current contract.

## Commits

- `1b60980` — feat(TASK-759): wire questions tRPC router + listMessages query + index.ts QuestionRouter boot init
- `d682d17` — test(TASK-759): document annotations silent-drop contract via regression test
