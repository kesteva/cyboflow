# Changelog

All notable changes to **Cyboflow** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.3.0] — 2026-09-03

### Added

- **Guided set-up replaces the old tour.** Onboarding is now seven modal steps followed by eight
  guided screens that run *inside* the real shell: add a project (existing / new / "not sure
  yet"), project home, a first idea composed into assistant proposals in the centre column, the
  assistant-rail introduction, choosing a first session (Planner / Ship / Quick), and a launching
  finale that lands on Human review. Callouts draw leader arrows to the actual controls they
  describe, and the "not sure yet" branch adopts whatever project you add from the Sidebar.
- **The Sidebar stays clickable during set-up.** Navigating away parks the tour instead of
  destroying it, and a "Resume setup" card brings it back where you left off.
- **The window remembers where you left it.** Size, position, and maximized state persist across
  quits, with a display-aware first run that opens sensibly on the current monitor and clamps a
  restore that no longer fits.
- An optional prompt-only `contextHint` on the assistant's `sendMessage` seam.

### Changed

- Rails open at usable 360px defaults, and rail widths persist as you drag them.
- The guided thread box grows with the window, and model ids stay on one line in the model step.
- Tour cards sit on the bare surface — no modal scrim behind them.

### Removed

- **The assistant's automatic daily recap.** It spent a real turn on every boot; the assistant now
  speaks when spoken to.
- The prompt-history rail inside the guided thread box.

### Fixed

- **Window bounds no longer drift on macOS.** `getNormalBounds` returns a stale cache after a
  maximize, so normal bounds are now tracked in JS and written atomically — a restore can't be
  corrupted by a crash mid-write.
- A maximized window is shown only once it has painted, keeping the title bar reachable instead of
  flashing an unpositioned frame.
- Claude-panel model fallbacks normalize to the Claude family rather than falling through to an
  unrelated provider's default.
- The day-gate canary no longer flakes: it baselines the stream at the moment the gate opens and
  polls for growth instead of sleeping a fixed interval.

## [0.2.11] — 2026-09-02

### Added

- **Beads as a fourth tracker provider.** A keyless CLI adapter for [beads](https://github.com/steveyegge/beads): a Detect wizard step that names the workspace folder instead of asking for a token, an "Initialize beads here" button that creates a missing workspace in place, and a Map step that offers sync / don't-sync per project. Writes go through a guarded-update contract (identity sandwich, fingerprint revisions, detect-after-write) with a reconciliation sweep, ledger, and recovery surfaces — remap, adopt-new-workspace, and a Dolt-HEAD guard (migration 129).
- **Human Review Queue redesign.** The landing page is rebuilt around a page-state machine and a recommended-actions engine, with a load-error state, a simplified Add-an-idea modal, and an idea-only New Task dialog. The Launch-flow card is hidden for established codebases.
- **Keyboard shortcuts.** Eight remappable global shortcuts (new session, rails, chat, queue, backlog) with a dedicated Shortcuts tab in Settings, plus a custom application menu. `Cmd+,` opens Settings, `Cmd+/` opens the Shortcuts tab, and `Cmd+]` also toggles the global-assistant rail on landing surfaces.
- **Claude Fable 5.1**, via an Agent SDK bump to 0.3.257.

### Changed

- The launch wizard presents workflows in a curated order (Ship first, Compound last).
- Reload moves to `Shift+Cmd+R` under the new application menu; `Alt+Cmd+R` stays pinned to force-reload, and remaps onto either reserved accelerator are rejected.
- Review-queue surfaces get a raised cream card treatment over a white canvas sheet, and their grids are intrinsically sized so narrow panes stack instead of overflowing.

### Fixed

- **Boot opens the landing page again.** The rail's auto-select pass navigated to the first project, which since the project-overview feature also opened the full Project page — and because the navigation store is not persisted, this ran at every launch, making it impossible to boot to LandingHome whenever any project existed. Selection no longer implies navigation.
- **The updater runs over Node's HTTP stack**, with `electron.net` as a fallback that now recovers by rebinding its poisoned session.
- Systemic environment conditions are no longer reported as app errors, and minidumps are dropped for deliberately terminated child processes.
- A too-old-CLI model rejection is treated as model-unavailable rather than a hard failure.

## [0.2.10] — 2026-08-31

### Added

- **Project overview page.** Clicking a project in the sidebar opens a per-project home: stage tiles that fill the card, a Select-tasks CTA that opens the sprint batch picker, and a dismissed-actions toggle (card-sized ghost tile, full-width well when all are dismissed) with per-action Restore.

### Changed

- **Session-record IPC → tRPC.** Fifteen session-record IPC handlers migrated to a `cyboflow.sessions` tRPC router, continuing the move off the legacy `ipcMain.handle` surface.
- Removed the prompt-history module.
- Monaco no longer bundles its TypeScript worker, trimming the renderer build; the unreachable editor-panel surface is marked `@cyboflow-hidden`.
- Documentation restructured around a shared `docs/AGENT-GUIDE.md` with thin per-runtime entry files and directory-scoped `AGENTS.md` rules.

### Fixed

- Runtime mix and the launch Runtime are now orthogonal dials.
- The IPC sender guard now also covers the `trpc-electron` channel.
- The CLI's own auth-expiry wordings are classified as systemic, and the opaque `other` class is split at the verify-request-failed seam.
- Pinned `playwright` and `@playwright/test` to one exact version, closing the lockfile split that silently broke the nightly E2E suite.
- The frontend Vite build gets a 4 GB heap ceiling.

## [0.2.9] — 2026-08-28

### Added

- **Workflow tuning levels.** The workflow editor becomes a two-page surface with a tuning dial (Quick / Standard / Thorough / Custom): a level picks the per-agent model tier across the whole flow, with per-level token estimates derived from `run_usage` medians, a three-way save prompt, and a per-run tuning-level override from the launch wizard. All six built-in flows are calibrated, and Standard pins the aligned-defaults models (migration 122).
- **Runtime mix.** A runtime-mix dial on the workflow editor and launch wizard lets a flow pair a primary and secondary provider per level, with the mix stamped onto runs and surfaced on the MCP compact row (migration 128).
- **Autonomous lane triage.** When a sprint/ship fan-out lane exhausts an automatic budget (inner-step loopbacks, code-review blocking, task-verify FAIL, or the visual merge gate), the run's monitor is consulted before the lane settles failed. It can rescue the lane — rewind it to an earlier inner step with supervisor guidance threaded into every later spawn — or, on concrete evidence that the task's acceptance criteria conflict with repo reality, autonomously adjust the task body first (through the TaskChangeRouter chokepoint) and then rescue. Bounded (one rescue per lane, four per run), fail-safe (any doubt settles the lane exactly as before), audited via a non-blocking review-queue finding, and disabled with `CYBOFLOW_DISABLE_LANE_TRIAGE=1`. A merge-gate rescue revives the already-settled lane row and re-verifies under a fresh attempt so a passing re-run supersedes the stale blocking finding.
- **Proactive monitor staging.** The monitor chat may now stage a confirm-gated action unprompted when the user describes a problem it is confident it can fix — still one action per reply, still behind the confirm/cancel gate — and its prompt tells it lane failures self-heal so it doesn't duplicate a rescue or promise manual intervention.
- **A/B variants scoped to a tuning level.** Variant surfaces (manager, pickers, A/B modal) and rotation experiments are scoped to a tuning level, with an experiment's baseline arm pinned to the variant arm's level (migration 126).
- **Image attachments in the run/monitor chat**, with a workflow run id accepted as an attachment owner.
- **Wizard redesign.** A redesigned Configure step, a base-branch picker in Advanced settings, per-level helper sentences, and the Mode row hidden when a provider has no CLI lane for the launch.
- **Per-project trust prompt** for repo-supplied permission allow rules, and the global assistant can now propose backlog creates.

### Changed

- **`raw_events` archiving.** Daily backups no longer copy `raw_events` into every snapshot; the table is archived into partitioned delta files by lineage, with shard validation and a restore path.
- Compound's three agent steps split across three agents; OMP and pi gain runtime-adapter prompt envelopes; Pi is gated behind Aria mode.
- The run/session status state machine is enforced at every write site, and the too-new-schema gate runs before any DB mutation.
- A session's branch shows in the sidebar hover tooltip (and a session whose worktree is gone no longer reports the project's branch).

### Security

- DOMPurify bumped 3.2.6 → 3.4.14, closing all open sanitizer advisories; the remaining prod-audit advisory backlog cleared via pnpm overrides + direct-dependency bumps.

## [0.2.8] — 2026-08-27

### Added

- **Backlog search + membership filters.** The backlog read model projects each entity's exact sprint/experiment memberships, and the backlog UI gains search, membership filters, and per-stage sorting.
- **Codex/OMP session summaries.** The session summarizer now covers Codex and OMP SDK sessions — armed from their SDK turn seams, with `summarySupported` derived from provider *and* substrate.
- **Agent finding + eval tools.** `cyboflow_get_eval` lets an agent read the jury's actual verdict; a settled session can now read and resolve its own findings; and `cyboflow_list_run_findings` is scoped to the session's runs rather than a single run id.
- **Native pi provider + OMP fleet runtime** (migration 122).
- **Workflow editor UX.** The workflow graph region scrolls independently, and a resolved model default threads into "run with modifications."
- **Native folder creation** in the project directory picker.

### Changed

- Three more IPC channel groups move to tRPC routers: `config:*` → `cyboflow.config`, worktree-file `file:*`/`git:*` → `cyboflow.workspaceFiles`, and session-git `sessions:*`/`git:*` → `cyboflow.sessionGit`.
- `streamParser`, `encodeCwd`, `modelContext`, and `agentProviderGuard` relocate under `shared/`, clearing the last relocatable standalone-invariant exemptions.
- Seam errors group by `[seam, errorClass, errorDigest]`, and the opaque `other` class is also split at the programmatic-step-failed seam.

### Fixed

- **Clean shutdown.** The shutdown teardown is actually awaited instead of racing Electron on quit, and terminal-panel PTYs are killed on quit (`destroyAllTerminals` previously had no callers).
- **Codex composer races.** Composer turns serialize to stop a 150 ms race that merged two sends, and PTY composer submit splits into a body write then a delayed Enter.
- The SDK gate honors the run's permission mode and no longer allow-lists a `glob` tool the pi provider doesn't have.
- Eval-jury and sprint-review findings addressed: stale membership filter, canvas backdrop, self-match child pruning, reorder-under-filter, and the workflow model-default rung.
- `dynamicWorkflows` tailer IO settles on a condition instead of a fixed turn count, removing a load-dependent test flake.

## [0.2.7] — 2026-08-25

### Added

- **Session triage board.** The flat quick-session board becomes triage groups: the summarizer returns a triage state `{state, waiting_on}` on new `session_summaries` columns (migration 121), rows get kick-free triage enrichment, and inline session rename now works on both the triage-board rows and the sidebar rail (with a click-away dismiss that no longer opens the session).
- **Per-model usage buckets.** The Claude card surfaces per-model weekly buckets and extra-usage credits, hiding the extra-usage row for an account with no credits.
- **Idle-since quiet clock.** Sessions persist `idle_since` at the busy→resting transition (migration 119, rows already at rest backfilled), and the quick-session board plus the sidebar activity clock read it instead of `updated_at`.
- **Renderer sandbox.** The renderer runs sandboxed via an esbuild-bundled preload, and Monaco is self-hosted so `cdn.jsdelivr.net` drops from the production CSP.
- **orch.sock hardening.** Per-run bearer tokens and owner-only permissions on the orchestrator socket.
- **Onboarding default-agent prompt.** When onboarding activates several agents, cyboflow asks which to default to; each provider names its structured runtime with a `default_runtime` step slug.
- **One MCP tool registry.** cyboflow's MCP tool declaration, validation, and dispatch now derive from a single registry (the OMP gate tool-list tripwire points at it).

### Changed

- The legacy `ipcMain.handle` surface is frozen — new IPC goes through tRPC (enforced by test).
- Duplicate migration prefixes are blocked and same-prefix files ordered deterministically; the orchestrator standalone-typecheck invariant is enforced mechanically.
- The opaque `other` errorClass is split with a shape + digest fingerprint.

### Fixed

- **SQLite timestamp parsing.** A family of unzoned-timestamp fixes: `parseTimestamp` (main and frontend) normalizes unzoned SQLite values and guards on the value's shape rather than the presence of a `T`; `formatDistanceToNow`, the wizard workflow row, and the sidebar activity clock all parse as UTC; and the polled Claude percentage survives a jittered reset timestamp.
- The migration runner is fail-closed with per-statement idempotence.
- Three substrate-dispatch bugs — stop, cleanup, and delete routing.
- One-shot SDK queries are restricted with `tools`, not `allowedTools`.
- A failed eager REPL spawn surfaces instead of a blank terminal.
- Blocking findings surface in the run's pending-input strip.
- Plugin install records fold into one gallery card per plugin id, with version and install stats kept as unbreakable units.
- OMP fleet supervisor runtime.
- CI: darwin-only `afterSign` cases are skipped off macOS and homed on the macOS runner; better-sqlite3 flips to the Electron ABI before the smoke tier; the unit-test job timeout rises 10 → 25 minutes; deterministic onboarding-scrim marker for the E2E boot helper.

## [0.2.6] — 2026-08-24

### Added

- **Idea home sessions.** A backlog idea card now has an **Open** entry that finds-or-creates a persistent, in-place SDK "home" session for that idea (`IdeaSessionCanvas` surface with external-artifact tabs, sidebar nesting under its idea, `home_idea_id` partial-unique so re-opening lands on the same session). Sprints can be launched from the canvas with `originIdeaId` lineage even when the idea isn't a seed, artifacts resolve per-idea, and the home session gets **Close** instead of Dismiss (migrations 113–115).
- **Tracker field write-back.** Entity priority widens to the full **P0–P6** range (migration 117); priority and category now sync **inbound** from the tracker, and content/archive changes sync **outbound** to it, with per-connection content/archive sync modes, mapping overlays, and new outbox kinds (migration 118). The wizard gains mapping tables and content/archive toggles. Outbound writes carry a lost-update guard (pre-send divergence check) and the removal ruling dialog discloses every linked provider and its real action (archive vs cancelled-state fallback).
- **Provider usage meters.** A provider-usage store captures Claude `rate_limit_event` at the SDK chokepoint and Codex account/rate-limit snapshots, exposes them over tRPC, and renders live Claude/Codex subscription-quota meters in the human review queue — each usage window counting down on its own row, with direct polling and stale-reading flags when a stream can't be wired.
- **Assistant long-term memory + flow advisor.** `cyboflow_history` gives the assistant durable recall over its own past transcripts, and a flow advisor recommends the right built-in flow and surfaces compound pressure.
- **Per-lane sprint rewind.** A confirm-gated monitor action (`rewind_lane_to_step`) un-sticks a *single* sprint lane — validated per-lane business logic, a `RunExecutor` mutator, and honoring in the fan-out inner loop — without disturbing its siblings or bumping the attempt cap.
- **Workflow variant archiving.** Variants can be archived behind a "Show archived" toggle (migration 116); creating a variant opens its editor immediately, a draft variant reads "Not in rotation", and a step's non-Claude model pin shows on the editor card.
- **Renderer security hardening.** A production CSP for the packaged renderer (build-time meta injection), centralized IPC-sender validation on every `ipcMain.handle` channel, a channel allowlist gating the generic preload invoke bridges, scheme-allowlisted `shell.openExternal`, realpath containment + an argv git allowlist in project file handlers, and migration of all shell-string git execution to argv-based `runGit`.

### Changed

- **E2E smoke tier is now a blocking PR gate** (and a release gate), joined by real-API canaries.
- Plain-language idea tile labels and captions.
- Cyboflow no longer honors `allow` rules from repo-controlled `.claude` settings, and no longer trusts repo-supplied allow rules over the repo-trust model.

### Fixed

- **OMP dispatch and turn accounting.** OMP subagent dispatch is allowed (the hook-scope premise having been tested false), the 30-minute turn ceiling no longer reports itself as a user interrupt, auto-mode bash may redirect to a plain path inside the working tree, and the `xd://` MCP dispatch wrapper is decided by the tool it targets.
- A fresh approval no longer reads as 45 minutes stale.
- A failed summarizer run now salvages a complete session summary instead of losing it.
- The updater no longer advertises an older feed version as an available update.
- Epics/stories `complete` stamps are downgraded when their underlying entities were deleted.
- The outbox drain stops when its connection is no longer active; an inbound unset-priority resolves against the canonical seed; overlay tokens are validated live.
- The `stale_socket` liveness rung was retired rather than wired.

## [0.2.5] — 2026-08-21

### Added

- **Multi-project tracker mapping.** A tracker connection can now map several tracker projects/spaces to their own cyboflow projects through sibling connection rows, each with an independent push target. The connected view gains a Project mappings card, and the wizard's Map step becomes a full mapping editor — linked rows with staged unlink, add-mapping mode that defers to the incumbent push target, and Connect surfaced only when a source is unconnected. Push-target identity is the full source scope and is enforced across runs (migration 110).
- **Pairwise evaluation judge panel.** The pairwise judge is now an ordered 3-slot panel that classifies slot failures and backfills degraded ballots instead of collapsing, with a `CodexPairwiseJudge` implementation alongside the Claude one.
- **Lane runbook bootstrap.** A verification lane derives, commits, and *proves* its own verification runbook — the harness exports the runbook's declared levers, and a committed config edit is always surfaced even when the bootstrap refuses (migrations 106–109).
- **PTY fan-out dynamic-workflow dispatch**, shipped on by default for interactive runs: a fan-out step dispatches its lanes as a dynamic workflow.
- **Configurable per-substrate sprint task cap.**
- **Daily `sessions.db` backups** with 7-day retention, pruning WAL sidecars alongside stale backups.
- **Main-process CPU/memory instrumentation** and a profiling harness.
- Pending-approval cards now say **who is asking**, and gate log lines are tagged with the agent that produced them.

### Changed

- **Multi-idea idea summaries collapse into one tab.** A planner run owning several ideas minted one idea-summary artifact per idea, all labelled "Idea summary", so the tab strip carried N indistinguishable tabs and each screen covered a single idea. A batch now mints one combined tab — following the same pattern the combined "Idea specs" tab already used — rendering a compact matrix: one row per idea against the five ledger components as columns, each row expanding to that idea's own deliverable links. Status is carried by shape as well as colour, with a legend. Single-idea runs are unchanged. Also fixes the per-idea "Idea spec" link, which pointed at a live tab for the batch's first idea only and read "not yet" for every other idea.

### Fixed

- **OMP approval reliability.** A human's answer now revives a run that was marked stuck while they were deciding (migration 111); a parked OMP verdict expires instead of standing for the whole run; humans get more than 25 seconds to answer; the OMP gate classifies `hub` calls by argument (no longer gating pure coordination), stops reading file bodies as remote targets, and stamps the approval's inbox row with the OMP substrate. A standing approval can no longer claim a blocked agent.
- **Eval jury no longer starves on large diffs** — more diff is inlined and the juror deadline scales with diff size, so the panel grades from the change instead of collapsing to a single ballot.
- **Dart recovery** — a create whose marker line the normalizer reflowed is recovered; the parent-scoped recovery arm is guarded against a trashed parent; a local body is aligned with what the create actually stored.
- Native crash reports are scrubbed of absolute paths and tagged by process provenance.
- The SDK path never auto-allows a tool call the user asked to be asked about, and stamps `origin { kind: 'human' }` on user turns.
- `tailwind-merge` no longer drops Button text colors at `size=md`; the idea-summary matrix scrolls instead of clipping when narrow.
- Escape closes only the top-most modal in a nested stack.
- A busy local entity defers one item instead of wedging inbound sync; a throttled subscription tears down when its source goes idle.
- **Auto-mode command classification hardening.** Auto mode no longer escalates on discards, bare environment assignments, or value substitutions; it resolves the real program past assignment, keyword, and wrapper prefixes and matches its hazard tables on the program basename.
- **Stuck-run and cross-run-deadlock detection.** A cross-run deadlock is stamped only on a real conflict; only approvals someone is actually blocked on count as stuck evidence; the stale clock no longer outruns the humans it measures; the stuck-run event bridge is now wired; and `orphan_pty` gets a real liveness probe instead of a silent no-op.
- **`raw_events` integrity.** A `tool_result` carrying image blocks (e.g. base64 screenshots) is now narrowed and kept instead of falling to `__unknown__` and being dropped from the transcript; superseded Codex snapshot notifications collapse to last-write-wins (migration 112); and missing `run_usage` rollups are materialized at boot.

> **Upgrade note.** Migration 112 runs a one-time cleanup on first launch that removes *superseded* Codex snapshot rows from `raw_events` — each is a cumulative snapshot whose successor already restates its full value, so no information is lost. It is idempotent; on a large history (~1.6 GB database) it clears tens of thousands of rows and adds roughly 20 seconds to that first boot. The database file itself will not shrink (the space returns to SQLite's freelist), but its growth stops.

## [0.2.4] — 2026-08-19

### Added

- **Idea component ledger**: ideas now carry a first-class component ledger (schema + shared types, a hybrid resolver, and a write chokepoint with a tRPC surface). Components render as chips with inline expand on backlog cards, an idea-summary artifact acts as the per-idea hub, and the planner reads the ledger to skip finished work and offer a design fork — launching a design session straight from the approve-idea fork, reopening any prototype in design mode, and stamping ledger components complete/incomplete as work moves. Body-change staleness is scoped to the section that moved. Migrations 101 and 102.
- **Dart tracker provider**: a third tracker-sync provider (`DartAdapter`) surfaced in the tracker integrations settings, filing sub-issues on the parent's dartboard, paginating off count, and guarding creates/client-key recovery with a container check. Adds an outbound-only "in-development" mapping target. Migration 105 (widen the tracker-provider CHECK to admit `dart`).
- **Mark complete**, for work that landed by a path the app never saw (the agent merged it in chat). Dismissing a session whose commits are already in the main branch now offers it instead of discarding the session outright, and a merge that finds nothing left to merge offers it in place of a "Merge failed" error. Creating a pull request no longer closes the session out on its own — it asks whether to mark it complete or keep it open.

### Changed

- Renamed the user-facing **"PTY" to "CLI"** across every runtime surface.
- **OMP polish**: `auto` now allows unless hazardous (matching Auto elsewhere), OMP models are offered in Settings rather than the Claude list, the model-override card opens under a non-Claude runtime, OMP inline questions are bridged (the ask-tool caveat is gone), and `cyboflow_set_idea_component` is admitted through the OMP gate.

### Fixed

- **Findings no longer die with the session that produced them.** Archiving a session dismissed every pending review item it had filed — and the merge and create-PR dialogs archive the session the moment the work is away, so a successful merge destroyed its own findings milliseconds later. Since the Insights compounding surface only offers findings from a session that landed its work, and landing the work was exactly what deleted them, the surface was unreachable by construction. The archive sweeps (live and the boot backfill) now keep the findings of a session whose work was delivered, and migration 106 restores the rows already lost. Gates are still dismissed: a permission prompt on an archived session can never be actioned.
- Stop the verify agent from inheriting the `auto` model sentinel; let the onboarding tour scroll on a short window; fix stuck pending-send reconciliation; compensate a mid-create design-session failure.

## [0.2.3] — 2026-08-15

### Added

- **Third agent provider (OMP / oh-my-pi)**: OMP runtimes are now picker-selectable and launchable as a first-tier workflow runtime. The provider ships a fail-closed cyboflow gating extension as its sole policy engine (safe-bash rung, Claude-canonical approval names), an RPC transport with an event projector and per-turn usage accounting, a PTY manager with an availability probe and MCP-config writer, and frontend surfaces (integrations card, onboarding, pickers, panel routing). Provider/runtime handling is now driven from one registry table. Migrations 103 (widen the provider/runtime CHECK constraints) and 104 (agent override provider/model).
- **Global launch defaults**: a global default launch model and agent runtime, configurable in Settings and resolved at every launch seam, plus a per-run-type overrides list and detail screen in Session settings and a "Save as default" CTA (with Undo) on the WorkflowPicker and the launch wizard.
- **Quick-session visual verification**: quick sessions can queue visual verifications over MCP (`cyboflow_get_verifications`), and a run's pending verifications are cancelled on merge / createPr / dismiss close-out.
- **Session action toast**: an actionable toast with pause-on-hover/focus and `role=status`; option-less escalation CTAs default to Open in session / Dismiss.
- A reconnect banner for paused tracker connections, and an observe-only tripwire for orphaned `cyboflowMcpServer` processes.

### Changed

- Split the Settings AI tab into Feature controls and Session settings groups, and drive wizard model selection through a single seeded-selection hook (per-key seed/touched isolation).
- Enforce runtime/model/substrate agreement at every launch and edit seam; coerce a quick session's model to its resolved runtime's family; surface Settings override failures and block unlaunchable combinations.

### Fixed

- **MCP orphan reaper**: `cyboflowMcpServer` now exits when its spawner dies rather than when the app does, with an `ELECTRON_RUN_AS_NODE` fork-bomb guard on both spawn paths and an observable, sound tripwire.
- **Tracker sync hardening**: unwedge inbound behind held pushes; abort adapter requests after 30s; outbox supersession; auth holds keep rows unsettled and repair a half-import first; discard stale reconcile responses after a mid-wizard retarget; log pushed ideas as pushes rather than mirrored sub-issues.
- Derive session file/diff stats from git rather than `execution_diffs`, and resolve the health panel's runbook status the way the gate does.

## [0.2.2] — 2026-08-13

### Added

- **In-app bug reporting**: a "Report a bug" button folded into the sidebar version block opens a structured reporting dialog backed by an isolated Sentry client and a validated `bugReport` IPC boundary (rate limiting, idempotency, and a minted event id so delivery can be tracked). The dialog previews the recorded errors it will attach, derives the bug's run from its session, tags session and run separately, and offers an optional log opt-in — with delivery confirmed from the transport's own send result rather than from `flush()`.
- **Retry button for dead terminals**: an interactive terminal that has died now shows a retry affordance, and a mid-session REPL death is surfaced instead of leaving a blank pane.

### Changed

- Bug-report dialog defaults to the expanded details panel with the log opt-in as a toggle, always shows the email field (no consent checkbox), and keeps the user's report, session, and log-consent choices across close and reopen.

### Fixed

- **sqlite ABI swap is now atomic** — the ABI guard writes a fresh file and renames it rather than rewriting a memory-mapped `.node` in place, fixing a `KERN_CODESIGN_ERROR` at `dlopen` from lazy page validation.
- **Orphaned worker reaping**: abandoned vitest pool workers are reaped from the main process, the orphan watchdog runs on its own thread instead of a stalled timer, the fork-cap governor sees and reaps orphaned workers, and pool workers whose root has died exit on their own.
- Report swallowed eager PTY spawn failures instead of showing a silent blank terminal.
- Stamp `activeProjectId` on the wizard's quick-session launch, so the quick surface (canvas, dock, tabs) renders on first run.
- Hold the flow turn open across the CLI's owed continuation, so a launch gate is no longer lost in the continuation window.
- Widen the gate-failure detector to MCP gates and cancellations.
- Stop billing one SDK failure as two Sentry issues.

## [0.2.1] — 2026-08-10

### Added

- **Launch flow (built-in)**: an interview-driven super-planner. A Launch run is grounded with a seed prompt collected in a pre-launch modal (migration 100), produces a `project-brief` artifact (migration 090/099), and mints one combined "Idea specs" artifact for multi-idea batches, with approve-ideas verdicts threaded into the post-gate programmatic steps.
- **Address-review stage**: the sprint and ship verify phases gain an address-review agent + step that acts on a run's own review findings. Adds a `cyboflow_list_run_findings` MCP tool (and `selectRunFindings`) for in-run triage, a findings contract for the programmatic execution plane, and a required full-suite re-run after address-review edits.
- **Quick-arm experiments**: launch a quick-session arm directly from the A/B launch modal — skipping the launcher and stamping a sentinel run — with a "Done" affordance in the comparison view and persisted quick-arm configs (migration 098) so a rerun replays the same matchup.
- **better-sqlite3 ABI guard + artifact cache**: `ensure-sqlite-abi.mjs <host|electron>` flips native ABI in ~0.3s (cached), and a read-only `--check` announces shared out-of-checkout artifacts.
- Verification instances are attested by launch token rather than app version or shared window title.

### Changed

- Bumped `@anthropic-ai/claude-agent-sdk` to 0.3.224.
- Merge / Create-PR is gated on a run's live settle state rather than `session.status`.

### Fixed

- Question gates survive human absence: the bridge timeout is removed and a Codex 300s tool-timeout + 30-minute bridge cap replace it.
- A red test tree is escalated as a blocking finding, and findings resolve only after the fix is verified and committed.
- Quick-arm hardening: a settle write-barrier refuses to settle an arm mid-turn, orphaned arm sessions are swept, and quick-arm configs are cross-field validated at the wire.
- Node process warnings and agent-authored SQL errors log at WARN, not ERROR.
- The verify window resolves by bundle id (not the ambiguous name "Electron") and `setAppTitle` no longer overwrites a verification instance's title.

## [0.2.0] — 2026-08-06

### Added

- **Verification setup flow (5th built-in flow)**: a `verify-setup` flow that establishes per-project verification. It ships a portable verification runbook contract — a content-hashed, machine-local schema (migration 089) — injected into the flow as a pinned runbook, with runbook MCP tools and a synchronous proof primitive so a step's attestation is authorized and stamped at the MCP boundary (`setup_proof`). A forbidden-command enqueue guard and engine-enforced proof block unproven advancing skips.
- **Verification capability model**: a failure taxonomy, a modality axis, and a hash-keyed capability ledger (migrations 088 → 095/096/097) drive an honest-failure verification scheduler and runner — modality-aware concurrency and drain priority, a conservative failure classifier, an agent-path preflight, and observe-only native-screen attestation channels.
- **Live host-capability probes**: the Verify Queue gains a health panel and a setup CTA that probe each host's capabilities once per panel open (not on a 15s poll), keyed to the runbook hash the engine actually evaluates. It surfaces which projects have verification, what each probe row means, and provisions Chromium on demand. The Peekaboo capture binary is now bundled inside the app, and all three capabilities are probed the same way — through the same binary the deployed driver uses — on every host.
- **Prepared-dependency mirror**: agent sessions get a dependency guard and a prepared-deps mirror that clones dependency dirs into snapshots (no write-through), with a 15-minute GC grace window.

### Fixed

- The Codex chat gate resolves through the chat-sentinel provider.
- Handled MCP query errors are no longer logged as "Unhandled", and archived-session event drops no longer log at ERROR.
- The git-exclude step is skipped quietly when the target is not a repo.
- The terminal-dock divider no longer sticks when the ceiling clamps its height.

## [0.1.36] — 2026-08-03

### Added

- **Design tier promotion (static → interactive)**: the design surface can promote a static prototype to a live interactive one. A `design.md` tier-promotion contract with a style-kit freshness check governs the transition, a "Make it interactive" control drives it, superseded static prototype tabs hide once a live interactive prototype exists (applied in `RunCenterPane` too), and the canvas auto-refreshes on each prototype revision.
- **Summary & History quick-session node**: extracted into its own node on the quick-session canvas, with its gate, structure, and accessibility contract locked by tests.
- **Post-approve planner launch choice**: after approving a design, launch the planner either in the same design session or in a new one.

### Fixed

- A same-session planner launch now inherits the design session's permission mode.
- Design well and add-workflow tints paint via the `rgb()` slash-alpha form so they render correctly across all palettes.

## [0.1.35] — 2026-08-01

### Added

- **Tracker sync (Linear & Plane)**: connect a Linear or Plane project and sync issues both ways. Remote issues import as ideas with a three-way merge; local ideas can be pushed as top-level issues; sync direction is gated independently per direction (manual mode defers rather than dropping). Includes a first-class tracker actor with attribution, `safeStorage`-backed secrets, a 6-step connect wizard with an explicit target-project step, a catalog that lists connections across all projects with project chips, and a connected view. Adapters for Linear (GraphQL, idempotent client-id creates) and Plane (REST, project-scoped ids). Schema in migrations 093–094.

### Fixed

- Shell `PATH` is resolved for SDK spawns so stdio MCP servers start reliably.
- The gate self-heal beacon carries bounded diagnostic tags.

### Build

- Pin an `app-builder-lib` patch (via pnpm `patchedDependencies`) so macOS 26's stricter `security set-key-partition-list` no longer breaks signed builds.

## [0.1.34] — 2026-07-30

### Added

- **Per-provider access toggles**: enable/disable each AI provider from Settings → Integrations and the onboarding Connect step, persisted to `AppConfig`. Provider access is enforced at the launch seams and at the SDK/CLI call level, every runtime picker is gated on it, and a provider-disabled send is explained with a link to Settings (the framing clears once the toggle returns).
- **Design comment-mode & feedback outbox**: a comment-mode capture channel (serializer injection, frozen-DOM sanitizer, nonce-CSP comment frame + inspector rail with element-anchored drafts) feeding a guarded design-feedback outbox pipeline — a `sendDesignBatch` tRPC seam, chokepoint primitives, boot recovery, the `cyboflow_design_ack_feedback` tool, and a revision-turn contract.
- **Ad-hoc session evals**: a `cyboflow_run_eval` MCP tool that publishes its verdict as an `eval-report` session artifact (rendered with the sprint-end ScoreSummary), plus an Efficiency & Economy dimension in the code-review eval rubric (v1.2).
- **Background sub-agent reports**: a background sub-agent's final report now renders in the chat.
- **Codex runtime for visual verification**: the visual-verification agent can run on Codex, with its runtime controls unlocked in the agent editors.
- First-party download counter at `dl.cyboflow.com` (Tier 1).

### Fixed

- Sub-agent narration no longer leaks into the parent chat; background tasks are attributed correctly, failures are never swallowed, and the `task_*` schemas are hardened.
- The codex-pty lane resolves the bundled Codex binary and probes CLI availability with the environment the spawn actually uses.
- Orch-socket handling: never unlink a socket another instance rebound, skip `close()` when the path was rebound, and report MCP health as failed when the socket path is lost.
- The opus alias is pinned to `claude-opus-5[1m]` to restore the 1M window, and both window forms of a pinned model are excluded from the picker catalog.
- A refused PTY resume is explained (with an offer to resume anyway) and a refused turn no longer leaves the chat stuck "thinking".
- The schema-version gate runs before binding shared state.
- R2 upload robustness: single-connection and optional fresh-connection (`R2_UPLOAD_NO_KEEPALIVE`) modes survive proxy resets.

## [0.1.33] — 2026-07-29

### Added

- **Design mode v1 — interactive prototype canvas**: an OOPIF-embedded live prototype with a surface-owned server lifecycle, terminated/respawn states, a frame watchdog, and a scripted-frame guard. Backed by an artifact-policy registry with an `interactive-prototype` artifact type, prototype-family draft binding, and a shared prototype-server IPC contract (preload bridge + type-parity). Schema in migrations 083–089.
- **Multi-chat panels**: choose the chat substrate at Add-chat creation time, with Claude/Codex panels routed by substrate override and isolated by their own panel id across substrates. Each Codex SDK chat panel gets its own resume thread; the Add-chat picker names the concrete session provider each override routes to.
- **Download analytics snapshots**: durable daily snapshots of R2 download analytics with a nightly CI job (accepts a `CLOUDFLARE_ANALYTICS_API` alias), since the upstream analytics window is not retained.
- **Onboarding refresh**: the app unwraps across onboarding's modal steps, wrapped in cream rather than terracotta, with a slower tile-peel so individual tiles read.
- Pairwise judge provenance is surfaced and attributed (with fallbacks), and the eval juror's failure reason is persisted and surfaced.

### Changed

- **Every multi-task idea gets an epic** — a fallback epic named after the idea — with the idea-needs-epic invariant enforced at the `TaskChangeRouter` chokepoint (and the unarchive-path bypass closed).
- Compound raises its bar for instruction-file edits.
- The full test gate is scoped to final verification rather than sprint lanes.

### Fixed

- Schema-parity check tolerates duplicate-column ALTERs, mirroring the migration runner's idempotent-ALTER self-heal (migration 088's revision "ensure" guard).
- Chat-panel provider and substrate resolve as independent axes; the whole `CreatePanelRequest` is forwarded across the `panels:create` seam.
- xterm/PTY listeners are disposed on panel and session close; PTY chat panels are isolated by their own id; mixed-provider retry sessions are guarded.
- A small back-off precedes the eval juror's transient retry.

## [0.1.32] — 2026-07-27

### Added

- **Design mode (v0.5)**: a fullscreen design surface for an idea, entered from the ui-prototype artifact header. A Design arm in the session wizard (idea-gated, SDK-substrate pinned) launches a design session with a clarify-first kickoff; a dedicated `design` MCP scope exposes a minimal toolset. Drafts round-trip through an artifact revision counter with compare-and-swap freshness, and an Approve control folds the approved design atomically, exits design mode, and prompts a planner handoff. Includes a live prototype iframe with an in-app "Open in browser", a working-indicator overlay, and a consent-gated style-kit step (repo-wide design-system discovery with tracked / untracked / skip options and backlog handoff). Schema in migrations 082–085.
- **Idle quick-session summaries**: a one-shot Haiku summary of a quick session, scheduled on an idle debounce and gated behind an Assistant setting. Surfaced as a summary card with expandable history on the quick-session canvas (opening with the session objective), served via `sessions:get-summary` with lazy catch-up. Backed by PTY transcript ingestion into `conversation_messages` and a liveness-gated in-flight probe (migrations 082/083).
- **Code-review blocking-finding escalation ladder**: a code-review verdict channel on the programmatic plane, a mint-time audience axis for review items (migration 085), and a per-lane failure summary on the terminal sprint gate.

### Changed

- Loopback-eligible defects are guarded against being filed as findings, with a fail-safe code-review loopback on a trailer-less turn; `audience=machine` findings are excluded from human Insights and metrics, and the under-cap visual loopback finding is audience-tagged plane-aware.

### Fixed

- Sprint-batch sessions inherit ALL idea artifacts, not just the dominant idea's.
- Blank assistant bubble: LiveTail is gated on visible content rather than block existence.

## [0.1.31] — 2026-07-24

### Added

- **Hybrid Claude model picker**: the pinned four models plus a dynamic "Other models" group surfaced from the SDK, with labels disambiguated by the concrete id. Available in the launch picker as well. Opus 5 replaces Opus 4.8 as the default in the picker.
- **Verification queue upgrade**: the queue shows in-flight work first, adds session pills and a per-item detail dialog, and verification requests are attributed to their origin session.
- **Interrupt & send** for a running quick session: a button beside Queue that aborts the in-flight turn and sends immediately. `panels:continue` accepts an interrupt flag (abort in-flight turn, send now) and otherwise queues mid-turn sends instead of mutex-starving.
- Quick-session chat renders `AskUserQuestion` gates and lets the composer answer them.
- Boot-time warning when the app is running as an emulated wrong-arch build (x64 under Rosetta on Apple Silicon).

### Changed

- Vitest fork pools are governed for agent-spawned gate runs, preventing CPU oversubscription when tests run under an orchestrating agent.
- The dead afterSign JAR-strip step is retired and converted to a post-sign JAR tripwire.

### Fixed

- Interrupt/stop correctness: interrupt aborts the in-flight turn before taking the continue lock; `sessions:stop` settles pending gates before killing panels; the composer Stop button follows the authoritative running status (not the working spinner), shows during SDK generation, and stays visible beside the interrupt trio.
- Codex quick-session parity: queue + interrupt parity (dropped the hard-reject), and a queued Codex message is delivered at the rest boundary rather than dropped.
- Question-answer sends save and forward their attachments (no silent drop); the client pending-id is threaded through the `panels:continue` queue fallback.
- Panel status follows the live store instead of a frozen `SessionContext` snapshot, and a main-repo session reads its live status from `activeMainRepoSession`.
- Deliberate step skips and CLI terminations are no longer reported as programmatic step / exit failures.
- The quick-session board stays mounted after opening an idle session.

## [0.1.30] — 2026-07-23

### Added

- **Task-scoped visual verification agent**: a redesigned verification flow where `task-verify` composes a visual-verification task consumed by a central verification agent. Includes a `VerificationAgentRunner` with scheduler dispatch, an agentless visual-verify step, a bundled headless-browser driver CLI with a lane-consistent snapshot provisioner, CDP-attach verification targets (Electron and other web-view apps), a typed step-output channel (`spawnCliProcess` resolves the turn's final result text), `VerificationTaskV1` / `ReportV1` types + validators, a delivery outbox with atomic artifact merge + finding supersession, verifier transcripts captured onto the screenshots artifact, and frontend surfaces (editor, report table, queue, baseline retirement). Migration 078.
- **Assistant context-retention**: a context-retention picker in a new top-level Assistant settings tab (`clear-daily` default), applied at the local-day boundary, plus a persisted agent-thread last-turn timestamp (migration 080) and a per-folder toggle to exclude project folders from the assistant's file access.
- **Workflow archiving**: a `workflows.archived_at` soft-archive seam (registry + tRPC) with Archive/Unarchive actions and a "Show archived" toggle in the workflow gallery (migration 079).
- Entity `category` on the Epic detail editor (alongside priority), reusing the canonical `CATEGORY_LABEL` map.
- Multi-model run cost computed from the rate card by summing the per-model breakdown.
- **Auto-handover to a full agent** when you chat at a programmatic run's final human gate (migration 081): the handover agent adopts the conversation, `ChatInput` exits monitor mode immediately on a handed-over send response, and `setPendingNudge` can hide a seeded turn from the transcript. Hardened per adversarial review.

### Changed

- Retired the Crystal checkpoint / structured commit-mode machinery, including the commit-mode pill and its components in the quick-session UI.
- Interrupted-run handling: resume restart-orphaned orchestrated runs and tag the unresumable as `outcome='interrupted'`; Insights break out interrupted runs and exclude restart noise from error/success rates.
- Verification ownership is controller-owned on programmatic runs: MCP `cyboflow_request_verification` / `request_verification` are rejected on programmatic step turns, the controller adopts a pre-fired lane verification request, and task-verify turns relay the verdict as text rather than firing the request.
- Session ordering simplified to a single `displayOrder` source (dropped the never-cleared `sessionOrderOverrides`), with a deterministic sort tiebreaker.

### Fixed

- Eval jury robustness: strict-ify the Codex juror output schema so it stops 400ing every eval, give jurors headroom (300s deadline, 20-turn budget) under host contention, stop retrying deterministic judge failures (timeout/max-turns), and fix the retry latch + canonical-row selection.
- Run cost/model resolution: fall back to reported cost for unresolved-model runs instead of an em dash, and ignore the `unknown` sentinel / blank model ids when folding model cardinality.
- Quick sessions: never boot-resume `__quick__` sentinels and resolve orphaned permission review items.
- Surface a restart-required updater error after a network-service crash.
- The delivery outbox keeps failed deliveries pending with an in-process retry sweep; snapshots always record on a recorded sha (dropped the whole-tree dirty check).
- The backlog rail badge counts board-visible items, not raw non-done rows; preserve entity category when cloning experiment seed tasks into arms.

## [0.1.29] — 2026-07-22

### Added

- **In-artifact feedback** (IDEA-033): highlight text in an artifact, attach a comment, and send it to a host-driven revision agent — backed by a `FeedbackRouter` write chokepoint, quote-based DOM anchor utilities, gate chips, and byte-preserving arch-section splicing (`replaceArchDesignSection`). Migration 077 + shared types.
- Computed run cost: a setting to recompute run summary cost from resolved run-usage models.

### Changed

- Dropped the hidden per-turn `/context` probe turn and deferred the `@anthropic-ai/claude-agent-sdk` parse off the boot path (faster startup, fewer wasted turns).
- Assistant rail polish: centered suggestion chips with the first renamed to "Status update", composer model chip removed with the send button tracking the textarea height, the human's turn persisted in the transcript, a vertically centered header row, and the auto-digest throttled to once per calendar day (persisted across restarts).

### Fixed

- Quick sessions: revive the parked `__quick__` chat sentinel on reuse so resumed quick sessions keep MCP access, drop an explicitly-completed run from the left rail (migration 075), echo flow-run chat sends into the transcript on the Claude SDK path, and show minutes-only quiet labels (refresh coarsened to 30s).
- Lifecycle cleanup: reap artifacts for retired entities, dismiss review items for archived sessions, reap leaked Codex brokers in worktrees that still exist, and stop presentation-only writes from bumping `sessions.updated_at`.
- Daily-recap digest: calendar-day cap, rollback on failure, and a frontend retry gate.
- Markdown fence-grammar hardening for arch-section parsing: shared CommonMark-paired fence grammar, and reject backtick-fence openers that carry backticks in the info string.

## [0.1.28] — 2026-07-21

### Added

- **Cyboflow assistant** — a global agent rail on the landing-family views: a thread view with an auto-growing composer, suggestion chips, and a digest trigger, backed by `AgentThreadService` + a dedicated events sink, an `agentThread` tRPC router with transcript projection, and a global-agent system prompt threaded into every spawn (migration 074).
- Assistant proposal flow: proposal action cards in the rail and a proposal executor with a CAS state machine, launch saga, and boot reconciliation; resolved proposal cards clear after a transient notification window.
- Read-only MCP surface for the assistant: a global-agent scope gate + read-tool family with `cyboflow_propose_action`, a `cyboflow_db_query` tool, a `cyboflow_reference` product deep-dive, and a product-overview tool — plus a folder-access setting for extra read-scope folders.
- Assistant settings section: model override for the global assistant and a zero-token kill switch.
- Planner approve-designs batch gate: an `approve-designs` gate with per-idea architecture-design identity (migration 073), an ApproveDesigns artifact renderer with per-idea arch-design tabs, and joint approve-ideas/approve-designs gates delivered via auto-created surfaces.

### Changed

- Renamed the agent rail to "cyboflow assistant" and dropped the subtitle / the "Kick off top tasks" suggestion chip.
- `raw_events` noise reduction: stop persisting noise classes at the write path, and migration 072 prunes existing noise with a conditional post-migration `VACUUM`.

### Fixed

- Provider-aware model selection — no cross-provider model bleed: per-agent Claude/Codex model pins propagate on programmatic runs, the mixed-provider guard is scoped to reachable agents (exempting the quick sentinel and covering `agent_overrides` Codex pins), the agent model picker is gated on a pinned runtime, the agent card chip reflects the pinned Codex runtime/model, and legacy model-without-runtime pins are made coherent in both editor and server.
- Exempt agent-thread spawn ids from Crystal session validation; open-session navigation now carries the server-resolved `projectId`.
- The empty assistant composer rests at single-line height.

## [0.1.27] — 2026-07-20

### Added

- Reasoning-effort control across the app (IDEA-029): a picker in the session-start wizard and quick-session composer, per-agent effort in the workflow step inspector, and a provider-aware effort vocabulary threaded through Claude and Codex spawns (SDK + interactive). Persisted per session and re-applied on launch/respawn, including on auto/`/context` turns.
- Epic-grouped task lists in the batch and A/B seed-task pickers — collapsible epic groups with tri-state selection via a shared `EpicGroupedTaskList`.
- Native static-mockup `ui-prototype` artifacts and the IDEA-039 artifact lifecycle: producer contract renders to a self-contained static HTML mockup.
- Subagent usage folded into Insights — subagent transcript usage is captured, deduplicated, and persisted.
- Improved run monitoring and eval-recovery flows.

### Changed

- Major main-process performance pass: WAL pragmas and narrowed SQLite hot-poll queries, git diff/history/status exec paths converted to async, serialized and async journal/transcript tailing, first-paint restructure with dev-gated log forwarding, bounded PTY and per-session log buffers, and a cached MCP-config parse fast-path.
- Renderer CPU pass: coalesced stream events with a capped buffer, identity-preserving transcript merge with memoized markdown rows, request-generation fences against stale refetches, visibility-gated polling/timers, and an isolated workflow-canvas animation leaf.
- Eval judge concurrency split into normal (3) vs A/B (1) lanes and capped app-wide; A/B comparison diffs fetched once instead of every 10s poll.

### Fixed

- File-watching EMFILE pressure: `gitFileWatcher` no longer recursively watches `node_modules`/`.git`.
- Reaped leaked `openai-codex` plugin broker daemons and hardened warm SDK/Codex session lifecycle (warm session busted when a run's effective agents change; queued-input drain treats parked warm sessions as idle).
- Codex replies no longer disappear when a turn produces no stream deltas.
- Artifact durability and CSP hardening: `srcdoc` frames confined from off-document navigation, `artifacts:load-html` read path hardened, render selected by payload shape.
- Correctness fixes surfaced by the audits: wire all tRPC router deps before creating the window, baseline structured-commit detection on the pre-turn HEAD, claim terminal workflow transitions before async drains, keep tailer partial buffers alive through the terminal drain, and bounded kill grace with macOS-safe descendant enumeration on terminal close.

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
