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
3. SoloFlow's `shadow-verifier` honors `verification.visual_web=true` (in
   `.soloflow/config.json`) and routes Electron flows through
   `mcp__playwright__*` automatically.

**Required precondition:** `pnpm dev` must be running before any
`mcp__playwright__*` call. If port 9223 isn't listening, the MCP server
fails the `connectOverCDP` and returns navigation errors. The verifier
classifies this as `skipped_unable` — not a code regression; just start the
dev server.

## Peekaboo (visual_macos) — fallback path

When `pnpm dev` isn't running, or when capturing system UI outside the
Electron window, `visual_macos` via Peekaboo MCP captures the Cyboflow
window directly. `verification.visual_macos=true` is set in
`.soloflow/config.json`, so this path is also active.

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

### Troubleshooting: "audio/video capture failure" despite grants showing clean

If `mcp__peekaboo__image` against the Cyboflow Electron window returns
`Failed to start stream due to audio/video capture failure` while
`mcp__peekaboo__probe` reports both grants granted, the **Electron dev
binary itself** needs its own Screen Recording entry — separate from the
Peekaboo CLI binary. Locate it with `find node_modules/.pnpm -name 'Electron.app' -maxdepth 6`,
grant Screen Recording in System Settings, and relaunch `pnpm dev`. Blocked
two consecutive sprints (FIND-SPRINT-034-3).

## Mobile (visual_mobile) — not applicable

cyboflow is desktop-only. `verification.visual_mobile=false`.

## Manual Playwright E2E (independent of MCP)

`pnpm test` drives the full Electron app via `playwright._electron.launch()`.
This path is independent of the CDP attach and does not require `pnpm dev`
to be running; the test runner manages the Electron lifecycle itself. Useful
for headless CI flows where MCP isn't available.
