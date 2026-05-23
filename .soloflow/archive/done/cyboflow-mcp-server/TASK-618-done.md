---
id: TASK-618
sprint: SPRINT-034
epic: cyboflow-mcp-server
status: done
summary: "Fix asarUnpack glob and replace ~/.cyboflow/ runtime extraction with process.resourcesPath + memoized resolver; packaged-build smoke deferred to QA."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-618 — Done Report

## What changed
- `package.json` — `build.asarUnpack` glob fixed to `main/dist/main/src/orchestrator/mcpServer/**/*.js` matching the real tsc emit layout.
- `main/src/orchestrator/mcpServer/scriptPath.ts` — full rewrite: removed `fs` and `getCyboflowSubdirectory` imports; switched packaged-mode resolution to `path.join(process.resourcesPath, 'app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js')`; module-level `cachedResolvedPath` memoization; `__resetCacheForTests()` exported for test isolation.
- `main/src/orchestrator/mcpServer/__tests__/scriptPath.test.ts` — new file, 6 unit tests across dev-mode, packaged-mode, and memoization.
- `docs/ARCHITECTURE.md` — added asarUnpack contract subsection documenting the glob, the resolved `app.asar.unpacked` path, the `process.resourcesPath` runtime pattern, and memoization.

## Verifier
- Verdict: APPROVED_WITH_DEFERRED.
- Ground truth: 648/648 tests pass; pnpm typecheck clean; pnpm lint 0 errors.
- Visual: not_applicable (backend/packaging change with no UI).
- Deferred (queued under `bucket: actions`): run `pnpm run build:mac:arm64` once Apple notarytool credentials are configured to verify AC2 (`find dist-electron -path '*app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js'`) and the manual packaged-app smoke (no spawn error, no re-extraction to `~/.cyboflow/`).

## Code review
- Verdict: CLEAN — no findings.

## Test-writer
- NO_TESTS_NEEDED — executor's 6 unit tests cover every test_strategy.target.

## Commits
- `6293ef9 fix(TASK-618): fix asarUnpack glob and replace extraction with resourcesPath resolution`
- `ba783d6 test(TASK-618): add scriptPath.test.ts and update ARCHITECTURE.md asarUnpack docs`
