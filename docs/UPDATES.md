# In-app updates (Cloudflare R2 host)

Cyboflow ships signed, notarized macOS builds and Authenticode-signed Windows
installers, and updates them in place via
[`electron-updater`](https://www.electron.build/auto-update). The app polls a
public manifest, compares versions, and downloads only the changed bytes. No git,
no GitHub — just HTTPS GETs against a static host.

```
Installed app (vX)
   │  GET https://updates.cyboflow.com/<variant>/latest-mac.yml   (macOS poll)
   │  GET https://updates.cyboflow.com/<variant>/latest.yml       (Windows poll)
   ▼
Cloudflare R2  ──►  version: Y   →   app sees Y > X
   │  macOS:   GET the .zip (+ .blockmap delta) → verify sha512 + Developer ID signature
   │  Windows: GET the .exe (+ .blockmap delta) → verify sha512 + Authenticode publisher
   ▼
swap bundle / run the NSIS installer → "Restart to update"
```

`<variant>` is `stable` or `dev` — Cyboflow ships as **two separate side-by-side
apps**, each with its own feed (see "Stable vs Dev" below). The feed is fixed at
build time, baked into the packaged `app-update.yml`; there is no in-app channel
switch.

The artifacts live in a **Cloudflare R2** bucket served at `updates.cyboflow.com`,
under `stable/` and `dev/` prefixes. macOS and Windows share each prefix:
electron-updater reads a per-platform manifest name (`latest-mac.yml` /
`latest.yml`), so one feed per variant serves both platforms. R2 is S3-compatible (so we publish with the
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

A small guarded wrapper avoids ever building unsigned by accident — add to
`~/.zshrc`:

```bash
cyborelease() {
  source ~/Developer/cyboflow/.envrc.local
  : "${CSC_LINK:?missing Apple signing vars}" "${R2_ACCESS_KEY_ID:?missing R2 vars}"
}
```

Run `cyborelease` at the start of a release shell instead of a bare `source`.

---

## Cutting a release

The full end-to-end release procedure — test gate, version bump + changelog,
four signed per-arch builds (stable + dev, arm64 + x64), R2 publish, and the
GitHub release — lives in **[`docs/RELEASE-RUNBOOK.md`](RELEASE-RUNBOOK.md)**,
including why a universal build isn't used. Follow it for every release; this
doc covers only the R2/update-feed architecture and the one-time setup above
that the runbook's env-var sourcing step depends on.

One update-feed detail worth calling out here: the website's "Download" buttons
don't link the versioned DMGs directly. `publish:r2` also maintains a
version-less `-latest-` alias key per variant/arch — a server-side copy of the
just-published DMG (see `latestAliasName()` in
[`scripts/publish-update.mjs`](../scripts/publish-update.mjs)) — and the site
links *those*, so a version bump never requires a site edit. The versioned
files still exist alongside them in the bucket.
- `https://updates.cyboflow.com/stable/Cyboflow-latest-macOS-arm64.dmg` (and `-x64.dmg` for Intel)
- `https://updates.cyboflow.com/stable/Cyboflow-latest-Windows-x64.exe`
- `https://updates.cyboflow.com/dev/Cyboflow-Dev-latest-macOS-arm64.dmg` (and `-x64.dmg` for Intel)
- `https://updates.cyboflow.com/dev/Cyboflow-Dev-latest-Windows-x64.exe`

### Windows

The Windows installer is built and signed **only on the `windows-latest` CI
runner** (`.github/workflows/windows.yml`, one dispatch per variant — Azure
Artifact Signing needs a Windows host; see `docs/WINDOWS-BUILD.md`). The runner
uploads `Cyboflow[-Dev]-<v>-Windows-x64.exe`, its `.blockmap`, and the
electron-builder-generated `latest.yml` as a workflow artifact; the release
downloads that into `dist-electron/` and publishes it with the same
`publish:r2` + `PUBLISH_ONLY` recipe as the macOS files. There is no
`gen-latest-yml` step for Windows — it is a single-arch build, so the manifest
electron-builder writes is already complete.

On the client, `electron-updater`'s NSIS path downloads the new installer,
checks its Authenticode signature against the `publisherName` baked into the
installed app's `app-update.yml` (electron-builder copies it from
`win.azureSignOptions.publisherName` — "Raimundo Esteva"), and runs it on
"Restart to update". An unsigned installer, or one signed by a different CN,
is **rejected** — which is why an unsigned CI artifact must never be published.

---

## The dev feed is continuous

Since 2026-09-17 the `dev/` feed is **not** only written at release time.
`.github/workflows/dev-release.yml` runs after every green **Code Quality** run
on `main` (`workflow_run`, so a red gate never ships), builds the three Dev
installers on hosted runners — `macos.yml` (arm64 on `macos-latest`, x64 on
`macos-15-intel`, signed + notarized from the `CSC_*`/`APPLE_*` secrets) and
`windows-installer.yml` (Azure-signed) — merges the per-arch `latest-mac.yml`
with `gen-mac-latest-yml.mjs`, and publishes to `dev/` with the same
`publish:r2` + `PUBLISH_ONLY` recipe as a release. The `-latest-` aliases move
with it, so `dl.cyboflow.com/dev/…` always serves the newest green main.

- **Version:** `<package.json patch+1>-dev.<run_number>` — `main` keeps holding
  the last *released* version, so `0.4.2 < 0.4.3-dev.7 < 0.4.3-dev.8 < 0.4.3`.
  The stamp rides `CYBOFLOW_BUILD_VERSION` → electron-builder `extraMetadata`
  (`configure-build.js`) and `buildInfo.json` (`inject-build-info.js`);
  `package.json` is never edited, so `buildInfo.gitCommit` is the real SHA.
  `isNewerVersion` in `appUpdater.ts` orders prerelease ids per semver, so the
  Dev app moves forward through dev builds and never offers its own version or
  a rolled-back feed.
- **Concurrency:** one dev release at a time, never cancelled mid-run (a
  cancelled publish would leave a manifest naming files that were never
  uploaded). A burst of pushes yields one release from the newest green SHA,
  because `quality.yml` cancels its own superseded runs.
- **Secrets it needs beyond the build ones:** `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (the publish trio — not the
  read-only `R2_ANALYTICS_*` pair). Build-time telemetry keys `SENTRY_DSN` and
  `APTABASE_APP_KEY` are baked by `inject-build-info.js`; without them a build
  ships with both SDKs silently no-op'd.
- **Manual:** `gh workflow run dev-release.yml -f ref=<sha-on-main>` publishes
  any main commit to the dev feed (a ref off main is refused).
- **Releases still publish `dev/`** as the runbook describes — the release build
  (`0.4.3`) lands on the dev feed too, and the next main push moves it on to
  `0.4.4-dev.N`. Nothing about the `stable/` feed changed.

## How the app consumes it

- `main/src/services/appUpdater.ts` wraps `electron-updater`. It is a **no-op in
  dev** (`app.isPackaged === false`) and only runs in packaged builds, on the
  platforms a feed exists for (`hasUpdateFeed`: macOS and Windows; Linux reports
  "not supported" rather than ENOENT-ing on every interval).
- The app checks the feed **8 s after boot and then once every 24 h** while it
  stays open. A scheduled check that finds a newer version **downloads it
  unattended** (a download is harmless to a running session), and the bottom-left
  version pill goes *Downloading… N%* → **"Restart to update"**. The daily
  re-check never re-downloads a version it has already staged.
- electron-updater's own `autoDownload` and `autoInstallOnAppQuit` stay **off**:
  the **install** is always explicit ("Restart to update" in the pill, Settings →
  Updates, or the About dialog), because a silent quit-time install mid-run could
  kill an in-progress orchestrator/agent session.
- electron-builder bakes `build.publish` (the generic `updates.cyboflow.com/<variant>`
  URL) into the packaged `app-update.yml`, so the app knows where to poll with no
  extra config. The stable URL is in `package.json`; `scripts/configure-build.js`
  overrides it to `.../dev` (gated on `BUILD_VARIANT=dev`) when it writes the merged
  config that every `build:mac:*` script passes via `--config`.

---

## Measuring downloads

There is no download counter in the bucket. `updates.cyboflow.com` is a plain R2
custom domain — objects go straight from bucket to edge with no Worker in the
path — so the only record of a download is Cloudflare's edge request log.

**That log expires.** Per-path detail (`httpRequestsAdaptiveGroups`) is gone after
roughly **3 days**; the daily rollup (`httpRequests1dGroups`) after about **30**.
Nothing older is recoverable at any granularity. GitHub release assets are not a
fallback — they read zero, because nothing links to them.

Two scripts, and a scheduled job that makes them durable:

| Script | Purpose |
|---|---|
| `scripts/r2-download-stats.mjs` | Reads live analytics. Ad-hoc queries — `--days=N`, `--daily` for long-range volume, `--by-ip` to spot dev boxes. Needs `CLOUDFLARE_ANALYTICS_API` (or `CLOUDFLARE_API_TOKEN`) with Zone › Analytics:Read. |
| `scripts/snapshot-download-stats.mjs` | Freezes one UTC day into JSON in a **private** R2 bucket, so it survives retention. |
| `.github/workflows/download-stats.yml` | Runs the snapshot nightly at 02:17 UTC. `workflow_dispatch` takes `since`/`until` to backfill. |
| `workers/download-counter/` | **Tier 1** — counts installer downloads first-party at `dl.cyboflow.com`, then 302s to R2. One row per download *start*, so no range inflation; ASN/bot flags stored per row. Shares `DOWNLOAD_STATS_SALT` with the snapshot job so downloader ids join across both. See its `README.md`. |

Required repo secrets for the nightly job:

```
CLOUDFLARE_ANALYTICS_API          Zone › Analytics:Read
CLOUDFLARE_ZONE_ID                cyboflow.com zone id (avoids needing Zone:Read)
DOWNLOAD_STATS_SALT               openssl rand -hex 32 — see below
R2_ACCOUNT_ID
R2_ANALYTICS_ACCESS_KEY_ID        scoped to the PRIVATE analytics bucket
R2_ANALYTICS_SECRET_ACCESS_KEY
```

**The analytics bucket must be private and separate from `cyboflow-updates`.** The
release bucket is served publicly over `updates.cyboflow.com`, so anything written
there — including download statistics — is world-readable at a guessable URL.

**`DOWNLOAD_STATS_SALT` must stay stable.** Per-downloader counts are what answer
"how many people", so each IP is stored as `sha256(monthlySalt + ip)` and the raw
address is dropped. The salt is required and never defaulted: IPv4 is small enough
that an unsalted hash is brute-forceable straight back to the address. It rotates
monthly by derivation (`sha256(SALT + ':' + YYYY-MM)`), which bounds linkability to
a calendar month — long enough for unique-downloader counts per release cycle, and
longer than residential IPs survive anyway. Changing the secret renumbers every id
and breaks continuity across the change.

### Reading the numbers

Counts are download *attempts*, not installs, and overstate reality in three ways:
a resumed download is several range requests; `-latest-` aliases double-count
alongside versioned files; and datacenter crawlers pull the `.dmg` constantly.
Snapshots carry a `botLikely` flag — downloaded the installer, never polled
`latest-mac.yml` — as the crawler signature, stored rather than applied so the
heuristic can be revised against history.

Egress bytes are the more honest measure than the row count: divide by the ~305 MB
(arm64) / ~328 MB (x64) DMG size for full-installer equivalents. `latest-mac.yml`
poll counts are the best proxy for *active* installs, since only a running app
polls. Neither dedupes to humans across months — that gap is Aptabase's job.

---

## Gotchas

| Concern | Detail |
|---|---|
| **Signing identity must be stable** | macOS: auto-update only accepts a build signed by the *same* Developer ID. Windows: the updater checks the installer's Authenticode CN against the `publisherName` baked into the installed app — a rename of the Azure identity is a breaking change for every installed Windows app. Don't rotate either between releases. |
| **Two manifests per feed** | `latest-mac.yml` (macOS) and `latest.yml` (Windows) live side by side in each `<variant>/` prefix. Both variants' Windows artifacts carry a file literally named `latest.yml` — keep them in separate dirs until the moment each feed is published. |
| **`.zip` is required** | `mac.target: "default"` produces `.dmg` **and** `.zip`. The updater needs the `.zip`; the `.dmg` is only for first install. |
| **Manifest must not be cached** | `latest-mac.yml` is uploaded `no-cache`. If you front it with extra CDN caching, the app won't see new releases until the cache expires. |
| **First install is still manual** | The updater upgrades an installed app only. New users download the `.dmg` from the website. |
| **Per-arch manifests must be merged** | Each per-arch build overwrites `latest-mac.yml`. Always regenerate it with `scripts/gen-mac-latest-yml.mjs` listing *both* arches before publishing, or one arch's users get no updates. |
| **Publish with an allowlist** | `dist-electron` holds a mix of variants/arches/stale files. Use `PUBLISH_ONLY` so a release publishes exactly its own files — the bare glob cross-contaminates the `stable/` and `dev/` feeds. |
| **Native-module ABI before packaging** | The unit gate (`pnpm test:unit`) rebuilds `better-sqlite3` for the **host Node** ABI (NMV 127). electron-builder's rebuild step *caches* and can then skip the Electron rebuild, packaging the host-ABI module — the app crashes on launch with `NODE_MODULE_VERSION 127 … requires 136`. The `build:mac:*` scripts now run **`pnpm electron:rebuild`** (force) first so this can't happen. To verify a built app: load its `…/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` with host `node` — it should *refuse* with "compiled against … 136" (proving the Electron ABI). |

---

## Stable vs Dev — two separate apps

Dev is **not** an in-app toggle. It's a distinct application that installs
side-by-side with Stable, the way VS Code Insiders or Chrome Canary do. Everything
that differs is fixed at build time by `build:mac:dev`:

| | Stable | Dev |
|---|---|---|
| App name (`productName`) | Cyboflow | Cyboflow Dev |
| Bundle id (`appId`) | `com.cyboflow.app` | `com.cyboflow.app.dev` |
| Data dir | `~/.cyboflow` | `~/.cyboflow_dev_dmg` (isolated) |
| Update feed | `updates.cyboflow.com/stable` | `updates.cyboflow.com/dev` |
| Artifact name | `Cyboflow-<v>-…` | `Cyboflow-Dev-<v>-…` |
| Windows install dir | `%LOCALAPPDATA%\Programs\Cyboflow` | `%LOCALAPPDATA%\Programs\Cyboflow Dev` |

**Why separate apps (not a channel setting):** distinct `appId`/name lets Dev install
side-by-side with Stable, the way VS Code Insiders does, and each app only ever updates
within its own feed. **Each packaged variant gets its own data dir** — `~/.cyboflow`
for Stable, `~/.cyboflow_dev_dmg` for Dev — so the two apps can run side by side
without sharing a `sessions.db` / `orch.sock` (the two-instance orch-socket clobber);
each dir is held to one running instance by the data-dir single-instance lock.
Bump the version for each Dev build you want
existing Dev installs to auto-update to — a `-dev.N` prerelease suffix is conventional
(e.g. `0.1.3-dev.1`).

The data-dir resolution lives in `getCyboflowDirectory()`
(`main/src/utils/cyboflowDirectory.ts`): packaged Stable → `~/.cyboflow`; packaged
Dev DMG → `~/.cyboflow_dev_dmg`; the non-packaged Electron dev server (`pnpm dev`) →
`~/.cyboflow_dev` — three parallel-safe kinds, so local development never mutates or
forward-migrates either installed app's database.

### Schema-version gate (newer DB → warn, don't corrupt)

Because each SQLite DB is **forward-only** migrated, any newer build that opens a
data dir advances its DB past what older binaries understand (e.g. rolling back to
an older Stable after a newer one has run, or pointing `CYBOFLOW_DIR` at a newer
dir). To stop an
older binary from then silently running against a schema it doesn't understand (a
real corruption risk — several migrations rebuild/drop tables), `initialize()`
stamps `PRAGMA user_version` with the highest migration the build ships and, on the
next boot, compares the on-disk value:

- **on-disk ≤ this build** → normal boot; the stamp is raised to the current max.
- **on-disk > this build** (DB advanced by a newer build) → a native dialog:
  *"This database was created by a newer version of Cyboflow"* with
  **[Check for Updates] [Open Anyway] [Quit]**.
  - *Check for Updates* boots, then auto-opens **Settings → Updates** (one-shot,
    via `app:consume-open-update-settings`).
  - *Open Anyway* boots normally (the stamp is **not** lowered).
  - *Quit* closes the DB without touching it.

The gate lives in `DatabaseService.getSchemaVersionStatus()` +
`computeAppMaxMigrationVersion()` (`main/src/database/database.ts`) and is consumed
at boot in `main/src/index.ts`.

> ⚠️ The gate prevents a silent crash/corruption, but it can't *merge* schemas. If
> a newer build advances a data dir, an older binary opening that same dir still
> needs those migrations to use the data normally. Back up the data dir before
> opening it with a build that carries new migrations if you want a clean path back
> to an older version.

Users get the dev by **downloading the separate Cyboflow Dev app** from the
website (Settings → Updates points them there) — there is no in-app opt-in.
