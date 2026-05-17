---
id: TASK-618
idea: null
status: approved
created: 2026-05-16T00:00:00Z
files_owned:
  - package.json
  - main/src/orchestrator/mcpServer/scriptPath.ts
  - main/src/orchestrator/mcpServer/__tests__/scriptPath.test.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpServerLifecycle.test.ts
  - docs/ARCHITECTURE.md
files_readonly:
  - main/src/orchestrator/mcpServer/mcpServerLifecycle.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/utils/crystalDirectory.ts
  - main/tsconfig.json
acceptance_criteria:
  - criterion: "package.json asarUnpack contains the corrected MCP server emit path and the old non-matching path is gone."
    verification: "grep -nE '\"main/dist/main/src/orchestrator/mcpServer/\\*\\*/\\*\\.js\"' package.json returns 1 match; grep -nE '\"main/dist/orchestrator/mcpServer/' package.json returns 0 matches"
  - criterion: "After pnpm run build:mac:arm64, the packaged .app contains cyboflowMcpServer.js under app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/."
    verification: "find dist-electron -path '*app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js' returns ≥1 match"
  - criterion: "resolveMcpServerScriptPath() no longer writes to ~/.cyboflow/ in packaged builds; returns process.resourcesPath + app.asar.unpacked path."
    verification: "grep -nE 'getCrystalSubdirectory\\(SCRIPT_FILENAME\\)|writeFileSync\\(extractedPath' main/src/orchestrator/mcpServer/scriptPath.ts returns 0 matches; grep -nE 'process\\.resourcesPath' main/src/orchestrator/mcpServer/scriptPath.ts returns ≥1 match"
  - criterion: "resolveMcpServerScriptPath() is memoized at module level."
    verification: "grep -nE '(cachedResolvedPath|memoiz)' main/src/orchestrator/mcpServer/scriptPath.ts returns ≥2 matches"
  - criterion: "New unit test file scriptPath.test.ts covers dev-mode, packaged-mode, and memoization (3+ tests)."
    verification: "test -f main/src/orchestrator/mcpServer/__tests__/scriptPath.test.ts; pnpm --filter main exec vitest run scriptPath exits 0"
  - criterion: "Existing mcpServerLifecycle.test.ts continues to pass."
    verification: "pnpm --filter main exec vitest run mcpServerLifecycle exits 0"
  - criterion: "docs/ARCHITECTURE.md documents the asarUnpack contract for the MCP server script."
    verification: "grep -nE 'cyboflowMcpServer|app\\.asar\\.unpacked' docs/ARCHITECTURE.md returns ≥1 match"
  - criterion: "pnpm typecheck and pnpm lint pass."
    verification: "pnpm typecheck exits 0; pnpm lint exits 0"
depends_on: []
estimated_complexity: medium
epic: cyboflow-mcp-server
test_strategy:
  needed: true
  justification: "Two verification surfaces: memoization invariant (unit-testable) and asarUnpack glob correctness (empirical — requires packaged build)."
  targets:
    - behavior: "Dev mode returns <dirOverride>/cyboflowMcpServer.js"
      test_file: "main/src/orchestrator/mcpServer/__tests__/scriptPath.test.ts"
      type: unit
    - behavior: "Packaged mode returns process.resourcesPath + app.asar.unpacked path; no fs writes"
      test_file: "main/src/orchestrator/mcpServer/__tests__/scriptPath.test.ts"
      type: unit
    - behavior: "Memoization: 5 calls invoke the underlying resolver at most once"
      test_file: "main/src/orchestrator/mcpServer/__tests__/scriptPath.test.ts"
      type: unit
prerequisites:
  - check: "test -f main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js"
    fix: "Run pnpm run build:main to produce the tsc emit."
    description: "Confirms the tsc emit layout is observable so the executor can verify the new asarUnpack glob against ground truth."
    blocking: true
---

# TASK-618: Fix asarUnpack glob and replace runtime ~/.cyboflow/ extraction with process.resourcesPath resolution

## Objective

`cyboflowMcpServer.js` is currently handled by two contradictory strategies: (1) `package.json:106` asarUnpack glob `main/dist/orchestrator/mcpServer/**/*.js` does NOT match the real tsc emit at `main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js` (the extra `main/src/` segment is unavoidable given the tsconfig layout); (2) `scriptPath.ts` runs `readFileSync + mkdirSync + writeFileSync + chmodSync` unconditionally in packaged DMGs. The runtime extraction is what makes packaged builds work today; the asarUnpack entry is dead config. Fix the glob AND switch to `process.resourcesPath`-based resolution, matching the canonical `mcpPermissionServer.ts` (TASK-584) pattern. Resolves FIND-6, FIND-12, FIND-13.

## Implementation Steps

1. **Fix the asarUnpack glob in `package.json:106`** — replace `"main/dist/orchestrator/mcpServer/**/*.js"` with `"main/dist/main/src/orchestrator/mcpServer/**/*.js"`.

2. **Rewrite `scriptPath.ts`**:
   - Remove `fs` import; remove `getCrystalSubdirectory` import.
   - Add module-level `cachedResolvedPath: string | null = null`.
   - In packaged mode: `path.join(process.resourcesPath, 'app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js')`.
   - In dev mode: `path.join(dirOverride ?? __dirname, 'cyboflowMcpServer.js')`.
   - Memoize (skip cache when `dirOverride` is provided so tests can drive both branches).
   - Export `__resetCacheForTests()` for the new test file.

3. **Create `scriptPath.test.ts`** with three tests: dev-mode override, packaged-mode resourcesPath join, memoization (5 calls → 1 underlying resolution).

4. **Verify `mcpServerLifecycle.test.ts:82-84`'s mock surface** still works (the existing `vi.mock('../scriptPath', () => ({ resolveMcpServerScriptPath: vi.fn(...) }))` covers the same signature).

5. **Build + smoke**:
   - `pnpm run build:main` → confirm `main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js` exists.
   - `pnpm run build:mac:arm64` (or `SKIP_SIGNING=1`).
   - `find dist-electron -path '*app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js'` returns ≥1 match.
   - Manual: `rm -f ~/.cyboflow/cyboflowMcpServer.js`, launch packaged app, create Claude session, confirm log shows no spawn error and the file was NOT re-created in `~/.cyboflow/`.

6. **Document** — add a subsection to `docs/ARCHITECTURE.md` covering the asarUnpack contract (mirror the TASK-584 entry).

7. **Verify** — typecheck, lint, full test suite all pass.

## Hardest Decision

Fix the glob + switch to `process.resourcesPath` (option a) vs. drop the glob and keep extract-to-`~/.cyboflow/` with memoization (option b). Chose (a) — aligns with TASK-584's permission-bridge pattern, eliminates the stale-file failure mode, removes all four sync syscalls per call.

## Lowest Confidence Area

Whether `pnpm run build:mac:arm64` can actually run on the executor's machine (signing credentials, electron-builder install). If not, complete steps 1-4 + 6-7 and document the manual smoke as deferred to QA in the done report. The AC2 + AC6 paragraph above gates on the packaged build but the rest of the work is sound without it.
