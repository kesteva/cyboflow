---
id: TASK-053
sprint: SPRINT-002
epic: apple-signing-notarization-setup
status: done
summary: "Flipped package.json build.mac defaults to signed+notarized posture (hardenedRuntime: true, notarize object form with teamId env-var interpolation, entitlements pointing at build/entitlements.mac.plist). Wrote plain-Node smoke test for scripts/configure-build.js downgrade and signed branches."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-053 — Done

Inverted the polarity of `package.json` `build.mac`: signed+notarized is now the default, the unsigned dev-shortcut is the explicit override (driven by `scripts/configure-build.js` when credentials are missing). Specifically:

- `hardenedRuntime: false` → `true`
- `notarize: false` → `{ "teamId": "${APPLE_TEAM_ID}" }` (object form per electron-builder v26 notarytool contract — env-var interpolation handled by electron-builder at build time)
- Added `entitlements: "build/entitlements.mac.plist"`
- Added `entitlementsInherit: "build/entitlements.mac.plist"`
- No changes to `appId`, `productName`, `name`, `version`, target/artifactName/signIgnore/x64ArchFiles or non-mac subkeys.

New `scripts/configure-build.test.js` is a self-contained plain-Node smoke test (no test framework — invoke via `node scripts/configure-build.test.js`). Two cases:
- Case A: CSC_DISABLE=true → asserts unsigned posture (hardenedRuntime false, notarize false, entitlements undefined)
- Case B: CSC_LINK + APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD → asserts signed posture
Snapshot+restore via `.bak` in try/finally; require-cache invalidation between cases.

AC1's literal `notarize !== true` clause contradicts AC3 (which accepts boolean OR object form). The plan body's "Hardest Decision" section explicitly chose the object form for electron-builder v26 robustness. Verifier resolved in favor of AC3 + plan body.

Code-reviewer queued one low-severity cleanup finding (FIND-SPRINT-002-1): dead `keysToDelete` array and redundant outer try/catch in the smoke test. Cosmetic, not blocking.

Env-var interpolation `${APPLE_TEAM_ID}` will be live-tested by TASK-055 (first real signed DMG build).

Commit: 719e4b6 feat(TASK-053): flip package.json build.mac to signed+notarized posture
