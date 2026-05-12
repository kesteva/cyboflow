---
id: TASK-052
sprint: SPRINT-002
epic: apple-signing-notarization-setup
status: done
summary: "Audited build/entitlements.mac.plist: removed 2 sandbox-only no-op entitlements (com.apple.security.inherit, com.apple.security.network.server), kept 5 active hardened-runtime entitlements + 1 forward-compat placeholder, added inline XML comments naming each consumer subsystem."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-052 — Done

Configuration-audit task. Rewrote `build/entitlements.mac.plist` from 8 keys to 6 keys with documented rationale per key:

Kept (active):
- `com.apple.security.cs.allow-jit` — V8 JIT (Electron core)
- `com.apple.security.cs.allow-unsigned-executable-memory` — node-pty subprocess executable pages (`AbstractCliManager.ts`)
- `com.apple.security.cs.disable-library-validation` — unsigned native modules: `better-sqlite3`, `@homebridge/node-pty-prebuilt-multiarch`
- `com.apple.security.cs.allow-dyld-environment-variables` — Electron helper process DYLD_* env vars
- `com.apple.security.network.client` — Anthropic API + Apple notarization + future electron-updater

Kept (forward-compat placeholder):
- `com.apple.security.files.user-selected.read-write` — sandbox-only entitlement, inert without `app-sandbox`. Retained because IDEA-002 slice 3 explicitly names it; comment explains the v2 trigger condition.

Removed:
- `com.apple.security.inherit` — sandbox-inherit, no effect without `app-sandbox`
- `com.apple.security.network.server` — sandbox-only TCP entitlement; codebase has no TCP `listen` call (`permissionIpcServer.ts` uses Unix domain sockets via `server.listen(socketPath)`)

All four acceptance-criteria CLI checks pass: `PlistBuddy Print` lists exactly 6 keys, `grep -c` for IDEA-002 keys returns 4, `plutil -lint` prints `OK`, comment-to-key ratio is 6/6.

Runtime correctness deferred to TASK-055 (signed DMG actually runs node-pty + better-sqlite3 under hardened runtime).

Commit: 3ad02bc chore(TASK-052): audit and annotate entitlements.mac.plist
