# Architecture

## Purpose

Cyboflow is a macOS desktop app that orchestrates Claude Code as a multi-agent workflow runner.
It is **self-contained**: the five user-facing flows — **Launch** (interviews a brand-new project
into a brief, an idea set, and first epics/tasks), **Planner**, **Sprint**,
**Compound** (mines merged runs for durable learnings, launched from the Insights view), and
**Ship** (planner + sprint end to end) — and their prompt bodies ship inside the app source
(`main/src/orchestrator/workflows/`). There is **no
runtime dependency on the SoloFlow plugin cache** (`~/.claude/plugins/cache/soloflow/...`). The
app spawns Claude Code in an isolated git worktree per run, streams and parses its structured
output, and concentrates everything that needs human attention — tool-use approvals, agent
findings, human-gate decisions, and manual tasks — into a single workspace-scoped **review
queue**. That review queue, backed by a DB-canonical `review_items` inbox, is the product
differentiator.

Launch, Planner, Sprint, and Ship write the app's own DB-canonical **3-table entity model** (`ideas` /
`epics` / `tasks`) via the `cyboflow_*` MCP tools — never `.soloflow/IDEA-NNN.md` or
`TASK-NNN.md` files. All entities share a single 5-stage board (see "Data Model"). The
`__quick__` sentinel flow remains an internal, picker-hidden lightweight path.

This codebase is forked from `stravu/crystal` at tag `0.3.5` (commit `1e18e0b`). Crystal
branding, IPC transport, and Crystal-specific features are being progressively replaced. See
`docs/cyboflow_system_design.md` for the full product spec and cut decisions. `compound` and
`ship` were rebuilt natively (`compound.md`, `ship.md`); only the `prune` SoloFlow flow remains
dropped, its prose preserved under `docs/workflows-future/` for a future rebuild.

## Entry Points

- **`main/src/index.ts`** — Electron main process bootstrap; registers IPC handlers, starts
  the orchestrator services, opens the BrowserWindow.
- **`main/src/preload.ts`** — Electron preload script; exposes the IPC bridge to the renderer
  via `contextBridge`.
- **`frontend/src/main.tsx`** — React renderer bootstrap; mounts `<App />`.
- **`frontend/src/App.tsx`** — Root React component; top-level routing and layout.

## Top-Level Layout

- **`main/`** — Electron main process (Node.js). All orchestration, database writes, PTY session
  management, git operations, and IPC handlers live here.
- **`frontend/`** — React renderer (Vite + Tailwind). UI panels, Zustand stores, and frontend
  utilities. Never touches the database or filesystem directly.
- **`shared/`** — TypeScript types shared between `main/` and `frontend/`. The contract layer.
- **`docs/`** — Product spec, research package, reference designs, Crystal legacy docs.
- **`tests/`** — Playwright E2E tests run against a live Electron instance.
- **`scripts/`** — Build tooling: `inject-build-info.js`, `configure-build.js`.
- **`build/`** — Electron Builder config files: `afterSign.js`, `entitlements.mac.plist`.

## Major Components / Layers

### Orchestrator (`main/src/orchestrator/`)

`Orchestrator` (`main/src/orchestrator/Orchestrator.ts`) is the single lifecycle entry
point for the cyboflow main process. It is constructed via constructor injection. The
dependency bag (`OrchestratorDeps` in `main/src/orchestrator/types.ts`) has three required
collaborators and four optional narrow interfaces:

- **`db: DatabaseLike`** — narrow interface over better-sqlite3; no concrete import.
- **`logger: LoggerLike`** — structured log surface (info/warn/error/debug).
- **`runQueues: RunQueueRegistry`** — per-run mutation queue; `drainAll()` is awaited in `stop()`.
- **`claudeManager?: ClaudeManagerLike`** *(optional)* — narrow `hasActiveRunForId(runId)` interface used by `StuckDetector` to classify `orphan_pty` reasons. When omitted, that classification is effectively disabled.
- **`applyReviewItem?`** *(optional)* — the review-item write chokepoint, used at orchestrator
  start to drain legacy idle-session review items. When omitted, that one-time drain is skipped.
- **`omp?: OmpControlPlaneAdapter`** *(optional)* — read-only OMP fleet adapter; when omitted,
  the orchestrator layer has no OMP awareness.
- **`stuckEvents?: StuckEventSink`** *(optional)* — sink for `runs:stuck` notifications forwarded
  to the renderer; when omitted the detector still writes the DB and emits telemetry, only the
  renderer push is skipped.

There is no `permissionServer` dependency: the `stale_socket` `StuckReason` rung it would have
backed was examined and deliberately **retired** on 2026-08-21 rather than left disabled — the
condition it hunts for cannot survive to be observed (see the "RETIRED RUNG" note on
`StuckReason` in `stuckDetector.ts`). The concrete socket bridge itself is live as
`OrchSocketServer` (the orchestrator-side half of the Cyboflow MCP IPC link, wired in `index.ts`).

`start()` is idempotent; `stop()` drains all run queues before resolving.

**Event bus decision (SPRINT-006):** No shared `eventBus: EventEmitter` exists on
`OrchestratorDeps`. Cross-component events (e.g., `runs:stuck` from `StuckDetector`) use
per-component `EventEmitter` instances created internally by each producer — not a
top-level shared bus. Future `ApprovalRouter → renderer` notifications follow the same
per-producer pattern: each component owns its emitter and callers subscribe directly.

Standalone-typecheck invariant: the entire `main/src/orchestrator/` subtree must compile
without transitive imports from `electron`, `better-sqlite3`, or any service in
`main/src/services/*`. This keeps the orchestrator extractable to a standalone Node process
for the team-tier v2 target (ROADMAP-001 §6.3).

**Frozen exemptions.** `standaloneInvariant.test.ts` holds the exact set of files still allowed
to import `electron` or a `services/*` value at value position — a list that may shrink but not
grow (a stale entry fails the test). `runEventBridge.ts` is NOT on it: its former
`services/streamParser` import relocated to `shared/streamParser` (alongside `encodeCwd`,
`modelContext`, and `agentProviderGuard`), clearing that exemption entirely. The three still
frozen:

- **`trpc/ipcAdapter.ts`** — the Electron host adapter binding the orchestrator tRPC router to
  `BrowserWindow` IPC; a standalone service substitutes a different transport adapter rather
  than extracting this one.
- **`mcpServer/scriptPath.ts`** — needs `app.isPackaged`, and is consumed BY services
  (`claudeCodeManager`, `interactiveClaudeManager`, `mcpOrphanTripwire`) at no-arg call sites, so
  the dependency runs the other way and injection would thread through five chains.
- **`verify/codexVerificationAgentQuery.ts`** — runtime use of the Codex app-server schema
  helper and usage observer; the Codex provider surface lives entirely under
  `services/panels/codex`.

Do NOT add value imports from `services/*` to any other file under `orchestrator/**` without
extending this list.

#### Entity write chokepoints (single-writer-via-orchestrator)

Four single-table write chokepoints own ALL mutations to their table — nothing UPDATEs
`ideas`/`epics`/`tasks`/`review_items`/`artifacts`/`idea_components` directly. Each keys a
per-PROJECT `p-queue({concurrency: 1})`, mutates + appends an `entity_events` delta inside one
transaction, and emits its changed-event AFTER commit, upholding the standalone-typecheck
invariant (`DatabaseLike` injected, no `electron` / `better-sqlite3` / `services/*` imports); the
queue/transaction/emit mechanics are canonical in `docs/CODE-PATTERNS.md` → "Entity-aware write
chokepoint" — this section frames only what each one owns:

- **`taskChangeRouter.ts` (`TaskChangeRouter.applyChange`)** — the 3-table entity model
  (`ideas`/`epics`/`tasks`). Entity-aware (table identity is the discriminator, resolved by id
  lookup when the caller omits it); lineage (`parent_epic_id`, `originating_idea_id`) is
  FK-enforced and cycle-checked. See "Off-board buckets" below for the `decomposed_at`/
  `approved_at` visibility stamps this chokepoint also owns.
- **`reviewItemRouter.ts` (`ReviewItemRouter.applyReviewItem`)** — `review_items`. The sanctioned
  exception is the folded run-pause co-write in `reviewItemListing.ts`: approval/question/
  human-gate code writes the review item synchronously inside the same transaction as the legacy
  gate row, so both commit or roll back together, still emitting through the same
  `entity_events`/`emitReviewItemChangedById` contract. `promote-to-task` is a two-chokepoint
  operation (resolves here AND mints a task via `TaskChangeRouter`), orchestrated in the
  `reviewItems` tRPC router.
- **`artifactRouter.ts` (`ArtifactRouter.apply`)** — the run-scoped `artifacts` table (migration
  035); see "Run artifacts" below.
- **`ideaComponentRouter.ts` (`IdeaComponentRouter.applyChange`)** — the `idea_components` ledger
  (migration 101) tracking each idea's idea-spec/prototype/architecture/epics/stories progress.

#### Visual verification (`main/src/orchestrator/verify/`)

`VerificationScheduler` (`verificationScheduler.ts`) is the DB-backed
`verification_requests` queue + `ResourceLeasePool` + drain loop a sprint/ship
lane's `visual-verify` step fires into (fire-and-continue MCP seam,
`cyboflow_request_verification`) and never blocks on. Since the
verification-agent redesign (`docs/proposals/verification-agent-redesign.md`)
the DEFAULT v1 engine dispatches every request to `VerificationAgentRunner`
(`verificationAgentRunner.ts`): `task-verify` composes a `VerificationTaskV1`
(build/serve commands + behaviors to check) on PASS, the scheduler provisions a
temporary `git worktree` at a recorded snapshot sha, deploys the
workflow-defined `visual-verify` Claude agent into it (Bash/Read/Grep/Glob
only, zero MCP servers, hermetic SDK settings), and the agent builds, serves,
drives the UI through a bundled Playwright-backed driver CLI
(`verify/driver/`), and returns a structured `VerificationReportV1` judged
against its own screenshots. `verdictDelivery.ts` merges the report into the
run's `screenshots` artifact (`ArtifactRouter`), advances or loops back the
sprint lane (`mergeGateLaneAdvance.ts`), and raises/supersedes a
`review_items` finding carrying the real failure evidence.

