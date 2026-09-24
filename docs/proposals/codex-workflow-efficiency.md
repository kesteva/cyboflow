# SDK workflow efficiency — accurate Codex usage, direct steps, scoped tools, pooled app-server

Status: PROPOSED (2026-09-24). Based on a read-only audit of the live Cyboflow Codex and
Claude sessions from 2026-09-16 through 2026-09-23 and an adversarial Opus 5.5 review. No
implementation has landed; the measured savings remain provisional pending §3.1.

## 1. Problem and measured baseline

Cyboflow's Codex workflow path works, and observed prompt caching appears healthy, but four
candidate mechanisms may distort reported usage or make the real workload more expensive than
it needs to be:

1. `CodexTurnUsageAccumulator` sums `tokenUsage.last` snapshots without a protocol-level proof
   of whether they are cumulative or per-request, making stored `agent_result` usage suspect.
2. A programmatic Claude or Codex step starts an outer agent whose first responsibility is to
   start a second provider agent to do the actual role work. Both agents consume allowance.
3. Ordinary Codex workflow threads inherit unrelated user MCP/plugin/app surfaces unless they
   happen to be running under the separate global-assistant isolation branch.
4. Every fan-out lane starts and stops a whole Codex app-server process even though one
   app-server can host multiple isolated threads.

The seven-day audit reconstructed provider usage from the final deduplicated
`thread/tokenUsage/updated.params.tokenUsage.last` snapshot for every turn, rather than from
the inflated `agent_result` projection:

| Metric | Observed |
| --- | ---: |
| Registered outer Codex threads with final usage | 282 |
| Spawned child threads with final usage | 282 |
| Total turns | 594 |
| Input tokens, inclusive of cache reads | 41.1 million |
| Cached input tokens | 40.2 million |
| Uncached input tokens | 0.89 million |
| Effective cache-hit rate | **97.82%** |
| Output tokens | 0.261 million |
| Input reported through `agent_result` | 370.8 million (**about 9.0x actual**) |
| Output reported through `agent_result` | 1.26 million (**about 4.8x actual**) |

The workload split shows the avoidable orchestration layer clearly:

| Layer | Threads | Turns | Input | Output |
| --- | ---: | ---: | ---: | ---: |
| Registered outer dispatcher | 282 | 282 | 16,482,102 | 55,341 |
| Spawned worker | 282 | 312 | 24,595,052 | 205,769 |

Under the current interpretation of Codex's `last` field, the outer layer represented about
40% of observed input and 21% of observed output. This is not a claim that removing it saves
exactly 40%: a direct worker must absorb a small amount of its persistence work. It is a
provisional upper bound on the duplicated orchestration surface. The protocol-validation gate
below must confirm the `last` semantics and re-derive this table before it becomes the rollout
baseline.

The provider's own `account/rateLimits/updated` snapshots confirm that consumption is not only
a Cyboflow display bug. In the prior weekly window the last observed meter advanced from 33%
to 74%; after the 2026-09-22 reset, the large Sprint run brought the new window to 13%. The
accounting defect and the real efficiency defect are separate and both need fixing.

The same double-delegation pattern appears in Claude programmatic sessions. The initial
comparison used terminal outer `result.usage` values and deduplicated child assistant messages
(`parent_tool_use_id != null`, grouped by run, session, and message id). Whether terminal
`result.usage` already includes Task-subagent traffic is not yet proven. Until the controlled
Claude probe below resolves that question, the combined total and outer share are provisional.
Child output cannot be reconstructed reliably from the forwarded event stream, so it is
deliberately not estimated:

| Claude programmatic metric | Observed |
| --- | ---: |
| Runs | 9 |
| Outer result records | 297 |
| Task/Agent delegations | 251 |
| Outer input, inclusive of cache reads | 183.6 million |
| Child input, inclusive of cache reads | 169.1 million |
| Naively combined input, pending inclusion probe | 352.7 million |
| Provisional outer share, if sources are disjoint | **52.1%** |
| Outer cache-read rate | **91.42%** |
| Child cache-read rate | **93.31%** |
| Outer output | 2.61 million |

If the two Claude sources are disjoint, the outer share is an upper bound rather than a
promised saving: a direct role must retain the necessary persistence and reporting work. If
`result.usage` includes child usage, outer-only input is closer to 14.5 million and the implied
share is about 8%, not 52.1%. The Claude totals are also not a cross-provider cost comparison
because provider tokenization, accounting, models, and subscription meters differ. The trace
topology justifies investigating a shared architectural opportunity; it does not yet establish
the size of Claude savings.

This conclusion is limited to **programmatic** runs, where the host already owns sequencing,
retries, gates, and loopbacks. The audit also found 143 Task/Agent calls across 13 orchestrated
Claude runs; those parents perform real model-led orchestration and are excluded from the
direct-step conversion.

## 2. Goals and non-goals

### Goals

