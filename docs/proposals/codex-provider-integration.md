# Codex Provider Integration Proposal

Date: 2026-07-08
Updated: 2026-07-10
Status: Codex SDK quick sessions and workflow launch are wired through app-server; Codex PTY remains quick-session-only

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

export type SessionAgentRuntime = Exclude<AgentRuntime, 'codex-exec'>;
export type WorkflowAgentRuntime = Exclude<AgentRuntime, 'codex-pty' | 'codex-exec'>;
```

Backfill existing session and workflow runtime rows from the Claude-era `substrate` columns as:

```ts
agent_provider = 'claude'
agent_runtime = substrate === 'interactive' ? 'claude-interactive' : 'claude-sdk'
```

Keep `sessions.substrate` and `workflow_runs.substrate` during the migration window as Claude compatibility projections, then stop exposing them as the primary UI concept.

Current v1 implementation decisions:

- The workflow execution transport is the native Codex 0.143.0 app-server over
  stdio JSON-RPC. Cyboflow packages `@openai/codex` at exactly `0.143.0` and does
  not use `@openai/codex-sdk` for workflow execution.
- `codex-sdk` remains the persisted `AgentRuntime` value, wire value, fixture
  name, and manager/factory compatibility name. It now means "the structured
  Codex workflow runtime" and dispatches to app-server; it is not a claim about
  the underlying npm SDK.
- Workflow launches remain Claude-only. `codex-sdk` rows remain readable and
  internally dispatchable, but new Codex workflow launch and restart requests
  are rejected at the UI, tRPC, and registry boundaries.
- Quick sessions may use `codex-pty` for an interactive terminal-style Codex
  experience. Quick-session `codex-sdk` chat is not wired.
- Native app-server approvals and nested per-thread MCP configuration are proven
  Phase 0 findings. The remaining workflow gate is provider-specific prompt
  compilation plus human-gate and MCP workflow-progress contract coverage.
- `codex-exec` remains internal-only for diagnostics and fixture capture.
- Codex app-server launch requires a ChatGPT account. Cyboflow performs an
  `account/read` preflight before starting or resuming a thread and rejects API-key
  or malformed account state. API-key auth remains a later product/billing decision.

## Implementation Status

Completed foundations:

- Provider/runtime persistence and provider-scoped model handling, while retaining
  the legacy Claude `substrate` compatibility projection.
- Provider-neutral agent-event projection, normalized-event persistence,
  run/session message projection, Codex event correlation, and a separate
  `codex_app_server_notification` audit row for each original notification.
- Codex 0.143.0 app-server transport, initialize/thread/turn lifecycle,
  thread-start/thread-resume primitives, interruption, terminal error handling,
  and internal runtime dispatch. Codex SDK quick-session follow-ups route through
  `sessions:send-input` and resume the latest Codex thread; the manager's legacy
  `continuePanel` compatibility method remains unsupported.
- Native command, file-change, and MCP tool approval requests bridged into
  `ApprovalRouter` and the shared review queue.
- Native `item/tool/requestUserInput` requests bridged into `QuestionRouter` and
  returned to app-server after the user answers.
- Nested `mcp_servers.cyboflow` injection on each `thread/start` and
  `thread/resume`, including run/socket correlation. This is the configuration
  foundation, not proof of workflow progress semantics.
- Codex token usage parsing and rollup, including cache-read and reasoning tokens.
- `codex-pty` quick-session launch, relay, respawn, and close behavior.
- ChatGPT `account/read` preflight and a packaged native executable resolver that
  validates the exact version, platform target, manifest, executable, and bundled
  PATH directory without falling back to an arbitrary system command.

Still gated:

- Compiling each built-in workflow into provider-appropriate Codex prompts rather
  than passing Claude-specific delegation and question instructions through.
- Host-owned human gates with contract coverage for pause, response, resume,
  cancellation, and failure.
- MCP workflow-progress contracts for step reporting, entity/finding writes, and
  artifact reporting across Planner, Sprint, Compound, and Ship.

Until those contracts pass, Cyboflow must not expose Codex workflows or describe
an internal Codex turn fixture as workflow support.

## Goals

- Let users choose Claude or Codex as the session's default chat agent.
- Keep the architecture capable of provider-scoped workflow plans without
  exposing Codex workflows before the compatibility gates pass.
- Preserve Cyboflow's workflow invariant: workflow human attention routes through
  the shared review queue. Codex PTY quick-session prompts remain terminal-native.
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

The initial research covered the Codex SDK, `codex exec --json`, MCP, sandbox,
and auth surfaces. Phase 0 then established that the pinned app-server protocol is
the correct workflow integration surface for this repository:

- `@openai/codex` 0.143.0 supplies the platform-native executable that Cyboflow
  launches as `codex app-server --listen stdio://`.
