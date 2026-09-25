# SDK workflow efficiency — complete usage accounting, scoped Codex tools, direct programmatic steps

Status: PROPOSED, revision 4 (2026-09-25).

Revision 4 folds in a second Codex review, of revision 3 (8 blocking, 5 should-fix, 1 nit):
- Codex turns are linked to invocations from now on (`agent_invocations.codex_turn_id`); past
  runs get a separate run-level key and `codex-run-level` coverage;
- a lane's client and raw sink stay alive through the drain, without delaying the lane;
- unattributed and top-up usage go to their own counted rows, so nothing is dropped or
  counted twice;
- the `total` fallback settles at process scope, not at turn end;
- Claude process segments are recorded at ingestion (`process_instance_id`); past runs are
  marked `claude-segments-inferred`;
- the outer Claude split uses parentless assistant messages only, and §13 uses the §5.2 formula;
- the fold reads `dedup_key` and applies an exhaustive source matrix gated by
  `accounting_version`;
- Codex child rows carry the child's model;
- the backfill runs per run in a transaction, before the rollup rebuild, with a marker written
  last;
- the step address is carried at runtime and stored per invocation, and Claude gets invocation
  rows;
- a config change on warm reuse restarts the app-server process;
- sibling-lane edits are reported, not reverted, until a path-claim protocol exists.

Revision 3 folded in a Codex review of revision 2 (4 blocking, 7 should-fix, 4 nits):
- descendant usage is now disjoint from the root `agent_result`;
- the backfill is a real backfill with a coverage record, not a delete;
- child threads get inherited configuration plus an audit, not a pre-start gate;
- there is one Claude token formula;
- the `total` fallback is baselined on the warm process and pairs updates with responses;
- steps are addressed by full path, and the resolved dispatch is frozen and stored per
  invocation;
- `config/read` is part of a two-phase cold start;
- the controller corrections that replace the dispatcher are specified;
- the kill switch no longer fails fully open.

Revision 2 (2026-09-24) replaced revision 1, which was drafted on `solar-juniper` the same
day. Revision 1 was checked against three sources: the production database (read-only), the
local Codex rollout files under `~/.codex/sessions`, and the code.
That check disproved its Codex accounting premise and blocked its app-server pool.

Nothing from this proposal has landed except the service-tier pin in §4.3.

### What changed from revision 1

| Revision 1 | Revision 2 | Why |
| --- | --- | --- |
| Codex baseline of 41.1M input; `agent_result` described as "9.0x actual" | 816.9M input. `agent_result` holds root threads only; children are missing | r1 summed the final `last` of each turn, and `last` covers only one model request (§1.1) |
| Increment 1 replaces the `last` sum, chosen by a probe | Increment 1 makes accounting complete: descendant threads, mixed-provider rollups, Claude dedup, recompute | The replacement would have cut reported Codex usage about 20x |
| Five probes gate all work | Probes 1–4 answered offline; lifecycle answered by a model-free probe; two small probes remain | §4 |
| — | Service tier pinned to standard for workflow threads (landed) | Every audited workflow thread ran on `priority` |
| — | New Increment 2: fixes to the delegated path | Removes baseline confounds, and each fix saves usage on its own |
| Tools restricted by disabling MCP servers by name | Each tool source closed with its own setting, a `mcpServerStatus/list` gate, and router-side limits per step | Disabling a plugin server by name makes the whole thread fail |
| Direct steps enabled by an env allowlist keyed `provider:role` | Frozen-spec resolved `stepDispatch` keyed by full step address; host eligibility keyed `provider:workflow:<step address>` | Role keys collide, step ids repeat across phases, and env toggles contaminate A/B comparisons |
| Increment 4: per-run app-server pool | Deferred to `codex-app-server-pool.md` | `thread/unsubscribe` leaks MCP children, and the possible gain is under 1% of lane time |
| Session MCP/plugin parity inside the tools increment | Split out as its own small fix (§7.6) | The session columns hold Claude-namespace ids |

Increment numbers now follow delivery order. Revision 1's Increment 3 (capabilities) is now
Increment 3. Revision 1's Increment 2 (direct steps) is now Increment 4.

## 1. Problem and measured baseline

The audit window is 2026-09-16 → 2026-09-23. Sources:

- `raw_events` and `workflow_runs` in the production `sessions.db`, read-only;
- the Codex rollout file for every workflow thread;
- the protocol types generated from the bundled `@openai/codex` 0.153.3.

A second agent re-derived every figure independently. Where it corrected a number, the corrected
figure is used.

Cyboflow's workflow path has two separate problems.

1. **The stored usage is wrong.** It misses most Codex work and double-counts most Claude input,
   so Insights cannot measure any efficiency change.
2. **The work costs more than it needs to.** Four things add cost:
   - Every programmatic step runs a dispatcher agent whose only job is to start a second agent
     that does the role work.
   - Codex workflow threads load unrelated MCP servers, plugins and apps.
   - The Codex role prompt never reaches Codex.
   - Every audited Codex workflow thread ran on the `priority` service tier.

### 1.1 Codex usage semantics (settled)

On 0.153.3, the two fields of `thread/tokenUsage/updated.params.tokenUsage` mean:

- **`last`** is the usage of one model request.
- **`total`** is cumulative per thread, per app-server process. It restarts when a thread is
  resumed in a new process.

In all 564 audited rollouts, the per-request records sum exactly to their turn and thread
totals.

**The exact per-turn check value** is the sum of `rawResponse/completed.usage` for each
(threadId, turnId):

- it is append-only in `raw_events`, with no dedup key;
- no response id appears twice;
- it matches the rollouts on 593 of 593 turns;
- it has been recorded since 2026-09-14T19:51Z.

`total(end) − total(start)` is **not** an exact check. It misses compaction requests, spills
across turn boundaries and resets on resume; 7 of about 600 turns disagree.

Three consequences:

- `CodexTurnUsageAccumulator` is correct to add up `last`.
- The `rawNotificationSink.ts` comment calling the snapshot "cumulative per-turn" is wrong.
- Revision 1's 41.1M is exactly the sum of the final `last` of each turn, which counts one
  request per turn.

### 1.2 Codex baseline

| Metric | Observed |
| --- | ---: |
| Threads with usage | 282 root + 282 child. Roots: 281 workflow, 1 quick chat |
| Turns | 593 |
| Model requests | 13,542 |
| Input, including cache reads | 816.9M (816,946,512) |
| Cached input | 780.7M |
| Uncached input | 36.3M |
| Cache-write input | 0 |
| Output | 3.39M |
| Cache-hit rate | 95.56% |
| Service tier | `priority` on 130/130 recorded thread-settings rows |

Figures in §1 are rounded independently from exact counts, so components can differ from a
rounded total by 0.1M (here, cached plus uncached shows 817.0M).

| Layer | Input | Output | Share of input | Share of output |
| --- | ---: | ---: | ---: | ---: |
| Root (dispatcher) threads | 373.2M | 1.28M | 45.7% | 37.7% |
| Child (worker) threads | 443.7M | 2.11M | 54.3% | 62.3% |
| Programmatic runs only: root | 224.3M | 0.777M | 51.0% | 37.6% |
| Programmatic runs only: child | 215.4M | 1.289M | 49.0% | 62.4% |

What the product stored:

- **Root threads:** `agent_result` matches them to within about 0.4%. The excess comes from
  duplicate `tokenUsage/updated` emissions.
- **Child threads:** nothing is recorded. Stored Codex usage is therefore about 54% too **low**,
  not 9x too high.
- **Mixed runs:** in runs that mix Claude and Codex steps, `run_usage` and Insights carry zero
  Codex usage (§5.1).

Codex lanes inside *orchestrated* Sprints also dispatch through a second agent. Their
dispatchers account for 39.1% of those runs' Codex input. The orchestrated-run exclusion in §2
covers only the Claude orchestrator parent; §7.2 and §8.2 state what applies to these lanes.

### 1.3 Claude baseline (programmatic runs)

How Claude reports usage:

- `result.usage` is per query and counts only the outer agent (297 of 297 results).
- `modelUsage` is cumulative per SDK process and includes Task children.
- Child usage is therefore the difference between successive `modelUsage` readings, minus the
  outer `result.usage`.

| Metric | Outer | Child | Combined |
| --- | ---: | ---: | ---: |
| Input, including cache | 183.6M | 175.7M | 359.2M |
| Cache-read rate | 91.42% | 93.44% | |
| Cache-creation input | 15.75M | 11.5M | |
| Output | 2.61M | 3.15M | 5.76M |

The outer share is 51.1% of input and 45.3% of output. (Rounded independently: the two input
components show 359.3M against the exact combined 359.2M.)

The set covers 9 runs, 297 outer result records and 251 Task/Agent delegations. The audit also
found 143 Task/Agent calls across 13 orchestrated Claude runs. Those parents do real
orchestration and are out of scope.

Claude's stored `run_usage` input is about 2.1x the true value. Each assistant content block is
stored as its own `assistant` row carrying the same `message.usage`. For example, run 232d22d8
has 964 rows for 362 message ids.

### 1.4 What skews the baseline

The shares above are the most that direct execution could remove. They are not yet a fair
comparison, for five reasons.

1. **Service tier.** Every Codex figure was measured on `priority`, which 0.153.3's `model/list`
   describes as "Fast — 1.5x speed, increased usage". How much extra allowance it uses is not
   known. Since 2026-09-24:
   - workflow threads are pinned to the standard tier (§4.3);
   - the user's own config was switched to `default`.

   So **no Codex run from before 2026-09-24 is a valid baseline** for later comparisons.
