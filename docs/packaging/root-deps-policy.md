# Root package.json dependency policy

Cyboflow is a pnpm workspace. Some packages are declared in `main/package.json`
(the Electron main process workspace) but NOT in root `package.json`. This is
intentional in cases where:

1. pnpm hoists the package to the root `node_modules/` via its dedup logic, AND
2. electron-builder's `npmRebuild: true` + `buildDependenciesFromSource: false`
   configuration pulls the hoisted copy into the asar at build time.

## Verified-safe-to-omit packages

_(none yet — see Dead-dep entries below for pending cleanup)_

## Dead dependencies in main/package.json

These packages are listed in `main/package.json` but have **zero importers** in
`main/src/**`. They should be removed from `main/package.json` in a dedicated
cleanup task (deletion is a behavior change requiring an explicit decision, so it
is out of scope here).

- `electron-store@^11.0.0` — declared in `main/package.json` only. As of
  2026-05-19, a full grep of `main/src/**/*.ts` finds no `import … from
  'electron-store'` or `require('electron-store')` call anywhere. The dependency
  appears to be a Crystal-era leftover that was never removed when window-state
  persistence was later handled differently. Root `package.json` intentionally
  omits it — adding it there would only entrench a dead dep in two places.
  Recommended action: remove from `main/package.json` in a follow-up task (see
  findings file for the logged finding).

## When to revisit

If a future packaged build emits MODULE_NOT_FOUND for a workspace-only dep,
move it to root and update this list. Re-verify on any pnpm major-version
upgrade, since hoisting behavior is pnpm-version-dependent.
