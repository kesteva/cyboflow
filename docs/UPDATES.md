# In-app updates (Cloudflare R2 host)

Cyboflow ships signed, notarized macOS builds and updates them in place via
[`electron-updater`](https://www.electron.build/auto-update). The app polls a
public manifest, compares versions, and downloads only the changed bytes. No git,
no GitHub — just HTTPS GETs against a static host.

```
Installed app (vX)
   │  GET https://updates.cyboflow.com/<variant>/latest-mac.yml   (poll)
   ▼
Cloudflare R2  ──►  version: Y   →   app sees Y > X
   │  GET the .zip (+ .blockmap delta) → verify sha512 + Developer ID signature
   ▼
swap bundle → "Restart to update"
```

`<variant>` is `stable` or `beta` — Cyboflow ships as **two separate side-by-side
apps**, each with its own feed (see "Stable vs Beta" below). The feed is fixed at
build time, baked into the packaged `app-update.yml`; there is no in-app channel
switch.

The artifacts live in a **Cloudflare R2** bucket served at `updates.cyboflow.com`,
under `stable/` and `beta/` prefixes. R2 is S3-compatible (so we publish with the
S3 SDK) but serves public downloads with **zero egress fees** and **no credentials
in the app** — the source repo stays private. See
[`scripts/publish-update.mjs`](../scripts/publish-update.mjs).

---

## One-time setup (do this once)

### 1. Create the R2 bucket
1. Cloudflare dashboard → **R2** → **Create bucket** → name it `cyboflow-updates`.
2. Bucket → **Settings** → **Public access** → **Custom Domains** → add
   `updates.cyboflow.com`. Cloudflare provisions the cert and DNS automatically
   (the domain must be on the same Cloudflare account; `cyboflow.com` itself can
   stay on Netlify — only the `updates` subdomain points at R2).
3. Verify: after the first publish, `https://updates.cyboflow.com/stable/latest-mac.yml`
   must load anonymously in a browser.

> Do **not** enable the `*.r2.dev` public URL for releases — use the custom domain
> so the update URL is stable and on-brand.

### 2. Create an R2 API token
R2 → **Manage R2 API Tokens** → **Create API Token**:
- Permission: **Object Read & Write**
- Scoped to the `cyboflow-updates` bucket
- Save the **Access Key ID** and **Secret Access Key** (shown once).

The **Account ID** is on the R2 overview page (it's the subdomain of the S3
endpoint `https://<accountid>.r2.cloudflarestorage.com`).

### 3. Set the release-shell env vars
Release secrets live in **`~/Developer/cyboflow/.envrc.local`** — a single
gitignored file (in the primary repo, never committed) that also holds the Apple
signing vars. Add the three R2 lines to it:

```bash
export R2_ACCOUNT_ID=...          # Cloudflare account id
export R2_ACCESS_KEY_ID=...       # from the API token
export R2_SECRET_ACCESS_KEY=...   # from the API token
# optional: export R2_BUCKET=cyboflow-updates   (this is the default)
```

The full file should then export **8 vars**: 5 Apple
([`signing/APPLE_DEVELOPER_SETUP.md`](signing/APPLE_DEVELOPER_SETUP.md)) + 3 R2.

> **It is sourced manually — `direnv` is NOT installed.** The `.envrc.local` name
> is just a convention; nothing auto-loads it. You `source` it before releasing
> (the `cyborelease` wrapper below does this for you).
>
> **Env vars are shell-scoped, not branch- or worktree-scoped.** Once sourced,
> they apply to any build you launch from that shell — the primary repo on `main`
> **or** any `~/.warp/worktrees/...` worktree, identically. What differs between
> those is only *which code* gets built, not whether credentials are present.
>
> ⚠️ If the vars are missing, `configure-build.js` **silently** produces an
> *unsigned* build. Don't release from a shell you haven't sourced — use the
> guarded wrapper.

---

## Cutting a release

1. Bump `version` in `package.json` (e.g. `0.1.2` → `0.1.3`). The updater compares
   this baked-in version against the manifest, so this is what gates the prompt.
2. Load the release secrets into your shell, then build + sign + notarize +
   publish in one step:
   ```bash
   source ~/Developer/cyboflow/.envrc.local   # 5 Apple + 3 R2 vars
   pnpm release:mac          # stable: build:mac → publish:r2 (uploads to stable/)
   pnpm release:mac:beta     # beta:   build:mac:beta → publish:r2 (uploads to beta/)
   ```
   Or use the guarded wrapper (recommended) — it sources the file, **aborts loudly
   if any credential is missing** (instead of silently shipping unsigned), and
   works from the primary repo or any worktree. Add to `~/.zshrc`:
   ```bash
   cyborelease() {
     source ~/Developer/cyboflow/.envrc.local
     : "${CSC_LINK:?missing Apple signing vars}" "${R2_ACCESS_KEY_ID:?missing R2 vars}"
     pnpm "${1:-release:mac}"   # cyborelease  → stable;  cyborelease release:mac:beta → beta
   }
   ```
3. Dry-run the upload step alone to see what would publish:
   ```bash
   pnpm build:mac && UPDATE_DRY_RUN=true pnpm publish:r2
   BUILD_VARIANT=beta UPDATE_DRY_RUN=true pnpm publish:r2   # dry-run the beta prefix
   ```

`publish:r2` mirrors everything in `dist-electron` matching `*.yml`/`*.zip`/`*.dmg`/
`*.blockmap` to the bucket under the variant prefix (`stable/` or `beta/`, from
`BUILD_VARIANT`). The `.yml` manifest is uploaded `no-cache` (it changes every
release); the binaries are uploaded `immutable` (their version is in the filename).

The website's "Download" buttons point at the current
`https://updates.cyboflow.com/stable/Cyboflow-<version>-macOS-universal.dmg` (and the
`beta/Cyboflow-Beta-<version>-...` for the beta app) for first installs — auto-update
only upgrades an already-installed app.

### Typical flow

```
bump version → pnpm release:mac:beta → test the Beta app → fix → repeat
                                     → on green: pnpm release:mac (ship Stable)
```

Because Beta is a distinct app (own data dir), you can run it alongside Stable
without risk. Bump the version for each Beta you want existing Beta installs to
auto-update to (a `-beta.N` prerelease suffix is conventional, e.g. `0.1.3-beta.1`).

---

## How the app consumes it

- `main/src/services/appUpdater.ts` wraps `electron-updater`. It is a **no-op in
  dev** (`app.isPackaged === false`) and only runs in packaged builds.
- `autoDownload` is **off** and `autoInstallOnAppQuit` is **off** by design: a
  silent install mid-run could kill an in-progress orchestrator/agent session.
  The flow is explicit — *check → download → "Restart to update"* (see the
  About dialog).
- electron-builder bakes `build.publish` (the generic `updates.cyboflow.com/<variant>`
  URL) into the packaged `app-update.yml`, so the app knows where to poll with no
  extra config. The stable URL is in `package.json`; the beta build overrides it
  with `--config.publish.url=.../beta` (see `build:mac:beta`).

---

## Gotchas

| Concern | Detail |
|---|---|
| **Signing identity must be stable** | Auto-update only accepts a build signed by the *same* Developer ID. Don't rotate the cert between releases. |
| **`.zip` is required** | `mac.target: "default"` produces `.dmg` **and** `.zip`. The updater needs the `.zip`; the `.dmg` is only for first install. |
| **Manifest must not be cached** | `latest-mac.yml` is uploaded `no-cache`. If you front it with extra CDN caching, the app won't see new releases until the cache expires. |
| **First install is still manual** | The updater upgrades an installed app only. New users download the `.dmg` from the website. |

---

## Stable vs Beta — two separate apps

Beta is **not** an in-app toggle. It's a distinct application that installs
side-by-side with Stable, the way VS Code Insiders or Chrome Canary do. Everything
that differs is fixed at build time by `build:mac:beta`:

| | Stable | Beta |
|---|---|---|
| App name (`productName`) | Cyboflow | Cyboflow Beta |
| Bundle id (`appId`) | `com.cyboflow.app` | `com.cyboflow.app.beta` |
| Data dir | `~/.cyboflow` | `~/.cyboflow-beta` |
| Update feed | `updates.cyboflow.com/stable` | `updates.cyboflow.com/beta` |
| Artifact name | `Cyboflow-<v>-…` | `Cyboflow-Beta-<v>-…` |

**Why separate apps (not a channel setting):** the SQLite DB is forward-only
migrated. If one install ran a newer beta migration on a *shared* database, the
older stable binary could no longer open it. Distinct `appId`s give each variant
its own data dir (resolved by `cyboflowDirName()` in
`main/src/utils/cyboflowDirectory.ts` via the `__CFBundleIdentifier` macOS sets),
so a beta install can never corrupt stable's data. Each app only ever updates
within its own feed.

Users get the beta by **downloading the separate Cyboflow Beta app** from the
website (Settings → Updates points them there) — there is no in-app opt-in.
