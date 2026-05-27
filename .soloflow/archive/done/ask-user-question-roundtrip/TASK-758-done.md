---
id: TASK-758
sprint: SPRINT-039
epic: ask-user-question-roundtrip
status: done
summary: "Implemented QuestionRouter singleton + questionCreatedBridge; branched claudeCodeManager.makePreToolUseHook to route AskUserQuestion through the router; wired clearPendingForRun into runSdkQuery's finally block; enabled SDK toolConfig.askUserQuestion.previewFormat='markdown'."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-758 — QuestionRouter singleton + PreToolUse hook intercept + SDK toolConfig

## Outcome

Main-process half of the AskUserQuestion round-trip is now in place:

- **`questionRouter.ts`** — Singleton mirroring ApprovalRouter line-for-line: per-run PQueue map (independent from RunQueueRegistry to preserve the no-recursive-enqueue invariant), pending Map, `requestQuestion` (single-transaction INSERT + `awaiting_input` UPDATE guarded by `status='running'`), `respond` (status back to `running` guarded by `awaiting_input` + cancel-race fallback), `clearPendingForRun` (synchronous, swallows DB errors, always resolves promises), `recoverStaleAwaitingInput` (boot recovery), `getPending` (renderer snapshot). Emits `questionCreated` / `questionAnswered`.
- **`questionCreatedBridge.ts`** — `buildQuestionCreatedEvent` JOINs workflow_runs → workflows for `workflowName`, with `console.warn` + empty-string fallback on missing-row (mirrors `buildApprovalCreatedEvent`).
- **`claudeCodeManager.ts`** — `makePreToolUseHook` now branches on `tool_name === 'AskUserQuestion'` to the new private `routeAskUserQuestion` method, which calls `QuestionRouter.requestQuestion` and returns `{ permissionDecision: 'allow', updatedInput: { questions, answers, ...annotations } }`. The non-AskUserQuestion branch still calls `routePreToolUseThroughApprovalRouter` unchanged. `runSdkQuery` finally block now calls both `ApprovalRouter.clearPendingForRun` and `QuestionRouter.clearPendingForRun`. `buildSdkOptions` sets `toolConfig.askUserQuestion.previewFormat = 'markdown'` unconditionally so the model emits preview strings.
- **Test fixture** — `orchestratorTestDb.ts` gains `includeQuestionsTable` option (applies migration 010 verbatim on top of GATE_SCHEMA without mutating it; GATE_SCHEMA parity test still green) and `seedQuestion` helper.
- **Type additions** — `shared/types/questions.ts` extended with `QuestionRequest` interface and `workflowName` field on `Question` (verified required by AC; missed by TASK-757).

## Verification

- All 14 acceptance criteria met (verifier APPROVED).
- 684/684 main tests pass after executor's commit; +4 wiring tests in 27b0205 → 688/688.
- New tests: 9 in questionRouter.test.ts, 4 in questionCreatedBridge.test.ts, 4 in claudeCodeManagerWiring.test.ts.
- `pnpm --filter main typecheck` exits 0; `pnpm lint` 0 errors; `pnpm test:unit` only the pre-existing 4 reviewQueueStore.test.ts failures from TASK-750 (FIND-SPRINT-039-2).
- Standalone-typecheck invariant preserved on both new orchestrator files (no electron/better-sqlite3/services imports).

## Findings logged

- **FIND-SPRINT-039-3** (resolved by verifier) — `QuestionRequest`/`workflowName` additions to shared/types/questions.ts; was an AC requirement TASK-757 missed.
- **FIND-SPRINT-039-4** (resolved by verifier) — `claudeCodeManagerWiring.test.ts` QuestionRouter init/reset edit; required by AC8/AC14; not a real scope deviation.
- **FIND-SPRINT-039-5** (resolved by verifier) — same as -4 for `claudeCodeManager.killProcess.test.ts`.
- **FIND-SPRINT-039-6** (pending compound) — minor docblock duplication in questionRouter.ts header §4/§5.
- **FIND-SPRINT-039-7** (pending compound) — unguarded UPDATE in `respond` cancel-race fallback (idempotent in practice; minor audit-trail noise possible under rare clearPendingForRun→respond interleave).

## Notes

- **Sprint-internal incoherence (NOT a regression to main):** `QuestionRouter.initialize()` is not yet wired in `main/src/index.ts`. Running `pnpm dev` from this commit alone would crash on the first Claude session at the finally block. TASK-759 wires this boot init alongside ApprovalRouter. The run branch will not merge until 759..762 land.
- The `socketReply` no-op closure (line 188-191) is dead under the SDK transport but kept for ApprovalRouter parity per plan's Lowest Confidence note.

## Commits

- `d4a7026` — feat(TASK-758): QuestionRouter singleton + PreToolUse hook intercept + SDK toolConfig
- `27b0205` — test(TASK-758): add hook-level wiring tests for AskUserQuestion routing
