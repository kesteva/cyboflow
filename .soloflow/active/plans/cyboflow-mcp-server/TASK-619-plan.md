---
id: TASK-619
idea: null
status: approved
created: 2026-05-16T00:00:00Z
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts
files_readonly:
  - main/src/utils/nodeFinder.ts
  - main/src/orchestrator/mcpServer/mcpServerLifecycle.ts
  - main/src/orchestrator/mcpServer/scriptPath.ts
acceptance_criteria:
  - criterion: "ClaudeCodeManager has a cachedNodePathPromise field populated inside setOrchSocketPath() by calling findNodeExecutable() at that boot moment."
    verification: "grep -n 'cachedNodePathPromise' main/src/services/panels/claude/claudeCodeManager.ts returns ≥2 matches"
  - criterion: "The fire-and-forget void findNodeExecutable().then(...) block in composeMcpServers() is removed."
    verification: "grep -n 'void findNodeExecutable' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches AND grep -nE 'cachedNodePath\\s*\\?\\?\\s*[\\x27\\\"]node[\\x27\\\"]' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches"
  - criterion: "composeMcpServers() is async and awaits the resolved node path."
    verification: "grep -nE 'private\\s+async\\s+composeMcpServers' main/src/services/panels/claude/claudeCodeManager.ts returns 1 match"
  - criterion: "buildSdkOptions() is async and its only call site in spawnCliProcess awaits it."
    verification: "grep -nE 'private\\s+async\\s+buildSdkOptions' main/src/services/panels/claude/claudeCodeManager.ts returns 1 match AND `await this.buildSdkOptions(` count matches `this.buildSdkOptions(` count"
  - criterion: "When findNodeExecutable() rejects, composeMcpServers() logs a warning and OMITS the cyboflow entry — no command:'node' fallback ships."
    verification: "New test 'omits cyboflow entry when findNodeExecutable rejects' asserts no cyboflow key + logger.warn called"
  - criterion: "First-session race regression test asserts: setOrchSocketPath → composeMcpServers → result.cyboflow.command === '/mock/path/node' (never bare 'node')."
    verification: "Test 'eager-populates node path before first composeMcpServers call' asserts result.mcpServers.cyboflow.command"
  - criterion: "findNodeExecutable is invoked exactly once per setOrchSocketPath, regardless of session count."
    verification: "Test asserts findNodeExecutable mock was called exactly once after 3 sequential composeMcpServers calls"
  - criterion: "pnpm typecheck and pnpm lint pass."
    verification: "pnpm typecheck exits 0; pnpm lint exits 0"
depends_on: []
estimated_complexity: low
epic: cyboflow-mcp-server
test_strategy:
  needed: true
  justification: "Race-fix behavior must be locked down by a race-deterministic unit test. No existing test covers composeMcpServers — net-new file. Pattern mirrors mcpServerLifecycle.test.ts (hermetic vi.mock, no real subprocess)."
  targets:
    - behavior: "On setOrchSocketPath(), findNodeExecutable() is invoked once; subsequent composeMcpServers() awaits the stored promise and injects the resolved path"
      test_file: "main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts"
      type: unit
    - behavior: "If findNodeExecutable() rejects, composeMcpServers logs warn and omits cyboflow entry — does NOT ship command:'node'"
      test_file: "main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts"
      type: unit
    - behavior: "When orchSocketPath is never set, no cyboflow entry is injected and findNodeExecutable is not called (Crystal-legacy regression guard)"
      test_file: "main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts"
      type: unit
---

# TASK-619: Eager-populate cachedNodePath at boot to prevent first-session MCP spawn failure

## Objective

`ClaudeCodeManager.composeMcpServers()` ships `command: 'node'` in the cyboflow MCP entry for the first session because `findNodeExecutable()` is fire-and-forget. On packaged DMGs / nvm / asdf environments, bare `node` doesn't resolve and the first session spawns a broken MCP entry. Move `findNodeExecutable()` to `setOrchSocketPath()` (the deterministic boot moment), store the promise as a field, await it in `composeMcpServers()`. If rejected: warn + omit the cyboflow entry — never silently ship broken `node`. Resolves FIND-5 + FIND-15.

## Implementation Steps

1. **Refactor `claudeCodeManager.ts`**:
   - Replace `private cachedNodePath: string | null = null;` with `private cachedNodePathPromise: Promise<string> | null = null;`.
   - In `setOrchSocketPath()`, after setting `this.orchSocketPath`, add `this.cachedNodePathPromise = findNodeExecutable();` (don't await — let it run in background).
   - Change `composeMcpServers()` to `private async composeMcpServers(...): Promise<Record<string, McpServerConfig>>`.
   - Inside the `if (this.orchSocketPath)` block: remove the fire-and-forget; `try { nodeCmd = await this.cachedNodePathPromise ?? (this.cachedNodePathPromise = findNodeExecutable(), await this.cachedNodePathPromise); } catch (err) { logger.warn(...); return mcpServers; /* skip cyboflow entry */ }`.
   - Change `buildSdkOptions()` to `async`, await `composeMcpServers()`.
   - In `spawnCliProcess`, await `buildSdkOptions(options)`.

2. **Create `__tests__/claudeCodeManager.composeMcpServers.test.ts`** — hermetic with `vi.mock('../../../../utils/nodeFinder')` + `vi.mock('../../../../orchestrator/mcpServer/scriptPath')` + minimal `SessionManager` stub returning a session without `project_id`. Define `TestableClaudeCodeManager` that exposes `composeMcpServers` publicly. Four tests: eager-population, single-invocation across 3 sessions, reject→omit, never-called when orchSocketPath unset.

3. **Verify** — typecheck, lint, full test suite, the new test file all pass. Final grep sweep confirms no `?? 'node'` and no `void findNodeExecutable` remain.

## Hardest Decision

Promise field (chosen) vs async setter vs lazy-on-first-call. The promise field keeps `setOrchSocketPath` sync (boot path doesn't block), uses the deterministic boot moment, and is the cleanest single-resolution pattern.

## Lowest Confidence Area

The `composeMcpServers → buildSdkOptions → spawnCliProcess` async propagation — three lines but easy to miss an `await`. AC4 grep gate (`await this.buildSdkOptions(` count == `this.buildSdkOptions(` count) catches it statically.
