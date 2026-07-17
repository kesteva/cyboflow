# Changelog

All notable changes to **Cyboflow** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.1.26] — 2026-07-17

### Added

- **Per-agent runtime in the global agent editor.** Each agent can be pinned to a
  provider/runtime (Claude or Codex) with a Codex-model picker, resolved and
  persisted through the agent chokepoint. [agent `runtime` + `codex_model` columns]
- **Live quick-session status board** in the review home — active quick sessions
  are listed with a running/quiet per-second timer and an unviewed flag for
  attention weighting (replaces the old `IdleSessionDetector` mint), wired over its
  own IPC listing.
- **Telemetry onboarding step.** The first-run tour gains a telemetry step modal
  (with corrected Settings event semantics); onboarding v1 snapshots migrate
  forward.
- **PTY AskUserQuestion blocked-state detection.** Interactive PTY sessions detect
  an open `AskUserQuestion` via an inline notify hook and stay flagged **blocked**
  until the user answers.
- **Opt-in performance tracing.** A single `CYBOFLOW_PERF_TRACE=1` enables both a
  main-process CPU tracer (per-seam rate counters) and a renderer probe (longtask +
  React-commit attribution, incl. a `sidebar` area).

### Changed

- **A/B experiment seed originals now sit at _In development_** with an
  _In-experiment_ badge, via read-side grouping (instead of dropping off-board).
- **Warm persistent Codex app-server.** The Codex runtime now keeps one app-server
  warm across resume-continuation turns (mirroring the warm SDK sessions),
  eliminating per-turn cold-spawn cost; leaks found in adversarial review closed.
- **git-status is async and concurrency-bounded** — the quick-check no longer
  blocks the main loop and is capped under the shared concurrency limit, with the
  last-known status preserved on an operational (timeout/kill) failure. (Addresses
  the elevated main-process CPU introduced alongside Codex.)
- **Renderer re-render churn cut** by memoizing the sidebar + session rows; the
  ui-prototype iframe is paused while the window is hidden.

### Fixed

- A **finished run no longer traps itself** on its completion summary over your
  follow-up chat — the summary is dismissable per-run (**Back to run** /
  **Continue in chat** / restore-pill).
- **Human gates surface through a programmatic→orchestrated/Codex handover.** The
  silent pass-through guard now covers **all** human gates (not just approve-plan),
  and the Codex runtime adapter is folded into the handover brief so gates aren't
  stranded in chat.
- The **monitor now sees per-task sprint lanes** in its context (lane digest
  hardened per adversarial review).

## [0.1.25] — 2026-07-16

### Added

- **Codex juror in the code-review eval jury.** The code-review evaluation jury
  now runs **2×Claude + 1×Codex**, with each juror's structured verdict persisted
  for the score panel. [migration 069 `jury_json`]
- **Per-agent Codex runtime (per-step provider pin).** An individual workflow
  step can be routed to **Codex** via a per-agent Runtime + Codex model picker in
  the step inspector; programmatic runs dispatch those steps to the Codex manager,
  and agent-config resolution threads the per-agent runtime/model through.
- **Codex-aware variant editor.** Workflow variants gain a per-variant agent
  provider/runtime axis with a provider-aware per-agent model pin rendered in the
  variant editor's step inspector. [migration 066]
- **Planner/Ship idea-stub gate.** The Planner and Ship flows gain an
  idea-stub → approve → expand → adversarial-review sequence, with research folded
  into as-needed spec completion rather than a standalone research step.
- **Derived "In development" board stage.** A position-7 derived stage surfaces
  tasks with active run associations, with in-development session attribution on
  task cards + the picker, guarded against double-pull. [migrations 066/067]
- **Session drag reordering.** Sessions in the left rail can be reordered by drag.
- **ui-prototype server reaping.** Leaked ui-prototype `http.server` processes are
  reaped at cancel + close-out.

### Changed

- **Programmatic orchestration is now the default** for workflow runs.
- **Quick sessions default to the interactive PTY substrate.**
- **Per-kind data directory.** Each app kind (Dev vs. stable) gets its own data
  directory instead of sharing `~/.cyboflow`, plus a single-instance-per-kind lock
  on that directory.
- **Mixed-provider workflow guards.** Orchestrated launches of mixed-provider
  (Claude + Codex) workflows are guarded and prompt to switch to programmatic; on
  `switch_to_orchestrated` the user is warned that separate-runtime steps fold
  into the handover agent.
- **Finer error classification.** The opaque `other` errorClass is split with a
  structural-shape tier.

### Fixed

- The quick-PTY substrate default no longer leaks onto workflow-host sessions.
- The Codex app-server environment is enriched with the login-shell `PATH`.
- **Two-instance socket collision hardening.** The orchestrator socket server
  probes before unlinking and never clobbers a live socket; EADDRINUSE recovery
  re-probes; an Electron OS single-instance lock (per-kind userData) replaces the
  PID lockfile.
- Sentry `beforeSend` drops benign broken-pipe (EPIPE) writes.
- The dev renderer retries its load on a network-service crash.
- The flow pill wraps to its own line and opens the session; **Run** is disabled
  while a task is in development.
- **"In development" projection fixes.** Heals the upgrade gap + stale pulse;
  applies the double-pull guard to experiment seed-task eligibility; the re-open
  window stops stale merged runs from pinning re-pulled tasks at Done; task stages
  recompute at Create-PR, merge, cancel, and restart close-outs.

## [0.1.24] — 2026-07-15

### Added

- **Codex provider (second agent runtime).** Cyboflow can now run flows and quick
  sessions on **OpenAI Codex** alongside Claude. A provider-neutral agent-stream
  adapter sits underneath, with provider-aware model selection, workflow prompt
  rendering, run/session labels, and permission copy throughout. Codex runs via a
  **bundled app-server** — its own transport, turn sessions, event projection,
  token-usage rollup, and approvals bridged into the review queue — gated on
  ChatGPT auth, with PTY quick sessions + SDK workflows, dynamic model discovery,
  a demo-mode launch guard, and foreign-arch Codex binaries excluded from the lean
  mac builds. [migrations 059–065: agent provider / runtime / model columns +
  agent invocations]
