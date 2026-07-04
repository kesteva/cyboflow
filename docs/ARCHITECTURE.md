# Architecture

## Purpose

Cyboflow is a macOS desktop app that orchestrates Claude Code as a multi-agent workflow runner.
It is **self-contained**: the four user-facing flows — **Planner**, **Sprint**,
**Compound** (mines merged runs for durable learnings, launched from the Insights view), and
**Ship** (planner + sprint end to end) — and their prompt bodies ship inside the app source
(`main/src/orchestrator/workflows/`). There is **no
runtime dependency on the SoloFlow plugin cache** (`~/.claude/plugins/cache/soloflow/...`). The
app spawns Claude Code in an isolated git worktree per run, streams and parses its structured
output, and concentrates everything that needs human attention — tool-use approvals, agent
findings, human-gate decisions, and manual tasks — into a single workspace-scoped **review
queue**. That review queue, backed by a DB-canonical `review_items` inbox, is the product
differentiator.

Planner, Sprint, and Ship write the app's own DB-canonical **3-table entity model** (`ideas` /
`epics` / `tasks`) via the `cyboflow_*` MCP tools — never `.soloflow/IDEA-NNN.md` or
`TASK-NNN.md` files. All entities share a single 4-stage board (see "Data Model"). The
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
collaborators and two optional narrow interfaces:

- **`db: DatabaseLike`** — narrow interface over better-sqlite3; no concrete import.
- **`logger: LoggerLike`** — structured log surface (info/warn/error/debug).
- **`runQueues: RunQueueRegistry`** — per-run mutation queue; `drainAll()` is awaited in `stop()`.
- **`claudeManager?: ClaudeManagerLike`** *(optional)* — narrow `hasActiveRunForId(runId)` interface used by `StuckDetector` to classify `orphan_pty` reasons. When omitted, that classification is effectively disabled.
- **`permissionServer?: PermissionServerLike`** *(optional)* — narrow `hasClientForRun(runId)` interface used by `StuckDetector` to classify `stale_socket` reasons. When omitted, `stale_socket` classification is disabled with a one-time WARN. The concrete socket bridge is now live as `OrchSocketServer` (the orchestrator-side half of the Cyboflow MCP IPC link, wired in `index.ts`).

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

**Documented exception:** `main/src/orchestrator/runEventBridge.ts` imports `EventRouter`,
`RawEventsSink`, and `TypedEventNarrowing` from `main/src/services/streamParser` at value
position. This is the ONLY accepted exception, permitted because `streamParser` itself has
clean runtime imports today (zod + `node:events`; `better-sqlite3` is type-only). If
`streamParser` ever pulls in `electron` or `better-sqlite3` at value position,
`runEventBridge.ts` must switch to constructor injection. Do NOT add value imports from
`services/*` to any other file under `orchestrator/**` without extending this list.

#### Entity write chokepoints (single-writer-via-orchestrator)

Two single-table write chokepoints own ALL mutations to the entity and review tables. Both
key a per-PROJECT `p-queue({concurrency: 1})` (entity refs + version bumps are project-scoped),
mirror each other's structure, and uphold the standalone-typecheck invariant (`DatabaseLike`
injected, no `electron` / `better-sqlite3` / `services/*` imports):

- **`taskChangeRouter.ts` (`TaskChangeRouter.applyChange`)** — the SINGLE write chokepoint for
  the 3-table entity model. Every entity write (GUI tRPC, orchestrator lifecycle, run close-out,
  `cyboflow_*` MCP agent tools) routes through it; nothing UPDATEs `ideas` / `epics` / `tasks`
  directly. Each `applyChange` atomically (1) mutates the correct entity table and (2) appends a
  per-field delta row to `entity_events`, minting the per-`(entity_type, entity_id)` `seq` UNIQUE
  **inside** the same transaction, then emits a `TaskChangedEvent` on `taskChangeEvents` after
  commit. It is **entity-aware**: table identity is the discriminator, so the change carries an
  `entityType` (optional on the update path — resolved by id lookup across the three tables when
  omitted). Lineage (`parent_epic_id` task→epic, `originating_idea_id` epic/task→idea) is both
  FK-enforced and validated/cycle-checked in the router. Decomposing an idea stamps
  `ideas.decomposed_at` (taking it OFF the board, reachable only via children) with **no
  cascade** — children carry the flow. The create seam stamps `epics`/`tasks.approved_at`
  PENDING (`NULL` = backend-invisible + sprint-ineligible) for plan-gated runs and visible
  (`now`) otherwise; after a child-task write settles it re-enters the queue to roll a parent
  epic's stage up via `recomputeEpicStage` (migration 042 — see "Data Model").
