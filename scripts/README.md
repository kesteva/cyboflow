# Scripts

Build, release, and debugging helpers for Cyboflow. Most are wired into `package.json`
scripts or CI; the CDP/debug helpers are run by hand against a running `pnpm dev` app
(see `docs/VISUAL-VERIFICATION-SETUP.md` and `docs/PERFORMANCE.md`).

**Build and packaging**
- `inject-build-info.js`, `configure-build.js` — stamp `main/dist/buildInfo.json` and the electron-builder config.
- `bundle-mcp-server.mjs`, `bundle-preload.mjs`, `bundle-verify-driver.mjs` — make standalone/sandboxed entrypoints self-contained.
- `install-app-deps.js`, `apply-pty-napi-prebuilds.js`, `ensure-sqlite-abi.mjs`, `rebuild-better-sqlite3-host.mjs` — native-addon ABI handling.
- `generate-icons.sh`, `make-ico.mjs` — regenerate brand raster assets and the Windows `.ico`.
- `verify-schema-parity.js` — migration/schema parity check.

**Release and analytics**
- `publish-update.mjs`, `gen-mac-latest-yml.mjs` — publish the R2 update feed.
- `r2-download-stats.mjs`, `snapshot-download-stats.mjs` — download analytics.

**Dev and debugging**
- `dev-electron.mjs` — Electron launcher used by the dev scripts.
- `cdp-eval.mjs`, `eval-cdp.mjs`, `cdp-shot.mjs`, `trpc-call.mjs` — drive the running renderer over CDP.
- `profile-electron.mjs` — CPU/memory profiling harness.
- `sentry-digest-hunt.mjs` — recover the plaintext behind a Sentry `errorDigest` tag.
- `sdk-smoke-probe.ts` — Claude SDK smoke probe.