- App-server supports structured initialize, account, thread, turn, item, usage,
  and error traffic over stdio JSON-RPC.
- App-server sends native server-to-client approval requests for command execution,
  file changes, and marked MCP tool calls. Those requests can block on Cyboflow's
  existing `ApprovalRouter` and receive an accept, decline, or cancel response.
- Nested `config.mcp_servers` is accepted on per-thread start and resume parameters,
  so Cyboflow can inject its run-scoped MCP server without mutating the user's
  global `~/.codex/config.toml` or creating a per-run `CODEX_HOME`.
- Codex sandbox modes and approval policies map behind Cyboflow's shared permission
  modes. App-server remains the technical execution boundary; the review queue is
  the human decision surface.
- ChatGPT login is the only accepted v1 auth state. The app-server process inherits
  the user's Codex environment, then Cyboflow verifies it with `account/read` before
  any thread starts or resumes.
- `codex exec --json` remains useful for diagnostics and fixture exploration, but
  it is not the production workflow runtime.

Primary source links:

- Codex manual: https://developers.openai.com/codex/codex-manual.md
- Codex app-server README: https://github.com/openai/codex/blob/rust-v0.143.0/codex-rs/app-server/README.md
- Codex app-server generated protocol: generated from the pinned `@openai/codex@0.143.0` executable with `codex app-server generate-ts`

Local Cyboflow seams reviewed:

- `shared/types/agentRuntime.ts`
- `shared/types/agentStream.ts`
- `main/src/services/substrateDispatchFacade.ts`
- `main/src/services/cliManagerFactory.ts`
- `main/src/services/panels/codex/codexSdkManager.ts`
- `main/src/services/panels/codex/codexExecutablePath.ts`
- `main/src/services/panels/codex/appServer/`
- `main/src/services/panels/codex/codexPtyManager.ts`
- `main/src/orchestrator/workflowRegistry.ts`
- `main/src/orchestrator/runLauncher.ts`
- `main/src/orchestrator/trpc/routers/runs.ts`
- `frontend/src/components/cyboflow/WorkflowPicker.tsx`
- `frontend/src/components/cyboflow/SubstrateSelector.tsx`

## Recommended Integration Surface

### Primary: Pinned Codex 0.143.0 App-Server

Use the packaged native executable from `@openai/codex` 0.143.0 and communicate
with `app-server --listen stdio://` as the workflow runtime.

Reasons:

- It exposes a host-owned structured lifecycle for initialize, account preflight,
  thread start/resume, turn start/interrupt, notifications, and terminal results.
- Its native server requests provide the blocking approval seam Cyboflow needs for
  review-queue parity. No shell-hook approximation is required.
- Thread start/resume accepts working directory, sandbox, approval policy, model,
  developer instructions, and nested MCP configuration in one invocation-scoped
  request.
- Pinning the executable and validating its native package manifest prevents silent
  protocol drift and avoids dependence on whichever `codex` happens to be on PATH.
- The app-server notifications can be projected into the existing provider-neutral
  event boundary and usage pipeline without pretending they are Claude events.

The persisted runtime remains `codex-sdk` for compatibility. `CodexSdkManager` and
factory/tool IDs retain that name during migration, but their production workflow
implementation is app-server. Renaming storage is unnecessary churn and would not
change the physical transport.

### Secondary: `codex exec --json`

Use this only for diagnostics or fixture capture, not as a production fallback
runner.

Its JSONL stream is useful for event-shape exploration, but it lacks the host-owned
bidirectional approval request/response lifecycle now proven through app-server.

### Avoid: Raw Responses API

Using the Responses API directly would bypass Codex's local coding-agent runtime. It would require Cyboflow to build its own command execution, patch application, sandboxing, MCP integration, and resume semantics. That duplicates the wrong layer.

## Data Model