- **`reviewItemRouter.ts` (`ReviewItemRouter.applyReviewItem`)** — the SINGLE normal-write
  chokepoint for `review_items`. Sprint-agent findings via MCP, manual human tasks, and user
  triage resolve/dismiss route through it. The sanctioned exception is folded run-pause co-writes
  in `reviewItemListing.ts`: approval/question/human-gate code writes the review item
  synchronously inside the same transaction as the legacy gate row so both commit or roll back
  together. Those helpers still append the same `entity_events` deltas and emit through
  `emitReviewItemChangedById` after commit, so readers see the same shape. `promote-to-task` is
  NOT handled here: it is a two-chokepoint triage operation (resolve the item via this router AND
  mint a real task via `TaskChangeRouter`) orchestrated in the `reviewItems` tRPC router so each
  router stays single-table.
- **`artifactRouter.ts` (`ArtifactRouter.apply`)** — the SINGLE write chokepoint for the run-scoped
  `artifacts` table (migration 029). Backs the tabbed center pane's artifact tabs (idea spec,
  decomposed stories, screenshots, ui prototype, generic live canvas). `apply(projectId, change)`
  handles `create` (UPSERT by `(run_id, atype)` — so orchestrator auto-mint is idempotent), `update`
  (enrich), and `commit` (flip to committed); `pruneSessionOnly(projectId, runIds)` drops a closing
  session's uncommitted artifacts. Each write appends a delta to `entity_events` with
  `entity_type='artifact'` (migration 029 widened the CHECK) and emits an `ArtifactChangedEvent`
  after commit. Writers that route through it: the `cyboflow.artifacts` tRPC router (commit), the
  `cyboflow_report_artifact`/`cyboflow_commit_artifact` MCP tools, and the orchestrator auto-mint
  (`autoMintArtifacts.handleStepCompletion`, hooked fail-soft into `stepTransitionBridge` when a
  completed step declares `WorkflowStep.outputArtifact`). Templated artifacts (idea-spec,
  decomposed-stories) re-derive their content from the entity model on read; canvas artifacts
  (ui-prototype/generic) carry a `payload_json` (e.g. a localhost dev-server URL embedded by
  `LiveCanvasEmbed`). Session-only artifacts are pruned on session dismiss (`artifactLifecycle`);
  committed ones persist.

### Services (`main/src/services/`)

Core business logic services. Key components:
- **`cliManagerFactory.ts` / `panels/claude/claudeCodeManager.ts`** — Claude Code session
  lifecycle via the **Agent SDK** (`@anthropic-ai/claude-agent-sdk` `query()` in-process).
  No `claude` CLI binary is spawned and no PTY is used on this path. `ClaudeCodeManager`
  extends `AbstractCliManager` and overrides its spawn surface so the SDK's async-iterator
  drives session output directly (see `claudeCodeManager.ts:4`, header docstring lines 79–84).
  Approval routing flows through SDK **PreToolUse hooks**, not the deprecated
  `--permission-prompt-tool` CLI flag — see `permissionModeMapper.ts` (`buildPreToolUseHook`)
  and `preToolUseHookHelper.ts` (`routePreToolUseThroughApprovalRouter`).
- **`panels/cli/AbstractCliManager.ts`** — Intentional extension surface (per
  `cyboflow_system_design.md:64`). Still owns the PTY spawn path (`spawnPtyProcess`); kept
  in place even though `ClaudeCodeManager` no longer routes through it, so future CLI tools
  can be added as additional subclasses.