- **Multi-idea planner batches.** The Planner can plan **several ideas in one run**:
  a multi-select idea picker (cap 4, scope badges, plan-separately split), an
  **approve-ideas artifact + per-idea verdict gate** with Approve-all / Deny-all
  bulk buttons, `launchSeparatePlanner` for peeling an idea into its own session,
  a decomposed-stories draft mode (per-idea sections, Approve/Reject plan gate),
  one idea-spec artifact per idea, and an idea size selector on the New-backlog
  dialog. [migrations 061 seed_idea_ids, 062 approve-ideas atype, 063 per-idea
  spec artifacts]
- **Monitor rewind + live-steer.** A programmatic run can be **rewound to an
  earlier step** (`rewind_to_step`, crash-atomic mutation + durable settled marker
  for kept fan-outs), and an operator can **live-steer** a running step agent by
  pushing guidance into it mid-turn (SDK live-steer seam). Per-run step validation
  now resolves the frozen run spec rather than the live workflow definition.
- **Workflow/variant config over MCP.** Twelve MCP tools to edit workflows and
  configure variants from a quick session.
- **Idea attachments accept any file type** (not just images), surfaced via the
  `cyboflow_get_task` read path, and rendered inside the multi-idea seed block.
- **Task-level code-review loop-back.** A task's code-review step now loops back
  on must-fix defects instead of passing them downstream.

### Changed

- **AI settings** split into their own Settings tab, with an **Integrations**
  scaffold (agent providers surfaced there).
- **Quick-session names** are now two friendly words (with a UTC-date suffix)
  instead of timestamp branches.
- Removed the **Opus 4.8 250K** picker option (the legacy alias still resolves),
  and added a workflow-variant rename affordance (inline pencil in the editor
  header).

### Fixed

- Programmatic→orchestrated handover preserves `current_step_id` (the flow
  timeline no longer resets to stage 1) and exits monitor-chat mode.
- Idle-session review items open via the quick-session host, not the flow-run host.
- The single-writer agent guard exempts the sanctioned request-only tool, and
  built-in agents whose baseline description names a `cyboflow_` tool can be saved.
- Per-run cyboflow env inherited from a hosting session is stripped at boot.
- **Codex app-server no longer leaks its subprocess tree.** Teardown previously
  signalled only the direct `codex app-server` child, orphaning its MCP-bridge
  node grandchildren and unix sockets (leaks that survived for days); the
  app-server is now spawned detached and group-killed by negative pid, and the
  transient onboarding/model-discovery probe servers are tracked and reaped on
  shutdown.
- **Codex `isSecret` is honored end-to-end.** A question the model flags secret
  now renders as a masked (password) field and is persisted as `[redacted]`
  rather than stored cleartext — the real value is still delivered to Codex
  in-memory for the turn.
- **Fork-bomb guard on the PTY node-fallback.** When the CLI node-fallback
  resolves to the packaged app binary (`process.execPath`), it is now spawned with
  `ELECTRON_RUN_AS_NODE=1` so it runs as Node instead of re-launching the app.
- **Messaging Codex no longer boots a second Cyboflow app.** The same fork-bomb
  guard now covers every MCP-bridge spawn — the Codex app-server MCP config and
  the interactive `.mcp.json` writer both fold in `ELECTRON_RUN_AS_NODE=1` when the
  resolved node path is the packaged app binary (extracted into one shared helper
  so no spawn site can silently miss it).
- **Main process no longer crashes on a broken pipe.** Added top-level
  `uncaughtException`/`unhandledRejection` guards plus `'error'` listeners on
  `stdout`/`stderr` and the log write streams, so an async `EPIPE` (a closed pipe
  from a sibling process) is swallowed instead of surfacing the native crash dialog.

## [0.1.23] — 2026-07-14

### Added

- **Entity category (feature / bug / chore).** Every backlog entity — idea, epic,
  task — now carries a `category` classification alongside its priority, threaded
  end-to-end: through the `TaskChangeRouter` write chokepoint, the 3-table UNION
  read path, and the tRPC + MCP write/read surfaces, with a `CategoryTag` render
  plus create/edit controls in the UI. Default `feature` backfills every existing
  row. [migration 059]
- **Compound recommendations doc.** The compound flow no longer files individual
  `finding` items — it proposes quick / doc / task improvements and surfaces
  discarded candidates in a single **`compound-recommendations`** artifact (new
  artifact type, accepted at the ArtifactRouter write chokepoint), ending on a
  fifth human-review "merge in changes" gate with one batched final review that
  applies edits on approval. [migration 060]
- **S9 static-server verification seam.** `htmlPath` visual verifications are now
  served over a tokenized loopback static file server (fixing the `file://`
  ES-module CORS failure), with worktree-first HTML resolution + static-deliverable
  matching, `captureOrigin` + capture diagnostics rendered on the human surfaces,
  and a pixel-area fold clamp in `CapturePageBackend`.
- **Deterministic PTY turn-end signal.** A Stop-hook shell script, delivered
  inline and routed to `handleTurnEnd`, gives interactive (PTY) sessions a
  reliable turn-end signal.

### Changed

- **Sessions inherit user plugins.** `sessions.enabled_plugins_json` now defaults
  to `NULL` (was `'[]'`, which force-disabled every file-enabled plugin such as
  codex); a shape-guarded, idempotent reconciler backfills legacy `'[]'` → `NULL`.
  The numbered 059 slot for this is intentionally inert — the real rebuild lives
  in `reconcileSessionsPluginsColumn`.
- **Single live-question surface.** A run's live AskUserQuestion now renders on
  one surface, with `reviewItemsSlice.init` refcounted so overlapping owners don't
  tear down the subscription early.

### Fixed

- **A/B experiment arm safety.** An arm is no longer graded while it rests behind
  an open approval gate or is paused at a mid-run human gate; Merge / Create-PR /
  dismiss actions are guarded against a live experiment arm and session drift;
  `approved_at` is split from board visibility so a ship-arm can materialize; the
  rail experiment group stays visible while undecided; experiment-arm tasks are
  excluded from the rail badge count, `hasChildren`, and foreign `runs.start`
  sprint selection; a picked winner is given a Claude agent and its bootstrap is
  decoupled from decide success. Pairwise verdict rationale now uses stable arm
  identity instead of "Solution 1/2".
- Interactive transcript discovery tolerates a slow start with late recovery.
- Fan-out inner-loopback UI framing no longer shows a stale "reserved" label.

## [0.1.22] — 2026-07-13

### Added

