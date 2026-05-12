# Apple Developer Setup for Cyboflow

Reference doc for the Apple-side prerequisites that the signed-and-notarized
macOS build pipeline depends on. Captures the values used and the exact
commands run during initial provisioning, so renewal (when the cert expires)
and onboarding a second signer take minutes, not hours.

## Identity

| Field                  | Value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| Apple ID               | rkesteva@gmail.com                                          |
| Team ID                | `Y7B83UUSAC`                                                |
| Bundle ID              | `com.cyboflow.app` (see `package.json` → `build.appId`)     |
| Signing identity (CN)  | `Developer ID Application: Raimundo Esteva (Y7B83UUSAC)`    |
| Cert SHA1              | `507352C3D4AEAF3B56DB0B788C4B624CFD4284BC`                  |
| Cert validity          | 2026-05-12 → **2027-02-01** (renew before this date)        |
| notarytool profile     | `AC_PASSWORD` (stored in login keychain)                    |

Note: a separate `Apple Development: rkesteva@gmail.com (2BG3N2H377)` cert
exists under a different team ID and is used for local dev only. Distribution
signing uses **`Y7B83UUSAC`** — that is the value to export as `APPLE_TEAM_ID`
at build time.

## Provisioning Commands

The following commands were run in order to provision the local machine.
Secrets (passwords) are redacted; replace with values from a secure source.

1. **Apple Developer Program enrollment** — completed at
   https://developer.apple.com/account (individual enrollment, $99/yr).
   No CLI step.

2. **Developer ID Application certificate** — created via Xcode → Settings →
   Accounts → Manage Certificates → `+` → `Developer ID Application`. Xcode
   generated the CSR, submitted it, and installed the cert in the login
   keychain. (Apple caps Developer ID certs at ~2 per team — don't burn one
   casually.)

3. **App-specific password** — generated at
   https://appleid.apple.com → Sign-In & Security → App-Specific Passwords,
   labeled `cyboflow-notarytool`.

4. **notarytool keychain profile**:

   ```bash
   xcrun notarytool store-credentials AC_PASSWORD \
     --apple-id rkesteva@gmail.com \
     --team-id Y7B83UUSAC \
     --password <app-specific-password>
   ```

## Verification

All four commands should pass before TASK-052..056 can run a signed build.

```bash
# 1. Xcode CLT present (provides xcrun/notarytool)
xcrun --version
# → xcrun version 72.

# 2. Developer ID Application cert installed and private key paired
security find-identity -v -p codesigning | grep "Developer ID Application"
# → 2) 507352C3D4AEAF3B56DB0B788C4B624CFD4284BC "Developer ID Application: Raimundo Esteva (Y7B83UUSAC)"

# 3. notarytool keychain profile authenticates against Apple
xcrun notarytool history --keychain-profile AC_PASSWORD
# → "No submission history." (exit 0) before the first build, populated after

# 4. Cert chain and expiry
security find-certificate -c "Developer ID Application" -p \
  | openssl x509 -noout -subject -issuer -dates
# → subject=... CN=Developer ID Application: Raimundo Esteva (Y7B83UUSAC) ...
# → issuer=CN=Developer ID Certification Authority, ...
# → notAfter=Feb  1 22:12:15 2027 GMT
```

## Build-Time Environment Variables

`scripts/configure-build.js` gates the signed-posture build on these env vars.
All five must be set in the shell that invokes `pnpm run build:mac:universal`
(or `release:mac`); otherwise the build silently downgrades to unsigned.

| Variable                       | Value                                              |
| ------------------------------ | -------------------------------------------------- |
| `APPLE_ID`                     | rkesteva@gmail.com                                 |
| `APPLE_TEAM_ID`                | `Y7B83UUSAC`                                       |
| `APPLE_APP_SPECIFIC_PASSWORD`  | (the app-specific password from step 3, redacted) |
| `CSC_LINK`                     | path to a `.p12` export of the Developer ID cert   |
| `CSC_KEY_PASSWORD`             | passphrase used when exporting the `.p12`          |

To produce the `.p12`: Keychain Access → right-click the Developer ID
Application cert (with its private key disclosed beneath it) → Export… →
`.p12` format → set a passphrase. Store the `.p12` and passphrase in a
password manager; do not commit them.

## Renewal

The current certificate expires **2027-02-01**. To renew:

1. Open Xcode → Settings → Accounts → Manage Certificates → `+` →
   `Developer ID Application`. Apple issues a new cert with a new SHA1.
2. Re-export to `.p12` and update `CSC_LINK` / `CSC_KEY_PASSWORD`.
3. Update the **Cert SHA1** and **Cert validity** rows in the Identity table
   above.
4. The notarytool keychain profile (`AC_PASSWORD`) does **not** need to be
   re-created — it authenticates via Apple ID + app-specific password, not
   the cert. It only needs refresh if the app-specific password is revoked.

The old cert remains valid for any binary signed before 2027-02-01;
notarization tickets stay stapled to those binaries indefinitely. Only new
builds need the renewed cert.
