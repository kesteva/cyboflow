# SDK program-driven workflows (execution-model seam)

Status: **Stage 0 landed** (the execution-model seam). Stages 1–3 are designed
here but not yet implemented.

This document describes how cyboflow runs the SAME workflow two ways — an
**orchestrator-driven** model (an agent walks the DAG) and a **programmatic**
model (host code walks the DAG, an agent supervises) — and the seam that selects
between them per run.

## The reframe: one DAG, two walkers

A workflow's DAG already exists and is already shared: it is the
[`WorkflowDefinition`](../shared/types/workflows.ts) (phases → steps, each step
carrying `agent` / `human` / `retries` / `loopback`), stored in
`workflows.spec_json` and resolved per workflow by `resolveWorkflowDefinition`.
Both execution models consume the SAME definition. The only difference is **who
walks it**:

- **`orchestrated`** — an orchestrator **agent** reads and manages the DAG. It
  sequences phases/steps, delegates each to a subagent via the Agent/Task tool,
  and is itself the single writer of cyboflow state + the human seam. This is
  today's behavior for every run, and the ONLY model the **interactive (PTY)
  substrate** can run (a `claude` REPL has no in-process control channel for a
  host loop to drive). Default.
- **`programmatic`** — host **code** (a `WorkflowController`) walks the same DAG.
  It sequences phases deterministically, invokes each phase agent as a discrete
  unit, validates structured output, and performs the writes through the
  existing routers. A repurposed orchestrating agent runs **alongside** it as
  monitor + human seam + triage (it no longer sequences). **SDK substrate only.**

This maps onto the dual-substrate seam without collapsing into it: `substrate`
("how the run is hosted", sdk vs interactive PTY) and `execution_model` ("who
walks the DAG", orchestrated vs programmatic) are two orthogonal immutable
stamps, bound by one hard rule — **interactive ⇒ orchestrated**.

## Stage 0 — the execution-model seam (landed)

Mirrors the `substrate` seam (IDEA-013 / migration 013) exactly: resolve once,
stamp immutably, no UPDATE path, dormant until a consumer lands.

| Concern | Substrate (precedent) | Execution model (this seam) |
| --- | --- | --- |
| Shared type + guard | `shared/types/substrate.ts` | `shared/types/executionModel.ts` (`ExecutionModel`, `isExecutionModel`, `isExecutionModelAvailable`) |
| Single resolver | `substrateResolver.ts` | `executionModelResolver.ts` (`resolveExecutionModel`) |
| DB column | migration 013 | migration **031** (`TEXT NOT NULL DEFAULT 'orchestrated' CHECK (...)`) |
| Stamp + readback | `WorkflowRegistry.createRun` / `getRunById` | same — stamped beside substrate, projected beside it |
| Row type | `WorkflowRunRow.substrate` | `WorkflowRunRow.execution_model` |

The resolver enforces the binding rule **before** the override ladder:

```
substrate === 'interactive'  ⇒  'orchestrated'   (hard rule, outranks ALL overrides)
otherwise: requested → frontmatter → projectConfig → globalDefault → env → 'orchestrated'
```

With no override anywhere, every run resolves `'orchestrated'` (an SDK run via the
floor, an interactive run via the pin) — so behavior is byte-identical. The
column is **stamped-but-dormant**: nothing reads `execution_model` to change
dispatch yet (the programmatic consumer is Stage 1), exactly as `substrate` was
dormant between migration 013 and the interactive manager. The
`requested` / `frontmatter` / `projectConfig` rungs are reserved (not yet wired
through `createRun`/`launch`) and land with the picker in a later stage.

## Stages 1–3 — the programmatic runtime (designed, not built)

In `programmatic` mode the SDK run hosts **two control planes**:

```
                  WorkflowDefinition (shared DAG)
                            │
   ┌────────────────────────┴─────────────────────────┐
   │ EXECUTION PLANE (code, deterministic)             │
   │   WorkflowController.walk(dag)                    │
   │     ready phase → run phase agent (one-shot query,│  outputFormat = JSON schema
   │       structured output, schema-validated retry)  │
   │     apply(ChangeSet) → TaskChangeRouter/etc.      │  code is the entity writer
   │     advance edges · bounded concurrency · gates   │
   └──────┬───────────────────────────────────▲────────┘
          │ event feed + triage requests        │ triage verdicts, pause/redirect
          ▼                                      │
   ┌────────────────────────────────────────────────────┐
   │ SUPERVISORY / HUMAN PLANE (orchestrator agent)      │
   │   long-lived streaming-input query() session        │  AsyncIterable prompt;
   │   • monitors phase events                           │  interrupt()/redirect live
   │   • IS the conversational seam (answers the user)   │
   │   • triages inter-agent conflicts / ambiguous output│
   │   • escalates to the human review queue when unsure │
   └──────▲───────────────────────────────▲──────────────┘
          │ chat                            │ direct review items (findings/permissions)
        human ◄──── review queue ◄──────── phase subagents (scoped ReviewItemRouter)
```

Key facts the design relies on (verified against `@anthropic-ai/claude-agent-sdk`
`0.2.141`, the version pinned in `pnpm-lock.yaml`):

- **Streaming input** — `query({ prompt })` accepts `string | AsyncIterable<SDKUserMessage>`.
  The monitor agent uses the `AsyncIterable` form (the one place it is needed);
  phase agents stay one-shot `string` queries.
- **`Query` control methods** (`interrupt()`, `setModel()`, `setPermissionMode()`,
  `setMcpServers()`, `streamInput()`, `stopTask()`) work **only in streaming-input
  mode** — they back the monitor agent's pause/redirect/triage authority.
- **Structured outputs** — `Options.outputFormat` (JSON schema) makes each phase
  agent return a validated shape, the basis for deterministic retries.
- **Programmatic agents** — `Options.agents: Record<string, AgentDefinition>` can
  compose phase agents from run state instead of (or alongside) the static
  `.claude/agents/*.md`. The DAG→markdown renderer already exists as
  `renderWorkflowGraph` in `customFlowPrompt.ts`.

### `.md` split (Stage 1+)

Both models still get an `.md`, but they differ. A workflow keeps its DAG
(`WorkflowDefinition`) as the single source of truth and gains two thin
orchestrator wrappers:

- `orchestrator.pty.md` — "you ARE the DAG engine: read the rendered graph,
  execute it, manage gates." The DAG is rendered into its prompt (the existing
  `renderWorkflowGraph` already does this for custom flows).