Dispatch keys on `isAgentEngineRequest`: the REQUEST row's own
`chain_json === '["agent"]'` first, falling back to the per-run stamp
(`workflow_runs.verify_chain=['agent']`) — never a live flag, so an in-flight
run always finishes on the engine it started on. For a flow run the two rungs
are indistinguishable: its request's `chain_json` is always the empty
intersection `'[]'` (`'agent'` is not a `VisualBackendId`, so it survives no
intersection), so dispatch still reads the run stamp exactly as it always did.
The ONE exception is the `__quick__` chat sentinel: it is minted once on the
session's first chat turn and `verify_chain` has no UPDATE path (see the
header on `visualVerificationResolver.ts`), so a quick run's posture is
instead resolved LIVE at enqueue time (`handleRequestVerification`, gated on
the optional `getVisualVerifyConfig` dep) and written VERBATIM onto the
request row's `chain_json`. A request row is never re-enqueued, so this is
every bit as immutable as the run stamp it substitutes for — the dispatch key
is still frozen at first write, just at request granularity instead of run
granularity for this one case. The prior LEGACY engine (capture backends
`capturePageBackend`/`playwrightBackend`/`peekabooBackend` + `VlmJudge`, plus
the `.cyboflow/verify.json`-driven `DevServerManager`/`StaticServerManager`
and the retired golden-baseline `pixelDiff`/`baselineStore`) is retired **in
place** (`@cyboflow-hidden` — see `docs/CODE-PATTERNS.md`) under
`main/src/services/visualVerify/`: it stays reachable only for a pre-upgrade
run's legacy `verify_chain` stamp or the `CYBOFLOW_VERIFY_LEGACY=1` rollback
kill switch, which also boot-terminalizes any agent-engine request stranded
queued/leased/running when the switch flips (via the same
`isAgentEngineRequest` key, `VerificationScheduler.runRecovery`). Both engines
share one per-project verification budget
(`projects.visual_verify_budget_calls` / `verification_requests.judge_calls_used`,
migration 056).

**Quick sessions are the first user-conversation-triggered path into this
queue, and firing one is deliberately UN-GATED at the PreToolUse layer.** In
native auto permission mode every `mcp__cyboflow__*` tool — including
`cyboflow_request_verification` — is allowed deterministically BEFORE the
auto-mode classifier even runs (`CYBOFLOW_MCP_TOOL_PREFIX` /
`claudeCodeManager.ts`'s always-installed dynamic PreToolUse hook), so a
verification fired from chat spends real per-project budget and deploys a
real SDK verification agent with NO PreToolUse prompt in front of it. What
bounds this: the runbook's build/serve commands were human-reviewed at
verify-setup time (the setup-flow layer below); the verifier runs against an
isolated, detached snapshot worktree, never the live checkout; it carries
zero MCP servers; `Bash` sits in its tool ceiling but is deliberately excluded
from its SDK `allowedTools` auto-approve list (`verificationAgentQuery.ts`), so
every Bash call still routes through `canUseTool` and the §7.2 guard below;
the per-project budget above still applies uniformly; and — the load-bearing
one — a human is present in the conversation actually asking for the check.
That last point is what makes the missing PreToolUse prompt acceptable here;
revisit this posture if quick sessions ever become reachable by a
non-interactive or untrusted caller.

`cyboflow_get_verifications` is the complementary NON-BLOCKING cold read
(`VerificationScheduler.listRequestsForRun`, run-scoped in SQL): it answers
"what has this run already verified", the one question the blocking
`cyboflow_await_verification` cannot serve once the caller no longer holds the
specific request id — e.g. a quick chat session after a context compaction
drops it.

Two deliberate decisions on this path, recorded so they are not re-litigated:

- **The proven-runbook gate has ONE enforcement point, at drain** (and only for
  a task that `derivesEnvironment`, i.e. carries a build or serve). It is
  deliberately NOT also checked at enqueue. The cost is one throwaway queue row
  per attempt on a project whose runbook is unproven; the benefit is that the
  two enqueue paths (this MCP seam and the programmatic
  `enqueueTaskVerification`) can never drift into applying two versions of one
  rule. Add a second check only if you are prepared to keep both in lockstep.
- **Quick requests drain at the SAME priority as live sprint lanes.** Only
  `setup_proof` is deprioritized (the §5.4 priority classes above), so a quick
  request lands in class 0 FIFO alongside a sprint's merge gates and, against a
  small agent-slot pool, a chatty quick session can delay them. Accepted as-is;
  revisit by giving quick traffic its own class if that becomes a real queue.

Every way a run can END cancels its outstanding verifications, through one
implementation (`VerificationScheduler.cancelForRun`) reached from two bags:
**dismiss/cancel** via `cancelRunHandler.ts`, and **Merge / Create-PR** via
`RunCloseoutDeps.cancelVerificationsForRun` in the `runs` router. Close-out
cancels alongside the other live-process teardown, BEFORE the worktree
mutation — a draining verification would otherwise both deliver a finding +
screenshots artifact onto an already-closed-out run and hold a snapshot
worktree cut from the worktree being removed. Fail-soft on both paths: the
verification queue is downstream of the run's terminal state and never blocks
a close-out.

The setup-flow layer (`docs/proposals/verification-setup-flow.md`, phases 0–3
implemented) sits on top of the agent engine: failures are classified
`env | deliverable | ambiguous` (`failureClassifier.ts` — env requires
harness-derived evidence and converts a blocking FAIL into a lane-advancing
skip; everything model-authored stays blocking), a pre-deploy preflight
(`preflight.ts`) + per-(project, modality) capability ledger with a circuit
breaker (`capabilityStore.ts`, migration 095) stop repeat environment burns,
and build/serve tasks only run against a **proven runbook**
(`.cyboflow/verify-runbook.json` portable half + `verify_runbook_local`
machine-local record, `runbookStore.ts`/`runbookHash.ts`, migration 096 —
content-addressed pin stamped at enqueue, validated by the runner, proven by
an engine-observed passing setup run). Requests resolve a **modality**
(`web | cdp-app | native-screen | mobile`) driving slot-pool concurrency
(`agentSlots` + `VERIFY_SCREEN_LEASE`), per-modality **attestation** (driver
`attest` commands + `VERIFY_ATTEST_NONCE`; no attestation ⇒ no clean pass),
and observe-only native-screen. Dependency mutation inside snapshots is
triple-guarded (§7.2): enqueue rejection + a default-deny `canUseTool` Bash
guard (`dependencyCommandGuard.ts`) + `depPreparer.ts`'s keyed read-side
dependency mirror that snapshots symlink instead of the live worktree. The
`verify-setup` built-in flow (5th `CYBOFLOW_WORKFLOW_NAMES` entry) derives,
registers (`cyboflow_register_verify_runbook`), and proves runbooks inline via
the blocking `cyboflow_await_verification` seam; `acceptanceMatrix.test.ts`
scripts the failure-injection acceptance rows.

### Services (`main/src/services/`)

Core business logic services. Key components:
- **`cliManagerFactory.ts` / `panels/claude/claudeCodeManager.ts`** — Claude Code session
  lifecycle via the **Agent SDK** (`@anthropic-ai/claude-agent-sdk` `query()` in-process).
  No `claude` CLI binary is spawned and no PTY is used on this path. `ClaudeCodeManager`
  extends `AbstractCliManager` and overrides its spawn surface so the SDK's async-iterator
  drives session output directly (see the header docstring above the `ClaudeCodeManager`
  class declaration in `claudeCodeManager.ts`).
  Approval routing flows through SDK **PreToolUse hooks**, not the deprecated
  `--permission-prompt-tool` CLI flag — see `permissionModeMapper.ts` (`buildPreToolUseHook`)
  and `preToolUseHookHelper.ts` (`routePreToolUseThroughApprovalRouter`).
- **`panels/cli/AbstractCliManager.ts`** — Intentional extension surface (per
  `cyboflow_system_design.md` §3, "What the fork provides directly usable"). Still owns the
  PTY spawn path (`spawnPtyProcess`); several
  live concrete subclasses extend it today: `ClaudeCodeManager` (SDK substrate),
  `InteractiveClaudeManager`, the per-provider PTY+SDK manager pairs
  (`CodexPtyManager`/`CodexSdkManager` in `panels/codex/`, `OmpPtyManager`/`OmpSdkManager` in
  `panels/omp/`, `PiPtyManager`/`PiSdkManager` in `panels/pi/`), and `DemoCliManager`. Contrast
  with `AbstractAIPanelManager` (`panels/ai/AbstractAIPanelManager.ts`) and `BaseAIPanelHandler`
  (`main/src/ipc/baseAIPanelHandler.ts`), which ARE collapse candidates — Crystal-era
  Claude+Codex UI scaffolding.
- **`panels/claude/interactiveClaudeManager.ts`** — The **interactive (subscription-billed)**
  Claude substrate (IDEA-013), a sibling of the SDK `ClaudeCodeManager`. It drives a REAL
  interactive `claude` REPL over the inherited `AbstractCliManager` PTY machinery (no headless
  `-p` flag, no stream-json output flag) and recovers structured panel fidelity out of band via
  a `TranscriptTailSource`. `workflow_runs.substrate` ('sdk' | 'interactive') is stamped at
  launch and dispatched by the `SubstrateDispatchFacade`.
- **`panels/codex/codexPtyManager.ts` / `panels/codex/codexSdkManager.ts`** — Codex is one of
  four **agent providers**, not just a CLI tool: `AGENT_PROVIDERS = ['claude', 'codex', 'omp',
  'pi']` (`shared/types/agentRuntime.ts`). `CodexPtyManager` runs Codex as an interactive PTY
  quick-session runtime; `CodexSdkManager` runs it through Codex's embedded SDK workflow
  runtime (its App Server protocol). Both extend `AbstractCliManager` and are registered/routed
  via `cliManagerFactory.ts`. Per-agent workflow runtime pins come from a workflow
  definition's `agentConfigs` overlay (`WorkflowAgentConfig.runtime === 'codex-sdk'` +
  `codexModel`, `shared/types/workflows.ts`).
- **`panels/omp/ompPtyManager.ts` / `panels/omp/ompSdkManager.ts`** and
  **`panels/pi/piPtyManager.ts` / `panels/pi/piSdkManager.ts`** — the third and fourth agent
  providers, OMP and pi, each following the same interactive-PTY / embedded-SDK-workflow split
  as Codex above and registered the same way via `cliManagerFactory.ts`.

#### Interactive-substrate workflow step tracking

The Workflow Progress panel advances on interactive-substrate runs through the **exact same
MCP-driven chain** the SDK substrate uses (scope decision #3: step tracking comes from
`cyboflow_report_step`, NOT from parsing the transcript stream). The MAIN orchestrating
interactive `claude` session calls the `cyboflow_report_step` MCP tool → `OrchSocketServer` →
`handleReportStep` → `buildStepTransitionEvent` (`stepTransitionBridge.ts`) →
`stepTransitionEvents.emit('transition', …)` → the `onStepTransition` subscription →
`mergeTransition` (`useWorkflowPhaseState.ts`), advancing the panel with zero renderer changes.
Two substrate-specific seams make this work and are the only interactive-side additions:
- **`CYBOFLOW_RUN_ID = workflow_runs.id`** is injected into the interactive PTY env (the real
  run id, NOT the discovered Claude session UUID) so the handler binds a real `workflow_runs`
  row.
- **Prompt-body prepend**: interactive `claude` has no SDK `systemPrompt.append` channel, so the
  per-run step-reporting instruction (`buildStepReportingAppend`, built from the run's EFFECTIVE
  `resolveWorkflowDefinition(name, spec_json)` — the dynamic, user-editable step-id model) is
  concatenated to the HEAD of the prompt written to PTY stdin. This is the interactive analogue
  of the SDK manager's `composeSystemPromptAppend` (`claudeCodeManager.ts`). Fail-soft: a
  non-SoloFlow / broken-spec run resolves to a `null` definition and prepends nothing.

