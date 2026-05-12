---
id: TASK-056
idea: IDEA-002
status: ready
created: "2026-05-11T00:00:00Z"
files_owned:
  - docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md
files_readonly:
  - docs/signing/FIRST_SIGNED_BUILD_LOG.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: The signed-and-notarized DMG from TASK-055 launches on a clean macOS user account with no Gatekeeper warning dialog
    verification: "On the test user account, run `spctl --assess --type execute --verbose /Applications/Cyboflow.app` — prints `accepted` and `source=Notarized Developer ID`. Visual confirmation: the app opens its main window without macOS displaying any 'unidentified developer' or 'app downloaded from internet' modal."
  - criterion: "The app's bundled PTY subsystem (node-pty) can spawn at least one child process under hardened runtime without crashing"
    verification: "Inside the launched app, perform any action that spawns Claude Code or any PTY subprocess (the simplest trigger is creating a session). Confirm via `ps -ef | grep -i claude` from a separate Terminal that a child process actually launched. Alternatively, open Console.app, filter on the app process, and confirm no `EXC_BAD_INSTRUCTION` or `Code Signature Invalid` errors in the last 5 minutes."
  - criterion: The app can write to its data directory under hardened runtime
    verification: "After running the app for at least 30 seconds with one session-creation interaction, confirm the data dir contains a populated SQLite DB: `test -s ~/.cyboflow/cyboflow.db || test -s ~/.crystal/crystal.db` exits 0. (Either dir name passes — the rebrand to ~/.cyboflow is owned by a different epic.)"
  - criterion: "`docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` records: test user account name (anonymized), macOS version, DMG SHA256, the three CLI verification outputs verbatim, and any anomalies observed during runtime smoke"
    verification: "`test -f docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` AND `grep -c 'macOS\\|SHA256\\|spctl' docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` is >= 3"
depends_on:
  - TASK-055
estimated_complexity: medium
epic: apple-signing-notarization-setup
test_strategy:
  needed: false
  justification: Manual acceptance test on a clean user account. The verification commands in acceptance criteria are the test cases; automating cross-account Gatekeeper testing requires VM infrastructure that is out of scope for v1.
prerequisites:
  - check: "test -f dist-electron/*-macOS-universal.dmg 2>/dev/null"
    fix: Run TASK-055 to produce the signed DMG
    description: This task requires the DMG artifact from TASK-055; without it there is nothing to test.
    blocking: true
  - check: "sw_vers -productVersion >/dev/null 2>&1"
    fix: This task must run on macOS — sw_vers is missing on non-macOS shells.
    description: Gatekeeper is a macOS subsystem; the acceptance test cannot run on Linux or Windows.
    blocking: true
---
# Clean-account Gatekeeper acceptance test

## Objective

Verify the TASK-055 DMG passes Gatekeeper on a clean macOS user account — not on the developer's primary account, where past `sudo spctl --master-disable` or `xattr -d com.apple.quarantine` interventions can mask Gatekeeper failures. This is the final gate of the apple-signing-notarization-setup epic and the proof that packaging is a known-good operation before Milestone 2's MVP-done bar.

## Implementation Steps

1. **Create or use a clean local user account** on the developer's Mac via System Settings → Users & Groups → Add User → Standard User. Name it something memorable like `cyboflow-signing-test`. This account must:
   - Have never run any unsigned Cyboflow/Crystal build
   - Have default Gatekeeper settings (System Settings → Privacy & Security → Allow apps from: "App Store & Known Developers")
   - Have no `spctl --master-disable` history

   If a clean account is not available, the next-best is a fresh VM (Parallels/UTM with a clean macOS install). Document which option is used.

2. **Copy the DMG** from the dev account to the test account's Downloads folder. Use Finder drag-drop or `cp` with `/Users/Shared/` as a relay. Confirm `xattr -p com.apple.quarantine ~/Downloads/Cyboflow-*.dmg` returns a quarantine flag (`0083;...`) — this confirms the file is being treated as user-downloaded.

3. **Compute the DMG SHA256** before mounting so the test log references the exact artifact:
   