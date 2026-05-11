---
id: ROADMAP-001-research-ecosystem
roadmap: ROADMAP-001
dimension: ecosystem
created: 2026-05-11T00:00:00Z
---

# Ecosystem Research: Cyboflow MVP

## Key Findings

- **Crystal fork is viable and stable at v0.3.5** (deprecated February 2026, replaced by Nimbalyst). The codebase is frozen — no upstream improvements will arrive — but the permission bridge architecture is fully implemented and production-tested. The `mcpPermissionBridge.ts` + `permissionIpcServer.ts` pair is the exact mechanism Cyboflow needs; it works today and requires renaming, not reimplementation.

- **electron-trpc does NOT exist in the Crystal codebase today.** Crystal uses raw `ipcMain.handle` throughout. The design doc's `electron-trpc v11` requirement means Cyboflow must wire this from scratch. The original `jsonnull/electron-trpc` library is unmaintained with tRPC v11 support stuck in an open PR. The only viable option is `mat-sz/trpc-electron` (npm: `trpc-electron`, latest tag `0.1.2`, January 2025) or a manual observable bridge.

- **`--permission-prompt-tool` takes an MCP tool name, not a socket path.** The Crystal codebase confirms the correct invocation: `claude -p --permission-prompt-tool mcp__crystal-permissions__approve_permission`. Claude routes tool approvals through the named MCP tool, which runs as a stdio subprocess; that subprocess in turn connects back to the main process via a Unix socket. The system design doc's description of the "socket bridge" is architecturally correct but the Claude CLI flag points at an MCP tool name, not a raw socket.

- **Missing `result` events in `--output-format stream-json` are confirmed and worsening.** Issue #1920 (closed not-planned, June 2025) and issue #8126 (closed not-planned, September 2025, v1.0.123) both confirm the pattern. The triple-gate completion check `(child exited) AND (stdout EOF) AND (parser drained)` with a 30-second watchdog is the correct mitigation and matches what the design doc prescribes.

- **Claude Code now ships a competing agent-view TUI** (`claude agents`, requires v2.1.139+) that displays parallel sessions and their "needs input" state across a workspace. It is terminal-based with per-session peek panels, not a native desktop UI. It lacks approval consolidation, per-workflow policy, dock badge, or SQLite audit log — the core gaps Cyboflow fills.

- **`@homebridge/node-pty-prebuilt-multiarch` v0.13.1 is stable but ships architecture-specific binaries, not a universal `.node` file.** Electron 37 (Crystal's pinned version) bundles Node.js 22.16.0. The `electron-builder` universal target handles this via `x64ArchFiles` in `build.mac` config (already present in Crystal's `package.json`) — separate arm64 and x64 `.node` files are lipo'd by electron-builder, not by the package itself.

---

## Detailed Analysis

### 1. Crystal Fork State at HEAD

**Repository status.** `stravu/crystal` at HEAD is v0.3.5, released February 26, 2026, and officially deprecated in favor of Nimbalyst. The project is frozen — the maintainer has explicitly stated no further upstream development will occur on the Crystal branch. This confirms the brief's assertion: fork it, own it, never pull from upstream.

**Nimbalyst license posture.** The Nimbalyst desktop app core is MIT; the team-collaboration layer is AGPL. The Crystal fork carries no AGPL contamination. The branch point is clean.

**What actually exists in the repo today vs. what the design doc describes.**
The design doc references `PermissionIpcServer` as if it provides the Unix socket bridge. The actual implementation is a three-layer stack:
1. `mcpPermissionBridge.ts` — a stdio MCP server subprocess that Claude Code actually talks to via `--permission-prompt-tool`
2. `permissionIpcServer.ts` — a `net.Server` Unix socket server that the bridge process connects to
3. `permissionManager.ts` — the main-process coordinator that holds pending requests and emits `ipcMain` events to the renderer

The `PermissionIpcServer`'s socket path is `~/.crystal/sockets/crystal-permissions-<PID>.sock`. When spawning Claude, Crystal writes an MCP config JSON that exposes the bridge as the `crystal-permissions` MCP server with the `approve_permission` tool.

