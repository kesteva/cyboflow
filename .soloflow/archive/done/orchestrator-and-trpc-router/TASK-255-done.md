---
id: TASK-255
sprint: SPRINT-006
epic: orchestrator-and-trpc-router
status: done
summary: "Wire tRPC router to renderer via trpc-electron ipcLink; instantiate Orchestrator in main entrypoint"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-255 — Done

## Summary

Bridged the TASK-254 tRPC router to the renderer via `trpc-electron`'s IPC link. `ipcAdapter.ts` is now the only file under `main/src/orchestrator/trpc/` that imports from `'electron'` — the rest of the subtree stays standalone-testable. The Orchestrator is constructed in `main/src/index.ts` after BrowserWindow creation, started, and stopped on `before-quit`. The renderer-side `trpcClient` imports `AppRouter` from `shared/types/trpc` so the dependency direction stays renderer → shared, not renderer → main.

## Changes

- `main/src/orchestrator/trpc/ipcAdapter.ts` (new) — `attachOrchestratorTrpc({ window, router, createContext })`; calls `createIPCHandler` from `trpc-electron/main`; wraps `createContext` in `Promise.resolve(...)` to match trpc-electron's typed signature; TODO(v2) comment for `opts.event` forwarding
- `main/src/orchestrator/trpc/__tests__/ipcAdapter.test.ts` (new) — 2 vitest tests, mocks `'trpc-electron/main'`
- `main/src/preload.ts` (modified) — additive `exposeElectronTRPC()` call; all existing contextBridge surfaces preserved (count 3 → 5)
- `main/src/index.ts` (modified) — `new Orchestrator(...)`, `orchestrator.start()`, `attachOrchestratorTrpc(...)`, `orchestrator.stop()` integrated into the existing `before-quit` handler (no duplicate listener); inline `DatabaseLike` and `LoggerLike` adapters keep `OrchestratorDeps` structurally typed
- `main/src/database/database.ts` (modified) — added public `getDb(): Database.Database` accessor so the inline `DatabaseLike` adapter can delegate `prepare`/`transaction` without bypassing the type system
- `frontend/src/utils/trpcClient.ts` (new) — `createTRPCProxyClient<AppRouter>` with `ipcLink` + `superjson`
- `frontend/tsconfig.json` (modified) — added `../shared` to `include` (resolves FIND-SPRINT-006-6)
- `frontend/package.json` (modified) — declared `@trpc/client`, `trpc-electron`, `superjson` explicitly

## Commits

- `57e1387 feat(TASK-255): add ipcAdapter.ts — only electron-importing file in trpc subtree`
- `be70ede feat(TASK-255): add exposeElectronTRPC() call to preload.ts`
- `62aff75 feat(TASK-255): wire Orchestrator and tRPC IPC handler in index.ts`
- `b98c672 feat(TASK-255): add renderer-side tRPC client (trpcClient.ts)`
- `e4cb107 test(TASK-255): add unit tests for attachOrchestratorTrpc`
- `c62fb8b fix(TASK-255): add shared/ to frontend tsconfig include and declare trpc deps`
- `8548594 fix(TASK-255): replace DatabaseLike cast with inline adapter` (code-review improvement)

## Verification

- 8/9 acceptance criteria MET; AC6 (manual DevTools smoke for end-to-end NOT_IMPLEMENTED) DEFERRED to human-review queue (`testing` bucket)
- `pnpm typecheck` exit 0 across all workspaces
- `pnpm --filter main lint` 0 errors / 228 warnings (baseline)
- `pnpm --filter main test -- ipcAdapter` 2/2 pass
- Full main suite: 177 pass / 22 pre-existing failures (FIND-SPRINT-006-4, better-sqlite3 NODE_MODULE_VERSION 136 vs 137)
- Standalone-typecheck invariant intact: only `ipcAdapter.ts` imports from 'electron'
- Code review: APPROVED on retry; one Important issue (cast bypass) fixed in 8548594

## Open observations / findings

- FIND-SPRINT-006-9: `mainWindow` null-guard in index.ts silently skips tRPC attach instead of throwing loudly. Logged for compounder; not a one-line fix.
- FIND-SPRINT-006-4 (pre-existing): better-sqlite3 native binding mismatch blocks 22 unrelated tests. Fix: `pnpm rebuild better-sqlite3`.
- AC6 deferred: run `pnpm dev`, open DevTools, run `trpcClient.cyboflow.runs.list.query({})`, confirm error string contains `NOT_IMPLEMENTED`.
