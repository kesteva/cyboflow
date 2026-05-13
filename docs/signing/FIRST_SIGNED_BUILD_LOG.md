# First Signed and Notarized Universal DMG — Build Log

## Build Summary

| Field | Value |
|-------|-------|
| Build timestamp | 2026-05-12T23:01:20Z (UTC) |
| Local build time | Tue May 12 16:01:20 PDT 2026 |
| electron-builder version | 26.0.20 |
| Electron version | 37.6.0 |
| App version | 0.3.5 |
| AppID | com.cyboflow.app |
| Product name | Cyboflow |
| Build command | `pnpm run build:mac:universal` |
| Signing identity | Developer ID Application: Raimundo Esteva (Y7B83UUSAC) |
| Team ID | Y7B83UUSAC |
| Signing timestamp | May 12, 2026 at 4:03:21 PM PDT |
| DMG size | 261 MB |
| DMG path | `dist-electron/Cyboflow-0.3.5-macOS-universal.dmg` |

---

## Pre-flight Smoke Tests

Both upstream smoke-tests passed before invoking the real build:

```
node build/afterSign.test.js
# Results: 4 passed, 0 failed  (exit 0)

node scripts/configure-build.test.js
# All test cases passed.  (exit 0)
```

---

## Build Process Timeline

| Time (PDT) | Event |
|------------|-------|
| 16:01:20 | `pnpm run build:mac:universal` started; configure-build.js ran with signed posture |
| 16:01 | Frontend (Vite) build complete |
| 16:01 | Main process (TypeScript) build complete |
| 16:01 | Build info injected |
| 16:02 | `@electron/rebuild` for x64 native modules (better-sqlite3, node-pty) |
| 16:02 | Electron x64 downloaded (115 MB) |
| 16:02 | `@electron/rebuild` for arm64 native modules |
| 16:02 | Electron arm64 downloaded (111 MB) |
| 16:02 | Universal app packaged in `dist-electron/mac-universal/` |
| 16:03 | codesign signing started — Developer ID Application: Raimundo Esteva (Y7B83UUSAC) |
| 16:03 | `afterSign.js` hook ran: JAR cleanup completed |
| 16:03:21 | codesign timestamp recorded |
| 16:03:43 | `notarytool submit` submitted `Cyboflow.zip` to Apple (submission ID: `0c820130-8bfc-4d58-b825-76f8abf94e40`) |
| 16:03–17:01 | Background process killed by tool timeout (notarytool `--wait` still polling Apple) |
| 17:01:14 | Separately confirmed: notarytool submit process finished |
| 17:38:46 | notarytool history confirmed: app submission **Accepted** |
| 17:42 | `notarytool submit` on DMG artifact: submission ID `c5950a84-b245-4322-a866-f332b6a4bef8` |
| ~17:44 | DMG submission **Accepted** by Apple |
| 17:44 | `xcrun stapler staple` on .app: **success** |
| 17:44 | `xcrun stapler staple` on DMG: **success** |

**Total wall-clock time (build start to stapled DMG):** ~1 hour 43 minutes  
_(Apple notarization for this first submission took ~1 hour 35 min — unusually slow; typical is 2–15 min)_

---

## configure-build.js Output

```
Configuring build for current environment...
Environment check:
  - Signing Disabled: ✗
  - Apple Certificate: ✓
  - Apple ID: ✓
  - Team ID: ✓
  - App Password: ✓
  - Can Sign: ✓
  - Can Notarize: ✓
Configuring for signed build...
Build configuration updated successfully!
Notarization: enabled
Hardened Runtime: enabled
```

---

## Notarization — Submission 1: App Bundle (Cyboflow.zip)

**Submission ID:** `0c820130-8bfc-4d58-b825-76f8abf94e40`  
**Submitted:** 2026-05-12T23:03:43.543Z (Apple upload time: 2026-05-12T23:05:22.840Z)  
**Status:** Accepted  
**statusSummary:** Ready for distribution  
**statusCode:** 0  
**archiveFilename:** Cyboflow.zip  
**sha256:** `68135630ae13d7e56bc2adf713bc2098e064026f31140d2a6c47a86f67b65d1b`  
**notarytool wall-clock time:** ~95 minutes (exceptionally slow first-submission delay on Apple servers)

```
xcrun notarytool log 0c820130-8bfc-4d58-b825-76f8abf94e40 --apple-id ... --team-id Y7B83UUSAC
# status: Accepted
# statusSummary: Ready for distribution
# statusCode: 0
```

No issues reported in the log (all files accepted, no warnings or errors).

---

## Notarization — Submission 2: DMG

The DMG was created manually (`hdiutil create`) after electron-builder was killed during the packaging phase. The .app inside was already notarized and stapled; a second notarytool submission was made for the DMG file itself to obtain a staple ticket.