- **`panels/claude/interactiveClaudeManager.ts`** — The **interactive (subscription-billed)**
  Claude substrate (IDEA-013), a sibling of the SDK `ClaudeCodeManager`. It drives a REAL
  interactive `claude` REPL over the inherited `AbstractCliManager` PTY machinery (no headless
  `-p` flag, no stream-json output flag) and recovers structured panel fidelity out of band via
  a `TranscriptTailSource`. `workflow_runs.substrate` ('sdk' | 'interactive') is stamped at
  launch and dispatched by the `SubstrateDispatchFacade`.

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
  of the SDK manager's `composeSystemPromptAppend` (`claudeCodeManager.ts:478`). Fail-soft: a
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
`sprint.md`, `builtInWorkflows.ts`). `buildBuiltInWorkflows()` returns one
`WorkflowDescriptor` per `CYBOFLOW_WORKFLOW_NAMES` entry, with `workflow_path` resolved relative
to the compiled bundle (`join(__dirname, '<name>.md')`). `copy:assets` (in `main/package.json`)
places these `.md` files at `dist/main/src/orchestrator/workflows/*.md` so the path resolves in
both dev and packaged builds. This is what severs the old runtime dependency on the SoloFlow
plugin cache.

> The synchronous permission/socket bridge is now live as `OrchSocketServer`
> (`main/src/orchestrator/mcpServer/orchSocketServer.ts`), wired in `index.ts`. It carries the
> async-deferred `shell-approval-request` branch on the interactive substrate and holds the
> socket reply open until the user decides (the `socketReply` invariant).

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
   `cyboflow.health.*`). The renderer uses the typed tRPC client via the bridge wired in
   `main/src/preload.ts:2` (`exposeElectronTRPC`) and attached in `index.ts:686`.

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
- **`stores/`** — Zustand slices, one per domain:
  - Crystal-baseline: `sessionStore`, `panelStore`, `configStore`, `navigationStore`,
    `errorStore`, `sessionHistoryStore`, `sessionPreferencesStore`, `slashCommandStore`.
  - Cyboflow-era: `cyboflowStore` (workflows & runs), `activeRunsStore`, `centerPaneStore`
    (per-session run-center-pane tabs/dock/right-tab, in-memory), `mcpHealthStore`
    (sidebar dot), `questionStore`, `backlogStore` (the 3-table entity board buckets),
    `reviewQueueStore` + `reviewQueueSlice` + `reviewItemsSlice` (the unified review-queue inbox
    across finding/permission/decision/human_task — the product differentiator).
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
- **better-sqlite3 11.7.0** — SQLite, synchronous, WAL mode. Database lives at `~/.cyboflow/`
  (`main/src/utils/cyboflowDirectory.ts:60`). The legacy `~/.crystal/` path has already
  been removed.
- **@anthropic-ai/claude-agent-sdk 0.2.141** — In-process Claude Code invocation via `query()`
  and `PreToolUse` hooks for approval routing. This is the live path; no `claude` CLI binary
  is spawned.
- **@homebridge/node-pty-prebuilt-multiarch 0.12.0** — PTY sessions. Pre-built binaries;
  rebuilt for Electron ABI by `electron-builder install-app-deps` postinstall. Used today
  only by `terminalSessionManager`, `terminalPanelManager`, and `runCommandManager` —
  **not** by Claude.
