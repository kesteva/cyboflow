# Release Runbook

The end-to-end procedure for cutting a Cyboflow release: **gate → version bump +
changelog → four signed builds → verify → publish to R2 (the in-app update
channel) → push + GitHub release**. Every macOS build is signed + notarized +
stapled. Nothing is published until the artifacts are verified. **The R2 publish
(§5) is what actually ships the update — the GitHub release is an archival
mirror the app never reads.**

> **Why per-arch, not universal.** `build:mac:universal` currently **fails**:
> `@electron/universal` can't merge the bundled `claude` / `codex` binaries
> (plain Mach-O executables not covered by `mac.x64ArchFiles`, which only lists
> `.node`/`.dylib`). The release ships as **per-arch** DMGs instead. See
> `docs/signing/APPLE_DEVELOPER_SETUP.md` for the signing contract.

## Prerequisites

- Clean `main`, all release-worthy commits merged.
- Signing **and** R2 credentials live in **`~/Developer/cyboflow/.envrc.local`**
  (gitignored, and present only in the primary repo checkout — a worktree has
  no copy of its own) — 8 vars total: Apple (`APPLE_ID`, `APPLE_TEAM_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `CSC_LINK`, `CSC_KEY_PASSWORD`) + R2
  (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`). R2 is the
  **in-app auto-update channel** — see `docs/UPDATES.md`. **Env vars are
  shell-scoped, not worktree-scoped**: once sourced, the same shell can build
  from the primary checkout or any worktree — see `docs/UPDATES.md`
  ("One-time setup"). Source with
  `set -a; . ~/Developer/cyboflow/.envrc.local; set +a`.
- **Dependency tree re-resolved from the lockfile**, before anything is gated:
  ```bash
  pnpm install --frozen-lockfile
  ```
  `node_modules` can be self-consistent while the *lockfile* is not, so §1 would
  otherwise pass against dependencies that no longer match what CI installs — a
  local gate never re-resolves, so a lockfile defect is invisible to it. That is
  how 0.2.9 shipped a dead E2E suite: a dep bump split `playwright` (1.62.1) from
  `@playwright/test` (1.54.1) in the lock, the un-reinstalled tree still held a
  matched 1.54.1 pair, the local smoke tier passed, and every nightly after it
  died at spec collection with "Playwright Test did not expect test.describe()
  to be called here". `--frozen-lockfile` additionally hard-fails when
  `package.json` and the lockfile disagree. **Do this BEFORE the cross-arch
  binary check below** — it prunes to host arch.
- Both darwin agent binaries present for **both** arches (a plain install/rebuild
  prunes to host arch). Verify all four exist; if any are missing run the
  cross-arch install **with `--force`** (see
  `[[project_cross_arch_build_foreign_binaries]]` / the memory note):
  ```bash
  ls -d node_modules/@anthropic-ai/claude-agent-sdk-darwin-{arm64,x64} \
        node_modules/@openai/codex-darwin-{arm64,x64}
  # if missing:
  pnpm install --config.supportedArchitectures.os=darwin \
    --config.supportedArchitectures.cpu=x64 \
    --config.supportedArchitectures.cpu=arm64 --force
  ```
- `gh` authenticated against `github.com/kesteva/cyboflow`.

## 1. Full test gate

All of these must pass. `test:unit` is the AC gate; `test:integration` is the
blocking mocked-SDK job for `main/src/services/panels/claude/` changes.

```bash
pnpm typecheck        # must be clean
pnpm lint             # 0 errors (warnings are non-gating)
pnpm test:unit        # main + frontend vitest, schema parity, build scripts
pnpm test:integration # the mocked-SDK *.itest.ts suite

# Packaged-app smoke tier (blocking since 2026-08-14): drives the built bundle
# via Playwright _electron.launch(). e2e:prereqs rebuilds native modules for the
# Electron ABI — later gates/builds re-ensure their own ABI automatically.
pnpm run e2e:prereqs && pnpm run test:ci:minimal

# SDK drift canaries against the REAL API (needs the authenticated `claude` CLI
# on PATH — this machine, not CI; ~15-20 min + real token spend). They catch
# protocol/behavior drift the mocked suites cannot see.
pnpm test:gate        # orchestrator day-gate, real wire shapes
pnpm smoke:sdk        # standalone raw-SDK protocol probe
```

## 2. Version bump + changelog

Bump the version in **all four** `package.json` files and move the
`[Unreleased]` changelog entries under a dated `[x.y.z]` heading.