- Store one accurate, disjoint usage record per Codex turn.
- Execute each programmatic Claude or Codex step with one model agent, while retaining the effective
  role prompt, project/workflow overrides, model and effort pins, result contracts, Cyboflow
  state writes, approvals, and cancellation semantics.
- Give workflow turns only the external capabilities that Cyboflow or the user explicitly
  selected for that run/agent.
- Reuse the local app-server process across concurrent lanes in one workflow run without
  sharing conversation state between lanes.
- Preserve provider-neutral controller semantics and leave orchestrated execution, OMP, pi,
  interactive sessions, quick sessions, and the global assistant unchanged unless a section
  explicitly says otherwise.

### Non-goals

- Sharing one provider conversation between unrelated lanes. Threads stay isolated.
- Disabling prompt caching, changing model selection, or lowering reasoning effort globally.
  The observed model split (Luna for implementation/test writing, Sol for review/verification,
  medium effort) was reasonable.
- Changing subscription policy or inferring dollar cost from subscription allowance.
- Changing `auto_review` approval behavior. That is a separate measurement proposal because
  its allowance impact is not represented in the available token events.
- Redesigning `raw_events` retention. Redundant raw-event persistence is a local database
  concern and is intentionally outside these four increments.
- Converting orchestrated Claude flows to direct execution. Their long-lived parent is the
  orchestrator, not a redundant wrapper around a host-owned step.

## 3. Non-negotiable invariants

1. The host controller remains the workflow sequencer. A direct step may execute only the one
   step and lane item in its prompt.
2. The Cyboflow database remains the source of truth. No replacement state files.
3. All entity writes continue through the existing MCP/router chokepoints.
4. The resolved effective agent is authoritative: project overrides, workflow `agentConfigs`,
   variant deltas, model/runtime/effort pins, prompt addenda, and output contracts must survive.
5. Conversation isolation is stronger than process reuse. Pooling never makes two lanes share
   a thread, history, approval bridge, terminal latch, or usage accumulator.
6. A child thread spawned deliberately by a user-authored prompt is still allowed outside the
   programmatic direct-step path. This proposal removes host-requested double delegation; it
   does not remove Claude Task or Codex collaboration from every product surface.
7. Tool reduction is fail-closed but not silently destructive: a capability explicitly enabled
   for an effective agent/run remains available, or the launch fails with a legible reason.

### 3.1 Mandatory validation gate before implementation

The audit interpretations are hypotheses until they are checked against independent provider
counters. No production behavior in increments 1–4 changes until these probes pass and the
baseline tables are regenerated:

1. **Codex usage semantics.** On the pinned app-server build, capture a controlled turn with
   multiple model/tool round trips and record `last` and `total` at every notification. Compare
   both candidate identities:

   ```text
   sum(last snapshots within turn) == total(end) - total(start)
   final(last snapshot)            == total(end) - total(start)
   ```

   Exactly one interpretation must match within exact integer equality. `total` deltas, not a
   second projection of `last`, are the independent oracle.
2. **Claude inclusion semantics.** Run one controlled Task delegation and compare terminal
   `result.usage` with deduplicated outer-only assistant messages and deduplicated child
   messages. Determine whether `result.usage` is outer-only or inclusive of the child before
   publishing a dispatcher share.
3. **Correction-loop inventory.** Classify the 30 Codex child turns beyond the 282 child-thread
   count as correction prompts, completion checks, retries, or unrelated events. Direct-mode
   evaluation must include any replacement controller loopback or full-step retry.
4. **Model and bucket baseline.** Record outer and child model, effort, uncached input, cache
   creation, cache reads, and output per step. Inclusive input alone is not an allowance proxy.
5. **Codex process/thread lifecycle.** Probe whether MCP servers and their authentication are
   process-scoped or thread-scoped, whether concurrent thread starts are safe, and which
   configuration fields are fixed at process initialization. Increment 4 remains blocked until
   lane attribution and cancellation can be preserved under the observed lifecycle.

The probe fixtures and raw observations become checked-in test fixtures or reproducible scripts.
If a probe contradicts the current audit interpretation, update the proposal and baseline before
implementation rather than forcing the result into the current design.

## 4. Increment 1 — correct Codex usage accounting

### 4.1 Root cause

`rawNotificationSink.ts` describes `thread/tokenUsage/updated.params.tokenUsage.last` as a
cumulative per-turn snapshot and stores it last-write-wins by `run + turn`. In contrast,
`CodexTurnUsageAccumulator.addLastUsage()` adds every update to its prior fields. This would
inflate usage if `last` is cumulative. However, the field name and historical protocol naming
also permit the interpretation that `last` is the most recent request while `total` is
cumulative. A code comment is not sufficient evidence to choose between them.

The four exported `AgentUsage` buckets must remain disjoint:

```text
uncached input = inputTokens - cachedInputTokens - cacheWriteInputTokens
cache read     = cachedInputTokens
cache creation = cacheWriteInputTokens
output         = outputTokens
```

The bucket normalization is independent of the snapshot question. The accumulator is a defect
only if the validation gate proves `last` is cumulative within a turn.

### 4.2 Design