Crucially, the design doc says "Crystal does not have an outbound MCP server today" (§5.6). This is incorrect — it does, precisely as `mcpPermissionBridge.ts`. The Cyboflow MCP server in §5.6 is a distinct outbound surface (exposing `cyboflow_list_pending_approvals`, etc. to Claude sessions), but the permission-bridge mechanism is already fully implemented and Cyboflow can lift it with a rename.

**No tRPC anywhere in the fork.** Crystal's renderer ↔ main communication is entirely raw `ipcMain.handle` / `contextBridge.exposeInMainWorld`. The `electron-trpc` requirement in the design doc is net-new work; there is no Crystal precedent to build on.

**Electron version.** Crystal pins `electron: ^37.6.0` (package.json devDependencies). Electron 37 bundles Node.js 22.16.0 and Chromium 138. This is a recent, non-LTS Electron release — Electron does not use the same LTS designation as Node.js; it rolls major versions roughly every 8 weeks. v37 is current-stable as of mid-2026.

**Sources:**
- https://github.com/stravu/crystal — deprecation notice, v0.3.5 README
- `main/src/services/mcpPermissionBridge.ts` — full implementation of the permission bridge
- `main/src/services/permissionIpcServer.ts` — Unix socket server
- `package.json` — Electron 37, MCP SDK ^1.12.1, node-pty ^0.12.0

---

### 2. Anthropic Claude Code CLI / SDK Status

**Current stable version.** `@anthropic-ai/claude-code` is at v2.1.138 as of the search date. The package has been shipping very rapidly (multiple versions per week). Crystal pins `^2.0.0` in both `package.json` files — this will pick up any 2.x release.

**The invocation.** From the current CLI reference (`code.claude.com/docs/en/cli-reference`), the flags Cyboflow needs are:

```
claude -p \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --mcp-config <path-to-run-mcp.json> \
  --permission-prompt-tool mcp__<server-name>__<tool-name> \
  --allowedTools mcp__<server-name>__<tool-name>
```

Key observations from the official reference:
- `--include-partial-messages` requires both `--print` and `--output-format stream-json`
- `--permission-prompt-tool` takes an MCP tool identifier of the form `mcp__<server-name>__<tool-name>`, NOT a socket path or "stdio" literal
- `--strict-mcp-config` is a useful flag for security: only loads MCP servers from the specified file, ignoring global `~/.claude.json` config
- `--mcp-config` accepts space-separated paths or a JSON string

**`--permission-prompt-tool` documentation status.** Issue #1175 (opened November 2024, still active as of research date) confirms there is no official minimal working example for implementing an MCP tool to handle permission prompts. Crystal's `mcpPermissionBridge.ts` is currently the best reference implementation available in open source.