- `orchestrator.sdk.md` — "code runs the DAG; you monitor, answer the human,
  triage." Gets a read-only view of the DAG, not the walking logic.

### Invariant re-map

| Concern | orchestrated | programmatic |
| --- | --- | --- |
| DAG engine | orchestrator agent | `WorkflowController` (code) |
| Entity writer | orchestrator agent via `cyboflow_*` MCP | controller via `TaskChangeRouter` (code) |
| Review-queue writers | orchestrator agent | controller + phase subagents (scoped) + monitor agent (triage) |
| Human seam | orchestrator agent | monitor agent (chat) + review queue |
| Step reporting | agent calls `report_step` | controller emits at phase boundaries |

The chokepoints (`TaskChangeRouter` / `ReviewItemRouter` / `SprintLaneStore`) are
identical regardless of caller — consistent with the existing "all writes funnel
through the router" rule. Only the *actor* differs.

### Staged plan

- **Stage 1** — `WorkflowController` walks the DAG in programmatic mode with **no
  monitor agent** (controller emits gates/questions directly). Add a facade /
  executor branch on `run.execution_model`. Wire `requestedExecutionModel`
  through `launch` → `createRun`. Validates the code engine + structured outputs
  in isolation. Planner first (linear, human-gated).
- **Stage 2** — add the monitor / human-seam agent as a streaming-input session
  (event feed + chat), read-only (no triage authority).
- **Stage 3** — enable triage (controller→agent requests, agent→controller
  verdicts) + subagent direct-to-review-queue routing; add an "awaiting triage"
  phase state with crash-safe resume.

## Tradeoffs (decide before Stage 2)

1. **Substrate divergence is intentional.** PTY cannot run programmatic; the
   capability surfaces of the two substrates genuinely diverge. Document as a
   v-limit rather than discovering it later.
2. **Two concurrent SDK sessions** in programmatic mode (phase queries + the
   long-lived monitor) cost more tokens and need a typed controller↔agent
   protocol, not ad-hoc prompts.
3. **Triage authority is advisory.** The monitor agent returns verdicts the
   controller applies through the routers — it must not write entity state
   directly, or the single-writer guarantee reopens.

## File index (Stage 0)

- `shared/types/executionModel.ts` — type, default, guards, substrate binding.
- `main/src/orchestrator/executionModelResolver.ts` — the single resolver.
- `main/src/database/migrations/031_workflow_run_execution_model.sql` — column.
- `main/src/orchestrator/workflowRegistry.ts` — `createRun` stamp + `getRunById`
  projection + `WorkflowConfigProvider.getDefaultExecutionModel`.
- `shared/types/workflows.ts` — `WorkflowRunRow.execution_model`.
- Tests: `executionModelResolver.test.ts`, execution-model stamping cases in
  `workflowRegistry.test.ts`; fixture provisioning in `orchestratorTestDb.ts`.
