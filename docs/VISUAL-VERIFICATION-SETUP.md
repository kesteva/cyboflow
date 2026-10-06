# Visual Verification Setup (cyboflow)

## Agent engine (current)

cyboflow's **built-in** visual-verification feature — the `visual-verify` lane
step that checks a Sprint/Ship task's UI deliverable — runs on a
**verification AGENT** (see
`docs/proposals/verification-agent-redesign.md`): `task-verify` composes a
`VerificationTaskV1` (build/serve/behaviors), the central
`VerificationScheduler` deploys the workflow-defined `visual-verify` Claude
agent into a snapshot worktree, and the agent builds, serves, drives the UI via
a bundled driver CLI, and judges its own screenshots. It is the only engine:
the earlier capture-backend + VLM-judge engine (and its `.cyboflow/verify.json`
deliverable recipes, dev/static server spawners and golden baselines) was
deleted. `.cyboflow/verify.json` now carries only the project's `enabled` /
`defaultType` rungs of the enablement ladder; a run stamped by the old engine
has its requests settled as `skipped`.

This is a **separate concern** from the rest of this document below, which
covers verifying **cyboflow's own** renderer while an agent works ON this
codebase (dogfooding) via the Playwright-MCP CDP attach and the `visual_macos`
Peekaboo fallback — that guidance is engine-independent and remains fully
current regardless of the section above.

(Separately, cyboflow the *product* now also ships a `mobile` modality —
iOS Simulator, on `xcodebuild`/`xcrun simctl` — for verifying a project's own
iOS app; that is the agent engine's concern, not this dogfooding CDP/Peekaboo
path. Its host prerequisites are below; the design is in
`docs/proposals/mobile-verification-tier.md` and Part B of
`docs/proposals/runbook-optional-verification.md`.)

## Runbook-optional verification (explore mode)

A verification request no longer needs a proven runbook
(`docs/proposals/runbook-optional-verification.md`). The runbook decides *how*
the request runs:

- **Pinned** — a proven runbook exists for the modality (or the lane carries a
  learned pin, below). The harness replaces the task's build, serve/app and
  attestation with the proven recipe and runs it exactly.
- **Explore** — no proven runbook. `web` and `mobile` always explore; `cdp-app`
  explores only when a registered runbook record (any status) names a
  `dataDirEnv` lever; `native-screen` never does and is still skipped. The
  composed build/serve/app are hints the agent may adapt. A web or cdp-app run
  reaches `passed` only when the composed `serve.cmd` ran verbatim through the
  driver and the harness bound the port to it; any other stand-up caps at
  `low_confidence`. A mobile run passes on a verified `bundle-identity`.
  `unverifiable` lands as `low_confidence` plus a finding and never loops the
  implementer; `wrong_environment` re-dispatches the request once under the
  modality the agent says it needs.
- **Learned runbooks.** A passing explore run may report the commands that
  stood the deliverable up. The harness validates them and stores an unproven
  draft of origin `learned` (the first one wins, and a committed
  `.cyboflow/verify-runbook.json` entry takes precedence). A web or cdp-app
  pass that rested on the serve binding alone learns an entry with
  `"attestation": {"kind": "serve-binding"}`, so a project whose app renders no
  attestation nonce still learns and gets pinned; a pinned `serve-binding`
  entry verifies exactly when the port is bound to its verbatim `serve.cmd`.
  An explore **web** request also gets a harness-injected nonce marker: before
  the agent starts, the harness adds
  `<meta name="cyboflow-verify-nonce" data-verify-nonce=…>` to the SNAPSHOT's
  entry HTML (`index.html`, `public/index.html`, `src/index.html` or
  `src/app.html`; never the repo). When the page in the driver's browser
  carries it and the serve binding holds, the pass rests on `dom-marker`
  `meta[name="cyboflow-verify-nonce"]` and learns that channel, and a pinned
  request from such a runbook injects the marker again. Server-rendered apps
  (Next, Remix, Nuxt, …), a monorepo package below the root, and ambiguous
  layouts are skipped, and so is a marker that never showed up: all of them
  fall back to the serve-binding verdict. The lane's next
  request runs that draft as a learned pin: a pass marks it proven, a failed
  stand-up discards it and re-runs the request in explore. Both events file a
  non-blocking finding naming the commands.