Select the implementation from the controlled `total`-delta probe:

- If `final(last) == total(end) - total(start)`, replace additive accumulation with
  latest-snapshot replacement inside the per-turn accumulator.
- If `sum(last) == total(end) - total(start)`, retain additive accounting and correct the audit,
  comments, and tests instead. Do not ship the replacement path.

For the replacement case:

- Rename `addLastUsage` to `observeSnapshot` so the API states the event semantics.
- On each accepted notification, normalize and replace all five stored fields.
- Keep `hasSnapshot` rather than `updateCount`; `snapshot()` remains `undefined` until the
  first valid notification.
- Use `total` deltas as the validation oracle, not as the stored production calculation unless
  the protocol probe shows that neither `last` identity is stable.
- Retain `Math.max(0, ...)` around uncached input for forward compatibility with temporarily
  inconsistent provider counters.

No database migration is required. Stamp new result payloads with an explicit
`usage_accounting_version`; timestamps are not reliable across reverts and development builds.
If the cumulative interpretation is confirmed, historical `agent_result` rows remain inflated
and Insights must distinguish the old version. A one-off rewrite is deliberately excluded: the
retained raw events do not always contain enough information to reconstruct every older result
after retention/backup compaction.

Keep the prior accumulator selectable behind a temporary accounting-mode flag until the
`total`-delta oracle has passed in production smoke runs. This is a rollback lever, not a
permanent product setting.

### 4.3 Tests

- Unit: one snapshot yields the current bucket breakdown.
- Unit, cumulative interpretation: a growing sequence `10 -> 30 -> 50` yields `50`, not `90`.
- Unit, cumulative interpretation: duplicate snapshots are idempotent.
- Unit, per-request interpretation: three `last` values sum to the matching `total` delta.
- Unit: cache read/write subtraction never produces negative uncached input.
- Manager test: repeated `thread/tokenUsage/updated` notifications followed by
  `turn/completed` emit exactly one `agent_result` carrying the probe-selected aggregate.
- Oracle test: a turn's stored usage equals `total(end) - total(start)` within exact integer
  equality on the pinned protocol fixture.
- Rollup test: a terminal run's `run_usage` equals the sum of its accepted per-turn finals,
  including or excluding descendant threads according to one documented rule that is stable
  before and after direct mode.

### 4.4 Acceptance

- New Codex turns show `agent_result` prompt/output totals equal to the independent `total`-delta
  oracle, with `reported / oracle` ratios between 0.99 and 1.01.
- The cache-hit calculation uses `cached / inclusive input`; it is not allowed to count cached
  tokens in both numerator and an already-inclusive extra denominator.

## 5. Increment 2 — make the programmatic step the worker

### 5.1 Current topology

`SpawnStepRunner` already creates one top-level turn per programmatic step. For both Claude and
Codex, the composed prompt then says:

> Delegate to the `cyboflow-${step.agent}` role ... You are the single writer; subagents are
> edit-only.

Claude resolves the exact `.claude/agents` Task subagent; the Codex runtime envelope maps the
role onto Codex's built-in `worker` or `explorer`. In both cases the outer agent starts the
child, waits for it, interprets its report, performs MCP writes, commits, and returns the final
result. Fan-out lanes are single-shot/fresh in both SDK managers, so there is no accumulated
conversation that requires the extra parent.

The Claude audit measured 183.6 million terminal result input tokens and 169.1 million input
tokens on forwarded child messages. The outer layer is 52.1% only if those sources are disjoint;
the mandatory inclusion probe must establish the real split. The topology still supports a
provider-neutral experiment while leaving orchestrated Claude execution alone.

Codex also produced 312 child turns across 282 child threads. The 30 additional turns may be
dispatcher-driven correction or completion checks rather than incidental duplication. They
must be classified, and any controller loopback or full-step retry that replaces them must be
charged to the direct step during evaluation.

### 5.2 Decision

For `executionModel === 'programmatic'` and either `runtime === 'claude-sdk'` or
`runtime === 'codex-sdk'`, the top-level step turn is the role worker. It must not invoke
Claude Task/Agent delegation or `collaboration.spawn_agent` merely to satisfy Cyboflow's own
delegation prose.

This is a pair of provider adapters, not a fork of workflow semantics. OMP keeps its own native
adapter; pi already performs role work directly because it has no delegation tool; orchestrated
Claude runs retain their current Task arrangement.

### 5.3 Prompt composition

Extend the per-step effective-agent resolver so it can supply the role material already held
by `EffectiveAgent`, not only runtime/model/effort:

```ts
interface ResolvedStepAgent {
  runtime?: WorkflowAgentRuntime;
  model?: string;
  providerModel?: string;
  effort?: ReasoningEffort;
  roleName: string;
  rolePrompt: string;
  tools: CliTool[];
  enabledMcps: string[];
}
```

For a direct SDK step, compose provider-specific system instructions—Claude SDK
`systemPrompt.append` or Codex app-server `developerInstructions`—from:

1. the resolved effective agent's `systemPrompt` (including project/workflow/variant prompt
   overrides), then
2. a host-owned **direct-step addendum** that resolves the one intentional role conflict:
   the role markdown says it is a subagent and never writes Cyboflow state, while this direct
   turn also owns the former dispatcher's exact persistence duties.

The addendum must say, in substance:

- perform the named role's work directly; do not spawn a collaboration agent for it;
- retain the role's file scope, test scope, and result schema;
- after the role work, perform only the state writes and commit/reporting actions explicitly
  required by the step prompt;
- the role's “never writes Cyboflow state” rule still forbids unrequested writes, but the
  step prompt's enumerated persistence contract is an explicit host override;
- stop after this one step.

The user-turn prompt continues to carry task scope, acceptance criteria, prior-step output,
review loopback, runbook protection, and machine-read result contracts. `composeStepPrompt`
gains an execution mode so its first instruction is direct and unambiguous instead of first
ordering delegation and relying on the provider envelope to contradict it:

```ts
executionMode: 'delegated' | 'direct-role'
```

The default remains `delegated`. `SpawnStepRunner` selects `direct-role` only after resolving
the effective provider/runtime to Claude SDK or Codex SDK and finding a concrete effective
agent. Missing role material fails closed with a step error; it must not silently run a generic
unscoped agent.

### 5.4 Tools and state ownership

The direct turn receives the union of:

- tools required by the effective role;
- the run-scoped Cyboflow MCP surface already available to the outer turn; and
- host-required commit/report plumbing.

It does not receive a second copy of the role through Claude Task or Codex collaboration. The
controller still parses `resultText` and owns loopbacks/gates exactly as today. No
model-generated JSON is introduced as a new control plane.

This union must be the minimum privilege for the step, not the union of every capability held
by the former parent and child. The Cyboflow MCP router exposes a step-type-specific method set;
review and verification turns are read-only except for the narrow finding/verdict writes their
contracts require. Codex review/verification turns use a read-only sandbox and have no commit
capability. Claude direct turns structurally disable `Task`/`Agent` and constrain their allowed
tools through the SDK.

Enforcement remains provider-specific. The role `tools` list cannot initially be treated as an
exact denylist for Codex built-ins because the current app-server configuration does not expose
a proven per-thread arbitrary-tool allowlist. It is still carried forward as policy input and
covered by increment 3 where Codex offers enforceable feature/MCP controls. Prompt-only
restrictions must never be described as structural enforcement. Direct-mode expansion to a
role remains blocked until its sandbox and MCP restrictions are structural.

### 5.5 Compatibility and rollout

- Add a temporary allowlist, `CYBOFLOW_DIRECT_PROGRAMMATIC_STEPS`, expressed as
  `provider:role` entries such as `codex:implement,claude:write-tests`.
- Resolve the allowlist once at run start, persist the resolved execution mode with the run,
  and use that snapshot for every lane. A process environment change must not create a mixed
  run or corrupt attribution.
- When off, behavior is byte-identical to today's delegated path.
- Enable Codex first for `implement` and `write-tests`, which were the majority of audited role
  invocations and use the lower-cost model tier.
- Enable Claude next for `implement` and `write-tests`, validating independently against the
  Claude baseline rather than assuming Codex behavior transfers.
- Expand each provider to read-only review/verification roles only after that provider's
  output-contract tests pass.
- Remove the flag only after representative Sprints for both providers complete with no child
  calls caused by the host prompt and with equivalent task/result outcomes.

### 5.6 Tests

- Prompt tests: each provider's direct prompt contains the effective role body, direct-step
  addendum, task scope, and exactly one final-result contract; it contains no instruction to
  delegate.
- Golden-snapshot tests: with the allowlist off, provider prompts and launch configuration are
  byte-identical to the current delegated path.
- Override tests: project prompt replacement, workflow addendum, variant delta, provider model,
  and effort all reach the direct turn.
- Integration: implement edits and reports state in one thread; write-tests does likewise;
  code-review findings and blocking verdicts still drive the controller loopback.
- Negative: a direct role cannot start when effective-agent resolution fails.
- Negative: direct mode never leaks onto OMP, pi, or orchestrated runs, and enabling one SDK
  provider does not enable the other.
- Cancellation: canceling one lane interrupts its turn and produces no late MCP write.
- Metrics: Claude Task/Agent calls and Codex `collabAgentToolCall(tool=spawnAgent)` are zero for
  their respective direct programmatic steps.
- Compaction: the direct-step persistence and result contracts remain available after Claude
  auto-compaction, either because they survive or because the host safely re-injects them.
- Repetition: run at least five matched fixture trials per provider and role. Predeclare
  tolerances for completion rate, controller loopbacks, full-step retries, and result parsing.

### 5.7 Acceptance

- One top-level provider thread/query per ordinary programmatic step; no host-requested child.
- The same acceptance criteria, commits, artifacts, findings, and controller verdicts appear
  as on the delegated baseline.