- **First-run onboarding tour.** A guided first-launch experience replacing the
  old Welcome modal and review-queue onboarding card: an overlay modal carousel
  followed by advance-by-doing coachmarks anchored to real UI, including
  Configure-page pointer steps (permission / model / substrate) and an idea
  picker that defaults to New with an explainer. The tour is resumable and
  replayable, persists progress, and emits Aptabase usage events at each step. A
  new `claude:detect` IPC probes the local `claude` binary (login + credential
  markers under the enhanced shell PATH) so setup can revive a missing install,
  and the detected main branch is persisted at project create. The Resume setup
  card can now be permanently dismissed.
- **Idle sessions in the review queue.** Completed-but-unviewed interactive quick
  (PTY) sessions are now surfaced into the review queue as blocking human tasks
  by an `IdleSessionDetector`, with a dedicated **Idle sessions** review-queue
  section (oldest-idle first, Open-only, no triage CTAs). Gated by a new
  **Settings → Idle Session Review** toggle + threshold. Keyed on `chat_run_id`
  with episode idempotency, and no longer marks a session viewed on a panel
  remount.
- **Workflow-scoped agent configs.** A workflow can now carry per-agent model +
  config overrides in its `spec_json` (no migration): the AGENT tab gains a model
  select and a "copy this agent into the workflow" action in the inspector,
  editor stage cards show an effective-model row + a custom marker, and the
  configs layer into the run agent overlay at launch.
- **Warm SDK sessions.** An SDK conversation now reuses **one persistent
  subprocess across turns** instead of spawning a fresh `query()` per turn,
  cutting multi-turn latency; a fingerprint change respawns and a TTL reaps idle
  sessions (kill switch `CYBOFLOW_DISABLE_WARM_SDK=1`). Paired with **live-tail**
  progressive rendering for both SDK run chat and quick-session panels (IPC delta
  buffer) and multi-turn persistent streaming prompt input.
- **Failure-seam telemetry.** A new `emitSeamError` Sentry sink with an
  `errorClass` classifier wired into twelve failure seams — SDK / interactive
  session-error origins, run terminal-outcome, boot-recovery, and the
  step / gate / monitor / verify seams. Raw error text is stripped from all seam
  messages before they reach Sentry.

### Changed

- **Fan-out driven by one spec chokepoint.** A step's `fanOut` spec now drives
  **both** the editor UI and the orchestrated prompt plane from a single source:
  the editor toggle is reworked to serial / parallel with a `maxConcurrency`
  input, fan-out instructions and lane vocabulary are derived from the workflow
  spec (unioned across all fan-out chains), and the Agents pane gains
  `fanOut.inner` awareness. Ship's execute-tasks step carries a fan-out block with
  live `batchId` driver resolution.
- **Model labelling.** Opus is relabelled "More capable" now that Fable 5 leads
  the roster.

### Fixed

- Fan-out edge cases from adversarial review: invalid concurrency caps are clamped
  in `effectiveMaxConcurrency`, and ship step prompts are re-grounded with task
  scope after a mid-run batch stamp.
- The orchestrator socket recovers from `EADDRINUSE` and the MCP server is gated
  on it actually listening; hosted runs/workflow runs are cancelled for
  worktree-less sessions on project deletion.
- SDK no-op gaps closed across the session/run close-out kill seams; the
  warm-close-reason diagnostics map is hard-capped.
- Coachmark polish: popover flips to the anchor's left when the right lacks room,
  footer overflow fixed, and a permission choice now reaches the setup wizard
  without a restart.

## [0.1.21] — 2026-07-10

### Added

- **Manual backlog ordering.** Kanban cards can now be reordered within a column
  by drag-and-drop, backed by a fractional `sort_order` rank so a reorder touches
  only the moved card. A card-menu **Move up / Move down / Move to top** gives the
  same control from the keyboard (WCAG 2.5.7). [migration 057]
- **Rotation experiments.** A new experiment **kind (`rotation`)** alongside the
  existing side-by-side variant experiments: instead of a fixed arm split, runs
  are attributed to arms as they happen and an arm can be **superseded** as the
  champion. Includes the full lifecycle (reconcile chokepoint, resolver
  provenance, per-run attribution, decide / abandon), a read surface (per-arm
  stats, run drill-down, dashboard rows), and Insights UI (rotation compare view
  + supersede confirm). [migration 058]
- **Fan-out step editor treatment.** The workflow editor now renders a parallel
  (fan-out) stage as a canvas lane-band frame with an inner-row inspector, framed
  and centered within its phase band.

### Changed

- **Experiment lifecycle polish.** A lifecycle-aware experiment home view, a
  sidebar experiment group row, an experiment-aware session-dismiss guard, a
  shared `<workflow> A/B · <challenger>` display-name helper, and a project
  picker on the A/B test modal (locked to global workflows) so a global sprint
  flow seeds from the right project. Abandoning an experiment now stamps
  `abandoned` first and cleans up its reports, and the seed-task fold no longer
  strands the originals short of Done.

### Fixed

- The run monitor is now torn down on a programmatic→orchestrated handover.
- The full-height chat dock sizes to its container instead of the window.
- Findings are dropped from the run's central-pane "Needs your input" strip
  (they belong in the triage queue, not the run gate surface).
- Stuck `sending` chat rows are cleared for users in eastern time zones.

## [0.1.20] — 2026-07-09

### Added