- **Kill switch.** `"visualVerify": { "requireProvenRunbook": true }` in the
  data dir's `config.json` (`~/.cyboflow/config.json` for the stable build), or
  launching with `CYBOFLOW_VERIFY_REQUIRE_RUNBOOK=1`, restores the old
  behaviour: a request with no proven runbook is skipped and nothing is
  learned. `visualVerify.exploreDeadlineFloorMs` (default 15 min) is the
  minimum deadline of an explore request.

## Mobile (iOS) verification: host prerequisites

Build, install, launch and `bundle-identity` run on `xcodebuild` +
`xcrun simctl` and need only Xcode. **Driving** the app (tap, type, swipe) uses
the engine `visualVerify.mobileDriveEngine` picks in `config.json`:

- `auto` (default) — Xcode DeviceInteraction when its probe is available or
  inconclusive, else Maestro when it resolves with a device-pin flag, else
  none.
- `xcode` / `maestro` / `none` — pin one. `none` is observe-only: behaviours
  that need driving come back `not_testable`.

A chosen engine that fails degrades to the next rung instead of skipping the
request; the report's provenance records the engine requested, the engine used
and why it degraded.

**Xcode DeviceInteraction** is checked by the `xcode-mcp` row of the Verify
Queue's health panel; each failing check names its fix:

1. **Xcode 27 or later** as the active developer directory
   (`sudo xcode-select -s /Applications/Xcode.app`), so `xcrun --find
   mcpbridge` succeeds.
2. **An iOS 27+ simulator runtime**: `xcodebuild -downloadPlatform iOS`.
   DeviceInteraction does not work on older runtimes. Without one, the request
   leases a simulator on the default runtime and drives through Maestro or not
   at all.
3. **Headless mode**: `sudo xcrun mcp-server enable`. Check it with
   `xcrun mcp-server status --format json` (`permission.enabled`).
4. **Approval.** Xcode approves the binary that spawns `xcrun mcpbridge`,
   which is the Cyboflow app itself. A dev build runs an unsigned Electron, so
   its grant lasts 24 hours and likely resets on each Electron upgrade; a
   signed, packaged build may be granted durably. Click **Approve Xcode
   access** on the row while you are at the Mac. Cyboflow asks Xcode to open a
   scaffold project under `<data dir>/xcode-approval/`, which raises Xcode's
   own approval prompt (the button reads "Waiting for Xcode…" until you
   answer). The panel also shows the command that grants it from a terminal,
   `sudo xcrun mcp-server approve <id> --for-24-hours`, and, for a signed build
   only and behind an explicit click, the durable `--always` form. Cyboflow
   never runs either command and never uses
   `--unsafe-always-allow-all-agents`. Read the disclosure it shows: approving
   Cyboflow approves every agent it hosts, Claude and Codex alike, for the
   grant window, across all of Xcode's tools on every folder you have
   permitted. The row goes back to "Approve Xcode access" shortly before a
   grant expires.

**Maestro** needs a JDK. The login shell's `/usr/bin/java` is only a macOS
stub, so the harness resolves `JAVA_HOME` itself — a valid `JAVA_HOME` already
set, then `/usr/libexec/java_home`, then the newest Homebrew `openjdk*` — and
exports it to Maestro and the agent. If none is found, install one
(`brew install openjdk@17`).

## Dogfooding: verifying cyboflow's own renderer

This project is an Electron app. The Vite renderer at `http://localhost:4521`
depends on `preload`-injected `electronTRPC` and cannot bootstrap standalone,
so a Playwright MCP that spawns its own Chromium would return an empty page
(HTTP 200, DOM empty). cyboflow works around this by having Playwright MCP
**attach to the real Electron renderer over CDP** instead of launching its own
browser.

## How the Playwright path works

1. `pnpm dev` (alias for `pnpm electron-dev`) launches Electron with
   `--remote-debugging-port=9223` — see `package.json` `electron-dev` script.
   The renderer is exposed as a Chrome DevTools Protocol target on
   `http://localhost:9223` with `electronTRPC` already attached via preload.
2. Project-scoped `.mcp.json` overrides the user-global Playwright MCP
   registration to launch with `--cdp-endpoint http://localhost:9223`. The MCP
   server's `browser_navigate` / `browser_snapshot` etc. then drive the real
   renderer instead of a standalone Chromium.

**Required precondition:** `pnpm dev` must be running before any
`mcp__playwright__*` call. If port 9223 isn't listening, the MCP server
fails the `connectOverCDP` and returns navigation errors — not a code
regression; just start the dev server.

## Peekaboo (visual_macos) — fallback path

