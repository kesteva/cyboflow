---
id: IDEA-029
type: FEATURE
status: draft
created: 2026-05-29T00:00:00Z
source: design_workflow_wf_473a7813-41c_2026-05-29
slices:
  - title: "Stand up the cyboflow MCP server runtime (the gating infra, formerly 'epic 7')"
    description: "Make the already-coded cyboflow MCP server actually runnable so spawned Claude sessions can call `cyboflow_*` tools. Today the whole path is stubbed: `orchSocketProvider`/`bridgeScriptResolver` in `main/src/index.ts:546-557` are sentinels that THROW ('epic 7 owns permissionIpcServer'), `McpQueryHandler` is never instantiated (0 hits for `new McpQueryHandler`), and `ClaudeCodeManager.setOrchSocketPath()` (`claudeCodeManager.ts:105`) is never called at boot — so `composeMcpServers()` always takes the `orchSocketPath===null` branch and the `cyboflow` MCP entry is never injected. Implement: (a) an orchestrator-side Unix-socket server (the `permissionIpcServer`) that listens on `~/.cyboflow/sockets/`, accepts subprocess connections, parses newline-delimited JSON, and routes each message to a real `McpQueryHandler` instance (wired with the cyboflow DB + logger); (b) instantiate + start the `McpServerLifecycle` singleton; (c) call `defaultCliManager.setOrchSocketPath(socketPath)` at boot; (d) replace the OrchestratorHealth sentinel (`index.ts:659-662`) with the real lifecycle status so `cyboflow.health.mcpServer` stops returning the `{status:'starting'}` fallback; (e) resolve `bridgeScriptResolver` for packaged (asar-unpacked) + dev modes via `mcpServer/scriptPath.ts`."
    value_statement: "Foundational unblock: nothing about agent->orchestrator tool calls works until this lands. It also makes the THREE existing tools (`cyboflow_list_pending_approvals`, `cyboflow_get_run`, `cyboflow_submit_checkpoint`) callable for the first time — value beyond step tracking."
  - title: "Thread the real workflow_runs.id as CYBOFLOW_RUN_ID into spawned sessions"
    description: "`claudeCodeManager.ts:523` currently sets `CYBOFLOW_RUN_ID` to `options.sessionId` (the Claude session UUID), NOT `workflow_runs.id`. Every cyboflow MCP tool binds the run from this env var, so as-is the step-report handler's `UPDATE workflow_runs SET current_step_id=? WHERE id=?` would target a non-existent row (changes===0, silent no-op — the FIND-SPRINT-024-4 silent-drop class). Add `runId?: string` to `ClaudeSpawnOptions`, thread it from `RunExecutor.execute()` through the spawn path into `composeMcpServers()`, and set `CYBOFLOW_RUN_ID` to the real run id for workflow runs (and a defined value/none for legacy quick sessions that have no run)."
    value_statement: "Correctness precondition shared by ALL cyboflow MCP tools (checkpoint included), not just step reporting. Without it the feature is a silent no-op and the existing checkpoint tool writes to the wrong run."
  - title: "Validate stepId in the transition bridge + accept arbitrary tool-driven steps"
    description: "`buildStepTransitionEvent` (`stepTransitionBridge.ts:83-125`) writes ANY stepId to `current_step_id` with ZERO validation — a typo would corrupt the row (UI `mergeTransition` defensively drops unknown ids on read, but the DB stays corrupt). Add validation: resolve the run's workflow name and reject any stepId not present in `WORKFLOW_DEFINITIONS[name]` flat steps (no write, warn-log, return null). Separately, relax the v1 single-step constraint: the `stepTransitionEmitter` adapter at `index.ts:596-610` resolves ONLY `INITIAL_STEP_IDS` — keep that as the lifecycle fallback (initial step at 'running', all 'done' at terminal) but allow the new tool path to supply arbitrary valid stepIds on top."
    value_statement: "Prevents DB corruption of current_step_id and unlocks forward-jump transitions while preserving the safe initial-step fallback for runs that never report."
  - title: "Add the cyboflow_report_step MCP tool + validated handler"
    description: "Register `cyboflow_report_step` in `cyboflowMcpServer.ts` (mirrors `cyboflow_submit_checkpoint`): inputSchema `{ step_id: string (required), status?: 'running'|'done' (default 'running') }`, NO run_id arg (server binds `CYBOFLOW_RUN_ID` from env). The CallTool handler validates `step_id` is a non-empty string then calls `executeMcpQuery('mcp-report-step', { stepId, status })`. Orchestrator side: extend the `McpQueryMessage` union in `mcpQueryHandler.ts` with `{ type:'mcp-report-step'; requestId; runId; stepId; status }` and add `handleReportStep()`: (1) reject `runId==='orchestrator'` (mirror checkpoint guard); (2) JOIN `workflows` for the run's name; (3) validate stepId against `WORKFLOW_DEFINITIONS[name]` (return `ok:false 'unknown_step_id'` on miss — no corruption); (4) call the validated `buildStepTransitionEvent(runId, stepId, status, db, logger)`; (5) fail-soft try/catch, never throw. Tool description must state it is OBSERVATIONAL — does not pause the run or change run status (unlike the PreToolUse approval gate)."
    value_statement: "The actual step-progress signal. Once it writes a real stepId for the real run, the DB->stepTransitionEvents->onStepTransition->mergeTransition chain advances the Workflow Progress panel with ZERO frontend changes (getPhaseState/mergeTransition already handle forward jumps)."
  - title: "Own the planner/sprint agents + step instructions natively in cyboflow"
    description: "DECISION (user, 2026-05-29): cyboflow does NOT track or edit the external SoloFlow plugin (`~/.claude/plugins/marketplaces/soloflow`); it was reference only. Port the planner/sprint agent roles + per-phase step ids into cyboflow-OWNED prompt assets so they are in-repo and version-controlled. Inject step-reporting instructions into each run via the existing per-run `systemPromptAppend` seam (`runExecutor.ts:423-429`), telling the MAIN orchestrating session to call `cyboflow_report_step` at each phase boundary with stepIds that match `WORKFLOW_DEFINITIONS` (planner: context->research->approve-idea->epics->tasks->approve-plan). Document the v1 granularity limit: subagents spawned via the Agent tool run in ISOLATED sub-sessions that do NOT inherit `mcpServers`, so only the main session can report — per-subagent step reporting is out of scope for v1."
    value_statement: "Removes the external-plugin dependency entirely (cyboflow owns its workflows), and makes the step_id contract an in-repo, testable artifact instead of a cross-boundary handshake with an uncontrolled plugin."
  - title: "Lock the step_id contract + UI in tests"
    description: "Add an in-repo parity test asserting every step_id the cyboflow-owned prompts will report exists in `WORKFLOW_DEFINITIONS` (now fully in-repo since cyboflow owns the prompts — drift fails CI). Add `mcpQueryHandler` unit tests (valid stepId -> ok:true + write + one emit; invalid -> ok:false 'unknown_step_id' + no write; `runId==='orchestrator'` guard). Add a frontend `mergeTransition` forward-jump test (currentStep step2 -> step5: 0-4 'done', 5 'running', rest 'pending'). Gate on `pnpm test:unit` (NOT `pnpm test:e2e`, environmental per CLAUDE.md). Manual integration: run a real planner under `pnpm dev`, watch `cyboflow-backend-debug.log` for `handleReportStep` and confirm the panel advances past step 1 live."
    value_statement: "Codifies the only cross-layer contract (prompt step_id <-> WORKFLOW_DEFINITIONS) as a CI gate so it can't silently drift into a stalled panel, and locks the forward-jump UI semantics."