**v1 limit — main-session-only step reporting.** Only the MAIN orchestrating session can call
`cyboflow_report_step`. Agent-tool **subagents** run in isolated sub-sessions that inherit
**neither** the `mcpServers` config **nor** the parent's hook scope (the same inherited IDEA-029
limit), so they cannot report steps — even though the PreToolUse shell hook itself does fire for
subagents (Probe A2). This ties directly to the **S5/TASK-810** subagent gating decision:
interactive selection is restricted for subagent-spawning workflows OR the `Task` tool is
force-denied, so a delegated step is always reported from the main session. Per-subagent step
reporting is explicitly out of scope for v1.

#### Dual-substrate seam, components, and rollback (IDEA-013)

A workflow run executes under **exactly one CLI substrate**, resolved **ONCE** and stamped
immutably onto `workflow_runs.substrate` at launch. The seam has three load-bearing layers:

- **Resolution** — `substrateResolver.ts` (`resolveSubstrate`) walks an override ladder
  (workflow frontmatter → per-project config → `ConfigManager.defaultSubstrate` global →
  `CYBOFLOW_SUBSTRATE` env) and floors to `DEFAULT_SUBSTRATE` (`'sdk'`). With no override
  anywhere, EVERY run resolves `'sdk'` and the SDK path stays byte-identical (zero-behavior-change
  invariant). `WorkflowRegistry.createRun` calls it once and stamps the result; there is
  intentionally **no UPDATE path** — substrate is per-run-immutable.
- **Selection surfacing** — the renderer carries the user's per-run choice via the
  `cyboflow.runs.start` tRPC input (`substrate?: 'sdk' | 'interactive'`, AppRouter-inferred,
  no local mirror) → `RunLauncher.launch` → the resolver. A global default lives in
  `ConfigManager.defaultSubstrate` (accessor floors to `'sdk'`; the field is deliberately NOT
  seeded into the constructor defaults so existing `config.json` files stay byte-identical).
  The `WorkflowPicker` selector defaults to `'sdk'` and surfaces the interactive v1 caveats.
- **Dispatch — `SubstrateDispatchFacade` (S4 / the boot-seam facade source).** It is the SINGLE
  `RunExecutor` `source` EventEmitter AND its `ClaudeSpawnerLike`. Per run it resolves
  `run.substrate` via `WorkflowRegistry.getRunById` and dispatches `spawnCliProcess` / `abort` to
  the matching `AbstractCliManager` (`ClaudeCodeManager` for `'sdk'`, `interactiveClaudeManager`
  for `'interactive'`), then **fans-in** both managers' `'output'`/`'exit'` events and re-emits
  each payload **unchanged by reference**. Because the payload is preserved object-identically,
  `runEventBridge.ts` needs **zero edits** and the `cyboflow:stream:<runId>` envelope is
  shape-identical across substrates. The `AbstractCliManager` base methods
  `spawnPtyProcess` / `setupProcessHandlers` / `killProcessTree` are LIVE and load-bearing for
  the interactive sibling — do NOT prune them or mark them `@cyboflow-hidden`.

**Warm persistent SDK sessions (per-turn subprocess respawn eliminated).** The SDK substrate
keeps ONE `query()`/claude subprocess alive across turns of the same conversation instead of
respawning per turn (which cost ~5s of bootstrap — settings scan, MCP handshakes, `--resume`
reload — on every prompt). The seam is invisible above `ClaudeCodeManager`: `spawnCliProcess`
keeps its per-turn await contract (resolves on THAT turn's terminal `result`; rejects with
`SdkSessionTerminalError` for a failed flow turn), so `RunExecutor`/`session.ts`/`events.ts`
are unchanged. Internally a non-lane spawn parks WARM at its result boundary
(`createPersistentPromptInput` holds stdin open; the for-await loop spans turns); a follow-up
spawn that is a resume-continuation of the SAME conversation (quick `isResume` / workflow
`resumeSessionId` matching the captured claude session id) with an UNCHANGED options
fingerprint (model, betas, settings overlay, MCP config, deny guards, permission allow-rules,
system prompt, env, permission mode) is PUSHED into the live query; anything else — fresh
conversation, fingerprint drift, idle TTL (15 min), terminal error, kill switch
`CYBOFLOW_DISABLE_WARM_SDK=1` — closes the warm process and cold-spawns with `--resume`
(worst case = the old per-turn behavior). `'spawned'`/`session_info`/`'exit'` are emitted per
LOGICAL TURN (not per OS process), so the whole `events.ts` quick-session lifecycle is
byte-identical; the bookkeeping maps (`processes`/`sdkRuns`/`pipelines`/`spawnKeysByRunId`)
stay populated while warm so every kill path reaches the warm process; boot recovery is
unaffected (warm state is in-memory and dies with the app; first post-restart turn always
cold-spawns with `--resume`). Fan-out lanes and programmatic DAG steps stay single-shot.
Per-turn `[Timing] sdk turn …` log lines record cold/warm path + submit→first-event latency.

**Testing note.** Any change under `main/src/services/panels/claude/` MUST run
`pnpm test:integration` (the Tier-3 mocked-SDK `*.itest.ts` suite, a blocking CI job) in
addition to `pnpm test:unit` — the `.itest.ts` files are structurally excluded from
`test:unit`'s vitest include pattern (`main/vitest.config.ts` collects only `*.test.ts` /
`*.spec.ts`), so `test:unit` alone never runs them.

**Structured-panel preservation (Q3).** The structured Claude panel renders interactive runs
with **zero frontend change**. The interactive substrate produces a `claude` transcript JSONL
whose per-line schema diverges from the SDK wire shape; `TranscriptSource` /
`TranscriptTailSource` tail it and `transcriptNormalizer.ts` reshapes each line into the SAME
`{panelId,sessionId,type:'json',data,timestamp}` envelope the SDK manager emits — so by the time
events reach `narrow()` and the bridge, the two substrates are indistinguishable. The
**transcript-vs-wire schema divergence is absorbed entirely by the normalizer**; `MessageProjection`
coalescing (the `emittedAssistantMessages` map) then folds the interactive **full-content**
lines that share a `message.id` into one rendered message, exactly as it folds SDK **partial
deltas**. `WorkflowProgressTimeline.tsx` and `useWorkflowPhaseState.ts` are byte-identical across
substrates (the `RunRightRail` parity test proves no change is needed).

**IDEA-029 dependency.** Interactive step tracking and PreToolUse gating reuse the IDEA-029
orchestrator MCP runtime (`OrchSocketServer` + `McpQueryHandler` + `cyboflow_report_step` + the
async-deferred `shell-approval-request` branch). The interactive seam consumes that runtime —
it does not duplicate it; `index.ts` / `mcpQueryHandler.ts` / `claudeCodeManager.ts` /
`runExecutor.ts` are owned by IDEA-029 / earlier slices.

**v1 limits (interactive substrate):**
- **Resume is fresh-session-only** — interactive `claude` does not expose a stable
  resume-by-id handle (upstream `claude-code#44607`); a re-opened run starts a NEW session
  rather than rehydrating the prior one.
- **Main-session-only step reporting** — only the MAIN orchestrating session reports steps
  (subagents inherit neither the `mcpServers` config nor hook scope; see above).
- **AskUserQuestion is native-TUI-only** — multiple-choice questions surface in the terminal,
  not the structured panel (no `QuestionRouter` bridge on this path).
- **Subagent gating per S5** — interactive selection is restricted for subagent-spawning
  workflows OR `Task` is force-denied (per-subagent surfacing is out of scope).
- **Coarser streaming granularity** — output arrives at **turn-level**, not token-level deltas
  (no `--include-partial-messages` on the interactive path).
- **`encodeCwd` collision caveat** — the transcript directory is keyed by an encoded cwd
  (upstream `claude-code#19972`); two worktrees that encode to the same key could collide. The
  deterministic per-run worktree path makes this practically unreachable in v1, but it is an
  UNRESOLVED upstream edge.
- **ToS / concurrency assumption is UNCONFIRMED (Probe H)** — running multiple concurrent
  subscription-billed interactive sessions is assumed acceptable but has NOT been confirmed
  against Anthropic's terms; this is a known open risk, not a guarantee.

**Rollback.** Substrate is per-run-immutable, so rollback is "pick `'sdk'` for a NEW run", never
a mutation of an existing run. Because the schema is substrate-agnostic (the column is one stamp
at launch; `raw_events` / `workflow_runs` / step transitions carry no substrate-specific shape),
flipping back to `'sdk'` preserves all prior interactive-run history unchanged — no migration, no
data loss. The `dualSubstrateIntegration.test.ts` rollback case locks this.

- **`terminalSessionManager.ts` / `terminalPanelManager.ts` / `runCommandManager.ts`** —
  These three services are the remaining live users of `@homebridge/node-pty-prebuilt-multiarch`
  (terminal panel and script execution surfaces — unrelated to Claude).
- **`simpleTaskQueue.ts`** — In-process concurrency queue (no Redis). Wraps `p-queue`.
  Used for session mutation serialization.
- **`worktreeManager.ts`** — `git worktree add -b ...` lifecycle; collision-safe naming;
  background cleanup.
- **`database.ts`** — `better-sqlite3` wrapper, WAL mode, hand-rolled migration runner.
  Also owns `seedDefaultBoard(projectId)`, which seeds the default board + its **4 canonical
  stages** (1 Idea / 6 Ready for development / 9 Done / 10 Won't do, hidden) for each NEW
  project after migration `042_collapse_board`. It MUST stay field-for-field in sync with the
  post-042 board; a cross-check test asserts `seedDefaultBoard` === the migrated 4-stage seed.
- **`sessionManager.ts`** — Coordinates session state across services.

In-repo workflow prompt bodies live in `main/src/orchestrator/workflows/` (`planner.md`,
`sprint.md`, `compound.md`, `ship.md`, plus `builtInWorkflows.ts`). `buildBuiltInWorkflows()`
returns one
`WorkflowDescriptor` per `CYBOFLOW_WORKFLOW_NAMES` entry (typed `CyboflowWorkflowName`, guarded
by `isCyboflowWorkflowName` — both exported from `shared/types/workflows.ts`), with
`workflow_path` resolved relative to the compiled bundle (`join(__dirname, '<name>.md')`).
`copy:assets` (in `main/package.json`)
places these `.md` files at `dist/main/src/orchestrator/workflows/*.md` so the path resolves in
both dev and packaged builds. This is what severs the old runtime dependency on the SoloFlow
plugin cache.

> The synchronous permission/socket bridge is now live as `OrchSocketServer`
> (`main/src/orchestrator/mcpServer/orchSocketServer.ts`), wired in `index.ts`. It carries the
> async-deferred `shell-approval-request` branch on the interactive substrate and holds the
> socket reply open until the user decides (the `socketReply` invariant).

#### The `cyboflow_*` MCP tool seam

Flow agents reach cyboflow through `cyboflowMcpServer.ts`, a **standalone node subprocess**
(esbuild-bundled self-contained by `scripts/bundle-mcp-server.mjs`, so it cannot import electron,
better-sqlite3, or `main/src/services/**`). It advertises tools to the SDK over stdio and
forwards each call as a JSON envelope over the orch unix socket to `McpQueryHandler` in the main
process, which dispatches on the envelope's `type`.

Which tools it advertises depends on `CYBOFLOW_MCP_SCOPE`, resolved once at module init and fixed
for the subprocess's lifetime: **run** (the default flow family), **global-agent** (the
cross-project read + propose-action family), or **design** (the minimal Design Mode family). Scope
is enforced by lookup, not by filtering — a tool the active scope does not advertise throws
`Unknown tool` on direct invocation, not merely absent from ListTools.

