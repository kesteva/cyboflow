# Release Runbook

The end-to-end procedure for cutting a Cyboflow release: **gate → version bump →
four signed builds → changelog → GitHub release**. Every macOS build is signed +
notarized + stapled. Nothing is pushed until the artifacts are verified.

> **Why per-arch, not universal.** `build:mac:universal` currently **fails**:
> `@electron/universal` can't merge the bundled `claude` / `codex` binaries
> (plain Mach-O executables not covered by `mac.x64ArchFiles`, which only lists
> `.node`/`.dylib`). The release ships as **per-arch** DMGs instead. See
> `docs/signing/APPLE_DEVELOPER_SETUP.md` for the signing contract.

## Prerequisites

- Clean `main`, all release-worthy commits merged.
- Apple signing credentials in `./.envrc.local` (gitignored): `APPLE_ID`,
  `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `CSC_LINK`, `CSC_KEY_PASSWORD`.
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

All four must pass. `test:unit` is the AC gate; `test:integration` is the
blocking mocked-SDK job for `main/src/services/panels/claude/` changes.

```bash
pnpm typecheck        # must be clean
pnpm lint             # 0 errors (warnings are non-gating)
pnpm test:unit        # main + frontend vitest, schema parity, build scripts
pnpm test:integration # 18 mocked-SDK *.itest.ts
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
git add package.json frontend/package.json main/package.json shared/package.json CHANGELOG.md
git commit -m "chore: release $NEW

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Signed-off-by: Krishna <13578267+kesteva@users.noreply.github.com>"
```

The DMGs stamp their `buildInfo.gitCommit` from this commit, so **build after
committing** and **tag this commit** (§5) so the tag matches the artifacts.

## 3. Four signed builds

Source signing creds into each build subprocess (`set -a; . ./.envrc.local; set +a`).
Each build recompiles `better-sqlite3` for the Electron ABI — order doesn't
matter, but **restore the host-Node ABI afterward** (§4) so tests/`pnpm dev`
work.

```bash
set -a; . ./.envrc.local; set +a
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

```bash
cd dist-electron
ls -lh Cyboflow*-0.1.25-macOS-*.dmg   # expect ~304M arm64 / ~327M x64 — NOT a 215K stub
for app in mac-arm64/Cyboflow.app mac/Cyboflow.app \
           "mac-arm64/Cyboflow Dev.app" "mac/Cyboflow Dev.app"; do
  xcrun stapler validate "$app"        # "The validate action worked!"
  spctl -a -vvv "$app"                 # "accepted" / source=Notarized Developer ID
done
cd .. && pnpm rebuild better-sqlite3   # restore host-Node ABI for tests/pnpm dev
```

- **Size is a stub-check, not a leak-check.** ~300M is correct (bundles Claude +
  Codex). Confirm no foreign binaries by inventory, not size:
  `find <app> -path '*@openai/codex-*' -o -path '*claude-agent-sdk-*'` must show
  only the build's own arch.
- **215K native-arch stub** (intermittent): if an arm64 DMG comes out empty,
  rebuild that DMG by hand from the (complete, signed, stapled) `.zip` — full
  recipe in `[[project_cross_arch_build_foreign_binaries]]`.

## 5. Push + GitHub release

Tag the release commit (matches the artifacts' `buildInfo.gitCommit`), push
`main` and the tag, then publish the release with **all four DMGs** (matches the
v0.1.24 shape — no zip/blockmap/yml assets; auto-update is served from R2).

```bash
git tag v0.1.25 <release-commit>          # the "chore: release 0.1.25" commit
git push origin main
git push origin v0.1.25
gh release create v0.1.25 \
  dist-electron/Cyboflow-0.1.25-macOS-arm64.dmg \
  dist-electron/Cyboflow-0.1.25-macOS-x64.dmg \
  dist-electron/Cyboflow-Dev-0.1.25-macOS-arm64.dmg \
  dist-electron/Cyboflow-Dev-0.1.25-macOS-x64.dmg \
  --title "v0.1.25" --notes-file <changelog-slice>
```

The repo is **public** — release DMG URLs are anonymously downloadable.

## Landmines

- **Never run `build:mac:universal`** — it fails on the agent binaries (see top).
- **Don't launch the app while a `build:mac` is running** — a live app can grab a
  handle on the mounting DMG and wedge the eject. Quit installed apps first.
- **ABI churn:** every mac build leaves `better-sqlite3` on the Electron ABI. Run
  `pnpm rebuild better-sqlite3` before vitest; `pnpm dev` self-heals via
  postinstall.
