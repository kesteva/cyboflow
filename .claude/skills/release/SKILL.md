---
name: release
description: Cut a Cyboflow release end-to-end — run the full test gate (local + the Windows unit leg on CI), bump the version + changelog, build four signed/notarized macOS DMGs (stable + dev, arm64 + x64) plus two Azure-signed Windows installers on CI, publish both R2 update feeds (macOS + Windows manifests) (the in-app update channel), and cut the GitHub release. Use when asked to cut/ship/publish a release, make a release build, or roll a new version. Follows docs/RELEASE-RUNBOOK.md.
---

# Release

Execute a Cyboflow release. The authoritative procedure and its rationale live in
`docs/RELEASE-RUNBOOK.md` — read it first; this skill is the executable checklist.
Work through the phases **in order** and do not skip verification.

## Guardrails

- **Never run `build:mac:universal`** — it fails on the bundled `claude`/`codex`
  binaries. The release is **per-arch** DMGs.
- **R2 is the real release channel, not GitHub.** The app auto-updates from
  `updates.cyboflow.com/<variant>/latest-mac.yml` (R2) and never reads the GitHub
  release. Publishing GitHub without the R2 step (Phase 5) leaves every user on the
  old version. Do NOT call the release done until both R2 feeds show the new version.
- **Hold all outward actions until the user confirms.** Do the gate, bump, builds,
  and verification, then **stop and ask before** publishing to R2, pushing `main`,
  the tag, or the GitHub release — unless the user has already said to push without
  asking.
- Every mac build recompiles native modules for the Electron ABI; **restore the
  host-Node ABI afterward** — rebuild **both** or the gate fails with a `pty.node`
  / `better_sqlite3.node` `dlopen` arch mismatch:
  `pnpm rebuild better-sqlite3 @homebridge/node-pty-prebuilt-multiarch`.
- Don't launch the app while a `build:mac` runs (it can wedge the DMG eject).

## Phase 0 — Preconditions

1. Confirm a clean tree on `main` (`git status`), and read the recent log to see
   what's shipping (`git log --oneline v<last>..HEAD`).
2. Decide the new version. Default is a patch bump of the current
   `package.json` version; **ask the user** if a minor/major bump is intended.
3. Confirm creds exist in `./.envrc.local` (8 vars): Apple `APPLE_ID`,
   `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `CSC_LINK`, `CSC_KEY_PASSWORD`
   + R2 `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
4. **Re-resolve the dependency tree before gating** — the gate is otherwise
   blind to lockfile defects:
   ```bash
   pnpm install --frozen-lockfile
   ```
   `node_modules` can be self-consistent while the *lockfile* is not, so Phase 1
   would pass against dependencies that no longer match what CI installs. This
   is exactly how 0.2.9 shipped a dead E2E suite: a dep bump split `playwright`
   (1.62.1) from `@playwright/test` (1.54.1) in the lock, but the un-reinstalled
   tree still held a matched 1.54.1 pair, so the local smoke tier passed and
   every nightly after it failed at spec collection. `--frozen-lockfile` also
   hard-fails outright when `package.json` and the lockfile disagree.
   **Runs BEFORE step 5 on purpose**: it prunes to host arch, so the cross-arch
   binary check must follow it, never precede it.
5. Confirm all four agent binaries are present (a plain install prunes to host
   arch):
   ```bash
   ls -d node_modules/@anthropic-ai/claude-agent-sdk-darwin-{arm64,x64} \
         node_modules/@openai/codex-darwin-{arm64,x64}
   ```
   If any are missing, run the cross-arch install **with `--force`** (see runbook).
6. Windows leg prerequisites: `gh auth status` is logged in (dispatching
   `windows.yml` + downloading its artifacts), `osslsigncode` is installed
   (`brew install osslsigncode`), and the repo has the `AZURE_TENANT_ID` /
   `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` secrets
   (`gh secret list | grep AZURE_` shows all three).

## Phase 1 — Full test gate (all must pass)

