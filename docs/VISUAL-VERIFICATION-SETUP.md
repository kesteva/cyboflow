# Visual Verification Setup (cyboflow)

This project is an Electron app. The Vite renderer at `http://localhost:4521`
depends on `preload`-injected `electronTRPC` and cannot bootstrap standalone, so
the `visual_web` / Playwright MCP path returns an empty page (HTTP 200, DOM empty).
Use `visual_macos` via Peekaboo MCP with `pnpm dev` running and the Electron
window visible.

## macOS Permissions Required for Peekaboo MCP

Two separate macOS grants must be enabled for the Claude Code host process:

1. **Screen Recording** — enables window screenshots.
   System Settings > Privacy & Security > Screen Recording > Claude Code.
2. **Accessibility** — enables UI events (click, type, key press, menu).
   System Settings > Privacy & Security > Accessibility > Claude Code.

Screen Recording alone is NOT sufficient: capture works but interaction is
silently blocked. If `visual_macos` returns screenshots but clicks/keystrokes do
nothing, check Accessibility first. After granting either permission, quit and
relaunch Claude Code.

Recurrence evidence: `human-review-queue.md` dedup_keys
`visual_web_electron_unreachable` and `visual_macos_unavailable` (affected
sprints 015, 017, 020, 023, 024, 025, 026).
