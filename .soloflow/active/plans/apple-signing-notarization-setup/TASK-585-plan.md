---
id: TASK-585
idea: SPRINT-006-compound
status: in-flight
source_sprint: SPRINT-006
created: "2026-05-14T00:00:00Z"
files_owned:
  - package.json
files_readonly:
  - main/package.json
  - pnpm-lock.yaml
  - .soloflow/active/findings/SPRINT-006-findings.md
  - .soloflow/active/compound/SPRINT-006-proposal.md
  - .soloflow/active/plans/apple-signing-notarization-setup/EPIC-apple-signing-notarization-setup.md
  - .soloflow/active/plans/orchestrator-and-trpc-router/TASK-251-plan.md
acceptance_criteria:
  - criterion: "Decision resolved: either (a) `electron-store` is added to root package.json `dependencies`, OR (b) a comment in package.json `dependencies` (or an inline JSON5-style adjacent doc) documents why the root omission is safe"
    verification: "Either: (a) `grep -nE '\"electron-store\":' package.json` returns 1 match in the `dependencies` block (with version `^11.0.0` matching main/package.json); OR (b) a peer markdown file `docs/packaging/root-deps-policy.md` exists with a section explaining the electron-store parity exception (since JSON disallows comments). The done report names which path was chosen."
  - criterion: "A packaged build was produced and launched; `require('electron-store')` at runtime resolves successfully (no `MODULE_NOT_FOUND` in the packaged app logs)"
    verification: "Manual smoke in done report: launch packaged build; check `~/.cyboflow/logs/` and the packaged app's main-process console for any `Cannot find module 'electron-store'` error — must be absent. If the app uses electron-store at startup (e.g. for window-state restoration), the absence of MODULE_NOT_FOUND in logs is sufficient. If electron-store is only conditionally required, the executor should add a one-line `console.log('[smoke] electron-store version:', require('electron-store').version)` to a startup path temporarily and verify in the packaged build's logs."
  - criterion: "If path (a) was chosen: the root version matches main/package.json's `^11.0.0` exactly to avoid pnpm hoisting divergence"
    verification: "Run `node -e \"const r=require('./package.json'); const m=require('./main/package.json'); if (!r.dependencies['electron-store']) process.exit(0); if (r.dependencies['electron-store'] !== m.dependencies['electron-store']) { console.error('version mismatch'); process.exit(1); } process.exit(0);\"` exits 0"
  - criterion: Top-level `pnpm install` succeeds without warnings about missing peer deps for electron-store
    verification: pnpm install exits 0; the install output does not contain new warnings mentioning electron-store
  - criterion: Top-level typecheck and lint pass
    verification: pnpm typecheck exits 0; pnpm lint exits 0
prerequisites:
  - check: "command -v electron-builder >/dev/null 2>&1 || test -f node_modules/.bin/electron-builder"
    fix: Run `pnpm install` at the repo root.
    description: A packaged build is required for the runtime-resolution AC; electron-builder must be available.
    blocking: true
  - check: "test -n \"$APPLE_TEAM_ID\" || test \"$SKIP_SIGNING\" = \"1\""
    fix: "Either export Apple signing creds per docs/signing/APPLE_DEVELOPER_SETUP.md, or set SKIP_SIGNING=1 for an unsigned build."
    description: configure-build.js gates on signing creds; without an explicit opt-out the build step may fail before the asar is assembled.
    blocking: false
depends_on: []
estimated_complexity: low
epic: apple-signing-notarization-setup
test_strategy:
  needed: false
  justification: "Pure packaging verification — the AC is whether `require('electron-store')` resolves in a packaged build, which cannot be tested in vitest (no real asar assembly). Sibling-test scan: no test files exist at the package.json level. The packaged-build smoke captured in the done report IS the test."
---
# Verify electron-store root package.json dep parity (or document why not)

## Objective

