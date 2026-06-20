# SDK program-driven workflows (execution-model seam)

Status: **Stages 0–3 landed and wired**, after an adversarial review of Stages
0–2 (16 confirmed findings, all fixed) + a headless integration smoke + a live
boot smoke. The deterministic `WorkflowController`, its protocol, the guarded
`RunExecutor` branch, the SDK-backed `SpawnStepRunner`, `ProgrammaticRunHost`, the
review-queue human gate, `DefaultProgrammaticRunner`, AND the Stage 3 supervisory
plane (monitor + triage + human-seam seam, `SupervisorSession` +
`ReviewQueueSupervisor`) are in, unit-tested, and **wired into the composition
root** (`main/src/index.ts`). Default `orchestrated` runs are byte-identical; an
opt-in `programmatic` run activates the host-driven path.

**Review-fix highlights (commit `3a7e7176`)** — the cancellation spine (an
`AbortSignal` threaded through runner → controller → step-runner → human gate, so
a cancel actually stops the host walk and settles/cleans up an open gate; SDK
abort is read as `aborted`, not a clean `ok`), the agent-then-gate fix (a step
with a real agent AND `human:true` like planner `context` runs its agent THEN
opens the gate), a corrected per-phase execution bound, graceful revise-budget
exhaustion, and dropping the run-level timeline rewind. See the review-fixes
section below.

> ⚠️ **Live verification status.** A headless **integration smoke**
> (`programmaticIntegration.test.ts`) drives the REAL runner/controller/gate/host
> over the REAL planner DAG + DB with only the SDK spawn faked, and a **boot
> smoke** confirmed a clean `pnpm dev` boot + migration 031 in the live DB + the
> full composition-root wiring. NOT covered headlessly: a real-Claude per-step
> turn and the renderer gate-approval UI — exercise those in a `pnpm dev` run
> against a `programmatic`-stamped workflow before relying on the live SDK path.
> The seam is strictly opt-in (default `orchestrated`), so the risk is contained.

The Stage 3 supervisory **policy** plane (`ReviewQueueSupervisor` → escalate
failures to the human queue) is live; the full SDK **monitor/chat agent**
(long-lived streaming-input session the user converses with) is the remaining
designed-only slice — a drop-in for the `SupervisorSession` factory.

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

- **Stage 1 (engine + seam) — landed.** The deterministic `WorkflowController`
  (`main/src/orchestrator/programmatic/`) walks the DAG via two injected
  collaborators — `StepRunner` (the SDK boundary) and `ControllerHost` (step
  reporting + human-gate decision) — owning ordering, the retries + intra-phase
  loopback budget (`MAX_STEP_LOOPBACKS`), optional-skip, human gates, and terminal
  outcomes. `RunExecutor.execute` branches on `run.execution_model` and delegates
  to an injected `ProgrammaticRunner` (the orchestrated path is untouched).
  `requestedExecutionModel` is threaded `launch` → `createRun`. All unit-tested.
- **Stage 2 — the live SDK glue + human gate — landed (unverified).**
  `DefaultProgrammaticRunner` assembles the per-run engine: `SpawnStepRunner`
  runs each step as a scoped agent turn via the existing spawn surface (so MCP /
  agent-overlay / worktree / permission-mode setup is reused; only the prompt is
  narrowed to one step — `composeStepPrompt`); `ProgrammaticRunHost` drives the
  timeline through `buildStepTransitionEvent` (the `cyboflow_report_step` path)
  and resolves human gates via `ReviewQueueHumanGate`, which opens a blocking
  decision review item through `HumanStepManager.openHumanGate` (parking the run
  in `awaiting_review`) and awaits its resolution on `reviewItemChangeEvents`,
  mapping the free-text resolution to approve/reject/revise (`parseGateVerdict` —
  resolving the gate defaults to approve unless the note says reject/revise).
  Outcome mapping: completed/rejected → rest in `awaiting_review`, failed → throw.
  Wired in `main/src/index.ts`. **Needs a real run to verify** (see banner above).
