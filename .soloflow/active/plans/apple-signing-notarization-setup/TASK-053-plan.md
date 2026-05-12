---
id: TASK-053
idea: IDEA-002
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - package.json
files_readonly:
  - scripts/configure-build.js
  - .github/workflows/build.yml
  - build/afterSign.js
  - build/entitlements.mac.plist
  - .soloflow/active/ideas/IDEA-002.md
acceptance_criteria:
  - criterion: "`package.json` build.mac defaults to signed+notarized posture (hardenedRuntime: true, notarize: true, entitlements pointing at build/entitlements.mac.plist)"
    verification: "`node -e \"const p=require('./package.json'); if(p.build.mac.hardenedRuntime!==true||p.build.mac.notarize!==true||p.build.mac.entitlements!=='build/entitlements.mac.plist'||p.build.mac.entitlementsInherit!=='build/entitlements.mac.plist') process.exit(1)\"` exits 0"
  - criterion: "`scripts/configure-build.js` still correctly downgrades the posture when credentials are absent (preserving the existing local/CI-without-secrets dev path)"
    verification: "Run `CSC_DISABLE=true node scripts/configure-build.js` then `node -e \"const p=require('./package.json'); if(p.build.mac.hardenedRuntime!==false||p.build.mac.notarize!==false||p.build.mac.entitlements!==undefined) process.exit(1)\"` exits 0. After the test, run `git checkout package.json` to restore the signed defaults."
  - criterion: "When credentials are present (signed posture), `package.json` declares notarize as an object with `teamId`, so electron-builder v26 uses notarytool with team-id correctly"
    verification: "`node -e \"const p=require('./package.json'); const n=p.build.mac.notarize; if(typeof n==='boolean'){process.exit(0)}else if(n&&n.teamId==='\\${APPLE_TEAM_ID}'){process.exit(0)}else process.exit(1)\"` exits 0 — either form is accepted, but if the object form is used it must reference APPLE_TEAM_ID"
  - criterion: "No regression to `appId`, `productName`, or other Crystal-specific fields outside this task's scope"
    verification: "`git diff package.json` touches only `build.mac.hardenedRuntime` and `build.mac.notarize` keys (and not `appId`, `productName`, `name`, `version`)"
depends_on:
  - TASK-052
estimated_complexity: low
epic: apple-signing-notarization-setup
test_strategy:
  needed: true
  justification: The interaction between the static package.json defaults and scripts/configure-build.js runtime override is subtle. A small smoke check confirms both paths still produce the expected build config.
  targets:
    - behavior: scripts/configure-build.js downgrades the build config to unsigned when CSC_DISABLE=true
      test_file: scripts/configure-build.test.js
      type: integration
    - behavior: "scripts/configure-build.js leaves the build config in signed-posture when all APPLE_* and CSC_LINK env vars are set"
      test_file: scripts/configure-build.test.js
      type: integration
---
# Flip hardenedRuntime and notarize defaults in package.json

## Objective

Change `package.json` build.mac defaults from Crystal's dev-shortcut (`hardenedRuntime: false`, `notarize: false`) to Cyboflow's production posture (`hardenedRuntime: true`, `notarize: true`, with `entitlements` and `entitlementsInherit` pointing at `build/entitlements.mac.plist`). The existing `scripts/configure-build.js` already handles the runtime downgrade when credentials are absent (lines 47–65), so flipping the defaults makes "signed + notarized" the assumed posture and the unsigned fallback the explicit override — the right polarity for Cyboflow.

## Implementation Steps

1. **Edit `package.json` `build.mac`** (lines 115–132). Change these specific keys:
   - `"hardenedRuntime": false` → `"hardenedRuntime": true`
   - `"notarize": false` → `"notarize": { "teamId": "${APPLE_TEAM_ID}" }`
   - Add `"entitlements": "build/entitlements.mac.plist"`
   - Add `"entitlementsInherit": "build/entitlements.mac.plist"`

   Do NOT touch `appId`, `productName`, `name`, `version`, the `target`, `artifactName`, `signIgnore`, `x64ArchFiles`, or any non-`mac` build subkey. The rebrand work (appId → `com.cyboflow.app`) is owned by `crystal-cuts-and-rebrand`'s rebrand slice (IDEA-001) and is **not** in scope for this task. Notarize will sign against whatever `appId` is set at the time the signed-build pipeline first runs (TASK-055).

