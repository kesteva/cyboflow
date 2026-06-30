# Changelog

All notable changes to **Cyboflow** are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
