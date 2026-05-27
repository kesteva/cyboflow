---
sprint: SPRINT-039
findings_count:
  critical: 1
  important: 5
  minor: 10
---

# Sprint Code Review: SPRINT-039

## Scope
- Base: 5be2fddff48128cea903ba85a7b03801101f36fa
- Tasks reviewed: [TASK-756, TASK-757, TASK-758, TASK-759, TASK-760, TASK-761, TASK-762]
- Files changed: 39 (9010 insertions, 1705 deletions across 72 paths counting renames)
- Cross-task hotspots:
  - main/src/orchestrator/questionRouter.ts (vs sibling approvalRouter.ts)
  - main/src/orchestrator/questionCreatedBridge.ts (vs sibling approvalCreatedBridge.ts)
  - main/src/orchestrator/questionListing.ts (vs sibling approvalListing.ts)
  - main/src/services/panels/claude/claudeCodeManager.ts (added routeAskUserQuestion alongside routePreToolUseThroughApprovalRouter)
  - main/src/orchestrator/cancelAndRestartHandler.ts (pre-sprint; not threaded for QuestionRouter — see FIND-15)
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts (extended) vs main/src/orchestrator/__tests__/stuckDetector.test.ts (inlined the same SQL)
  - frontend/src/stores/questionStore.ts (mirrors reviewQueueStore patterns; FIND-8/9/14 from per-task review)

## Findings queued
6 new findings appended to `.soloflow/active/findings/SPRINT-039-findings.md` by the sprint-code-reviewer (FIND-15 through FIND-20); 10 pre-existing open entries from per-task verifier and code-reviewer passes remain queued for the same compounder run (FIND-3/4/5/10 are status=resolved and excluded). pending_count reported by findings.js: 15 (does not include FIND-2 which uses the legacy schema with no `status` field). Severity breakdown across the 16 currently-pending entries: critical=1, important=5, minor=10.

### Critical (1)
- **FIND-SPRINT-039-14** — `otherText` bus in questionStore is a one-way writer; AskUserQuestionCard never reads it, breaking the epic's bottom-bar → "Other"-field forwarding. (per-task verifier)

### Important (5)
- **FIND-SPRINT-039-1** — Recurring TCC-grant gap in docs/VISUAL-VERIFICATION-SETUP.md. (per-task verifier)
- **FIND-SPRINT-039-2** — Pre-existing reviewQueueStore test failures from TASK-750 trpc-shim removal. (per-task verifier)
- **FIND-SPRINT-039-15** — cancelAndRestartHandler clears approvals but not questions; symmetry violation introduced when TASK-757/758 added awaiting_input + QuestionRouter without threading the pre-existing cancel-and-restart path. (sprint-code-reviewer)
- **FIND-SPRINT-039-16** — QuestionRouter and ApprovalRouter are ~70%+ structurally identical (singleton + PQueue + transaction + recover + bridges); a shared `GateRouter` abstraction is the right next step before a third gate type lands. (sprint-code-reviewer)
- **FIND-SPRINT-039-17** — stuckDetector.test.ts inlines migration 010 schema rebuild instead of using the new `createTestDb({ includeQuestionsTable: true })` helper added in the same sprint. (sprint-code-reviewer)

### Minor (10 open)
- FIND-SPRINT-039-6 — Duplicate paragraphs §4/§5 in questionRouter header. (per-task)
- FIND-SPRINT-039-7 — Unguarded UPDATE in `respond`'s cancel-race fallback. (per-task)
- FIND-SPRINT-039-8 — Second subscription onError closure-cleanup asymmetry in questionStore (mirrored from reviewQueueStore). (per-task)
- FIND-SPRINT-039-9 — Silent submit-failure UX in AskUserQuestionCard/PendingApprovalCard. (per-task)
- FIND-SPRINT-039-11 — RunChatView merges historicalMessages + streamEvents with no deduplication. (per-task)
- FIND-SPRINT-039-12 — tool_use block rendering duplicated between RunChatView and RunView. (per-task)
- FIND-SPRINT-039-13 — TASK-762 documented otherText bus addition. (per-task)
- FIND-SPRINT-039-18 — routeAskUserQuestion duplicates routePreToolUseThroughApprovalRouter shape with hardcoded log label; should extract a sibling helper. (sprint-code-reviewer)
- FIND-SPRINT-039-19 — questionListing/approvalListing share the same SELECT-JOIN scaffolding; extract gateListing.ts. (sprint-code-reviewer)
- FIND-SPRINT-039-20 — Dead `_getQueueForRun` constructor parameter propagated across both routers; misleading DI surface. (sprint-code-reviewer)

(FIND-3/4/5/10 closed as `status: resolved` and excluded from the open queue.)

## Inline assessment notes
- **Boot ordering safety** (`main/src/index.ts:734-757`) — Verified: QuestionRouter.initialize → on(created/answered) bridge wire → recoverStaleAwaitingInput → ApprovalRouter recovery → recoverActiveStateOrphans → setStartRunDeps. `setStartRunDeps` gates run starts, so no SDK PreToolUse hook can fire before both routers are wired. recoverStaleAwaitingInput only touches DB state (no in-memory emit), so no listener-ordering race. Safe.
- **otherText bus** — already at HIGH (FIND-14); no additional finding.
- **Security review of MarkdownPreview** — react-markdown v10 with remark-gfm; no `rehype-raw`, no custom `urlTransform` override. v10's built-in `defaultUrlTransform` filters `javascript:` / `data:` schemes from `<a href>`. SDK-emitted preview strings rendered through this path are safe against inline-HTML XSS today. No finding; flag in CLAUDE.md if a future change adds rehype-raw.
- **IPC/tRPC type parity** — Question, ChatMessage, QuestionAnswer are owned by `shared/types/*.ts` and imported on both sides; no dual declarations. `cyboflow.questions.answer` Zod schema drops the optional `annotations` field intentionally and has a regression test (TASK-759). Good.
- **Test infrastructure parity** — `createTestDb` extension follows the additive layering pattern and is gated by an option flag. `seedQuestion` mirrors `seedApproval`. Only drift is FIND-17 (one test file inlines instead of using the helper).