open_questions:
  - "v1 granularity: accept main-session-only step reporting (subagents can't report due to MCP-config isolation), or invest in Agent-tool param plumbing + per-subagent MCP injection for finer progress? Recommended: accept main-session-only for v1."
  - "mergeTransition 'done' semantics: a mid-run status='done' currently marks ALL forward steps 'done' (useWorkflowPhaseState.ts:85-92). Is that the desired visual for skipped/optional steps, or do we want an explicit per-step status array in the event payload (larger change)?"
  - "status enum: keep running|done only, or add 'failed'/'skipped' to WorkflowStepState for richer progress?"
  - "Where do the cyboflow-owned agent/step prompt assets live (new dir under main/src or shared/), and how are they associated with each WORKFLOW_DEFINITIONS workflow?"
  - "Should an agent-reported step ever override the lifecycle 'done' at run end, or is last-write-wins acceptable (getPhaseState already forces all 'done' on terminal status)?"
assumptions:
  - "This epic OWNS the formerly-deferred 'epic 7' MCP-server runtime (slice 1) — it is NOT a separate prerequisite. Per user decision 2026-05-29 to do the complete implementation."
  - "cyboflow natively owns the planner/sprint agent roles + step ids; there is NO ongoing sync with the external SoloFlow plugin."
  - "The existing UI (getPhaseState in runs.ts:506-584, mergeTransition in useWorkflowPhaseState.ts:66-103) needs NO changes to render forward-jump step transitions — confirmed by the design workflow."
  - "Per-run worktree + spawn path is the one used by RunExecutor (not the quick-session direct claudeCodeManager path)."
