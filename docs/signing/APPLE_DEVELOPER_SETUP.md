# Apple Developer Setup for Cyboflow

Reference doc for the Apple-side prerequisites that the signed-and-notarized
macOS build pipeline depends on. Captures the values used and the exact
commands run during initial provisioning, so renewal (when the cert expires)
and onboarding a second signer take minutes, not hours.

---

## Identity

| Field                  | Value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| Apple ID               | `<APPLE_ID>` (rkesteva@gmail.com)                           |
| Team ID                | `<TEAM_ID>` (Y7B83UUSAC)                                   |
| Bundle ID              | `com.cyboflow.app` (see `package.json` → `build.appId`)     |
| Signing identity (CN)  | `Developer ID Application: Raimundo Esteva (Y7B83UUSAC)`    |
| Cert SHA1              | `507352C3D4AEAF3B56DB0B788C4B624CFD4284BC`                  |
| Cert validity          | 2026-05-12 → **2027-02-01** (renew before this date)        |
| notarytool profile     | `AC_PASSWORD` (stored in login keychain)                    |

Note: a separate `Apple Development: rkesteva@gmail.com (2BG3N2H377)` cert
exists under a different team ID and is used for local dev only. Distribution
signing uses **`Y7B83UUSAC`** — that is the value to export as `APPLE_TEAM_ID`
at build time.

All signing identifiers (Apple ID, Team ID, cert SHA1, notarytool submission
IDs) are committed in plain text in `docs/signing/`. The only secret is
`APPLE_APP_SPECIFIC_PASSWORD`, which is never committed.

---

## Prerequisites

Before starting the provisioning steps, verify Xcode Command Line Tools are
installed. `notarytool` ships as part of the Xcode CLT package; without it,
no notarization command is available.

```bash
# Check that xcrun is present
xcrun --version
# Expected output: xcrun version 72. (or higher)
```

If this command fails:

```bash
xcode-select --install
```

Follow the on-screen prompts. The CLT package is ~1.5 GB and takes a few
minutes to install. You do not need the full Xcode IDE — CLT alone provides
`xcrun`, `notarytool`, `codesign`, and `stapler`.

---

## Provisioning Steps

### Step 1 — Apple Developer Program enrollment

1. Open https://developer.apple.com/account and sign in with `<APPLE_ID>`.
2. In the sidebar, choose **Membership Details**. If you see an active paid
   membership (Individual, $99/yr), skip to Step 2.
3. If not enrolled, click **Enroll** and follow the prompts. Individual
   enrollment (no D-U-N-S number required) is faster; organization enrollment
   requires a D-U-N-S lookup that can add 24–48 hours on top of identity
   verification.
4. **Identity verification takes 24–48 hours.** Apple sends an email when the
   account is approved. You cannot create a Developer ID Application
   certificate until verification completes. Plan accordingly — this step must
   start at least two business days before the first signed build.
5. Once the membership is active, go to **Membership Details** and record the
   **Team ID** (a 10-character alphanumeric string). This is `<TEAM_ID>` and
   must be set as `APPLE_TEAM_ID` at build time.

> **Apple caps Developer ID Application certificates.** Each team is allowed
> approximately 2 active Developer ID Application certs at a time. Do not
> create one casually — revocation cannot be undone.

---

### Step 2 — Create the Developer ID Application certificate

**Option A: Via Xcode (recommended — handles the CSR automatically)**

1. Open Xcode → **Settings** (⌘,) → **Accounts** tab.
2. Select your Apple ID. Click **Manage Certificates…**.
3. Click **+** in the bottom-left corner → choose **Developer ID Application**.
4. Xcode generates a Certificate Signing Request (CSR), submits it to Apple's
   Certificate Authority, downloads the signed certificate, and installs it
   in your login keychain — all automatically.
5. Close the Manage Certificates sheet. The cert is now in your keychain.

**Option B: Via Apple Developer Portal + Keychain Access (manual)**

1. Open **Keychain Access** (Applications → Utilities).
2. Menu bar: **Keychain Access → Certificate Assistant → Request a Certificate
   From a Certificate Authority…**
3. Fill in:
   - **User Email Address**: `<APPLE_ID>`
   - **Common Name**: any descriptive name (e.g., `cyboflow-signing`)
   - **CA Email Address**: leave blank
   - **Request is**: Saved to disk
