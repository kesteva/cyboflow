# Global assistant on Codex — plan

Status: PROPOSAL (2026-09-03). Follow-on to `GLOBAL-AGENT-PLAN.md` (Stages 0–1 shipped).

## Problem

The onboarding "which agent should be your default?" step writes `defaultAgentRuntime`
(e.g. `codex-sdk`), but that key governs **launches only**. The global assistant is
hard-wired to Claude:

- `index.ts` constructs `AgentThreadService` with `manager: defaultCliManager` — the
  Claude SDK manager — and `defaultModel: getAssistantModel() ?? getDefaultModel()`
  (a Claude alias, floor `'sonnet'`).
- `OnboardingGate.handleModelNext` deliberately skips writing `assistantModel` for a
  Codex pick *because* the assistant cannot run on Codex ("hard-wired to
  ClaudeCodeManager" comment).
- `CodexSdkManager` ignores the four options the assistant's hermetic spawn contract
  relies on (`isolation`, `tools`, `eventsSink`, `mcpScope`) and does run-keyed
  bookkeeping that a run-less `agent:<threadId>` identity cannot satisfy.

So a user who picks Codex as primary still gets a Claude assistant (or a broken one if
Claude is not connected).

## Goal

When the resolved assistant runtime is `codex-sdk`, every assistant turn spawns through
`CodexSdkManager` with the same contract Claude gets today: synthetic identity
`agent:<threadId>`, neutral home cwd, the global-agent MCP tool family only, transcript
persisted thread-keyed via `AgentThreadEventsSink`, warm reuse across turns, and no
human approval prompts. Everything the renderer already does (unified transcript,
proposals, guided onboarding steps 10–12) works unchanged.

Scope v1: `claude-sdk` | `codex-sdk`. OMP/pi as primary ⇒ assistant stays on Claude.

## Design

### 1. Config: `assistantRuntime` + resolver

`AppConfig.assistantRuntime?: 'claude-sdk' | 'codex-sdk'` (+ `UpdateConfigInput`, +
`frontend/src/types/config.ts` — IPC type-parity rule).

`ConfigManager.getAssistantRuntime(): 'claude-sdk' | 'codex-sdk'`:

1. explicit `assistantRuntime` if set and its provider is enabled
   (`isAgentProviderEnabled`);
2. else the provider of `defaultAgentRuntime` mapped through
   `PROVIDER_DEFAULT_RUNTIME`, if that provider is `claude` or `codex` and enabled —
   **this is what makes the onboarding "Codex primary" choice flow through with no new
   UI**;
3. else `'claude-sdk'`.

Model: keep the single `assistantModel` key. Resolution becomes per-provider —
`defaultModel(runtime)`: Claude ⇒ `assistantModel ?? defaultModel` as today; Codex ⇒
`assistantModel` run through `normalizeAgentModelSelection('codex', …)` (a stale
Claude alias floors to `undefined` = Codex app-server default). No second model key.

### 2. `AgentThreadService`: pick a manager per turn

- Deps: `manager` → `managers: Record<AssistantRuntime, AgentSpawnManagerLike>` and
  `runtime: () => AssistantRuntime`. `defaultModel` takes the runtime.
- Event bridge attaches to **both** managers' `'output'` streams (filter by identity is
  already there). Session-id capture is unchanged: Codex's `agent_init` is projected to
  `system/init` with `session_id = external_session_id` (thread id) by
  `agentStreamEventToClaudeStreamEvent`, so `maybeCaptureSessionId` works as-is.
- **Stored conversation id is provider-bound.** Migration
  `130_agent_thread_session_runtime.sql`: `ALTER TABLE agent_threads ADD COLUMN
  session_runtime TEXT` (+ `schema.sql` sync per `database/migrations/AGENTS.md`).
  Store it alongside `claude_session_id` on capture. On a turn whose runtime differs
  from the stored one: clear the id and cold-start on the new provider (never hand a
  Claude session id to Codex `thread/resume` or vice versa). Type field
  `AgentThread.claudeSessionId` keeps its name (column is FROZEN) — add
  `sessionRuntime`.