- Before treatment runs, set a provider-specific savings floor from the validated removable
  share and measurement noise. Codex retains a 25% target if its current baseline is confirmed;
  Claude's floor is set only after resolving whether its terminal result includes child usage.
  On at least five matched Sprint fixtures, the model-weighted total must beat that floor, with
  no increase in per-step uncached input, cache-creation input, or output and no regression
  beyond predeclared tolerances for task completion, verification, loopbacks, retries, or result
  parsing. Usage from loopbacks and retries is charged back to the originating step. The weekly
  provider meter is corroborating evidence only, not a fixture-scale oracle.
- A user-requested child is exempt from the zero-child metric only when delegation originates
  in explicit task/user text rather than a role template, system addendum, or host-composed
  step prompt; record that exemption in local diagnostics.

## 6. Increment 3 — explicit workflow tool surface

### 6.1 Current gap

The hermetic global-assistant branch enumerates and disables user MCP servers and turns off
plugins, apps, remote plugin discovery, image generation, goals, and other unrelated built-ins.
The ordinary workflow branch only overlays the Cyboflow MCP server and otherwise inherits the
user's Codex configuration. The audit observed unrelated `cloudflare-api` and `codex_apps`
servers starting inside child workers.

There is also a parity gap: Cyboflow persists session-level MCP/plugin selections and the
Claude managers enforce them, but `CodexSdkManager` does not currently resolve those session
columns for ordinary workflow spawns.

### 6.2 Decision

Programmatic workflow steps use an explicit, capability-derived surface:

- `cyboflow` is always present and cannot be disabled for a workflow step.
- User MCP servers are disabled by name unless explicitly allowed by the effective agent's
  `enabledMcps` or a run/session selection.
- Plugin/app/remote-plugin surfaces are off by default for programmatic steps. A future or
  existing explicit selection may enable a known capability; inheritance alone may not.
- Shell/edit functionality remains governed by the role, sandbox, permission mode, and the
  existing Cyboflow approval hook. This proposal does not weaken the sandbox to avoid prompts.
- Quick/chat sessions retain today's user-config inheritance. Users reasonably expect their
  chosen tools there; the high-volume autonomous workflow path is the narrowed surface.

The policy applies to both direct turns and delegated programmatic turns, including their
children. That is the path on which the audit observed unrelated server startup. Before
enforcement, mine the seven-day raw events for MCP tools actually invoked by workflow threads,
convert legitimate dependencies to explicit grants, and run a warn-only compatibility phase.

### 6.3 Resolution model

Introduce a provider-neutral spawn policy rather than adding more Codex-specific booleans to
`SpawnStepRunner`:

```ts
interface AgentCapabilityPolicy {
  allowedMcpServers: readonly string[]; // `cyboflow` implicit for workflows
  allowPlugins: boolean;
  allowApps: boolean;
  allowRemotePluginDiscovery: boolean;
  allowCollaboration: boolean;
}
```

For a direct programmatic Codex step:

- `allowedMcpServers` is the validated union of effective-agent `enabledMcps` and explicit
  session/run selections;
- `allowCollaboration` is false because increment 2 made the step direct;
- the other flags are false unless explicitly selected by a capability that maps to them.

`CodexSdkManager` reads the installed/user MCP universe, computes the complement, and emits
`mcp_servers.<name>.enabled=false` entries alongside the required `cyboflow` configuration.
Known feature switches (`plugins`, `apps`, `remote_plugin`, and their required companion
config) are set explicitly rather than relying on global defaults.

Complement disabling is not itself a security boundary: project configuration, profiles,
plugin-contributed servers, or a configuration race may escape the enumerated universe. After
thread start, compare the observed MCP startup set with the resolved policy and abort before
role work on any unexpected server. This post-start verification is the fail-closed control.

Important limitation: on Codex 0.153.3, setting the documented collaboration feature flags
false did not remove `collaboration.spawn_agent` in the global-assistant probe. Therefore
`allowCollaboration:false` is defense-in-depth plus a prompt contract, not yet structural tool
removal. Increment 2's acceptance criterion observes that the tool is not called. If a later
Codex build exposes a reliable exclusion, adopt it behind a versioned capability probe.

### 6.4 Compatibility and failure behavior

- Ship behind `CYBOFLOW_CODEX_EXPLICIT_CAPABILITIES=warn|enforce`. In `warn`, report unexpected
  or missing capabilities without changing behavior; move to `enforce` only after legitimate
  inherited dependencies are represented explicitly.
- Unknown requested MCP name: warn during compatibility rollout, then fail the step before role
  work in enforce mode with a clear configuration error. Do not silently omit a dependency.
  Shared workflows may declare a capability optional explicitly; machine absence alone does not
  make a required capability optional.
- Unavailable required plugin/app capability: same fail-before-invocation rule. An explicitly
  optional capability may be omitted with a diagnostic warning.
- `cyboflow` in a deny list is ignored, matching existing behavior.
- The pool fingerprint in increment 4 includes the resolved capability policy, so a policy
  change can never reuse an incompatible process/thread configuration.

