# In-app updates (Cloudflare R2 host)

Cyboflow ships signed, notarized macOS builds and updates them in place via
[`electron-updater`](https://www.electron.build/auto-update). The app polls a
public manifest, compares versions, and downloads only the changed bytes. No git,
no GitHub — just HTTPS GETs against a static host.

```
Installed app (vX)
   │  GET https://updates.cyboflow.com/latest-mac.yml   (poll)
   ▼
Cloudflare R2  ──►  version: Y   →   app sees Y > X
   │  GET the .zip (+ .blockmap delta) → verify sha512 + Developer ID signature
   ▼
swap bundle → "Restart to update"
```

The artifacts live in a **Cloudflare R2** bucket served at `updates.cyboflow.com`.
R2 is S3-compatible (so we publish with the S3 SDK) but serves public downloads
with **zero egress fees** and **no credentials in the app** — the source repo stays
private. See [`scripts/publish-update.mjs`](../scripts/publish-update.mjs).

---

## One-time setup (do this once)

### 1. Create the R2 bucket
1. Cloudflare dashboard → **R2** → **Create bucket** → name it `cyboflow-updates`.
2. Bucket → **Settings** → **Public access** → **Custom Domains** → add
   `updates.cyboflow.com`. Cloudflare provisions the cert and DNS automatically
   (the domain must be on the same Cloudflare account; `cyboflow.com` itself can
   stay on Netlify — only the `updates` subdomain points at R2).
3. Verify: after the first publish, `https://updates.cyboflow.com/latest-mac.yml`
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
Keep these out of the repo — use a local `.envrc`/shell profile, or CI secrets:

```bash
export R2_ACCOUNT_ID=...          # Cloudflare account id
export R2_ACCESS_KEY_ID=...       # from the API token
export R2_SECRET_ACCESS_KEY=...   # from the API token
# optional: export R2_BUCKET=cyboflow-updates   (this is the default)
```

(Apple signing/notarization env vars are still required too — see
[`signing/APPLE_DEVELOPER_SETUP.md`](signing/APPLE_DEVELOPER_SETUP.md).)

---

## Cutting a release

1. Bump `version` in `package.json` (e.g. `0.1.2` → `0.1.3`). The updater compares
   this baked-in version against the manifest, so this is what gates the prompt.
2. Build, sign, notarize, and publish in one step:
   ```bash
   pnpm release:mac          # build:mac (signs+notarizes) → publish:r2 (uploads)
   ```
3. Dry-run the upload step alone to see what would publish:
   ```bash
   pnpm build:mac && UPDATE_DRY_RUN=true pnpm publish:r2
   ```

`publish:r2` mirrors everything in `dist-electron` matching `*.yml`/`*.zip`/`*.dmg`/
`*.blockmap` to the bucket root. The `.yml` manifest is uploaded `no-cache`
(it changes every release); the binaries are uploaded `immutable` (their version is
in the filename).

The website's "Download" button should point at the current
`https://updates.cyboflow.com/Cyboflow-<version>-macOS-universal.dmg` for first
installs — auto-update only upgrades an already-installed app.

---

## How the app consumes it

- `main/src/services/appUpdater.ts` wraps `electron-updater`. It is a **no-op in
  dev** (`app.isPackaged === false`) and only runs in packaged builds.
- `autoDownload` is **off** and `autoInstallOnAppQuit` is **off** by design: a
  silent install mid-run could kill an in-progress orchestrator/agent session.
  The flow is explicit — *check → download → "Restart to update"* (see the
  About dialog).
- electron-builder bakes `build.publish` (the generic `updates.cyboflow.com` URL)
  into the packaged `app-update.yml`, so the app knows where to poll with no extra
  config.

---

## Gotchas

| Concern | Detail |
|---|---|
| **Signing identity must be stable** | Auto-update only accepts a build signed by the *same* Developer ID. Don't rotate the cert between releases. |
| **`.zip` is required** | `mac.target: "default"` produces `.dmg` **and** `.zip`. The updater needs the `.zip`; the `.dmg` is only for first install. |
| **Manifest must not be cached** | `latest-mac.yml` is uploaded `no-cache`. If you front it with extra CDN caching, the app won't see new releases until the cache expires. |
| **First install is still manual** | The updater upgrades an installed app only. New users download the `.dmg` from the website. |
| **Canary / channels** | `pnpm canary:mac` builds a prerelease and uploads via the same script. A true separate `beta` channel (`beta-mac.yml` + `allowPrerelease`) is not wired yet — follow-up. |
