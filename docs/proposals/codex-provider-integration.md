# Codex Provider Integration Proposal

Date: 2026-07-08

## Summary

Cyboflow should support Codex as a second agent family alongside Claude by adding a provider/runtime axis, not by extending the current Claude-only `substrate` enum.

The core product model should be:

- A session has one runtime agent. This powers the default chat when no workflow is actively controlling the session.
- A workflow has its own agent plan. While the workflow is running, its configured provider/runtime/model choices take over for workflow steps.
- When the workflow completes, fails, or is cancelled, the session returns to its existing runtime agent for normal chat.

The existing runtime model is:

- `substrate = 'sdk'`: Claude Agent SDK.
- `substrate = 'interactive'`: Claude Code interactive PTY.

That model is intentionally Claude-specific. Adding `codex` to `CliSubstrate` would make the short-term patch smaller, but it would collapse two different concepts:

- Agent provider: Claude vs Codex.
- Runtime transport: SDK, interactive PTY, non-interactive exec.

Recommended target model:

```ts
export type AgentProvider = 'claude' | 'codex';

export type AgentRuntime =
  | 'claude-sdk'
  | 'claude-interactive'
  | 'codex-sdk'
  | 'codex-pty'
  | 'codex-exec';

export type WorkflowAgentRuntime = Exclude<AgentRuntime, 'codex-pty' | 'codex-exec'>;
```

Backfill existing runs as:

```ts
agent_provider = 'claude'
agent_runtime = substrate === 'interactive' ? 'claude-interactive' : 'claude-sdk'
```

Keep `workflow_runs.substrate` during the migration window as a Claude compatibility projection, then stop exposing it as the primary UI concept.

## Goals

- Let users choose Claude or Codex as the session's default chat agent.
- Let workflows run with their own provider/runtime/model plan, including mixed Claude and Codex steps inside one workflow.
- Preserve Cyboflow's product invariant: all human attention routes through the shared review queue.
- Reuse the existing worktree, run lifecycle, MCP, raw event, message projection, review item, and usage infrastructure.
- Keep Claude as the default and avoid behavior changes for existing users.
- Make model labels provider-scoped so `Opus` and `GPT-5.5` do not share one selector namespace.

## Non-Goals

- Do not resurrect Crystal's inherited Codex paths without design review.
- Do not call the OpenAI Responses API directly as the main implementation. That would add OpenAI models, not Codex as a local coding agent.
- Do not make Codex Cloud part of v1. Local Codex is the right fit for Cyboflow's worktree-isolated desktop model.
- Do not split the review queue by provider.
- Do not run workflows through Codex PTY mode. Codex PTY is for quick sessions only.
- Do not expose `codex-exec` as a user-facing runtime in v1.

## Source Research

The current official Codex docs expose these relevant surfaces:

- Codex SDK: `@openai/codex-sdk` embeds Codex in Node apps, starts/resumes threads, and supports streamed structured events via `runStreamed()`.
- Codex non-interactive mode: `codex exec --json` streams JSONL events such as `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`.
- Codex MCP: Codex reads MCP server config from `config.toml` and supports STDIO and streamable HTTP servers, environment variables, tool allow/deny lists, and per-tool approval modes.
- Codex sandboxing: Codex has explicit sandbox modes (`read-only`, `workspace-write`, `danger-full-access`) and approval policies (`untrusted`, `on-request`, `never`).
- Codex auth: local CLI/SDK flows support ChatGPT login or API key auth. Cyboflow should start with ChatGPT auth for v1, then revisit API-key auth as a product/billing decision.
- Codex models: current docs recommend `gpt-5.5` for most Codex tasks, `gpt-5.4-mini` for faster/lower-cost work, and `gpt-5.3-codex-spark` as a research preview for near-instant iteration.

Primary source links:

- Codex SDK README: https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
- Codex SDK source types: https://github.com/openai/codex/tree/main/sdk/typescript/src
- Codex manual: https://developers.openai.com/codex/codex-manual.md

Local Cyboflow seams reviewed:

- `shared/types/substrate.ts`
- `main/src/orchestrator/substrateResolver.ts`
- `main/src/services/substrateDispatchFacade.ts`
- `main/src/services/cliManagerFactory.ts`
- `main/src/services/panels/claude/claudeCodeManager.ts`
- `main/src/services/panels/claude/interactiveClaudeManager.ts`
- `frontend/src/components/cyboflow/WorkflowPicker.tsx`
- `frontend/src/components/cyboflow/SubstrateSelector.tsx`
- `frontend/src/components/cyboflow/RunChatView.tsx`
- `frontend/src/components/cyboflow/ChatInput.tsx`

## Recommended Integration Surface

### Primary: Codex SDK

Use `@openai/codex-sdk` as the main implementation path.

Reasons:

- It is designed for embedding Codex into internal tools and workflows.
- It provides structured streamed events through `runStreamed()`.
- It supports thread resume by ID.
- It supports working-directory control, sandbox mode, approval policy, model choice, additional writable directories, network access, web search, and controlled environment injection.
- It wraps the local Codex CLI, which preserves Codex's local agent behavior, sandboxing, config, and MCP support.

### Secondary: `codex exec --json`

Use this only for an implementation spike or a fallback runner.

It is useful because the JSONL stream is easy to inspect and maps to the same event family as the SDK. It is less attractive as the main product path because the SDK already provides a Node-native lifecycle wrapper.

### Avoid: Raw Responses API

Using the Responses API directly would bypass Codex's local coding-agent runtime. It would require Cyboflow to build its own command execution, patch application, sandboxing, MCP integration, and resume semantics. That duplicates the wrong layer.

## Data Model

Add migration `048`:

```sql
ALTER TABLE workflow_runs
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex'));

ALTER TABLE workflow_runs
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk'));

UPDATE workflow_runs
SET agent_runtime =
  CASE substrate
    WHEN 'interactive' THEN 'claude-interactive'
    ELSE 'claude-sdk'
  END
WHERE agent_provider = 'claude';
```

Keep model in `workflow_runs.model`, but interpret it as provider-scoped. The label renderer should use `(agent_provider, model)` rather than a single global model label map.

For v1, keep provider/runtime/model run-scoped. This gets one Codex-backed workflow running end to end before Cyboflow takes on the extra UI and resolver complexity of mixed-provider steps. `workflow_runs.agent_runtime` should use `WorkflowAgentRuntime`, not the broader session runtime set.

For the fast-follow mixed-provider workflow work, add step-scoped agent configuration to workflow definitions or workflow run steps:

```ts
export interface WorkflowAgentDefaults {
  provider: AgentProvider | 'inherit-session';
  runtime: AgentRuntime | 'inherit-session';
  model: WorkflowDefaultModelSelection;
}

export interface WorkflowStepAgentConfig {
  provider?: AgentProvider | 'inherit-session' | 'inherit-workflow';
  runtime?: AgentRuntime | 'inherit-session' | 'inherit-workflow';
  model?: WorkflowStepModelSelection;
}

export type WorkflowDefaultModelSelection =
  | { kind: 'inherit-session' }
  | { kind: 'auto' }
  | { kind: 'explicit'; model: string };

export type WorkflowStepModelSelection =
  | WorkflowDefaultModelSelection
  | { kind: 'inherit-workflow' };
```

Effective agent resolution should be:

```txt
step explicit value
-> step inherit-workflow
-> workflow default
-> workflow inherit-session
-> session default runtime agent
```

Many workflows should expose "Inherit from session" directly in step model selectors. That inheritance state should be persisted as an explicit selection, not represented only by `null` or an omitted field, so the UI can distinguish:

- Inherit from session.
- Inherit from workflow default.
- Auto for the effective runtime.
- Explicit provider model.

Resolve provider and runtime before resolving model, because the valid model list depends on the effective runtime. If a step inherits the session model but overrides provider or runtime to something incompatible, the selector should show the inherited model as invalid and require either `Auto` or an explicit model for the effective runtime.

Each concrete agent turn should persist its own invocation identity:

```sql
agent_invocation_id TEXT NOT NULL
step_id TEXT
agent_provider TEXT NOT NULL
agent_runtime TEXT NOT NULL
model TEXT
external_session_id TEXT
```

`external_session_id` is provider-specific: Claude session ID for Claude, Codex thread ID for Codex. Store this on the invocation record, not as `workflow_runs.codex_thread_id`, so the v1 schema does not immediately create a run-level column that mixed-provider workflows must unwind.