4. Save the `.certSigningRequest` file.
5. In a browser, open https://developer.apple.com/account/resources/certificates/add.
6. Choose **Developer ID Application** → **Continue**.
7. Upload the `.certSigningRequest` file. Apple generates the certificate.
8. Download the `.cer` file and double-click it — Keychain Access imports it.

Verify the certificate is installed and its private key is accessible:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
# Expected output (one line per cert):
# N) <SHA1>  "Developer ID Application: <YOUR NAME> (<TEAM_ID>)"
```

The number at the start (`N)`) indicates the cert is valid and the private key
is present in the login keychain. If you see the cert listed but prefixed with
a status like `(CSSMERR_TP_NOT_TRUSTED)`, the cert chain is broken — usually
fixed by downloading and importing the **Developer ID Intermediate** CA from
https://www.apple.com/certificateauthority/.

> **Record the SHA1 hash** printed by the command above. Update the
> **Cert SHA1** row in the Identity table at the top of this document.

---

### Step 3 — Generate an app-specific password for notarytool

`notarytool` authenticates against Apple using your Apple ID and an
**app-specific password** (not your regular Apple ID password). Two-factor
authentication must be enabled on the Apple ID account before app-specific
passwords can be generated.

1. Open https://appleid.apple.com and sign in.
2. Navigate to **Sign-In & Security → App-Specific Passwords**.
3. Click **Generate an App-Specific Password**.
4. Enter a label, e.g., `cyboflow-notarytool`. Apple generates a
   16-character password in the form `xxxx-xxxx-xxxx-xxxx`.
5. **Copy it immediately** — Apple shows it only once. Store it in your
   password manager under a label like `cyboflow notarytool app-specific pw`.

This password becomes `<APPLE_APP_SPECIFIC_PASSWORD>` in the provisioning
command below and `APPLE_APP_SPECIFIC_PASSWORD` in the build environment.

> App-specific passwords do not expire on their own, but are invalidated if
> you change your Apple ID password or if you revoke them manually. If
> notarytool starts failing with an authentication error, generating a new
> app-specific password and re-running Step 4 fixes it.

---

### Step 4 — Create the notarytool keychain profile

Store the Apple ID, Team ID, and app-specific password in the login keychain
under the profile name `AC_PASSWORD`. This profile name is used by the build
pipeline (future `afterSign.js` hook) to authenticate without exposing secrets
in environment variables or shell history.

```bash
xcrun notarytool store-credentials AC_PASSWORD \
  --apple-id <APPLE_ID> \
  --team-id <TEAM_ID> \
  --password <APPLE_APP_SPECIFIC_PASSWORD>
```

Replace:
- `<APPLE_ID>` with your Apple ID email address
- `<TEAM_ID>` with the 10-character Team ID from Step 1
- `<APPLE_APP_SPECIFIC_PASSWORD>` with the password generated in Step 3

When prompted, you may be asked to confirm which keychain to store the profile
in — choose your **login keychain**.

The command exits 0 on success with output similar to:

```
Validating your credentials...
Success. Credentials validated.
Saved credentials for profile: AC_PASSWORD
```

If it exits with a non-zero status or prints an authentication error, check:
- The app-specific password is correct and was not truncated when copied
- The Team ID matches the team that owns the Developer ID Application cert
- Your Apple ID has an active Apple Developer Program membership

---

## Verify Your Setup

Run all four commands after completing the provisioning steps. Every command
must succeed (exit 0) before downstream signing tasks (TASK-052 through
TASK-056) can produce a signed build.

### Check 1 — Xcode Command Line Tools present

```bash
xcrun --version
```

Expected output: `xcrun version 72.` (or any version number). A non-zero exit
or `xcrun: error: invalid active developer path` means the CLT is not
installed — run `xcode-select --install`.

---

### Check 2 — Developer ID Application certificate installed with private key

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Expected output (one or more lines matching):

```
  2) 507352C3D4AEAF3B56DB0B788C4B624CFD4284BC "Developer ID Application: Raimundo Esteva (Y7B83UUSAC)"