**Missing `result` event (issue #1920 and #8126).** Both are closed-not-planned by Anthropic. Issue #1920 documents intermittent missing `result` events; issue #8126 (September 2025, v1.0.123) confirms the regression worsened on Vertex AI / CI / Linux. The current Claude Code v2.x has not shipped an explicit fix announcement. The design doc's triple-gate completion approach `(child exited) AND (stdout EOF) AND (parser drained)` with 30-second watchdog is correct and mandatory.

**Related hanging issue.** Issue #25629 documents a complementary failure mode: the `result` event IS emitted, but the process hangs afterward. This means both "no result event" and "result event + hang" are live failure modes. The completion gate must not rely on `result` as a gate-opener; it should only treat `result` as bonus data when it arrives.

**New capabilities since design doc was written.** Claude Code v2.1.139+ ships `claude agents` (Agent View), a terminal TUI for multi-session management. The `--bg` flag starts background sessions. The `--worktree` flag creates worktrees natively. These are Claude Code's own answer to the problem Cyboflow is solving; their existence is competitive context (see §6), not a threat to the fork strategy.

**Sources:**
- https://code.claude.com/docs/en/cli-reference — full flag reference, current
- https://github.com/anthropics/claude-code/issues/1920 — closed not-planned, result event missing
- https://github.com/anthropics/claude-code/issues/8126 — closed not-planned, v1.0.123 regression
- https://github.com/anthropics/claude-code/issues/25629 — related hang after result event
- https://github.com/anthropics/claude-code/issues/1175 — --permission-prompt-tool undocumented

---

### 3. electron-trpc v11 Maturity

**Critical finding: the design doc's stack requirement collides with library fragmentation.**

The original `jsonnull/electron-trpc`:
- Latest release: `0.7.1` (December 7, 2024)
- tRPC v11 support: PR #194 has been open since July 2025, unmerged
- Maintainer stance: "working on a rewrite for tRPC v11 support" but no timeline
- Community verdict: effectively unmaintained for tRPC v11 purposes

The fork `mat-sz/trpc-electron` (npm package name: `trpc-electron`):
- Explicitly targets tRPC v11.x.x
- Latest tag: `0.1.2` (January 6, 2025)
- 44 stars, 10 forks, 32 releases
- Active enough for production use; not battle-tested at scale
- No explicit subscription performance benchmarks available

**The subscription/observable pattern.** tRPC v11's subscription system uses async generators (server-sent events model), not RxJS observables. The `ipcLink` in `trpc-electron` routes subscription updates through Electron IPC. For 60Hz event throttling, the design doc's approach is correct: events go at full fidelity into the SQLite `raw_events` table; the tRPC subscription pushes a coalesced snapshot at most 60 times per second via a debounced IPC fanout. The library does not enforce a frequency cap internally — that's application-layer work.

**Practical recommendation.** Since Crystal has zero tRPC in it today, the choice between `trpc-electron@0.1.2` and a manual `ipcMain.handle` observable bridge is genuinely open. The risk of `trpc-electron` is that it is a small fork with limited issue tracking. The benefit is typed subscriptions and future `httpLink` swap path for team-tier extraction. Given the 80-hour timeline, using `trpc-electron` and accepting its unknown-at-scale behavior is reasonable — the tRPC router would only carry `cyboflow.*` procedures, not Crystal's existing IPC surface.

**Sources:**
- https://github.com/jsonnull/electron-trpc — original library, unmaintained for v11
- https://github.com/jsonnull/electron-trpc/pull/194 — tRPC v11 PR, unmerged
- https://github.com/mat-sz/trpc-electron — v11 fork, `0.1.2` latest
- https://trpc.io/blog/announcing-trpc-v11 — tRPC v11 stable announcement

---

### 4. @homebridge/node-pty-prebuilt-multiarch ABI Status

**Current stable version.** `v0.13.1` (July 3 date shown in releases). Introduced Node.js 24 support. Beta `v0.14.1-beta.2` exists (April 30) but stable is `0.13.1`. Crystal pins `^0.12.0` — this will resolve to `0.13.x` on fresh install.

**Critical finding: Electron support removed in beta.** The `v0.14.1-beta.1` release notes state "Electron support has been removed, unless a tester can be found." This means the next stable release may not include Electron prebuilds. Crystal's `^0.12.0` pin means it will resolve to `0.13.x`, which still has Electron support. The risk is in upgrading to `0.14.x+` stable if that version drops Electron prebuilds — the fallback is `node-gyp` source compilation, which is slower but functional for macOS.

**Universal binary architecture.** The package ships architecture-specific prebuilts (separate `darwin-arm64` and `darwin-x64` tarballs), not a single universal `.node` file. Crystal's `electron-builder` config handles this correctly: the `x64ArchFiles` key in `build.mac` specifies which files to keep when building the x64 slice of the universal binary. The `asarUnpack` pattern `node_modules/**/*.node` ensures `.node` binaries are extracted from the asar for runtime access. The build system already works — Cyboflow inherits this for free.

**ABI vs. Electron 37.** Electron 37 uses Node.js 22.16.0 ABI. `@homebridge/node-pty-prebuilt-multiarch@0.13.1` provides prebuilts for Electron v101 and v103 per the release page — these appear to be legacy version labels in the asset naming convention. The actual ABI matching is done by the install script checking `process.versions.electron` and falling back to `node-gyp` when no prebuilt matches. With `@electron/rebuild` in the postinstall hook (`pnpm exec electron-rebuild`), the native module is always correctly rebuilt for the pinned Electron ABI. Crystal's existing setup handles this.

**Sources:**
- https://github.com/homebridge/node-pty-prebuilt-multiarch/releases — v0.13.1 stable, beta warning
- `package.json` — pin `^0.12.0`, electron 37, asarUnpack config

---

### 5. MCP SDK Status

**Current stable version.** `@modelcontextprotocol/sdk` v1.29.0 (March 30, 2026) is the latest stable. Crystal currently pins `^1.12.1`. v1.x is the production-recommended line; v2 is in pre-alpha. Cyboflow should stay on v1.x until v2 stabilizes.

**Transports available.** The v1 SDK supports `StdioServerTransport` (used by Crystal's `mcpPermissionBridge.ts`) and Streamable HTTP transport. **Unix domain sockets are not a first-class transport in the SDK.** Crystal's architecture uses Unix sockets at the application layer (between the MCP bridge subprocess and the main Electron process) — that custom `net.createConnection(ipcPath)` in `mcpPermissionBridge.ts` is not using the MCP SDK's transport layer; it's a raw Node.js socket for orchestrator-to-bridge IPC. The MCP SDK's `StdioServerTransport` handles the Claude-to-bridge communication. This two-layer architecture is correct and Cyboflow can adopt it wholesale.

**Per-session scoping via `.mcp.json`.** Claude Code's `--mcp-config` flag accepts a path to a JSON file. Crystal writes a per-session MCP config that registers the `crystal-permissions` server with the bridge subprocess path and its two CLI args (sessionId, ipcPath). This is the per-session scoping mechanism. For Cyboflow, the same pattern applies: write a per-run `.mcp.json` into the worktree (or a temp path) injecting `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` as env vars for the bridge subprocess. The `--strict-mcp-config` flag (newly documented) can be used to prevent Claude from loading user-global MCP servers that might interfere.

**Sources:**
- https://github.com/modelcontextprotocol/typescript-sdk — v1.29.0 stable, v2 pre-alpha
- `main/src/services/mcpPermissionBridge.ts` — per-session scoping implementation

---

### 6. Competitor Landscape

**What competitors offer today.**

| Product | Parallel sessions | Cross-session approval queue | Permission policy | Native desktop app |
|---|---|---|---|---|
| **Claude Code `claude agents`** | Yes (supervisor process) | Peek panel per session, no consolidated queue | Per-mode (default/acceptEdits/dontAsk) | No (terminal TUI) |
| **Cursor 2.0** | Yes (up to 8, worktrees) | No — per-agent approve/reject, no workspace queue | File-level diffs, no tool-level gates | Yes (IDE) |
| **Nimbalyst** | Yes (multi-session kanban) | No queue — per-file diff review | Per-project permission modes | Yes (Electron) |
| **Cline** | No (VS Code extension, single session) | No | Tool allow/deny rules | No (VS Code extension) |
| **Continue.dev** | No | No | Limited | No (VS Code extension) |
| **Aider** | No | No | `--auto-commits` flag only | No (terminal) |

**Claude Code's native `claude agents` view (research preview, v2.1.139+).** This is the most direct competitive response. It shows a TUI table of all sessions with state, "Needs input" surfaced at the top, and per-session peek panels. It is:
- Terminal-only (no native desktop GUI, no dock badge)
- Per-session interaction model (you peek into one session at a time)
- No approval consolidation across sessions into a single queue pane
- No per-workflow tool policy (it is per-session permission mode, not per-tool rule)
- No audit log or SQLite persistence of approval history
- No timeout enforcement (approval expiry is not handled)

The gap Cyboflow fills: a single native desktop pane that shows ALL pending approvals from ALL running workflows sorted by age/priority, where the user clears the queue in one linear flow rather than navigating between per-session peek panels. The dock badge is the headline affordance — glanceable count without opening a terminal.

**Cursor 2.0 parallel agents.** Cursor dispatches up to 8 agents in worktrees. Each agent surfaces file diffs for approval in its own editor pane. There is no workspace-aggregated review queue; the user switches between panes. Cursor's permission granularity is at the file-diff level, not the tool-use level — Claude's `Bash` command approval is not a concept in Cursor.

**Nimbalyst.** Crystal's own successor. Kanban board for sessions, inline red/green diffs, per-project permission modes. No cross-session consolidated approval queue. The AGPL team layer is entirely separate and not relevant to the solo-developer v1 user.

**Market gap validation.** The "human attention is scarce" thesis is validated by what's missing across all competitors: none of them aggregate tool-use approvals from multiple parallel agents into a single ordered queue. Every product treats the human as navigating to agents, not agents surfacing their needs to the human. Cyboflow's `<ReviewQueueView />` pattern is genuinely not present in any shipping product as of this research.

**Sources:**
- https://code.claude.com/docs/en/agent-view — Claude Code agent view (research preview)
- https://cursor.com/blog/long-running-agents — Cursor parallel agents
- https://nimbalyst.com/features/ — Nimbalyst feature set, MIT/AGPL license split
- https://claude.com/blog/claude-code-desktop-redesign — April 2026 Claude Code desktop redesign

---

## Recommendations

1. **Adopt `mat-sz/trpc-electron` (`trpc-electron` on npm, v0.1.2) for the `electron-trpc` requirement.** The original `jsonnull/electron-trpc` has no tRPC v11 support and is effectively abandoned for this use case. `mat-sz/trpc-electron` is the only available v11-compatible option with release history. Scope its use to `cyboflow.*` procedures only; leave Crystal's existing `ipcMain.handle` surface untouched.
   - Evidence: PR #194 in jsonnull/electron-trpc open since July 2025, unmerged. `trpc-electron@0.1.2` has 32 releases and active maintenance.
   - Risk if ignored: Building on `jsonnull/electron-trpc@0.7.1` means running on tRPC v10 internals, breaking the design doc's v11 requirement and the future `httpLink` swap path.

2. **Pin `@homebridge/node-pty-prebuilt-multiarch` to `^0.13.1` explicitly (not `^0.12.0`).** v0.13.1 is the current stable with Node.js 24 support; v0.14.x betas drop Electron prebuilds. The `^0.12.0` pin in the fork will resolve to 0.13.x anyway, but explicitly pinning to `^0.13.1` documents intent and avoids accidentally picking up a 0.14.x stable that removes Electron support.
   - Evidence: `v0.14.1-beta.1` release notes state "Electron support has been removed, unless a tester can be found."
   - Risk if ignored: A future `pnpm update` could pull `0.14.x` stable, break Electron prebuilds, and require `node-gyp` source compilation — a surprising breakage mid-sprint.

3. **Wire the triple-gate completion check and 30-second watchdog before building any UI on top of run completion state.** Both issue #1920 (missing result event) and issue #25629 (hang after result event) are closed without upstream fixes and the pattern is confirmed across multiple Claude Code versions including current 2.x releases. The design doc's prescribed gate is correct; it should be the first thing implemented in `ClaudeStreamParser`.
   - Evidence: Two confirmed issues (June 2025, September 2025), neither fixed. Current version v2.1.138 has no changelog entry addressing this.
   - Risk if ignored: Workflow runs will hang indefinitely in the `running` state, blocking the approval queue from draining and making the review queue unusable after any session runs for more than a few turns.

4. **Rename and reuse Crystal's `mcpPermissionBridge.ts` + `permissionIpcServer.ts` directly; do not reimplement.** The design doc (§5.6) says Crystal has no outbound MCP server — this is incorrect. The full three-layer stack (Claude → stdio MCP bridge subprocess → Unix socket → main process) is implemented and working. The only change needed is renaming `crystal-permissions` to `cyboflow-permissions` and updating the socket path to `~/.cyboflow/sockets/`.
   - Evidence: `mcpPermissionBridge.ts` implements `approve_permission` MCP tool with full IPC bridge. Crystal's prod invocation passes `--permission-prompt-tool mcp__crystal-permissions__approve_permission` to Claude.
   - Risk if ignored: Reimplementing this from scratch adds 1-2 days to the critical path and risks introducing bugs in the most failure-sensitive part of the system (the pause mechanism).

5. **Use `--strict-mcp-config` when spawning Claude Code for workflow runs.** This prevents user-installed global MCP servers from loading inside Cyboflow-managed sessions, which could interfere with tool approval routing or add unexpected tool surfaces. Write a per-run MCP config to a temp path, pass it via `--mcp-config`, and add `--strict-mcp-config` to ensure only Cyboflow's `cyboflow-permissions` bridge and any workflow-specific servers load.
   - Evidence: `--strict-mcp-config` documented in current CLI reference; Issue #1175 highlights that unexpected MCP server interactions can interfere with `--permission-prompt-tool`.
   - Risk if ignored: User's global MCP servers (cursor, cline integrations, etc.) load into every Cyboflow session, potentially triggering additional permission-prompt-tool calls through the wrong handler.

---

## Open Questions

- **`trpc-electron@0.1.2` subscription backpressure at 60Hz** — The design doc prescribes throttling the tRPC subscription broadcast to 60Hz. The `trpc-electron` library uses Electron IPC channels underneath; IPC has no built-in backpressure. At high event rates (e.g., a Bash command producing 1000 output lines/sec), does the IPC channel queue grow unboundedly? The architecture dimension should validate whether a manual throttle in the Observable producer is sufficient, or whether a different buffering approach (e.g., batch-and-emit) is safer.

- **Electron 37 "current stable" vs. LTS posture** — Electron 37 is the current release but not an LTS branch. Electron's LTS branches (e.g., v34) receive bug fixes for 2 years; current releases do not. Crystal pinned v37 at deprecation time. The architecture dimension should decide whether to pin to Electron 34 LTS (more conservative, longer support) or keep v37 (latest features, Chromium 138).

- **`@modelcontextprotocol/sdk` v1.29.0 vs. `^1.12.1` pin** — Crystal pins `^1.12.1`; v1.29.0 is current. The jump from `1.12.x` to `1.29.x` likely includes breaking changes within the v1 minor series. Should Cyboflow upgrade to `1.29.0` on day one, or keep the inherited pin and only upgrade deliberately? The MCP SDK's minor version cadence is very fast (17 minor releases in roughly 3 months). The risks dimension should flag whether any 1.12→1.29 changes affect `StdioServerTransport` or `CallToolRequestSchema`.

- **Claude Code `claude agents` as accelerating competition** — Claude Code shipped its own parallel-agent management TUI in April 2026 (v2.1.139, research preview). Anthropic appears to be building toward the same problem space. The architecture dimension should note whether the `PermissionIpcServer`/`mcpPermissionBridge` mechanism remains stable as Claude Code evolves its permission model, or whether a future Claude Code release might change the `--permission-prompt-tool` protocol in a breaking way.

- **`mcpPermissionBridge.ts` has no timeout on `requestPermission`** — The `PermissionManager.requestPermission()` method (`permissionManager.ts:72`) uses `return new Promise((resolve) => { this.once(...) })` with no timeout, no reject path. In Crystal, this hangs forever if the renderer never sends `permission:respond`. Cyboflow's design doc requires a 60-minute timeout that replies with deny. The architecture dimension needs to spec how to plumb this timeout into the existing promise chain — it's not currently wired.

---

Sources:
- [stravu/crystal GitHub repository](https://github.com/stravu/crystal)
- [Nimbalyst features page](https://nimbalyst.com/features/)
- [Crystal for Claude Code: Nimbalyst is the Successor](https://nimbalyst.com/crystal/)
- [electron-trpc (jsonnull)](https://github.com/jsonnull/electron-trpc)
- [trpc-electron fork (mat-sz)](https://github.com/mat-sz/trpc-electron)
- [tRPC v11 support PR for electron-trpc](https://github.com/jsonnull/electron-trpc/pull/194)
- [Announcing tRPC v11](https://trpc.io/blog/announcing-trpc-v11)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code Agent View documentation](https://code.claude.com/docs/en/agent-view)
- [Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Issue #1920 — Missing result event in stream-json](https://github.com/anthropics/claude-code/issues/1920)
- [Issue #8126 — Sometimes missing result in stream-json](https://github.com/anthropics/claude-code/issues/8126)
- [Issue #25629 — Claude Code CLI hangs after result event](https://github.com/anthropics/claude-code/issues/25629)
- [Issue #1175 — --permission-prompt-tool undocumented](https://github.com/anthropics/claude-code/issues/1175)
- [@homebridge/node-pty-prebuilt-multiarch releases](https://github.com/homebridge/node-pty-prebuilt-multiarch/releases)
- [MCP TypeScript SDK (modelcontextprotocol)](https://github.com/modelcontextprotocol/typescript-sdk)
- [Cursor long-running agents](https://cursor.com/blog/long-running-agents)
- [Claude Code desktop redesign (April 2026)](https://claude.com/blog/claude-code-desktop-redesign)