Later cleanup:

- Rename UI-facing `substrate` labels to runtime.
- Keep `substrate` as a compatibility field for old run rows and tests until all callers move to provider/runtime.

## Runtime Architecture

### Session And Workflow Agent Ownership

Separate long-lived session ownership from workflow execution ownership.

The session record owns the default runtime agent:

```ts
interface SessionAgentConfig {
  provider: AgentProvider;
  runtime: AgentRuntime;
  model?: string;
  permissionMode: PermissionMode;
}
```

That agent powers the default chat surface before and after workflows. It should remain stable unless the user changes the session configuration.

A workflow run owns a temporary workflow agent plan:

```ts
interface WorkflowAgentPlan {
  defaults: WorkflowAgentDefaults;
  steps: Record<string, WorkflowStepAgentConfig>;
}
```

While a workflow is active, chat and workflow execution should route through the workflow's active agent invocation rather than the session default. When the workflow finishes, fails, or is cancelled, Cyboflow should release workflow ownership and route subsequent chat back to the session's pre-existing runtime agent.

This makes these cases explicit:

- A plain session can use Claude SDK for normal chat.
- The user can launch a workflow whose default is Codex SDK.
- One workflow can run a planning step on Claude and an implementation or review step on Codex.
- After workflow completion, the session returns to the Claude SDK agent it had before the workflow started.

Implementation rule: provider/runtime/model must be resolved at the agent invocation boundary, not only at workflow launch. The workflow run may have defaults, but each step can override them.

### New Manager

Add:

```txt
main/src/services/panels/codex/codexSdkManager.ts
main/src/services/panels/codex/codexPtyManager.ts
main/src/services/panels/codex/codexEventNormalizer.ts
main/src/services/panels/codex/codexModelContext.ts
```

`CodexSdkManager` should extend `AbstractCliManager` for lifecycle parity with existing managers, but it should drive the Codex SDK rather than a PTY.

This follows the current Claude SDK precedent: the class can inherit PTY lifecycle helpers from `AbstractCliManager` without using `spawnPtyProcess` for the SDK path. Do not wire Codex SDK through the interactive PTY path.

Expected flow:

1. Build a `Codex` client with a controlled environment.
2. Start or resume a thread with `workingDirectory = worktreePath`.
3. Call `thread.runStreamed(prompt, { signal })`.
4. Persist `thread.started.thread_id` as the invocation `external_session_id`.
5. Normalize each `ThreadEvent` into Cyboflow's provider-neutral stream envelope.
6. Emit `output` and `exit` through the same facade path the run executor consumes.

`CodexPtyManager` should be separate and intentionally narrow:

- It launches the interactive Codex CLI in a PTY for quick sessions only.
- It is not eligible for workflow runs.
- It does not need workflow MCP progress, provider-neutral event projection, usage rollup, or review queue parity in v1.
- It should inherit the same terminal lifecycle constraints as `InteractiveClaudeManager`.

### Dispatch

Replace or generalize `SubstrateDispatchFacade` into an `AgentRuntimeDispatchFacade`.

Workflow runtime dispatch:

```ts
switch (run.agent_runtime) {
  case 'claude-sdk':
    return claudeSdkManager;
  case 'claude-interactive':
    return interactiveClaudeManager;
  case 'codex-sdk':
    return codexSdkManager;
}
```

Quick-session runtime dispatch can additionally support:

```ts
switch (session.agent_runtime) {
  case 'codex-pty':
    return codexPtyManager;
}
```

Keep `codex-exec` internal-only as a diagnostic runner for spikes and fixture capture. It should not appear in launch UI or workflow runtime dispatch unless a later decision explicitly promotes it.

The key invariant remains: dispatch resolves once from the run row and preserves event payload identity after normalization.

### Event Boundary

Do not keep expanding `ClaudeStreamEvent` for Codex. Add a provider-neutral stream type:

```ts
export type AgentStreamEvent =
  | AgentSessionStartedEvent
  | AgentTurnStartedEvent
  | AgentMessageEvent
  | AgentReasoningEvent
  | AgentCommandEvent
  | AgentFileChangeEvent
  | AgentMcpToolEvent
  | AgentUsageEvent
  | AgentErrorEvent;
```

Then implement adapters:

- Claude SDK/transcript normalizer -> `AgentStreamEvent`
- Codex SDK event normalizer -> `AgentStreamEvent`

The raw provider event should still be stored in `raw_events.payload_json` for replay/debugging. The normalized event should drive message projection, review queue, usage, and workflow progress.

### Codex Event Mapping

Initial mapping:

| Codex event | Cyboflow normalized event |
| --- | --- |
| `thread.started` | `agent.session.started` |
| `turn.started` | `agent.turn.started` |
| `turn.completed` | `agent.usage` + rest/completion candidate |
| `turn.failed` | `agent.error` + failed transition |
| `item.started command_execution` | `agent.command.started` |
| `item.updated command_execution` | `agent.command.updated` |
| `item.completed command_execution` | `agent.command.completed` |
| `item.completed file_change` | `agent.file_change.completed` |
| `item.* mcp_tool_call` | `agent.mcp_tool.*` |
| `item.completed agent_message` | `agent.message.assistant` |
| `item.completed reasoning` | `agent.reasoning` |
| `item.completed todo_list` | `agent.plan` |
| `error` | `agent.error` |

## MCP Integration

Cyboflow's MCP server should be available to Codex the same way it is available to Claude:

- `cyboflow_report_step`
- entity write tools
- finding/reporting tools
- artifact tools
- shell approval hook path if needed

Do not ask the user to globally edit `~/.codex/config.toml` as the main path. Generate per-run config through SDK `config` overrides and environment injection where possible:

```ts
new Codex({
  env: {
    PATH,
    HOME,
    CYBOFLOW_RUN_ID: runId,
    CYBOFLOW_ORCH_SOCKET: socketPath,
    CODEX_HOME: perRunCodexHome,
  },
  config: {
    mcp_servers: {
      cyboflow: {
        command: nodePath,
        args: [mcpServerScriptPath],
        env: {
          CYBOFLOW_RUN_ID: runId,
          CYBOFLOW_ORCH_SOCKET: socketPath,
        },
        required: true,
        default_tools_approval_mode: 'auto',
      },
    },
  },
});
```

If SDK config override support is insufficient for nested MCP config in practice, write a per-run `CODEX_HOME/config.toml` in app-owned state, not in the user's repo.

## Approval And Review Queue

This is the main risk area.

Cyboflow cannot ship Codex as a full peer until Codex permission requests reliably land in `review_items`.

Target behavior:

- Cyboflow first-party MCP tools are allowed deterministically.
- Low-risk commands can run according to Codex sandbox/approval policy.
- Any out-of-policy command, filesystem write outside scope, network request, or sensitive action becomes a blocking `review_items.kind = 'permission'`.
- The run remains blocked until the user resolves the review item.

Recommended implementation:

1. Start Codex with `sandboxMode = 'workspace-write'` and `approvalPolicy = 'on-request'` by default.
2. Add a Codex PreToolUse hook or equivalent policy bridge that calls back into Cyboflow's `ApprovalRouter`.
3. Preserve Codex's own sandbox as the technical boundary.
4. Use the review queue as the human decision surface.

Beta limitation if hook parity is not ready:

- Codex can run in `workspace-write` with Codex-native approvals, but Cyboflow should mark review queue parity as incomplete.
- Do not present Codex as equivalent to Claude until approvals are bridged.

## UI Approach

Replace "CLI substrate" as the user-facing top-level control with "Agent".

### Launch Configure Surface

The launch configure surface sets the session's default runtime agent. It does not fully define every workflow agent choice. If the user launches a workflow, the workflow's own agent plan can override the session default while the workflow is active.

Use a compact provider segmented control:

```txt
[ Claude ] [ Codex ]
```

Provider-specific controls below:

Claude:

- Runtime: SDK, Interactive PTY.
- Model: Auto, Fable, Opus, Sonnet, Haiku.
- Permission mode: existing four-mode selector.

Codex:

- Runtime for quick sessions: SDK, Interactive PTY.
- Runtime for workflows: SDK only.
- Model: Auto, GPT-5.5, GPT-5.4 mini, Custom.
- Permission mode: maps to Codex sandbox and approval policy internally.
- Network/web search toggles.

Runtime should appear before model because available model choices can differ by runtime.