```

- If no output: the cert is not in the keychain. Repeat Step 2.
- If the line appears but a leading status code like `CSSMERR_TP_NOT_TRUSTED`
  is shown: the intermediate CA certificate is missing. Download it from
  https://www.apple.com/certificateauthority/ (look for "Developer ID
  Certification Authority") and import it into the System keychain.
- If the line appears but without a private key (cert only, no arrow or sub-
  entry in Keychain Access): the signing private key was generated on a
  different machine and is not present here. Export the cert + private key as
  a `.p12` from the original machine and import on this machine.

---

### Check 3 — notarytool keychain profile authenticates against Apple

```bash
xcrun notarytool history --keychain-profile AC_PASSWORD
```

Expected output on success (profile present, no prior submissions):

```
No submission history.
```

Or if prior builds have been notarized, a table of submission IDs and
statuses. Either way the command must **exit 0**.

- If it exits non-zero with `No Apple ID in keychain`: the profile was not
  created. Repeat Step 4.
- If it exits non-zero with an authentication error: the app-specific password
  has been revoked or the Team ID is wrong. Regenerate the app-specific
  password (Step 3) and re-run Step 4.

---

### Check 4 — Certificate chain and expiry

```bash
security find-certificate -c "Developer ID Application" -p \
  | openssl x509 -noout -subject -issuer -dates
```

Expected output:

```
subject=UID = Y7B83UUSAC, CN = Developer ID Application: Raimundo Esteva (Y7B83UUSAC), OU = Y7B83UUSAC, O = Raimundo Esteva, C = US
issuer=CN = Developer ID Certification Authority, OU = Apple Certification Authority, O = Apple Inc., C = US
notBefore=May 12 20:12:15 2026 GMT
notAfter=Feb  1 22:12:15 2027 GMT
```

Verify:
- `issuer` contains `Developer ID Certification Authority` (not just
  `Apple Worldwide Developer Relations`)
- `notAfter` is in the future
- The Team ID in `subject` matches `<TEAM_ID>` from Step 1

---

## Build-Time Environment Variables

`scripts/configure-build.js` reads these environment variables to decide
whether to enable the signed + notarized build posture. All five must be set
in the shell that invokes `pnpm run build:mac:universal` (or `release:mac`);
if any are missing, the script silently downgrades to an unsigned build.

| Variable                       | Source                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| `APPLE_ID`                     | Your Apple ID email (`<APPLE_ID>`)                         |
| `APPLE_TEAM_ID`                | Team ID from Step 1 (`<TEAM_ID>`)                          |
| `APPLE_APP_SPECIFIC_PASSWORD`  | App-specific password from Step 3 (secret, never commit)  |
| `CSC_LINK`                     | File path (or base64) of the `.p12` cert export            |
| `CSC_KEY_PASSWORD`             | Passphrase used when exporting the `.p12`                  |

### How to export the `.p12`

1. Open **Keychain Access** (Applications → Utilities).
2. Under **My Certificates**, find `Developer ID Application: <YOUR NAME>
   (<TEAM_ID>)`. It must have a disclosure arrow showing the private key
   beneath it.
3. Right-click the cert (not the private key) → **Export…**
4. Choose **Personal Information Exchange (.p12)** format.
5. Set a strong passphrase. Store the `.p12` file and the passphrase in your
   password manager.
6. **Do not commit the `.p12` to the repository.** It is a full signing
   credential; anyone who has it can sign code as your identity.

Set `CSC_LINK` to the absolute path of the `.p12` file, e.g.:

```bash
export CSC_LINK="/Users/<USERNAME>/keys/cyboflow-developer-id.p12"
export CSC_KEY_PASSWORD="<passphrase>"
```

### Minimal signed build invocation

```bash
export APPLE_ID="<APPLE_ID>"
export APPLE_TEAM_ID="<TEAM_ID>"
export APPLE_APP_SPECIFIC_PASSWORD="<APPLE_APP_SPECIFIC_PASSWORD>"
export CSC_LINK="/path/to/cyboflow-developer-id.p12"
export CSC_KEY_PASSWORD="<passphrase>"