- **Stage 3 (supervisory plane) — landed (policy supervisor live; SDK agent
  designed-only).** The controller now exposes two optional `ControllerHost` hooks
  — `notify(event)` (monitor feed: run-started / step-failed / gate-opened /
  run-finished) and `triageFailure(step)` (consulted when a REQUIRED step exhausts
  its retry+loopback budget). Triage verdicts: `retry` (bounded re-run), `escalate`
  (open a human gate → approve=skip&advance / revise=retry / reject=fail /
  abort=cancel), `fail` (terminal; the no-advisor default). A `SupervisorSession`
  (`start`/`notify`/`triage`/`stop`) backs the hooks via `ProgrammaticRunHost`;
  `DefaultProgrammaticRunner` brackets the walk with `start`/`stop`. Two policy
  impls ship: `NoopSupervisor` (default elsewhere — byte-identical `fail`) and
  `ReviewQueueSupervisor` (wired as the programmatic default — escalates failures
  to the human review queue). **Still designed-only:** the full SDK monitor/chat
  agent (a long-lived streaming-input session the user converses with, emitting
  triage verdicts via structured `outputFormat`) as a drop-in `SupervisorSession`;
  per-step structured `outputFormat` + host-side router writes (per-step writes
  still go through the agent's `cyboflow_*` MCP); subagent direct-to-review-queue
  routing; and an "awaiting triage" phase state with crash-safe resume (the gate
  open/await is in-process only — a mid-gate restart still strands the run).

## Adversarial review of Stages 0–2 — fixes landed (`3a7e7176` / `98ef086e`)

A 24-agent adversarial-review workflow over Stages 0–2 confirmed 16 defects (no
false positives). Clusters and resolutions:

- **Cancellation (CRITICAL/HIGH).** The programmatic plane had no abort path, and
  the SDK treats an aborted `query()` as a clean drain — so a cancel kept the
  controller walking and a run parked at a gate hung forever, leaking a
  `reviewItemChangeEvents` listener. Fix: a per-run `AbortController` in
  `RunExecutor` (`requestProgrammaticCancel`, wired into `cancelRunHandler`'s
  `stopLiveRun`), threaded as `signal` through `ProgrammaticRunContext` →
  `WorkflowController.run` (checked each step → `canceled`), `SpawnStepRunner`
  (resolved-under-abort → `aborted`, distinct from `failed`), and
  `ReviewQueueHumanGate` (settles to `abort` + removes its listener).
  `HumanStepManager.clearPendingForRun` dismisses orphan gate decision rows.
- **Agent-then-gate (HIGH).** A step with a real agent AND `human:true` (planner
  `context`) was treated as a pure gate, silently skipping its agent. `isPureHumanGate`
  now keys on `agent === HUMAN_GATE_AGENT`; such steps run the agent THEN gate.
- **Controller bounds (HIGH/MED).** The per-phase execution bound was linear and
  tripped falsely for multi-loopback phases (corrected to `(MAX*n+1)*n+n+1`); a
  repeatedly-`revise`d no-loopback gate now ends gracefully as `rejected` instead
  of tripping the defensive throw.
- **Timeline (HIGH).** `executeProgrammatic` no longer drives the run-level
  `stepEmitter` (which rewound the timeline to the initial step on rest).
- **Config rung (LOW).** `ConfigManager.getDefaultExecutionModel` + an
  `AppConfig.defaultExecutionModel` field make the global-default resolver rung
  live (`98ef086e`).

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

## File index (Stage 1)

- `main/src/orchestrator/programmatic/types.ts` — `StepRunner` / `ControllerHost`
  protocol + result types.
- `main/src/orchestrator/programmatic/workflowController.ts` — the deterministic
  DAG walker (`MAX_STEP_LOOPBACKS`).
- `main/src/orchestrator/runExecutor.ts` — `ProgrammaticRunner` interface, the
  guarded `execution_model` branch + `executeProgrammatic`, slot-13 injection.
- `main/src/orchestrator/runLauncher.ts` + `workflowRegistry.ts` —
  `requestedExecutionModel` threaded `launch` → `createRun` (opts bag).
- Tests: `programmatic/__tests__/workflowController.test.ts`, the execution-model
  branch cases in `runExecutor.test.ts`, the requested-rung cases in
  `workflowRegistry.test.ts`.

## File index (Stage 2)

- `programmatic/stepPrompt.ts` — pure scoped single-step prompt composer.
- `programmatic/spawnStepRunner.ts` — `StepRunner` over `spawnCliProcess`.
- `programmatic/humanGate.ts` — `HumanGateResolver` + `parseGateVerdict` +
  `ReviewQueueHumanGate` (open via `HumanStepManager`, await `reviewItemChangeEvents`).
- `programmatic/programmaticRunHost.ts` — `ControllerHost` + `StepReporter`.
- `programmatic/defaultProgrammaticRunner.ts` — assembles the per-run engine +
  outcome mapping (the `ProgrammaticRunner` RunExecutor delegates to).
- `main/src/index.ts` — composition-root wiring (slot-13 of `new RunExecutor`).
- Tests: one suite per module under `programmatic/__tests__/`.

## File index (Stage 3 + review fixes)

- `programmatic/supervisor.ts` — `SupervisorSession` interface + `NoopSupervisor`
  (default) + `ReviewQueueSupervisor` (programmatic default — escalate to human).
- `programmatic/types.ts` — `TriageDecision`, `SupervisorEvent`, the optional
  `ControllerHost.notify` / `triageFailure` hooks; plus the cancellation additions
  (`StepRunStatus 'aborted'`, `HumanGateDecision 'abort'`, `ControllerOutcome
  'canceled'`, `ControllerStepContext.signal`).
- `programmatic/workflowController.ts` — triage seam (`handleRequiredFailure`),
  monitor `emit`/`finish`, agent-then-gate, corrected bound, graceful revise.
- `programmatic/programmaticRunHost.ts` — `notify`/`triageFailure` → supervisor.
- `programmatic/defaultProgrammaticRunner.ts` — `supervisorFactory` + start/stop.
- `programmatic/spawnStepRunner.ts`, `humanGate.ts` — signal/abort handling.
- `main/src/orchestrator/runExecutor.ts` — `programmaticAborts` +
  `requestProgrammaticCancel` + abort-aware `executeProgrammatic`.
- `main/src/orchestrator/{cancelRunHandler,humanStepManager}.ts` — cancel wiring +
  `clearPendingForRun`. `main/src/services/configManager.ts` +
  `main/src/types/config.ts` — `defaultExecutionModel` rung.
- Tests: `programmatic/__tests__/{supervisor,programmaticIntegration}.test.ts` +
  triage/abort cases across the existing suites; `clearPendingForRun` in
  `reviewItemFold.test.ts`.