### 6.5 Tests

- Hostile-config integration fixture: globally enabled MCP servers, plugins, apps, and remote
  discovery do not appear in a default programmatic Codex step.
- Post-start verification fixture: a server introduced through project config, a profile, or a
  plugin is detected even when it was absent from the pre-spawn universe.
- Explicit allow test: a validated role MCP is present and usable while siblings stay disabled.
- Session toggle parity tests for malformed, missing, empty, deny, and explicit-allow values.
- `cyboflow` remains required and carries the correct run id, socket, token, scope, and timeout.
- Direct-step threads do not emit unrelated MCP startup notifications in a smoke run.
- Delegated programmatic parents and children obey the same capability policy.

### 6.6 Acceptance

- Default programmatic Codex lanes start only Cyboflow plus explicitly granted servers.
- No `cloudflare-api`, `codex_apps`, or other inherited startup event appears absent an explicit
  grant.
- Prompt/context size, startup latency, and MCP-start failure rate do not regress; context size
  should decrease.

## 7. Increment 4 — pool app-server processes, never conversations

### 7.1 Current topology

`CodexSdkManager.spawnTrackedProcess()` marks a lane spawn as single-shot whenever
`spawnKey !== panelId`. It constructs a cold app-server entry, starts one thread/turn, and
stops the client afterward. This is correct for conversation isolation but conflates thread
lifetime with process lifetime.

A large Sprint consequently repeats binary startup, protocol initialization, MCP startup,
and teardown hundreds of times. Cache behavior at the provider is unaffected, but local
latency, CPU, memory churn, file descriptors, and startup-failure exposure all increase.

### 7.2 Decision

Create a `CodexAppServerPool` that owns long-lived app-server clients. Each lane still creates
a new `CodexTurnSession`, thread, usage accumulator, terminal latch, approval/question bridge,
and invocation row.

This decision is conditional on the lifecycle probe in §3.1. If Cyboflow MCP configuration or
authentication is process-scoped, pooling requires a per-lane identity mechanism—such as a
lane-scoped token carried on every router call—before implementation. If MCP startup is
thread-scoped, remove MCP startup from the expected savings and keep capability policy in the
thread configuration rather than the process key.

Initial pool scope is **one workflow run**. Cross-run pooling is rejected for v1 because the
process environment carries the run id, orchestration bearer token, socket path, sandbox
environment, and test-concurrency settings. Sharing that process across runs would blur an
authentication and cancellation boundary for marginal extra gain.

### 7.3 Pool key and lifecycle

Key a pool entry by the stable process-level fingerprint:

```text
run id
+ Codex executable path/version
+ app-server client protocol version
+ process environment (including orch socket/token and PATH)
+ sandbox/permission family
+ resolved capability policy
```

Model, effort, role developer instructions, and conversation history are thread/turn inputs,
not process-key fields, provided the pinned app-server protocol confirms they are accepted per
thread/turn. Any field the protocol actually bakes at process initialization must be promoted
into the key.

Emit `pool_key_distinct_per_run`. If lane-specific ports, test databases, or environment values
make every fingerprint distinct, the pool must report that it is ineffective rather than claim
process reuse.

Lifecycle:

1. First lane acquires and starts the run's pool entry.
2. Concurrent lanes acquire references and start independent threads.
3. Lane completion releases only its thread resources.
4. Run cancellation interrupts every active turn, then closes the pool.
5. A clean idle pool closes after a bounded TTL; terminal run status closes immediately.
6. App-server process failure rejects all attached turns with the same systemic failure class;
   it does not silently respawn and replay mutating prompts. Any controller retries are capped,
   staggered, and their provider usage is attributed to pooling evaluation.

Use a small configurable process count only if a real concurrency probe shows one app-server
cannot service the workflow's target lane concurrency. Default target is one process per run,
not an arbitrary N-process pool.

### 7.4 Notification routing

Pooling requires a central notification router. Attaching one raw sink and one generic listener
per lane would cause every listener to see every thread's notification and multiply persistence.

The pool router must:

- route outer-thread events by `threadId` to exactly one lane session;
- associate collaboration descendants with their owning lane when collaboration is allowed on
  a non-direct surface;
- persist each raw notification at most once to the owning run;
- send approval/question events only to the bridge for the owning active turn;
- buffer notifications for an unknown thread for a short bounded registration window, then
  diagnostic-log and drop only notifications that cannot affect liveness or accounting;
- answer an unroutable server request such as approval or user input with an explicit denial or
  error—never drop a request that would leave the provider waiting indefinitely;
- unregister ownership before resolving lane teardown, preventing late events from reaching a
  reused key.

This router also creates the right seam for future raw-event filtering, but filtering itself is
outside this proposal.

### 7.5 Concurrency, cancellation, and backpressure

- The pool maintains `threadId -> LaneContext` and `spawnKey -> threadId` maps.
- `killProcess(spawnKey)` interrupts only that lane's active turn.
- `killProcess(runId)` interrupts all lanes and closes the run pool.
- Canceling a lane revokes that lane at the Cyboflow MCP router before interrupting its turn, so
  a late in-flight write is rejected even when the MCP transport is process-scoped.
