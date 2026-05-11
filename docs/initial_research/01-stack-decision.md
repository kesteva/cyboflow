# Stack Decision: Open-Source Foundation for Cyboflow

Research underpinning the Electron + node-pty + xterm.js + React stack choice. Reference when making cross-cutting tech decisions.

## TL;DR

- **Build on Electron + `node-pty` + `xterm.js` + React/Vite.** Lowest-friction path for a TypeScript/React developer. Largest body of working reference code (Crystal/Nimbalyst, MultiClaude, coide, claude-console). 2-week MVP lands without Rust learning curve. The forked starter is **stravu/crystal** — MIT-licensed, implements multi-PTY Claude Code sessions with a custom React UI.
- **Do NOT fork Warp or Ghostty as the shell.** Warp is AGPLv3 with a Rust+GPU codebase that takes weeks to grok; its real value (Oz orchestration) is closed-source. Ghostty is a terminal emulator app, not an orchestration scaffold. `libghostty-vt` might be useful later as an embedded VT renderer, not as a starting shell.
- **Honorable mention for the long-term play:** Tauri 2 + `portable-pty`. Pattern-validated by `opcode` (formerly Claudia, ~21k stars, AGPLv3). Pay ~3–5 days of Rust tax to win smaller binaries, native feel, App Store-friendly bundles.

## Key Findings

### 1. "Spawn N Claude Codes and parse stream-json into a custom UI" is solved repeatedly in Electron+node-pty
Crystal/Nimbalyst, MultiClaude, coide, claude-console, CodePilot, Outworked, and Anthropic's Claude Desktop are all Electron apps. Crystal's architecture is essentially what Cyboflow is building: Electron main → `node-pty` spawns Claude Code → IPC bridge → React renderer with `xterm.js` panels and Zustand state. MIT-licensed and forkable. Anthropic's Boris Cherney publicly confirmed Claude Desktop is Electron because "Claude is great at it" — AI assistants write Electron well.

### 2. Claude Code's `--output-format stream-json` is trivial to consume in Node
Each line of stream-json is a self-contained NDJSON event with `type`, `event.delta`, `system`, `message`, `tool_use`, etc. From `node-pty` (or `child_process.spawn` for non-interactive `claude -p`), you `.split('\n')` and `JSON.parse()`. A working consumer is roughly 30 lines. The chaining pattern (`--input-format stream-json` ↔ `--output-format stream-json`) maps cleanly to long-term structured-handoff goals.

### 3. Tauri's PTY story is real but younger
- **In-shell:** `tauri-plugin-pty` (Tnze, MIT) wraps xterm.js-style terminals; `tauri-terminal` (Marc Espin) uses `portable-pty` directly. `portable-pty` is the wezterm-derived crate, used by mprocs and others.
- **Sidecar pattern:** Tauri's `Command.sidecar()` lets you bundle the `claude` binary and stream stdout via event channel. Known sharp edge (issue #3508): `rx.recv()` doesn't fire for processes that clear/redraw their output. For `claude --print --output-format stream-json` (line-buffered NDJSON, no clearing) this is fine; for interactive mode use `tauri-plugin-pty` instead.
- **opcode** (21k+ stars, AGPLv3) and forks prove the Tauri 2 + Claude Code pattern is production-ready. AGPLv3 limits forking.

### 4. Warp's open source release is more political than practical for a forker
Warp open-sourced in early 2026 under AGPLv3 (UI crates `warpui`/`warpui_core` are MIT). 37k stars in days, but: (a) contribution model funnels through Warp's closed-source **Oz** cloud orchestrator, (b) the codebase is a large native Rust GPU-accelerated terminal — you'd inherit their entire rendering stack for the *least interesting* part of the app, (c) AGPLv3 means adding cloud agents requires open-sourcing your modifications. **Verdict: useful as architectural study, not as a starting scaffold.**

### 5. Ghostty / libghostty is interesting but the wrong layer for v0
`libghostty-vt` (alpha, MIT, zero-dep, runs in WASM) is an embeddable VT parser/renderer — better than xterm.js's parsing core. A dozen agent-orchestration projects already use it (cmux, Factory Floor, frep, Mux, Supacode, taskers). But libghostty doesn't give you a window, IPC, UI framework, or PTY management. You still need Electron or Tauri around it. **Realistic plan: ship MVP on xterm.js, swap to libghostty later if rendering correctness becomes a complaint.**

