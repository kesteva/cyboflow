---
id: TASK-301
sprint: SPRINT-006
epic: approval-router-and-permission-fix
status: done
summary: "Rename Crystal permission-bridge identifiers to Cyboflow (file names, MCP server name, socket path, --permission-prompt-tool, .mcp.json key, MCP_SOCKET_PATH removal)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-301 — Done

## Summary

Crystal → Cyboflow identity sweep on the permission-bridge path. Eight files renamed or rebranded so the rest of the epic builds on a Cyboflow surface. `MCP_SOCKET_PATH` removed (the bridge always read argv[3], never the env). `getCyboflowSubdirectory` re-export alias added to `crystalDirectory.ts` so callers can use the Cyboflow name while the deeper data-dir flip waits for the `crystal-cuts-and-rebrand` epic.

## Changes

- `main/src/services/mcpPermissionBridge.ts` → `main/src/services/cyboflowPermissionBridge.ts` (server name `cyboflow-permissions`)
- `main/src/services/permissionIpcServer.ts` → `main/src/services/cyboflowPermissionIpcServer.ts` (class `CyboflowPermissionIpcServer`, socket filename `cyboflow-permissions-${pid}.sock`)
- `main/src/services/mcpPermissionServer.ts` (server name updated)
- `main/src/services/panels/claude/claudeCodeManager.ts` (`--permission-prompt-tool mcp__cyboflow-permissions__approve_permission`, MCP_SOCKET_PATH env removed, bridge script + `.mcp.json` filenames + key updated)
- `main/src/services/cliManagerFactory.ts` (MCP_SOCKET_PATH removed from optionalEnvVars)
- `main/src/index.ts` (import + variable type renamed)
- `main/build-mcp-bridge.js` → `main/build-cyboflow-permission-bridge.js`
- `main/src/utils/crystalDirectory.ts` (additive: `getCyboflowSubdirectory = getCrystalSubdirectory` alias with transitional JSDoc)
- `package.json` (`asarUnpack` entries renamed)
- `main/package.json` (`bundle:mcp` script renamed)

## Commits

- `b3489b8 feat(TASK-301): rename mcpPermissionBridge to cyboflowPermissionBridge`
- `d6d44de fix(TASK-301): rename permissionIpcServer variable to cyboflowPermissionIpcServer`

## Verification

- All 11 acceptance criteria MET
- Sweep grep returns 0 matches for `crystal-permissions | mcpPermissionBridge | crystal-mcp- | MCP_SOCKET_PATH` across main/src/, the renamed builder, and package.json
- `pnpm run build:main` exit 0
- `pnpm typecheck` (main, frontend, shared) all Done
- `pnpm --filter main lint` 0 errors / 227 warnings (baseline)
- Code review: CLEAN
- Tests: NO_TESTS_NEEDED (plan declared test_strategy.needed: false; behavioral coverage in TASK-302+)

## Notes

- FIND-SPRINT-006-11 (scope_deviation on crystalDirectory.ts) resolved — plan-prescribed in Implementation Step 3.
- FIND-SPRINT-006-12 logged: `asarUnpack` paths point at `main/dist/services/cyboflowPermissionBridge.js` but tsc emits to `main/dist/main/src/services/...`. Pre-existing defect inherited from the legacy entries; rescued at runtime by the asar-path detection + temp-extraction in `claudeCodeManager.ts:698`. Tracked for compound.
- Stale "Crystal process" comments in claudeCodeManager.ts and bridge headers intentionally deferred to `crystal-cuts-and-rebrand` epic.
