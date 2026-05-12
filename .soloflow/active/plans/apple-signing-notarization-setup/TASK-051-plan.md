---
id: TASK-051
idea: IDEA-002
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - docs/signing/APPLE_DEVELOPER_SETUP.md
files_readonly:
  - package.json
  - scripts/configure-build.js
  - .github/workflows/build.yml
  - .soloflow/active/ideas/IDEA-002.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: Apple Developer Program membership is active for the team that will sign Cyboflow
    verification: "Run `xcrun notarytool history --keychain-profile AC_PASSWORD` — exits 0 and shows the team. (Pre-enrollment, this command errors with 'No Apple ID in keychain'.)"
  - criterion: A Developer ID Application certificate for the enrolled team is installed in the local login keychain
    verification: "Run `security find-identity -v -p codesigning | grep 'Developer ID Application'` — prints at least one identity line; capture the SHA1 / Team ID in the setup doc"
  - criterion: "A `notarytool` keychain profile named `AC_PASSWORD` is stored with Apple ID, team ID, and an app-specific password"
    verification: Run `xcrun notarytool history --keychain-profile AC_PASSWORD` — exits 0 (or exits 0 with an empty history). Profile presence is sufficient; history may be empty.
  - criterion: "`docs/signing/APPLE_DEVELOPER_SETUP.md` documents the exact commands used (with secrets redacted) and the Team ID + Bundle ID combination Cyboflow will sign against"
    verification: "`test -f docs/signing/APPLE_DEVELOPER_SETUP.md` and `grep -n 'Team ID' docs/signing/APPLE_DEVELOPER_SETUP.md` returns at least one match"
depends_on: []
estimated_complexity: medium
epic: apple-signing-notarization-setup
test_strategy:
  needed: false
  justification: Manual external-account provisioning task; verification is provided by the four CLI-based acceptance checks above. No code is modified.
prerequisites:
  - check: "test -n \"$APPLE_ID\" || echo 'WARN: APPLE_ID not in shell env; will set during this task'"
    fix: "Capture APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD via this task's documented flow"
    description: "Cyboflow's signed build pipeline (scripts/configure-build.js lines 19-25) requires APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_SPECIFIC_PASSWORD env vars at build time. This task is the source-of-truth for obtaining them."
    blocking: false
  - check: "xcrun --version >/dev/null 2>&1"
    fix: "Install Xcode Command Line Tools: `xcode-select --install`"
    description: "`notarytool` ships with Xcode CLT. Without it, no notarization is possible."
    blocking: true
---
# Apple Developer Program enrollment, Developer ID cert, and notarytool keychain profile

## Objective

Provision the Apple-side prerequisites that every downstream task in this epic depends on: an active Apple Developer Program membership, an installed `Developer ID Application` signing certificate, and a `notarytool` keychain profile named `AC_PASSWORD`. Without this, no signed build can be produced — and Apple Developer enrollment has a 24–48 hour identity verification lag, so this task must start first and may block for up to two business days.

## Implementation Steps

1. **Confirm enrollment status.** Open https://developer.apple.com/account and verify the signing-in account has an active Apple Developer Program membership ($99/yr). If not enrolled, complete enrollment as an individual (faster, no D-U-N-S requirement) and **STOP here**; resume the rest of the steps after Apple completes identity verification (24–48 h). Record the Team ID shown on the Membership page.

2. **Create the signing certificate.** In Xcode → Settings → Accounts → Manage Certificates → `+` → `Developer ID Application`. Xcode generates a CSR, submits it to Apple, downloads the resulting cert, and adds it to the login keychain. Alternatively, generate the CSR via Keychain Access → Certificate Assistant and upload it at https://developer.apple.com/account/resources/certificates/add. Verify with:
   