### 6. tmux/Zellij are useful as backends but a footgun as frontends
tmux's control mode (`tmux -C`/`-CC`) is a machine-readable protocol used by iTerm2. `claude-squad`, `dmux`, `multi-agent-shogun` use it. But that's a TUI/terminal-attached pattern. Layering a custom React UI on top means parsing %output streams *and* still owning a PTY for the multiplexer process — strictly more plumbing than spawning Claude directly with node-pty. **Skip unless you need session persistence across app restarts** (a v1 feature, not v0).

### 7. Hyper is functional but in slow decay
Vercel's Electron+React terminal with a plugin system mirroring what you'd build anyway. As of mid-2025 there's an open "Is Hyper dead?" issue (#8101) over MacOS Tahoe-beta breakage, sparse PR throughput. Technically forkable, but you'd inherit a stagnant codebase. Crystal/Nimbalyst is fresher and tighter.

### 8. Wave Terminal is the sleeper architectural reference
Electron + React + Go (Apache-2.0). "Blocks" model — terminal blocks, web blocks, AI blocks, file-preview blocks draggable on a tiled canvas — is conceptually closest to Cyboflow's target UI. Heavier, don't fork whole. Read the source for layout/state patterns. Apache-2.0 means cribbing is fine.

## Comparison Matrix

Scale: ⭐⭐⭐⭐⭐ excellent · ⭐ poor

| Option | Time-to-MVP | Multi-PTY | UI freedom | Stream parse | Long-term | Skill fit | License risk |
|---|---|---|---|---|---|---|---|
| **Electron + node-pty + xterm.js + React** ⭐ recommended | ⭐⭐⭐⭐⭐ days | ⭐⭐⭐⭐⭐ native | ⭐⭐⭐⭐⭐ pure React | ⭐⭐⭐⭐⭐ trivial NDJSON | ⭐⭐⭐⭐ huge ecosystem | ⭐⭐⭐⭐⭐ JS/TS | ⭐⭐⭐⭐⭐ MIT |
| **Tauri 2 + portable-pty** | ⭐⭐⭐ 1-2 days Rust tax | ⭐⭐⭐⭐ portable-pty | ⭐⭐⭐⭐⭐ same React | ⭐⭐⭐⭐ sidecar events | ⭐⭐⭐⭐⭐ growing fast | ⭐⭐⭐ Rust for plugins | ⭐⭐⭐⭐⭐ MIT/Apache |
| **Fork stravu/crystal** ⭐ honorable mention | ⭐⭐⭐⭐⭐ clone+delete | ⭐⭐⭐⭐⭐ implemented | ⭐⭐⭐⭐ replace UI | ⭐⭐⭐⭐⭐ already parses | ⭐⭐⭐⭐ MIT, deprecated | ⭐⭐⭐⭐⭐ React/TS | ⭐⭐⭐⭐⭐ MIT |
| **Fork opcode (Claudia)** | ⭐⭐⭐ Tauri+Rust | ⭐⭐⭐⭐ single Claude/window | ⭐⭐⭐ inheriting arch | ⭐⭐⭐⭐ already does it | ⭐⭐⭐⭐ active | ⭐⭐⭐ Rust touchpoints | ⭐⭐ **AGPLv3** |
| **Fork Warp** | ⭐ weeks of Rust archaeology | ⭐⭐⭐ one-user model | ⭐⭐ fighting their UI | ⭐⭐⭐ write your own | ⭐⭐⭐⭐ corporate backing | ⭐⭐ Rust + GPU | ⭐⭐ AGPLv3 mostly |
| **libghostty-vt + shell** | ⭐⭐ alpha C API | ⭐⭐⭐⭐ VT only | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ hand-parse | ⭐⭐⭐⭐⭐ best correctness | ⭐⭐ C/Zig FFI | ⭐⭐⭐⭐⭐ MIT |
| **Hyper fork** | ⭐⭐⭐⭐ familiar | ⭐⭐⭐⭐ via node-pty | ⭐⭐⭐ plugin friction | ⭐⭐⭐⭐ raw Electron | ⭐⭐ uncertain maintenance | ⭐⭐⭐⭐⭐ JS/React | ⭐⭐⭐⭐⭐ MIT |
| **Wave Terminal** | ⭐⭐ Electron+React+Go heavy | ⭐⭐⭐⭐ implemented | ⭐⭐⭐ opinionated blocks | ⭐⭐⭐⭐ achievable | ⭐⭐⭐⭐ active | ⭐⭐⭐ adds Go | ⭐⭐⭐⭐⭐ Apache-2.0 |
| **tmux control mode** | ⭐⭐⭐ % parsing fiddly | ⭐⭐⭐⭐⭐ multiplexer | ⭐⭐⭐⭐ UI is yours | ⭐⭐⭐ %output wrapping | ⭐⭐⭐⭐ tmux is forever | ⭐⭐⭐⭐ shell + JS | ⭐⭐⭐⭐⭐ ISC |
| **Direct node-pty primitive** | ⭐⭐⭐⭐⭐ skip terminal | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ MIT |

