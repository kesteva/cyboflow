---
id: TASK-591
sprint: SPRINT-008
epic: claude-agent-sdk-migration
status: done
summary: "Delete dead main/build-cyboflow-permission-bridge.js (275-line MCP bridge emitter) and scrub asarUnpack + bundle:mcp references; pre-task SDK substrate made it unreachable."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-591 — Delete MCP permission bridge build artifact

## Outcome

Pure deletion + build-config scrub. With TASK-590's PreToolUse-hook rewrite in place, the bridge subprocess emitter (`main/build-cyboflow-permission-bridge.js`) is unreachable. Removed the file, dropped the `bundle:mcp` script and its `&& npm run bundle:mcp` chain from `main/package.json`'s build script, and removed the two `cyboflowPermissionBridge.js` / `cyboflowPermissionBridgeStandalone.js` entries from the root `package.json` `build.asarUnpack` list (electron-builder would otherwise warn on missing files). EPIC success-signal #5 now achievable.

## Files changed

- `main/build-cyboflow-permission-bridge.js` — DELETED
- `main/package.json` — removed `bundle:mcp` script; pruned `build` script
- `package.json` (root) — pruned `build.asarUnpack`

## Verification

- `pnpm typecheck`: PASS (3 workspaces)
- `pnpm lint`: PASS (0 errors)
- `pnpm build:main`: PASS (clean rebuild)
- Verifier: APPROVED 10/10 ACs
- Code-reviewer: CLEAN

## Acknowledged residual

FIND-SPRINT-008-6: `main/src/services/cyboflowPermissionBridge.ts` (TS source) remains on disk. `tsc` will keep emitting `dist/main/src/services/cyboflowPermissionBridge.js` from it on every build (the `main/dist/services/**/*.js` asarUnpack glob will still ship it). The plan explicitly carved this out: per §2, only the JS build artifact is in TASK-591 scope; the TS source's deletion is queued for a future dead-code sweep task. Functionally inert — no spawn callers exist.

## Forward references

- A future dead-code sweep should delete `main/src/services/cyboflowPermissionBridge.ts` and its sibling `cyboflowPermissionIpcServer.ts`/`mcpPermissionServer.ts`/`permissionManager.ts` files now that all approval gating routes through the SDK PreToolUse hook + ApprovalRouter.
- TASK-595 will confirm the SDK substrate is fully operational under PATH-isolation, closing EPIC success-signal #4.
