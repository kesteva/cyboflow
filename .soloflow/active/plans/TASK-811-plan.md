---
id: TASK-811
idea: IDEA-013
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-013
epic: dual-substrate-claude
files_owned:
  - main/src/services/panels/claude/interactiveClaudeManager.ts
  - main/src/services/panels/claude/__tests__/interactiveStepTracking.integration.test.ts
  - docs/ARCHITECTURE.md
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
  - main/src/orchestrator/mcpServer/cyboflowMcpServer.ts
  - main/src/orchestrator/mcpServer/scriptPath.ts
  - main/src/orchestrator/stepTransitionBridge.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - main/src/orchestrator/prompts/step-reporting-instructions.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/index.ts
  - shared/types/workflows.ts
  - frontend/src/hooks/useWorkflowPhaseState.ts
acceptance_criteria:
  - criterion: "CYBOFLOW_RUN_ID is set to the real workflow_runs.id (the run id supplied by TASK-800's binding) in the interactive PTY env produced by InteractiveClaudeManager, NOT the Claude session UUID; the integration test asserts the env value equals the workflow run id."
    verification: "Unit/integration test in interactiveStepTracking.integration.test.ts: spawn the manager with a known runId, capture the env passed to the inherited spawn (via the manager's getCliEnvironment/initializeCliEnvironment seam) and assert env.CYBOFLOW_RUN_ID === runId (the workflow_runs.id) and !== the discovered Claude session UUID."
  - criterion: "Step-reporting instructions reach interactive `claude` via PROMPT-BODY PREPEND: the buildStepReportingAppend(workflowName) text from TASK-803 is concatenated to the HEAD of the initial prompt written to PTY stdin in the spawn path; the concatenation point is specified and tested. No SDK systemPrompt.append channel is used (interactive `claude` has none)."
    verification: "grep -n 'buildStepReportingAppend' main/src/services/panels/claude/interactiveClaudeManager.ts shows the import + a call whose result is prepended to the prompt before sendInput/PTY-stdin write; the integration test stubs the PTY and asserts the first stdin write begins with the buildStepReportingAppend text followed by the run prompt body."
  - criterion: "An interactive-session report_step call updates workflow_runs.current_step_id and advances getPhaseState through the SAME DB->stepTransitionEvents->mergeTransition chain as the SDK path — driven by IDEA-029's handleReportStep/buildStepTransitionEvent, with NO interactive-specific tracking code added."
    verification: "Integration test drives the report_step path end-to-end (invoke the TASK-802 handleReportStep branch on McpQueryHandler with the run's stepIds, or buildStepTransitionEvent directly) against an in-memory DB seeded with the run, then asserts (a) workflow_runs.current_step_id updated and (b) getPhaseState returns stepStates with the matching step 'running' / prior steps 'done' — identical to the SDK assertion."
  - criterion: "Tracking independence is asserted: step transitions fire even with the TranscriptSource tail paused/stopped — proving the advance is MCP-driven (cyboflow_report_step), not derived from the transcript stream."
    verification: "Integration test stops/never-starts the fake TranscriptSource, then drives a report_step transition and asserts current_step_id still advances and a stepTransitionEvents 'transition' event is emitted; the transcript onLine callback fired zero panel events for that step."
  - criterion: "No duplicate report-step handler, no duplicate tracking pipeline, and no re-touch of IDEA-029-owned MCP/env wiring is introduced by this task: the interactive path consumes TASK-802's handleReportStep, TASK-801's stepId validation, and TASK-800's CYBOFLOW_RUN_ID binding as-is."
    verification: "grep -rn 'handleReportStep\\|report-step\\|report_step' main/src/services/panels/claude/interactiveClaudeManager.ts returns 0 handler DEFINITIONS (only references/comments, no new branch); git diff --stat shows main/src/orchestrator/mcpServer/mcpQueryHandler.ts, main/src/services/panels/claude/claudeCodeManager.ts, main/src/orchestrator/runExecutor.ts, and main/src/index.ts are UNCHANGED by this task."
  - criterion: "The v1 main-session-only step-reporting granularity limit is documented in docs/ARCHITECTURE.md for the interactive substrate, and is explicitly tied to the S5 (TASK-810) subagent gating decision (Agent-tool subagents inherit neither mcpServers nor the parent hook scope)."
    verification: "grep -in 'main-session-only\\|subagent' docs/ARCHITECTURE.md returns >=1 match in a new interactive-substrate / step-tracking section that also names cyboflow_report_step and references the S5/TASK-810 subagent decision."
  - criterion: "The interactive manager passes an injected logger to the TranscriptSource and any narrowing/sink collaborators it constructs (CLAUDE.md optional-logger rule — logger must be passed, not omitted)."
    verification: "grep -n 'logger' main/src/services/panels/claude/interactiveClaudeManager.ts shows the logger forwarded into the TranscriptSource/EventRouter/RawEventsSink construction sites added by this task (no new collaborator constructed with the logger argument omitted)."
  - criterion: "No use of the `any` type."
    verification: "grep -nE ':\\s*any(\\b|\\[)|<any>|as any' main/src/services/panels/claude/interactiveClaudeManager.ts main/src/services/panels/claude/__tests__/interactiveStepTracking.integration.test.ts returns 0 matches"
  - criterion: "All unit tests pass and the code type-checks and lints clean."
    verification: "pnpm test:unit exits 0 (with interactiveStepTracking.integration.test.ts included); pnpm typecheck && pnpm lint exit 0. Do NOT use pnpm test:e2e as the gate (environmental per CLAUDE.md)."
