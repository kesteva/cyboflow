# Visual Verification Setup (cyboflow)

This project is an Electron app. The Vite renderer at `http://localhost:4521`
depends on `preload`-injected `electronTRPC` and cannot bootstrap standalone, so
the `visual_web` / Playwright MCP path returns an empty page (HTTP 200, DOM empty).
Use `visual_macos` via Peekaboo MCP with `pnpm dev` running and the Electron
window visible.

## When `verification.visual_web=true` is set (Electron project)

`visual_web=true` combined with `playwright_target.kind=electron` always
produces `skipped_unable` verdicts — Playwright MCP drives a standalone
Chromium browser and cannot attach to the Electron renderer, which requires
the `electronTRPC` preload global. Three resolution paths exist:

1. **Set `verification.visual_web=false`** in `.soloflow/config.json` — visual
   verification then uses `visual_macos` (Peekaboo) only.
2. **Add a CDP-attach launcher** — expose the Electron renderer over Chrome
   DevTools Protocol so Playwright can `page.goto(cdpUrl)` against it; no
   such launcher exists in this repo yet.
3. **Run Playwright E2E manually** — `pnpm dev` in one shell, `pnpm test` in
   another. The `tests/*.spec.ts` suite drives the full Electron app and is
   not subject to the preload constraint.

If `visual_web=true` is being kept deliberately (it currently is — see
`.soloflow/config.json`), `skipped_unable` is the expected verdict for the
Playwright MCP path; `visual_macos` via Peekaboo with `pnpm dev` running is
the supported capture path in the meantime.

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