**All three surfaces derive from one registry** (`mcpServer/toolRegistry/`). Each tool is one
`defineTool` entry — name, description, a zod schema, the envelope it forwards, and a
`toEnvelope` mapping the snake_case arguments to the handler's camelCase params. From that entry
the ListTools declaration (zod → JSON Schema, `toolSchema.ts`), the argument validation, and the
`invalid_arguments` reply are all generated; `cyboflowMcpServer.ts` itself holds no per-tool code,
only the generic `findTool → prepare → executeMcpQuery` dispatch and a small table for the one
locally-served tool (`cyboflow_reference`, whose content is compiled in).

The entry's `toEnvelope` is typechecked against `EnvelopeParams<T>` — the `McpQueryMessage` union
member for the envelope it names — which closes the seam's real hole: the envelope crosses the
socket as JSON and is re-typed by a blind `parsed as McpQueryMessage` cast, so before the registry
a mis-renamed camelCase key compiled and arrived at the handler as `undefined`. The
declaration/validation/dispatch lockstep is held by
`mcpServer/__tests__/toolRegistryRatchet.test.ts`. Adding a tool means adding one entry; see
`docs/CODE-PATTERNS.md` → "`cyboflow_*` MCP tools are declared ONCE".

### Telemetry (`main/src/services/telemetry/`)

Opt-out, anonymized. Both SDKs init once at boot from the resolved config (`initTelemetry` in
`telemetry/index.ts`):

- **Errors — Sentry** (`@sentry/electron`). Fires only from **packaged `.dmg` builds**
  (`app.isPackaged`); under `pnpm dev` errors surface in the console, so Sentry stays off.
  Every outbound event/breadcrumb passes through the **scrub chokepoint** (`telemetry/scrub.ts`):
  stack-frame paths reduced to basenames, home dirs → `~`, `server_name`/`extra`/`user`
  dropped, console breadcrumbs dropped — so user source, file paths, repo names, and prompts
  never leave the machine.
- **Usage — Aptabase** (`@aptabase/electron`, no identifiers). Gated by the config flag
  (default on for packaged builds, off under `pnpm dev`) plus a baked app key — every event
  carries the `environment` tag for channel filtering. Renderer events flow through a typed
  closed-union helper
  (`frontend/src/utils/telemetry.ts` → `trackEvent`) over the fire-and-forget `telemetry:track`
  raw-IPC channel → `main/src/ipc/telemetry.ts` → `trackUsage`. Props are scalar/enum only by
  construction (never user content).

**Environment gating** (`telemetry/environment.ts`, `TelemetryEnvironment = 'local' | 'dev' | 'stable'`)
resolves from `app.isPackaged` + the stamp in `buildInfo.json`. `scripts/inject-build-info.js`
stamps **every** packaged build: `CYBOFLOW_BUILD_ENV` (`stable`/`dev`/`local`) wins when set
(the release pipeline sets it: `release:mac` → `stable`, `release:mac:dev` → `dev`); otherwise
the stamp follows the build **variant** (`build:mac:dev*` → `dev`, every other `build:mac*` →
`stable`) — so a hand-built `.dmg` handed to a tester reports a filterable environment instead
of hiding under `local` (pre-fix `build:mac` artifacts, e.g. 0.1.14, still report `local`).
Set `CYBOFLOW_BUILD_ENV=local` explicitly for a throwaway build that must not pollute release
telemetry. This `environment` is telemetry-only and **distinct from the `variant` field**
(About-dialog/updater metadata).

| Build | environment | Errors | Usage |
|---|---|---|---|
| `pnpm dev` (unpackaged) | `local` | off | off |
| explicit `CYBOFLOW_BUILD_ENV=local` `.dmg` (or pre-fix unstamped) | `local` | on (tagged `local`) | on |
| any `build:mac*` `.dmg` / stable release (`release:mac`) | `stable` | on (tagged `stable`) | on |
| `build:mac:dev*` `.dmg` / Cyboflow Dev release (`release:mac:dev`) | `dev` | on (tagged `dev`) | on |

Credentials come from env (`SENTRY_DSN`, `APTABASE_APP_KEY`, e.g. `.envrc.local`); a missing key
disables that SDK. Opt-out lives in config (`telemetry.errorReportingEnabled` /
`usageMetricsEnabled`, both default `true`) alongside a one-time anonymous `installId`; UI in
**Settings → Privacy & Telemetry**. Init reads config at boot, so toggles take effect next launch.

### IPC Layer

Two parallel surfaces are wired today:

1. **Raw Electron IPC** under `main/src/ipc/` — one file per domain (`session.ts`, `git.ts`,
   `panels.ts`, `cyboflow.ts`, etc.). `main/src/ipc/index.ts` registers all handlers at boot.
2. **tRPC via `trpc-electron`** under `main/src/orchestrator/trpc/` — the root `appRouter`
   in `router.ts` exposes all procedures under a single `cyboflow` namespace
   (`cyboflow.runs.*`, `cyboflow.approvals.*`, `cyboflow.workflows.*`, `cyboflow.events.*`,
   `cyboflow.health.*`). The renderer uses the typed tRPC client via the bridge wired by
   `exposeElectronTRPC()` in `main/src/preload.ts` and attached by
   `attachOrchestratorTrpcToWindow` in `main/src/index.ts`.

The tRPC surface is now the canonical transport for all `cyboflow.*` channels. The
`trpc-cutover-and-legacy-tree-cleanup` epic (TASK-713 through TASK-717) completed the
migration: the four raw-IPC channels (`cyboflow:listWorkflows`, `cyboflow:startRun`,
`cyboflow:listRuns`, `cyboflow:mcp-health`) have been replaced by
`cyboflow.workflows.list`, `cyboflow.runs.start`, `cyboflow.runs.list`, and
`cyboflow.health.mcpServer` respectively. The unwired duplicate tRPC tree that previously
lived in `main/src/trpc/` has been deleted (TASK-717).

#### cyboflow.* transport status

**Raw-IPC stub** — handler present in `main/src/ipc/cyboflow.ts` but returns NOT_IMPLEMENTED:
- `cyboflow:approveRun` — a dead legacy raw-IPC stub. Approve/deny is now served live by the
  tRPC `cyboflow.approvals.*` procedures (below) routed through `ApprovalRouter`; this raw
  channel is unused by the renderer and kept only so the handler registration stays exhaustive.

The renderer is fully cut over to tRPC for all data-plane `cyboflow.*` procedures except
the `cyboflow:stream:<runId>` push channel.

**tRPC live** — all procedures in `main/src/orchestrator/trpc/routers/` with real
implementations wired today:
- `cyboflow.workflows.list` — list/seed workflows for a project.
- `cyboflow.workflows.get` — fetch a single workflow by ID.
- `cyboflow.runs.list` — list `workflow_runs` rows for a project (newest first).
- `cyboflow.runs.start` — launch a new workflow run.
- `cyboflow.runs.cancel` — cancel an in-flight run via `setCancelDeps()` injection.
- `cyboflow.runs.cancelAndRestart` — cancel a stuck run and enqueue a fresh run.
- `cyboflow.runs.getStuckInspection` — diagnostic data for a stuck run (stuck reason,
  pending approval payload, latest raw_events rows). Delegates to
  `getStuckInspectionHandler` in `main/src/orchestrator/inspectorQueries.ts`.
- `cyboflow.runs.sprintLanes` / `cyboflow.runs.onSprintLaneChanged` — sprint lane rows for a
  run + the per-run lane push subscription (backed by `SprintLaneStore`, injected via
  `setSprintLaneDeps()`; see "Sprint lanes" under Data Model).
- `cyboflow.health.mcpServer` — point-in-time MCP server health snapshot.
- `cyboflow.approvals.listPending` — list all pending approvals across runs.
- `cyboflow.approvals.approve`, `cyboflow.approvals.reject` — resolve an in-flight
  decisionPromise via `ApprovalRouter.respond()`.
- `cyboflow.approvals.approveRestOfRun`, `cyboflow.approvals.rejectRestOfRun` — per-run
  batch decision procedures.
- `cyboflow.events.onApprovalCreated`, `cyboflow.events.onApprovalDecided`,
  `cyboflow.events.onStreamEvent`, `cyboflow.events.setBadgeCount` — push subscriptions
  and badge management.
- `cyboflow.tasks.*` — entity-model reads + writes (board buckets across ideas/epics/tasks,
  detail editors, lineage edits). All writes delegate to `TaskChangeRouter.applyChange`.
- `cyboflow.tracker.*` — the Linear/Plane/Dart sync surface: stateless wizard probes, `connect`,
  connected-view reads (`connections` / `conflicts`), settings/disconnect/`syncNow`,
  `resolveConflict`, and the `onTrackerChanged` project subscription. The router reaches the
  sync service through the injectable facade in `main/src/orchestrator/trackerSyncBridge.ts`
  (its standalone-typecheck invariant forbids importing `services/`); entity writes still land
  through `TaskChangeRouter.applyChange` with a `linear`/`plane`/`dart` actor.
- `cyboflow.reviewItems.list` / `.get` — project review-inbox reads; `.resolve` / `.dismiss` —
  triage mutations through `ReviewItemRouter` (resolve returns `{ reviewItemId, resumed }`
  where `resumed` reflects aggregate-unblock); `.promoteToTask` — the only TWO-chokepoint
  operation (mints a task via `TaskChangeRouter` AND resolves the item via `ReviewItemRouter`).

All procedures are consumed by their respective Zustand stores and React components.

### Renderer (`frontend/src/`)

- **`components/panels/`** — Per-panel React components. Panel-type subdirs present today:
  `ai/` (abstract base), `claude/`, `cli/`, `diff/`, `editor/`, `logPanel/`. The Crystal-era
  `codex/` panel has already been removed.