Add migrations `059` through `065`. Keep each `ALTER TABLE ADD COLUMN` in its own migration file, then run one idempotent backfill migration. This avoids the file-migration runner's coarse duplicate-column handling marking a multi-`ALTER` migration applied after only the first column exists.

Session defaults need their own storage. The existing `sessions.substrate` column only captures the Claude-era quick-session runtime (`'sdk' | 'interactive'`) and cannot represent Codex provider state or `codex-pty` without silently dropping the new `SessionAgentConfig` shape.

Add session columns:

```sql
-- 059_session_agent_provider.sql
ALTER TABLE sessions
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex'));

-- 060_session_agent_runtime.sql
ALTER TABLE sessions
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty'));

-- 061_session_agent_model.sql
ALTER TABLE sessions
  ADD COLUMN agent_model TEXT;
```

Backfill after all new columns exist:

```sql
-- 064_agent_provider_runtime_backfill.sql
UPDATE sessions
SET
  agent_provider = 'claude',
  agent_runtime =
    CASE substrate
      WHEN 'interactive' THEN 'claude-interactive'
      ELSE 'claude-sdk'
    END
WHERE agent_provider = 'claude';
```

`sessions.agent_runtime` should use `SessionAgentRuntime`, not the narrower workflow runtime set. `codex-pty` is valid here because it is a quick-session runtime. `codex-exec` is not valid here because it remains an internal diagnostic runner.

Do not ship workflow-run columns without parallel session columns. The session owns the default runtime agent that powers normal chat before and after workflows, so storage must cover `SessionAgentConfig` explicitly rather than projecting it through the legacy `sessions.substrate` field.

Add workflow run columns:

```sql
-- 062_workflow_run_agent_provider.sql
ALTER TABLE workflow_runs
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex'));

-- 063_workflow_run_agent_runtime.sql
ALTER TABLE workflow_runs
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk'));
```

Backfill after all new columns exist:

```sql
-- 064_agent_provider_runtime_backfill.sql
UPDATE workflow_runs
SET
  agent_provider = 'claude',
  agent_runtime =
    CASE substrate
      WHEN 'interactive' THEN 'claude-interactive'
      ELSE 'claude-sdk'
    END
WHERE agent_provider = 'claude';
```

Keep model in `workflow_runs.model`, but interpret it as provider-scoped. The label renderer should use `(agent_provider, model)` rather than a single global model label map.

Keep session default model in `sessions.agent_model`, also interpreted as provider-scoped. If null, the effective session model is "auto/default for the selected runtime."

For v1, keep workflow provider/runtime/model run-scoped. This gets one Codex-backed workflow running end to end before Cyboflow takes on the extra UI and resolver complexity of mixed-provider steps. `workflow_runs.agent_runtime` should use `WorkflowAgentRuntime`, not the broader session runtime set.

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
- Keep `sessions.substrate` and `workflow_runs.substrate` as compatibility fields for old rows and tests until all callers move to provider/runtime.

## Runtime Architecture

### Session And Workflow Agent Ownership

Separate long-lived session ownership from workflow execution ownership.

The session record owns the default runtime agent:

```ts
interface SessionAgentConfig {
  provider: AgentProvider;
  runtime: SessionAgentRuntime;
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

After the compatibility gate is lifted, this target model makes these cases explicit:

- A plain session can use Claude SDK for normal chat.
- The user can launch a compiled workflow whose default is Codex's structured app-server runtime.
- One workflow can run a planning step on Claude and an implementation or review step on Codex.
- After workflow completion, the session returns to the Claude SDK agent it had before the workflow started.

Implementation rule: provider/runtime/model must be resolved at the agent invocation boundary, not only at workflow launch. The workflow run may have defaults, but each step can override them.

### New Manager

Add:

```txt
main/src/services/panels/codex/codexSdkManager.ts
main/src/services/panels/codex/codexPtyManager.ts
main/src/services/panels/codex/appServer/
main/src/services/panels/codex/codexExecutablePath.ts
```

`CodexSdkManager` extends `AbstractCliManager` for lifecycle parity with existing managers, but it drives the pinned Codex app-server rather than a PTY. The name is a compatibility artifact: the persisted runtime remains `codex-sdk`, while the concrete transport is `codex app-server --listen stdio://`.

This follows the current Claude SDK precedent: the class can inherit PTY lifecycle helpers from `AbstractCliManager` without using `spawnPtyProcess` for the structured runtime. Do not wire Codex workflows through the interactive PTY path.