Do not expose a separate Codex sandbox dropdown in the launch configure step if session permission settings already represent the same decision. Treat sandbox mode as provider-specific implementation detail behind the shared permission control.

Codex PTY should be selectable only when the user is launching a quick session. If the user is launching a workflow, hide it or show it disabled with concise copy such as "Quick sessions only." Workflows should use `codex-sdk` because they need structured events, MCP workflow progress, usage accounting, and review queue integration.

### Workflow Configuration

V1 workflow configuration should be run-scoped: a workflow chooses one provider/runtime/model setup for the whole workflow, and the session returns to its default agent afterward.

Mixed-provider workflow steps should be a fast-follow after Codex event, MCP, and approval parity are proven. At that point, workflow definitions should have their own step-level agent configuration, separate from the session default:

- Workflow default provider/runtime/model.
- Optional per-step provider/runtime/model overrides.
- Explicit "Inherit from session" and "Inherit from workflow" states for step model selectors.
- Shared permission and review queue behavior.

The workflow editor can start simple by showing the workflow-level default, then reveal per-step overrides in the step inspector in Phase 5. This keeps the launch configure step focused on the session's default chat agent while still leaving a clear path to mixed Claude/Codex workflows.

Step model selectors should support:

```txt
Inherit from session
Inherit from workflow default
Auto
Provider-specific explicit models
```

The UI must resolve runtime before model. If a step inherits the session model but changes runtime/provider to one where that model is unavailable, the selector should show a validation state and ask the user to choose `Auto` or an explicit compatible model.

Example:

```txt
Session default chat: Claude / SDK / Opus
Workflow default: Codex / SDK / GPT-5.5
Step override: "Design plan" -> Claude / SDK / Sonnet
Step override: "Review diff" -> Codex / SDK / Inherit from workflow default
Step override: "Write release note" -> Inherit from session
```

### Settings

Add provider cards:

- Claude Code
  - Availability/auth status.
  - Default runtime.
  - Default model.
  - Default permission mode.

- Codex
  - Auth status.
  - `codex doctor` status.
  - Default runtime.
  - Default model.
  - Default permission behavior.
  - ChatGPT auth status as the v1 auth path.

### Run Surfaces

Run cards and active-run headers should show:

```txt
Claude / SDK / Opus
Codex / SDK / GPT-5.5 / Ask when needed
```

Use provider-specific labels only as metadata. The chat, progress rail, artifacts, tasks, and review queue should remain provider-neutral.

When a workflow is active, show the active workflow agent as the controlling context. When no workflow is active, show the session default agent.

### Review Queue

Keep one review queue.

Cards should include provider provenance in the metadata line:

```txt
Codex requested Bash
Claude requested Edit
```

Do not add provider tabs by default. Filtering by provider can be a later advanced filter.

## Rollout Plan

### Phase 0: Spike

- Install `@openai/codex-sdk`.
- Run a single `CodexSdkManager` fixture against a temporary git repo.
- Capture real `runStreamed()` events for message, command, file change, MCP, and failure cases.
- Save event fixtures under a Codex-specific test fixture directory.
- Verify whether the SDK exposes a synchronous approve/deny hook that can back Cyboflow's review queue approval bridge.
- Verify whether per-run nested `mcp_servers` config works through SDK config overrides. If not, prove the per-run `CODEX_HOME/config.toml` fallback.
- Verify how Codex usage/cost fields are exposed and what normalization is required for `run_usage`.

Exit criteria:

- Can start a Codex turn in a worktree.
- Can stream structured events.
- Can cancel via `AbortController`.
- Can resume by `thread_id`.
- Can answer whether Codex can be approval-bridged into `ApprovalRouter` for v1 parity.
- Can answer whether Cyboflow MCP can be injected without mutating the user's global Codex config.
- Can map Codex usage to Cyboflow usage fields without assuming Claude's `total_cost_usd` shape.

### Phase 1: Schema And UI Plumbing

- Add provider/runtime shared types.
- Add DB migration.
- Add tRPC input fields with Claude defaults.
- Add provider selector UI.
- Add session default agent config.
- Add runtime capability guards so `codex-pty` is valid for quick sessions but invalid for workflows.
- Keep workflow agent config run-scoped for v1. Document mixed-provider per-step config as a fast-follow, not as required v1 schema.
- Keep all launches defaulting to Claude SDK.
- Branch model alias resolution by provider so Claude aliases and Codex model names cannot collide.
- Use ChatGPT auth as the v1 Codex auth path.

