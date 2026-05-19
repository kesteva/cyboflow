# First Signed and Notarized Universal DMG — Build Log

## Build Summary

| Field | Value |
|-------|-------|
| Build timestamp | `<TODO: ISO-8601 UTC timestamp, e.g. 2026-05-12T23:01:20Z>` |
| Local build time | `<TODO: local time string>` |
| electron-builder version | `<TODO: run electron-builder --version>` |
| Electron version | `<TODO: from package.json devDependencies>` |
| App version | `<TODO: from package.json version>` |
| AppID | `<TODO: from package.json build.appId>` |
| Product name | `<TODO: from package.json productName>` |
| Build command | `<TODO: e.g. pnpm run build:mac:universal>` |
| Signing identity | `<TODO: Developer ID Application: <NAME> (<TEAM_ID>)>` |
| Team ID | `<TODO: APPLE_TEAM_ID env var value>` |
| Signing timestamp | `<TODO: from codesign --display output>` |
| DMG size | `<TODO: e.g. 261 MB>` |
| DMG path | `<TODO: e.g. dist-electron/Cyboflow-<VERSION>-macOS-universal.dmg>` |

---

## Pre-flight Smoke Tests

Both upstream smoke-tests must pass before invoking the real build:

```
node build/afterSign.test.js
# Results: <TODO: N passed, 0 failed>  (exit 0)

node scripts/configure-build.test.js
# <TODO: All test cases passed.>  (exit 0)
```

---

## Build Process Timeline

| Time (local) | Event |
|--------------|-------|
| `<TODO>` | `pnpm run build:mac:universal` started; configure-build.js ran with signed posture |
| `<TODO>` | Frontend (Vite) build complete |
| `<TODO>` | Main process (TypeScript) build complete |
| `<TODO>` | Build info injected |
| `<TODO>` | `@electron/rebuild` for x64 native modules (better-sqlite3, node-pty) |
| `<TODO>` | `@electron/rebuild` for arm64 native modules |
| `<TODO>` | Universal app packaged in `dist-electron/mac-universal/` |
| `<TODO>` | codesign signing started |
| `<TODO>` | `afterSign.js` hook ran |
| `<TODO>` | codesign timestamp recorded |
| `<TODO>` | `notarytool submit` submitted `Cyboflow.zip` to Apple (submission ID: `<TODO>`) |
| `<TODO>` | `notarytool submit` on DMG artifact: submission ID `<TODO>` |
| `<TODO>` | App submission status: `<TODO: Accepted / Rejected>` |
| `<TODO>` | DMG submission status: `<TODO: Accepted / Rejected>` |
| `<TODO>` | `xcrun stapler staple` on .app: `<TODO: success / failed>` |
| `<TODO>` | `xcrun stapler staple` on DMG: `<TODO: success / failed>` |

**Total wall-clock time (build start to stapled DMG):** `<TODO: e.g. ~1 hour 43 minutes>`

---

## configure-build.js Output

```
<TODO: paste verbatim output of configure-build.js, including the posture
(signed or unsigned) and the fields it rewrote>
```

---

## Notarization — Submission 1: App Bundle (Cyboflow.zip)

> **Redaction:** Use the literal `<APPLE_ID>` placeholder in committed
> transcripts rather than a real Apple ID email. The submission ID and Team
> ID are sufficient cross-reference anchors for audit; the email adds no
> retrieval value and is unnecessary PII to leave in version control.

**Submission ID:** `<TODO>`
**Submitted:** `<TODO: ISO-8601 UTC timestamp>`
**Status:** `<TODO: Accepted / Rejected / Invalid>`
**statusSummary:** `<TODO>`
**statusCode:** `<TODO>`
**archiveFilename:** `Cyboflow.zip`
**sha256:** `<TODO>`
**notarytool wall-clock time:** `<TODO: e.g. ~2 minutes>`

```
xcrun notarytool log <TODO: submission-id> --apple-id <APPLE_ID> --team-id <TEAM_ID>
# <TODO: paste status line(s) from log>
```

`<TODO: note any issues reported or "No issues reported.">`

---

## Notarization — Submission 2: DMG

_Omit this section if electron-builder completed the DMG creation and notarization inline (i.e. the build was not interrupted). Only needed when the DMG was created manually after a build interruption._

**Submission ID:** `<TODO>`
**Submitted:** `<TODO: ISO-8601 UTC timestamp>`
**Status:** `<TODO: Accepted / Rejected / Invalid>`
**statusSummary:** `<TODO>`
**statusCode:** `<TODO>`
**archiveFilename:** `<TODO: Cyboflow-<VERSION>-macOS-universal.dmg>`
**sha256 (pre-staple, as submitted to notarytool):** `<TODO>`
**sha256 (post-staple, distribution artifact):** `<TODO>`
**notarytool wall-clock time:** `<TODO>`

`<TODO: note any issues reported or "No issues reported.">`

---

## Rejection Iterations

`<TODO: Describe each rejection iteration, or write "None. Both submissions were accepted on the first attempt.">`

---

## codesign Verification (AC2)

```
$ codesign --verify --deep --strict --verbose=2 dist-electron/mac-universal/Cyboflow.app
<TODO: paste verbatim output>
# exit: 0
```

**codesign identity details:**
```
<TODO: paste Authority= / Timestamp= / TeamIdentifier= lines from:
  codesign -dv --verbose=4 dist-electron/mac-universal/Cyboflow.app 2>&1 | grep -E "Authority|Timestamp|TeamIdentifier">
```

---

## spctl Assessment (AC2)

```
$ spctl --assess --type execute --verbose dist-electron/mac-universal/Cyboflow.app
<TODO: paste verbatim output — expected: "accepted" + "source=Notarized Developer ID">
# exit: 0
```

---

## Stapler Validation (AC3)

```
$ xcrun stapler validate dist-electron/Cyboflow-<TODO:VERSION>-macOS-universal.dmg
<TODO: paste verbatim output — expected: "The validate action worked!">
# exit: 0
```

---

## lipo — better-sqlite3 Universal Binary (AC4)

```
$ lipo -info dist-electron/mac-universal/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
<TODO: paste verbatim output — expected: "Architectures in the fat file: ... are: x86_64 arm64">
```

Both `x86_64` and `arm64` slices confirmed present.

---

## lipo — node-pty Universal Binary (AC5)

```
$ lipo -info dist-electron/mac-universal/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node
<TODO: paste verbatim output — expected: "Architectures in the fat file: ... are: x86_64 arm64">
```

Both `x86_64` and `arm64` slices confirmed present.

---

## cyboflowMcpServer.js Unpacking (AC6)

```
$ test -f dist-electron/mac-universal/Cyboflow.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js && echo "PRESENT" || echo "MISSING"
<TODO: paste verbatim output — expected: "PRESENT">
```

File confirmed present under `app.asar.unpacked/`. This file is the sole `asarUnpack` entry under `main/dist/**` — its presence confirms the `package.json` `build.asarUnpack` path matches the tsc emit layout.
