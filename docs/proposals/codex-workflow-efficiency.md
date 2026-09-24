# SDK workflow efficiency — complete usage accounting, scoped Codex tools, direct programmatic steps

Status: PROPOSED, revision 2 (2026-09-24). This revision replaces revision 1, which was drafted
on `solar-juniper` the same day. Revision 1 was checked against three sources: the production
database (read-only), the local Codex rollout files under `~/.codex/sessions`, and the code.
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
| Direct steps enabled by an env allowlist keyed `provider:role` | Frozen-spec `stepDispatch` keyed by step id; host eligibility keyed `provider:workflow:stepId` | Role keys collide, and env toggles contaminate A/B comparisons |
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
| Input, including cache reads | 816.9M |
| Cached input | 780.7M |
| Uncached input | 36.3M |
| Cache-write input | 0 |
| Output | 3.39M |
| Cache-hit rate | 95.56% |
| Service tier | `priority` on 130/130 recorded thread-settings rows |

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

The outer share is 51.1% of input and 45.3% of output.

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
   effective agent is available. Otherwise the launch fails with a named reason.
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

Direct mode must reproduce the timebox and scope interventions through controller loopbacks.

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
- **Codex role-prompt probe.** This blocks Increment 2c. It checks whether a forked
  `spawn_agent` child inherits the parent thread's `developerInstructions`.
- **Outcome baseline for the delegated path.** This blocks evaluation of Increment 4. Run the
  Increment 2 arm to completion on the programmatic plane (§8.6). It costs real Sprints, so
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

Add `observeResponse(threadId, responseId, usage)` to `CodexTurnUsageAccumulator`:

- Calling it twice with the same `responseId` changes nothing.
- It keeps a breakdown per thread.
- `CodexSdkManager`'s notification handler calls it *before* `TurnSession` filters the
  notification, so the root thread's descendants are counted.

A thread belongs to the lane that spawned it, as shown by `spawnAgent.receiverThreadIds` or
`subAgentActivity(kind=started).agentThreadId`. A descendant's usage is attributed to the
lane's current turn.

`thread/tokenUsage/updated` stays as a fallback. It is used for a thread only when no
`rawResponse/completed` arrives for that thread:

- Add up changes in `total`, not `last`.
- Skip repeats whose `total` has not changed.
- If `total` goes down, treat it as a process restart: take the new value as the starting point
  instead of subtracting.

Two guards protect the primary source:

- **Drift diagnostic.** Log loudly when a turn has `tokenUsage` snapshots but no
  `rawResponse/completed`; that means the protocol has changed.
- **Protocol-shape test.** `rawResponse/completed` is typed as internal-only, and its `usage` is
  `TokenUsageBreakdown | null`. Pin the method name, field names and nullability against the
  generated types, so a Codex upgrade that changes them fails CI instead of silently zeroing
  usage.

Also confirm whether delivery depends on `experimentalApi: true`. The fallback covers either
answer.

Output shape:

- The root thread's usage stays on `agent_result`, as today.
- Descendant usage is emitted as the existing `subagent_usage` event type. Both Insights paths
  already add it unconditionally (`insightsQueries.ts:141`, `:686`).

No new event type and no new rollup are needed.

**1b — Roll up per provider.**

Replace the per-run `assistantMessageCount === 0` condition with a rollup per provider:

| Usage | Source |
| --- | --- |
| Claude | deduplicated assistant messages |
| Codex root | `agent_result` |
| Descendants | `subagent_usage` |

Put this in one shared function that both `scanRawEventRollups` and `selectDailyModelUsage`
call, so they cannot drift apart again. `insightsQueries.ts` is 3,122 lines and has no size cap
yet, but the shared function still belongs in a separate file next to it.

**1c — Deduplicate Claude usage.**

Count assistant usage once per (session, `message.id`).
- **Outer usage:** from `result.usage` where present.
- **Child usage:** from the differences between successive `modelUsage` readings. These are
  already tracked per (run, session) for cost.

Apply this to both Insights paths.

**1d — Recompute past runs.**

A data-only migration recomputes `run_usage` for runs with Codex or Claude rows. It takes the
next free number (145 when this was written) and follows migration 132
(`132_run_usage_recompute.sql`).

| Run | What the migration does |
| --- | --- |
| Codex run whose raw events predate 2026-09-14T19:51Z (no `rawResponse/completed`) | Recompute from the root-thread fallback and mark it root-only |
| Run whose raw events have been archived out of `raw_events` (see `docs/BACKUP-RESTORE.md`) | Keep the stored value and mark it not recomputed |

Stamp new usage with a `usage_accounting_version` so Insights can tell the old accounting from
the new. Do not rely on timestamps for this.

**1e — Fix the comment.**

Correct `rawNotificationSink.ts:25`. Add a sink test that `rawResponse/completed` is never
deduplicated.