Expected flow:

1. Resolve and validate the packaged `@openai/codex` 0.143.0 native executable.
2. Launch `codex app-server --listen stdio://` with run-scoped environment.
3. Initialize the app-server and verify its `userAgent` contains the pinned version.
4. Call `account/read` and require ChatGPT auth before creating any thread.
5. Create an append-only `agent_invocations` row for this concrete turn.
6. Start or resume a thread with `cwd = worktreePath`, permission-derived sandbox policy, model, developer instructions, and nested Cyboflow MCP server config.
7. Persist the returned Codex thread ID as the invocation `external_session_id`.
8. Start the turn, persist each original app-server notification in a dedicated
   raw-event row, project notifications into `AgentStreamEvent`, persist those
   normalized events, and emit legacy-compatible panel output through the facade.
9. Interrupt active turns on cancellation, then tear down approval bridges and the app-server process.

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
- Codex app-server notification projector -> `AgentStreamEvent`

The original app-server notification is stored with event type
`codex_app_server_notification` for replay/debugging. The normalized event is
stored separately and drives message projection, review queue, usage, and
workflow progress. Consumers must distinguish the original-notification audit row
from the normalized event row rather than treating both as the same payload shape.

This boundary landed with the Codex app-server manager work, not after Codex rendered through a temporary `Codex -> ClaudeStreamEvent` shim. Rendering Codex messages and usage in the existing run view means rendering provider-neutral `AgentStreamEvent` projections and only adapting outward for legacy listeners.

### Codex Event Mapping

Initial mapping:

| Codex app-server event | Cyboflow normalized event |
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

Do not ask the user to globally edit `~/.codex/config.toml` as the main path. Inject the Cyboflow MCP server through nested app-server `config.mcp_servers` on every `thread/start` and `thread/resume` request:

```ts
thread.start({
  cwd: worktreePath,
  config: {
    mcp_servers: {
      cyboflow: {
        command: nodePath,
        args: [mcpServerScriptPath],
        env: {
          CYBOFLOW_RUN_ID: runId,
          CYBOFLOW_ORCH_SOCKET: socketPath,
        },
      },
    },
  },
});
```

The app-server protocol accepts this per-thread nested config, so no per-run `CODEX_HOME/config.toml` fallback is needed for the current pinned version.

## Approval And Review Queue

Cyboflow cannot ship Codex as a full workflow peer until Codex permission requests reliably land in `review_items` and the workflow human-gate contracts are covered.

Target behavior:

- Cyboflow first-party MCP tools are allowed deterministically.
- Low-risk commands can run according to Codex sandbox/approval policy.
- Any out-of-policy command, filesystem write outside scope, network request, or sensitive action becomes a blocking `review_items.kind = 'permission'`.
- The run remains blocked until the user resolves the review item.

Implemented approval bridge:

1. Start Codex app-server threads with permission-derived `sandbox` and `approvalPolicy` values.
2. Handle native app-server approval requests for commands, file changes, and marked MCP tools.
3. Route those requests through Cyboflow's `ApprovalRouter`.
4. Preserve Codex's own sandbox as the technical boundary.
5. Use the review queue as the human decision surface.

Important nuance:

Codex does not expose a Claude-style pre-tool `canUseTool` callback before Codex's own policy classifier. The bridge operates at the app-server server-request boundary after Codex has decided host approval is required. That is still the right parity point for Cyboflow's review queue because it preserves Codex's sandbox/classifier and lets Cyboflow own the final human approval decision.

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

- Runtime for quick sessions: Interactive PTY.
- Runtime for workflows in v1: unavailable. Keep `codex-sdk` as a persisted,
  internal-fixture runtime until provider-specific workflow prompts compile.
- Model: Auto, GPT-5.5, GPT-5.4 mini, Custom.
- Permission mode: maps to Codex sandbox and approval policy internally.
- Network/web search toggles.

Runtime should appear before model because available model choices can differ by runtime.

The current permission mapping is explicit: `default` uses a read-only sandbox
with on-request approval; `acceptEdits` uses workspace-write with on-request
approval; and `dontAsk` uses danger-full-access with approvals disabled. For the
structured `codex-sdk` runtime, `auto` uses workspace-write/on-request plus
`approvalsReviewer: 'auto_review'`. For `codex-pty`, `auto` has the same CLI flags
as `acceptEdits`; the UI must distinguish those two runtime-specific meanings.

