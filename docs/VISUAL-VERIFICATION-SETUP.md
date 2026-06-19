# Visual Verification Setup (cyboflow)

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

`pnpm dev`'s `concurrently` + `wait-on` parents can survive in `ps` after the
Electron renderer has exited — `pgrep -lf "electron"` then matches the
`concurrently` command line and falsely suggests a live window. A capture
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

`pnpm test` drives the full Electron app via `playwright._electron.launch()`.
This path is independent of the CDP attach and does not require `pnpm dev`
to be running; the test runner manages the Electron lifecycle itself. Useful
for headless CI flows where MCP isn't available.