pnpm run build:mac:universal
```

### configure-build.js contract

`scripts/configure-build.js` rewrites `package.json` **in place** before invoking
`electron-builder`, and is run automatically by every `pnpm run build:mac:*` script.
The fields it rewrites on every invocation:

| Field                           | Signed (all 5 env vars set) | Unsigned        |
| ------------------------------- | --------------------------- | --------------- |
| `build.mac.notarize`            | `true`                      | `false`         |
| `build.mac.hardenedRuntime`     | `true`                      | `false`         |
| `build.mac.entitlements`        | `build/entitlements.mac.plist` | deleted       |
| `build.mac.entitlementsInherit` | `build/entitlements.mac.plist` | deleted       |

The committed values in `package.json` (e.g. `"notarize": true` after a signed
run) are post-run artifacts, not defaults — the script overwrites them every
build based on the env vars present at that moment.

**Never invoke `electron-builder` directly.** Always use `pnpm run build:mac:universal`
(or another `build:mac:*` / `release:mac` script). Skipping the npm script skips
`configure-build.js`, leaving the signed/unsigned posture determined by whatever
is committed in `package.json` rather than by the env vars in your shell.

> TASK-052 flips the `hardenedRuntime` and `notarize` defaults in
> `package.json`. TASK-053 creates `build/entitlements.mac.plist`. TASK-054
> replaces `build/afterSign.js` with the actual `notarytool` submission call.
> TASK-051 (this task) is the prerequisite for all of them.

---

## Renewal

The current certificate expires **2027-02-01**. Certificate renewal does not
affect existing signed binaries — notarization tickets are stapled to those
binaries and remain valid indefinitely.

To renew before expiry:

1. In Xcode → Settings → Accounts → Manage Certificates → `+` →
   `Developer ID Application`. Apple issues a new cert. The old cert is
   not automatically revoked.
2. Verify the new cert with Check 2 above. Record the new SHA1.
3. Re-export to `.p12` (see above). Update `CSC_LINK` / `CSC_KEY_PASSWORD`.
4. Update the **Cert SHA1** and **Cert validity** rows in the Identity table
   at the top of this document and commit the change.
5. The `AC_PASSWORD` notarytool keychain profile does **not** need to be
   re-created — it authenticates via Apple ID + app-specific password, not
   the cert. It only needs refresh if the app-specific password is revoked
   (see Step 3 for regeneration).

> If the certificate expires before renewal and a new build is needed, the
> new cert covers new builds only. Binaries signed with the expired cert
> continue to run on machines where they were already notarized, but
> Gatekeeper will block new downloads of those binaries.

---

## Troubleshooting

### `codesign: error: code object is not signed at all`

`electron-builder` invoked `codesign` but could not find a valid signing
identity. Check:
- `security find-identity -v -p codesigning` lists a Developer ID Application
  identity (Check 2).
- `CSC_LINK` points to a `.p12` file that contains both the certificate and
  the private key.
- `CSC_KEY_PASSWORD` matches the passphrase used when the `.p12` was exported.

### `notarytool: error: HTTP status code: 401`

Authentication failure. The app-specific password has likely been revoked.
Generate a new one (Step 3) and re-run Step 4.

### `xcrun: error: unable to find utility "notarytool"`

The Xcode Command Line Tools version installed is older than Xcode 13 (the
version that introduced `notarytool`). Run:

```bash
sudo rm -rf /Library/Developer/CommandLineTools
xcode-select --install
```

### `The signature of the binary is invalid` during notarization

Most common cause: a native `.node` binary or helper executable was not
code-signed before submission. `electron-builder` handles signing of files in
`asarUnpack`, but only those matched by the `files` and `asarUnpack` patterns
in `package.json`. Check that `node_modules/**/*.node` is listed in
`asarUnpack` (it is, as of the current `package.json`).

### Notarization submission accepted but stapling fails

`xcrun stapler staple` may fail if the CDN has not yet propagated the
notarization ticket (~5 minutes after `notarytool` reports `Accepted`). Wait
5–10 minutes and retry. If it continues to fail after 30 minutes, re-check the
Apple status page at https://developer.apple.com/system-status/.

---

## Recording a Signed Build

After `pnpm run build:mac:universal` produces a signed-and-notarized DMG,
capture the evidence immediately — do not reconstruct from memory or logs later.

1. Create a new directory for this release version:
   ```bash
   mkdir -p docs/signing/builds/<version>
   ```

2. Copy the build log template and fill in every `<TODO: ...>` placeholder as
   you work through the build:
   ```bash
   cp docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md \
      docs/signing/builds/<version>/FIRST_SIGNED_BUILD_LOG.md
   ```
   Record submission IDs, SHA256 hashes, and timestamps directly from the
   terminal output at the time each step completes.

3. After the clean-account Gatekeeper test completes (separate task), copy and
   fill in the Gatekeeper test template:
   ```bash
   cp docs/signing/builds/_template/GATEKEEPER_TEST_TEMPLATE.md \
      docs/signing/builds/<version>/GATEKEEPER_ACCEPTANCE_TEST.md
   ```

4. Commit both files:
   ```bash
   git add docs/signing/builds/<version>/
   git commit -m "docs: record signed build and Gatekeeper test for <version>"
   ```

See `docs/signing/builds/README.md` for the full lifecycle policy, including
the never-overwrite rule: completed `builds/<version>/` directories are
append-only audit records.

> **This directory is the audit trail for distribution — never overwrite a
> completed build's evidence.** If a rebuild is required, create a new
> directory (e.g. `builds/<version>-rebuild/`) rather than editing the
> original.

---

## Known Build Pitfalls

These are operational lessons from the 0.3.5 first signed build. Review before
starting a new signed build.

### Pitfall 1: electron-builder background kill during notarytool wait

`electron-builder` runs `notarytool submit --wait`, which polls Apple for up
to several hours on a slow first submission. If your terminal session times out
or the build runner kills the process, `electron-builder` exits non-zero but
the notarytool submission continues on Apple's side.

**Recovery:**
1. Poll `xcrun notarytool info <submission-id> --apple-id <APPLE_ID> --team-id <TEAM_ID>` until the status leaves "In Progress".
2. Manually staple the `.app`: `xcrun stapler staple dist-electron/mac-universal/Cyboflow.app`
3. Create the DMG manually: `hdiutil create -volname Cyboflow -srcfolder dist-electron/mac-universal/Cyboflow.app -ov -format UDZO dist-electron/Cyboflow-<VERSION>-macOS-universal.dmg`
4. Submit and staple the DMG separately (see Pitfall 2).

**Prevention:** Ensure the terminal session is persistent (e.g. use `tmux` or
`screen`) or increase the timeout before invoking `pnpm run build:mac:universal`.
Apple notarization for a first submission can take ~1 hour.

### Pitfall 2: DMG notarization is a separate round-trip from app notarization

The `.app` and the `.dmg` are notarized in separate `notarytool submit` calls.
`electron-builder` normally handles both inline. If the build is interrupted
after `.app` signing but before DMG creation, the DMG must be submitted
separately — adding approximately 2 minutes for a second notarytool round-trip.
Record both submission IDs in the build log.

### Pitfall 3: Apple notarization latency variance

First submission for a new app identity can take ~95 minutes; subsequent
submissions for the same app are typically 2–15 minutes. A slow notarization
does not mean the submission has failed — poll `notarytool info` rather than
re-submitting. Re-submitting produces a second (unnecessary) submission ID and
complicates the audit trail.

### Pitfall 4: configure-build.js rewrites package.json at build time

`scripts/configure-build.js` rewrites `package.json` `build.mac.notarize` (and
related fields) in place before invoking `electron-builder`. The committed value
in `package.json` is a post-run artifact, not a default; the `APPLE_*` env vars
present at build time are what actually drive the credentials and notarization
posture. A contributor invoking `electron-builder` directly (bypassing the npm
`build:mac:*` scripts) will not get configure-build.js's rewrite and may get
unexpected behavior. Always use `pnpm run build:mac:universal` (or another
`build:mac:*` / `release:mac` script). See the "configure-build.js contract"
subsection under Build-Time Environment Variables for the full field list.

### Pitfall 5: Stapling rewrites the DMG — always record the post-staple SHA256

`xcrun stapler staple` rewrites the DMG file to embed the notarization ticket.
The SHA256 of the file changes after stapling. Always record the **post-staple**
SHA256 in the Gatekeeper test record — that is the file users will download and
verify. The pre-staple SHA256 (from the `notarytool` submission record) is
preserved in the build log for cross-reference only; it will not match the
distribution artifact on disk.