When `pnpm dev` isn't running, or when capturing system UI outside the
Electron window, `visual_macos` via Peekaboo MCP captures the Cyboflow
window directly.

### macOS Permissions Required for Peekaboo

Two separate macOS grants must be enabled for the Claude Code host process
(typically Warp on this machine):

1. **Screen Recording** — enables window screenshots.
   System Settings > Privacy & Security > Screen Recording.
2. **Accessibility** — enables UI events (click, type, key press, menu).
   System Settings > Privacy & Security > Accessibility.

Screen Recording alone is NOT sufficient: capture works but interaction is
silently blocked. If `visual_macos` returns screenshots but clicks/keystrokes
do nothing, check Accessibility first. After granting either permission, quit
and relaunch the host process.

### Pre-flight: confirm the Electron renderer is actually running

`pnpm dev`'s `concurrently` + `node scripts/dev-electron.mjs` parents can survive
in `ps` after the Electron renderer has exited — `pgrep -lf "electron"` then
matches those command lines and falsely suggests a live window. A capture
attempt against a windowless run fails with `-3811` audio/video errors or
returns 0 windows.

Before any `mcp__peekaboo__image` call, confirm the renderer is up:

1. CDP port is listening (only true when the Electron renderer is alive):
   ```bash
   lsof -i :9223     # must show an `electron` LISTEN entry
   ```
2. Peekaboo sees a Cyboflow window:
   ```
   mcp__peekaboo__list(application_windows, app="Electron")
   # or app="Cyboflow" — window count must be ≥ 1
   ```

If either check fails, restart `pnpm dev` and wait for the renderer to load
before retrying. (FIND-SPRINT-038-1; reproduces SPRINT-029/031 verifier patterns.)

### Troubleshooting: "audio/video capture failure" despite grants showing clean

If `mcp__peekaboo__image` against the Cyboflow Electron window returns
`Failed to start stream due to audio/video capture failure` while
`mcp__peekaboo__probe` reports both grants granted, the **Electron dev
binary itself** needs its own Screen Recording entry — separate from the
Peekaboo CLI binary. Locate it with `find node_modules/.pnpm -name 'Electron.app' -maxdepth 6`,
grant Screen Recording in System Settings, and relaunch `pnpm dev`. Blocked
two consecutive sprints (FIND-SPRINT-034-3).

### Troubleshooting: confirm which process holds each TCC grant

When `mcp__peekaboo__image` fails with `"The user declined TCCs for application,
window, display capture"` even though `mcp__peekaboo__probe` / `server_status`
reports grants present, the grants are likely held by the wrong binary (e.g.
Warp instead of the Node subprocess that issues the CGDisplay / CGWindow
capture calls). One-shot diagnostic:

```bash
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "SELECT client, auth_value, last_modified FROM access WHERE service IN ('kTCCServiceScreenCapture','kTCCServiceAccessibility') ORDER BY service, client;"
```

Look for the MCP host binary path (e.g. `/usr/local/bin/node` or the Claude
Code CLI) in the `client` column with `auth_value=2`. If missing, grant Screen
Recording and Accessibility to that binary in System Settings → Privacy &
Security, then restart `pnpm dev`. Recurring failure across SPRINT-031..SPRINT-039
(TASK-655, TASK-715, TASK-752, TASK-756, TASK-761).

## Mobile (visual_mobile) — not applicable

cyboflow is desktop-only. `verification.visual_mobile=false`.

## Manual Playwright E2E (independent of MCP)

`pnpm test:e2e` drives the **built Electron bundle** via Playwright's
`_electron.launch()` (fixture: `tests/helpers/electronApp.ts`) — it launches
the compiled app directly and attaches Playwright to the real Electron window.
There is no `webServer`, `baseURL`, or `http://localhost:4521` dev server
involved. Two config tiers exist: `playwright.config.ts` (full suite,
`workers: 1`, all specs) and `playwright.ci.minimal.config.ts` (smoke:
health-check + smoke + permissions).

It is still **not** the headless code-change AC gate — Electron windows need a
real display to appear on screen. For headless code-change validation use
`pnpm test:unit`; for visual verification use `visual_macos` via Peekaboo
against a running `pnpm dev` (see above).

The `pretest:e2e` hook rebuilds `better-sqlite3` for the Electron ABI, which the
next `pnpm test:unit` / `pnpm test:integration` / `pnpm dev` restores automatically —
see `docs/ARCHITECTURE.md` → "The better-sqlite3 ABI ping-pong" for the full
contract, and "Build & Run" for the e2e contract.
