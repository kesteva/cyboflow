# Gatekeeper Acceptance Checklist (reusable)

Run this checklist after a **signing-config change** (new cert, entitlements, electron-builder /
Electron / macOS bump) or before announcing a new signed release, to confirm a clean download
installs and launches without a Gatekeeper warning. This is a **procedure, not a per-build
record** — you don't commit results. If a step fails, fix it and note the cause + fix in
`APPLE_DEVELOPER_SETUP.md` → "Known Build Pitfalls". Artifact hashes are captured automatically
in the published `latest-mac.yml`; user-facing changes go in `CHANGELOG.md`.

Replace `<version>` below with the release version (`package.json` → `version`).

## Preconditions — clean account

- [ ] A clean macOS user account that has **never run** an unsigned Cyboflow/Crystal build and has **not** had `spctl --master-disable` applied. (A fresh VM is an acceptable substitute.)
- [ ] Gatekeeper at default: System Settings → Privacy & Security → "App Store and identified developers".
- [ ] `spctl --status` prints `assessments enabled`.

## Procedure (run on the clean account)

1. **Relay the DMG to the test account** via `/Users/Shared/`, then copy to `~/Downloads/`:
   ```bash
   # developer account:
   cp dist-electron/Cyboflow-<version>-macOS-universal.dmg /Users/Shared/
   # test account:
   cp /Users/Shared/Cyboflow-<version>-macOS-universal.dmg ~/Downloads/
   ```
   - [ ] DMG present in `~/Downloads/` on the test account.

2. **Quarantine flag is set** (confirms macOS treats it as a real download):
   ```bash
   xattr -p com.apple.quarantine ~/Downloads/Cyboflow-<version>-macOS-universal.dmg
   ```
   - [ ] Output starts with `0083;`.

3. **SHA256 matches** the published artifact (from `latest-mac.yml` / your build output):
   ```bash
   shasum -a 256 ~/Downloads/Cyboflow-<version>-macOS-universal.dmg
   ```
   - [ ] Hash matches the distributed artifact.

4. **Mount + install** — double-click the DMG, drag `Cyboflow.app` to `/Applications`.
   - [ ] No "unidentified developer" dialog and no "downloaded from the internet" sheet.

5. **spctl assessment**:
   ```bash
   spctl --assess --type execute --verbose /Applications/Cyboflow.app
   ```
   - [ ] Output: `accepted` / `source=Notarized Developer ID`.

6. **Launch** — double-click `Cyboflow.app`.
   - [ ] Main window opens with no Gatekeeper / quarantine modal.

7. **PTY under hardened runtime** — create a session in-app, then from a separate Terminal:
   ```bash
   ps -ef | grep -i claude
   ```
   - [ ] At least one child process appears.

8. **No signing errors in Console** — Console.app, filter `Cyboflow`, last 5 min:
   - [ ] No `EXC_BAD_INSTRUCTION` and no `Code Signature Invalid`.

9. **Data directory write** — after ~30s and one session interaction:
   ```bash
   test -s ~/.cyboflow/sessions.db; echo $?
   ```
   - [ ] Prints `0` (DB exists, non-empty). No `~/.crystal/` artifacts appear.

If anything fails, see `APPLE_DEVELOPER_SETUP.md` → "Known Build Pitfalls".
