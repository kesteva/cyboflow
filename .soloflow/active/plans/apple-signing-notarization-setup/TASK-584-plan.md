---
id: TASK-584
idea: SPRINT-006-compound
status: in-flight
source_sprint: SPRINT-006
created: "2026-05-14T00:00:00Z"
files_owned:
  - package.json
  - docs/ARCHITECTURE.md
  - main/src/services/panels/claude/claudeCodeManager.ts
files_readonly:
  - main/build-cyboflow-permission-bridge.js
  - main/package.json
  - .soloflow/active/findings/SPRINT-006-findings.md
  - .soloflow/active/compound/SPRINT-006-proposal.md
  - .soloflow/active/plans/apple-signing-notarization-setup/EPIC-apple-signing-notarization-setup.md
acceptance_criteria:
  - criterion: "package.json asarUnpack entries reference the correct tsc emit layout: `main/dist/main/src/services/cyboflowPermissionBridge.js`, `main/dist/main/src/services/cyboflowPermissionBridgeStandalone.js`, and a (more bounded) glob for any service dependency files the bridge requires"
    verification: "grep -nE '\"main/dist/main/src/services/cyboflowPermissionBridge\\.js\"' package.json returns 1 match; grep -nE '\"main/dist/main/src/services/cyboflowPermissionBridgeStandalone\\.js\"' package.json returns 1 match; grep -nE '\"main/dist/services/' package.json returns 0 matches (the old wrong paths are gone)"
  - criterion: "After a packaged build (`pnpm run build:mac:arm64` or equivalent), the bridge `.js` files appear at `dist-electron/*.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/services/` — i.e. asarUnpack actually placed them there"
    verification: "After packaged build completes, `find dist-electron/*.app -path '*app.asar.unpacked/main/dist/main/src/services/cyboflowPermissionBridge*'` returns at least 2 matches (bridge + standalone). Record the absolute paths in the done report."
  - criterion: "At runtime in the packaged build, `claudeCodeManager.ts:674-676`'s `__dirname` resolves to a path under `app.asar.unpacked/` (not a temp-extract path), so the script-from-asar fallback at `claudeCodeManager.ts:698-722` is no longer triggered for every session"
    verification: "Manual smoke test in the packaged build: launch the app, create a Claude session, observe in logs that the `[MCP] Detected ASAR packaging, extracting script` warning at claudeCodeManager.ts:700 is NOT printed (i.e. `mcpBridgePath` no longer includes `.asar`). Record the observed mcpBridgePath value in the done report."
  - criterion: "The `main/dist/services/**/*.js` wildcard is replaced with a more-bounded glob; the executor explicitly enumerates which dependency files the bridge needs to access at runtime (likely zero — both `cyboflowPermissionBridge.ts` and the standalone use only stdlib + `@modelcontextprotocol/sdk`, both of which are already covered by `node_modules/**/*.node` and the asar-inclusion default)"
    verification: "grep -nE '\"main/dist/main/src/services/\\*\\*/\\*\\.js\"' package.json returns 0 matches (overly-broad glob removed); the package.json `build.asarUnpack` array has at most 2 dist-tree entries (bridge + standalone)."
  - criterion: "docs/ARCHITECTURE.md documents the asarUnpack convention: that `main/dist/main/src/services/cyboflowPermissionBridge.js` and `*Standalone.js` are unpacked because they are spawned as external `node` subprocesses and cannot run from inside ASAR"
    verification: "grep -nE 'asarUnpack|app\\.asar\\.unpacked' docs/ARCHITECTURE.md returns at least 1 match in proximity to a section mentioning the permission bridge"
  - criterion: "Main process build succeeds (`pnpm run build:main` runs the standalone bundler step + tsc emit successfully)"
    verification: "pnpm run build:main exits 0; the resulting `main/dist/main/src/services/cyboflowPermissionBridge.js` and `cyboflowPermissionBridgeStandalone.js` both exist"
  - criterion: Top-level typecheck and lint pass
    verification: pnpm typecheck exits 0; pnpm lint exits 0