research_recommendation: not_needed
research_rationale: "A multi-agent design workflow (wf_473a7813-41c, 2026-05-29) already produced an adversarially-reviewed, file-level plan grounded in the current codebase. Two of three review lenses verdicted the naive plan 'flawed' purely because the MCP runtime is unbuilt — that finding is now slice 1. No external/ecosystem research is needed; every decision is anchored in the repo."
---

# MCP server runtime + native MCP-tool-driven workflow step tracking

## Context

The Workflow Progress panel pins `workflow_runs.current_step_id` to the first
step for the entire run and never advances — see
`[[project_workflow_run_lifecycle]]`. Root cause: `stepTransitionBridge.ts` uses
an explicit "v1 single-step-per-workflow" model (`INITIAL_STEP_IDS`), and
`RunExecutor` only emits `'running'` at start and `'done'` at end. There is no
mid-run step signal.

The user chose the **MCP-tool-driven** approach (the running agent reports phase
transitions) over a fragile cyboflow-side stream heuristic. A design workflow
(`wf_473a7813-41c`) then surfaced that this is gated on a larger, unbuilt
dependency: the cyboflow MCP server is fully **coded but non-runnable** — the
Unix-socket wiring, `McpServerLifecycle` spawn, and `McpQueryHandler` routing are
all throwing sentinels labelled "epic 7", and `CYBOFLOW_RUN_ID` is wrongly set to
the session id. See `[[project_mcp_server_blocked_epic7]]` for the verified
specifics. This epic therefore absorbs that runtime work as slice 1.

## Sequencing & dependencies

```
slice 1 (MCP runtime)  ─┬─> slice 4 (report_step tool/handler) ─┐
slice 2 (CYBOFLOW_RUN_ID)┘                                       ├─> slice 5 (native agents + prompt) ─> slice 6 (tests/contract)
slice 3 (stepId validation + relax v1) ─────────────────────────┘
```

- Slices 1, 2, 3 are independently startable. 1 + 2 are the runtime/correctness
  gate; 3 is a self-contained bridge hardening.
- Slice 4 depends on 1 (a callable tool surface) + 3 (validated arbitrary steps).
- Slice 5 depends on 4 (a tool to call) + 2 (correct run binding).
- Slice 6 depends on 5 (the prompts whose step_ids it parity-checks).

## Reviewer must-fixes (carry into task refinement)

From the design workflow's adversarial review (2 of 3 lenses verdicted the
naive plan "flawed"; all must-fixes are folded into the slices above):

1. **MCP runtime must actually run, not just compile** — slice 1. The tool +
   handler can be written before slice 1 lands but cannot RUN; do not declare
   the feature done on a compile-only basis.
2. **CYBOFLOW_RUN_ID must be the workflow_runs.id** — slice 2. Silent no-op
   otherwise.
3. **buildStepTransitionEvent must validate stepId** — slice 3. Otherwise a typo
   corrupts current_step_id (UI hides it on read; DB stays corrupt).
4. **Relax the INITIAL_STEP_IDS hardcoding** for tool-driven steps while keeping
   it as the lifecycle fallback — slice 3.
5. **In-repo step_id parity gate** — slice 6. The only cross-layer contract;
   must fail CI on drift. (Cheap now that cyboflow owns the prompts.)
6. **Decide subagent granularity** — open question; recommended v1 = main-session
   only, documented as a known limit.

## Out of scope (v1)

- Per-subagent step reporting (Agent-tool param plumbing + per-subagent MCP
  injection).
- Richer step states beyond running|done (failed/skipped) unless the open
  question resolves to add them.
- Any change to the external SoloFlow plugin — cyboflow owns its workflows now.

## Raw Input

> User, 2026-05-29: "Lets go with the more complete implementation. We don't
> need to update soloflow, it was only provided for reference. We can adapt those
> agents and steps for native use within cyboflow without needing to continue to
> track soloflow updates. Since this is a more involved project, lets document as
> an epic with tasks for implementation that can be picked up."