depends_on: [TASK-809, TASK-810, TASK-799, TASK-800, TASK-801, TASK-802, TASK-803]
estimated_complexity: medium
test_strategy:
  needed: true
  justification: "The slice adds ONE real seam (prompt-body prepend of the step-reporting instruction) onto the already-built InteractiveClaudeManager and otherwise VERIFIES that IDEA-029's MCP-driven tracking chain works identically on the interactive substrate. All claimed behavior (env carries the run id, prepend reaches stdin, report_step advances getPhaseState, tracking is stream-independent) is unit/integration-testable against a faked PTY + fake TranscriptSource + in-memory DB, reusing the orchestrator test fixtures used by stepTransitionBridge/getPhaseState tests. No new tracking pipeline is built, so the test surface is the integration of consumed components plus the one new prepend wiring."
  targets:
    - behavior: "The interactive PTY env carries CYBOFLOW_RUN_ID = workflow_runs.id (not the Claude session UUID), and the step-reporting instruction is prepended to the initial prompt body written to PTY stdin."
      test_file: "main/src/services/panels/claude/__tests__/interactiveStepTracking.integration.test.ts"
      type: integration
    - behavior: "A report_step call from the (interactive) main session updates current_step_id and advances getPhaseState through the same DB->stepTransitionEvents->mergeTransition chain as the SDK path, with the transcript tail stopped (MCP-driven, stream-independent)."
      test_file: "main/src/services/panels/claude/__tests__/interactiveStepTracking.integration.test.ts"
      type: integration
---

# Workflow step tracking on the interactive substrate via cyboflow_report_step + prompt-body-prepend instruction delivery

## Objective

Make the Workflow Progress panel advance on interactive-substrate runs through the EXACT MCP-driven path the SDK substrate already uses (per scope decision #3, tracking comes from `cyboflow_report_step`, NOT from parsing the transcript stream), by closing the single real seam difference and verifying everything else is substrate-independent. The MAIN orchestrating interactive `claude` session calls `cyboflow_report_step` → `OrchSocketServer` → `handleReportStep` (TASK-802) → `buildStepTransitionEvent` (`stepTransitionBridge.ts:83`) → `stepTransitionEvents.emit('transition', …)` → the `onStepTransition` subscription → `mergeTransition` (`useWorkflowPhaseState.ts:66`), advancing the panel with the SAME zero-frontend-change IDEA-029 relies on. This task adds NO tracking code: it consumes TASK-801 (stepId validation), TASK-802 (`cyboflow_report_step` + `handleReportStep`), TASK-800 (`CYBOFLOW_RUN_ID = workflow_runs.id`), and TASK-803 (`buildStepReportingAppend` prompt assets), and owns ONLY (a) the prompt-body-prepend wiring inside `InteractiveClaudeManager` and (b) the integration test + an architecture doc note.

This slice is **depends-on-MERGE** of its IDEA-029 dependencies and of the earlier IDEA-013 slices, and must branch off the MERGED tree of those tasks — it never co-edits an IDEA-029-owned file. Specifically: TASK-799 OWNS `main/src/index.ts`; TASK-800 OWNS `claudeCodeManager.ts` + `runExecutor.ts` (and supplies the `CYBOFLOW_RUN_ID = workflow_runs.id` binding); TASK-802 OWNS `mcpServer/mcpQueryHandler.ts` (which provides `handleReportStep`); TASK-803 creates `main/src/orchestrator/prompts/step-reporting-instructions.ts`; TASK-810 (S5 shell-hook gating) and TASK-809 (S4 dispatch facade) land the interactive substrate's gating + boot dispatch. The InteractiveClaudeManager class body itself is created by TASK-808/S3 — this task EXTENDS it with the prompt-body-prepend wiring on top of the merged tree, adding no duplicate of any IDEA-029 or earlier-slice code.

## Implementation Steps

1. **Branch off the merged tree of all `depends_on` tasks.** Confirm before starting that `main/src/services/panels/claude/interactiveClaudeManager.ts` exists (created by the S3/TASK-808 line), that `main/src/orchestrator/prompts/step-reporting-instructions.ts` exports `buildStepReportingAppend` (TASK-803), that `mcpServer/mcpQueryHandler.ts` has a `report_step`/`handleReportStep` branch (TASK-802), and that the interactive manager already builds the PTY env with `CYBOFLOW_RUN_ID` (TASK-800 binding + S3 env construction). If any is absent, the merge prerequisite is unmet — STOP and surface it rather than re-implementing the dependency.

2. **Wire the prompt-body prepend in `interactiveClaudeManager.ts`** (the one new seam). Locate the spawn path's initial-prompt write to PTY stdin (the `sendInput`/stdin write that delivers the run `prompt` after the PTY is ready — established by S3 in `spawnCliProcess`). Import `buildStepReportingAppend` from `../../../orchestrator/prompts/step-reporting-instructions` (verify relative depth from `services/panels/claude/`). Resolve the workflow name for the run (from the workflow row / spawn options already threaded into the interactive spawn path), compute `const append = buildStepReportingAppend(workflowName)`, and PREPEND it to the prompt head: `const promptToSend = append ? \`${append}\n\n${prompt}\` : prompt;`. Write `promptToSend` (not `prompt`) to PTY stdin. The fail-soft empty-string contract of `buildStepReportingAppend` (TASK-803 returns `''` for non-SoloFlow names, mirroring `resolveInitialStepId`'s null branch in `stepTransitionBridge.ts:52`) means non-SoloFlow workflows prepend nothing. Document this concatenation point with a short comment naming it as the interactive analogue of the SDK's `composeSystemPromptAppend` (`claudeCodeManager.ts:478`), which interactive `claude` cannot use (no SDK `systemPrompt.append`).