- Thread start is bounded by the existing workflow concurrency controller; the pool does not
  invent a second scheduler.
- Notification persistence remains ordered per thread. If the central sink queue exceeds a
  bounded threshold, diagnostic raw notifications may be shed only under an explicit policy;
  projected transcript, token-usage, terminal, approval, and tool events are never shed. Every
  shed event increments a local counter.

### 7.6 Rollout and tests

Ship behind `CYBOFLOW_CODEX_APP_SERVER_POOL=1` until the following pass:

- Unit: identical process fingerprints share; any security/config difference does not.
- Concurrency: 20 lane threads complete through one fake client with no event cross-talk.
- Isolation: prompts, usage, result text, approvals, and cancellation remain lane-local.
- Failure: process death rejects every attached lane exactly once and cleans all maps.
- Cancellation: canceling one lane leaves siblings running; canceling the run stops all.
- Persistence: one provider notification produces one raw row, not one row per listener.
- Routing matrix: both direct and delegated steps work through the pool, including a child whose
  first notification arrives before its ownership mapping.
- Integration: a multi-lane programmatic Sprint starts at most one app-server process per run
  under the supported concurrency probe.

### 7.7 Acceptance

- App-server process starts fall from approximately one per lane to one per active run under
  ordinary conditions.
- Lane thread count, model usage, and conversation isolation are unchanged by pooling alone.
- Median and p95 time from lane dispatch to `turn/started` improve materially; target at least
  30% p95 improvement on both a simultaneous 20-lane burst and a representative staggered
  arrival fixture. Serialized thread starts must not make burst p95 worse than the baseline.
- No increase in terminal errors, approval misrouting, or leaked thread state.

## 8. Delivery sequence

The validation gate and increments are intentionally ordered so every later measurement trusts
an independent oracle and every architecture change has a narrow rollback:

| Order | Increment | Why here | Rollback |
| --- | --- | --- | --- |
| 0 | Protocol and accounting probes | Prevents an inverted baseline or unsafe pool design | No production behavior changed |
| 1 | Probe-selected usage accounting | Establishes a trustworthy meter | Temporary accounting-mode flag |
| 3 | Explicit workflow capabilities | Establishes least privilege before parent/child roles are combined | `warn` mode restores inherited surface |
| 2 | Direct Claude/Codex programmatic steps | Largest shared subscription-efficiency opportunity after capability enforcement | Provider/role-selective flag to delegated path |
| 4 | Per-run app-server pool | Local performance change after turn semantics stabilize | Feature flag to single-shot clients |

The implementation order intentionally delivers increment 3's structural capability controls
before enabling increment 2. The numbering continues to identify the four original proposal
areas rather than implying execution order.

Do not combine increments 2 and 4 in one rollout. A direct-step result-contract regression and
a pooled-notification routing regression have very different failure signatures and must remain
independently attributable.

## 9. Observability and evaluation

Add no prompt/code content to telemetry. Local diagnostic counters are sufficient. Shared step
counters carry a local `provider` dimension; app-server and usage-accounting counters remain
Codex-specific:

- `codex.usage.snapshot_updates`
- `codex.usage.final_input/output/cache`
- `agent.step.execution_mode = delegated | direct-role`
- `agent.step.child_spawn_count`
- `agent.step.result_parse_failures`, `loopbacks`, and `full_step_retries`
- `agent.step.usage.{uncached,cache_read,cache_creation,output}` by provider, model, role,
  execution mode, and originating step
- `agent.step.mcp_write_failures`
- `codex.capabilities.mcp_count` and feature booleans (names remain local logs only)
- `codex.app_server.process_starts`
- `codex.app_server.active_threads`
- `codex.app_server.pool_key_distinct_per_run`
- `codex.app_server.dispatch_to_turn_started_ms`
- `codex.app_server.unroutable_notifications`
- `codex.app_server.shed_notifications`

Evaluate with at least five trials of a fixed workflow fixture and one opt-in production Sprint
for each provider. Compare:

1. completed/failed/canceled task outcomes;
2. controller loopbacks and review findings;
3. provider-reconstructed input/cache/output;
4. provider weekly-meter delta where observable, as coarse corroboration only;
5. process starts and dispatch latency;
6. MCP/plugin startups and startup errors.

Cache hit rate is a guardrail, not the optimization target. Codex should remain at least 95%
on a comparable workload; Claude should not decline materially from the matched 91–93%
programmatic baseline. A lower total token count with a slightly lower percentage can still be
a win, but a material cache collapse blocks rollout until explained.

Do not collapse unlike models into a raw-token headline. Where the provider exposes a stable
allowance or cost-equivalent weight by model, use it to compute the model-weighted total and
publish the weights. Otherwise report each model separately and require every materially used
model to pass its bucket guardrails; no invented conversion factor is allowed. Integer weekly
subscription meters include non-Cyboflow activity and are too coarse to judge fixture-scale
changes.