prerequisites:
  - check: "find main/dist -name 'cyboflowPermissionBridge*' 2>/dev/null | grep -q '.'"
    fix: "Run `pnpm run build:main` first. The asarUnpack path-correction relies on observing the actual emit layout, and tsc must have emitted at least once."
    description: "Confirms the tsc emit layout is observable on disk; without a prior build, the executor cannot empirically verify the unpack paths point at real files."
    blocking: true
  - check: "command -v electron-builder >/dev/null 2>&1 || test -f node_modules/.bin/electron-builder"
    fix: Run `pnpm install` at the repo root. electron-builder is in devDependencies and a packaged build cannot be produced without it.
    description: A packaged build is required to verify the runtime AC (post-unpack file layout under app.asar.unpacked).
    blocking: true
  - check: "test -n \"$APPLE_TEAM_ID\" || test \"$SKIP_SIGNING\" = \"1\""
    fix: "Either export APPLE_TEAM_ID + APPLE_ID + APPLE_PASSWORD per docs/signing/APPLE_DEVELOPER_SETUP.md, or set SKIP_SIGNING=1 to use the unsigned build path (scripts/configure-build.js gates on these)."
    description: "Packaged-build smoke needs either signing credentials or an explicit opt-out so configure-build.js doesn't fail mid-flow."
    blocking: false
depends_on: []
estimated_complexity: medium
epic: apple-signing-notarization-setup
test_strategy:
  needed: false
  justification: "The verification is empirical — `pnpm run build:main` + a packaged build + `find`-based path inspection. No unit-testable behavior exists for asarUnpack rules (electron-builder consumes them at build time and they cannot be exercised in vitest). Sibling-test scan: no test files exist at `main/__tests__/` or near `package.json`; the existing `build/afterSign.test.js` exercises the JAR-strip step, not asarUnpack. The packaged-build smoke captured in the done report IS the test."
---
# Fix asarUnpack paths to match tsc output layout

## Objective

`package.json:105-107` `asarUnpack` references `main/dist/services/cyboflowPermissionBridge.js`, `main/dist/services/cyboflowPermissionBridgeStandalone.js`, and `main/dist/services/**/*.js`. The tsc emit layout is `main/dist/main/src/services/...` (verified by `find main/dist -name 'cyboflowPermissionBridge*'`). The unpack rules match **zero** files. The reason the app currently works is the runtime fallback at `claudeCodeManager.ts:698-722`: it detects the bridge path is inside `.asar`, reads the file as a string, writes it to `~/.cyboflow/<sessionId>.js`, and spawns from there. That fallback is a workaround for a packaging bug — it adds per-session disk I/O and a temp-script proliferation that gets stale.

This task corrects the asarUnpack paths so the bridge `.js` ships pre-extracted to `app.asar.unpacked/main/dist/main/src/services/`. The runtime fallback stays in place (defense-in-depth + dev-mode parity), but the warn-log "Detected ASAR packaging, extracting script" should never fire in a packaged build after this task lands.

## Implementation Steps

1. **Edit `package.json` `build.asarUnpack`**. Replace the three current entries (lines 105-107):
   ```json
   "main/dist/services/cyboflowPermissionBridge.js",
   "main/dist/services/cyboflowPermissionBridgeStandalone.js",
   "main/dist/services/**/*.js"
   ```
   With the corrected paths:
   ```json
   "main/dist/main/src/services/cyboflowPermissionBridge.js",
   "main/dist/main/src/services/cyboflowPermissionBridgeStandalone.js"
   ```
   The two-entry version drops the wildcard glob. Justification: both bridge entry-points run as external `node` subprocesses and require only stdlib (`net`, `fs`, `path`, `os`, `crypto`) plus `@modelcontextprotocol/sdk` (for the non-standalone version). `node_modules/**/*.node` already covers native modules. There are no transitively-imported `main/src/services/*` files the bridge needs at runtime (it does NOT import `cyboflowPermissionIpcServer.ts` or `approvalRouter.ts` — those run in the main process). If the executor finds a transitive dep at packaged-build time, they may add a narrow `main/dist/main/src/services/<specific>.js` entry and document why in the done report.

2. **Build the main process and inspect the emit layout** (prerequisite probe):
   ```
   pnpm run build:main
   find main/dist -name 'cyboflowPermissionBridge*'
   ```
   Confirm exactly two files emerge: `main/dist/main/src/services/cyboflowPermissionBridge.js` and `main/dist/main/src/services/cyboflowPermissionBridgeStandalone.js`. If the layout has shifted (e.g. a future tsconfig change moves emit roots), update the asarUnpack paths accordingly.