3. **Confirm `CYBOFLOW_RUN_ID = workflow_runs.id` in the interactive env (assert, do not modify).** The interactive manager's `initializeCliEnvironment`/`getCliEnvironment` (S3) already injects `CYBOFLOW_RUN_ID`/`CYBOFLOW_ORCH_SOCKET` when `orchSocketPath` is set (reusing the `setOrchSocketPath` seam). Because TASK-800 makes the bound run id the real `workflow_runs.id` (NOT the Claude session UUID as in the legacy `claudeCodeManager.ts:523` stand-in), this task only ASSERTS that invariant in the test — it does NOT re-touch `composeMcpServers`/env wiring (TASK-800 owns `claudeCodeManager.ts`). Verify the env value equals the run id and is distinct from the tail-discovered session UUID.

4. **Create `main/src/services/panels/claude/__tests__/interactiveStepTracking.integration.test.ts`.** Reuse the orchestrator DB fixtures (the in-memory DB + `buildStepTransitionEvent`/`getPhaseState` helpers used by the existing `stepTransitionBridge`/`runs` router tests — e.g. `__test_fixtures__/orchestratorTestDb` and the `dbAdapter` adapter). Provide a `makeSpyLogger()` `LoggerLike` of `vi.fn()` methods. Cover the two `test_strategy.targets`:
   - **Env + prepend:** Spawn the interactive manager with a known `runId` (a seeded `workflow_runs.id`) and a stubbed PTY (fake `IPty`) plus a fake `TranscriptSource`. Assert `env.CYBOFLOW_RUN_ID === runId` and `!== sessionUuid`, and assert the first PTY stdin write begins with the `buildStepReportingAppend(workflowName)` text immediately followed by the prompt body.
   - **MCP-driven advance, stream-independent:** With the fake `TranscriptSource` STOPPED (or never started — zero `onLine` events), drive a `report_step` transition for one of the run's flat step ids (invoke TASK-802's `handleReportStep` branch on `McpQueryHandler`, or call `buildStepTransitionEvent(runId, stepId, 'running', db, logger)` directly to exercise the shared chain). Assert (a) `workflow_runs.current_step_id` updated, (b) a `stepTransitionEvents` `'transition'` event was emitted, and (c) `getPhaseState({ runId })` returns `stepStates` with that step `'running'` and prior steps `'done'` — byte-identical in shape to the SDK assertion. This proves tracking is MCP-driven, not transcript-derived.

5. **Add the v1 limit note to `docs/ARCHITECTURE.md`.** In the dual-substrate / interactive-substrate section (or a new subsection if S4/S5/S6 docs land here), state the v1 **main-session-only** step-reporting granularity limit: Agent-tool subagents run in isolated sub-sessions that inherit neither `mcpServers` nor the parent's hook scope (the same inherited IDEA-029 limit), so only the MAIN orchestrating session can call `cyboflow_report_step`. Tie it explicitly to the S5/TASK-810 subagent gating decision (interactive selection restricted for subagent-spawning workflows OR Task force-denied, per Probe A2). Name `cyboflow_report_step` and the prompt-body-prepend delivery seam.