## Recommended Primary Path

**Electron Forge (Vite template) + node-pty + xterm.js + React + Tailwind + Zustand.**

Reasoning for Cyboflow's specific situation:

1. **2-week budget pushed harder** — every hour on Rust is an hour not on the differentiator (review queue, workflow DAG, orchestration logic). Electron lets the full app be written in TypeScript, matching the language already running Claude Code daily.

2. **Reference implementations exist and are recent.** Crystal/Nimbalyst (Electron+node-pty+xterm.js+React+Zustand+SQLite) is a near-perfect architectural twin. coide, MultiClaude, claude-console are smaller variations.

3. **Stream-JSON is the integration surface, not a rendering surface.** Most of the UI (DAG view, step status, review queue) reads parsed JSON events, not rendering 24×80 terminal output. xterm.js is only needed for the optional "drop into a session" pane. Terminal-emulator quality is low-priority — xterm.js is fine.

4. **App Store deployment is not a v0 concern.** A 200 MB Electron DMG distributed via direct download or Homebrew Cask is acceptable. If/when targeting the Mac App Store later, that's the time for a Tauri rewrite, and React/TypeScript code transfers cleanly.

5. **node-pty is boringly reliable.** Maintained by VS Code team, pre-built binaries for macOS arm64/x64 and Windows, supports ConPTY on modern Windows. The `@lydell/node-pty` fork exists for bundle-size optimization. Not thread-safe across worker_threads — fine for spawning N child processes from the main process.

6. **The long-term vision survives this choice.** Custom DAG editor → React Flow. Multi-agent pipelines with structured handoffs → spawn a Claude with `--input-format stream-json` piped from another Claude's output. Token telemetry → in stream-json `usage`. GitHub/Linear → npm packages. Cloud agents in v1 → desktop app becomes thin client to a server you'd write anyway. **Nothing about the Electron choice forecloses any of this.**

### Day-1 starter sketch

```bash
npx create-electron-app@latest cyboflow --template=vite-typescript
cd cyboflow

npm i node-pty @xterm/xterm @xterm/addon-fit @xterm/addon-webgl
npm i react react-dom zustand
npm i -D @electron-forge/plugin-vite electron-rebuild tailwindcss postcss autoprefixer

npx electron-rebuild -f -w node-pty

npm i react-flow-renderer
npm i @radix-ui/react-dialog
npm i lucide-react
```

Architecture in your head:
- `src/main/index.ts` — Electron main. Owns `Map<sessionId, IPty>` of running Claude Code processes. Spawned with `pty.spawn('claude', ['--print', '--verbose', '--include-partial-messages', '--output-format', 'stream-json', '--input-format', 'stream-json', ...workflowArgs], { cwd, env })`.
- `src/main/ipc.ts` — IPC handlers: `session:start`, `session:stop`, `session:write`, `session:resize`. PTY `onData` events get newline-buffered, JSON-parsed, emitted to renderer as typed `claude:event`.
- `src/preload/index.ts` — `contextBridge.exposeInMainWorld('cyboflow', { startSession, stopSession, ... })`.
- `src/renderer/` — React app with Zustand store keyed by session. Three top-level panels: Workflow DAG (React Flow), Live Run (xterm.js + step status), Review Queue (across sessions).
- `src/renderer/lib/stream-parser.ts` — single function: Claude stream-json event → normalized `{kind: 'message'|'tool_use'|'tool_result'|'review_request'|'usage'|'system', ...}`.

