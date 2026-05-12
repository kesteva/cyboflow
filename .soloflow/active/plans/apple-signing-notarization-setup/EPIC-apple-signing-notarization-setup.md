---
epic: apple-signing-notarization-setup
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-002]
---

# Apple Signing and Notarization Setup

## Objective

Convert the inherited Crystal "dev-shortcut" packaging posture (`hardenedRuntime: false`, `notarize: false`, no notarytool integration) into a production-grade pipeline that produces a signed-and-notarized universal macOS DMG on every `pnpm run build:mac:universal`. Front-load this work into days 1–2 of the roadmap so the 24–48 h Apple Developer enrollment lag and the 5–30 min notarization round-trips do not collide with Milestone 2's MVP-done bar in week 2.

## Scope

- In scope:
  - Apple Developer Program enrollment / verification and Developer ID Application certificate provisioning
  - `notarytool` keychain profile (`AC_PASSWORD`) setup
  - Audit and tightening of `build/entitlements.mac.plist` to only the entitlements Cyboflow's runtime actually needs (V8 JIT, unsigned exec memory for node-pty, library validation off for unsigned native modules, dyld env vars for Electron helpers, outbound network)
  - Flip `package.json` `build.mac` defaults to signed-posture (`hardenedRuntime: true`, `notarize: { teamId: "${APPLE_TEAM_ID}" }`, entitlements declared)
  - Verify `scripts/configure-build.js` continues to correctly downgrade to unsigned when credentials are absent (preserves the dev/CI-without-secrets path)
  - Refit `build/afterSign.js` to keep its JAR-strip responsibility and explicitly delegate notarization to electron-builder's built-in `@electron/notarize` hook
  - First end-to-end signed universal DMG with full pipeline verification (codesign, notarization, stapler, lipo on native modules)
  - Clean-account Gatekeeper acceptance test on a fresh macOS user

- Out of scope:
  - Rebrand of `appId` from `com.stravu.crystal` to `com.cyboflow.app` (owned by `crystal-cuts-and-rebrand`); notarization passes regardless of the appId value, but the brand identity baked into the signed binary is owned elsewhere
  - CI signing pipeline beyond confirming `.github/workflows/build.yml` is not broken (production CI signing is post-MVP)
  - Sparkle/electron-updater integration (system design §8 puts auto-update out of v1)
  - Sandbox entitlements (`com.apple.security.app-sandbox` + sandbox-only entitlements) — Cyboflow is an unsandboxed developer tool in v1
  - App Store Connect API key (.p8) authentication — Apple ID + app-specific password is the simpler v1 path

## Success Signal

A signed, notarized universal DMG opens on a fresh macOS user account without any Gatekeeper warning dialog. `spctl --assess` prints `source=Notarized Developer ID`. `xcrun stapler validate` passes. `lipo -info` confirms both x64 and arm64 slices for `better_sqlite3.node` and the node-pty native binary. node-pty can spawn child processes inside the launched app under hardened runtime. `~/.cyboflow/cyboflow.db` (or `~/.crystal/crystal.db` if the rebrand has not yet landed) is written successfully. The audit trail of the first signed build is captured in `docs/signing/FIRST_SIGNED_BUILD_LOG.md` and `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` so the next iteration costs minutes, not hours.