Do not expose a separate Codex sandbox dropdown in the launch configure step if session permission settings already represent the same decision. Treat sandbox mode as provider-specific implementation detail behind the shared permission control.

Codex PTY should be selectable only when the user is launching a quick session. If the user is launching a workflow, hide or disable both Codex runtimes with concise copy such as "Workflows currently use Claude." The backend must reject `codex-sdk` workflow creation and restart even when a caller bypasses the launch UI. Keep the runtime in shared and persisted unions for forward compatibility and internal fixtures.

### Workflow Configuration

V1 workflow configuration is Claude-only. A workflow still chooses one runtime/model setup for the whole run, and the session returns to its default agent afterward. Provider/runtime storage remains wider than the launch capability so existing rows and internal Codex fixtures continue to deserialize.

Codex workflow support should follow only after prompt compilation, event/MCP behavior, human gates, and approval parity are proven. At that point, workflow definitions should have their own step-level agent configuration, separate from the session default:

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

### Phase 0: Transport And Feasibility Spike (Complete)

- ChatGPT auth is viable as the first auth path. `codex login status` reports a ChatGPT login on a configured machine, and the official Codex auth path uses ChatGPT by default when no valid CLI session is available.
- The interactive PTY path should launch `codex` directly. The CLI accepts `--model`, `--sandbox`, `--ask-for-approval`, `--cd`, and `--no-alt-screen`, which are enough for a constrained quick-session terminal runtime.
- The TypeScript SDK path was not the right production surface for this repo because approval and MCP parity are better served by the app-server protocol.
- The pinned app-server exposes host approval requests for command execution, file changes, and marked MCP calls. These requests can be routed through `ApprovalRouter`.
- The pinned app-server accepts nested per-thread `config.mcp_servers`, so Cyboflow can inject its MCP bridge without mutating the user's global Codex config.
- App-server usage notifications expose token counts that can be normalized into Cyboflow's usage fields without assuming Claude's `total_cost_usd` shape.
- `codex exec --json` is useful for diagnostics, fixture capture, and event-shape exploration. Keep `codex-exec` internal-only; do not promote it to a user-facing workflow runtime.

Exit criteria:

- Can start a Codex turn in a worktree.
- Can stream structured events.
- Can interrupt and cancel active turns.
- Can resume by `thread_id`.
- Can approval-bridge Codex app-server requests into `ApprovalRouter`.
- Can inject Cyboflow MCP without mutating the user's global Codex config.
- Can map Codex usage to Cyboflow usage fields.

### Phase 1: Schema And UI Plumbing (Complete)

- Add provider/runtime shared types.
- Add DB migration for both `sessions` and `workflow_runs`.
- Add tRPC input fields with Claude defaults.
- Add provider selector UI.
- Add session default agent config backed by `sessions.agent_provider`, `sessions.agent_runtime`, and `sessions.agent_model`.
- Add runtime capability guards so `codex-pty` is valid for quick sessions while
  both Codex runtimes are invalid for workflow launch and restart in v1.
- Keep workflow agent config run-scoped for v1. Document mixed-provider per-step config as a fast-follow, not as required v1 schema.
- Keep all launches defaulting to Claude SDK.
- Branch model alias resolution by provider so Claude aliases and Codex model names cannot collide.
- Use ChatGPT auth as the v1 Codex auth path.

Exit criteria:

- Existing tests pass.
- Existing Claude runs are byte-identical except for new read-model fields.
- Existing `sessions.substrate` and `workflow_runs.substrate` rows backfill to equivalent Claude provider/runtime values.
- Existing model alias behavior remains unchanged for Claude.
- Codex model choices do not pass through Claude-scoped alias resolution.
- Workflow launch validation rejects `codex-pty` and `codex-sdk` with a clear
  compatibility error, while persisted `codex-sdk` rows remain readable.
- Quick-session launch validation accepts `codex-pty`.

### Phase 2: Provider-Neutral Event Boundary And Codex App-Server Manager (Foundation Complete)

- Add `AgentStreamEvent`.
- Move message projection and run usage from Claude-specific assumptions to provider-neutral events.
- Add `CodexSdkManager` backed by app-server.
- Add `CodexPtyManager` for quick sessions only.
- Add Codex app-server notification projector.
- Register `codex-sdk` in the runtime dispatch facade.
- Register `codex-pty` only in quick-session dispatch.
- Persist Codex thread ID as invocation `external_session_id`.
- Render Codex messages and usage in the existing run view.
- Persist normalized `AgentStreamEvent` payloads and original app-server
  notifications as distinct raw-event rows.
