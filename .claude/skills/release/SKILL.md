---
name: release
description: Cut a Cyboflow release end-to-end — run the full test gate, bump the version + changelog, build four signed/notarized macOS DMGs (stable + dev, arm64 + x64), publish both R2 update feeds (the in-app update channel), and cut the GitHub release. Use when asked to cut/ship/publish a release, make a release build, or roll a new version. Follows docs/RELEASE-RUNBOOK.md.
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
- Every mac build recompiles `better-sqlite3` for the Electron ABI; **restore the
  host-Node ABI afterward** (`pnpm rebuild better-sqlite3`) or tests break.
- Don't launch the app while a `build:mac` runs (it can wedge the DMG eject).

## Phase 0 — Preconditions

1. Confirm a clean tree on `main` (`git status`), and read the recent log to see
   what's shipping (`git log --oneline v<last>..HEAD`).
2. Decide the new version. Default is a patch bump of the current
   `package.json` version; **ask the user** if a minor/major bump is intended.
3. Confirm creds exist in `./.envrc.local` (8 vars): Apple `APPLE_ID`,
   `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `CSC_LINK`, `CSC_KEY_PASSWORD`
   + R2 `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
4. Confirm all four agent binaries are present (a plain install prunes to host
   arch):
   ```bash
   ls -d node_modules/@anthropic-ai/claude-agent-sdk-darwin-{arm64,x64} \
         node_modules/@openai/codex-darwin-{arm64,x64}
   ```
   If any are missing, run the cross-arch install **with `--force`** (see runbook).

## Phase 1 — Full test gate (all must pass)

```bash
pnpm typecheck        # clean
pnpm lint             # 0 errors (warnings OK)
pnpm test:unit        # AC gate
pnpm test:integration # 18 mocked-SDK itests
```
If anything fails, stop and report — do not proceed to a build.

## Phase 2 — Version bump + changelog

- Bump the version in **all four** `package.json` files (root, `frontend`,
  `main`, `shared`).
- In `CHANGELOG.md`, move the `[Unreleased]` items under a new
  `## [<version>] — YYYY-MM-DD` heading (grouped Added / Changed / Fixed), derived
  from `git log --oneline v<last>..HEAD`.
- Commit exactly those five files:
  ```bash
  git add package.json frontend/package.json main/package.json shared/package.json CHANGELOG.md
  git commit -m "chore: release <version>

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Signed-off-by: Krishna <13578267+kesteva@users.noreply.github.com>"
  ```
  Build **after** this commit — the DMGs stamp `buildInfo.gitCommit` from it, and
  the tag must point here.

## Phase 3 — Four signed builds

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

```bash
cd dist-electron
ls -lh Cyboflow*-<version>-macOS-*.dmg   # ~304M arm64 / ~327M x64 — NOT a 215K stub
for app in mac-arm64/Cyboflow.app mac/Cyboflow.app \
           "mac-arm64/Cyboflow Dev.app" "mac/Cyboflow Dev.app"; do
  xcrun stapler validate "$app"          # "The validate action worked!"
  spctl -a -vvv "$app"                   # accepted / Notarized Developer ID
done
cd .. && pnpm rebuild better-sqlite3     # restore host-Node ABI
```
If an arm64 DMG is a 215K stub, rebuild it by hand from the `.zip` (recipe in the
cross-arch memory / runbook).

## Phase 5 — Publish to R2, the in-app update channel (CONFIRM FIRST) — THE release

**This is the step that actually ships the update.** The app polls
`updates.cyboflow.com/<variant>/latest-mac.yml` (R2) and never reads GitHub. Do
**both** feeds. For each: merge the per-arch manifests with `gen-mac-latest-yml.mjs`
(arm64 zip first — each build overwrites `latest-mac.yml`), then upload with an
explicit `PUBLISH_ONLY` allowlist so the mixed `dist-electron` doesn't
cross-contaminate feeds. See `docs/UPDATES.md`.

```bash
set -a; . ./.envrc.local; set +a
V=<version>

# stable feed
node scripts/gen-mac-latest-yml.mjs dist-electron/latest-mac.yml \
  Cyboflow-$V-macOS-arm64.zip Cyboflow-$V-macOS-arm64.dmg \
  Cyboflow-$V-macOS-x64.zip  Cyboflow-$V-macOS-x64.dmg
cat dist-electron/latest-mac.yml          # sanity: version, 4 files, path=arm64 zip
S="Cyboflow-$V-macOS-arm64.dmg,Cyboflow-$V-macOS-arm64.dmg.blockmap,Cyboflow-$V-macOS-arm64.zip,Cyboflow-$V-macOS-arm64.zip.blockmap,Cyboflow-$V-macOS-x64.dmg,Cyboflow-$V-macOS-x64.dmg.blockmap,Cyboflow-$V-macOS-x64.zip,Cyboflow-$V-macOS-x64.zip.blockmap,latest-mac.yml"
PUBLISH_ONLY="$S" UPDATE_DRY_RUN=true pnpm publish:r2   # verify list first
PUBLISH_ONLY="$S" pnpm publish:r2                        # real → stable/

# dev feed
node scripts/gen-mac-latest-yml.mjs dist-electron/latest-mac.yml \
  Cyboflow-Dev-$V-macOS-arm64.zip Cyboflow-Dev-$V-macOS-arm64.dmg \
  Cyboflow-Dev-$V-macOS-x64.zip  Cyboflow-Dev-$V-macOS-x64.dmg
D="${S//Cyboflow-$V/Cyboflow-Dev-$V}"                    # stable names → Dev names
BUILD_VARIANT=dev PUBLISH_ONLY="$D" pnpm publish:r2      # real → dev/

# verify both feeds live
curl -s https://updates.cyboflow.com/stable/latest-mac.yml | grep -m1 version
curl -s https://updates.cyboflow.com/dev/latest-mac.yml    | grep -m1 version
```

`pnpm publish:r2` is a credentialed network write — in auto/headless modes the
permission classifier may block it; if so, have the user run it (`!` prefix) or
grant the Bash rule. Do not report the release as done until both feeds show `<version>`.

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
  --title "v<version>" --notes-file /tmp/notes.md
gh release view v<version> --json assets --jq '.assets[] | "\(.name) [\(.state)]"'
```
All four assets must read `[uploaded]`. The repo is public — DMG URLs are
anonymously downloadable.

## Wrap-up

Report: both R2 feeds live at `<version>` (the update channel), the GitHub release
URL, the four artifact names/sizes, and that `main` + tag are pushed. If branch
protection was bypassed on the direct push, say so.
