---
id: TASK-555
idea: IDEA-012
idea_id: IDEA-012
status: ready
created: "2026-05-11T00:00:00Z"
files_owned:
  - package.json
  - .soloflow/active/acceptance/DMG-VERIFICATION.md
files_readonly:
  - build/afterSign.js
  - build/entitlements.mac.plist
  - main/src/index.ts
acceptance_criteria:
  - criterion: "package.json version is set to '1.0.0' (no '-rc', '-beta', or '-alpha' suffix)."
    verification: "node -e \"console.log(require('./package.json').version)\" prints exactly '1.0.0'."
  - criterion: "package.json build.appId is 'com.cyboflow.app' and build.productName is 'Cyboflow'."
    verification: "node -e \"const p=require('./package.json'); console.log(p.build.appId+'|'+p.build.productName)\" prints 'com.cyboflow.app|Cyboflow'."
  - criterion: "package.json top-level 'name' is 'cyboflow' (not 'crystal')."
    verification: "node -e \"console.log(require('./package.json').name)\" prints exactly 'cyboflow'."
  - criterion: "A signed, notarized universal DMG named 'Cyboflow-1.0.0-macOS-universal.dmg' is produced under dist-electron/ by the build pipeline established in epic apple-signing-notarization-setup."
    verification: "After running `pnpm build:mac:universal`, `ls dist-electron/Cyboflow-1.0.0-macOS-universal.dmg` exits 0 and `codesign -dvv dist-electron/mac-universal/Cyboflow.app 2>&1 | grep 'Authority=Developer ID Application'` returns a match."
  - criterion: "Notarization status is 'Accepted' — verified via `spctl --assess --type install dist-electron/Cyboflow-1.0.0-macOS-universal.dmg` returns exit 0 and `stapler validate dist-electron/Cyboflow-1.0.0-macOS-universal.dmg` returns 'The validate action worked!'."
    verification: Run both commands; record their stdout in DMG-VERIFICATION.md. Both must succeed.
  - criterion: "Clean-account smoke test: a separate macOS user account (or a fresh test machine) opens the DMG, drags Cyboflow.app to /Applications, launches it. Gatekeeper shows no warnings. The app reaches the main UI with a green StatusBar dot."
    verification: "DMG-VERIFICATION.md contains a 'Clean-Account Smoke Test' section with: account/machine used, screenshot or terminal log of the launch, and a PASS/FAIL stamp."
  - criterion: lipo -info confirms both x64 and arm64 slices in better-sqlite3.node and node-pty.node bundled in the DMG.
    verification: "Mount the DMG, run `lipo -info /Volumes/Cyboflow/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` and the equivalent for node-pty; both report 'Architectures in the fat file: x86_64 arm64'. Output captured in DMG-VERIFICATION.md."
depends_on:
  - TASK-554
estimated_complexity: medium
epic: first-run-onboarding-and-self-host-acceptance
test_strategy:
  needed: false
  justification: "This is a packaging/release task. Verification is operational (codesign, spctl, stapler, lipo, real Gatekeeper) — there are no unit-testable code paths added. The DMG-VERIFICATION.md file captures the operational evidence."
prerequisites:
  - check: "test -n \"$APPLE_ID\" && test -n \"$APPLE_TEAM_ID\" && test -n \"$APPLE_APP_SPECIFIC_PASSWORD\""
    fix: "Configure notarytool credentials in keychain or environment per build/afterSign.js. Run `xcrun notarytool store-credentials AC_PASSWORD --apple-id <email> --team-id <team> --password <app-specific-password>` once, then set APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD env vars before invoking the build."
    description: "Notarization requires Apple ID + team ID + app-specific password (or keychain-stored credentials under AC_PASSWORD). Without these, electron-builder's notarize step fails with cryptic error."
    blocking: true
  - check: "security find-identity -v -p codesigning | grep -q 'Developer ID Application'"
    fix: "Install the Developer ID Application certificate from Apple Developer portal into the login keychain. The apple-signing-notarization-setup epic owns this; if missing here, that epic did not complete."
    description: "Code signing requires a valid Developer ID Application certificate in the keychain. Absence yields 'no identity found' from electron-builder."
    blocking: true
  - check: "grep -q '\"hardenedRuntime\": true' package.json && grep -q '\"notarize\": true' package.json"
    fix: "Open package.json, set build.mac.hardenedRuntime to true and build.mac.notarize to true. This should already be done by apple-signing-notarization-setup; if not, that epic regressed."
    description: "Crystal's inherited package.json ships with hardenedRuntime: false and notarize: false (Crystal's dev shortcut). Notarization will not run unless both flags are true."
    blocking: true
---
# Produce, Sign, and Notarize the v1.0.0 DMG

## Objective

Cut v1.0.0 of Cyboflow: bump `package.json` to 1.0.0, finalize the appId/productName rebrand if still incomplete, run the full sign + notarize + staple pipeline established in `apple-signing-notarization-setup` (epic 2), and verify the resulting DMG installs and launches cleanly on a fresh macOS user account from the GitHub release page. Capture verification evidence (codesign output, spctl/stapler results, lipo verification, clean-account smoke test) in `DMG-VERIFICATION.md`. This is the shippable artifact — the "ship event" the brief calls out as the gating deliverable of the MVP.

## Implementation Steps

1. Read `build/afterSign.js` and `build/entitlements.mac.plist` to confirm `apple-signing-notarization-setup` epic has wired notarytool correctly. If the afterSign hook only does JAR cleanup and does not invoke notarytool, that earlier epic did not land its work — escalate.

