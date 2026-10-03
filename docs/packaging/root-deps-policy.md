# Root package.json dependency policy

Cyboflow is a pnpm workspace. Some packages are declared in `main/package.json`
(the Electron main process workspace) but NOT in root `package.json`. This is
intentional in cases where:

1. pnpm hoists the package to the root `node_modules/` via its dedup logic, AND
2. electron-builder's `npmRebuild: true` + `buildDependenciesFromSource: false`
   configuration pulls the hoisted copy into the asar at build time.

## Verified-safe-to-omit packages

_(none yet)_

## Dead dependencies in main/package.json

_(none — see Removed dependencies below)_

## Removed dependencies

- `electron-store@^11.0.0` — removed in TASK-653 (sprint SPRINT-019 follow-up).
  Was declared in `main/package.json` but had zero importers in `main/src/**`,
  `frontend/src/**`, `shared/**`, or `scripts/**` — a Crystal-era leftover.
  Removal verified by repo-wide grep returning zero hits.

- `web-streams-polyfill@^3.3.3` — removed in SPRINT-025 compound (FIND-SPRINT-025-4).
  Zero importers across the repo; Node 22+ (engine floor) ships WHATWG Streams
  natively.

- `dotenv@^16.4.7` — removed in SPRINT-025 compound (FIND-SPRINT-025-5).
  Was declared in BOTH root `package.json` and `main/package.json` with zero
  importers anywhere in the repo. Both declarations removed.

- Crystal-baseline leftovers with zero importers, removed in the Crystal-fork
  cleanup (re-verified by repo-wide grep of every specifier, config files and
  scripts included):
  - root `devDependencies`: `vite-plugin-electron`, `vite-plugin-electron-renderer`
    (never wired into any Vite config) and `wait-on` (replaced by
    `scripts/dev-electron.mjs`'s own `waitOnVite()`).
  - `main/package.json` `devDependencies`: `mkdirp` (its last use, the old
    `copy:assets` script, became `scripts/copy-assets.js`) and `@types/glob`
    (a deprecated stub — `glob@11` ships its own types).
  - `frontend/package.json`: `@radix-ui/react-{alert-dialog,checkbox,dialog,label,slot,tabs}`,
    `class-variance-authority`, `date-fns`, `react-diff-viewer-continued`,
    `react-json-view-lite`, `tailwindcss-animate` (never registered as a Tailwind
    plugin), `@xterm/addon-search`, `uuid` and `@types/uuid` (the renderer uses
    `crypto.randomUUID`; main's `uuid` imports resolve from the root declaration,
    which stays).

## When to revisit

If a future packaged build emits MODULE_NOT_FOUND for a workspace-only dep,
move it to root and update this list. Re-verify on any pnpm major-version
upgrade, since hoisting behavior is pnpm-version-dependent.
