---
id: TASK-055
sprint: SPRINT-003
epic: apple-signing-notarization-setup
status: done
summary: "First end-to-end signed and notarized universal DMG produced (Cyboflow-0.3.5-macOS-universal.dmg). Codesign + spctl + stapler + lipo (both native binaries) all verified; build log captures both notarytool submission IDs, wall-clock times, and electron-builder version."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-055 — Done

First successful end-to-end signed-and-notarized universal DMG. Pre-flight smoke tests (`build/afterSign.test.js` 4/0, `scripts/configure-build.test.js` all pass) ran clean, then `pnpm run build:mac:universal` produced `dist-electron/Cyboflow-0.3.5-macOS-universal.dmg` (274 MB). Two notarytool round-trips were needed because the foreground build job hit a 1-hour tool timeout while polling Apple — the app bundle was already submitted (`0c820130-8bfc-4d58-b825-76f8abf94e40`, Accepted after ~95 min on Apple's servers); recovery used `xcrun notarytool info` polling, `xcrun stapler` on the .app, `hdiutil` to mint the DMG, and a second notarytool submission (`c5950a84-b245-4322-a866-f332b6a4bef8`, Accepted in ~2 min) for the DMG itself.

Both binaries verified universal via `lipo -info`: `better_sqlite3.node` and `@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node` both ship `x86_64 arm64`. `codesign --display` confirms `Identifier=com.cyboflow.app`, `Authority=Developer ID Application: Raimundo Esteva (Y7B83UUSAC)`, `Runtime Version=15.4.0`, `Notarization Ticket=stapled`. `spctl --assess --type execute` on the .app prints `accepted, source=Notarized Developer ID`; `xcrun stapler validate` on the DMG returns "The validate action worked!". Zero notarization rejections on the first attempt.

The build log at `docs/signing/FIRST_SIGNED_BUILD_LOG.md` (232 lines) captures all AC6 fields (`grep -c 'submission ID|notarytool|lipo|codesign'` returns 21) and includes a "Notes for Future Builds" section worth promoting into `docs/signing/APPLE_DEVELOPER_SETUP.md` as runbook material (queued for compounder).

One in-diff side effect: `configure-build.js` rewrote `package.json`'s `build.mac.notarize` field from `{teamId: "${APPLE_TEAM_ID}"}` to `true` during the signed run. Plan-prescribed (TASK-053 signed-posture flip) and `package.json` is in files_owned, so this is informational; logged as FIND-SPRINT-003-1 for visibility. Pre-existing `pnpm lint` failure in `frontend/src/components/panels/ai/MessagesView.tsx:50` (`prefer-const`) is unrelated and logged as FIND-SPRINT-003-2.

Commits: `5942daa` (docs(TASK-055): add first signed build log), `70b72e0` (chore(TASK-055): commit configure-build.js signed-posture package.json update).