- **@modelcontextprotocol/sdk 1.12.1** — For the cyboflow MCP server (runs as a stdio
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
`version` (optimistic concurrency), and a `(board_id, stage_id)` placement onto **one shared
board**. Migration `042_collapse_board` narrowed the board to **4 canonical stages** kept at
their original positions (seeded by migration 042 and `seedDefaultBoard`); they form a union
view across all three entity types:

| # | Stage | Owner | Notes |
|---|-------|-------|-------|
| 1 | Idea | idea | Raw input captured · decomposed ideas leave the board (see `decomposed_at`) |
| 6 | Ready for development | epic / task | Approved · queued — entities are CREATED here on plan approval |
| 9 | Done | epic / task | Merged & archived — terminal; an epic rolls up here once all its children are Done |
| 10 | Won't do | any | terminal · hidden by default |

> **Removed positions: 2,3,4,5,7,8,12.** The former intermediate planning stages
> (Research / Idea spec / Epics extracted / Tasks extracted) and the `derived`
> In-development / Ready-to-merge stages are now invisible app state rather than board
> columns; the old position-12 `Decomposed` terminal is now the `ideas.decomposed_at` stamp,
> and position-11 `Archived` was already removed by `024_archive_in_place` (in-place
> `archived_at` flag). Stages are DATA rows in `board_stages` (no enum/CHECK); the entity
> `stage_id` FK is `ON DELETE RESTRICT`, so 042 RELOCATES every occupant of a removed
> position to a kept stage on the same board BEFORE deleting the row (mirrors 024).

**Off-board buckets (042).** Three nullable TEXT stamps replace the dropped intermediate
stages and gate backend visibility:

- **`ideas.decomposed_at`** — a stamped idea is OFF the board (decomposed; reachable only via
  its children, surfaced through the "open root idea" back-link on epic/task cards).
  Retirement is EXCLUSIVELY gate-driven — the approve-plan gate retires the planner's root
  idea — and decomposition has NO cascade: children carry the flow.
- **`epics.approved_at` / `tasks.approved_at`** — `NULL` = PENDING = backend-invisible +
  sprint-INELIGIBLE until plan approval. This is the deferred-materialization model: the
  planner CREATES entities pending, and the approve-plan gate REVEALS them — per entity,
  through the chokepoint's orchestrator-only `approved` toggle, so each reveal broadcasts a
  `TaskChangedEvent` and a mounted board updates live. Every non-plan-gated create is visible
  immediately. The eligibility filter at `SprintLaneStore.createForRun` (the single
  sprint-materialization chokepoint) drops any task whose `approved_at IS NULL`; the
  user-facing `runs.start` pre-check is strict and rejects mixed selections outright.
- **`workflow_runs.plan_approved_at`** — stamped when a run's approve-plan gate is approved.
  The `applyChange` create seam reads it to decide pending-vs-visible. Draft cleanup is
  REJECT-only at the gate (a Revise / cap-trim answer keeps the drafts for in-place
  adjustment) and triple-gated on cancel/dismiss teardown (`deleteRunCreatedEntities`:
  plan-gated run + `plan_approved_at IS NULL` + per-entity `approved_at IS NULL`), so an
  approved run's revealed entities — and every non-plan-gated run's visible creates — survive.

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
  `task_events`. Written ONLY inside the chokepoints' transactions. (Migration 029 widened the CHECK
  to add `'artifact'` via a recreate-rename — editing migration 015 in place would never re-run on a
  migrated DB, and SQLite cannot `ALTER` a CHECK.)
- **Task satellites** — `task_acceptance_criteria`, `task_dependencies`, `task_files`,
  `task_external_links` stay **task-scoped** (FK→`tasks`).
- **`task_ref_counters`** — per-`(project_id, type)` display-ref sequence (`IDEA-NNN`,
  `EPIC-NNN`, `TASK-NNN`).

#### Review queue — the unified human-attention inbox (migration 016)

