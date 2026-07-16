---
name: release
description: Cut a Cyboflow release end-to-end — run the full test gate, bump the version + changelog, build four signed/notarized macOS DMGs (stable + dev, arm64 + x64), and publish the GitHub release. Use when asked to cut/ship/publish a release, make a release build, or roll a new version. Follows docs/RELEASE-RUNBOOK.md.
---

# Release

Execute a Cyboflow release. The authoritative procedure and its rationale live in
`docs/RELEASE-RUNBOOK.md` — read it first; this skill is the executable checklist.
Work through the phases **in order** and do not skip verification.

## Guardrails

- **Never run `build:mac:universal`** — it fails on the bundled `claude`/`codex`
  binaries. The release is **per-arch** DMGs.
- **Hold all outward actions until the user confirms.** Do the gate, bump, builds,
  and verification, then **stop and ask before pushing** `main`, the tag, or the
  GitHub release — unless the user has already said to push without asking.
- Every mac build recompiles `better-sqlite3` for the Electron ABI; **restore the
  host-Node ABI afterward** (`pnpm rebuild better-sqlite3`) or tests break.
- Don't launch the app while a `build:mac` runs (it can wedge the DMG eject).

## Phase 0 — Preconditions

1. Confirm a clean tree on `main` (`git status`), and read the recent log to see
   what's shipping (`git log --oneline v<last>..HEAD`).
2. Decide the new version. Default is a patch bump of the current
   `package.json` version; **ask the user** if a minor/major bump is intended.
3. Confirm signing creds exist: `./.envrc.local` must define `APPLE_ID`,
   `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `CSC_LINK`, `CSC_KEY_PASSWORD`.
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

## Phase 5 — Push + GitHub release (CONFIRM FIRST)

Present the plan and get the user's go-ahead, then:

```bash
git tag v<version> <release-commit>      # the "chore: release <version>" commit
git push origin main
git push origin v<version>
# release notes = the changelog slice for this version
awk '/^## \[<version>\]/{f=1} f&&/^## \[/&&!/\[<version>\]/{exit} f' CHANGELOG.md > /tmp/notes.md
gh release create v<version> \
  dist-electron/Cyboflow-<version>-macOS-arm64.dmg \
  dist-electron/Cyboflow-<version>-macOS-x64.dmg \
  dist-electron/Cyboflow-Dev-<version>-macOS-arm64.dmg \
  dist-electron/Cyboflow-Dev-<version>-macOS-x64.dmg \
  --title "v<version>" --notes-file /tmp/notes.md
```

Then verify the release:
```bash
gh release view v<version> --json assets --jq '.assets[] | "\(.name) [\(.state)]"'
```
All four assets must read `[uploaded]`. The repo is public — release DMG URLs are
anonymously downloadable.

## Wrap-up

Report the release URL, the four artifact names/sizes, and note that `main` +
tag are pushed. If branch protection was bypassed on the direct push, say so.