- Spawn options for Codex add `hidePromptFromTranscript: true` (Codex's app-server
  echoes the user message natively; the service already records the human turn and
  the `contextHint` must never land in the transcript — the Claude manager already
  suppresses its echo whenever `eventsSink` is set).
- `isResumeError` gains the app-server's thread-resume failure text (verify the exact
  string from `turnSession.resumeThread`; add a fixture-based test).
- Retention `'compact-daily'` on Codex: our app-server protocol exposes no compaction
  RPC → degrade to `'clear-daily'` with one info log line. (`'/compact'` as prompt text
  would be sent to the model as a literal message.)
- Error surfacing: `sendMessage` failures today die in `console.error`
  (agentThreadStore "no dedicated error slot yet"). Codex adds two realistic first-turn
  failures — `CodexChatGptAuthRequiredError` and "Codex not installed" — so publish a
  synthetic `agent_result`/`result` `is_error` event into the transcript on spawn
  failure (both providers). Prerequisite, not optional.

### 3. `CodexSdkManager`: honor the hermetic-spawn contract (the core work)

| Gap | Today | Change |
| --- | --- | --- |
| `eventsSink` | Ignored; `RawEventsSink` + `CodexRawNotificationSink` write `raw_events` keyed by run_id (FK → `workflow_runs`; fail-soft drop **with a WARN per event**) | When `options.eventsSink` is set, attach it to the turn's `EventRouter` and skip both built-in sinks. `AgentThreadEventsSink` stores the `agent_*` event verbatim — `derivePersistedEventType` already handles `agent_*`, and `agentThreadUnifiedMessagesListing` already runs `agentStreamEventToClaudeStreamEvent`, so the transcript needs no change. Widen the sink's handler type to `ClaudeStreamEvent \| AgentStreamEvent`. |
| `agent_invocations` INSERT | `createInvocation(runId)` — FK to `workflow_runs`, `foreign_keys=ON` ⇒ **throws** for `agent:<threadId>` and kills the spawn | Skip `createInvocation` + `captureInvocationCodexThreadId` when `isAgentThreadSpawnId(runId)` (or when `eventsSink` is injected). |
| `mcpScope` | `buildMcpConfig` never stamps `CYBOFLOW_MCP_SCOPE` ⇒ the assistant would get the **run-scoped** tool family (most tools fail for a non-run id) and not the global-agent read/propose family | Thread `options.mcpScope` into `buildMcpConfig` env exactly as `composeMcpServers` does. `orchTokenEnv(runId)` / `CYBOFLOW_RUN_ID = agent:<threadId>` already match the Claude path. |
| `isolation: 'agent'` | No equivalent | In `buildCodexAppServerThreadConfiguration`: `sandbox: 'read-only'`, `approvalPolicy: 'never'` (mandatory — `ApprovalRouter.requestApproval` requires a *running* `workflow_runs` row and would throw), `developerInstructions` = `getAgentSystemPrompt()` (already wired via `systemPromptAppend`), plus config to disable web search / apply_patch (verify the key names against the pinned Codex version's config schema). |
| `tools: []` | Codex thread config has no tool allow-list | Cannot be enforced server-side. Residual: **Codex can still run read-only shell commands anywhere the sandbox permits**, so Settings → Assistant "Folder access" / excluded projects (enforced inside the MCP fs tools) does not bind a Codex assistant, and the user's own `~/.codex/config.toml` MCP servers are inherited. See Decision A. |
| Provider gate | `assertProviderEnabled` throws if Codex is switched off in Integrations | Handled upstream by the resolver's fallback to Claude; keep the throw as belt-and-braces. |
| Warm reuse | `spawnKey === panelId` ⇒ warm-eligible; fingerprint covers `developerInstructions` | Works as-is: a prompt edit busts the warm app-server, same as Claude. |

`index.ts`: pass `managers: { 'claude-sdk': defaultCliManager, 'codex-sdk':
createdCodexSdkManager }` and `runtime: () => configManager.getAssistantRuntime()`.

### 4. Frontend

- **Settings → Assistant**: add a Runtime row — `Follow default runtime` (unset,
  shows the resolved value), `Claude`, `Codex`. Swap the Claude-only `ModelSelector`
  for the provider-aware picker already used in `SessionSettings` /
  `RunTypeOverrideDetail` (Codex options from `codexModelCatalogStore`). Reset the
  model when the runtime changes. When the resolved runtime is Codex, show a one-line
  note under Folder access: "Applies to the Claude assistant; Codex reads through its
  read-only sandbox."
- **Onboarding** `handleModelNext`: write `assistantModel` for the Codex pick too when
  the resolved assistant runtime is Codex (drop the Claude-only guard and its comment).
  No new step: "Follow default runtime" inherits step 2. Flip the two
  `OnboardingGate.defaultRuntimeStep.test.tsx` expectations.
- **AgentComposer** model chip: show provider + model (`Codex · gpt-5.3-codex`).
- Guided steps 10–12 and `firstIdeaHint` are provider-neutral already; no change.

## Tests

- `agentThreadService.test.ts`: manager selection per runtime; runtime switch clears the
  stored id; Codex options carry `hidePromptFromTranscript`, `isolation`, `mcpScope`;
  compact-daily degrades on Codex; spawn failure publishes an error event.
- `agentThreadService.parity.test.ts`: `CodexSdkManager` satisfies
  `AgentSpawnManagerLike` at compile time.
- `codexSdkManager.test.ts` + a new `runConfig.test.ts`: injected sink replaces both
  built-in sinks; no `agent_invocations` INSERT for `agent:` ids; `CYBOFLOW_MCP_SCOPE`
  stamped; isolation flags.
- `configManager` tests: `getAssistantRuntime` ladder incl. disabled-provider fallback.
- Frontend: Settings runtime row + picker; onboarding write; composer chip.
- `services/panels/claude/` should stay untouched (types only) — if it is touched,
  `pnpm test:integration` is required per `services/panels/AGENTS.md`.
- Live smoke (fresh `CYBOFLOW_DIR`): onboarding → Codex primary → assistant turn runs on
  Codex; `agent_thread_events` holds `agent_*` rows; `cyboflow_propose_action` yields a
  proposal card; no approval prompt appears; switching the runtime in Settings
  cold-starts cleanly.

## Sequencing (one commit each)

1. `feat(config)`: `assistantRuntime` + `getAssistantRuntime` + per-provider model
   resolution (main + frontend types). — S
2. `feat(codex)`: `eventsSink` honored, invocation bookkeeping skipped for agent ids,
   `mcpScope` env, `isolation` bundle in `runConfig`. — M (core)
3. `feat(assistant)`: multi-manager service, migration 130 + `sessionRuntime`,
   retention degrade, resume-error text, error-event surfacing. — M
4. `feat(main)`: `index.ts` wiring. — S
5. `feat(ui)`: Settings runtime row + provider-aware picker, onboarding write, composer
   chip. — M
6. `docs`: `ARCHITECTURE.md` (assistant runtime), `GLOBAL-AGENT-PLAN.md` §5 open
   question closed, `SHELL-LAYOUT.md` chip note. — S

## Decisions needed

- **A. Folder-access semantics on Codex.** Recommend: accept the read-only sandbox for
  v1 and say so in Settings. Alternative: refuse `codex-sdk` for the assistant while any
  folder restriction is configured (blocks the feature for exactly the users who care).
- **B. Default behaviour.** Recommend: follow `defaultAgentRuntime` automatically
  (fixes the reported bug with zero extra clicks). Alternative: explicit opt-in only.
- **C. Error surfacing** in the rail is in scope (Codex auth / not-installed would
  otherwise fail silently).