3. **Produce a packaged build**:
   ```
   pnpm run build:mac:arm64   # or build:mac:x64 depending on host arch
   ```
   If signing credentials are not available, set `SKIP_SIGNING=1` per `scripts/configure-build.js` to take the unsigned-build path.

4. **Verify post-unpack layout**:
   ```
   find dist-electron/*.app -path '*app.asar.unpacked/main/dist/main/src/services/cyboflowPermissionBridge*'
   ```
   Both bridge files must appear under `app.asar.unpacked/main/dist/main/src/services/`. Record the absolute paths in the done report.

5. **Launch the packaged build** (`open dist-electron/mac-arm64/Cyboflow.app` or equivalent), create a Claude session, and check the app logs at `~/.cyboflow/logs/`. Confirm:
   - `[MCP] Detected ASAR packaging, extracting script` does NOT appear (claudeCodeManager.ts:700)
   - `mcpBridgePath` resolves to `<app>/Contents/Resources/app.asar.unpacked/main/dist/main/src/services/cyboflowPermissionBridgeStandalone.js`
   - A permission prompt round-trips successfully
   Record the observed `mcpBridgePath` value in the done report.

6. **Edit `docs/ARCHITECTURE.md`** — add a short section near the existing "Frameworks & External Dependencies" or under a new "Packaging" subsection:
   ```
   ### asarUnpack contract

   `main/dist/main/src/services/cyboflowPermissionBridge.js` and
   `cyboflowPermissionBridgeStandalone.js` are listed in `package.json` `build.asarUnpack`
   because they are spawned as external `node` subprocesses (the MCP permission bridge) and
   Node cannot `require` or execute files from inside an ASAR archive. The runtime fallback
   in `claudeCodeManager.ts:698-722` (read-from-asar, write-to-temp) is a defensive
   safety net for dev/edge cases; in a correctly-packaged build, it should never fire.
   ```

7. **Decision point on the runtime fallback**: this task does NOT remove the fallback at `claudeCodeManager.ts:698-722`. Removing it is out of scope — the fallback also exists to gracefully handle the dev-mode case where `__dirname` might point inside `.asar` during weird CI/build-config combinations. Leave it intact; the done report should note the fallback's `[MCP] Detected ASAR packaging` warning is now expected to never fire in production, and a future task can decide whether to delete it.

8. **Run typecheck and lint**:
   ```
   pnpm typecheck
   pnpm lint
   ```

## Acceptance Criteria

See frontmatter. Seven criteria covering the package.json edit, packaged-build verification, runtime smoke, doc note, and the standard build chain.

## Test Strategy

See frontmatter `test_strategy`. No new unit tests — asarUnpack is a build-time concern that cannot be exercised by vitest. The packaged-build smoke and the `find`-based filesystem assertion are the verification.

## Hardest Decision

**Whether to remove the `main/dist/services/**/*.js` wildcard entirely or fix its path.** Chosen: **remove it**. The wildcard was originally intended to unpack any transitively-imported service files the bridge might `require`, but inspection of both bridges shows zero such imports — the standalone bridge is fully self-contained (built via `main/build-cyboflow-permission-bridge.js` which inlines everything), and the non-standalone bridge only imports stdlib + `@modelcontextprotocol/sdk`. A wildcard glob unpacking ~50+ `.js` files inflates the unpacked size unnecessarily. If a future bridge dependency emerges, a targeted entry is preferable to a wildcard.

## Rejected Alternatives

- **Keep the wildcard glob, just fix its prefix.** Rejected: bloats the unpacked tree with files no subprocess reads. Failure mode is silent (works correctly but ships extra bytes), so easy to overlook.
- **Delete the runtime extract-and-spawn fallback at claudeCodeManager.ts:698-722.** Rejected: out of scope for this task. The fallback's only failure mode is per-session disk I/O — minor compared to losing dev-mode parity if `__dirname` ever shifts in an unexpected way. Leave the fallback and follow up separately if it ever fires in a packaged build.
- **Replace asarUnpack with `asar: false` for the bridge files.** Rejected: turning off asar globally would lose the substantial cold-start improvement asar provides. Targeted `asarUnpack` is exactly the right mechanism.

## Lowest Confidence Area

The "no transitively-imported service files" claim (step 1). The executor should empirically verify by running the packaged build and watching for `MODULE_NOT_FOUND` errors at bridge-spawn time. If any appear, add the missing file(s) to `asarUnpack` as targeted entries and document why in the done report — that signal is the only reliable way to discover hidden runtime deps.
