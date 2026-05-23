---
id: TASK-619
sprint: SPRINT-034
epic: cyboflow-mcp-server
status: done
summary: "Eager-populate cachedNodePathPromise in setOrchSocketPath; await it in composeMcpServers; warn + omit cyboflow entry on reject. Fixes first-session MCP race (FIND-5/FIND-15)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-619 — Done Report

## What changed
- `main/src/services/panels/claude/claudeCodeManager.ts` — `cachedNodePath: string | null` replaced with `cachedNodePathPromise: Promise<string> | null`; eager assignment in `setOrchSocketPath()`; `composeMcpServers()` made `private async`, awaits stored promise, warn + omit cyboflow entry on reject (no bare `'node'` fallback); `buildSdkOptions()` made `async`; await propagated at the `spawnCliProcess` call site.
- `main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts` — new hermetic test file (`vi.mock` for `nodeFinder`, `scriptPath`); 4 tests: eager-population, single-invocation across 3 sessions, reject → warn + omit, never called when `orchSocketPath` unset.

## Verifier
- Verdict: APPROVED.
- Ground truth: 652/652 unit tests pass; pnpm typecheck clean; pnpm lint 0 errors.
- Visual: not_applicable across mobile/web/macos (backend race fix).

## Code review
- Verdict: CLEAN — two minor category-level notes (test-typing gymnastics; defensive-branch coverage) acknowledged with no required changes.

## Test-writer
- NO_TESTS_NEEDED — executor's 4 tests cover every `test_strategy.target`.

## Commits
- `2f41e45 refactor(TASK-619): eager-populate cachedNodePathPromise at boot to fix first-session MCP race`
- `c737858 test(TASK-619): hermetic unit tests for composeMcpServers eager node-path resolution`