**Start the Windows leg FIRST** — it runs on a hosted runner for ~15 min, in
parallel with everything below. The `skipIf(process.platform !== 'win32')`
suites (afterSign cases Y–AA, the named-pipe orch socket, the PowerShell
process table, taskkill, cmd.exe quoting) execute **nowhere else**, and the
POSIX-host suites have shipped Windows-only breakage before (the 9/10
verify-harness merge: `:` vs `;` PATH joins, an EBUSY unlink, real-git
timeouts). The runner needs a REMOTE ref and local `main` is normally ahead of
`origin/main`, so push a throwaway gate branch — **not `main`**, Phase 6 owns
that push:

```bash
V=<version>
git push origin HEAD:refs/heads/release-gate/$V
gh workflow run windows.yml --ref release-gate/$V -f build_installer=false
# The run is created asynchronously; wait for it to appear, then watch it.
until RUN=$(gh run list --workflow windows.yml --branch release-gate/$V --limit 1 \
  --json databaseId -q '.[0].databaseId') && [ -n "$RUN" ]; do sleep 5; done
echo "Windows gate: https://github.com/kesteva/cyboflow/actions/runs/$RUN"
```
(The branch push itself may also trigger `windows.yml` if the diff touches its
path filter — then two runs appear; both must be green, and the dispatched one
is the cheaper, unit-only run.) Continue with the local gate while it runs;
collect the verdict at the end of this phase:

```bash
gh run watch "$RUN" --exit-status          # exit 0 = Unit tests (Windows) green
git push origin --delete release-gate/$V   # cleanup, whatever the verdict
```

Local gate, in this order:

```bash
pnpm typecheck        # clean
pnpm lint             # 0 errors (warnings OK)
pnpm test:unit        # AC gate
pnpm test:integration # 18 mocked-SDK itests
pnpm run e2e:prereqs && pnpm run test:ci:minimal  # packaged-app smoke (blocking)
pnpm test:gate        # real-API canary — needs authenticated `claude` on PATH
pnpm smoke:sdk        # real-API protocol canary
```
If anything fails — the Windows run included — stop and report; do not proceed
to a build. The E2E smoke tier launches the built Electron bundle, so it needs
this machine's display; the two canaries spend real API tokens (~15-20 min
combined) and exist because CI can never run them (no authenticated `claude` on
hosted runners). The Windows run is the mirror image: it exists because this
Mac can never run those suites.

## Phase 2 — Version bump + changelog

- Bump the version in **all four** `package.json` files (root, `frontend`,
  `main`, `shared`).
- In `CHANGELOG.md`, move the `[Unreleased]` items under a new
  `## [<version>] — YYYY-MM-DD` heading (grouped Added / Changed / Fixed), derived
  from `git log --oneline v<last>..HEAD`.
  - **After the edit, confirm you did NOT eat the previous heading**: an Edit whose
    `old_string` spans `## [Unreleased]\n\n## [<prev>]` must re-add `## [<prev>]` in
    the `new_string`, or the prior release's notes merge under the new heading (and
    the Phase 6 notes-slice awk then runs to EOF). Verify:
    `grep -nE '^## \[' CHANGELOG.md | head` — the prior version heading must still
    be there, directly after your new section.
- Commit exactly those five files:
  ```bash
  git add package.json frontend/package.json main/package.json shared/package.json CHANGELOG.md
  git commit -m "chore: release <version>

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Signed-off-by: Krishna <13578267+kesteva@users.noreply.github.com>"
  ```
  Build **after** this commit — the DMGs stamp `buildInfo.gitCommit` from it, and
  the tag must point here.

## Phase 3 — Four signed macOS builds + two Windows installers

**Dispatch the Windows installers FIRST** — they build on `windows-latest` (~10 min
each, the only host that can Azure-sign) in parallel with the macOS builds. They
must build the **release commit** (DMGs and installers share `buildInfo.gitCommit`),
and `workflow_dispatch` needs a **remote** ref, so push it to a throwaway branch:

```bash
V=<version>
git push origin HEAD:refs/heads/release-build/$V      # the "chore: release" commit
for variant in stable dev; do
  gh workflow run windows.yml --ref release-build/$V -f build_installer=true -f variant=$variant
done
sleep 20; gh run list --workflow windows.yml --branch release-build/$V --limit 3 \
  --json databaseId,event,displayTitle,status
# Record the two workflow_dispatch ids as WIN_STABLE / WIN_DEV. The push itself
# may also trigger a third (push-event) run — harmless, ignore it.
```

