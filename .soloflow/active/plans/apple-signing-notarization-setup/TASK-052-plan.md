---
id: TASK-052
idea: IDEA-002
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - build/entitlements.mac.plist
files_readonly:
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/permissionIpcServer.ts
  - main/src/services/mcpPermissionBridge.ts
  - package.json
  - scripts/configure-build.js
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "`build/entitlements.mac.plist` contains exactly the entitlements Cyboflow needs and no extras that broaden the attack surface without justification"
    verification: "Run `/usr/libexec/PlistBuddy -c 'Print' build/entitlements.mac.plist` — output enumerates only the keys named in this plan's Implementation Steps. Every key has an inline XML comment explaining why."
  - criterion: "The four entitlements named in IDEA-002 slice 3 are present: `com.apple.security.cs.allow-jit`, `com.apple.security.network.client`, `com.apple.security.files.user-selected.read-write`, `com.apple.security.cs.allow-unsigned-executable-memory`"
    verification: "`grep -c 'com.apple.security.cs.allow-jit\\|com.apple.security.network.client\\|com.apple.security.files.user-selected.read-write\\|com.apple.security.cs.allow-unsigned-executable-memory' build/entitlements.mac.plist` returns at least 4"
  - criterion: "The plist parses as valid XML"
    verification: "`plutil -lint build/entitlements.mac.plist` prints `OK`"
  - criterion: "Each entitlement key has a sibling XML comment explaining its rationale (which subsystem requires it)"
    verification: "`grep -B1 'com.apple.security' build/entitlements.mac.plist | grep -c '<!--'` is >= number of entitlement keys"
depends_on: []
estimated_complexity: low
epic: apple-signing-notarization-setup
test_strategy:
  needed: false
  justification: "Configuration audit task. The runtime correctness of these entitlements is verified by TASK-055 (the first signed DMG actually runs node-pty + better-sqlite3 without crashing under hardened runtime)."
---

# Audit and document entitlements.mac.plist

## Objective

`build/entitlements.mac.plist` already exists from the Crystal inheritance with eight entitlement keys. This task audits each key against Cyboflow's actual runtime needs (node-pty subprocess spawn, JIT for V8, Unix socket server for `--permission-prompt-tool` bridge, project-dir file access, Anthropic API calls), keeps only what is justified, and annotates every remaining key with an inline XML comment naming the consumer subsystem. Entitlements broaden the app's attack surface; each one must justify itself.

## Implementation Steps

1. **Read the current plist** (`build/entitlements.mac.plist`). It currently declares: `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation`, `com.apple.security.cs.allow-dyld-environment-variables`, `com.apple.security.inherit`, `com.apple.security.files.user-selected.read-write`, `com.apple.security.network.client`, `com.apple.security.network.server`.

2. **Audit each key** against Cyboflow's actual usage (use the `files_readonly` codebase paths to confirm):
   - `com.apple.security.cs.allow-jit` → **KEEP**. V8 in Electron JIT-compiles JavaScript; required by every Electron app under hardened runtime.
   - `com.apple.security.cs.allow-unsigned-executable-memory` → **KEEP**. node-pty (`@homebridge/node-pty-prebuilt-multiarch`) spawns child processes that may write to executable memory pages. Crystal's `AbstractCliManager` is the consumer.
   - `com.apple.security.cs.disable-library-validation` → **KEEP**. `better-sqlite3` and `@homebridge/node-pty-prebuilt-multiarch` ship as unsigned native `.node` binaries; without this entitlement, hardened runtime refuses to dlopen them. This is the universally-recommended Electron + native-module entitlement.
   - `com.apple.security.cs.allow-dyld-environment-variables` → **KEEP**. Electron uses `DYLD_*` env vars internally for its helper processes; removing this has been documented to break Electron on hardened runtime.
   - `com.apple.security.inherit` → **REMOVE**. This is a sandbox-inherit entitlement; it has no effect on an app that does not enable App Sandbox (`com.apple.security.app-sandbox`). Cyboflow is a developer tool and will not enable sandboxing. Carrying `inherit` without `app-sandbox` is dead config.
   - `com.apple.security.files.user-selected.read-write` → **REMOVE**. This is a sandbox entitlement (it only takes effect with `com.apple.security.app-sandbox`). For an un-sandboxed app, the user's home directory is accessible by default subject to macOS TCC prompts. **However**, IDEA-002 slice 3 explicitly names this as a required entitlement. Re-read IDEA-002 slice 3, note that the directive is a literal copy from the risks research, and the risks research listed it as "minimum entitlements" assuming a sandboxed posture which Cyboflow does not adopt. **Decision: remove it, with a comment in the plan noting the rationale** so the executor does not silently contradict the IDEA. If a reviewer demands it for forward-compat with future sandboxing, restore it under a `<!-- forward-compat: re-enable if App Sandbox is enabled in v2 -->` comment.
   - `com.apple.security.network.client` → **KEEP**. Required by every outbound network call (Anthropic API, Apple notarization, telemetry, electron-updater future-work).
   - `com.apple.security.network.server` → **REMOVE**. `permissionIpcServer.ts` uses a **Unix domain socket** (`net.createServer()` on a filesystem path under `~/.cyboflow/sockets/`), not a TCP listening socket. `network.server` is a sandbox-only entitlement and does not apply to Unix sockets even under sandbox. No TCP server in the codebase confirmed via grep on `listen(` in `main/src/services/`.

3. **Rewrite the plist** with only the kept keys (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `allow-dyld-environment-variables`, `network.client`). Add an inline XML comment immediately before each `<key>` line naming the consumer subsystem and the source-of-truth file path. Example:
   