- **Run center pane (tabbed surface)** — for an active run, `CyboflowRoot` mounts `RunCenterPane`
  (replacing the former WorkflowCanvas-over-RunBottomPane stack): a `CenterPaneTabStrip` over a
  content area over a collapsible `TerminalDock`. The pinned **Flow** tab hosts `WorkflowCanvas`
  (or `SprintSwimlaneCanvas` for sprint runs); **file** tabs render `FileTabRenderer` (a 3-col diff
  grid over `parseFileHunks`, opened from the right-rail File Explorer); **artifact** tabs render
  `ArtifactTabRenderer` (+ `LiveCanvasEmbed` for ui-prototype). Per-session tab state lives in the
  in-memory `centerPaneStore` (keyed by the run's parent session). The dock collapses via
  `display:none` and NEVER unmounts `RunBottomPane`/`InteractiveTerminalView` (xterm keep-alive).
- **`stores/`** — Zustand slices, one per domain. The directory listing is the source of truth
  (36 files today, one hand-maintained list would rot); worth naming: `backlogStore` (the
  3-table entity board buckets) and `reviewQueueStore` + `reviewQueueSlice` +
  `reviewItemsSlice` (the unified review-queue inbox across finding/permission/decision/
  human_task — the product differentiator). See `frontend/src/stores/` for the current set.
- **`utils/api.ts`** — Thin IPC call wrapper used by all frontend components for raw IPC.
- **`utils/cyboflowApi.ts`** — Helper for the raw `cyboflow:*` channels.
- **`trpc/client.ts`** *(via `trpc-electron` client)* — Typed entry point for
  `cyboflow.*` procedures defined in `main/src/orchestrator/trpc/routers/`.

### Shared Types (`shared/types/`)

Both packages import from here via `../../../shared/types/...`. Changing types here is a
cross-package concern.

- **Crystal-baseline:** `models.ts`, `panels.ts`, `cliPanels.ts`, `aiPanelConfig.ts`.
- **Cyboflow-era:** `cyboflow.ts`, `workflows.ts`, `approval.ts`, `approvals.ts`,
  `mcpHealth.ts`, `stuckDetection.ts`, `stuckInspection.ts`, `claudeStream.ts`,
  `unifiedMessage.ts`, `substrate.ts`, `tasks.ts` (the 3-table entity model: `IdeaRow` /
  `EpicRow` / `TaskRow`, `TaskChangeAction`, board types), `reviews.ts` (`ReviewItem`,
  the per-kind payload union, `ReviewItemChangeAction`).
- **Transport contract:** `trpc.ts` re-exports the inferred `AppRouter` type from
  `main/src/orchestrator/trpc/router.ts` so the renderer's `trpc/client.ts` is fully typed
  without importing main-process code.

## Frameworks & External Dependencies

- **Electron 37.6.0** — Desktop shell. `electron-builder` for packaging/signing; `@electron/rebuild`
  for native module rebuilds against Electron's Node ABI.
- **React 19 + Vite 6** — Renderer. Tailwind CSS for styling; `clsx` + `tailwind-merge` via `cn()`.
- **Zustand 5** — Renderer state. One slice per domain; no Redux.
- **better-sqlite3 11.7.0** — SQLite, synchronous, WAL mode. Data-dir resolution is per-kind
  (`getCyboflowDirectory()`, `main/src/utils/cyboflowDirectory.ts`) — see `docs/UPDATES.md` for
  the full table. The legacy `~/.crystal/` path has already been removed.
- **@anthropic-ai/claude-agent-sdk 0.3.224** — In-process Claude Code invocation via `query()`
  and `PreToolUse` hooks for approval routing. This is the live path; no `claude` CLI binary
  is spawned.
- **@openai/codex 0.144.3** — Direct dependency (both root and `main/package.json`) that
  bundles per-platform native `codex` CLI executables (resolved by
  `panels/codex/codexExecutablePath.ts`), not merely a thin API client. `CodexPtyManager` /
  `CodexSdkManager` (`panels/codex/`) spawn it as an external process — one of four agent
  providers alongside Claude, OMP, and pi (see **Services**). It is asar-unpacked
  (`node_modules/@openai/codex*/**` in `package.json` `build.asarUnpack`) so the packaged app can
  execute the bundled binary outside the archive.
- **@homebridge/node-pty-prebuilt-multiarch 0.12.0** — PTY sessions. Pre-built binaries;
  rebuilt for Electron ABI by `electron-builder install-app-deps` postinstall. Used today
  only by `terminalSessionManager`, `terminalPanelManager`, and `runCommandManager` —
  **not** by Claude.
- **@modelcontextprotocol/sdk 1.29.0** — For the cyboflow MCP server (runs as a stdio
  subprocess; entry point asar-unpacked, see below).
- **trpc-electron 0.1.2** — Typed `electron-trpc` bridge between the renderer client and
  the main-process `appRouter`.
- **p-queue 7.4.1** (via `simpleTaskQueue.ts` wrapper) — Per-run mutation serialization.
- **@sentry/electron 7.13.0 + @aptabase/electron 0.3.1** — Anonymized, opt-out telemetry.
  Sentry = crash/error reporting (main + renderer + native crashes); Aptabase = privacy-first
  usage metrics (no identifiers). Both init in the main process behind opt-out config flags +
  client credentials (`SENTRY_DSN`, `APTABASE_APP_KEY`); absent either → silent no-op. Creds
  resolve from the runtime env var (pnpm dev) **or**, when absent, the keys BAKED into
  `buildInfo.json` at build time by `inject-build-info.js` — the only source in a distributed
  packaged app, whose runtime env has none of the build shell's vars. See the **Telemetry**
  component below.
- **Playwright** — E2E tests only.

## Data Model

Schema in `main/src/database/schema.sql`; incremental migrations run in two phases inside
`DatabaseService.initialize()` (see `main/src/database/database.ts`):

- **Phase 1 — inline migrations** inside `runMigrations()`: hand-written `ALTER TABLE` /
  `CREATE TABLE` blocks gated on `PRAGMA table_info` checks and on `user_preferences` marker
  keys (e.g. `auto_commit_migrated`, `claude_panels_migrated`, `diff_panels_migrated`,
  `unified_panel_settings_migrated`, `folder_session_order_fix_applied`). These are the
  legacy Crystal-era migrations and run unconditionally on every boot (each block is
  idempotent via the marker check).

- **Phase 2 — file-based migrations** via `runFileBasedMigrations()` (added in TASK-151),
  called at the tail of `runMigrations()`: reads `main/src/database/migrations/NNN_*.sql`
  files (numeric prefix `NNN`), sorts them by prefix, and applies each whose
  `file_migration_applied:<filename>` key is not yet in `user_preferences`. The ledger
  uses the same `user_preferences` table as the inline markers; the
  `file_migration_applied:` prefix namespaces file-runner entries from inline ones.
  On upgrade installs, `runFileBasedMigrations()` also backfills
  `file_migration_applied:003_add_tool_panels.sql`, `...004...`, and `...005...` when
  the corresponding inline markers are present, so those files are never double-applied.
  Each file runs STATEMENT BY STATEMENT inside one transaction, with the ledger stamp
  written in that same transaction, and the runner is FAIL-CLOSED: only an
  already-applied `ALTER … ADD COLUMN` / `CREATE …` is skipped, and any other error
  aborts boot with a blocking dialog rather than running the app against a schema its
  code does not match. Authoring rules: `docs/CODE-PATTERNS.md` → "SQLite migrations:
  idempotence is per STATEMENT".

Central tables (Crystal baseline): `sessions`, `panels`, `execution_diffs`, `projects`.
Cyboflow-era run-substrate tables (migration `006_cyboflow_schema.sql`): `workflows`,
`workflow_runs`, `raw_events`, `messages`, `approvals` — designed in system design §5.

#### Entity model — 3 tables + a single shared board (migration 015)

The DB-canonical backlog is a **3-table entity model**, one table per type — table identity IS
the type discriminator (no `type` column):

- **`ideas`** — captured input. Carries a nullable `scope` size hint (`'small' | 'large'`, set
  at idea-spec time). No lineage FK.
- **`epics`** — `originating_idea_id` FK→`ideas`. Created only on the LARGE-idea branch.
- **`tasks`** — `parent_epic_id` FK→`epics` + `originating_idea_id` FK→`ideas` (small-idea
  branch carries the idea directly) + `entry_stage_id` (planning stage captured at first
  execution; revert target).

Each table carries its own columns plus a single markdown `body` column, a `priority`, a
`category` classification (`'feature' | 'bug' | 'chore'`, default `'feature'` — migration
059, mirroring `priority`), a `version` (optimistic concurrency), and a
`(board_id, stage_id)` placement onto **one shared board**. Migration `042_collapse_board` narrowed the board to 4 canonical stages, and
migration `066_in_development_stage` re-introduced the derived position-7 **In development**
stage — **5 canonical stages** today, kept at their original positions (seeded by
`seedDefaultBoard`); they form a union view across all three entity types:

| # | Stage | Owner | Notes |
|---|-------|-------|-------|
| 1 | Idea | idea | Raw input captured · decomposed ideas leave the board (see `decomposed_at`) |
| 6 | Ready for development | epic / task | Approved · queued — entities are CREATED here on plan approval |
| 7 | In development | epic / task | Derived, never hand-set — recomputed from run associations (see `docs/CODE-PATTERNS.md` → "Derived-stage recompute follow-ons") |
| 9 | Done | epic / task | Merged & archived — terminal; an epic rolls up here once all its children are Done |
| 10 | Won't do | any | terminal · hidden by default |

> **Removed positions: 2,3,4,5,8,12.** The former intermediate planning stages
> (Research / Idea spec / Epics extracted / Tasks extracted) and the `derived`
> Ready-to-merge stage are now invisible app state rather than board columns (position-7
> In development returned via migration 066); the old position-12 `Decomposed` terminal is now the `ideas.decomposed_at` stamp,
> and position-11 `Archived` was already removed by `024_archive_in_place` (in-place
> `archived_at` flag). Stages are DATA rows in `board_stages` (no enum/CHECK); the entity
> `stage_id` FK is `ON DELETE RESTRICT`, so 042 RELOCATES every occupant of a removed
> position to a kept stage on the same board BEFORE deleting the row (mirrors 024).

**Off-board buckets (042).** Three nullable TEXT stamps replace the dropped intermediate stages
and gate backend visibility: **`ideas.decomposed_at`** (a decomposed idea leaves the board,
reachable only via children, gate-driven, no cascade), **`epics`/`tasks.approved_at`** (`NULL` =
PENDING = backend-invisible + sprint-ineligible until the approve-plan gate REVEALS it per
entity through the chokepoint's `approved` toggle), and **`workflow_runs.plan_approved_at`** (the
create seam's pending-vs-visible switch; draft cleanup is REJECT-only at the gate and
triple-gated on cancel/dismiss teardown). The deferred-materialization mechanics — the reveal
toggle, `SprintLaneStore.createForRun`'s eligibility filter, the `runs.start` mixed-selection
rejection — are canonical in `docs/CODE-PATTERNS.md` → "Entity-aware write chokepoint" →
"Off-board buckets (migration 042)".

**Pending-draft terminal lifecycle.** A plan-gated run's PENDING drafts land in exactly one
bucket at every terminal state — zero permanent zombies:

| Terminal state | Draft outcome | Seam |
| --- | --- | --- |
| Reject option chosen at approve-plan | DELETED | `deletePendingDraftsOnPlanDecline` (exact reject-option match) |
| Plan approved | REVEALED + seed idea retired | `promoteTasksOnPlanApproval` (reveal awaited before agent resume) |
| `runs.cancel` / `runs.dismiss` of an unapproved run | DELETED | `deletePendingDraftsForRun` sweep |
| Run FAILS terminal | DELETED | shared sweep on the lifecycle `failed` seam |
| Cancel-and-restart | OLD run's drafts DELETED | shared sweep after the old run flips `canceled` |
| Run COMPLETES with `plan_approved_at` still NULL | REVEALED fail-soft | `promotePendingDraftsForRun` at `runs.end` (visible-but-unwanted beats invisible-then-deleted) |

The `ideas.scope` hint (`'small' | 'large'`) is the pre-extraction small-vs-large signal; the
post-extraction source of truth is the presence of epics. All four kept stages are `asserted`
(the `derived` execution stages collapsed away), so a task holds its entry stage until a run
actually merges — see `recomputeTaskExecutionStage` / `recomputeEpicStage` in `CODE-PATTERNS.md`.

- **`entity_events`** — polymorphic append-only audit log (`entity_type IN
  ('idea','epic','task','review_item','artifact')`, `entity_id`, per-`(entity_type, entity_id)`
  UNIQUE `seq`, `kind`, `actor`, optional `run_id`, `changes_json`). Replaces the old task-scoped
  `task_events`. Written ONLY inside the chokepoints' transactions. (Migration 035 widened the CHECK
  to add `'artifact'` via a recreate-rename — editing migration 015 in place would never re-run on a
  migrated DB, and SQLite cannot `ALTER` a CHECK.)