- **`review_items`** — one project-scoped inbox aggregating everything that needs human
  attention. `kind IN ('finding','permission','decision','human_task')`; `status IN
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

#### Run artifacts (migration 029)

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
and stamps `workflow_runs.batch_id`. The orchestrator agent fans out per-task subagents in
the shared session worktree (max 5 concurrent) and reports per-task progress
(status + `current_step_id`) through the `cyboflow_update_sprint_task` MCP tool. These are
NOT entity-model tables — they have their own single write chokepoint, **`SprintLaneStore`**
(`main/src/orchestrator/sprintLaneStore.ts`), and never route through `TaskChangeRouter`
(board-stage derivation of the underlying tasks still does). Lane status `'integrated'`
means "task complete + committed in the session worktree"; the session Merge close-out moves
integrated lanes' tasks to Done and marks the batch terminal. See
`docs/parallel-sprint-design.md` for the full architecture.

#### Workflow A/B testing — variants, experiments, pairwise grading (migrations 046–048)

**Variants (046).** A `workflow_variants` row is a named, frozen snapshot of a workflow's
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

**Experiments (047).** A side-by-side A/B test is an `experiments` row owning ONE
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

**Pairwise grading (048).** `experiment_comparisons` (UNIQUE per experiment) is a
self-contained verdict row: both arms' diffs are FROZEN onto it at capture (worktree-
independent), K=3 position-randomized judge samples aggregate to a `preference A|B|tie`, and
completion mints a blocking `kind='decision'` review item (gate `experiment-comparison`)
resolved by `decide`. The trigger is a workflow-agnostic terminal-status subscriber
(`terminalEvalSubscriber.ts` on `runStatusEvents`, all four settled statuses) that also
widens the run-eval snapshot to variant/experiment-tagged runs — gated by a run_evals
row-existence pre-check plus a step-ownership predicate so `human_influenced` is never
spuriously flipped, and by the `autoGradeVariantRuns` config toggle (default ON).
`PairwiseJudgeWorker` runs on its own serial queue beside `EvalWorker`. Per-variant rotation
stats (`selectVariantStats`, excluding experiment arms) power the Insights `04 Experiments`
section; the compare view is `ExperimentComparisonView` (center-pane overlay routed via
`navigationStore.experimentComparisonId`).

#### Migration file list

Migration files present today under `main/src/database/migrations/`: `003_add_tool_panels.sql`,
`004_claude_panels.sql`, `005_unified_panel_settings.sql`, `006_cyboflow_schema.sql`,
`007_add_stuck_reason.sql`, `008_permission_mode_approve_default.sql`, `009_sessions_run_id.sql`,
`010_questions.sql`, `011_workflow_step_tracking.sql`, `012_quick_workflow_sentinel.sql`,
`013_workflow_run_substrate.sql`, `014_native_tasks.sql` (board + the unified-`tasks` model +
satellites), `015_entity_model_rebuild.sql` (the 3-table entity model + `entity_events` + the
12th `Decomposed` stage), `016_review_items.sql` (the unified inbox),
`017_run_seed_idea.sql`, `018_run_claude_session.sql`, `019_workflow_run_session_id.sql`,
`020_workflow_run_paused_status.sql`, `021_session_agent_permission_mode.sql`,
`022_sprint_batches.sql` (sprint batches + lanes + `workflow_runs.batch_id`),
`023_sprint_lane_step.sql` (lane `current_step_id`), continuing through `024`–`035`,
`042_collapse_board.sql` (narrows the board to the 4 kept stages + adds the off-board
`ideas.decomposed_at` / `epics`+`tasks.approved_at` / `workflow_runs.plan_approved_at` stamps
via a relocate-then-delete that respects the `ON DELETE RESTRICT` stage FK, mirroring 024),
`043`–`045`, and the A/B-testing trio `046_workflow_variants.sql` /
`047_experiments.sql` / `048_experiment_comparisons.sql` (see the section above). 015
and 016 are forward-only with no backfill (no prod data existed); the destructive DROP+recreate
in 015 is intentional and safe.

`copy:assets` (in `main/package.json`) copies BOTH `*.sql` migrations and the workflow `*.md`
prompt bodies into the build output, so new migrations and prompt files ship in packaged builds.

## Build & Run

```
pnpm dev                  # Start Electron dev (frontend Vite dev server + Electron)
pnpm build:mac:arm64      # Full macOS arm64 build → packaged app
pnpm typecheck            # Type-check all workspaces
pnpm lint                 # ESLint across all workspaces
pnpm test:e2e             # Playwright E2E (requires a built app)
```

### asarUnpack contract

`cyboflowMcpServer.js` is spawned as an external `node` subprocess (the
per-session Cyboflow MCP server). Node cannot execute files from inside an ASAR
archive, so the script must be placed **outside** the archive at package time.

`package.json` `build.asarUnpack` covers it with the glob:

```
"main/dist/main/src/orchestrator/mcpServer/**/*.js"
```

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
exists yet; the invariant is preventive.

## Decisions & Trade-offs

See `docs/cyboflow_system_design.md` §2 (stack), §3 (fork rationale, cuts), §4 (principles).
Key standing decisions: macOS-only v1; no Redis; no Codex/OpenAI; deterministic worktree names;
orchestrator self-contained inside Electron main (extractable to Node service for team tier).
Telemetry is opt-out + anonymized: errors (Sentry) only from packaged builds, usage (Aptabase)
only from releases, all error payloads scrubbed of code/paths/prompts (see **Telemetry**).