**Submission ID:** `c5950a84-b245-4322-a866-f332b6a4bef8`  
**Submitted:** 2026-05-13T00:42:00.619Z  
**Status:** Accepted  
**statusSummary:** Ready for distribution  
**statusCode:** 0  
**archiveFilename:** Cyboflow-0.3.5-macOS-universal.dmg  
**sha256 (pre-staple, as submitted to notarytool):** `cdf62a509f69d9984ec43c1a884fa83effd3f91608b197367b390e675e09ee8e`  
**sha256 (post-staple, distribution artifact):** `6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494`  
**notarytool wall-clock time:** ~2 minutes

> Note: `xcrun stapler staple` rewrites the DMG to embed the notarization ticket, so the post-staple SHA differs from the pre-staple SHA submitted to Apple. Distribution / Gatekeeper-acceptance docs must reference the **post-staple** value (the file users actually download). The pre-staple SHA is preserved here only for cross-reference with the notarytool submission record.

No issues reported.

---

## Rejection Iterations

**None.** Both submissions were accepted on the first attempt. No rejection iterations occurred.

---

## codesign Verification (AC2)

```
$ codesign --verify --deep --strict --verbose=2 dist-electron/mac-universal/Cyboflow.app
--prepared: ...Squirrel.framework
--validated: ...Squirrel.framework
--prepared: ...Mantle.framework
--validated: ...Mantle.framework
--prepared: ...Cyboflow Helper (Renderer).app
--validated: ...Cyboflow Helper (Renderer).app
--prepared: ...ReactiveObjC.framework
--validated: ...ReactiveObjC.framework
--prepared: ...Cyboflow Helper (GPU).app
--validated: ...Cyboflow Helper (GPU).app
--prepared: ...Cyboflow Helper (Plugin).app
--validated: ...Cyboflow Helper (Plugin).app
--prepared: ...Cyboflow Helper.app
--validated: ...Cyboflow Helper.app
--prepared: ...Electron Framework.framework/Versions/Current
--prepared: ...Electron Framework.framework/.../chrome_crashpad_handler
--validated: ...Electron Framework.framework/.../chrome_crashpad_handler
--validated: ...Electron Framework.framework/Versions/Current
dist-electron/mac-universal/Cyboflow.app: valid on disk
dist-electron/mac-universal/Cyboflow.app: satisfies its Designated Requirement
# exit: 0
```

**codesign identity details:**
```
Authority=Developer ID Application: Raimundo Esteva (Y7B83UUSAC)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=May 12, 2026 at 4:03:21 PM
TeamIdentifier=Y7B83UUSAC
```

---

## spctl Assessment (AC2)

```
$ spctl --assess --type execute --verbose dist-electron/mac-universal/Cyboflow.app
dist-electron/mac-universal/Cyboflow.app: accepted
source=Notarized Developer ID
# exit: 0
```

---

## Stapler Validation (AC3)

```
$ xcrun stapler validate dist-electron/Cyboflow-0.3.5-macOS-universal.dmg
Processing: ...Cyboflow-0.3.5-macOS-universal.dmg
The validate action worked!
# exit: 0
```

---

## lipo — better-sqlite3 Universal Binary (AC4)

```
$ lipo -info dist-electron/mac-universal/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
Architectures in the fat file: .../better_sqlite3.node are: x86_64 arm64
```

Both `x86_64` and `arm64` slices confirmed present.

---

## lipo — node-pty Universal Binary (AC5)

The `@homebridge/node-pty-prebuilt-multiarch` package ships one rebuilt fat binary under `build/Release/` (rebuilt by `@electron/rebuild` for the current Electron ABI):

```
$ lipo -info dist-electron/mac-universal/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node
Architectures in the fat file: .../pty.node are: x86_64 arm64
```

Both `x86_64` and `arm64` slices confirmed present.

(The package also ships pre-built binaries for other platforms under `prebuilds/` — these are ignored at runtime; the `build/Release/pty.node` is what Electron loads.)

---

## Notes for Future Builds

1. **electron-builder background kill:** The background process timeout killed `pnpm run build:mac:universal` while `notarytool submit --wait` was polling Apple. On future runs, ensure the terminal session is persistent or the timeout is increased (the build takes ~1 hour when Apple notarization is slow). The submitted artifact was still accepted; we recovered by:
   - Polling `xcrun notarytool info` until status left "In Progress"
   - Manually stapling the .app
   - Creating the DMG with `hdiutil create`
   - Submitting and stapling the DMG separately

2. **DMG notarization is separate from app notarization:** electron-builder normally handles creating the DMG and stapling as part of its build flow. When the build is interrupted after signing but before DMG creation, the DMG must be notarized separately. This adds ~2 min for a second notarytool round-trip.

3. **Apple notarization latency:** First submission took ~95 min. Subsequent submissions were ~2 min. Normal latency is 2–15 min; the first submission may be slow due to Apple's initial scan of a new app identity.

4. **configure-build.js behavior:** Sets `notarize: true` in package.json before invoking electron-builder. electron-builder 26's `getNotarizeOptions()` reads credentials directly from `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` env vars — the `notarize: { teamId: '${APPLE_TEAM_ID}' }` placeholder in package.json is overridden to `true` by configure-build.js and the env vars are what actually matter.

5. **appId:** `com.cyboflow.app` — confirmed correct, rebrand is complete.
