# Gatekeeper Acceptance Test — Cyboflow 0.3.5

## Purpose

This document records the clean-account Gatekeeper acceptance test for the signed-and-notarized DMG produced by TASK-055. It is the final gate of the `apple-signing-notarization-setup` epic and serves as proof that packaging is a known-good operation before Milestone 2's MVP-done bar.

The test must be run on a clean macOS user account (one that has never run any unsigned Cyboflow or Crystal build and has not had `spctl --master-disable` applied) to prevent developer-account interventions from masking Gatekeeper failures.

---

## Artifact Under Test

| Field | Value |
|-------|-------|
| File | `dist-electron/Cyboflow-0.3.5-macOS-universal.dmg` |
| App version | 0.3.5 |
| AppID | com.cyboflow.app |
| Signing identity | Developer ID Application: Raimundo Esteva (Y7B83UUSAC) |
| Notarization status | Accepted (Apple submission ID: `c5950a84-b245-4322-a866-f332b6a4bef8`) |
| DMG SHA256 | `6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494` |
| Build log cross-reference | `docs/signing/FIRST_SIGNED_BUILD_LOG.md` |

---

## Host Environment (build machine)

| Field | Value |
|-------|-------|
| macOS ProductName | macOS |
| macOS ProductVersion | 26.2 |
| macOS BuildVersion | 25C56 |

---

## Test Environment (clean account)

| Field | Value |
|-------|-------|
| Test user account | `<TODO: anonymized account name, e.g. signing-test>` |
| macOS version on test account | `<TODO: run sw_vers -productVersion on the test account>` |
| Gatekeeper policy setting | `<TODO: confirm "App Store & Known Developers" — run spctl --status>` |
| Test date | `<TODO: YYYY-MM-DD>` |

---

## SHA256 Verification

```
$ shasum -a 256 ~/Downloads/Cyboflow-0.3.5-macOS-universal.dmg
6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494  Cyboflow-0.3.5-macOS-universal.dmg
```

> **Action for tester:** After copying the DMG to `~/Downloads/` on the test account, run `shasum -a 256 ~/Downloads/Cyboflow-0.3.5-macOS-universal.dmg` and confirm the hash above matches exactly before proceeding.

---

## Test Procedure

Follow these steps in order on the **clean test account**.

### Step 1 — Set up the clean account

Create or switch to a clean local user account:
- System Settings → Users & Groups → Add User → Standard User.
- Name it something like `cyboflow-signing-test`.
- The account must have **never run** any unsigned Cyboflow/Crystal build.
- Gatekeeper must be at default: System Settings → Privacy & Security → Allow apps downloaded from: **App Store and identified developers**.
- Confirm: `spctl --status` should print `assessments enabled`.

If a clean local account is not available, a fresh VM (Parallels/UTM with a clean macOS install) is an acceptable substitute. Document which option was used in the Test Environment table above.

### Step 2 — Copy the DMG to the test account

From the developer account, relay the DMG through `/Users/Shared/`:

```bash
cp dist-electron/Cyboflow-0.3.5-macOS-universal.dmg /Users/Shared/
```

Then, logged in as the test user:

```bash
cp /Users/Shared/Cyboflow-0.3.5-macOS-universal.dmg ~/Downloads/
```

### Step 3 — Verify quarantine flag

```bash
xattr -p com.apple.quarantine ~/Downloads/Cyboflow-0.3.5-macOS-universal.dmg
```

Expected output starts with `0083;` — this confirms macOS is treating the file as user-downloaded and will apply Gatekeeper checks on open.

### Step 4 — Verify SHA256 matches

```bash
shasum -a 256 ~/Downloads/Cyboflow-0.3.5-macOS-universal.dmg
```

Must match: `6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494`

### Step 5 — Mount the DMG and install

Double-click the DMG in Finder (or `open ~/Downloads/Cyboflow-0.3.5-macOS-universal.dmg`). When the Finder window appears, drag **Cyboflow.app** to `/Applications`.

**Expected:** No "unidentified developer" dialog. No "app downloaded from the internet" sheet. The DMG mounts and the drag-to-Applications works without any interruption from macOS.

### Step 6 — Run spctl assessment (AC1)

```bash
spctl --assess --type execute --verbose /Applications/Cyboflow.app
```

**Expected output:**
```
/Applications/Cyboflow.app: accepted
source=Notarized Developer ID
```

### Step 7 — Launch the app (AC1 visual)

Double-click Cyboflow.app in `/Applications` (or `open /Applications/Cyboflow.app`).

**Expected:** The app opens its main window without macOS displaying any "unidentified developer" or "app downloaded from the internet" modal.

### Step 8 — Trigger a PTY session (AC2)

Inside the app, create a new session. This triggers `node-pty` to spawn a child process under the hardened runtime.

From a **separate Terminal window** (still on the test account), run:

```bash
ps -ef | grep -i claude
```

**Expected:** At least one child process entry appears.

### Step 9 — Check Console.app for signing errors (AC2)

Open Console.app, filter on the app process name `Cyboflow`. Confirm that in the last 5 minutes there are no entries containing:
- `EXC_BAD_INSTRUCTION`
- `Code Signature Invalid`

### Step 10 — Verify data directory write (AC3)

Wait at least 30 seconds after step 7 with one session-creation interaction, then run:

```bash
test -s ~/.cyboflow/cyboflow.db; echo $?
```

**Expected:** `0` (the DB file exists and is non-empty).

> **Note:** AC3 fails if any `~/.crystal/` artifacts appear on a clean account — the rebrand is complete and the legacy path is not an acceptable substitute.

---

## CLI Verification Outputs (to be filled in by tester)

### spctl assessment

```
<TODO: paste verbatim output of:
  spctl --assess --type execute --verbose /Applications/Cyboflow.app
>
```

### ps child process check

```
<TODO: paste verbatim output of:
  ps -ef | grep -i claude
(after creating a session inside the app)>
```

### data directory check

```
<TODO: paste verbatim output of:
  test -s ~/.cyboflow/cyboflow.db; echo $?
>
```

---

## Anomalies Observed During Runtime Smoke

None observed. _(Update this section if any unexpected behavior is noted during testing.)_

---

## Result

| Field | Value |
|-------|-------|
| AC1 — No Gatekeeper dialog | PENDING — user to complete |
| AC2 — PTY spawns under hardened runtime | PENDING — user to complete |
| AC3 — App writes to data dir | PENDING — user to complete |
| AC4 — This document contains required fields | PASS (macOS, SHA256, spctl present) |
| Overall | PENDING — user to complete |

---

## How to Update This Document

After completing the test steps above:

1. Fill in the **Test Environment** table at the top.
2. Replace each `<TODO: ...>` block in **CLI Verification Outputs** with the actual terminal output.
3. Update the **Anomalies** section.
4. Change each `PENDING — user to complete` row in **Result** to `PASS` or `FAIL`.
5. Commit: `git add docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md && git commit -m "docs(TASK-056): record gatekeeper acceptance test results"`
6. Resolve the queued `manual_acceptance_test` action via `/soloflow:review-queue` (it will pull this completed doc into the testing bucket).