2. **The child runs a different model or effort from its pin.**
   - Claude: the outer passes `Agent input.model`. 111 of 253 dispatches ran on a model other
     than the outer's, and the task-verify opus pin ran on sonnet in 65 of 74.
     `agentMarkdown.ts` never writes `effort:`.
   - Codex: the outer chooses the child's effort. 29 of 99 write-tests children ran above their
     pin, and 3 code-review children were switched to gpt-6-astra/high.

   So direct execution *at the pinned model* can cost **more** for review roles than today.
3. **Codex never receives the Cyboflow role prompt.** `SpawnStepRunner` passes
   `systemPromptAppend: ''` for Codex (`spawnStepRunner.ts:456`), so no `developerInstructions`
   are sent. Every thread-settings row shows `developer_instructions = null`. As a result:
   - project prompt overrides, variant prompt changes and tuning addenda do nothing on Codex
     today;
   - past Codex prompt A/B results measured nothing.
4. **Single-step dispatches run in the background.** `resolveAgentDispatchBackgroundPin`
   (`claudeCodeManager.ts:356`) treats a single (non-fan-out) programmatic step as a `flow`
   spawn, so its Agent dispatches run in the background. The outer then pays for roughly one
   extra full-context query per child just to collect the result. In planner run e6a1a2df, the
   `tasks` step alone used about 53% of the run's outer input.
5. **There is no outcome baseline for the delegated path.** No programmatic Sprint completed in
   the window: all 7 Sprint runs were canceled, and 6 had been handed over to orchestrated.
   - Handover rewrites `execution_model` to `orchestrated` (`handoverRunHandler.ts`).
   - So filtering on `execution_model = 'programmatic'` silently drops the phases before
     handover.
   - That is why the Claude programmatic set contains **zero** implement and **zero** write-tests
     dispatches.

### 1.5 Other observations

- **Weekly meter.** The provider's `account/rateLimits/updated` snapshots show the previous
  weekly window rising from 33% to 74%. After the 2026-09-22 reset, one large Sprint took the
  new window to 13%. These were measured on the priority tier and not re-checked.
- **State writes.** Codex children made 504 Cyboflow MCP calls, including 124 `report_finding`
  and 124 `update_sprint_task`. Claude children made none. "The outer agent is the only writer"
  is true for Claude only.
- **MCP servers.**
  - Codex root threads start 6 MCP servers from 3 sources: config.toml, plugins and apps.
  - Children start `codex_apps` and `cloudflare-api` (159 threads), and `cyboflow` in 124 of
    283 threads.
  - `codex_apps` exposes 98 tools.
- **Unrequested tools in use.** Workflow roots called `cua_repl` (desktop computer-use) 6 times.
  Sprint implement children used web search 10 times.
- **Process start time.** Starting the app-server process takes p50 0.14s and p95 3.8s, against
  a p50 lane of about 186s.

## 2. Goals and non-goals

### Goals

- Store complete, non-overlapping usage for every Codex and Claude step, so Insights can measure
  change. This includes Codex descendant threads and mixed-provider runs.
- Remove the known skews from the delegated path before comparing anything against it.
- Give Codex workflow threads only the capabilities that Cyboflow or the effective agent
  explicitly selected.
- Run each eligible programmatic step as one model agent. The step must keep its effective role
  prompt, overrides, model and effort pins, result contracts, state writes, approvals and
  cancellation behavior.
- Leave orchestrated execution, OMP, pi, interactive and quick sessions, and the global
  assistant unchanged, unless a section says otherwise.

### Non-goals

- Sharing a provider conversation between lanes.
- Turning off prompt caching, changing model selection, or lowering reasoning effort globally.
  The actual workflow pins are:

  | Codex role | Model / effort |
  | --- | --- |
  | implement | luna / high |
  | write-tests | luna / medium |
  | task-verify | sol / low |
  | code-review | sol / medium |

  luna/high uses the most tokens in both the root and child layers.
- Changing subscription policy, or inferring dollar cost from allowance.
- Changing `auto_review` approval behavior. §12 explains why it still matters for evaluation.
- Redesigning `raw_events` retention.
- Converting orchestrated Claude flows to direct execution.
- Pooling Codex app-server processes. This is deferred to
  `docs/proposals/codex-app-server-pool.md`.

## 3. Invariants

1. **The host controller stays the workflow sequencer.** A direct step runs only the one step
   and lane item in its prompt.
2. **The Cyboflow database stays the source of truth.** No state files replace it.
3. **All entity writes go through the existing MCP/router chokepoints.** Who writes differs by
   provider today:
   - Claude: the outer agent only.
   - Codex: the outer agent *and* the child.

   Direct mode brings Codex down to one writer and leaves Claude at one.
4. **The resolved effective agent is authoritative.** These must reach whichever agent does the
   role work:
   - project overrides;
   - workflow `agentConfigs`;
   - variant deltas;
   - model, runtime and effort pins;
   - prompt addenda;
   - output contracts.

   Today they do not reach Codex (§1.4).
5. **Threads stay isolated.** No two lanes share a thread, history, approval bridge, terminal
   latch or usage accumulator.
6. **Delegation the user writes into a prompt stays allowed.** This covers any delegation
   outside the host-composed programmatic step. This proposal removes only delegation that the
   host itself requests.
7. **Tool reduction fails closed, but never silently.** A capability explicitly granted to an
   effective agent is available. Otherwise the launch fails with a named reason. There are two
   deliberate exceptions, both in §7.5, and every run they affect carries a loud diagnostic:
   - the `warn` rollout mode, which applies nothing;
   - the emergency kill switch, which bypasses only the blocking gate and keeps the source-level
     disabling.
8. **A restriction enforced only by the prompt is never described as structural.**

## 4. Increment 0 — settled questions and remaining groundwork

### 4.1 Revision 1's probes

Revision 1 blocked all work on five probes. Their status:

| Revision 1 probe | Status | Answer |
| --- | --- | --- |
| 1. Codex `last` vs `total` | Settled offline | §1.1. `last` is one request. The check value is the sum of `rawResponse/completed.usage` |
| 2. Whether Claude `result.usage` includes children | Settled offline | §1.3. It counts the outer agent only; `modelUsage` is cumulative and includes children |
| 3. Extra Codex child turns | Classified (approximate) | 29 follow-up turns, about 24.3M input (below) |
| 4. Model and token-type baseline | Settled offline, with skews | §1.2–1.4 |
| 5. App-server lifecycle | Settled by a probe that ran no model | MCP servers start per thread, and `thread/unsubscribe` does not stop them. This is what blocks the pool |

The 29 extra child turns were a mix of:

- timeboxes;
- completeness corrections;
- reverts of edits that went outside the task's scope;
- branch re-syncs.

Direct mode must reproduce these interventions in the controller (§8.6).

### 4.2 Remaining before the increments that depend on it

- **Checked-in reproductions.** Each offline answer becomes a reproducible script under
  `docs/probes/`. Where a test needs one, a *sanitized* fixture goes under
  `main/src/services/panels/codex/appServer/__fixtures__/`. The repo is public, so fixtures taken
  from production `raw_events` must be stripped of prompts, paths and identifiers.
- **Claude SDK probe.** This blocks the Claude half of Increment 4. Run one minimal turn for
  each of:
  - the `tools` option with a role's tool list plus `mcp__cyboflow__*`;
  - `Options.agent = 'cyboflow-<key>'`, checking system-prompt layering, model precedence over
    `Options.model`, and whether the agent can reach the Cyboflow MCP server.

  The same probe also checks, for Increment 1, whether a warm process emits `system/init` once
  per process or once per query. That decides whether past Claude runs can be segmented on
  `system/init` (§5.2 1b).