`electron-store@^11.0.0` lives in `main/package.json:26` (the workspace's `main` package) but is absent from root `package.json` `dependencies` (which includes `trpc-electron`, `p-queue`, `superjson`, but not `electron-store`). TASK-251's plan rationale was that root deps are what `electron-builder` reads when assembling the asar, so root-level inclusion would be required for packaged builds to resolve the module. The current packaged build *might* work because of pnpm hoisting + `npmRebuild: true` — but the inconsistency is undocumented and a future contributor reading TASK-251's reasoning would believe the current state is broken.

Resolve the inconsistency one of two ways: add `electron-store` to root, OR document why it is safe to omit.

## Implementation Steps

1. **Build a packaged binary**:
   ```
   pnpm install
   pnpm run build:main
   pnpm run build:mac:arm64   # set SKIP_SIGNING=1 if creds unavailable
   ```

2. **Launch the packaged build and inspect**:
   - Open `dist-electron/mac-arm64/Cyboflow.app` (or whatever the build produced).
   - Inspect the packaged app's main process logs at `~/.cyboflow/logs/` (or via attaching to the process — the app forwards backend logs there).
   - Search for `Cannot find module 'electron-store'` or `MODULE_NOT_FOUND`.

3. **Verify `electron-store` is actually used.** Run a grep to confirm whether the package is currently imported anywhere:
   ```
   grep -rn --include='*.ts' "from 'electron-store'\|require('electron-store')" main/src
   ```
   If the result is empty, the parity question is **moot** — the dep is dead. Take the "delete from main/package.json" path instead (note: this is a behavior-change beyond the scope as written; if zero importers, escalate to the user before proceeding, since the deletion path needs an explicit decision).

   If the result is non-empty, proceed with one of the two paths below.

4. **Branch (a): Add to root `dependencies`** if step 2's smoke shows MODULE_NOT_FOUND or the executor wants belt-and-suspenders parity:
   - Edit root `package.json`, add `"electron-store": "^11.0.0"` in the `dependencies` block (alphabetical order: between `dotenv` and `electron-updater`).
   - Run `pnpm install`.
   - Re-run the packaged build and re-verify.

5. **Branch (b): Document the safe-omission** if step 2's smoke shows the module resolves without root listing:
   - Create `docs/packaging/root-deps-policy.md` with content:
     ```
     # Root package.json dependency policy

     Cyboflow is a pnpm workspace. Some packages are declared in `main/package.json`
     (the Electron main process workspace) but NOT in root `package.json`. This is
     intentional in cases where:

     1. pnpm hoists the package to the root `node_modules/` via its dedup logic, AND
     2. electron-builder's `npmRebuild: true` + `buildDependenciesFromSource: false`
        configuration pulls the hoisted copy into the asar at build time.

     ## Verified-safe-to-omit packages

     - `electron-store@^11.0.0` — declared in `main/package.json` only. Verified
       on <DATE> by <build SHA / DMG name>: a packaged build resolves
       `require('electron-store')` at runtime without root-level inclusion.
       Re-verify on any pnpm major-version upgrade, since hoisting behavior is
       pnpm-version-dependent.

     ## When to revisit

     If a future packaged build emits MODULE_NOT_FOUND for a workspace-only dep,
     move it to root and update this list.
     ```
   - Reference the doc from `package.json` indirectly: since JSON cannot embed comments, add a no-op `"//"` key adjacent to `dependencies` is not portable across all JSON parsers; the executor should instead update `docs/ARCHITECTURE.md` (or wherever packaging is described) to point at the new doc.

6. **Record the decision in the done report**: state which path (a or b) was chosen, the smoke evidence (logs / observed behavior), and a one-line rationale.

7. **Run typecheck and lint**:
   ```
   pnpm typecheck
   pnpm lint
   ```

## Acceptance Criteria

See frontmatter. Five criteria.

## Test Strategy

See frontmatter `test_strategy`. No new unit tests — packaging is a build-time concern.

## Hardest Decision

**Branch (a) vs (b).** Chosen: **let the empirical packaged-build smoke decide**, then document. Adding to root unconditionally would be the safest defensive choice, but it adds maintenance friction (two version strings to keep in sync, an inflated root `dependencies` block that doesn't actually run in renderer or root scope). If the smoke shows the module resolves correctly without root inclusion, branch (b) preserves the pnpm-workspace boundaries that exist for good reasons.

## Rejected Alternatives

- **Unconditionally add to root `dependencies` to mirror main/package.json.** Rejected: that's the "obvious" fix but doesn't actually verify the failure mode. A documented parity-exception is more informative for future contributors.
- **Delete electron-store from main/package.json if unused.** Rejected: out of scope unless step 3 reveals zero importers, in which case escalation to the user is the right move (deletion is a behavior change, not a documentation change).
- **Move electron-store to `peerDependencies` of main package.** Rejected: misuses the peerDependencies semantic. The package is a runtime dep, not a peer.

## Lowest Confidence Area

The "logs show no MODULE_NOT_FOUND" verification. The packaged app's main process logs only what the app explicitly calls — if electron-store is only `require`d on a code path not exercised at launch (e.g. only when the user opens settings for the first time), MODULE_NOT_FOUND won't surface in the smoke. Step 3's grep is the protective check: if a usage exists, the executor should exercise that code path during the smoke (e.g. open settings, restart, observe). If the grep returns empty, the parity question is moot and the deletion-or-escalation branch applies.