- Bridge native Codex questions through `QuestionRouter`.
- Route Codex SDK quick-session follow-ups through session input and thread resume;
  do not claim support for the manager's legacy `continuePanel` method.

Exit criteria:

- An internal Codex app-server fixture starts, streams messages, writes normalized
  events and original notifications to `raw_events`, and finishes cleanly without
  exposing workflow launch in the UI.
- Claude and Codex both flow through the same normalized event pipeline.
- Provider-specific code is isolated to adapters/managers.
- Codex usage renders with provider-normalized usage and cost fields.
- A Codex PTY quick session can launch and close without participating in workflow execution.

### Phase 3: Prompt Compilation, Human Gates, And Workflow Progress (Next)

- Compile effective workflow prompts and agents for Codex rather than sending
  Claude `Agent` / `AskUserQuestion` instructions or `.claude/agents` bundles.
- Prefer the programmatic execution plane first so the host owns sequencing,
  fan-out, retries, and human gates.
- Verify `cyboflow_report_step` through the injected MCP bridge.
- Verify entity writes and findings.
- Verify artifact reporting.
- Verify pause, resume, cancellation, failure, and host-owned human-gate behavior.

Exit criteria:

- Planner/Sprint/Compound/Ship pass provider-specific prompt and human-gate contract tests and advance through the same MCP-driven workflow progress path under Codex.
- A session returns to its original default chat agent after workflow completion, failure, or cancellation.

### Phase 4: Review Queue Approval Bridge Hardening

- Keep Codex app-server approval requests routed to `ApprovalRouter`.
- Verify command, file-change, and MCP approval/rejection/cancellation cases against real workflow prompts.
- Verify blocking `review_items` recover correctly across app restart.

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
- Workflow runtime compatibility gate across shared, tRPC, registry, restart,
  and both launch surfaces.
- DB migration parity for `sessions` and `workflow_runs`.
- Provider-scoped model alias resolution.
- Codex app-server event projector fixtures.
- Provider-neutral `AgentStreamEvent` projection.
- Runtime dispatch selection.
- Invocation-level external session ID persistence.
- Codex manager cancellation and terminal-error behavior.
- Codex MCP config construction.
- Codex approval bridge.

Add integration coverage:

- Claude SDK parity remains unchanged.
- Codex app-server mocked stream runs through the runtime dispatch path.
- Codex PTY quick session launches outside workflow dispatch.
- Normalized events and original provider notifications persist as distinct rows.
- Messages project.
- Usage rolls up.
- Review items appear for permission cases.

Use `pnpm test:unit` as the code-change gate for implementation work.

## Remaining Product Questions

- Should model defaults be global per provider or per workflow?

## Deferred Engineering Cleanup

The Codex integration widened several established launch APIs, including
`RunLauncher.launch`, quick-session creation, and their IPC callers. Converting
those positional parameter lists to named options objects is worthwhile, but is
deliberately deferred from the correctness pass: it touches every launch path and
needs its own parity audit and focused contract tests. Until then, new parameters
must remain trailing and every caller must be verified together.

The remaining duplicated JSON guards, request-key helpers, quick-session briefing
composition, and launcher model-clamp effects are also refactoring work rather than
provider behavior. Consolidate them separately with parity tests instead of mixing
cross-cutting churn into lifecycle and approval fixes.

## Recommendation

Build Codex support as a provider/runtime expansion:

1. Provider/runtime schema and UI.
2. Provider-neutral event adapter.
3. Codex PTY manager for quick sessions plus internal Codex app-server fixtures.
4. Provider-specific workflow prompt compilation and host-owned human gates.
5. MCP workflow-progress contracts and review queue approval hardening.

Until steps 4-5 pass their contract tests, gate `codex-sdk` from every workflow launch and restart. Do not present raw Codex turn execution as workflow parity.

Use ChatGPT auth for the initial Codex integration. Keep `codex-exec` internal-only for diagnostics and fixture capture.

Do not ship the feature as "just another substrate." The architecture cost of introducing the provider axis now is lower than unwinding a widened `substrate` enum later.