```bash
OLD=0.1.24 NEW=0.1.25
for f in package.json frontend/package.json main/package.json shared/package.json; do
  sed -i '' "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" "$f"
done
# edit CHANGELOG.md: insert "## [NEW] — YYYY-MM-DD" above the prior release,
# grouped Added / Changed / Fixed from `git log --oneline vOLD..HEAD`.
# CAUTION: if the edit spans "## [Unreleased]\n\n## [OLD]", RE-ADD "## [OLD]" or
# you merge OLD's notes under NEW (and §6's notes-slice awk runs to EOF). Verify:
#   grep -nE '^## \[' CHANGELOG.md | head   # "## [OLD]" must still be present
git add package.json frontend/package.json main/package.json shared/package.json CHANGELOG.md
git commit -m "chore: release $NEW

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Signed-off-by: Krishna <13578267+kesteva@users.noreply.github.com>"
```

The DMGs stamp their `buildInfo.gitCommit` from this commit, so **build after
committing** and **tag this commit** (§5) so the tag matches the artifacts.

## 3. Four signed builds

Source signing creds into each build subprocess (`set -a; . ~/Developer/cyboflow/.envrc.local; set +a`).
Both native addons are N-API (better-sqlite3 ≥ 13, node-pty), so no ABI flip is
involved any more. What the builds DO leave behind is an **arch** problem: the
x64 builds compile an x64 `pty.node` that the arm64 host cannot dlopen
(better-sqlite3's prebuilds are never recompiled). **Restore host-arch node-pty
afterward** (§4) so tests/`pnpm dev` work.

```bash
set -a; . ~/Developer/cyboflow/.envrc.local; set +a
pnpm run build:mac:arm64       # Cyboflow.app        → Cyboflow-<v>-macOS-arm64.dmg
pnpm run build:mac:x64         # Cyboflow.app        → Cyboflow-<v>-macOS-x64.dmg
pnpm run build:mac:dev:arm64   # Cyboflow Dev.app    → Cyboflow-Dev-<v>-macOS-arm64.dmg
pnpm run build:mac:dev:x64     # Cyboflow Dev.app    → Cyboflow-Dev-<v>-macOS-x64.dmg
```

Each build should log `notarization successful`. The `AfterSign: Claude Code
path not found` line is **benign** (legacy package probe; the bundled path is
`claude-agent-sdk`). Stable = appId `com.cyboflow.app` / `~/.cyboflow`; Dev =
`com.cyboflow.app.dev` / `~/.cyboflow_dev_dmg` — so a Dev DMG runs safely
alongside a stable prod app.

## 4. Verify artifacts (do NOT skip)

 The dev builds **overwrite** the stable staging dirs (`mac-arm64/`, `mac/`), so by
verify time only the **Dev** `.app` bundles survive there — validate the stable
apps by mounting their DMGs. Both surviving bundles are literally named
`Cyboflow Dev.app`; refer to them by staging dir as **Cyboflow Dev (arm64)**
(`mac-arm64/`) and **Cyboflow Dev (x64)** (`mac/`) so the Intel one is never
mistaken for the app you actually run.

```bash
cd dist-electron
ls -lh Cyboflow*-0.1.25-macOS-*.dmg   # expect ~304M arm64 / ~327M x64 — NOT a 215K stub
# dev apps still in the staging dirs:
#   mac-arm64/ = Cyboflow Dev (arm64)   |   mac/ = Cyboflow Dev (x64), Intel-only
for app in "mac-arm64/Cyboflow Dev.app" "mac/Cyboflow Dev.app"; do
  xcrun stapler validate "$app"        # "The validate action worked!"
  spctl -a -vvv "$app"                 # "accepted" / source=Notarized Developer ID
done
# stable apps: mount the DMG (staging dir was overwritten by the dev build):
for arch in arm64 x64; do
  mnt=$(hdiutil attach "Cyboflow-0.1.25-macOS-$arch.dmg" -nobrowse -noverify -readonly | grep -o '/Volumes/.*' | head -1)
  xcrun stapler validate "$mnt/Cyboflow.app"; spctl -a -vvv "$mnt/Cyboflow.app"
  hdiutil detach "$mnt" -quiet
done
cd .. && pnpm rebuild @homebridge/node-pty-prebuilt-multiarch   # restore host-arch pty.node after the x64 builds
```

- **Size is a stub-check, not a leak-check.** ~300M is correct (bundles Claude +
  Codex). Confirm no foreign binaries by inventory, not size:
  `find <app> -path '*@openai/codex-*' -o -path '*claude-agent-sdk-*'` must show
  only the build's own arch.
- **215K native-arch stub** (intermittent): if an arm64 DMG comes out empty,
  rebuild that DMG by hand from the (complete, signed, stapled) `.zip` — full
  recipe in `[[project_cross_arch_build_foreign_binaries]]`.

- **Expect a ~46 MB/arch jump on the first release after `claude-agent-sdk`
  0.3.224.** The SDK's bundled `claude` core grew 231.7 MB → 277.5 MB, and it
  ships unpacked via the `asarUnpack` glob in `package.json`, so the increase
  lands in every DMG AND in every auto-update payload. That makes the expected
  sizes above stale by roughly that much — re-baseline them from the first good
  build rather than treating the jump as a leak, and confirm by inventory as
  above. Re-check this after any future SDK bump; the bundled core moves with it.

- **macOS 26 will warn about "Cyboflow Dev" after the cut — that is
  Cyboflow Dev (x64), not your arm64 app.** `build:mac:dev:x64` leaves an
  Intel-only bundle at `dist-electron/mac/Cyboflow Dev.app`, LaunchServices
  registers it (`lsregister -dump` shows `slices: x86_64`), and Tahoe posts
  *"Support Ending for Intel-based Apps — This version of 'Cyboflow Dev'
  includes a component that will not work with a future release of macOS."*
  The notice carries only the display name, so it reads as if the arm64 Dev app
  were at fault. It is not: verify with
  `lipo -archs "dist-electron/mac-arm64/Cyboflow Dev.app/Contents/MacOS/Cyboflow Dev"`
  (arm64) against the same path under `mac/` (x86_64). Expected after every
  release; to silence it, `rm -rf dist-electron/mac` and
  `lsregister -u "dist-electron/mac/Cyboflow Dev.app"`.

- **Bundled `peekaboo` capture binary.** It ships unpacked beside the asar and
  is RE-SIGNED under our Team ID (it arrives already signed as
  `com.steipete.peekaboo`, which notarization would otherwise reject as a
  foreign identity). Verify it survived signing, and that it still answers —
  a binary that runs but cannot report its own grants makes every
  native-screen verification skip, silently:

  ```bash
  APP="mac-arm64/Cyboflow Dev.app"   # or the mounted stable .app
  PB="$APP/Contents/Resources/app.asar.unpacked/node_modules/@steipete/peekaboo-mcp/peekaboo"
  test -x "$PB" || echo "MISSING — the build shipped without it"
  codesign -dv --verbose=2 "$PB" 2>&1 | grep -E 'TeamIdentifier|flags'  # our Team ID, runtime flag
  "$PB" permissions --json-output   # must print JSON, not "Unknown option"
  ```

  Absence is a DEGRADATION, not a break — the app falls back to resolving
  `peekaboo` off the user's PATH, i.e. the pre-bundling behaviour — so
  `configure-build.js` warns rather than failing. Which is exactly why this
  check is here: nothing else would tell you.

## 5. Publish to R2 — the in-app update channel (THE release)

> **This is the step that actually ships the update.** The app polls
> `updates.cyboflow.com/<variant>/latest-mac.yml` (a Cloudflare R2 bucket) and
> downloads the `.zip`; it **never** reads the GitHub release. Skip this and users
> stay on the old version even though `main`, the tag, and the GitHub release all
> say the new one. Full detail: `docs/UPDATES.md`.

Publish **both feeds** (`stable/` and `dev/`). For each feed: regenerate the
**merged** `latest-mac.yml` (each per-arch build overwrites it, so no single build
lists both arches — `gen-mac-latest-yml.mjs` merges them, **arm64 zip first**),
then upload with an explicit `PUBLISH_ONLY` allowlist so the mixed `dist-electron`
doesn't cross-contaminate feeds. Dry-run first.

```bash
set -a; . ~/Developer/cyboflow/.envrc.local; set +a   # needs the 3 R2 vars

# --- stable feed ---
node scripts/gen-mac-latest-yml.mjs dist-electron/latest-mac.yml \
  Cyboflow-0.1.25-macOS-arm64.zip Cyboflow-0.1.25-macOS-arm64.dmg \
  Cyboflow-0.1.25-macOS-x64.zip  Cyboflow-0.1.25-macOS-x64.dmg
cat dist-electron/latest-mac.yml   # sanity: version, 4 files, path=arm64 zip
S="Cyboflow-0.1.25-macOS-arm64.dmg,Cyboflow-0.1.25-macOS-arm64.dmg.blockmap,\
Cyboflow-0.1.25-macOS-arm64.zip,Cyboflow-0.1.25-macOS-arm64.zip.blockmap,\
Cyboflow-0.1.25-macOS-x64.dmg,Cyboflow-0.1.25-macOS-x64.dmg.blockmap,\
Cyboflow-0.1.25-macOS-x64.zip,Cyboflow-0.1.25-macOS-x64.zip.blockmap,latest-mac.yml"
PUBLISH_ONLY="$S" UPDATE_DRY_RUN=true pnpm publish:r2   # verify list
PUBLISH_ONLY="$S" pnpm publish:r2                        # real upload → stable/

# --- dev feed (regenerate the manifest with the Dev-* names, then publish) ---
node scripts/gen-mac-latest-yml.mjs dist-electron/latest-mac.yml \
  Cyboflow-Dev-0.1.25-macOS-arm64.zip Cyboflow-Dev-0.1.25-macOS-arm64.dmg \
  Cyboflow-Dev-0.1.25-macOS-x64.zip  Cyboflow-Dev-0.1.25-macOS-x64.dmg
D="$(echo "$S" | sed 's/Cyboflow-0/Cyboflow-Dev-0/g')"
BUILD_VARIANT=dev PUBLISH_ONLY="$D" pnpm publish:r2      # real upload → dev/
```

Verify both feeds went live:

```bash
curl -s https://updates.cyboflow.com/stable/latest-mac.yml | grep -m1 version
curl -s https://updates.cyboflow.com/dev/latest-mac.yml    | grep -m1 version
```

> `pnpm publish:r2` is a credentialed network write; in auto/headless permission
> modes the classifier may gate it — run it in an interactive shell or grant the
> Bash rule.

## 6. Push + GitHub release (archival mirror)

Independent of §5 — the updater never touches GitHub. Tag the release commit
(matches the artifacts' `buildInfo.gitCommit`), push `main` and the tag, then
publish the release with **all four DMGs** (matches the v0.1.24 shape — no
zip/blockmap/yml assets; those live only on R2).

```bash
git tag v0.1.25 <release-commit>          # the "chore: release 0.1.25" commit
git push origin main
git push origin v0.1.25

# Notes = this version's CHANGELOG slice + an install/update footer (throwaway file):
{
  awk '/^## \[0\.1\.25\]/{f=1; next} /^## \[/{if(f)f=0} f' CHANGELOG.md
  printf '\n---\n\n### Install\n\n- **New install:** download the DMG for your Mac below.\n- **Existing install:** auto-updates via `updates.cyboflow.com/stable` (*Settings → Updates*).\n- **Dev channel:** the `Cyboflow-Dev-*` DMGs install side-by-side and track `updates.cyboflow.com/dev`.\n\nAll builds are signed (Developer ID), notarized, and stapled.\n'
} > /tmp/notes-0.1.25.md

gh release create v0.1.25 \
  dist-electron/Cyboflow-0.1.25-macOS-arm64.dmg \
  dist-electron/Cyboflow-0.1.25-macOS-x64.dmg \
  dist-electron/Cyboflow-Dev-0.1.25-macOS-arm64.dmg \
  dist-electron/Cyboflow-Dev-0.1.25-macOS-x64.dmg \
  --title "v0.1.25" --notes-file /tmp/notes-0.1.25.md
```

The repo is **public** — release DMG URLs are anonymously downloadable (a usable
mirror, but not the channel the app or website depends on).

## Landmines

- **R2 is the real release; GitHub is a mirror.** Publishing the GitHub release
  without §5 leaves every user on the old version (the app polls R2, not GitHub).
- **Per-arch manifests must be merged** with `gen-mac-latest-yml.mjs` (arm64 zip
  first) before publishing, or one arch gets no updates.
- **Publish with `PUBLISH_ONLY`** — `dist-electron` accumulates a mix of
  variants/arches/stale files; the bare glob cross-contaminates `stable/` ↔ `dev/`.
- **Never run `build:mac:universal`** — it fails on the agent binaries (see top).
- **Don't launch the app while a `build:mac` is running** — a live app can grab a
  handle on the mounting DMG and wedge the eject. Quit installed apps first.
- **Arch churn:** the x64 mac builds leave `node-pty` compiled for x64 (both
  addons are N-API, so this is an arch problem, not an ABI one; better-sqlite3's
  prebuilds are never recompiled). Run
  `pnpm rebuild @homebridge/node-pty-prebuilt-multiarch` before vitest (a
  `pty.node` dlopen arch-mismatch fails 30+ test files even though every test
  that loads passes); `pnpm dev` self-heals via postinstall.
