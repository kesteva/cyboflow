# Global assistant on Codex — plan

Status: PROPOSAL (2026-09-03), Codex-adversarial-reviewed (6 findings, all incorporated — see
"Review round 1" at the end). Follow-on to `GLOBAL-AGENT-PLAN.md` (Stages 0–1 shipped).

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
| Option visibility | `isolation` / `eventsSink` / `mcpScope` / `tools` exist only on `ClaudeSpawnOptions` (claudeCodeManager.ts); the Codex manager is typed on `ClaudeSpawnerOptions` (runExecutor.ts) and cannot read them | Add `isolation`, `mcpScope`, `eventsSink` to `ClaudeSpawnerOptions` (type-only import of `SpawnEventsSink`). `services/panels/claude/` stays untouched. `options.isolation === 'agent'` is the ONE discriminator every Codex change below keys on — never id-sniffing. |
| `eventsSink` | Ignored; the per-turn `RawEventsSink` AND the cold-entry `CodexRawNotificationSink` (`onNotification` closure in `buildColdEntry`, codexSdkManager.ts:731) both write `raw_events` keyed by run_id (FK → `workflow_runs`; fail-soft drop **with a WARN per notification** — dozens per turn) | When `options.eventsSink` is set, attach it to the turn's `EventRouter` instead of `RawEventsSink`, and carry `persistRawNotifications: false` on `WarmCodexEntry` so the cold-entry notification sink is skipped too. `AgentThreadEventsSink` stores the `agent_*` event verbatim — `derivePersistedEventType` already handles `agent_*`, and `agentThreadUnifiedMessagesListing` already runs `agentStreamEventToClaudeStreamEvent`, so the transcript needs no change. Widen the sink's handler type to `ClaudeStreamEvent \| AgentStreamEvent`. |
| `agent_invocations` INSERT | `createInvocation(runId)` — FK to `workflow_runs`, `foreign_keys=ON` ⇒ **throws** for `agent:<threadId>` and kills the spawn | Skip `createInvocation` + `captureInvocationCodexThreadId` for isolation spawns. |
| `mcpScope` | `buildMcpConfig` never stamps `CYBOFLOW_MCP_SCOPE` ⇒ the assistant would get the **run-scoped** tool family (most tools fail for a non-run id) and not the global-agent read/propose family | Thread `options.mcpScope` into `buildMcpConfig` env exactly as `composeMcpServers` does. `orchTokenEnv(runId)` / `CYBOFLOW_RUN_ID = agent:<threadId>` already match the Claude path. |
| Approval / question bridges | Both `CodexAppServerApprovalBridge` and `CodexAppServerQuestionBridge` route to `ApprovalRouter` / `QuestionRouter`, which do a guarded `UPDATE workflow_runs … WHERE status='running'` and throw `RunNotRunningError` for a run-less id. The bridges CATCH that and answer decline / cancel — so a turn does not crash, it silently loses the request. MCP tool calls themselves are pre-approved (`default_tools_approval_mode: 'approve'` = "auto-approve MCP tool calls without prompting", Codex config reference) — the same setting every Codex lane relies on — so they never elicit in the first place. | For isolation spawns install a **local fail-closed policy** in place of the routers, mirroring Claude's isolation PreToolUse hook: an `mcp_tool_call` elicitation for a `cyboflow_*` tool → approve locally; every other server request (command / fileChange / permissions / other MCP / user-input question) → decline locally, logged at WARN. Nothing reaches the routers. |
| `isolation: 'agent'` thread config | No equivalent — `buildCodexAppServerThreadConfiguration` never consults `options.isolation`; none of the four `codexPermissionFlagsForMode` branches yields `{read-only, never}` | A NEW isolation branch that bypasses `codexPermissionFlagsForMode` / `agentPermissionMode` entirely (mirrors `composeHookOptions` special-casing `isolation==='agent'` before the ordinary ladder): `sandbox: 'read-only'`, `approvalPolicy: 'never'`, `approvalsReviewer: 'user'`, `developerInstructions` = `getAgentSystemPrompt()` (already wired via `systemPromptAppend`), and config `features.shell_tool = false` + `web_search = "disabled"` (both documented in the Codex config reference: `features.shell_tool` "Enable the default shell tool for running commands", `web_search = "disabled"` "Remove the tool"). |
| `tools: []` / hermetic MCP map | Claude gets an EXCLUSIVE `mcpServers` map + `settingSources: []`; Codex inherits `~/.codex/config.toml`, whose own `mcp_servers` may MERGE with the thread `config.mcp_servers` | With the shell tool and web search off, the only residual escape is a user-configured MCP server. Verify empirically on the first live smoke (the `agent_init` / `mcp/list` surface) whether the thread `config.mcp_servers` table REPLACES or MERGES the user's file; if it merges, pass the user's server names with `enabled_tools = []` (documented allow-list) or accept and document. See Decision A. |
| Provider gate | `assertProviderEnabled` throws if Codex is switched off in Integrations | Handled upstream by the resolver's fallback to Claude; keep the throw as belt-and-braces. |
| Warm reuse | `spawnKey === panelId` ⇒ warm-eligible; fingerprint covers `developerInstructions` and the thread config | Works as-is: a prompt edit or an isolation-config change busts the warm app-server, same as Claude. |

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