Exit criteria:

- Existing tests pass.
- Existing Claude runs are byte-identical except for new read-model fields.
- Existing model alias behavior remains unchanged for Claude.
- Codex model choices do not pass through Claude-scoped alias resolution.
- Workflow launch validation rejects `codex-pty`.
- Quick-session launch validation accepts `codex-pty`.

### Phase 2: Provider-Neutral Event Boundary And Codex SDK Manager

- Add `AgentStreamEvent`.
- Move message projection and run usage from Claude-specific assumptions to provider-neutral events.
- Add `CodexSdkManager`.
- Add `CodexPtyManager` for quick sessions only.
- Add Codex event normalizer.
- Register `codex-sdk` in the runtime dispatch facade.
- Register `codex-pty` only in quick-session dispatch.
- Persist Codex thread ID as invocation `external_session_id`.
- Render Codex messages and usage in the existing run view.
- Keep raw provider payloads for audit.

Exit criteria:

- A Codex run starts from the UI, streams messages, writes raw events, and finishes cleanly.
- Claude and Codex both flow through the same normalized event pipeline.
- Provider-specific code is isolated to adapters/managers.
- Codex usage renders with provider-normalized usage and cost fields.
- A Codex PTY quick session can launch and close without participating in workflow execution.

### Phase 3: MCP And Workflow Progress

- Inject Cyboflow MCP config into Codex.
- Verify `cyboflow_report_step`.
- Verify entity writes and findings.
- Verify artifact reporting.

Exit criteria:

- Planner/Sprint/Compound/Ship can advance through the same MCP-driven workflow progress path under Codex.
- A session returns to its original default chat agent after workflow completion, failure, or cancellation.

### Phase 4: Review Queue Approval Bridge

- Route Codex tool/sandbox approvals to `ApprovalRouter`.
- Create blocking `review_items`.
- Resume Codex after approval or rejection.

Exit criteria:

- Permission cards behave the same as Claude cards from the user's point of view.

### Phase 5: Mixed-Provider Workflow Steps

- Add workflow default and per-step agent config shape.
- Add explicit inherit-session and inherit-workflow selector states.
- Add effective agent resolution from step override -> workflow default -> session default.
- Verify a mixed-provider workflow can switch active agent invocations per step.

Exit criteria:

- A workflow can run Claude and Codex steps inside the same workflow run.
- A workflow can inherit the session model for steps where that is the intended behavior.
- Runtime/provider changes validate the available model list before launch.

## Test Strategy

Add focused unit coverage first:

- Provider/runtime resolver.
- DB migration parity.
- Provider-scoped model alias resolution.
- Codex event normalizer fixtures.
- Provider-neutral `AgentStreamEvent` projection.
- Runtime dispatch selection.
- Invocation-level external session ID persistence.
- Codex manager cancellation and terminal-error behavior.
- Codex MCP config construction.
- Codex approval bridge.

Add integration coverage:

- Claude SDK parity remains unchanged.
- Codex SDK mocked stream runs through `RunExecutor`.
- Codex PTY quick session launches outside workflow dispatch.
- Raw events persist.
- Messages project.
- Usage rolls up.
- Review items appear for permission cases.

Use `pnpm test:unit` as the code-change gate when implementation starts.

## Open Questions

- Phase 0 must answer whether the TypeScript SDK exposes enough config override support for complete per-run MCP config, or whether Cyboflow should always use a per-run `CODEX_HOME`.
- Phase 0 must answer which Codex hook event is best for a blocking Cyboflow approval bridge, and what exact response shape resumes/denies the action.
- Should model defaults be global per provider or per workflow?

## Recommendation

Build Codex support as a provider/runtime expansion:

1. Provider/runtime schema and UI.
2. Codex SDK manager for workflows and Codex PTY manager for quick sessions.
3. Provider-neutral event adapter.
4. MCP parity.
5. Review queue approval parity.

Use ChatGPT auth for the initial Codex integration. Keep `codex-exec` internal-only for diagnostics and fixture capture.

Do not ship the feature as "just another substrate." The architecture cost of introducing the provider axis now is lower than unwinding a widened `substrate` enum later.