- **Task satellites** — `task_acceptance_criteria`, `task_dependencies`, `task_files`,
  `task_external_links` stay **task-scoped** (FK→`tasks`).
- **`task_ref_counters`** — per-`(project_id, type)` display-ref sequence (`IDEA-NNN`,
  `EPIC-NNN`, `TASK-NNN`).

#### Review queue — the unified human-attention inbox (migration 016)

- **`review_items`** — one project-scoped inbox aggregating everything that needs human
  attention. `kind IN ('finding','permission','decision','human_task','notification')` (the
  fifth kind added by migration 046); `status IN
  ('pending','resolved','dismissed')`; a per-item `blocking` boolean. The entity link is a
  **SOFT polymorphic** `(entity_type, entity_id)` pair — both nullable, `entity_type`
  CHECK-constrained to `(idea|epic|task)`, validated in code (the `ReviewItemRouter`), with NO
  per-type FK split (the referenced row may be deleted; the item survives for the audit trail).
  Lifecycle deltas reuse `entity_events` (no new event table). Kinds:
  - **finding** — emitted by Sprint agents via the `cyboflow_report_finding` MCP tool;
    non-blocking. Surfaced in a SEPARATE UI section so blocking items stay prominent.
  - **permission** — folds the real-time PreToolUse/approval path; `blocking=true`.
  - **decision** — minted by the `approve-idea` / `approve-plan` human gates; resolving one
    AUTO-RESUMES the run, subject to **aggregate-unblock** (a run stays `awaiting_review` until
    ALL of its blocking `review_items` resolve).
  - **human_task** — manual to-do; `blocking` per item. Triage can resolve / dismiss / promote
    a finding to a real task (minted through `TaskChangeRouter`).
  - **notification** — non-blocking FYI rows (migration 046; e.g. dynamic-workflow
    notifications formerly filed as `human_task`).

##### Session close-out and the delivered-session invariant

Archiving a session (`sessions:delete`) dismisses its pending review items —
`dismissPendingReviewItemsForSession`, with `backfillArchivedSessionReviewItems` as the
boot-time backstop. That seam is reached by a plain dismiss AND by the merge / create-PR
close-outs, whose dialogs delete the session once the work is away.

Gates are dismissed unconditionally: a permission prompt or human gate on an archived
session has no live run to resume. **Findings are not**, when the session's work was
DELIVERED — `workflow_runs.outcome IN DELIVERED_RUN_OUTCOMES`
(`merged` | `integrated` | `completed` | `pr_open`, `shared/types/cyboflow.ts`). A finding
describes code, and delivered code is in the tree, so the finding still applies. Before
this carve-out existed, a merge destroyed the findings it had just produced milliseconds
later, and the Insights compounding surface — which only offers findings from a delivered
session — was unreachable by construction. Migration 106 restored the rows already lost.

The invariant: `reviewItems.list({ requireDeliveredSession: true })` (what SHOWS findings)
and `DELIVERED_SESSION_FINDING_CARVE_OUT` (what KEEPS them) read the SAME outcome set. If
they drift, findings are either kept and never shown, or shown after being swept.

`'completed'` is the human's Mark-complete stamp for work that landed by a path the app
never observed (the agent merged it in chat). It is written only by
`stampSessionRunsCompleted`, whose guard is "not already delivered" rather than the
`outcome IS NULL` used elsewhere — the runs needing this correction have almost always
already recorded `canceled` / `interrupted`. The close-out dialogs decide whether to offer
it from `sessions:get-delivery-state`, which pairs that DB stamp with a git probe
(`WorktreeManager.getBranchLandingState`) covering fast-forward, cherry-pick, and squash
landings.

#### Run artifacts (migration 035)