Then the macOS builds:

```bash
set -a; . ./.envrc.local; set +a
pnpm run build:mac:arm64
pnpm run build:mac:x64
pnpm run build:mac:dev:arm64
pnpm run build:mac:dev:x64
```
Each must log `notarization successful`. `AfterSign: Claude Code path not found`
is benign.

## Phase 4 — Verify (do NOT skip)

The dev builds **reuse and overwrite** the stable staging dirs
(`dist-electron/mac-arm64/`, `dist-electron/mac/`), so by now only the **Dev**
`.app` bundles survive there — the stable ones live only inside their DMG/zip.
Validate the **dev** apps in place and the **stable** apps by mounting their DMGs.

```bash
cd dist-electron
ls -lh Cyboflow*-<version>-macOS-*.dmg   # ~304M arm64 / ~327M x64 — NOT a 215K stub

# dev apps: still in the staging dirs
for app in "mac-arm64/Cyboflow Dev.app" "mac/Cyboflow Dev.app"; do
  xcrun stapler validate "$app"          # "The validate action worked!"
  spctl -a -vvv "$app"                   # accepted / Notarized Developer ID
done
# stable apps: mount the DMG (the staging dir was overwritten by the dev build)
for arch in arm64 x64; do
  mnt=$(hdiutil attach "Cyboflow-<version>-macOS-$arch.dmg" -nobrowse -noverify -readonly | grep -o '/Volumes/.*' | head -1)
  xcrun stapler validate "$mnt/Cyboflow.app"
  spctl -a -vvv "$mnt/Cyboflow.app"
  hdiutil detach "$mnt" -quiet
done

cd .. && pnpm rebuild better-sqlite3 @homebridge/node-pty-prebuilt-multiarch  # restore host-Node ABI (BOTH)
```
If an arm64 DMG is a 215K stub, rebuild it by hand from the `.zip` (recipe in the
cross-arch memory / runbook).

**Windows installers.** Download each artifact into its OWN dir (both carry a
`latest.yml`; Phase 5 copies the right pair in per feed) and verify the
Authenticode signature from the Mac:

```bash
gh run watch "$WIN_STABLE" --exit-status && gh run watch "$WIN_DEV" --exit-status
gh run download "$WIN_STABLE" -n cyboflow-windows-x64-installer     -D dist-electron/win-stable
gh run download "$WIN_DEV"    -n cyboflow-windows-x64-installer-dev -D dist-electron/win-dev
ls -lh dist-electron/win-*/                       # each: *.exe ~300M, *.exe.blockmap, latest.yml
grep -m1 version dist-electron/win-*/latest.yml   # both = <version>
ROOT=/tmp/ms-idv-root-2020.pem      # MS serves DER; osslsigncode needs PEM
[ -f $ROOT ] || curl -sS "https://www.microsoft.com/pkiops/certs/Microsoft%20Identity%20Verification%20Root%20Certificate%20Authority%202020.crt" \
  | openssl x509 -inform DER -out $ROOT
for exe in dist-electron/win-*/*.exe; do
  osslsigncode verify -in "$exe" -CAfile $ROOT -TSA-CAfile $ROOT | grep -E 'Subject:|Succeeded|Failed|No signature'
done
```
Both must print `CN=Raimundo Esteva` and `Succeeded`. `No signature found` means
the `AZURE_*` secrets were absent on the runner — **stop**; an unsigned installer
is never published (the installed app's updater would reject it anyway).

## Phase 5 — Publish to R2, the in-app update channel (CONFIRM FIRST) — THE release

**This is the step that actually ships the update.** The app polls
`updates.cyboflow.com/<variant>/latest-mac.yml` (macOS) / `latest.yml` (Windows)
on R2 and never reads GitHub. Do **both** feeds, each carrying both platforms.
For each: merge the per-arch manifests with `gen-mac-latest-yml.mjs` (arm64 zip
first — each build overwrites `latest-mac.yml`), copy that variant's Windows trio
up from its Phase 4 dir, then upload with an explicit `PUBLISH_ONLY` allowlist so
the mixed `dist-electron` doesn't cross-contaminate feeds. See `docs/UPDATES.md`.

```bash
set -a; . ./.envrc.local; set +a
V=<version>

# stable feed
node scripts/gen-mac-latest-yml.mjs dist-electron/latest-mac.yml \
  Cyboflow-$V-macOS-arm64.zip Cyboflow-$V-macOS-arm64.dmg \
  Cyboflow-$V-macOS-x64.zip  Cyboflow-$V-macOS-x64.dmg
cat dist-electron/latest-mac.yml          # sanity: version, 4 files, path=arm64 zip
cp dist-electron/win-stable/* dist-electron/  # stable exe + blockmap + latest.yml
S="Cyboflow-$V-macOS-arm64.dmg,Cyboflow-$V-macOS-arm64.dmg.blockmap,Cyboflow-$V-macOS-arm64.zip,Cyboflow-$V-macOS-arm64.zip.blockmap,Cyboflow-$V-macOS-x64.dmg,Cyboflow-$V-macOS-x64.dmg.blockmap,Cyboflow-$V-macOS-x64.zip,Cyboflow-$V-macOS-x64.zip.blockmap,latest-mac.yml,Cyboflow-$V-Windows-x64.exe,Cyboflow-$V-Windows-x64.exe.blockmap,latest.yml"
PUBLISH_ONLY="$S" UPDATE_DRY_RUN=true pnpm publish:r2   # verify: 12 files, 3 -latest- aliases
PUBLISH_ONLY="$S" pnpm publish:r2                        # real → stable/

# dev feed
node scripts/gen-mac-latest-yml.mjs dist-electron/latest-mac.yml \
  Cyboflow-Dev-$V-macOS-arm64.zip Cyboflow-Dev-$V-macOS-arm64.dmg \
  Cyboflow-Dev-$V-macOS-x64.zip  Cyboflow-Dev-$V-macOS-x64.dmg
cp dist-electron/win-dev/* dist-electron/     # dev trio; its latest.yml OVERWRITES stable's
grep -m1 url dist-electron/latest.yml         # must name Cyboflow-Dev-…exe
D="${S//Cyboflow-$V/Cyboflow-Dev-$V}"                    # stable names → Dev names
BUILD_VARIANT=dev PUBLISH_ONLY="$D" pnpm publish:r2      # real → dev/

# verify both feeds live, both platforms
for v in stable dev; do
  curl -s https://updates.cyboflow.com/$v/latest-mac.yml | grep -m1 version
  curl -s https://updates.cyboflow.com/$v/latest.yml     | grep -m1 version
done
```

`pnpm publish:r2` is a credentialed network write — in auto/headless modes the
permission classifier may block it; if so, have the user run it (`!` prefix) or
grant the Bash rule. Do not report the release as done until both feeds show
`<version>` in **both** manifests (`latest-mac.yml` and `latest.yml`).

## Phase 6 — Push + GitHub release, archival mirror (CONFIRM FIRST)

Independent of Phase 5 — the updater never touches GitHub.

```bash
git tag v<version> <release-commit>      # the "chore: release <version>" commit
git push origin main
git push origin v<version>
awk '/^## \[<version>\]/{f=1} f&&/^## \[/&&!/\[<version>\]/{exit} f' CHANGELOG.md > /tmp/notes.md
gh release create v<version> \
  dist-electron/Cyboflow-<version>-macOS-arm64.dmg \
  dist-electron/Cyboflow-<version>-macOS-x64.dmg \
  dist-electron/Cyboflow-Dev-<version>-macOS-arm64.dmg \
  dist-electron/Cyboflow-Dev-<version>-macOS-x64.dmg \
  dist-electron/win-stable/Cyboflow-<version>-Windows-x64.exe \
  dist-electron/win-dev/Cyboflow-Dev-<version>-Windows-x64.exe \
  --title "v<version>" --notes-file /tmp/notes.md
gh release view v<version> --json assets --jq '.assets[] | "\(.name) [\(.state)]"'
git push origin --delete release-build/<version>    # Phase 3 throwaway branch
```
All six assets must read `[uploaded]`. The repo is public — the URLs are
anonymously downloadable.

## Wrap-up

Report: both R2 feeds live at `<version>` in both manifests (the update channel),
the GitHub release URL, the six artifact names/sizes, and that `main` + tag are
pushed and `release-build/<version>` is deleted. If branch
protection was bypassed on the direct push, say so.
