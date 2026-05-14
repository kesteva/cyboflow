---
id: TASK-251
sprint: SPRINT-006
epic: orchestrator-and-trpc-router
status: done
summary: "Install tRPC v11 + trpc-electron + p-queue + superjson + zod deps in main/ and root package.json"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-251 — Done

## Summary

Added the typed-IPC + queue + serialization libraries the orchestrator-and-trpc-router epic depends on. Both `main/package.json` and root `package.json` carry the six entries with identical version ranges so electron-builder bundles them and the main process resolves them at runtime.

## Changes

- `main/package.json` — added `@trpc/client`, `@trpc/server`, `p-queue`, `superjson`, `trpc-electron` to `dependencies` (alphabetically positioned alongside pre-existing `zod`)
- `package.json` — added the same six entries (`@trpc/client`, `@trpc/server`, `p-queue`, `superjson`, `trpc-electron`, `zod`) to `dependencies`
- `pnpm-lock.yaml` — updated by `pnpm install`

## Version decisions

- `@trpc/server` / `@trpc/client`: `>=11.0.0 <12.0.0` (resolved to `11.17.0`). PR #6161 (subscription memory-leak fix) merged 2024-10-29; first stable v11 release `11.0.0` on 2025-03-21 carries the fix.
- `p-queue`: `^7.4.1`. v7 is the last CJS line; `main/package.json` declares `"type": "commonjs"`, making v8 (ESM-only) incompatible without a module-system change.
- `trpc-electron`: `0.1.2` exact pin. Only v11-compatible Electron link (mat-sz fork) — supply-chain risk minimized via exact version.

## Commits

- `3e5f86e feat(TASK-251): install tRPC v11 + trpc-electron + p-queue + superjson deps`

## Verification

- `pnpm install` exit 0, no WARN lines for new packages
- `pnpm install --frozen-lockfile` exit 0 (lockfile consistent)
- `pnpm typecheck` exit 0 across all 3 TS workspaces
- `pnpm lint` exit 0 (0 errors; no new warnings introduced)
- All five acceptance criteria met
- Code review: CLEAN
- Tests: NO_TESTS_NEEDED (plan declared `test_strategy.needed: false`)
