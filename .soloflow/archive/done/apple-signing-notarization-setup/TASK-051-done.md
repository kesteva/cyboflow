---
id: TASK-051
sprint: SPRINT-002
epic: apple-signing-notarization-setup
status: done
summary: "Documented Apple Developer Program enrollment, Developer ID Application certificate setup, and notarytool keychain profile creation in docs/signing/APPLE_DEVELOPER_SETUP.md."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-051 — Done

Manual provisioning task. The deliverable is `docs/signing/APPLE_DEVELOPER_SETUP.md`, a 350-line setup guide covering Apple Developer Program enrollment (with 24–48 h identity-verification lag warning), Developer ID Application certificate creation via Xcode and manual CSR paths, app-specific password generation, and `notarytool` keychain profile creation. Includes a "Verify Your Setup" section with all four acceptance-criteria CLI checks (xcrun --version, security find-identity, xcrun notarytool history, security find-certificate), build-time env-var reference, renewal procedure, and troubleshooting appendix.

User confirmed live provisioning is in place: the verifier ran `xcrun notarytool history --keychain-profile AC_PASSWORD` (exits 0, "No submission history.") and `security find-identity -v -p codesigning` returned "Developer ID Application: Raimundo Esteva (Y7B83UUSAC)". The Identity table in the doc records Team ID `Y7B83UUSAC` and Bundle ID `com.cyboflow.app`. Apple ID, Team ID, and cert SHA1 are non-secret in Apple's threat model (embedded in every signed binary); the actual app-specific password and `.p12` passphrase are placeholdered.

Code-reviewer flagged one Minor: the env-var enumeration says "all five must be set" but `scripts/configure-build.js:19-25` strictly only requires CSC_LINK for signing and three additional vars for notarization. Descriptive imprecision only — following the doc as written produces a correct signed+notarized build.

Commit: 0deba2f docs(TASK-051): complete Apple Developer setup guide with verification section