2. **Verify `scripts/configure-build.js` still correctly downgrades when credentials are missing.** The script reads the current `package.json`, then conditionally overrides keys (`hardenedRuntime`, `notarize`, `entitlements`, `entitlementsInherit`). After the change, the relevant branches behave as:
   - `canSign === false` → script overwrites `hardenedRuntime: false`, sets `notarize: false`, `delete`s the two entitlement keys. **This still works correctly** because the script writes the file back after the override.
   - `canSign === true` → script overwrites with the same values we are now defaulting to. **Net effect: idempotent.**

   No edits to `scripts/configure-build.js` are needed in this task. (TASK-054 makes a separate, scoped change to that file.)

3. **Smoke-test the downgrade path.** Write a tiny integration check at `scripts/configure-build.test.js` (Node, no test framework — invoke as `node scripts/configure-build.test.js`, exit non-zero on failure). Two cases:
   - **Case A: CSC_DISABLE=true.** Snapshot `package.json`, run `scripts/configure-build.js`, assert `build.mac.hardenedRuntime === false`, `build.mac.notarize === false`, `build.mac.entitlements === undefined`. Restore the snapshot.
   - **Case B: CSC_LINK + APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD set.** Snapshot `package.json`, run `scripts/configure-build.js`, assert `build.mac.hardenedRuntime === true`, `build.mac.notarize` is truthy, `build.mac.entitlements === 'build/entitlements.mac.plist'`. Restore the snapshot.

   The test must always restore `package.json` to its pre-test state (use `fs.copyFileSync` to a `.bak` and restore in a `try/finally`).

4. **Run typecheck and lint.** `pnpm typecheck` and `pnpm lint` must exit 0. Neither should be affected because `package.json` is not TypeScript and the smoke-test file is plain JS, but run them to confirm no incidental breakage.

## Acceptance Criteria

- `package.json` defaults are signed-posture (hardenedRuntime true, notarize true, entitlements set).
- `scripts/configure-build.js` still correctly downgrades when `CSC_DISABLE=true`.
- The `notarize` value is either `true` (boolean) or an object with `teamId: "${APPLE_TEAM_ID}"`.
- `git diff package.json` is scoped to only the four `build.mac.*` keys named above.

## Test Strategy

New file `scripts/configure-build.test.js` exercises both branches of `scripts/configure-build.js` (signed vs unsigned). The test is self-contained, runs as `node scripts/configure-build.test.js`, and snapshots+restores `package.json` to avoid polluting the working tree. No mocking framework required — the test directly invokes `require('./configure-build').configureBuild()` (the module already exports the function).

## Hardest Decision

**Whether to use `"notarize": true` (boolean) or `"notarize": { "teamId": "${APPLE_TEAM_ID}" }` (object).** Chose the **object form with teamId** because electron-builder v26 with the modern notarytool flow requires the team ID to be discoverable; the boolean form has historically worked when the cert subject embeds the team ID and `APPLE_TEAM_ID` env var is exported, but the explicit object form is more robust against electron-builder version drift and matches the @electron/notarize v3 documented contract. The `${APPLE_TEAM_ID}` env-var interpolation is supported by electron-builder's config schema.

## Rejected Alternatives

- **Leave `package.json` at unsigned defaults and rely entirely on `scripts/configure-build.js` to flip them.** Rejected because that hides the production posture from anyone reading `package.json` cold and inverts the polarity — the dev-shortcut should be the explicit override, not the default.
- **Hard-code the Team ID literal in `package.json` instead of `${APPLE_TEAM_ID}` interpolation.** Rejected because the Team ID is captured by TASK-051 in a docs file and treated as configuration, not a secret; but committing it would couple the repo to one Apple account. Env var interpolation keeps the value out of git while still being declarative.
- **Use `@electron/notarize` directly from `afterSign.js` instead of the built-in `notarize` config.** Rejected because electron-builder v26's built-in notarize support (which uses `@electron/notarize` internally) is documented, maintained, and handles the staple step. A custom afterSign notarytool call would duplicate the wheel. See TASK-054 for the afterSign treatment.

## Lowest Confidence Area

**Whether electron-builder v26 honors `${APPLE_TEAM_ID}` env-var interpolation inside the `notarize` object.** The schema docs are clear that the top-level macOS config supports env-var interpolation, but the notarize subkey has historically been less consistent. Mitigation: TASK-055 (first signed DMG build) is the first real integration test; if the team ID does not resolve, the failure mode is a clear "401 unauthorized" or "missing team-id" from notarytool, easy to diagnose. Fallback: hard-code the team ID literal in `package.json` and accept the coupling.
