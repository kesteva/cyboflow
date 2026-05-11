---
id: TASK-055
idea: IDEA-002
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - docs/signing/FIRST_SIGNED_BUILD_LOG.md
files_readonly:
  - package.json
  - build/afterSign.js
  - build/afterSign.test.js
  - build/entitlements.mac.plist
  - scripts/configure-build.js
  - .github/workflows/build.yml
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "A universal DMG is produced at `dist-electron/*-macOS-universal.dmg` by `pnpm run build:mac:universal` with APPLE_* and CSC_LINK env vars exported"
    verification: "After build completes, `ls dist-electron/*-macOS-universal.dmg` returns at least one file path"
  - criterion: "The DMG is code-signed with a Developer ID Application certificate"
    verification: "Run `codesign --verify --deep --strict --verbose=2 dist-electron/*.app` — exits 0. Also `spctl --assess --type execute --verbose dist-electron/*.app` prints `accepted` and `source=Notarized Developer ID`"
  - criterion: "The DMG is notarized and stapled"
    verification: "Run `xcrun stapler validate dist-electron/*.dmg` — prints `The validate action worked!` and exits 0. Also `xcrun notarytool log <submission-id> --keychain-profile AC_PASSWORD` (submission-id from build logs) shows `status: Accepted`"
  - criterion: "The bundled better-sqlite3 native binary is universal (both x64 and arm64 slices)"
    verification: "Run `lipo -info dist-electron/*.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` — output contains both `x86_64` and `arm64`"
  - criterion: "The bundled node-pty native binary is universal (both x64 and arm64 slices)"
    verification: "Run `lipo -info $(find dist-electron/*.app/Contents/Resources/app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch -name '*.node' | head -1)` — output contains both `x86_64` and `arm64`. If the package ships per-arch directories (not a single fat binary), record the layout in the build log and confirm both arch dirs are present."
  - criterion: "`docs/signing/FIRST_SIGNED_BUILD_LOG.md` captures: build timestamp, electron-builder version, notarytool submission ID, notarytool wall-clock time, lipo output for both native binaries, codesign/stapler output, and any rejection iterations with their root cause + fix"
    verification: "`test -f docs/signing/FIRST_SIGNED_BUILD_LOG.md` AND `grep -c 'submission ID\\|notarytool\\|lipo\\|codesign' docs/signing/FIRST_SIGNED_BUILD_LOG.md` is >= 4"
depends_on: [TASK-051, TASK-052, TASK-053, TASK-054]
estimated_complexity: high
epic: apple-signing-notarization-setup
test_strategy:
  needed: true
  justification: "This task IS the first end-to-end integration test of the entire signing pipeline. The acceptance criteria are the test cases."
  targets:
    - behavior: "afterSign smoke-test still passes before invoking the real build"
      test_file: "build/afterSign.test.js"
      type: integration
    - behavior: "configure-build smoke-test still passes before invoking the real build"
      test_file: "scripts/configure-build.test.js"
      type: integration
prerequisites:
  - check: "test -n \"$APPLE_ID\" && test -n \"$APPLE_TEAM_ID\" && test -n \"$APPLE_APP_SPECIFIC_PASSWORD\" && test -n \"$CSC_LINK\" && test -n \"$CSC_KEY_PASSWORD\""
    fix: "Export the five env vars per docs/signing/APPLE_DEVELOPER_SETUP.md before invoking pnpm run build:mac:universal"
    description: "scripts/configure-build.js (lines 18-25) gates the signed-posture build on these env vars. Without all five, the build downgrades to unsigned and this task's signed-DMG acceptance criteria cannot pass."
    blocking: true
  - check: "xcrun notarytool history --keychain-profile AC_PASSWORD >/dev/null 2>&1"
    fix: "Run TASK-051 to provision the AC_PASSWORD keychain profile"
    description: "electron-builder's built-in notarize uses the keychain profile to submit. Without it, notarize fails with 'no credentials' before the upload starts."
    blocking: true
  - check: "node -e \"const p=require('./package.json'); process.exit(p.appId&&p.appId.startsWith('com.cyboflow')?0:1)\" || echo 'WARN: appId still com.stravu.crystal; rebrand epic may not be complete'"
    fix: "Complete the rebrand slice in crystal-cuts-and-rebrand (IDEA-001) which sets build.appId to com.cyboflow.app"
    description: "Notarization will succeed regardless of appId, but Cyboflow's brand identity in the notarized record should be com.cyboflow.app. If appId is still com.stravu.crystal, the build is technically valid but ships under the wrong identity; log this as a known deviation in the build log."
    blocking: false
  - check: "test -f build/entitlements.mac.plist && plutil -lint build/entitlements.mac.plist >/dev/null 2>&1"
    fix: "Run TASK-052 to audit and validate the entitlements file"
    description: "An invalid entitlements plist causes codesign to fail before notarization can be attempted, with a cryptic error."
    blocking: true
  - check: "node -e \"const p=require('./package.json'); process.exit(p.build.mac.hardenedRuntime===true&&p.build.mac.notarize?0:1)\""
    fix: "Run TASK-053 to flip package.json defaults to signed posture"
    description: "Without hardenedRuntime: true and notarize enabled, electron-builder produces an unsigned DMG that cannot pass Gatekeeper."
    blocking: true
---

# First end-to-end signed and notarized universal DMG

## Objective

Produce the first signed-and-notarized universal DMG and verify every layer of the pipeline: codesign, notarization (notarytool round-trip), stapler, and `lipo` confirmation that both x64 and arm64 slices are present in the bundled native modules (`better-sqlite3.node` and `node-pty`). Capture the full build log to `docs/signing/FIRST_SIGNED_BUILD_LOG.md` so the next iteration is faster — notarization rejections cost 5–30 min per round-trip and the fix patterns deserve to be documented once.

This task is the integration test for everything TASK-051 through TASK-054 set up. Allocate a half-day of wall-clock time because notarization rejections are likely on the first attempt and each rejection iteration costs 30–60 min.

## Implementation Steps

1. **Pre-flight: run upstream smoke-tests** before invoking the real build.
   