**Recommendation for Cyboflow: fork stravu/crystal at HEAD as the starting point** rather than greenfield Electron. See `02a-architecture-comparison.md` for the Path A (fork) vs Path B (greenfield) decision detail.

## Honorable Mention: Tauri 2 (the polished long-term play)

If willing to spend 3–5 extra days to land on a stack that ships <20 MB binaries instead of 200 MB, starts in 0.4s vs 1.5s, mac-codesigns cleanly, is App Store-amenable, and aligns with where new desktop AI tools are going (opcode, Factory Floor, Mux, Supacode all chose Tauri or libghostty + native) — Tauri is the answer.

Pattern: `portable-pty` in the Rust backend manages PTYs and emits events; Tauri's `app.emit()` pushes them to the React frontend over IPC; xterm.js renders the embedded terminal pane. **opcode** is the canonical reference but **AGPLv3** — treat as learning reference, not fork basis. `marc2332/tauri-terminal` is MIT and shows the minimum portable-pty + xterm.js wiring.

The trap: most code is still TypeScript/React, but the moment something needs deep OS integration (spawning Claude with the right env, watching files, custom shortcuts) you're writing Rust. With Claude Code as a pair programmer this is doable but costs days not hours per new Rust capability.

## Caveats & Gotchas

- **AGPLv3 is the headline license trap.** Warp (mostly), opcode/Claudia, opclaude, OpenWarp, Outworked are all AGPLv3. For a locally-installed desktop app AGPL behaves like GPL — must release source for derivative works distributed. Adding cloud agents with a network UI activates AGPL's network clause. **Prefer MIT/Apache-2.0 (Crystal, Wave, Hyper, Tauri, Electron, node-pty, xterm.js, libghostty) over AGPL.**
- **node-pty requires native compilation.** Hit `electron-rebuild` issues at least once on macOS, especially crossing arm64/x86_64. Bake a CI matrix early. `@lydell/node-pty` fork ships per-platform pre-built binaries.
- **Tauri sidecar `rx.recv()` quirk (#3508)** means an interactive `claude` that clears its terminal won't stream events properly through sidecar API. For headless `claude --print --output-format stream-json` this is fine.
- **Claude Code's `--input-format stream-json` is undocumented at CLI level.** GitHub issue anthropics/claude-code#24594 complains about exactly this. Agent SDK docs cover it; CLI docs don't. Treat as semi-stable.
- **Crystal renamed to Nimbalyst (Feb 2026).** Original `stravu/crystal` repo still exists as MIT-licensed. Both are MIT for Cyboflow's purposes (Nimbalyst's AGPL layer is a separate package, not the desktop).
- **node-pty isn't thread-safe across worker_threads.** Spawning many PTYs from the main process is fine.
- **macOS code signing for Electron apps with native modules** requires hardened runtime + entitlements. Plan a half-day. Conductor and Crystal publish recipes; copy theirs.
- **Don't optimize for Linux until v1.** Mac primary is correct. Tauri's WebKitGTK on Linux has the most paper cuts; Electron's bundled Chromium "just works."

## Decision Heuristic

Choose **Electron + node-pty + xterm.js** if any two:
- Running a Claude Code session in a custom React panel within 2 days is the goal.
- Prefer hand-writing the workflow + review-queue logic to learning a new language during a 2-week sprint.
- Comfortable shipping a 200 MB DMG to early users.

Switch to **Tauri + portable-pty** if all three:
- Plan to take this to the Mac App Store before raising money / hiring.
- Have an extra week and tolerance for `cargo` error messages.
- Want the codebase to feel native from day one.

**Cyboflow's decision: Electron.** Ship the MVP. Take the Tauri rewrite as a v1 hardening pass once the differentiator is validated. Frontend React code travels between the two with minor changes.