- **Codex child-inheritance probe.** This blocks Increments 2c and 3. It checks two things about a
  forked `spawn_agent` child:
  - whether it inherits the parent thread's `developerInstructions` (for 2c);
  - whether it inherits the parent's thread `config` overrides, such as `features.plugins =
    false` and a disabled config.toml server (for 3). The host cannot stop a child before its
    first request (§7.3), so inherited configuration is the only structural protection a child
    gets. If children do not inherit it, Increment 3's child coverage shrinks to an audit, and
    the proposal must say so.
  - which spawn or thread-start field carries a child's effective model (for Increment 1's
    per-model attribution, §5.2).
- **Codex version.** Every protocol claim here was verified on 0.153.3. An upgrade to 0.156.1 is
  in progress on another branch. Whichever version lands first, re-run the model-free probes and
  the protocol-shape test (§5.2) against it before building on them.
- **Outcome baseline for the delegated path.** This blocks evaluation of Increment 4. Run the
  Increment 2 arm to completion on the programmatic plane (§8.7). It costs real Sprints, so
  budget for them.
- **Shared fake app-server.** Build `main/src/test/fakes/fakeCodexAppServer.ts`, following the
  existing `fakeSdk.ts` pattern. It must cover:
  - several threads emitting events at once;
  - collaboration children;
  - server requests (approvals and user input);
  - `mcpServerStatus/list`.

  Today there is only a fake local to one test file, and no Codex integration test. Increments
  1, 3 and 4 all need it.

### 4.3 Landed: standard service tier for workflow threads

Commit `ab1de1118`, on branch `mellow-otter-20260924`. Not merged and not smoke-tested live.

How it works:

- `ClaudeSpawnerOptions.standardServiceTier` is set by the two workflow spawn seams,
  `RunExecutor.execute` and `SpawnStepRunner`.
- `buildCodexAppServerThreadConfiguration` then sends `serviceTier: 'default'` on `thread/start`
  and `thread/resume`. This overrides `service_tier` in `~/.codex/config.toml`.
- The field is part of the thread configuration, so it is included in the warm-session
  fingerprint.
- Quick chats and the global assistant keep the user's choice.
- Claude already pins fast mode off for every spawn.

A probe on 0.153.3 that ran no model confirmed the behavior:

| `serviceTier` sent | Tier used |
| --- | --- |
| omitted | inherits `priority` |
| `null` | `default` |
| `'default'` | `default` |

Still open, and optional: measuring how much extra allowance `priority` uses. One matched
fixture pair (priority vs default) would do it, comparing the change in `account/rateLimits`
usedPercent per token. The pin is correct either way.

## 5. Increment 1 — complete usage accounting

Every later measurement depends on this. Without it, direct mode on Codex would move worker
usage from untracked children into `agent_result`. Insights would then show Codex usage
*rising* in Codex-only runs and not changing at all in mixed runs.

### 5.1 Defects

**A1 — Codex descendant threads are never counted.** These are the collaboration child threads.
`TurnSession.acceptsTurn` (`turnSession.ts:719`) drops every usage and terminal notification
that is not from the lane's root thread.

**A2 — Root `agent_result` counts about 0.4% too high.** Duplicate `tokenUsage/updated`
emissions arrive with an unchanged `total` and a non-zero `last`, and each is added again.

**A3 — Mixed Claude+Codex runs record no Codex usage in `run_usage`.**
- `scanRawEventRollups` adds `agent_result` only when `assistantMessageCount === 0`
  (`insightsQueries.ts:780`).
- `selectDailyModelUsage` (`insightsQueries.ts:2666`) has the same per-run condition.
- All 10 mixed runs in the window show Claude usage only. For example, run 91811849 has 159
  Codex `agent_result` rows totalling 223.1M input, and none of it is in `run_usage`.

**A4 — Claude `run_usage` input is about 2.1x too high.** Each content block is stored as its
own `assistant` row, and each row repeats `message.usage`.

**A5 — A misleading comment.** `rawNotificationSink.ts:25` describes `tokenUsage/updated` as
"cumulative per-turn".

### 5.2 Design

**1a — Count Codex usage per response.**

Add `observeResponse(threadId, responseId, usage)` to `CodexTurnUsageAccumulator`.

- Calling it twice with the same `responseId` changes nothing.
- It keeps a separate total per thread.
- `CodexSdkManager`'s notification handler calls it *before* `TurnSession` filters the
  notification, so the root thread's descendants reach it.

The accumulator gets two read methods in place of today's single `snapshot()`:

| Method | Returns | Where it goes |
| --- | --- | --- |
| `rootSnapshot()` | the lane's root thread only | the root `agent_result`, as today (`codexSdkManager.ts:1191`) |
| `descendantSnapshots()` | one cumulative total per descendant thread | one `subagent_usage` row per descendant |

The two outputs are disjoint by construction. `agent_result` stays root-only, as it is today
because `TurnSession` filters child events, so no descendant token is ever counted in both.

**Invocation ↔ Codex turn link.** A warm root thread serves several invocations, and today
nothing records which Codex turn belonged to which invocation: `agent_invocations` stores the
thread id (`external_session_id`) but no turn id (`agentInvocationStore.ts:15`, `:60`), and the
stored notifications carry thread and turn ids but no invocation id. Add a nullable
`codex_turn_id` column to `agent_invocations`, written when `turn/start` returns. From then on,
any stored notification can be mapped (run, thread, turn) → invocation. Past runs have no such
link; 1d handles them separately.

**Descendant rows.**
- Each descendant gets one cumulative row, upserted under a stable Codex-namespaced dedup key
  `codex-subagent:<invocationId>:<threadId>`. This uses the existing `subagent_usage` upsert
  (`persistSubagentUsage`, `shared/streamParser/rawEventsSink.ts:110`).
- The payload uses the nested `message.usage` shape that Insights already reads, and it carries
  `message.model`. The fold takes model attribution from that field (`insightsQueries.ts:672`),
  and a child may run on a different model or effort from its parent.
- **Child model.** The registry records each child's model from the spawn or thread-start
  metadata. The Increment 0 child-inheritance probe must name the field that carries it. When no
  authoritative model is available, the row uses the parent's model, sets
  `model_inferred: true`, and the run's coverage is downgraded (1d).
- A key namespace alone changes nothing: today's fold sums every `subagent_usage` row and never
  reads `dedup_key` (`insightsQueries.ts:652-692`, and the daily path at `:2681-2723`). 1b makes
  both rollups read it.

**Descendant ownership.** Ownership cannot hang off `entry.currentContext`. That context is
valid only during the logical turn, and terminal cleanup clears it (`codexSdkManager.ts:1110`).
Instead, the warm entry keeps a **descendant registry**:
- It maps a child `threadId` to the owning invocation and lane.
- A thread is registered from `spawnAgent.receiverThreadIds` or
  `subAgentActivity(kind=started).agentThreadId`.
- Registration is transitive, so a grandchild belongs to the same lane.

**Drain before teardown.** Today a lane closes its client in the same `finally` block that
handles the root terminal. Lanes are never warm-eligible (`codexSdkManager.ts:624-626`), so the
`finally` calls `closeWarmEntry`, which calls `client.stop()` (`:1110-1129`, `:1214-1235`), and
the raw sink is disposed right after. A late child response has nowhere to arrive. The order
becomes:

1. On root terminal, resolve the step's outcome to the controller as today. The lane is **not**
   delayed.
2. Write each registered descendant's row.
3. Keep the client, the raw notification sink and the registry alive for a bounded drain. The
   drain ends when every registered descendant has reported a terminal state and no response is
   pending, or after 30 seconds, whichever comes first. A response during the drain re-upserts
   its descendant's row.
4. Then settle the fallback (below), stop the client and dispose the sink.

Other endings:
- **Cancellation** interrupts the turn and stops the client immediately, with no drain. Nothing
  can arrive after the client stops, and everything received before it is already counted.
  The run is marked as a canceled run in evaluation anyway.
- **App shutdown** settles whatever has been received and stops every client, as cancellation
  does.
- **A warm parked entry** (not a lane) keeps its client after the drain. A response that
  arrives after its drain goes to the unattributed row.

**Unattributed usage is counted, once.** A response from a thread that was never registered, or
that arrives after its owner's drain, goes to a separate additive row,
`codex-unattributed:<runId>:<threadId>`, with the `descendant_usage_unattributed` diagnostic. The
fold counts this row (1b), so run totals stay exact and only per-invocation attribution is
lost. A thread's usage never moves between keys. Responses from a not-yet-registered thread are
buffered on the entry; if the thread registers before the drain ends they go to its owner's
row, and only what is still unregistered at drain end is written to the unattributed row. Once
written there, a thread's usage stays there, so it is never in both.

**Fallback from `thread/tokenUsage/updated`.** The primary source is `rawResponse/completed`.
The fallback fills gaps in it request by request, not thread by thread:

1. **Keep a baseline per thread.** The warm entry stores the last `total` it saw for each
   (process, thread). A thread first seen in this process starts at 0; `total` restarts per
   process, so that is also right for a resumed thread. The baseline lives on the warm entry,
   not in the per-turn accumulator (`codexSdkManager.ts:898`). That way a second turn on a warm
   process is compared against the first turn's last reading, not against zero.
2. **Count only updates that moved `total`.** An update whose `total` equals the baseline is a
   duplicate emission and is skipped. This is defect A2.
3. **Pair updates with responses, at process scope.** Each counted update's `last` is one
   request's usage, so it has a matching `rawResponse/completed.usage`. Unmatched updates and
   unmatched responses are kept per (process, thread) across logical turns. They are **not**
   settled at turn end, because an update can arrive in one turn and its response in the next.
   Pairing is a multiset match on all token fields, so it does not depend on arrival order and
   handles identical-usage requests.
4. **Top up only at settlement.** Settlement happens when the process's client stops (after the
   drain, on cancellation, or on warm-entry close). An update still unmatched then means its
   response never arrived or had `usage: null`. Its `last` goes to a separate additive row,
   `codex-usage-topup:<runId>:<threadId>`, and `response_usage_missing` is logged. Top-ups never
   modify `agent_result` or a descendant row, so they cannot be counted twice.

If no responses arrive at all, this reduces to today's behavior without the duplicates.
`total(end) − total(start)` is only a cross-check. When it differs from the stored figure for
reasons other than the known ones (compaction), log `oracle_mismatch`; never use it as the
stored value.

**Protocol guards.**
- **Drift diagnostic.** Log loudly when a turn has `tokenUsage` snapshots but no
  `rawResponse/completed`. That means the protocol has changed.
- **Protocol-shape test.** `rawResponse/completed` is typed as internal-only, and its `usage` is
  `TokenUsageBreakdown | null`. Pin the method name, field names and nullability against the
  generated types. A Codex upgrade that changes them then fails CI instead of silently falling
  back.
- **Delivery.** Confirm whether delivery depends on `experimentalApi: true`. The fallback
  covers either answer.

**1b — One rollup, with one formula per provider.**

Replace the per-run `assistantMessageCount === 0` condition with a single shared function.
`scanRawEventRollups`, `selectDailyModelUsage` and the daily model buckets all call it, so they
cannot drift apart again. It lives in a new file next to `insightsQueries.ts`, which is 3,122
lines. Both rollup queries must read each row's `dedup_key` and each assistant event's
`parent_tool_use_id`, which they do not today.

Each token comes from exactly one source:

| Provider | Tokens counted from | Also read, for attribution and checks only |
| --- | --- | --- |
| Claude, outer agent | `result.usage`, per query | parentless deduplicated assistant messages (1c) |
| Claude, children | Δ`modelUsage` − `result.usage`, per query, within one process segment | Task/Agent `tool_use`; parented assistant messages; dynamic-workflow `subagent:` rows |
| Codex, root thread | `agent_result` | — |
| Codex, descendants | `codex-subagent:` rows | — |
| Codex, unattributed | `codex-unattributed:` rows | — |
| Codex, missing responses | `codex-usage-topup:` rows | — |
| OMP, pi, other | their existing `agent_result` / `subagent_usage` sources, unchanged | — |

The source matrix is exhaustive and applies only to runs whose `accounting_version` is current.
Rows under an older version keep the legacy fold, so an un-backfilled run is never re-counted
under the new rules.

Rules for the Claude child formula:

- **Segments.** A process segment is one SDK process. The rollup cannot infer this reliably:
  result events carry `session_id` but no process identity (`shared/types/claudeStream.ts:241`),
  cold resumes reuse the session id (`claudeCodeManager.ts:2056`, `:2247-2305`), and a
  restarted process can pass the previous process's totals before its first stored result, so
  no counter need go down. So **record the segment at ingestion**:
  `claudeCodeManager` mints a `process_instance_id` for each SDK process it spawns and stamps it
  on every stored event from that process. Segments are then exact for new runs.
- **Past runs.** Segment on stored `system/init` events, with a counter decrease as a second
  signal. This is a heuristic; the existing reset handling in the cost fold
  (`insightsQueries.ts:723-741`) is a conservative cost-and-output check, not an exact segment
  detector. Before relying on `system/init`, the Increment 0 Claude SDK probe must confirm
  whether a warm process emits one per process or one per query. Past Claude runs get
  `claude-segments-inferred` coverage (1d).
- **First reading.** The first reading in a segment counts from zero.
- **Negative result.** If Δ`modelUsage` − `result.usage` comes out negative, clamp that token
  type to 0 and log `claude_child_delta_negative`.
- **Missing `modelUsage`.** A result with no `modelUsage` contributes zero child tokens and logs
  `claude_model_usage_missing`.
- **Per-model split.** Take it from Δ`modelUsage` for each model. The outer's own per-model
  figures come from parentless deduplicated assistant messages (1c).
- **Dynamic-workflow rows.** Rows from `dynamicWorkflowTracker` run inside the same Claude
  process, so `modelUsage` already contains them. In Claude runs they become attribution-only.
  Today's fold adds them unconditionally. Check whether it also counts the same work through
  forwarded child assistant rows; if so, that is a further double count, and 1b removes it.

**1c — Deduplicate Claude assistant messages, and separate outer from child.**

- Count each (session, `message.id`) once.
- Assistant events carry `parent_tool_use_id` (`shared/types/claudeStream.ts:173`). A non-null
  value marks a forwarded sub-agent message (`shared/streamParser/messageProjection.ts:315-362`),
  and the sink stores these unchanged (`rawEventsSink.ts:182-192`). Only **parentless** messages
  describe the outer agent.
- Messages are no longer a token source (1b). Parentless ones supply the outer's message count
  and per-model split; parented ones are attribution for children.
- They also give a check: summing the deduplicated parentless messages should come close to
  `result.usage`. A large gap logs `claude_outer_mismatch`.

**1d — Backfill past runs, and record how complete each run's accounting is.**

Deleting `run_usage` rows, as migration 132 did, is not enough. The boot rebuild runs the fold
over `raw_events`, and past runs have no `codex-subagent:` rows for the fold to find.

1. **Schema migration.** Take the next free number (145 when this was written).
   - Add `accounting_version INTEGER NOT NULL DEFAULT 0` and
     `coverage TEXT NOT NULL DEFAULT 'legacy'` to `run_usage`, with a `CHECK` on the coverage
     values. The defaults label every existing row explicitly.
   - Add `codex_turn_id` (1a) and, for Increment 4, the columns in §8.3, to
     `agent_invocations` in the same or a following migration.
   - Update `schema.sql`, and extend the writer in `runUsageRollup.ts:129`, which today inserts
     only nine fields.

   | `coverage` | Meaning |
   | --- | --- |
   | `complete` | every token source was available and attributed per invocation |
   | `codex-run-level` | Codex run totals are complete, but descendant usage is attributed to the run and root turn, not to an invocation |
   | `codex-model-inferred` | some Codex child rows use the parent's model |
   | `claude-segments-inferred` | Claude process segments were inferred from `system/init` and resets |
   | `codex-root-only` | Codex descendants could not be reconstructed |
   | `legacy` | written before this change and not recomputed |

   A run with several limitations gets the most severe, in the table's order from bottom to
   top. The rollup writer records the value together with the current `accounting_version`.

2. **Historical key.** Past runs have no invocation ↔ turn link (1a), so replay cannot produce
   the live `codex-subagent:<invocationId>:<threadId>` key. It writes
   `codex-subagent-run:<runId>:<rootThreadId>:<rootTurnId>:<threadId>` instead, using the thread
   and turn ids the stored spawn notifications carry. These rows count exactly like live
   descendant rows in 1b, and the run is marked `codex-run-level`.

3. **One-shot boot backfill.** This is TypeScript that runs before `backfillRunUsageRollups`
   (called from `index.ts:4160-4172`; defined at `runRecovery.ts:921-982`). For each run with
   `codex_app_server_notification` rows, in one transaction per run:
   - replay the stored `rawResponse/completed` and spawn notifications through the same registry
     and pairing code as 1a (both kinds are persisted; only the two delta methods are dropped,
     `rawNotificationSink.ts:12-46`);
   - write the historical rows with their upsert keys, so re-running is harmless;
   - recompute and write that run's `run_usage` row with the new fold, coverage and version;
   - record the run in a per-run progress table.

   Claude runs need no new rows, only the recompute, because 1b works from stored `result`,
   `modelUsage` and assistant payloads.

   The completion marker is written only after every run has succeeded. A failure is logged and
   leaves that run's old row and the marker untouched, so the next boot resumes from the
   progress table. No run is left with a deleted rollup.

4. **Runs before 2026-09-14T19:51Z.** These have no `rawResponse/completed`. Their descendant
   `tokenUsage/updated` notifications were kept only last-write-wins per (run, turn), so they
   cannot be summed. They are rebuilt root-only and marked `codex-root-only`.

5. **Daily buckets** read `raw_events` through the shared fold, so they pick up the backfilled
   rows without a separate step.

Two things are deliberately not changed:
- Historical root `agent_result` payloads are not rewritten. Their roughly 0.4% duplicate-update
  overcount stays, and it is documented.
- Runs with no `raw_events` keep their stored value and stay `legacy`, following migration
  132's rule.

**1e — Fix the comment.**

Correct `rawNotificationSink.ts:25`. Add a sink test that `rawResponse/completed` is never
deduplicated.

There is no accounting-mode flag. 1a has an exact, independent check value, and rolling back is
a revert.

### 5.3 Tests

**Accumulator and fallback:**
- one response;
- several responses add up;
- a repeated `responseId` adds 0;
- `rootSnapshot()` excludes descendants, and `descendantSnapshots()` excludes the root;
- a duplicate `tokenUsage/updated` with unchanged `total` and non-zero `last` adds 0;
- partial delivery: 3 counted updates and 2 responses tops up exactly the unmatched `last`, into
  the `codex-usage-topup:` row;
- null `usage` on a response is topped up from its update;
- an update in turn A whose response arrives in turn B is matched, not topped up;
- two requests with identical usage, one response missing, top up exactly one;
- a second turn on the same warm process is baselined against the first turn's last `total`;
- a new process starts each thread's baseline at 0;
- compaction requests are counted;
- uncached input is never negative.

**Manager, using the fake app-server:**
- A lane whose root spawns a child and a grandchild emits one root `agent_result` and two
  `codex-subagent:` rows.
- Each row is correct on its own, and the three add up to the lane's
  `rawResponse/completed.usage` total with no overlap.
- The step outcome resolves at root terminal, before the drain ends.
- The client is not stopped until the drain ends; a child response that arrives after root
  terminal but within the drain updates its row.
- An unregistered thread's usage lands in `codex-unattributed:` and is counted in `run_usage`.
- Cancellation stops the client with no drain.
- A child row carries the child's model; with no model metadata it carries the parent's model
  and `model_inferred`.
- The invocation row records `codex_turn_id`.

**Protocol shape:**
- `rawResponse/completed` is pinned against the generated types.

**Rollups:**
- In a mixed claude-primary fixture, `run_usage` equals Claude (outer plus child) plus Codex
  root, descendants, unattributed and top-ups, and equals the sum of the daily buckets.
- Multi-block assistant messages are counted once, and never as tokens.
- Parented assistant messages never enter the outer per-model split.
- Claude cases: a new `process_instance_id` starts a new segment; a restarted process whose
  first reading is above the previous totals still starts a new segment; a negative child delta
  clamps and logs; a result with no `modelUsage` logs.
- A Claude run with dynamic-workflow `subagent:` rows is not double-counted.
- A run at an older `accounting_version` is folded with the legacy rules.

**Backfill:**
- Running it twice gives the same rows.
- A failure midway leaves the failed run's old row and no completion marker, and the next boot
  finishes it.
- A post-boundary Codex run is marked `codex-run-level` and uses the historical key.
- A run before the boundary is marked `codex-root-only`.
- Runs with no `raw_events` are untouched and read `legacy`.
- The daily buckets for a backfilled run match its `run_usage`.

### 5.4 Acceptance

- For new Codex runs, stored input and output per run (root, descendant, unattributed and
  top-up rows) equals the sum of `rawResponse/completed.usage` exactly, and per lane when no
  unattributed row exists.
- For the audit window, the backfill reproduces two figures within 0.5%. The historical 0.4%
  root overcount fits inside that tolerance.
  - Codex: §1.2's 816.9M input and 3.39M output, minus the one quick-chat root.
  - Claude: §1.3's outer and child totals.
- Mixed runs show both providers in `run_usage` and in the daily model buckets.
- Every `run_usage` row carries `accounting_version` and `coverage`, and only `complete` rows are
  used for per-invocation comparisons in §8.7.

## 6. Increment 2 — fixes to the delegated path

These are cheap changes to today's delegated path that need no new architecture. Each one saves
usage or fixes a defect on its own. Together they make the delegated path a fair comparison
point for Increment 4, called the "delegated-fixed" arm.

**2a — The Claude child uses its pinned model and effort.**

- **Strip the model override.** Use the existing PreToolUse `updatedInput` merge for Agent
  dispatches, the same one that applies the `run_in_background` pin (documented at
  `claudeCodeManager.ts:388`, implemented around `:404-422`).
  Remove `input.model` from dispatches the host requested in programmatic steps, so the
  subagent's frontmatter `model:` wins.
- **Write the effort.** Have `agentMarkdown.ts` write `effort:` when the effective agent has one.
  First check that the CLI honors `effort` in subagent frontmatter. If it does not, record that
  as a known skew.

Codex has no equivalent place to strip the model. The outer chooses the child's effort in the
`spawn_agent` call, so on Codex this skew stays until Increment 4.

**2b — Run dispatches in the foreground for single-step programmatic runs.**

In `resolveAgentDispatchBackgroundPin`, classify single-step programmatic spawns separately
from the flow orchestrator, and pin `run_in_background = false` for them, as lanes already are.
Background dispatch exists to keep an interactive orchestrator steerable; a programmatic step
turn has nothing to steer.

**2c — Deliver the role prompt on Codex.**

- **If** the Increment 0 child-inheritance probe shows forked children inherit the parent's
  `developerInstructions`: send the effective role body as thread `developerInstructions` on
  programmatic Codex steps.
- **Otherwise:** put it in the spawn message the host composes.

Either way, prompt overrides and variant changes start working on Codex. Split historical Codex
prompt-variant stats at this change, because comparisons before 2c measured nothing.

**2d — Service tier.** Already landed (§4.3).

**Tests:**
- The `updatedInput` merge drops `model` only for dispatches the host requested in programmatic
  steps. It keeps the rest of the input, which must be spread in full (anthropics/claude-code#30770).
- Agent markdown writes `effort:` only when one is set. An agent that inherits its model gets
  byte-identical output to today.
- The background-pin tests gain a row for single-step programmatic runs.
- Codex programmatic threads carry the role body, and project and variant overrides reach it.

**Acceptance, in a matched run:**
- Claude children run on their pinned model in 100% of dispatches the host requested.
- Outer input for single-step programmatic runs falls.
- Codex prompt overrides visibly change the child's instructions.

## 7. Increment 3 — explicit Codex workflow capability surface

### 7.1 Current gap

The global assistant's isolated configuration turns off:

- user MCP servers;
- plugins and apps;
- remote plugin discovery;
- image generation;
- goals.

Ordinary workflow threads get none of that. They only add the `cyboflow` server on top of the
user's Codex configuration (§1.5).

`agent_init` also hard-codes `mcp_servers: [{ name: 'cyboflow' }]` (`codexSdkManager.ts:1467`),
so the transcript misreports which servers actually started.

### 7.2 Decision

This applies to programmatic workflow steps on Codex, delegated or direct, on both root and
child threads. It also covers Codex lanes of orchestrated Sprints: they are spawned through the
same `SpawnStepRunner` → `CodexSdkManager` path. Increment 4's direct dispatch does not cover
them.

| Capability | Policy |
| --- | --- |
| `cyboflow` MCP server | Always present; cannot be disabled |
| Other MCP servers | Allowed only if listed in the effective agent's `enabledMcps`, resolved against the *Codex* server list |
| Plugins, apps, remote plugin discovery, image generation, goals | Off unless an explicit capability maps to them |
| Web search | Its own setting, **not** derived from role `tools` (implement children used it without a WebSearch grant). Decide the implement/write-tests default during the warn phase; likely on for implement/write-tests and off for review/verify |
| Shell and edit | Still governed by the role, sandbox, permission mode and the Cyboflow approval hook |

Quick and chat sessions keep inheriting the user's configuration, as today.

### 7.3 Mechanism

Each source of tools is closed with its own setting. Disabling everything by name is unsafe:
`mcp_servers.<id>.enabled = false` for an id that config.toml does not define creates an entry
with no transport, and the app-server then rejects the whole thread. This was verified live and
is documented in the `userMcpServers.ts` header.

| Source | Setting |
| --- | --- |
| config.toml servers | Disable by name, but only ids the *effective* configuration defines. List them with `config/read { cwd, includeLayers: true }` so project config and profiles are included; the current header scan reads only `$CODEX_HOME/config.toml`. This changes the cold start (below) |
| Plugins | `features.plugins = false` |
| Apps | `features.apps = false` plus `apps._default.enabled = false` |
| Remote plugin discovery | `features.remote_plugin = false` |
| Image generation, goals | Their feature switches, as in the isolated configuration |

A probe on 0.153.3 that ran no model verified these settings.

**Cold start becomes two-phase.** Today `CodexSdkManager` builds the isolation inputs and the
warm fingerprint (`codexSdkManager.ts:629`, `:636`) before it constructs and starts the client
(`:973`). `config/read` needs a running app-server, so the cold start becomes:

1. Start and initialize the app-server process.
2. Call `config/read { cwd, includeLayers: true }`.
3. Resolve the capability policy against that effective configuration.
4. Build the final thread configuration and its fingerprint.
5. Call `thread/start`.
6. Run the gate (below).
7. Call `turn/start`.

The warm fingerprint splits in two:
- a **process fingerprint** (executable, environment, cwd) that decides whether a warm process
  can be reused;
- a **thread-configuration fingerprint** that includes a digest of the `config/read` result and
  the resolved policy.

On every warm reuse, re-run `config/read`. It is one local call. If the digest has changed
because the user edited config.toml or a profile, **close the client and start a new app-server
process**; never reuse a configuration built from stale input. Opening a second thread in the
same process is not an option: `CodexAppServerTurnSession.openThread` rejects a second thread
once one is bound (`turnSession.ts:666-683`), the warm entry owns exactly one thread
(`codexSdkManager.ts:165-195`), and there is no way to unload a thread's MCP children
(`codex-app-server-pool.md`). Only a change confined to the thread-configuration fingerprint
could in principle reuse the process, and only after the session abstraction supports several
threads; until then, any fingerprint change means a new process.

**Gate that blocks on failure (root thread).** Between `thread/start` and `turn/start`, call
`mcpServerStatus/list({ threadId, detail: 'toolsAndAuthOnly' })`.

- It lists config, plugin and app servers, with `pluginId`, and reports disabled ones as
  `disabled`.
- If any enabled server is outside the resolved policy, the step stops before role work with a
  named error.
- Fill `agent_init.mcp_servers` from this call.

Startup notifications cannot serve as the gate: nothing marks when startup is complete, and
`cloudflare-api` arrives late.

**Children: inherited configuration plus an audit, not a gate.**
- The host controls the gap between `thread/start` and `turn/start` only for the root thread
  (`codexSdkManager.ts:995`, `:1062`). Codex creates collaboration children internally, and the
  host first hears of one after it has started work. So no child can be gated before its first
  request.
- A child's structural protection is the configuration it inherits from the parent thread. The
  Increment 0 child-inheritance probe must confirm it inherits the overrides above.
- On top of that, when a child is registered (§5.2), the host runs `mcpServerStatus/list` for
  the child's `threadId` as an audit. An unexpected server interrupts the lane's turn and fails
  the step with a named error. Any work the child already did is discarded along with the step.
- If the probe shows children do *not* inherit the overrides, the audit is the only child
  control. §7.8 and §13 then state child coverage as "detected and failed", not "prevented".

`collaboration.spawn_agent` cannot be removed from the tool list on 0.153.3. Setting the
collaboration feature flags to false did not remove it in the global-assistant probe. So
`allowCollaboration: false` is a prompt instruction backed by Increment 4's zero-child metric,
not enforcement.

The capability policy is part of the thread configuration, so include it in the existing
warm-session fingerprint.

### 7.4 Limits on Cyboflow MCP methods per step

Revision 1 assumed Cyboflow MCP methods were already limited per step type. They are not: the
router's only scopes are run, global-agent and design.

Add a router-side allowlist keyed on (run, step, lane). It limits each step to the Cyboflow MCP
methods its contract needs. For example, review and verification steps get the read methods plus
`report_finding`, but not `update_task`.

- **Pattern to follow.** The existing server-side check in `verifyToolHandlers.ts`, which rejects
  `request_verification` on programmatic runs. It already works for both providers because it
  does not rely on per-spawn `disallowedTools`.
- **Step identity.** It reaches the router from the spawn's MCP server configuration. If pooling
  is ever revived, it must move to a token sent with each call.
- **Where the code goes.** New handler code goes in `orchestrator/mcpServer/handlers/`, which is
  where the tool families now live. `mcpQueryHandler.ts` is only the dispatcher (1,151 lines on
  local main, at its size cap).

This must be in place before Increment 4 is enabled on any review or verification step.

### 7.5 Rollout

- The mode (`warn` or `enforce`) is a ConfigManager setting, not an env flag.
- The emergency switch is `CYBOFLOW_CODEX_CAPABILITY_GATE=audit`, not a full disable. In
  `enforce` mode it keeps every source-level setting from §7.3 and turns only the blocking gate
  into a logged audit.
- Every run under `warn` or under the switch logs a startup diagnostic and writes a raw event
  that names the mode. Rolling back to `warn` is the full fail-open path, and it is visibly
  marked on every affected run.
- **Warn phase:**
  - Change nothing.
  - Search `raw_events` for the MCP tools *and built-in tools* (web search, computer use) that
    workflow threads actually called.
  - Report what enforcement would have removed.
  - Turn legitimate uses into explicit grants.
- **Enforce phase:**
  - An unknown MCP name, or a required capability that is unavailable, fails the step before
    role work with a named error.
  - A capability marked optional may be left out, with a warning.
  - `cyboflow` in a deny list is ignored.

### 7.6 Split out: session MCP/plugin parity

Revision 1 folded "`CodexSdkManager` ignores the session's MCP and plugin toggles" into this
increment. The fix is not a simple read of those columns:

- they hold Claude-namespace ids from `~/.claude.json` and `~/.claude/plugins`;
- the session wizard hides the toggles for Codex;
- workflows have no run-level selection at all.

Handle it as a separate small fix that also covers quick sessions. The session deny list may
only *remove* Codex servers whose ids match; it never grants one.

### 7.7 Tests

- **Config-builder unit tests, with no live Codex.** A hostile config (user servers, plugins,
  apps, remote discovery) produces exactly the expected override set. Ids that are absent from
  the effective config are never named.
- **Fake `mcpServerStatus/list`.** An unexpected enabled server from config, a profile or a
  plugin stops the root step before `turn/start`. An unexpected server on a registered child
  interrupts the lane's turn and fails the step.
- **Cold start and warm reuse.** `config/read` runs before the thread configuration is built. A
  changed `config/read` digest on warm reuse closes the client and starts a new process. The audit-only switch keeps
  the source-level settings, and it writes its diagnostic.
- **Explicit grant.** A validated role MCP server is present while the other servers are
  disabled.
- **Router.** A review step that calls a write method outside its scope is rejected, for both
  providers.
- **Checked-in probe output.** A saved output from a live 0.153.3 probe that runs no model.

### 7.8 Acceptance

- By default, programmatic Codex root threads start only `cyboflow` plus explicit grants, with
  no `cloudflare-api`, `codex_apps` or `cua_repl`.
- Child threads get the same surface through inherited configuration. If the probe shows they
  don't inherit it, an unexpected child server is detected and the step fails (§7.3).
- `agent_init` reports the servers that actually started.
- Context size decreases, and neither startup latency nor MCP startup failures get worse.

## 8. Increment 4 — direct programmatic steps

### 8.1 Current topology

`SpawnStepRunner` creates one top-level turn per programmatic step. Its composed prompt says
"Delegate to the `cyboflow-${step.agent}` role … You are the single writer; subagents are
edit-only."

- Claude resolves the `.claude/agents` Task subagent.
- The Codex envelope maps the role onto the built-in `worker` or `explorer`.

The providers differ in ways that matter:

| | Claude | Codex |
| --- | --- | --- |
| What the child sees | only the Task brief | a fork of the full history (`fork_turns: 'all'`), including the whole step prompt |
| Role prompt | the child gets the role `.md` | nobody gets it (until 2c) |
| Child writes Cyboflow state | never (0 calls) | yes (504 calls) |
| Child model and effort | the outer may override them (fixed by 2a) | the outer chooses them |
| Most that could be removed (programmatic runs) | 51.1% of input, 45.3% of output | 51.0% of input, 37.6% of output |

How much could be removed varies by step. For example, the dependency-analyzer outer used about
10x its child's input, mostly on 111 persistence calls that a direct worker would still have to
make.

### 8.2 Decision

A step runs direct only when all three hold:

- it is programmatic and its resolved runtime is `claude-sdk` or `codex-sdk`;
- its frozen spec marks it direct;
- it is on the host eligibility list.

A direct step's top-level turn does the role work itself.

These keep their current behavior:
- OMP keeps its own adapter.
- pi already does role work directly.
- Orchestrated runs, including their Codex lanes, keep delegating. The orchestrated plane
  ignores `stepDispatch` (§8.3).

**Codex goes first, for three reasons:**
- direct mode takes Codex from two writers to one;
- it removes the effort-override skew;
- it needs no SDK probe.

Claude follows once the Increment 0 SDK probe is done and its baseline is rebuilt.

### 8.3 Selection and keying

**Steps are addressed by their full path.** Step ids are unique only within a phase
(`workflowDefinitionSchema.ts:210`), and fan-out inner steps have a namespace of their own
(`:222`). So a bare step id is ambiguous in a valid definition. Every key in this section is a
**step address**:
- `<phaseId>/<stepId>` for an ordinary step;
- `<phaseId>/<stepId>/<innerStepId>` for a fan-out lane step, such as
  `<executePhase>/execute-tasks/implement`.

A shared helper builds and parses addresses, and validation rejects an address that does not
resolve to exactly one step.

**The address must be carried at runtime; today it is lost.** A fan-out lane's inner step is
turned into a synthesized `WorkflowStep` holding only the inner step's id
(`workflowController.ts:2185-2194`). `ControllerStepContext` has `phaseId` and the fan-out item,
but not the parent fan-out step's id (`programmatic/types.ts:116-143`). `SpawnStepRunner` passes
only `step.id` as `agentInvocationStepId` (`spawnStepRunner.ts:496-520`), and
`agent_invocations.step_id` stores that bare id. So:
- add `stepAddress` to `ControllerStepContext`, set by the controller for ordinary and
  fan-out steps alike;
- pass it through the spawn options to both managers, and into diagnostics;
- persist it in a new `agent_invocations.step_address` column (keep `step_id` for existing
  readers).
Dispatch lookup, eligibility and evaluation read the address, never `step_id`.

**What the definition requests.**
- Add a definition-level `stepDispatch?: Record<StepAddress, 'delegated' | 'direct'>` to
  `workflowDefinitionSchema`. The schema's `z.object` strips unknown keys, so the field must be
  declared.
- It is *not* an `agentConfigs` field. `agentConfigs` is keyed by agent or role
  (`workflowDefinitionSchema.ts:194`), and role keys collide (next point).

**Host eligibility is keyed `provider:workflow:<step address>`.** It is a code constant, not a
setting. Role keys would be wrong because one role backs several steps:
- Ship's `materialize-batch` uses the `implement` role for database-only work.
- `expand-spec` uses `context`.
- Launch's `interview` role backs three steps.
- `execute-tasks` is `implement`.

Exclude verify-setup `prove` and fan-out parent steps. The first entries are Sprint's
implement and write-tests lane steps on Codex. Ship's lane equivalents follow once Sprint
passes.

**What gets frozen is the resolved choice, not the request.** At launch, after the runtime mix is
applied, each requested `direct` entry is resolved. It falls back to `delegated` if either:
- the step's resolved runtime is not `claude-sdk` or `codex-sdk`; or
- the step address is not on the eligibility list at launch time.

The frozen spec records both the request and the resolved map. Restart and replay read only the
resolved map. That way a later change to the eligibility list, or a version upgrade, can never
change how a run that is already in flight executes. The resolved map is part of the frozen
spec, so the two arms of a comparison get different `spec_hash` values.

**Per-invocation record.** `agent_invocations` today stores only step, provider, runtime, model
and panel identity (`agentInvocationStore.ts:15`, `:60`). Add nullable columns, and have
the store write them and read them back:
- `step_address` (above);
- `dispatch_mode`;
- `service_tier`;
- `effort`.

This needs a schema migration (next free number after Increment 1's) and a `schema.sql`
update. §10 depends on these columns.

**Claude has no invocation rows today.** Only the Codex and OMP managers call
`AgentInvocationStore.createInvocation` (`codexSdkManager.ts:1028`, `ompSdkManager.ts:1050`).
The Claude path receives `agentInvocationStepId` (`runExecutor.ts:233-245`) but never writes a
row, so new columns alone give Claude evaluation nothing. Add a Claude invocation lifecycle, in a
new file extracted next to `claudeCodeManager.ts` (which is at its size cap):
- create the row before the query starts, with the step address, dispatch mode, effective model,
  effort, service tier (Claude pins fast mode off, so `standard`), the SDK `session_id` once
  known, and the `process_instance_id` from §5.2;
- close it on result, error or cancellation, with the outcome.

**Handover.** After a run is handed over, the orchestrated plane ignores the resolved
`stepDispatch` map and goes back to the Task arrangement. Invocations that already ran keep their
recorded `dispatch_mode`.
Evaluation excludes handed-over runs.

**Kill switch.** `CYBOFLOW_DISABLE_DIRECT_STEPS=1` forces `delegated` everywhere.

### 8.4 Prompt composition

`composeStepPrompt` gains `stepDispatch: 'delegated' | 'direct'`. It is named that way to avoid
confusion with the existing `ExecutionModel`.

- Delegated output stays byte-identical to today.
- Direct output must reword every contract that talks about a subagent, not just the opening
  instruction. In `stepPrompt.ts` these include:
  - the artifact contracts (around lines 361–388);
  - idea persistence (410);
  - build breaks (598);
  - sprint task scope (791);
  - final-message contracts (872, 895);
  - address-review's two-pass delegation (907);
  - Compound review-queue rules (944).
- Add a `programmatic-step-direct` Codex envelope. The existing envelope already has a fallback
  clause for doing the work directly, which can be the starting point.

**System instructions for the direct turn.** These go in Claude's `systemPrompt.append` or
Codex's `developerInstructions`, in this order:

1. The resolved effective agent's `systemPrompt`, including project, workflow and variant
   overrides.
2. A **direct-step addendum** written by the host. It says:
   - do the role's work directly and do not spawn an agent for it;
   - keep the role's file scope, test scope and result schema;
   - then perform only the state writes and commit/report actions the step prompt lists; the
     role's "never writes Cyboflow state" rule still forbids anything else;
   - stop after this one step.

**A second option for Claude.** Claude could instead use `Options.agent = 'cyboflow-<key>'`.
`settingSources` already includes `project`, so the installed agent file is found and would run
exactly what today's child runs, which makes for the closest comparison. It would still need
`mcp__cyboflow__*` added and a rule for which model setting wins. The Increment 0 SDK probe
chooses between the two options.

**Expected change in Claude behavior.** A direct Claude worker sees the full step prompt for
the first time. That includes design surfaces, thoroughness budgets and loopback text that the
Task child never saw. On Codex nothing changes here, because the child already sees the full
prompt.

If the role material is missing, the step fails. It never falls back to a generic, unscoped
agent.

### 8.5 Tools, sandbox and state ownership

**Claude.**
- Pass the role's tool list as the SDK `tools` option.
  - The manager's own `ClaudeSpawnOptions` already has `tools` (`claudeCodeManager.ts:849`) and
    forwards it at `:3203`.
  - The orchestrator-facing `ClaudeSpawnerOptions` (`runExecutor.ts`), which `SpawnStepRunner`
    uses, does not. Add `tools` there, and carry it through every facade and adapter between
    the two.
  - Non-Claude runtimes ignore it deliberately, and a test pins that.
- Add the step's `mcp__cyboflow__*` tools, because role `tools:` lists omit them.
- Exclude `Task` and `Agent`.
- Never use `allowedTools`, which only pre-approves tools and does not restrict them. Without
  the `tools` option, a direct code-review turn would gain Edit and Write.

**Codex.** Set the sandbox per role based on what each role actually does, not on its name.

| Role | Sandbox | Why |
| --- | --- | --- |
| implement, write-tests | workspace-write | They edit files |
| task-verify, sprint-verify, visual-verify | workspace-write | They run tests |
| Reviewers | workspace-write, unless warn-phase data shows read-only is enough | They also run Bash (25 of 46 role files list it) |

"Verifiers don't commit" is enforced only by the prompt plus a commit check after the step. It
is not structural, and should not be described that way.

**State writes.** These are limited by Increment 3's per-step router limits. Direct mode is not
turned on for any review or verification step until those limits are enforced.

### 8.6 Replacing the dispatcher's corrections

In the window, dispatchers sent 29 corrective follow-up turns to their children (§4.1). A
direct worker has no dispatcher, so the controller must do this job. "Charge the loopback to the
step" covers only the accounting. It does not make the corrections happen.

`SpawnStepRunner` today makes one spawn and waits for one terminal outcome
(`spawnStepRunner.ts:496`, `:521`). Direct mode is not enabled for a step until each
intervention below has a controller-side trigger, action, limit and test.

**Timebox.**
- **Trigger:** the step's wall-clock time exceeds its budget. The budget is set per step
  address, defaulting to 1.5x arm A's p95 for that step.
- **Action:** interrupt the turn, then resume the same thread with one "stop, finish, and emit
  your result contract now" turn. A single-shot lane has already stopped its client, so this
  resumes the thread on a new client.
- **Limit:** one follow-up. After that the step fails with a timeout class.

**Incomplete output.**
- **Trigger:** the result contract is missing or cannot be parsed.
- **Action:** the existing output-contract retry. Today it exists for task-verify ("fails this
  lane after one retry"); extend it to every direct-eligible step.
- **Limit:** one retry.

**Edits outside the task's scope.** Lanes share one worktree, and nothing today records which
lane owns which path. Tasks carry file hints, not a strict list, so they cannot decide
ownership. A revert based on a guess could undo a sibling's legitimate work or the user's own
uncommitted changes. So this correction is split:
- **Protected paths** (the runbook, `.cyboflow/`, and any path the workflow declares protected):
  - **Trigger:** after the step, the lane's diff touches one.
  - **Action:** a loopback that lists the paths and asks for the edit to be reverted.
  - **Limit:** one loopback, then the step fails.
- **Possible sibling conflicts** (a path another lane in the batch also changed, or one outside
  the task's file hints):
  - **Action:** report a finding naming the lane, the paths and the other lane. Never revert
    automatically.
- **Automatic sibling reverts need a path-claim protocol first**, which is out of scope here.
  It would define how a lane acquires claims, what happens on a conflicting claim, when claims
  are released, and how files already dirty at lane start are excluded. It is listed as an open
  decision in §12.

**Branch drift.**
- **Trigger:** after the step, the lane is not on its expected branch or base, or the worktree
  is still dirty after the step's required commit.
- **Action:** a loopback that asks the worker to re-sync or commit.
- **Limit:** one loopback, then the step fails.

Beyond the task-verify retry, none of these is confirmed to exist in the controller today. Treat
each as new work unless the implementation finds it already there.

Arm A's data sizes the need. Classify how often each intervention would have fired on arm A's
delegated runs, and require direct mode to fire no more often than that within the predeclared
tolerance.

### 8.7 Evaluation design

**Compare variants side by side, not with a toggle.**
- **Arm A:** a delegated-fixed variant (Increment 2 in place) with explicit per-agent runtime
  pins. The pins are needed because variants reject a runtime-mix override
  (`workflowRegistry.ts`).
- **Arm B:** the same variant plus `stepDispatch`.

An env toggle would leave `spec_hash`, variant and level identical in both arms, which would
mix them together in the `workflowTuningEstimates` medians.

**Match models.** Both arms run each role at the same model and effort. Record the service tier
as a dimension, and use only runs from 2026-09-24 onward.

**Run on the programmatic plane, to completion.** Arm A runs first, to produce the outcome
baseline that §1.4 says is missing.

**Count child agents.**
- Codex: combine three signals, because the Sol path emits no `spawnAgent` items (81 spawns in
  the window):
  - `spawnAgent.receiverThreadIds`;
  - `subAgentActivity(kind=started).agentThreadId`;
  - `rawResponseItem` function calls named `spawn_agent`, `followup_task` or `send_message`.
- Claude: count Task/Agent `tool_use` calls.
- No exemption based on who asked for the child: the Sol spawn message is encrypted, so the
  origin cannot be established.

**Attribute cost to the originating step.** Usage from controller loopbacks and full-step
retries counts against the step that caused them. The eval jury's cost is not in `run_usage`;
budget for it separately.

**Findings.** Codex children filed 124 findings in the window. If the outer and the child both
filed, direct mode will produce *fewer* findings with no change in quality. Deduplicate the
findings metric, or split it by dispatch mode.

**Trials.** Run at least five matched fixture trials per provider and step, plus one opt-in
production Sprint. Decide the tolerances in advance for completion, verification, loopbacks,
retries and result parsing.

### 8.8 Tests

- **Prompts.**
  - Direct prompts contain the effective role body, the addendum, the task scope and exactly one
    result contract.
  - They contain no "subagent", "delegate" or "relay" wording.
  - Delegated prompts and launch config are byte-identical to today (golden snapshots).
- **Overrides.** Project prompt replacement, workflow addendum, variant delta, provider model
  and effort all reach the direct turn.
- **Keying.**
  - Eligibility for Sprint's implement lane step never makes Ship's `materialize-batch`
    direct.
  - A bare or ambiguous step id is rejected; only full step addresses resolve.
  - Restart after an eligibility-list change replays the frozen resolved map.
  - `agent_invocations` rows carry `step_address`, `dispatch_mode`, `service_tier` and
    `effort`, for Claude as well as Codex.
  - A fan-out lane step's invocation records `<phaseId>/<fanOutStepId>/<innerStepId>`, and two
    phases with the same step id get distinct addresses.
  - Ineligible or wrong-runtime entries fall back to delegated and are recorded in the stamp.
- **No leakage.**
  - Direct mode never reaches OMP, pi or orchestrated turns; check every place `stepDispatch` is
    read.
  - Enabling one provider does not enable the other.
- **Tools.**
  - A direct Claude code-review turn has no Edit, Write or Task.
  - A direct Codex review turn cannot call Cyboflow methods outside its limits.
- **Integration, with the fake app-server and fake SDK.**
  - implement edits files and reports state in one thread.
  - Code-review findings and blocking verdicts still trigger the loopback.
  - Canceling interrupts the turn, and no MCP write arrives afterwards.
- **Handover.** A run handed over after a direct step keeps an accurate per-invocation stamp.
- **Corrections (§8.6).** Test each intervention: timebox expiry with its one follow-up;
  incomplete output with its one retry; an edit to a protected path causing a revert loopback;
  a possible sibling conflict producing a finding and no revert; branch drift causing a re-sync
  loopback. Each fails the step when its limit is
  exhausted.
- **Compaction.**
  - The persistence and result contracts survive Claude auto-compaction, or are re-injected.
  - Measure how often direct Claude workers compact: they now carry the full step prompt plus
    the role body for the whole turn.
- **Warm-session reuse.** Check whether per-role `tools` or prompt changes stop Claude from
  reusing a warm session between sequential programmatic steps. If they do, count the extra
  cold starts in evaluation.

### 8.9 Acceptance

- Each eligible step runs one top-level thread or query, with zero host-requested children by
  the §8.7 count.
- Acceptance criteria, commits, artifacts, findings (after deduplication) and controller
  verdicts match arm A within the tolerances set in advance.
- Before arm B runs, set a minimum saving per provider. Base it on how much the validated
  baseline shows could be removed, and on how much arm A varies between runs.
- Across five matched fixtures, the per-model totals must beat that minimum. No token type that
  §10 guards for that provider may rise per step.
- Codex cache-hit rate is no more than 1.0 point below arm A.

## 9. Delivery sequence

| Order | Increment | Why at this point | How to roll back |
| --- | --- | --- | --- |
| — | Service-tier pin (§4.3) | Already landed. The cheapest saving, and it removes a skew | Revert |
| 0 | Reproductions, fake app-server, Claude SDK and Codex child-inheritance probes, re-probe on the next Codex version | Every later increment needs the fake; 2c, Increment 3's child coverage and Claude direct mode need the probes | Nothing to roll back; no behavior changes |
| 1 | Complete usage accounting | Nothing can be measured without it | Revert. The migration only touches data and can be re-run |
| 2 | Fixes to the delegated path | Each saves usage on its own, and together they define arm A | Revert each sub-item separately |
| 3 | Codex capability surface and per-step router limits | Least privilege must exist before parent and child are merged into one agent | Switch ConfigManager to `warn`, or use the kill switch |
| 4 | Direct steps: Codex, then Claude | The largest opportunity, measured against arm A | Remove `stepDispatch` from the variant, or use the kill switch |

Increments 1 and 2 can land in parallel. Increment 4's evaluation must not start until 1 and 2
are in and arm A has completed its baseline.

## 10. Observability and evaluation

**Compute evaluation metrics with SQL.** Derive them from `raw_events` and the run and
invocation stamps, not from in-process counters. `perfBump` does nothing unless
`CYBOFLOW_PERF_TRACE=1`, so counters would be empty in real Sprints. Check the queries in under
`docs/probes/`.

**Add these diagnostics** as raw events or log lines:
- `duplicate_token_snapshots`;
- `descendant_input` and `descendant_output`;
- `response_usage_missing`;
- `oracle_mismatch`;
- `descendant_usage_unattributed` (its tokens are counted through the `codex-unattributed:` row);
- `model_inferred` on Codex child rows;
- `claude_child_delta_negative`, `claude_model_usage_missing` and `claude_outer_mismatch`;
- capability-gate aborts and child-audit failures;
- the capability mode (`warn` / `enforce` / audit switch) on every affected run.

Per-invocation `step_address`, `dispatch_mode`, `service_tier`, model and effort come from the
new `agent_invocations` columns (§8.3), for both providers, not from diagnostics. Per-invocation
comparisons use only runs whose `run_usage.coverage` is `complete`.

**Compare**, per provider, per model and per step:
- task outcomes;
- loopbacks and findings (deduplicated);
- uncached, cache-read, cache-creation and output tokens;
- the number of child agents;
- MCP and plugin startups and failures.

Weekly meter changes are rough supporting evidence only.

**Guardrails differ by provider:**

| Provider | Token types guarded | Cache-hit guardrail |
| --- | --- | --- |
| Codex | uncached input and output (cache-write is always 0) | no more than 1.0 point below the matched baseline, about 95.5% today |
| Claude | cache-creation and output (uncached is about 0) | no clear drop from 91–93% |

Never add different models together into one headline figure. Use published allowance weights
where they exist; otherwise report each model separately.

## 11. Code touchpoints

Indicative, not exhaustive:

- **Increment 1**
  - `codex/appServer/usageAccumulator.ts`
  - `codex/codexSdkManager.ts`
  - `codex/appServer/turnSession.ts`
  - `codex/appServer/rawNotificationSink.ts`
  - `orchestrator/insightsQueries.ts`, plus a new shared-rollup file next to it
  - `orchestrator/runRecovery.ts` (the one-shot backfill) and `orchestrator/runUsageRollup.ts`
  - a schema migration adding `run_usage.accounting_version` and `coverage` and
    `agent_invocations.codex_turn_id`, plus `schema.sql`
  - the Claude ingestion path, to stamp `process_instance_id` on stored events
  - `test/fakes/fakeCodexAppServer.ts`
- **Increment 2**
  - the PreToolUse Agent-dispatch merge and background pin in `claude/`, extracted (see below)
  - `orchestrator/agents/agentMarkdown.ts`
  - `programmatic/spawnStepRunner.ts`
  - `codex/appServer/runConfig.ts`
- **Increment 3**
  - `codex/appServer/runConfig.ts`
  - `codex/appServer/userMcpServers.ts`
  - `codex/codexSdkManager.ts`
  - a new module for per-step router limits under `orchestrator/mcpServer/handlers/`
  - ConfigManager
- **Increment 4**
  - `orchestrator/workflowDefinitionSchema.ts` and a step-address helper
  - `orchestrator/agentInvocationStore.ts`, plus a migration adding `step_address`,
    `dispatch_mode`, `service_tier` and `effort`
  - `programmatic/types.ts` and `programmatic/workflowController.ts` (`stepAddress` on the step
    context)
  - a new Claude invocation-lifecycle file next to `claudeCodeManager.ts`
  - the controller's step-correction interventions (§8.6)
  - `programmatic/stepPrompt.ts`
  - `programmatic/spawnStepRunner.ts`
  - the Codex runtime envelope
  - a new `resolveStepRole` module
  - `orchestrator/runExecutor.ts` (`ClaudeSpawnerOptions.tools`)

**Where new code lives.** Three files are at or near their size caps. Re-check them on rebase:

| File | Lines / cap |
| --- | --- |
| `claudeCodeManager.ts` | 4,818 / 4,818 (at cap) |
| `mcpQueryHandler.ts` | 4,495 / 4,495 here; 1,151 / 1,151 on local main after the #19 split (at cap either way) |
| `index.ts` | 6,180 / 6,220 (40 lines free); #19's next target |

So:
- Claude option wiring and the dispatch-pin changes go in a new file extracted next to
  `claudeCodeManager.ts`.
- Router limits go in `handlers/`.
- `resolveStepRole` is a new module. `resolveStepAgent` stays byte-identical, because callers
  rely on it returning `undefined` for unpinned agents.
- Fix the outdated comment near `resolveStepAgent` in `index.ts` that claims frontmatter never
  applies on this plane.

Read `main/src/services/panels/AGENTS.md` before editing under `panels/`.

## 12. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| `rawResponse/completed` is internal-only and could change | Protocol-shape test; the `total` fallback; the drift diagnostic |
| The backfill mislabels old runs | Explicit coverage values (run-level, model-inferred, segments-inferred, root-only, legacy), plus an accounting version that selects the fold |
| A partial backfill leaves stale or missing rollups | One transaction per run, a per-run progress table, and a completion marker written only after every run succeeds (§5.2 1d) |
| Draining keeps single-shot Codex processes alive up to 30s longer | The lane's outcome is not delayed; the drain ends early once every descendant is terminal. Watch peak process count in the first Sprints |
| Historical Claude segments are inferred | Marked `claude-segments-inferred`; new runs use `process_instance_id` |
| A direct worker writes state before its file work is valid | The addendum keeps the step's order; controller gates and result contracts stay authoritative |
| The role's "subagent / no state writes" wording conflicts with direct ownership | The addendum overrides only the listed persistence duties |
| A direct worker loses the dispatcher's corrective follow-ups (timeboxes, scope reverts) | Controller interventions with defined triggers and limits (§8.6), gated on arm A's rates; their usage is charged to the step |
| A late or unregistered Codex descendant escapes accounting | A drain before client stop; anything unregistered or late goes to a counted `codex-unattributed:` row (§5.2) |
| The fail-open paths (`warn` mode, the audit switch) are left on | Every affected run carries a startup diagnostic and a raw event naming the mode (§7.5) |
| Direct Claude review turns at the pinned model cost more than today's downgraded children | Arm A also runs at the pins (2a), so the comparison is fair. Accept the cost, or change the pin deliberately |
| A workflow relied on inherited plugins, apps or web search | Warn phase that also mines built-in tool use; named failures in enforce mode |
| `spawn_agent` cannot be removed from the tool list | The child-agent count; a loopback when one is spawned |
| Reviewers need Bash, so they can change files | workspace-write only where the data shows it is needed; a commit check after the step; described as policy, not enforcement |

Not yet examined, and relevant to evaluation:

1. **`auto_review` approvals.** Codex task-verify threads run with
   `approvalsReviewer: auto_review`. Two things are unknown:
   - whether its model calls appear in `rawResponse/completed` or use allowance invisibly;
   - whether direct mode changes how many approvals there are.
2. **Why all 7 Sprints were canceled.** If usage was the reason, that argues for urgency. If
   defects were, the outcome baseline is compromised.
3. **Whether outer requests are mostly waiting and polling.** If they are, telling the outer to
   block on `wait` with a long timeout is a cheap fix for delegated mode. This can be checked
   offline by comparing, per outer turn, the number of `rawResponse` events with the number of
   `wait`, `sendInput` and MCP items.
4. **Whether Claude children inherit the session's effort.** Check child `system/init` rows
   offline if they record it; otherwise arm A will answer it.
5. **Whether Claude fan-out lanes are single-shot and fresh,** as revision 1 claimed. This was
   checked for Codex only.

Open decisions:

1. The web-search default for implement and write-tests (§7.2).
2. The Claude direct mechanism: `systemPrompt.append` plus `tools`, or `Options.agent`. The probe
   decides (§8.4).
3. When to extend eligibility beyond Sprint implement and write-tests, and in what order.
4. How long the kill switches and the ConfigManager mode stay after validation.
5. Whether to design a lane path-claim protocol, which automatic sibling reverts in §8.6 would
   need.

## 13. Definition of done

- **Accurate usage.** Codex and Claude usage matches the independent check values in each of:
  - `agent_result`;
  - `subagent_usage`;
  - `run_usage`;
  - the daily buckets.

  The check values are:
  - Codex: the sum of `rawResponse/completed.usage`;
  - Claude: outer `result.usage` plus the non-negative per-segment child deltas
    (Δ`modelUsage` − `result.usage`), exactly as in §5.2 1b. Deduplicated parentless messages
    are a cross-check and supply the outer's per-model split, never tokens.

  Descendant threads, unattributed and top-up rows, and mixed runs are included. Every
  `run_usage` row carries an accounting version and a coverage value, and the audit window has
  been backfilled.
- **Tiers, models and effort.** Workflow Codex threads run on the standard tier. Claude children
  run on their pinned model and effort.
- **Capabilities.** By default, programmatic Codex root threads start only `cyboflow` plus
  explicit grants, as checked by the gate. Children are covered by inherited configuration and
  the audit, as far as the probe shows they can be (§7.3). Review and verification steps are
  held to their per-step router limits.
- **Direct steps.** Eligible direct steps run one agent per step, with zero host-requested
  children. Outcomes do not regress beyond the tolerances set in advance. Savings beat each
  provider's minimum on trials that are model-matched, completed and not handed over.