There is no accounting-mode flag. 1a has an exact, independent check value, and rolling back is
a revert.

### 5.3 Tests

**Accumulator:**
- one response;
- several responses add up;
- a repeated `responseId` adds 0;
- null `usage` falls back to the change in `total`;
- a duplicate `tokenUsage/updated` with unchanged `total` and non-zero `last` adds 0;
- a change in `total` that spans two requests;
- a `total` reset (process resume) takes the new starting point;
- compaction requests are counted;
- uncached input is never negative.

**Manager, using the fake app-server:**
- A lane whose root thread spawns two children emits one root `agent_result` and one
  `subagent_usage` per child.
- Their sum equals the lane's total from `rawResponse/completed.usage`.

**Protocol shape:**
- `rawResponse/completed` is pinned against the generated 0.153.3 types.

**Rollups:**
- In a mixed claude-primary fixture, `run_usage` equals deduplicated Claude plus Codex root plus
  Codex children, and also equals the sum of the daily buckets.
- In a Claude run with multi-block assistant messages, each message is counted once.

**Migration:**
- Running it twice gives the same result.
- Runs before the boundary are marked root-only.
- Archived runs are untouched.

### 5.4 Acceptance

- For new Codex runs, stored input and output per lane (root plus descendants) equals the sum of
  `rawResponse/completed.usage` exactly.
- For the audit window, the recompute reproduces two figures within 0.5%:
  - Codex: §1.2's 816.9M input and 3.39M output, minus the one quick-chat root;
  - Claude: §1.3's deduplicated totals.
- Mixed runs show both providers in `run_usage` and in the daily model buckets.

## 6. Increment 2 — fixes to the delegated path

These are cheap changes to today's delegated path that need no new architecture. Each one saves
usage or fixes a defect on its own. Together they make the delegated path a fair comparison
point for Increment 4, called the "delegated-fixed" arm.

**2a — The Claude child uses its pinned model and effort.**

- **Strip the model override.** Use the existing PreToolUse `updatedInput` merge for Agent
  dispatches, the same one that applies the `run_in_background` pin (`claudeCodeManager.ts:388`).
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

- **If** the Increment 0 probe shows forked children inherit the parent's
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
| config.toml servers | Disable by name, but only ids the *effective* configuration defines. List them with `config/read { cwd, includeLayers: true }` so project config and profiles are included; the current header scan reads only `$CODEX_HOME/config.toml` |
| Plugins | `features.plugins = false` |
| Apps | `features.apps = false` plus `apps._default.enabled = false` |
| Remote plugin discovery | `features.remote_plugin = false` |
| Image generation, goals | Their feature switches, as in the isolated configuration |

A probe on 0.153.3 that ran no model verified these settings.

**Gate that blocks on failure.** Between `thread/start` and `turn/start`, call
`mcpServerStatus/list({ threadId, detail: 'toolsAndAuthOnly' })`.

- It lists config, plugin and app servers, with `pluginId`, and reports disabled ones as
  `disabled`.
- If any enabled server is outside the resolved policy, the step stops before role work with a
  named error.
- Collaboration children have their own threads, so each child must pass the same check with its
  own `threadId`.
- Fill `agent_init.mcp_servers` from this call.

Startup notifications cannot serve as the gate: nothing marks when startup is complete, and
`cloudflare-api` arrives late.

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
- **Where the code goes.** New handler code goes in `orchestrator/mcpServer/handlers/`, not
  `mcpQueryHandler.ts`, which is at its size cap.

This must be in place before Increment 4 is enabled on any review or verification step.

### 7.5 Rollout

- The mode (`warn` or `enforce`) is a ConfigManager setting, not an env flag.
  `CYBOFLOW_DISABLE_CODEX_CAPABILITY_POLICY=1` turns the policy off entirely.
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
  plugin stops the step before `turn/start`. A child thread is checked separately.
- **Explicit grant.** A validated role MCP server is present while the other servers are
  disabled.
- **Router.** A review step that calls a write method outside its scope is rejected, for both
  providers.
- **Checked-in probe output.** A saved output from a live 0.153.3 probe that runs no model.

### 7.8 Acceptance

- By default, programmatic Codex threads (root and child) start only `cyboflow` plus explicit
  grants, and no `cloudflare-api`, `codex_apps` or `cua_repl`.
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

**Recorded in the frozen spec, not an env var.**
- Add a definition-level `stepDispatch?: Record<stepId, 'delegated' | 'direct'>` to
  `workflowDefinitionSchema`. The schema's `z.object` strips unknown keys, so the field must be
  declared.
- It is copied into the run's frozen spec, so the two arms get different `spec_hash` values, a
  restart replays the same choice, and no migration is needed.
- It is *not* an `agentConfigs` field. `agentConfigs` is keyed by agent/role
  (`workflowDefinitionSchema.ts:194`), and role keys collide (next point).