- **A. Isolation parity on Codex — RESOLVED by live smoke (2026-09-03, Codex 0.144.3).**
  The thread `config` override MERGES with `~/.codex/config.toml` (the user's `node_repl`
  and the bundled Computer Use plugin's `cua_repl` were callable, as were the ChatGPT app
  connectors). Shipped confinement, each verified by a direct tool probe:
  `sandbox: read-only`, `approvalPolicy: never`, `features.{shell_tool,unified_exec}=false`
  (shell gone), `features.plugins=false` (plugin MCP gone), `features.apps=false` +
  `apps._default.enabled=false` (connectors gone), `features.remote_plugin=false`,
  `web_search="disabled"`, `include_apply_patch_tool=false` (apply_patch is blocked by the
  sandbox anyway), and `mcp_servers.<id>.enabled=false` for every server named in
  `config.toml` (read per spawn, fingerprinted). Disabling a PLUGIN server by name is not
  possible — the override has no transport to merge into and the app-server rejects the
  thread ("invalid transport in `mcp_servers.cua_repl`"). Residual: `collaboration.spawn_agent`
  survives every multi-agent flag spelling on this build; sub-agents inherit the same
  confinement, and the developer instructions forbid spawning. Settings → Assistant shows the
  Codex folder-access note.
- **B. Default behaviour.** Recommend: follow `defaultAgentRuntime` automatically
  (fixes the reported bug with zero extra clicks). Alternative: explicit opt-in only.
- **C. Error surfacing** in the rail is in scope as a prerequisite (Codex auth /
  not-installed would otherwise fail silently).

## Review round 1 (Codex adversarial, 2026-09-03)

1. **Critical (mechanism refuted, mitigation adopted):** "`default_tools_approval_mode:
   'approve'` makes every cyboflow tool call elicit, and the run-less id gets it auto-declined".
   The Codex config reference defines `"approve"` as "auto-approve MCP tool calls without
   prompting" (the other values are `auto` / `prompt` / `writes`), and every Codex lane
   already depends on exactly that. Adopted anyway: the local fail-closed request policy for
   isolation spawns, so a residual elicitation can never reach `ApprovalRouter`.
2. **High (accepted):** `CodexRawNotificationSink` is a cold-entry closure, not the per-turn
   sink — gate it on the entry (`persistRawNotifications`).
3. **High (accepted, strengthened):** isolation parity promoted to Decision A; shell tool and
   web search are now disabled via documented config keys, closing most of the gap.
4. **Medium (accepted):** the bridges catch `RunNotRunningError` and decline — corrected the
   "would throw" wording; `approvalPolicy: 'never'` stays.
5. **Medium (accepted):** the question bridge has the same run-row dependency — covered by
   the local policy row.
6. **Medium (accepted):** the isolation thread config is a new branch, not a flag swap —
   made explicit.

## Live smoke (2026-09-03, fresh data dir, `defaultAgentRuntime: codex-sdk`, no explicit pick)

- Assistant turn spawned through the Codex app-server; `agent_threads.session_runtime =
  codex-sdk`; `cyboflow_overview` succeeded; zero `raw_events` / `agent_invocations` rows.
- Transcript sink initially stored 1174 `agent_unknown` rows per turn (every unprojected
  app-server notification) — now skipped, matching the run-scoped sink.
- A thread-start failure (the plugin-name experiment) surfaced in the rail as a system error
  message — the error-surfacing path works.
- Merge-vs-replace and the tool confinement: see Decision A.