2. Modify `package.json` (single PR, atomic):
   - `"name": "cyboflow"` (replaces `"crystal"`).
   - `"version": "1.0.0"` (replaces `"0.3.5"`).
   - `"description": "Cyboflow - Cross-workflow review queue for Claude Code"`.
   - `"author": { "name": "Cyboflow", "email": "<author email>" }`.
   - `"build.appId": "com.cyboflow.app"` (replaces `"com.stravu.crystal"`).
   - `"build.productName": "Cyboflow"` (replaces `"Crystal"`).
   - `"build.publish.owner"` / `"build.publish.repo"`: update to the Cyboflow GitHub org/repo. If publishing target is undecided, leave as `null` and use local `--publish never`.
   - Do NOT touch `build.mac.hardenedRuntime`, `build.mac.notarize`, or `build.afterSign` — those are owned by epic 2 and must already be `true`/wired by the time this task runs.
   - Linux and Windows blocks under `build.*`: leave for now if Crystal cuts already removed them; otherwise delete (this is technically outside this task's scope — flag rather than scope-creep).

3. Run the build pipeline locally:
   - `pnpm install` (in case dep changes from upstream merges).
   - `pnpm run setup` (rebuilds native modules against current Electron).
   - `pnpm run build:mac:universal` — produces `dist-electron/Cyboflow-1.0.0-macOS-universal.dmg`.
   - Monitor electron-builder output for any sign failures (unsigned helper executables, wrong identity). The notarytool submission step prints a submission ID; record it.

4. Verification commands (each result captured in DMG-VERIFICATION.md):
   - `codesign -dvv dist-electron/mac-universal/Cyboflow.app 2>&1 | grep -E 'Authority|TeamIdentifier|Format'`
   - `spctl --assess --type install dist-electron/Cyboflow-1.0.0-macOS-universal.dmg`
   - `stapler validate dist-electron/Cyboflow-1.0.0-macOS-universal.dmg`
   - Mount the DMG: `hdiutil attach dist-electron/Cyboflow-1.0.0-macOS-universal.dmg`
   - `lipo -info /Volumes/Cyboflow/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` — expect 'x86_64 arm64'.
   - `lipo -info /Volumes/Cyboflow/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node` (path may vary — locate with `find /Volumes/Cyboflow -name 'pty.node'`).
   - `hdiutil detach /Volumes/Cyboflow`.

5. Clean-account smoke test:
   - On the same Mac, create a fresh macOS user account (System Settings → Users & Groups → Add User) named `cyboflow-test`, log in.
   - OR use a separate test machine with no prior Cyboflow installation.
   - Download the DMG from a local path (or, if the release is uploaded, from the GitHub release URL).
   - Open it (Gatekeeper must NOT show "unidentified developer"). Drag Cyboflow.app to /Applications.
   - Launch Cyboflow.app. The first-launch dialog "Cyboflow is an app downloaded from the internet. Are you sure?" is acceptable; "cannot be opened because the developer cannot be verified" is FAIL.
   - Verify the app reaches its main UI and the StatusBar dot is green (MCP healthy on a fresh install).
   - Capture a screenshot OR a `say -v "Daniel" "test passed"` style timestamp log in DMG-VERIFICATION.md.

6. Create `.soloflow/active/acceptance/DMG-VERIFICATION.md` with sections:
   ```
   # v1.0.0 DMG Verification

   Build commit: <git rev-parse HEAD>
   Built at: <ISO timestamp>
   Notarytool submission ID: <id>

   ## Sign Verification
   <codesign output>

   ## Gatekeeper Verification
   <spctl output>
   <stapler validate output>

   ## Universal Binary Verification
   <lipo -info outputs for both .node binaries>

   ## Clean-Account Smoke Test
   - Account/machine: <description>
   - Launch timestamp: <ISO>
   - StatusBar dot color on first launch: <green/yellow/red>
   - Result: <PASS/FAIL>
   - Evidence: <path to screenshot or terminal log>
   ```

7. If all verifications PASS, this task is done. The DMG is the shippable artifact. Push to the GitHub release (manually for v1.0.0 — auto-update is out of scope per brief).

## Acceptance Criteria

See frontmatter. The DMG must be signed, notarized, stapled, universal, and verifiable on a clean account.

## Test Strategy

No unit tests — operational verification only. The 7 AC items + the DMG-VERIFICATION.md log file constitute the test record.

## Hardest Decision

Whether to do the clean-account smoke test on a separate user account on the same Mac vs a completely fresh machine. Picked separate user account on same Mac. Rationale: the dominant Gatekeeper failure mode is "developer cannot be verified" which is a per-user-keychain trust issue; a fresh user account on the same Mac exercises that codepath without requiring access to a second machine. A fresh machine adds confidence but at high cost; the brief's success metric does not require it. If the self-host run already ran on the dev's primary account, the fresh user account is a meaningful independent probe.

## Rejected Alternatives

- Skip notarization, rely on `codesign` + manual override. Rejected — explicitly violates the success criteria ("signed + notarized macOS app").
- Use a third-party notarization service (e.g., a wrapper script). Rejected — `notarytool` is the only Apple-supported path post-2024 (altool decommissioned per risks research §2).

## Lowest Confidence Area

Sign-time pipeline interaction with the existing `build/afterSign.js`. The current afterSign.js only strips JARs from claude-code's vendor directory; epic 2 (`apple-signing-notarization-setup`) is supposed to have replaced or extended it with the notarytool submission. If epic 2 left the JAR cleanup in place but also added the notarytool call as a second hook, ordering matters — JARs must be stripped BEFORE final signing or signing fails on unsigned JAR contents. If epic 2's wiring is unclear when this task runs, read its plan and confirm both hooks chain correctly before invoking `build:mac:universal`.