**Host eligibility is keyed `provider:workflow:stepId`.** It is a code constant, not a setting.
Role keys would be wrong because one role backs several steps:
- Ship's `materialize-batch` uses the `implement` role for work that only touches the database.
- `expand-spec` uses `context`.
- Launch's `interview` role backs three steps.
- `execute-tasks` is `implement`.

Exclude verify-setup `prove` and fan-out parent steps.

The first entries are `codex:sprint:implement` and `codex:sprint:write-tests`. Ship's lane
equivalents follow once Sprint passes.

**How a `direct` entry resolves.** At launch, after the runtime mix is applied, a `direct` entry
falls back to `delegated` if:
- the step's resolved runtime is not `claude-sdk` or `codex-sdk`; or
- the step is not eligible.

The fallback is recorded in the run stamp, never applied silently. Each invocation row also
records its dispatch mode, so attribution survives handover.

**Handover.** After a run is handed over, the orchestrated plane ignores `stepDispatch` and
goes back to the Task arrangement. Invocations that already ran keep their recorded mode.
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
- Pass the role's tool list as the SDK `tools` option. The option is
  `ClaudeSpawnerOptions.tools`, wired at `claudeCodeManager.ts:3203`.
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

### 8.6 Evaluation design

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

### 8.7 Tests

- **Prompts.**
  - Direct prompts contain the effective role body, the addendum, the task scope and exactly one
    result contract.
  - They contain no "subagent", "delegate" or "relay" wording.
  - Delegated prompts and launch config are byte-identical to today (golden snapshots).
- **Overrides.** Project prompt replacement, workflow addendum, variant delta, provider model
  and effort all reach the direct turn.
- **Keying.**
  - `codex:sprint:implement` never makes Ship's `materialize-batch` direct.
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
- **Compaction.**
  - The persistence and result contracts survive Claude auto-compaction, or are re-injected.
  - Measure how often direct Claude workers compact: they now carry the full step prompt plus
    the role body for the whole turn.
- **Warm-session reuse.** Check whether per-role `tools` or prompt changes stop Claude from
  reusing a warm session between sequential programmatic steps. If they do, count the extra
  cold starts in evaluation.

### 8.8 Acceptance

- Each eligible step runs one top-level thread or query, with zero host-requested children by
  the §8.6 count.
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
| 0 | Reproductions, fake app-server, SDK and role-prompt probes | Every later increment needs the fake; 2c and Claude direct mode need the probes | Nothing to roll back; no behavior changes |
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
- capability-gate aborts;
- per invocation: `stepDispatch`, `serviceTier`, model and effort.

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
  - a data-only migration
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
  - `orchestrator/workflowDefinitionSchema.ts`
  - `programmatic/stepPrompt.ts`
  - `programmatic/spawnStepRunner.ts`
  - the Codex runtime envelope
  - a new `resolveStepRole` module
  - `orchestrator/runExecutor.ts` (`ClaudeSpawnerOptions.tools`)

**Where new code lives.** Three files are at or near their size caps:

| File | Lines / cap |
| --- | --- |
| `claudeCodeManager.ts` | 4,818 / 4,818 (at cap) |
| `mcpQueryHandler.ts` | 4,495 / 4,495 (at cap) |
| `index.ts` | 6,180 / 6,220 (40 lines free) |

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
| The recompute migration mislabels old runs | Explicit root-only and not-recomputed markers, plus an accounting version |
| A direct worker writes state before its file work is valid | The addendum keeps the step's order; controller gates and result contracts stay authoritative |
| The role's "subagent / no state writes" wording conflicts with direct ownership | The addendum overrides only the listed persistence duties |
| A direct worker loses the dispatcher's corrective follow-ups (timeboxes, scope reverts) | Reproduce them as controller loopbacks, and charge their usage to the step |
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

## 13. Definition of done

- **Accurate usage.** Codex and Claude usage matches the independent check values in each of:
  - `agent_result`;
  - `subagent_usage`;
  - `run_usage`;
  - the daily buckets.

  The check values are:
  - Codex: the sum of `rawResponse/completed.usage`;
  - Claude: deduplicated messages plus the differences between successive `modelUsage` readings.

  Descendant threads and mixed runs are included. Every new row carries an accounting version,
  and the audit window has been recomputed.
- **Tiers, models and effort.** Workflow Codex threads run on the standard tier. Claude children
  run on their pinned model and effort.
- **Capabilities.** By default, programmatic Codex threads start only `cyboflow` plus explicit
  grants, as checked by the gate. Review and verification steps are held to their per-step
  router limits.
- **Direct steps.** Eligible direct steps run one agent per step, with zero host-requested
  children. Outcomes do not regress beyond the tolerances set in advance. Savings beat each
  provider's minimum on trials that are model-matched, completed and not handed over.