## 10. Expected code touchpoints

Indicative, not an exhaustive implementation checklist:

- `main/src/services/panels/codex/appServer/usageAccumulator.ts`
- `main/src/services/panels/codex/appServer/usageAccumulator.test.ts`
- `main/src/services/panels/codex/codexSdkManager.ts`
- `main/src/services/panels/codex/appServer/runConfig.ts`
- `main/src/services/panels/codex/appServer/runConfig.test.ts`
- `main/src/services/panels/codex/appServer/turnSession.ts`
- `main/src/services/panels/claude/claudeCodeManager.ts`
- `main/src/orchestrator/programmatic/spawnStepRunner.ts`
- `main/src/orchestrator/programmatic/stepPrompt.ts`
- `main/src/orchestrator/workflowPromptRenderer.ts`
- `main/src/orchestrator/agents/effectiveAgents.ts`
- `main/src/index.ts` (`resolveStepAgent` adapter)
- focused programmatic integration tests and a new app-server pool/router test fixture

Before editing `main/src/services/panels/`, read its directory-scoped `AGENTS.md`; the substrate
seam and integration-test requirement apply.

## 11. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Codex `last` is per-request rather than cumulative | Gate the accounting design on an independent `total`-delta protocol probe and retain a rollback mode |
| Claude terminal usage already includes child usage | Treat the 52.1% figure as provisional until an outer-only controlled delegation reconciles all sources |
| Direct agent performs state writes before its file work is valid | Preserve current step ordering in the direct addendum; controller gates and result contracts remain authoritative |
| Role prompt's “subagent/no state” prose conflicts with direct ownership | Host-owned addendum explicitly and narrowly overrides only enumerated persistence duties |
| Removing the dispatcher loses corrective child follow-ups | Classify the observed extra turns; include replacement loopbacks/retries in usage; require repeated matched trials |
| Direct mode concentrates parent and child privileges | Enforce role-specific sandbox and MCP method sets before enabling each role; reviewers remain structurally read-only |
| Claude and Codex diverge in tool controls or result behavior | Keep provider adapters and rollout gates independent while sharing only the controller execution mode |
| A workflow relied accidentally on globally inherited plugins | Explicit capability grants; fail before invocation with a named missing capability; staged rollout |
| Codex feature flags do not actually remove a tool | Treat version-probed enforcement separately from prompt policy; verify the live `tools` surface where possible |
| Pool routes one lane's event to another | Central ownership map, exact `threadId` routing, bounded pre-registration buffering, no guess fallback, and concurrency tests |
| One pooled process becomes a larger failure domain | Reject attached turns once; cap and stagger controller retries; attribute retry usage; never replay mutating prompts automatically |
| Historical Insights use the wrong interpretation if the cumulative hypothesis is confirmed | Accounting-version marker and documentation; do not forge a lossy backfill |

## 12. Open decisions before implementation

1. Whether each provider should expand beyond the proposed implement/write-tests first rollout
   after meeting its independent acceptance threshold.
2. Whether explicit external capabilities are configured only through effective-agent
   `enabledMcps` or also through a run-level selection snapshot. The implementation needs one
   precedence rule, not two implicit inheritance paths.
3. After the lifecycle probe, whether the pinned Codex app-server supports one client at the
   workflow's maximum lane concurrency or requires a small per-run pool with the same
   isolation/router design.
4. How long to retain the accounting, capability, direct-step, and app-server-pool rollout
   controls after production validation. They are not permanent product settings.

## 13. Definition of done

The proposal is complete when the §3.1 probes have resolved the provider semantics, the baseline
has been regenerated, and at least five representative matched programmatic trials per enabled
provider/role demonstrate the shared direct-step outcomes below. The Codex trials must also
demonstrate the Codex-specific accounting, capability, and pooling outcomes:

- accurate Codex `agent_result` and `run_usage` totals against the independent `total`-delta
  oracle, stamped with an accounting version;
- a reconciled Claude outer/child baseline that proves whether terminal result usage includes
  Task-subagent traffic;
- one top-level provider thread/query per programmatic step unless delegation came from explicit
  user/task text and was recorded as an exemption;
- only Cyboflow and explicitly granted external capabilities on Codex workflow threads;
- structurally enforced role-specific sandboxes and Cyboflow MCP method sets, with review and
  verification roles remaining read-only outside their narrow result writes;
- at most one Codex app-server process per active run under the supported concurrency profile;
- no regression in task outcomes, commits, findings, gates, verification, cancellation, or
  security boundaries beyond predeclared tolerances, including loopbacks, retries, and
  result-parse failures;
- each provider beats its predeclared, baseline-derived savings floor on matched direct-step
  workloads, using published model weights or separate per-model results if no defensible
  weights exist, with no increase in uncached input, cache creation, or output per originating
  step;
- at least 30% lower Codex p95 local lane-start latency after pooling on both burst and staggered
  fixtures, with no regression in burst p95.
