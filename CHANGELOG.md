# Changelog

All notable changes to **Cyboflow** are documented in this file.

Cyboflow is a fork of [Crystal](https://github.com/stravu/crystal) at tag `0.3.5` and has
diverged substantially in scope and architecture. The original upstream Crystal changelog is
preserved at [`docs/archive/CHANGELOG-crystal.md`](docs/archive/CHANGELOG-crystal.md) — note
that Cyboflow does **not** track the renamed successor product (Nimbalyst); see
[`docs/PROVENANCE.md`](docs/PROVENANCE.md).

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