- **Visual verification.** A new subsystem that captures a run's UI deliverable,
  judges it, and can gate the merge on the result — opt-in via a global
  **Settings → Visual Verification** toggle and a **per-run toggle** in the launch
  config step, configured per project through a `.cyboflow/verify.json` file.
  [migrations 055–056]
  - **Backends, in rungs.** Rung 0 captures the page and judges with a VLM; rung 1
    (**Playwright**) drives interactive web across multiple viewports with a
    deterministic-first accessibility gate, spinning up the project's dev server
    (`DevServerManager`) and lazy-installing Chromium; rung 2 (**Peekaboo**)
    verifies native desktop via a `verify:screen` lease and degrades to SKIPPED
    when macOS TCC grants are missing. Playwright is now a runtime dependency so
    the backend ships in packaged builds.
  - **Judging + baselines.** A zero-dependency pixel/**SSIM** pre-diff gates the
    (paid) VLM call, bounded by a **per-project judge-call budget** with telemetry;
    verdicts carry their source and SSIM score. A filesystem **baseline store**
    (`.cyboflow/artifacts/baselines`) plus an **Accept-as-baseline** button in the
    verdict banner let you promote a passing capture as the reference for future
    diffs.
  - **Scheduler.** A singleton `VerificationScheduler` with a resource-lease pool
    and drain loop runs requests wedge-proof, starvation-free, and cancel-safe,
    with request timeouts, abort, `cancelForRun`, crash recovery, and a
    per-batch worktree-sync mutex for batched sprint runs.
  - **Merge-gate integration.** A visual-verify lane step with loopback delivers
    the verdict (artifact enrichment plus a FAIL / low-confidence finding); the
    programmatic controller parks and actuates the gate, and skipped/timeout
    verdicts park the lane (with a non-blocking finding for
    advance-with-visibility) instead of wedging the sprint. Exposed to agents via
    the `cyboflow_request_verification` MCP tool.
  - **Review surfaces.** A **Verify Queue** panel (center pane + sidebar toggle)
    backed by a `verificationRequests.list` route, and a verdict banner on the
    run's Screenshots tab.
- **Run pending-input strip.** A footer on the run view that surfaces pending
  review items and live questions at a glance (TASK-004 / TASK-005).

## [0.1.19] — 2026-07-08

### Added

- **Workflow A/B testing — variants, experiments, and baseline rotation.**
  A workflow can now carry named **variants** alongside its baseline spec, and a
  run picks an arm by **randomized rotation** executing against a **frozen spec**
  so a mid-experiment edit can't skew results. **Experiments** run arms
  side-by-side over a shared task set: each arm gets an **arm-scoped entity
  sandbox** (one arm can never touch another's ideas/epics/tasks), a **pairwise
  judge** auto-evaluates outcomes, and a **comparison view** + experiments
  dashboard route the decision (adopt / rerun / abandon). The winning variant can
  be **promoted to baseline**, and the **baseline is a first-class rotation
  participant** (the champion, shown as a row in the Variants list with its
  weight hidden unless it's in rotation). Sprint experiments launch from a
  **task-picker modal** that seeds each arm with per-task clones and folds results
  back. [migrations 048–054]
- **Durable human gates that survive SDK-session expiry.** Human gates now
  persist across an SDK session expiring and resume gracefully; boot recovery
  **mints durable recovery gates** for open question gates, and the
  ask-user-question-recovery gate **renders and is answerable in the review
  queue** (option-less gates stay on the answer path, never generic triage). The
  PreToolUse hook timeout is pinned to a safe ~23-day ceiling.
- **Live monitor steering (RunDirectives).** Eight **non-stopping monitor
  steering actions** plus a live **RunDirectives** seam let an operator skip or
  steer a run and re-resolve a fan-out mid-flight, all behind a
  **stage-then-confirm** gate (host-enforced; no auto-confirm on re-attach).
  `SprintLaneStore` gains add/remove lane so tasks can be edited mid-run, and the
  monitor **lazily rehydrates after an app restart**.
- **Sidebar update-available pill.** A pill driven by `useUpdater` surfaces when
  a new build is available. The workflow timeline now renders **failed/skipped
  step states**.
- **Dev-only force-gate-failure affordance.** A settings-gated trigger to force
  the AskUserQuestion gate-failure path, for exercising the durable-gate recovery
  flow.

### Changed

- **Review-item invariants + flow docs aligned** (PR #6). The
  `ReviewItemRouter` invariant now documents the sanctioned **folded run-pause
  co-write** exception; cancel-path dismiss (`humanStepManager`) and app-restart
  stale recovery (`questionRouter`) now append the same `entity_events` deltas
  and emit change events, so those transitions are visible to the queue. Docs
  (README / ARCHITECTURE / CODE-PATTERNS / CLAUDE.md) updated to the current
  **four** built-in flows including **Ship**, and the stale "12-stage board"
  wording corrected to the 4-stage board.
- **Sprint task scope re-renders per step** so tasks added mid-run are grounded
  in the agent's context, and `edit_task` is scoped to queued lanes with orphaned
  `add_task` rolled back.
- **Nested modals no longer close the outer modal** on a click (cross-portal
  event bubbling fixed).

## [0.1.18] — 2026-07-07

### Added

- **In-place quick sessions (worktree opt-out).** A quick session can now run
  directly in the main checkout instead of an isolated git worktree — chosen via
  a tri-state **Workspace** control in the wizard's Advanced options, with a
  global default in a new **Settings → Quick Sessions** section. In-place
  sessions run on the interactive substrate, **never auto-commit**, and **refuse
  workflow runs** (with a warn-and-redirect); the interactive PreToolUse gate and
  MCP config are delivered without writing into the checkout, and close-out
  degrades gracefully with a rail badge. [migration 047]
- **Resilient programmatic runs — systemic-pause, retry, and handover.**
  - A **systemic-error classifier** detects usage / session / rate-limit / auth
    failures (parsing reset times) and **pauses the walk** instead of burning
    budget or skipping steps; a review-queue gate **auto-resumes at limit
    reset**.
  - A failed programmatic run can be **retried at its failed/skipped step**
    (`runs.retryStep`) — via a **Retry-failed-step** CTA on the summary panel or
    a validated retry action from the run chat.
  - A one-way **programmatic → orchestrated handover** lets a programmatic run
    switch to the orchestrated plane mid-flight.
  - **Pause/Resume now works for programmatic runs.**
- **First-class "notification" review items.** A dedicated notification kind in
  the review queue. [migration 046]

### Changed

- **Flow prose hardening.** The context agent is now intent-first with
  complexity-scaled questions; sprint review/verify subagents are scoped to the
  task's own file list; write-tests gains a no-infra decision ladder; the
  compounder gets a durability bar and doc-edit guardrails; and ship's
  dependency-analyzer is re-synced with the sprint hardening.
- Dynamic-workflow review items now offer only **Dismiss**.

### Fixed

- **ui-prototype / arch-design artifacts are minted on programmatic runs** (via a
  step-prompt follow-up), matching orchestrated runs.
- The **Workflow-complete card** is gated on the walk actually reaching its last
  step, so it no longer appears early.
- Retry / systemic-pause hardening: a `retryStep` pre-flight outside the held
  queue with a TOCTOU guard, sticky systemic give-up, resume-set purging on
  deliberate revisits, and the human gate owning the run-resume before waking the
  walk.
- The session branch is now **deleted on dismiss / project-delete close-out**.

## [0.1.17] — 2026-07-06

### Added

- **Quick-session artifacts.** Artifacts produced by a quick session now surface
  in the center pane and the right rail, backed by session-scoped artifact
  listing.
- **Always-on programmatic supervisor.** Programmatic runs now always run under
  a supervisor — live chat on every run, with escalations dual-surfaced to both
  the chat and the review queue, and no unilateral fail. This replaces the
  opt-in `programmaticSupervisor` setting (the supervisor is no longer an
  either/or choice).
- **Model picker + Advanced settings in the Ultracode launcher.** The Ultracode
  configure step now offers the same model picker and Advanced MCP/plugin
  disclosure as the quick-session launcher, defaulting to **Fable 5** when the
  availability check says it's usable (falling back to Opus otherwise).
- **"Ready to review" queue category.** A run that drains cleanly to
  *awaiting_review* now surfaces in its own **Ready to review** group on the
  home/review queue. Previously such a run minted no review item and was
  misfiled as *blocked*, so a finished sprint could silently disappear from the
  home while the queue read "all caught up."

### Fixed

- **AskUserQuestion gates work on SDK 0.3.201.** SDK flow turns are now driven in
  streaming-input mode so human `AskUserQuestion` gates fire reliably after the
  0.3.201 bump.
- **Mid-turn quick-session messages are queued** instead of aborting the running
  turn, with a client-side pending-send model for the chat composers.
- **Programmatic run gating.** Programmatic runs are blocked on pending blocking
  findings (now surfaced), and the Q1 reveal is wired into the programmatic
  approve-plan gate via an explicit outcome.
- **Run token/context ticker** is backfilled from `raw_events`, so it survives
  view switches instead of resetting.
- **Stream-IPC stability.** Stopped leaking stream-IPC listeners and no longer
  wipe `streamEvents` when re-selecting the same run.
- **Reopened-session transcripts** stay pinned to the bottom while content
  hydrates.
- **Artifact tabs.** They live-refresh as their underlying entities change
  (decomposed stories / idea spec / architecture design), and a tab opened
  before its artifact mints now shows a *not-created-yet* state instead of an
  empty/spinning tab.
- **`create_sprint_batch`** gains ref-or-id resolution and a no-eligible-tasks
  diagnostic; no-op review-item resumes are surfaced and the approvals MCP tool
  description de-confused.
- **Worktree shells no longer inherit run-scoped env.** A run's shell no longer
  leaks the app's own `CYBOFLOW_RUN_ID` / orchestrator socket / artifacts-dir
  variables when Cyboflow is launched from inside a Cyboflow session — which
  could point a shell-launched `claude` at the wrong run's MCP context.

## [0.1.16] — 2026-07-05

### Added

- **Read-only backlog access for flow agents.** Two new MCP tools —
  `cyboflow_list_tasks` and `cyboflow_get_task` — let a running flow read the
  entity backlog without any write path.
- **Execution-model controls.** The launch wizard's **Advanced** options gain a
  per-run execution-model override (orchestrated vs programmatic), and Settings
  gains a **default execution model** plus a **programmatic-supervisor** opt-in.
  The supervisor setting is read at run start, so toggling it takes effect
  without a restart.
- **Fast-mode feedback.** The **Fast** pill now warns when a fast-requested
  turn's opt-in is declined by the CLI, with a one-off toast on the decline.
- **Spawn-failure telemetry.** Sentry now instruments the missing-`claude`-binary
  and spawn-timeout seams.

### Fixed

- **Human gates survive long waits.** Gates are kept alive past the CLI's 600s
  hook timeout, and a dead `AskUserQuestion` gate now **self-heals** instead of
  wedging the run.
- Tester `.dmg` builds report their real telemetry environment (derived from the
  build variant) instead of `local`.
- The chat column stays usable on narrow windows.
- Persisted fast-mode is threaded through `panels:continue` respawns.
- The injected Cyboflow MCP server is marked always-load on both substrates.

### Changed

- Bumped the Claude Agent SDK to **0.3.201** (added a direct `@anthropic-ai/sdk`
  dependency, MCP SDK to `^1.29`) and added the `seven_day_overage_included`
  rate-limit literal to the shared unions.

## [0.1.15] — 2026-07-04

### Added

- **Optional design phase for Planner and Ship.** Both flows can now run two
  optional design steps before an idea is decomposed:
  - a **UI prototype** — a static HTML mockup the flow builds, serves from a
    local server, and shows in its own **iframe tab**; and
  - an **architecture design** — folded into the idea body and surfaced as a
    dedicated **arch-design** artifact tab.

  These run at the refinement head, after idea approval, and are gated by a new
  **approve-design** human checkpoint so nothing decomposes until you sign off on
  the design. [migration 045]

### Fixed

- The end-of-run review panel now appears only at a flow's **final** human gate,
  not at every intermediate gate.
- The Planner idea picker excludes **decomposed** (retired) ideas.
- Removed a spurious human-review prompt on the Planner/Ship context step.

### Changed

- Expanded CI and test infrastructure — a mocked-SDK integration harness
  (Tier-2 chokepoint + Tier-3 scenario coverage over a migration-replay DB), a
  parallel blocking integration job with coverage moved off the critical path,
  nightly SDK canaries, and flake quarantining.

## [0.1.14] — 2026-07-03

### Fixed

- **Hardened file-access IPC against path escapes.** All file handlers now
  enforce `realpath` containment, closing symlink, sibling-prefix, and
  dangling-link escapes out of the working directory.
- **Stricter HTML sanitization.** Rendered markdown enforces a style-property
  allowlist through a real DOMPurify `afterSanitizeAttributes` hook rather than a
  best-effort filter.
- **Process-tree termination on macOS.** Descendant PIDs are enumerated via
  `pgrep -P` — the previous GNU-only `ps --ppid` path returned nothing on macOS,
  leaving stray child processes behind on cancel/kill.
- **Long replays keep their newest output.** Sessions with more than 500 buffered
  output items no longer drop the true tail when the transcript is replayed.
- **Squash-merge after an auto-rebase.** The squash base is now recomputed after
  a rebase, so a merge succeeds when `main` has advanced underneath the run.
- Boot-recovery review-item resolution is routed through the entity chokepoint
  with post-commit emits.
- The composer no longer surfaces an unhandled promise rejection when a submit is
  rejected.

### Changed

- Removed the dead permission IPC chain; the legacy permission dialog is now
  hidden.
- **Substantially expanded automated test coverage** — main-process and renderer
  unit gaps, destructive IPC / worktree-lifecycle chokepoints, live PTY
  primitives, and the MCP + eval-judge boundaries — and reworked the end-to-end
  suite onto Electron's `_electron.launch()` against an isolated data directory.

## [0.1.13] — 2026-07-02

### Added

- **Code-review evaluation for flow runs.** A run can now be scored against a
  code-review rubric: the end-of-workflow panel gains a **score summary** broken
  down by dimension, and rubric-based findings surface in the review queue. It's
  **off by default**, gated behind a global toggle in Settings with a per-run
  override on the launch wizard. Dimensions that don't apply to a run explain
  themselves via a hover tooltip.
- **Restart a failed run.** A workflow run whose underlying turn dies on a
  terminal error is now marked **failed** instead of hanging, and can be
  relaunched **in the same session** with **Restart** — carrying over the run's
  pinned model and eval settings. The end-of-workflow panel gains dedicated
  **failed** and **needs-review** states.

### Changed

- **Task board collapsed to a simpler shape.** The board is narrowed to three
  visible columns — **Idea → Ready for development → Done** — plus a hidden
  **Won't do**. Retired ideas are marked with a *decomposed* stamp and reached
  through their child epics/tasks rather than occupying a column, and an epic's
  stage now **rolls up automatically** from its children (all children Done →
  epic Done). Entities created by a plan-gated run stay **pending until the plan
  is approved**, and are removed if the plan is declined. Epic and task cards link
  back to their originating idea.

### Fixed

- Auto-mode's permission classifier can no longer soft-brick a flow run.
- The About dialog: removed the Discord button, corrected the **View on GitHub**
  link (now `kesteva/cyboflow`), and updated the tagline to *"A human-first
  agentic development environment."*

## [0.1.12] — 2026-07-01

### Added

- **Live permission mode you can change mid-session.** Permission mode is now
  owned by the session and can be switched on the fly — the next tool call honors
  the new mode with no re-spawn. **Auto** mode routes tool approvals through
  Claude's native classifier and auto-prompts only when a call genuinely needs it;
  **Accept edits** now also auto-approves safe reads and read-only git/shell
  commands so you're not prompted for harmless inspection. Inline approval prompts
  surface directly in the chat, including for quick sessions reopened after a
  restart.
- **Fable 5 in the model pickers.** Fable 5 (1M-context native) is selectable
  everywhere a model is, guarded by an availability check: if it's pulled from
  release, the pickers grey it out and any run pinned to it falls back gracefully
  to Opus — including a mid-run retry on Opus if Fable becomes unavailable while a
  turn is in flight.
- **Per-agent and per-session MCP / plugin control.** A workflow agent can now be
  scoped to a subset of MCP servers in the Agent editor, and a session can deny
  specific MCP servers or enable specific plugins from the session-start
  **Advanced** panel. The Workflows page shows read-only MCPs and Plugins sections.
  Controls apply on both the SDK and interactive (PTY) substrates.
- **Custom-agent model pin.** A custom agent's pinned model is now threaded through
  its save path, so the choice sticks.

### Changed

- The workflow-run composer shows a **read-only model pill**; when a run falls back
  off a pulled model, a toast fires and the pill swaps to show the model actually
  in use.
- MCP / plugin controls moved from the chat bar to the session-start **Advanced**
  panel (hidden for the PTY substrate where they don't apply).
- The left rail now shows each session's **last-activity** time instead of its
  creation time.

### Fixed

- Reopening a session with a running flow now lands on the main **Flow** page
  instead of the last artifact. Newly *created* artifacts still take focus as
  before.
- Diff files now open as center-pane tabs in quick sessions (runless), matching
  the workflow-run behavior.

## [0.1.11] — 2026-06-30

### Added

- **One unified chat surface for quick sessions and workflow runs.** A quick
  session's chat now renders through the same component as a workflow run, so the
  two look and behave identically and can't drift apart. The interactive (PTY)
  experience — live terminal, resume recovery, the Ctrl+G composer toggle — is
  preserved within it.
- **Collapse/expand dock for quick sessions.** Quick sessions gain the same
  ▴▾ collapse/expand dock the run center pane uses, with its own persisted height,
  sitting over the chat/canvas.
- **Multiple terminals per run.** A run's terminal tab is now the always-present
  primary **Terminal**, and a **＋terminal** button spawns additional independent
  worktree shells (Terminal 2, Terminal 3, …) — each a closeable shell in the
  run's worktree. Added terminals persist across run switches.
- **Model picker on workflow launch.** The launch Configure step (and the
  "Browse all" workflow picker) now let you choose the model for a flow, defaulting
  to **Opus 4.8 · 1M**. The choice is pinned per run, so the flow's orchestrator
  agent spawns on the selected model. The one-click "Add a workflow" lane pins the
  same default.
- **Per-agent model pin.** A workflow agent's model is now editable in the Agent
  editor — pin **Opus**, **Sonnet**, or **Haiku**, or keep inheriting the run's
  model (the default). The gallery card and inspector show the pinned model.

### Changed

- **Sonnet 4.6 → Sonnet 5** in the model picker. Sonnet 5 is 1M-context native, so
  it appears as a single **Sonnet 5 · 1M** row instead of separate 250K / 1M rows.
- Run tabs are restyled to the pill format used by quick sessions, the **＋terminal**
  button sits flush next to the tabs, and the old **＋chat** add-panel button has been
  removed (quick sessions keep their single primary chat panel plus terminals).
- The chat dock can now be dragged all the way to full viewport height (the previous
  ~70%/560px resize cap is gone).

### Fixed

- Added terminals are no longer dropped when switching between runs. Previously the
  tabs reset on a run switch while their backend shells kept running — leaving an
  orphaned, unreachable shell (e.g. a dev server) alive until the run closed.

## [0.1.10] — 2026-06-29

### Added

- **Resume a lost interactive session.** When you reopen a quick session whose
  interactive (PTY) REPL was lost — typically after an app restart — Cyboflow now
  offers to **Resume previous session** or **Start fresh**. Choosing Resume
  reopens the prior conversation live the moment you click (no typing required):
  it re-spawns the REPL with a plain `claude --resume`, so the session continues
  on its existing transcript with no forked or rewound history across restarts.
  The structured token meter is restored for the resumed session.

### Fixed

- Typing directly into a lost or dead interactive terminal no longer raises an
  "unexpected error" modal — the keystroke is swallowed, and recovery happens
  through the composer (which respawns the REPL) rather than raw keystrokes.
- The resume prompt no longer re-appears in a loop after you choose Resume, and
  **Start fresh** is now authoritative — a previously-armed resume is disarmed and
  the declined session isn't re-offered when the panel remounts.
- The "restored context" hint now auto-clears after a few seconds instead of
  sticking indefinitely.

## [0.1.9] — 2026-06-27

### Added

- **Three-level bottom chat dock.** The center-pane chat dock now has three
  heights — a collapsed strip, a standard height, and full (which covers the
  central pane) — with clear up/down chevrons. The standard level keeps
  drag-to-resize.
- **Estimated session cost.** The running-session ticker and the whole-session
  token breakdown now show an estimated USD cost, computed from per-category
  token totals (input / output / cache-write / cache-read) at each model's list
  price. An unset model is priced at the quick-session default (Opus); an
  unrecognized model shows `—` rather than a mispriced figure.
- **Per-day tooltip on the Insights token chart.** Hovering any day on the
  token-use chart highlights that column and surfaces its full per-model
  breakdown (swatch · name · tokens) plus the day total. Every day is an easy
  hover target, including thin or empty slots.
- **Stage-bucketed dynamic-workflow progress.** A running dynamic workflow's
  agents are grouped by stage — an accordion when every agent maps cleanly to a
  declared phase, an honest flat list otherwise — in the run pane, and the
  review-queue card's ▸ glyph now expands that same live state inline.
- **Finding origin project.** Compounding backlog findings (both untriaged and
  ready-to-compound) now show a subtle tag with their origin project's name,
  since the backlog is cross-project until a selection locks it to one.

### Fixed

- Generated `cyboflow-*.md` agent and command files are kept out of the run diff
  — they're added to the worktree's local git exclude at install time — so they
  no longer appear as a dozen-plus untracked "changed files" or risk being
  committed. The user's own (non-`cyboflow-`) `.claude/agents` files are
  untouched.
- The session-meter **Cost** row no longer always shows `—`: it reads the model
  from the panel settings and prices an unset / `auto` model at the
  quick-session default, so a cost is always estimated.
- Interactive (PTY) quick-session chat tokens are now counted in the session
  meter, which previously showed zero usage for them.
- A completed dynamic workflow no longer reports a lingering "running" agent in
  its tally, stage glyphs, or rows.
- Primary CTA hover on the paper theme darkens to deep terracotta instead of
  inverting to a near-black slab that swallowed the button's own label.
- Workflow step cards no longer overlap the card below them; the row height now
  matches each card's true rendered height.

## [0.1.8] — 2026-06-27

### Added

- **Tabbed run center pane.** The run view's center pane is now tabbed — a **Flow**
  tab plus file and diff tabs opened from the File Explorer — sitting over a
  collapsible, resizable terminal dock. The right rail is likewise collapsible and
  width-adjustable.
- **Run artifacts.** Flows now produce typed artifacts — idea specs, decomposed-story
  grids, UI prototypes, and screenshots — that open as center-pane tabs and are listed
  in a new **Artifacts** panel so closed tabs can be reopened. A UI-prototype artifact
  renders live in a sandboxed iframe; reported screenshots show in a gallery. Artifacts
  are snapshotted to disk when committed (with a configurable commit location), and new
  `cyboflow_*` MCP tools let agents report them.
- **Diff / Split / Preview in file tabs.** Opening a file shows its diff with a header
  control to switch between a unified **Diff**, a side-by-side **Split**, and a
  **Preview** of the file (Markdown is rendered). An unchanged file shows its contents
  rather than a dead-end message.
- **Message a running flow.** You can now send a message to a running SDK flow — input
  is queued and drained into the agent.
- **Runtime permission mode.** Change an agent's permission mode while a run (or an
  open quick session) is live.

### Changed

- **The rail Diff tab is a changed-files list.** It lists each changed file with its
  +/- counts; clicking one opens it in the center pane (where Diff / Split / Preview
  live) instead of expanding an inline toggle.
- **The run diff shows committed work, not just untracked files.** The run-scoped diff
  is now computed against the run's launch point, so a flow that *commits* its work — a
  sprint/ship run merging parallel task lanes back to the branch — shows those changes.
  Previously only uncommitted/untracked files appeared.
- Decomposed-story tasks stack vertically and open a clickable task-detail modal, and a
  small idea that decomposes directly into tasks now surfaces those tasks.
- Planner/ship idea specs flow into the entity body, and the `cyboflow_create_task` /
  `cyboflow_update_task` MCP tools accept a `body`.

### Fixed

- **Sandbox-escape guard.** The live-canvas iframe rejects shell-origin / non-loopback
  URLs so an artifact preview can't navigate out of the sandbox.
- The split diff view no longer bleeds long lines across the divider, and the diff
  parser no longer emits phantom blank-context rows between hunks.
- A run/quick session with no active run shows its session diff again instead of a
  dead-end "No active run".
- The chat stays visible when a workflow completes, and the terminal dock no longer
  shows a duplicated label for quick sessions.
- Planner, sprint, and ship runs mint their baseline artifacts at run start, so a run
  whose agents never report a `done` step still produces its deliverables.

## [0.1.7] — 2026-06-26

### Added

- **Model picker in the composer.** Choose the model per session — it shows each
  model's version and context window, and offers both 250k and 1M-context Opus
  variants. Opus 4.8 is the default.
- **Opus-only fast mode.** A fast-mode toggle on the chat composer and the quick
  Configure page (faster Opus output, not a smaller model). The chosen model and
  fast-mode setting persist on the quick-session panel and carry through session
  creation.
- **End-of-workflow summary.** When a workflow finishes, a token-usage summary now
  renders as a card on the graph-paper canvas, with **Complete** and **Request
  changes** actions.
- **Whole-session token breakdown.** The session module shows a granular,
  whole-session accounting of token usage.

### Changed

- Composer pills are reordered to read model → permission → speed → checkpoint, and
  the redundant display-settings gear has been removed from the chat composer.

### Fixed

- **Telemetry now reports from distributed builds.** Credentials were read only from
  the build shell's environment, which a double-clicked packaged app never has — so
  Sentry and Aptabase silently did nothing in every shipped build. The client keys
  are now baked into the build, so error and usage reporting work as intended.
- The context meter no longer pegs at 1000/1000 on long quick-session turns, and
  quick-chat turn tokens are now counted in the session meter.
- Insights cards now surface cache tokens, so the token counts reconcile with the
  reported cost.
- Claude model aliases are pinned to their current snapshots, and fast mode defaults
  to off.

## [0.1.6] — 2026-06-25

### Fixed

- **Critical: the app could spawn endless copies of itself in an unkillable loop.**
  On a machine with no standalone `node` on its PATH, a packaged build fell back to
  launching its own app binary to run an internal helper — which booted another full
  app, and another, in an exponential loop (most visible on Intel installs without
  Node installed). The helper now runs in Node mode, so it never re-launches the app.
- The left rail now expands all projects by default, so an agent running under a
  project is never hidden behind a collapsed row — keeping the rail consistent with
  the review home's "Active agents" list. An explicit collapse still persists.

## [0.1.5] — 2026-06-25

### Fixed

- **Usage metrics now actually send.** Aptabase's SDK disables itself if initialized
  after the app is ready, and telemetry was being set up too late in boot — so usage
  events were silently dropped (error reporting via Sentry was unaffected). Telemetry
  is now initialized before the app `ready` event and usage events flow as intended.

### Changed

- **Telemetry is now toggleable on local (`pnpm`) builds.** The Settings flag (plus the
  presence of a credential) is the single control: packaged `.dmg` builds still default
  on (opt-out), while non-packaged builds default off but can be turned on for testing.
  Previously local builds could never enable telemetry regardless of the setting.
- Usage-metrics events from a non-packaged build are tagged `local` and surface in the
  telemetry provider's debug stream rather than the live/release view.
- **Less console and disk noise.** `INFO`-level logs are no longer persisted to disk
  unless verbose logging is enabled.
- The personalized user/settings footer was removed from the left rail, and the demo-mode
  toggle is now hidden in the stable build.
- Adding a project now gitignores the legacy `worktrees/` folder so stale worktrees from
  earlier versions don't show up as untracked changes.

## [0.1.4] — 2026-06-24

### Added

- **Anonymized, opt-out telemetry.** Sentry error reporting (packaged `.dmg` builds only —
  every payload scrubbed of source code, file paths, repo names, and prompts) and Aptabase
  usage metrics (release builds only, no identifiers). Both stay off under `pnpm dev`, are gated
  by a `local`/`dev`/`stable` environment resolved from the build, and can be turned off in
  **Settings → Privacy & Telemetry** (both default on). Credentials come from `SENTRY_DSN` /
  `APTABASE_APP_KEY`; without them the SDKs are silent no-ops.
- **Compounding findings triage.** The Insights findings surface is rebuilt into a triage
  inbox: review the findings surfaced from merged sessions, select the ones worth acting on,
  and seed a **Compound** run with exactly that selection in one loop.

### Fixed

- A shipped idea now retires to the terminal **Decomposed** stage the moment its plan is
  **approved** at the ship flow's `approve-plan` gate — not only at the later materialize or
  final-review steps. A ship run interrupted any time after approval no longer leaves its seed
  idea stranded in the planning column; its tasks carry the flow forward. (Existing stuck ideas
  are not retroactively retired.)
- The renderer no longer floods the devtools console with `sentry-ipc` scheme errors when error
  reporting is inactive (under `pnpm dev`, or in a packaged build that opted out or has no DSN).
  The renderer Sentry SDK now initializes only when the main process did.

## [0.1.3] — 2026-06-24

### Changed

- **Shared production database across installed apps.** Both packaged variants —
  Cyboflow and Cyboflow Dev — now read the local production database at `~/.cyboflow`.
  Dev is a separate *update channel*, not a separate dataset, so the two installed
  apps stay in lockstep on one machine. The non-packaged Electron dev server
  (`pnpm dev`) keeps its own isolated `~/.cyboflow_dev` so local development never
  mutates or forward-migrates the installed apps' database.

### Added

- **Schema-version gate.** Because both variants share one database and migrations
  are forward-only, an older build could previously run against a schema a newer
  build had already advanced — risking silent corruption. On launch, Cyboflow now
  stamps `PRAGMA user_version` with the highest migration it ships and, if the
  database is newer than the running build, shows a warning dialog
  (**Check for Updates** / **Open Anyway** / **Quit**) instead. *Check for Updates*
  opens Settings → Updates automatically.

### Fixed

- The **Download** / **Restart to update** buttons in Settings → Updates and the
  About dialog rendered with an invisible label in the paper theme — accent-colored
  text sat on the accent-colored fill. They now use the correct on-fill text token.

## [0.1.2] — 2026-06-23

First signed, notarized, and auto-updating macOS builds.

### Added

- **Signed + notarized macOS distribution.** Developer ID-signed, Apple-notarized
  builds with lean per-architecture DMGs (arm64 and x64) and in-app auto-update via
  `electron-updater` against `updates.cyboflow.com` (a combined `latest-mac.yml`
  serves both architectures).
- **Cyboflow Dev** — a side-by-side build variant (own appId, name, and update feed)
  for testing pre-release builds, in the style of VS Code Insiders.
- **Ship workflow** — a fourth built-in flow that combines Planner and Sprint in a
  single run (idea → epics → tasks → execute → integrate), launched from an idea picker.
- **Programmatic sprint execution** with a DAG-aware fan-out that runs independent
  tasks in parallel lanes, plus a monitor you can chat with at rest in the run's Chat pane.
- **Always-available Shell tab** in run views — a plain shell in the run's git worktree,
  keyed by run id.
- **Reopen timed-out or failed runs** directly from the composer.

### Fixed

- SDK agent sessions no longer hang in packaged builds — the native `claude` binary
  is unpacked from the asar archive so it can be spawned. The bundled MCP server is
  likewise packaged so `cyboflow_*` tools work in distributed builds.
- The `better-sqlite3` native module is rebuilt for the Electron ABI before packaging,
  fixing a `NODE_MODULE_VERSION` crash on launch.
- Flow-run context meter no longer pegs at 100%; a torn-down awaiting-input run now
  rests in `awaiting_review` instead of wedging.

---

Cyboflow is a fork of [Crystal](https://github.com/stravu/crystal) at tag `0.3.5` and has
diverged substantially in scope and architecture. The original upstream Crystal changelog is
preserved at [`docs/archive/CHANGELOG-crystal.md`](docs/archive/CHANGELOG-crystal.md) — note
that Cyboflow does **not** track the renamed successor product (Nimbalyst); see
[`docs/PROVENANCE.md`](docs/PROVENANCE.md).