- **`artifacts`** — run-scoped deliverables surfaced as center-pane tabs + a right-rail Artifacts
  panel. One row per `(run_id, atype)` (`atype IN
  ('idea-spec','decomposed-stories','screenshots','ui-prototype','generic','arch-design')`,
  widened by migration `045_arch_design_atype`); `mode` (`template`
  re-derived-on-read vs `canvas` payload-backed), `committed` / `session_only` / `is_new` flags,
  `step_origin`, `source_ref` (soft link to the derived-from entity), `payload_json`. `run_id`
  FK→`workflow_runs` ON DELETE CASCADE. All writes go through `ArtifactRouter.apply` (see Entity
  write chokepoints); deltas append to `entity_events` with `entity_type='artifact'`. Templated
  artifacts (idea-spec, decomposed-stories, arch-design) re-derive content from the entity model
  (arch-design extracts the idea body's `## Architecture design` section; its mint is
  content-gated on that section existing); auto-minted by
  the orchestrator when a completed step declares `WorkflowStep.outputArtifact`. Session-only
  (uncommitted) artifacts are dropped on session dismiss; committed ones persist. Quick sessions
  surface artifacts too, with no flow run in play: rows attach to the session's persistent
  `'__quick__'` chat sentinel run (`sessions.chat_run_id`) rather than a workflow-driven run, and
  neither MCP handler gates on workflow name or kind.

  Listing is SESSION-scoped wherever the consumer is the center-pane tab store (which is keyed by
  session, not run): `artifacts.listBySession` (JOINs `workflow_runs` on `session_id`) plus the
  `ArtifactChangedEvent.sessionId` field (stamped by `ArtifactRouter.emitChange` from
  `workflow_runs.session_id`, null for a parentless/legacy run) back a `useSessionArtifactsList`
  frontend hook returning a session's deliverables across ALL its runs — the `'__quick__'` chat
  sentinel plus any flow runs that session hosted. `QuickSessionCenterPane` and `RunCenterPane`
  both feed `useArtifactTabsSync` from this session-scoped list (falling back to the run-scoped
  `useArtifactsList` only when a run's parent session is unknown), so tabs survive the
  RunCenterPane ↔ QuickSessionCenterPane host switch: a deliverable minted mid-chat, or by an
  earlier flow run the session hosted, stays reachable in the tab store after that run ends
  instead of being pruned as "vanished" the moment the host with a narrower, run-scoped list takes
  over. The right-rail `ArtifactsPanel` mirrors this dual scope (`runId` xor `sessionId` prop).

#### Sprint lanes (migrations 022 + 023)

A multi-task **sprint** is ONE session-hosted `sprint` run seeded with N task ids: the
launcher creates a `sprint_batches` row plus one **lane** per task in `sprint_batch_tasks`
and stamps `workflow_runs.batch_id`. Stage parallelism is now **spec-derived** on BOTH
planes: `WORKFLOW_DEFINITIONS.sprint`'s (and `.ship`'s) `execute-tasks` step declares a
`step.fanOut` (`over: 'tasks'`, a 5-step `inner` chain, optional `maxConcurrency` — absent ⇒
`SPRINT_BATCH_CAP` = 5, `1` ⇒ serial; see `shared/types/workflows.ts` `FanOutSpec`). The
orchestrated plane (today's default) receives a runtime-generated instruction block derived
from that spec (`main/src/orchestrator/prompts/fan-out-instructions.ts`) telling the
orchestrator agent how to fan out per-task subagents and drive lanes itself in the shared
session worktree, reporting per-task progress (status + `current_step_id`) through the
`cyboflow_update_sprint_task` MCP tool; the programmatic plane's `FanOutDriver` walks the
same spec mechanically. Neither plane hardcodes the concurrency cap or the chain shape in
prose anymore — the workflow editor's fan-out toggle + concurrency control is the single
place that changes it. These lane tables are NOT entity-model tables — they have their own
single write chokepoint, **`SprintLaneStore`** (`main/src/orchestrator/sprintLaneStore.ts`),
and never route through `TaskChangeRouter` (board-stage derivation of the underlying tasks
still does). Lane status `'integrated'` means "task complete + committed in the session
worktree"; the session Merge close-out moves integrated lanes' tasks to Done and marks the
batch terminal. See `docs/proposals/parallel-sprint-design.md` for the full architecture.

#### Workflow A/B testing — variants, experiments, pairwise grading (migrations 048–050)

**Variants (048).** A `workflow_variants` row is a named, frozen snapshot of a workflow's
resolved definition (`spec_json`) plus per-variant config (agent prompt/model deltas in
`agent_overrides_json`, optional `model` / `execution_model` defaults, rotation `weight`).
Status is `draft` (default — pinnable, experiment-usable, never auto-rotated) | `active`
(in rotation) | `paused` | `retired`; **rotation is explicit opt-in** — any launch of a
workflow with ≥1 ACTIVE weight>0 variant gets a server-side weighted-random assignment at
the `RunLauncher.launch` seam (`VariantResolver`, injectable rng) unless the launch pins a
variant or the baseline. Runs stamp `variant_id`/`variant_label` (+ `experiment_id`/
`experiment_arm`) immutably at `createRun`, and **`spec_hash` is computed from the run's
EFFECTIVE spec** (the variant's frozen `spec_json` when present). Every per-run reader of a
workflow definition resolves the frozen spec via **`resolveRunFrozenSpec`**
(`main/src/orchestrator/runFrozenSpec.ts` — revision by `(workflow_id, spec_hash)`, live-spec
fallback); reading live `workflows.spec_json` per-run is a bug class (it also used to let a
mid-run edit change a running definition).

**Experiments (049).** A side-by-side A/B test is an `experiments` row owning ONE
pre-resolved `base_sha` and two arm sessions whose worktrees are pinned to that exact
committish, two arm runs (launched via `experiments.startSideBySide`), and — when
idea-seeded — one hidden per-arm CLONE of the seed idea. Arm entity writes are
**sandboxed**: creates stamp `entities.experiment_id` (+ epics/tasks land `approved_at`
NULL), `selectProjectBacklog` excludes tagged rows server-side, the plan-gate reveal paths
no-op for experiment runs, and a bidirectional `experiment_sandboxed` guard at
`TaskChangeRouter` denies cross-boundary updates in both directions (only orchestrator
promote/fold/sweep paths cross). `experiments.decide({winnerRunId|null})` folds the winner
clone back into the original idea, reveals winner entities, hard-sweeps the loser
(`deleteExperimentArmEntities`), and dismisses the loser session; `rerun` chains a fresh
head-to-head via `rerun_of_experiment_id`, `switchToRotation` activates both variants.
`workflow_runs.merge_sha` is stamped at merge close-out and `ideas/epics/tasks.caused_by_run_id`
is the manual post-merge-bug attribution link.

**Pairwise grading (050).** `experiment_comparisons` (UNIQUE per experiment) is a
self-contained verdict row: both arms' diffs are FROZEN onto it at capture (worktree-
independent), position-randomized judge samples aggregate to a `preference A|B|tie`, and
completion mints a blocking `kind='decision'` review item (gate `experiment-comparison`)
resolved by `decide`. The judge is an **ordered heterogeneous panel** of
`PairwisePanelSlot`s (mirroring `EvalWorker`'s rubric jury) — 2×Claude + 1×Codex in
production, wired at `index.ts`; **K is the panel's LENGTH**, one sample per slot in order,
and both Claude slots share ONE `ClaudePairwiseJudge` while the Codex slot gets its own
`makeCodexEvalJudgeQuery` closure (no `timeoutMs` override, so it inherits the 600s Codex
deadline against the Claude judge's 180s). The row-level `judge_model` scalar is stamped
from the FIRST Claude slot (a Claude judge resolves its model in its constructor; the Codex
one only after its first grade) — per-slot models live on each `per_sample_json` entry.
A slot failure is classified like the rubric jury's (`unavailable` / deterministic
`timeout`,`max-turns` / retryable `failed`) and the slot is dropped; if any sample survived,
a **bounded backfill** (≤2 extra draws, from the first Claude slot that graded OK) repairs
the ballot up to `min(3, panel.length)`, since an even 2-sample ballot turns a 1A/1B split
into an artificial tie. Backfill samples take `sampleIndex = panel.length + ordinal` (panel
survivors keep their gapped SLOT index — `sampleIndex` is a key, not a dense ordinal), and a
one-line degradation note naming each dropped slot is persisted into the `error` column
**on the complete row** (so `error IS NOT NULL` there is a healthy-but-degraded verdict, not
a failure). If NO sample survived and every failure was non-retryable, the whole-comparison
retry loop is skipped outright. The trigger is a workflow-agnostic terminal-status subscriber
(`terminalEvalSubscriber.ts` on `runStatusEvents`, all four settled statuses) that also
widens the run-eval snapshot to variant/experiment-tagged runs — gated by a run_evals
row-existence pre-check plus a step-ownership predicate so `human_influenced` is never
spuriously flipped, and by the `autoGradeVariantRuns` config toggle (default ON).
`PairwiseJudgeWorker` runs on its own serial queue beside `EvalWorker`. Per-variant rotation
stats (`selectVariantStats`, excluding experiment arms) power the Insights `04 Experiments`
section; the compare view is `ExperimentComparisonView` (center-pane overlay routed via
`navigationStore.experimentComparisonId`).

**Rotation experiments (058).** A running randomized rotation is itself a first-class
`experiments` row (`kind='rotation'`): it auto-OPENS when a workflow's weighted pool
reaches ≥2 arms (active weight>0 variants + the opted-in baseline), snapshotting the arm
set into `experiment_rotation_arms` (`'__baseline__'` sentinel row; label/weight
denormalized at open). **Arm-set membership is the experiment's identity**: a membership
change closes the running row as `superseded` and opens a lineage-chained successor
(`rerun_of_experiment_id`) — or silently replaces it when zero runs were attributed; pure
weight changes never close. The reconcile chokepoint lives INSIDE
`WorkflowRegistry.setVariantStatus/setBaselineRotation/deleteVariant/updateVariant`
(transactional with the write; boot reconciles all workflows). Attribution: only genuine
weighted rotation picks stamp `workflow_runs.rotation_experiment_id`
(`VariantResolver.resolveForLaunch` returns `VariantAssignment` provenance; pins/restarts
never stamp) — deliberately SEPARATE from `workflow_runs.experiment_id`, which drives the
side-by-side entity sandbox and must never see rotation runs. `experiments.decideRotation`
stamps decided+promotion FIRST (so the pauses below can't supersede it), adopts the
winning variant's spec (retire iff spec-only), and pauses every real-variant arm —
including a non-retired winner — so rotation can't instantly reopen; `abandonRotation`
mirrors it winnerless. Read surface: `selectRotationArmStats` /
`selectRotationExperimentRuns` / `selectRotationDashboardRows` (fan-out-safe
`selectVariantStats` shape, arm snapshot as driving set so zero-run arms render).
UI: rotation rows in Insights 04, a rotation mode of `ExperimentComparisonView`
(`RotationComparisonBody`: per-arm stats/run drill-down/declare-winner), and a
confirm-before-supersede modal in `VariantManagerSection` gating membership-changing
config writes while a rotation runs.

#### Migration files

Migrations are numbered `NNN_*.sql` files directly under `main/src/database/migrations/`,
applied in numeric order by `runFileBasedMigrations()` (see "Phase 2" above). The `legacy/`
subdirectory holds quarantined pre-fork Crystal migrations kept for reference only — the
runner's non-recursive numeric scan never reads it and `copy:assets` never ships it. The directory
listing is the source of truth for which migrations exist — it is intentionally NOT enumerated
here, since a hand-maintained file list rots the moment a new migration lands. A few are
structurally load-bearing enough to be worth naming: `015_entity_model_rebuild.sql` (the 3-table
entity model + `entity_events`), `016_review_items.sql` (the unified review inbox), and
`042_collapse_board.sql` (narrows the board to its 4 kept stages — see "Entity model" and
"Off-board buckets" above for the full detail on each). 015 and 016 are forward-only with no
backfill (no prod data existed); the destructive DROP+recreate in 015 is intentional and safe.

`copy:assets` (in `main/package.json`) copies BOTH `*.sql` migrations and the workflow `*.md`
prompt bodies into the build output, so new migrations and prompt files ship in packaged builds.

## Build & Run

```
pnpm dev                  # Electron dev (Vite renderer + Electron main)
pnpm build:main           # Compile the main process — run at least once before `pnpm dev`
pnpm typecheck            # Type-check all workspaces
pnpm lint                 # ESLint across all workspaces
pnpm test:unit            # THE headless code-change AC gate (see below)
pnpm test:integration     # Tier-3 mocked-SDK itest suite; required for panels/claude changes
pnpm test:e2e             # Playwright against the BUILT Electron bundle (needs a display)
pnpm electron:rebuild     # Manual escape hatch for better-sqlite3 ABI drift (normally automatic — see below)
pnpm test:gate            # Day-gate integration test; manual/unscheduled
```

`pnpm dev`'s Electron half (`electron-dev` in `package.json`) waits on the Vite dev server and
then spawns Electron via `scripts/dev-electron.mjs` — a cross-platform Node launcher (so it
starts from `cmd.exe` too) that replaced a POSIX-only `wait-on ... && electron .` shell pipeline;
it owns the `--cdp` / `--inspect` / `--perf` flags (`dev:perf` forwards `--perf`) and strips
`NODE_OPTIONS` before spawning, since the Electron binary rejects some host-Node-only flags.

**`pnpm test:unit`** is the headless code-change AC gate: `pnpm --filter main test` +
`pnpm --filter frontend test` (vitest, both one-shot) + schema-parity checks + build-script
tests, chained by the root `test:unit` script.

**Which tests to run when.** `test:unit` is the gate for a *settled* tree — it is NOT the
per-change command, and it is NOT something every agent should run:

- **Inside a sprint/ship lane** (an implement / write-tests / task-verify subagent): run only
  the tests covering the lane's files — `cd main && npx vitest run <paths>`, or the `frontend`
  equivalent. The flow prompts already require this (`sprint/agents/write-tests.md`,
  `task-verify.md`). Two reasons. **Correctness:** lanes fan out into ONE shared session
  worktree (`SPRINT_BATCH_CAP` = 5 concurrent), so a full-suite run there also executes
  siblings' half-finished uncommitted edits — unrelated failures are noise, and green proves
  nothing about the lane's own task. **Cost:** each `test:unit` is two full vitest suites; a
  Codex sprint was measured running it 14–24× per run (Claude 4–6×), which saturates every
  core. The fork-width half of this is capped separately by
  `shared/types/testConcurrency.ts` (see `vitestForkCap.ts`).
- **Final verification** (`sprint-verify`, or an interactive session finishing a change):
  `pnpm test:unit` once, over the combined/settled state.

Prefer `npx vitest run` per workspace over `pnpm --filter <ws> test` for scoped runs — filter
recursion has broken bin PATH resolution in this repo.

**`pnpm test:integration`** runs the Tier-3 mocked-SDK `*.itest.ts` suite
(`vitest.config.integration.ts`, `main/src/**/*.itest.ts`) — a blocking CI job, and structurally
excluded from `test:unit`'s vitest include pattern (`main/vitest.config.ts` only collects
`*.test.ts` / `*.spec.ts`). REQUIRED, in addition to `test:unit`, for any change under
`main/src/services/panels/claude/` (see the "Testing note" under Dual-substrate above).

**`pnpm test:e2e`** drives the BUILT Electron bundle via Playwright's `_electron.launch()`
(fixture `tests/helpers/electronApp.ts`): it launches `main/dist/main/src/index.js` under
`NODE_ENV=production` against a throwaway `--cyboflow-dir` tmp data dir and attaches to the real
Electron window on screen — no Vite dev server, no `http://localhost:4521`, no Playwright
`webServer`. The `pretest:e2e` hook (`e2e:prereqs`) builds the prerequisites (`build:main` +
`build:frontend` + `electron:rebuild`) so the launched app has `better-sqlite3` on the
**Electron** ABI; the host-Node ABI is restored automatically the next time you run `test:unit`
or `test:integration` (see "The better-sqlite3 ABI ping-pong" below), or by hand with
`node scripts/ensure-sqlite-abi.mjs host`. Two config tiers: `playwright.config.ts` (full,
`workers: 1`, all specs — the app is launched per-test by the fixture) and
`playwright.ci.minimal.config.ts` (smoke: health-check + smoke + permissions specs only). The
seeded specs (`cyboflow-picker.spec.ts`, `standalone-terminal-panels.spec.ts`) boot the app once
to create the DB, then `seedProject()` inserts a project row directly via the `/usr/bin/sqlite3`
CLI (present on every macOS runner; better-sqlite3 can't be imported host-side post-rebuild).
`test:e2e` is **NOT** the headless code-change AC gate — it needs a real display. Run it locally
on macOS, or via `.github/workflows/e2e.yml` (macOS runner): its full tier runs nightly
report-only, while the minimal smoke tier (`test:ci:minimal`) is a blocking required PR check
("E2E smoke (macOS)", promoted 2026-08-14) and part of the release gate.

### The better-sqlite3 ABI ping-pong

**Mostly retired since better-sqlite3 v13 (the Electron 44 upgrade).** v13 is N-API: it ships one
runtime-agnostic prebuild per platform (`prebuilds/darwin-arm64.node`), and that single binary
loads under host Node (ABI 127) **and** Electron (ABI 149). Its loader (`lib/binding.js`) checks
`prebuilds/<platform>-<arch>.node` **first** and falls back to `build/Debug` / `build/Release`
only when no prebuild exists — so on every platform we ship, a locally compiled artifact is never
even loaded, and `pnpm electron:rebuild`, postinstall's `install-app-deps` and CI's
`rebuild-better-sqlite3-host.mjs` are no-ops for better-sqlite3 (its `binding.gyp` skips the
compile outright when a prebuild is present). Steady state is therefore *no* `build/Release`
artifact at all and every `ensure-sqlite-abi.mjs` call passing as a cheap no-op. The machinery
below is retained as a guard for a platform without a prebuild or a future non-N-API addon.
better-sqlite3 is also kept OUT of `pnpm.onlyBuiltDependencies`: pnpm 10.11 ignores the package's
`gypfile: false` and, for an allow-listed package, runs npm's implicit `node-gyp rebuild` at
install — harmless where a toolchain exists, but node-gyp's configure step needs a recognised
Visual Studio on Windows before `binding.gyp` can skip anything, which broke `pnpm install` on
`windows-latest` (VS 2026, unknown to pnpm's bundled node-gyp 11). `pnpm rebuild better-sqlite3`
stays a no-op that exits 0, so `rebuild-better-sqlite3-host.mjs` is unaffected.
`node-pty` is N-API as well and loads under both ABIs; the one post-packaging restore that
remains is an **arch** one, not an ABI one — the x64 mac builds compile an x64 `pty.node` that an
arm64 host cannot dlopen (see `docs/RELEASE-RUNBOOK.md`). The history below explains what the
machine was for:

`NODE_MODULE_VERSION` is a property of the **host binary**, not the module. Pre-v13 there was
exactly one compiled artifact — `node_modules/.../better-sqlite3/build/Release/better_sqlite3.node`
— and two hosts that `dlopen` it: Electron (`pnpm dev`, e2e, packaging) and host Node (vitest).
Whichever rebuilt last wins; the loser dies with a `NODE_MODULE_VERSION` mismatch far from its
cause. There was no way to hold both without a second install tree.

**This is now automatic.** `scripts/ensure-sqlite-abi.mjs <host|electron>` fronts the entry points
that care:

| Entry point | Ensures |
| --- | --- |
| `test:unit`, `test:integration`, `test:gate` | host ABI |
| `electron-dev` (`pnpm dev`) | Electron ABI |

It **probes first** — a real `new Database(':memory:')` in a fresh child process, under host Node
or under Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`) as appropriate. If the artifact already
loads, it exits immediately, so steady state is a ~50ms no-op. Otherwise it swaps in a cached
artifact (`.abi-cache/`, gitignored) — the addon is a single file, so a flip is a copy rather than
a multi-minute recompile. The cache fills itself: before overwriting a working artifact it banks
that artifact under the ABI it satisfies. Keys pin platform, arch, better-sqlite3 version, and the
host's ABI-defining version, so a Node/Electron/better-sqlite3 upgrade **misses** rather than
restoring a stale artifact that would `dlopen`-fail. Only a genuine miss rebuilds, delegating the
host case to `scripts/rebuild-better-sqlite3-host.mjs` (which retries once with a forced source
build — a bare `pnpm rebuild` can silently leave a stale wrong-arch prebuild behind).

Two things it does NOT cover:

- **Direct `npx vitest run`** — the lane-scoped command (see "Which tests to run when") bypasses
  pnpm scripts entirely, so no guard runs. If it dies on `NODE_MODULE_VERSION`, run
  `node scripts/ensure-sqlite-abi.mjs host` by hand.
- **Release and packaging paths** — `build:mac:*`, `e2e:prereqs` and the root `postinstall` are
  deliberately untouched. They already rebuild explicitly, and they are the riskiest scripts in
  the repo to change.

Diagnostics: `node scripts/ensure-sqlite-abi.mjs --check <target>` reports which ABI the installed
artifact satisfies **without** swapping, rebuilding, or writing to the cache — safe against a
checkout whose app is live. `--print-key <target>` prints the cache key.

**Worktree caveat.** Node resolution walks UP the directory tree, so a git worktree with no
`node_modules` of its own resolves the **parent checkout's** better-sqlite3 — one artifact shared
with the parent's dev server and every sibling worktree. Reading it is pre-existing behaviour (a
worktree's vitest already loads the parent's addon); an ABI swap, however, is a write felt by all
of them, so the script announces it. Give a worktree its own `pnpm install` to opt out. Note that
`pnpm electron:rebuild` no-ops in a worktree that has no local `node_modules`.

**`pnpm electron:rebuild`** remains the manual escape hatch, rebuilding for the Electron ABI, as
do the `e2e:prereqs` / `build:mac:*` scripts.

Do NOT assume the root `postinstall` (`node scripts/apply-pty-napi-prebuilds.js && electron-builder
install-app-deps` — the first step aliases node-pty's installed prebuild to the name
`@electron/rebuild` looks for, so it never falls through to a node-gyp source build; see
`docs/WINDOWS-BUILD.md` → "node-pty and `@electron/rebuild`") leaves better-sqlite3 on the
Electron ABI. `install-app-deps` reports `finished moduleName=better-sqlite3`, but with
`buildFromSource=false` it can resolve a **host-ABI prebuild** and leave NMV 127 in place —
measured on a fresh worktree install, where `pnpm dev` would then have died on
`NODE_MODULE_VERSION`. Which is the point of the guard: measure the artifact, never infer its ABI
from which command last ran.

**`pnpm test:gate`** is the day-gate integration test; it requires `claude` on PATH plus real
API access and is manual/unscheduled — not part of `test:unit` or CI.

Packaging/releases: per-arch DMGs; `build:mac:universal` currently fails — see
`docs/RELEASE-RUNBOOK.md`.

### asarUnpack contract

Anything executed as a real file — a spawned subprocess script, a native binary,
a `dlopen`ed addon — cannot live inside the ASAR archive and must be listed in
`package.json` `build.asarUnpack`. The current entries and why each exists:

- `node_modules/**/*.node` — native addons (`better-sqlite3`, `node-pty`
  prebuilds) must be real files for `dlopen`.
- `node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/**` — the Agent SDK's
  per-arch bundled `claude` executable, spawned as an external process both by
  the SDK's `query()` runtime and by the interactive substrate's PTY.
- `node_modules/@openai/codex*/**` — the bundled per-platform `codex` CLI
  binaries (resolved through `app.asar.unpacked` by
  `panels/codex/codexExecutablePath.ts`).
- `node_modules/@steipete/peekaboo-mcp/**` — the retired-in-place legacy
  visual-verify capture backend's bundled Peekaboo CLI
  (`main/src/services/visualVerify/peekabooExecutablePath.ts`), still
  asar-unpacked for the `CYBOFLOW_VERIFY_LEGACY=1` rollback path.
- `main/dist/main/src/orchestrator/mcpServer/**/*.js` — `cyboflowMcpServer.js`,
  spawned as an external `node` subprocess (the per-session Cyboflow MCP
  server; the worked example below).
- `main/dist/main/src/orchestrator/shellHooks/**/*.js` — the PTY hook scripts
  (Stop / PreToolUse / question hooks) that the interactive `claude` CLI
  executes as external commands; resolved via `process.resourcesPath` in
  `interactiveSettingsWriter.ts`.
- `main/dist/main/src/orchestrator/verify/driver/**/*.js` — the visual-verify
  driver CLI, run as a subprocess by `verificationAgentRunner.ts`.

Post-sign, `build/afterSign.js` sweeps the unpacked tree as a tripwire and
warns if any `*.jar` lands in it (unsigned native code inside JARs can fail
notarization — see `docs/signing/APPLE_DEVELOPER_SETUP.md`).

**The worked example** — `cyboflowMcpServer.js` is spawned as an external
`node` subprocess. Node cannot execute files from inside an ASAR archive, so
the script must be placed **outside** the archive at package time.

In a packaged build, electron-builder places the script at:

```
<app>.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js
```

`scriptPath.ts` (`resolveMcpServerScriptPath`) resolves the script at runtime:

- **Packaged mode** — `path.join(process.resourcesPath, 'app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js')`.
  No filesystem writes occur; the file is already asar-unpacked.
- **Dev mode** — `path.join(__dirname, 'cyboflowMcpServer.js')` (the tsc-compiled
  sibling in `main/dist/main/src/orchestrator/mcpServer/`).

The result is memoized at module level (`cachedResolvedPath`). The old
read-from-asar / write-to-`~/.cyboflow/` extraction path has been removed (TASK-618).

The tsc emit layout for the main process is `main/dist/main/src/**` (mirroring
the source tree under `main/src/`). Any future subprocess script added under
`main/src/` that must be spawned externally in a packaged build needs a
targeted `asarUnpack` entry using the corresponding `main/dist/main/src/...`
path — avoid broad wildcards to minimise the unpacked-tree size.

See also `docs/packaging/root-deps-policy.md` for the workspace dependency
policy (which deps belong in `main/package.json` vs. root `package.json`, and
the list of confirmed dead dependencies pending removal).

## Planned / Not Yet Built

The approval-router / MCP-runtime gap that this section previously tracked has SHIPPED:
`ApprovalRouter`, the `OrchSocketServer` socket bridge, and the `cyboflow_*` MCP runtime
(including `cyboflow_report_step` and `cyboflow_report_finding`) are all live and wired in
`main/src/index.ts`. The only remaining stub is the dead `cyboflow:approveRun` raw-IPC handler,
superseded by the live tRPC `cyboflow.approvals.*` path (see "cyboflow.* transport status").

### Team-tier v2 — long-horizon

The standalone-typecheck invariant on `main/src/orchestrator/**` keeps the orchestrator
extractable to a standalone Node service (ROADMAP-001 §6.3 — team-tier v2 target). No code
exists yet; the invariant is preventive. It is enforced mechanically in two layers: a
`@typescript-eslint/no-restricted-imports` override over that tree in `main/eslint.config.js`
(errors on `electron` and on any `**/services/**` specifier, with `allowTypeImports` on since
tsc erases those), and the ratchet test
`main/src/orchestrator/__tests__/standaloneInvariant.test.ts`, which scans the same tree for
the dynamic `require('electron')` forms no import rule can see and holds the frozen exemption
list — a list that may shrink but not grow, since a stale entry fails the test. The seam for
new code is the one the rest of the orchestrator already uses: depend on an interface
(`DatabaseLike`-style) or take the value from the boot wiring in `main/src/index.ts`, the way
the SDK-query factories receive their resolved `claudeExecutablePath`.

## Decisions & Trade-offs

See `docs/cyboflow_system_design.md` §2 (stack), §3 (fork rationale, cuts), §4 (principles).
Key standing decisions: macOS-only v1; no Redis; deterministic worktree names;
orchestrator self-contained inside Electron main (extractable to Node service for team tier).
The original v1 "no Codex" cut was later reversed — Codex now ships as an agent provider
alongside Claude, joined since by OMP and pi (see **Services**).
Telemetry is opt-out + anonymized: errors (Sentry) only from packaged builds, usage (Aptabase)
only from releases, all error payloads scrubbed of code/paths/prompts (see **Telemetry**).