6. **Run the gates.** `pnpm test:unit` (exit 0, with the new integration test included). If a `better-sqlite3` `NODE_MODULE_VERSION` error appears, run `pnpm rebuild better-sqlite3` first per CLAUDE.md, then re-run. Then `pnpm typecheck && pnpm lint` (exit 0). Confirm `git diff --stat` shows `mcpServer/mcpQueryHandler.ts`, `claudeCodeManager.ts`, `runExecutor.ts`, and `index.ts` are UNCHANGED by this task.

## Acceptance Criteria notes

- **The advance chain is fixed by IDEA-029 and re-used verbatim.** `buildStepTransitionEvent` (`stepTransitionBridge.ts:83-125`) writes `current_step_id` BEFORE emitting (write-then-emit ordering) and fail-softs on a missing/zero-row UPDATE; `getPhaseState` (`runs.ts:506-584`) flattens `WORKFLOW_DEFINITIONS[name].phases[].steps` and marks `< matchIndex` done / `=== matchIndex` running / `> matchIndex` pending. The interactive substrate touches NONE of this — it only ensures the MAIN interactive session is INSTRUCTED to call `cyboflow_report_step` (via the prepend) and that the env carries the right run id so the handler binds a real row.
- **Why the prepend, not an SDK append.** The SDK manager rides `options.systemPromptAppend → composeSystemPromptAppend` (`claudeCodeManager.ts:478-485`) via the unchanged `runExecutor.ts` `pendingSystemPromptAppend → buildOptionsOverrides` chain (`runExecutor.ts:373, 428`). Interactive `claude` has NO such SDK append channel, so TASK-803's instruction text is delivered by concatenating it to the HEAD of the prompt written to PTY stdin. Per Probe F (idea013_synthesis.md), a prompt-body-prepended instruction was confirmed to actually CAUSE a `report_step` call on the MAIN session (not merely list the tool); the per-worktree instruction file is the documented fallback if the prepend proves unreliable, but v1 ships the prepend.
- **Stream independence is the load-bearing assertion.** The test deliberately stops/never-starts the TranscriptSource so the advance cannot be attributed to a transcript line — it must come through the MCP `report_step` chain. This guards scope decision #3 (tracking is MCP-driven, not stream-derived) against silent regression.
- **No duplicate handler.** The grep AC requires that `interactiveClaudeManager.ts` defines NO new `handleReportStep`/report-step branch — it only references the consumed one. Any new branch would duplicate TASK-802 and is a violation.
- **Logger-passing rule.** Any TranscriptSource / EventRouter / RawEventsSink the manager constructs MUST receive the enclosing logger (CLAUDE.md: optional `logger?` must be passed, not omitted, or the collaborator becomes a silent observability no-op).

## Out of Scope

- **Implementing `cyboflow_report_step`, `handleReportStep`, or the stepId validation** — owned by TASK-802 / TASK-801 and consumed via depends-on-MERGE; this task adds NO duplicate handler or validation.
- **Touching `composeMcpServers` / the `CYBOFLOW_RUN_ID` env binding** — owned by TASK-800 (`claudeCodeManager.ts` + `runExecutor.ts`). This task takes `CYBOFLOW_RUN_ID = workflow_runs.id` as ALREADY fixed and only ASSERTS the interactive PTY env carries it. `claudeCodeManager.ts`, `runExecutor.ts`, `mcpQueryHandler.ts`, and `index.ts` are read-only here and must show 0 changed lines.
- **Creating the InteractiveClaudeManager class body, the TranscriptSource/normalizer, or the substrate-aware dispatch facade** — owned by the S2/S3/S4 line (TASK-807/TASK-808/TASK-809), consumed via depends-on-MERGE; this task only EXTENDS the existing manager with the prepend wiring.
- **Authoring `buildStepReportingAppend` or the planner/sprint prompt assets** — owned by TASK-803; this task only imports and calls `buildStepReportingAppend`.
- **The shell-hook permission gating, AskUserQuestion handling, and the per-worktree settings writer** — owned by S5/TASK-810.
- **Per-subagent step reporting** — explicit v1 limit (main-session-only); documented in `docs/ARCHITECTURE.md`, not implemented.
- **Any frontend change** — the IDEA-029 `onStepTransition` subscription + `mergeTransition` + `WorkflowProgressTimeline` already render the advance with zero modification; renderer substrate surfacing is S7/TASK-812.
- **Modifying `WORKFLOW_DEFINITIONS`, `stepTransitionBridge.ts`, or the tRPC `runs`/`events` routers** — all read-only context for this slice.
