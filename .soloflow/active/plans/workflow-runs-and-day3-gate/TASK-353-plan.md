---
id: TASK-353
idea: IDEA-008
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/orchestrator/mcpConfigWriter.ts
  - main/src/orchestrator/__tests__/mcpConfigWriter.test.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
files_readonly:
  - main/src/services/mcpPermissionBridge.ts
  - main/src/services/permissionManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: "`McpConfigWriter.writeForRun({ runId, worktreePath, orchSocketPath, bridgeScriptPath })` writes a JSON file at `<worktreePath>/.mcp.json` whose `mcpServers` key contains a single entry `cyboflow-permissions`"
    verification: "Test `mcpConfigWriter.test.ts > writeForRun > writes .mcp.json at worktree root`: call with fixture paths; readFileSync the output; JSON.parse; assert `mcpServers['cyboflow-permissions']` is an object."
  - criterion: "The written `cyboflow-permissions` server entry has `command` = the resolved node executable path and `args` = [bridgeScriptPath, runId, orchSocketPath]"
    verification: "Test `writeForRun > args match bridge subprocess signature`: assert mcpServers['cyboflow-permissions'].args is exactly [bridgeScriptPath, runId, orchSocketPath] (the same argv contract Crystal's bridge uses today, per architecture research §2)."
  - criterion: "The written `cyboflow-permissions` server entry has `env` containing `CYBOFLOW_RUN_ID = <runId>` and `CYBOFLOW_ORCH_SOCKET = <orchSocketPath>`"
    verification: "Test `writeForRun > env vars present`: assert mcpServers['cyboflow-permissions'].env.CYBOFLOW_RUN_ID === runId and mcpServers['cyboflow-permissions'].env.CYBOFLOW_ORCH_SOCKET === orchSocketPath."
  - criterion: "`ClaudeCodeManager.buildCommandArgs` includes `--strict-mcp-config` in the returned args array when launching a Cyboflow workflow run (signaled by a new option `strictMcpConfig: true` on the spawn options)"
    verification: "Read main/src/services/panels/claude/claudeCodeManager.ts; grep -n \"'--strict-mcp-config'\" returns at least one match; the surrounding code branches on a new option flag `options.strictMcpConfig` defaulting to undefined for legacy Crystal callers."
  - criterion: "`RunLauncher.launch` (extended) calls `McpConfigWriter.writeForRun` after worktree creation and before any Claude spawn; the orch socket path passed is read from a constructor-injected `OrchSocketProvider` (so tests can inject a stub path)"
    verification: "Test `runLauncher.test.ts > launch > writes per-run mcp config after worktree created`: spy on McpConfigWriter.writeForRun; call launch; assert the spy was called with { runId, worktreePath, orchSocketPath: 'stub-socket-path', bridgeScriptPath: ... } AFTER worktreeManager.createDeterministicWorktree resolved."
  - criterion: "The .mcp.json filename is exactly `.mcp.json` at worktree root (not in a temp dir, not in `~/.cyboflow/`) — this is the per-run scoping mechanism"
    verification: "grep -n \"'\\.mcp\\.json'\\|\\\"\\.mcp\\.json\\\"\" main/src/orchestrator/mcpConfigWriter.ts returns at least 1 match; the path is joined against the worktreePath argument, not against os.homedir() or os.tmpdir()."
depends_on:
  - TASK-352
estimated_complexity: medium
epic: workflow-runs-and-day3-gate
test_strategy:
  needed: true
  justification: "The .mcp.json contract is what Claude reads to discover the permission bridge — any drift in keys, env vars, or argv structure silently breaks the day-3 gate (Claude would either not load the bridge or load the wrong one). Strict-mcp-config inclusion is a security invariant per ecosystem research §6. Each shape is verified directly."
  targets:
    - behavior: writeForRun writes .mcp.json at worktree root with cyboflow-permissions server entry
      test_file: main/src/orchestrator/__tests__/mcpConfigWriter.test.ts
      type: unit
    - behavior: "writeForRun args match bridge subprocess signature ([scriptPath, runId, socketPath])"
      test_file: main/src/orchestrator/__tests__/mcpConfigWriter.test.ts
      type: unit
    - behavior: writeForRun env vars CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET are populated
      test_file: main/src/orchestrator/__tests__/mcpConfigWriter.test.ts
      type: unit
    - behavior: RunLauncher.launch invokes writeForRun after worktree creation
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
---
# Per-Run .mcp.json with cyboflow-permissions Bridge + --strict-mcp-config

## Objective

Write a per-run `.mcp.json` into the worktree root before Claude is spawned. The file declares exactly one MCP server, `cyboflow-permissions`, whose `command` + `args` invoke the Cyboflow permission bridge subprocess with the run-scoped `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` env vars. Pass `--strict-mcp-config` to Claude so only this file's servers load — user-global MCP servers from `~/.claude.json` cannot interfere with the permission bridge or inject unexpected tool surfaces. This is the per-session scoping mechanism the design doc §5.6 specifies and the security posture ecosystem research recommends.

The actual `cyboflowPermissionBridge.ts` rename and `ApprovalRouter` replacement happen in epic 7 (`approval-router-and-permission-fix`). This task assumes that work has produced a bridge script path; it just composes the per-run config that references it.

## Implementation Steps

1. **Create `main/src/orchestrator/mcpConfigWriter.ts`** with the writer logic:
   ```ts
   import * as fs from 'fs/promises';
   import * as path from 'path';

   export interface McpConfigWriteOptions {
     runId: string;
     worktreePath: string;
     orchSocketPath: string;     // Unix socket path the bridge connects to
     bridgeScriptPath: string;   // resolved path to cyboflowPermissionBridge.js
     nodeExecutablePath: string; // resolved by upstream (see ClaudeCodeManager.setupMcpConfigurationSync)
   }

   export class McpConfigWriter {
     async writeForRun(opts: McpConfigWriteOptions): Promise<string> {
       const configPath = path.join(opts.worktreePath, '.mcp.json');
       const config = {
         mcpServers: {
           'cyboflow-permissions': {
             command: opts.nodeExecutablePath,
             args: [opts.bridgeScriptPath, opts.runId, opts.orchSocketPath],
             env: {
               CYBOFLOW_RUN_ID: opts.runId,
               CYBOFLOW_ORCH_SOCKET: opts.orchSocketPath,
             },
           },
         },
       };
       await fs.mkdir(opts.worktreePath, { recursive: true });
       await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
       return configPath;
     }
   }
   ```
   Notes from architecture research §2 and §6:
   - The bridge subprocess takes the socket path as `argv[3]`, not via env. The argv contract `[scriptPath, runId, socketPath]` matches Crystal's working invocation in `claudeCodeManager.ts:777`.
   - The `env` block is separately injected because epic 7's `cyboflowPermissionBridge.ts` will also read `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` from env as a forward-compat hook. Setting both argv and env is intentional belt-and-suspenders; the bridge implementation in epic 7 decides which it actually consumes.
   - No other MCP servers are merged. `--strict-mcp-config` (step 2) ensures user-global servers from `~/.claude.json` are ignored. This is a deliberate departure from Crystal's `setupMcpConfigurationSync` which merges base-project servers — that behavior is correct for Crystal sessions but unsafe for Cyboflow workflow runs.

2. **Modify `main/src/services/panels/claude/claudeCodeManager.ts`** to support a new spawn option `strictMcpConfig: boolean` (default `false` to preserve Crystal-session behavior). In `buildCommandArgs`:
   ```ts
   // Existing logic that adds --mcp-config <mcpConfigPath>
   if (mcpConfigPath) {
     args.push('--mcp-config', mcpConfigPath);
     if (options.strictMcpConfig) {
       args.push('--strict-mcp-config');
     }
     // ... existing permission-prompt-tool logic stays
   }
   ```
   Update `ClaudeSpawnOptions` interface (in the same file, near line 23) to add `strictMcpConfig?: boolean`. Cyboflow's run-launch path (epic 6 orchestrator-and-trpc-router will own the actual spawn call) will pass `strictMcpConfig: true`. For TASK-353 the orchestrator-side spawn is still stubbed; the flag plumbing is what this task delivers.

3. **Extend `main/src/orchestrator/runLauncher.ts`** (created in TASK-352) to invoke the writer:
   - Add a constructor parameter `mcpConfigWriter: McpConfigWriter`.
   - Add a constructor parameter `orchSocketProvider: { getSocketPath(): string }` so tests can inject a stub. Production wiring (epic 7) hands in the `permissionIpcServer.getSocketPath()` accessor.
   - Add a constructor parameter `bridgeScriptResolver: { getScriptPath(): string }`. Production wiring resolves to the bundled `cyboflowPermissionBridge.js` path (with ASAR extraction handled at orchestrator boot, mirroring Crystal's existing pattern in `claudeCodeManager.ts:700-730`).
   - Add a constructor parameter `nodeResolver: { getNodePath(): Promise<string> }`. Production wiring delegates to `findExecutableInPath('node')` with the same fallback ladder Crystal's `setupMcpConfigurationSync` uses.
   - After `worktreeManager.createDeterministicWorktree` resolves, call:
     ```ts
     await this.mcpConfigWriter.writeForRun({
       runId,
       worktreePath,
       orchSocketPath: this.orchSocketProvider.getSocketPath(),
       bridgeScriptPath: this.bridgeScriptResolver.getScriptPath(),
       nodeExecutablePath: await this.nodeResolver.getNodePath(),
     });
     ```

4. **Write `main/src/orchestrator/__tests__/mcpConfigWriter.test.ts`** (new file). Cover:
   - `writeForRun` writes the file at `<worktreePath>/.mcp.json` (read it back; JSON.parse; assert keys).
   - args array has exactly 3 elements in `[bridgeScriptPath, runId, orchSocketPath]` order.
   - env block has both `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET`.
   Use `os.tmpdir()` + a unique subdir for worktreePath; clean up afterEach.

5. **Extend `runLauncher.test.ts`** (from TASK-352) with a new test:
   - Inject mock `McpConfigWriter` (vi.fn for writeForRun). Call `launch()`. Assert `writeForRun` was called once, with arguments that include the `runId` and `worktreePath` returned by the (mocked) WorktreeManager. Assert the call ordering: createDeterministicWorktree resolved BEFORE writeForRun was invoked (use a sequence captured in the mocks).

6. **Do not implement the bridge subprocess itself.** That is the deliverable of epic 7's `approval-router-and-permission-fix`. This task ships only the per-run config writer and the `--strict-mcp-config` plumbing. The integration test (TASK-355) is the gate that confirms epic 7's bridge + this task's config wire up end-to-end.

## Acceptance Criteria

See frontmatter. The criteria together specify: (1-3) the .mcp.json content shape, (4) the `--strict-mcp-config` flag is included, (5) the launcher orchestrates the call, (6) the path scope is per-worktree.

## Test Strategy

See `test_strategy.targets`. The four unit tests verify the contract shape and the orchestration call site. Integration with the actual bridge subprocess is verified by TASK-355's day-3 gate test.

## Hardest Decision

Whether to write `.mcp.json` at worktree root (visible to the user, committed-by-accident risk) or under a temp path (cleaner, but breaks the Claude convention). Chose worktree root because:
- Claude Code's `--mcp-config` accepts any path, so a temp path would also work in principle.
- BUT the design doc §5.6 explicitly says "The MCP server is configured per-Claude-session via a `.mcp.json` file written into the worktree before `claude -p` is invoked."
- AND TASK-352 auto-writes `.cyboflow/worktrees/` to `.gitignore`, so the entire worktree directory (including its `.mcp.json`) is already git-ignored. There is no commit-by-accident risk.
- Following the convention also keeps the file inspectable for debugging — `cat .cyboflow/worktrees/sprint/a3f2b1c0/.mcp.json` shows exactly what Claude saw.

## Rejected Alternatives

- **Merge base-project MCP servers like Crystal does.** Rejected per ecosystem research recommendation #5: "Use `--strict-mcp-config` when spawning Claude Code for workflow runs. This prevents user-installed global MCP servers from loading inside Cyboflow-managed sessions." The day-3 gate depends on the permission bridge being the ONLY server that surfaces approval requests; a third-party MCP server that also implements an approval tool would create a heisenbug.
- **Inject CYBOFLOW_* via Electron app env instead of the MCP config's `env` block.** Rejected because the bridge subprocess is spawned by Claude Code, not by Cyboflow directly — Cyboflow's process env doesn't propagate. The MCP config's `env` block is the only injection point.
- **Embed the bridge script path at write time as an absolute path baked into a static `mcpConfig` template.** Rejected because the script path differs between dev (`__dirname/mcpPermissionBridge.js`) and packaged builds (ASAR-extracted under `~/.cyboflow/`). The resolver-injection pattern lets the production wiring handle that lookup once at orchestrator boot.

## Lowest Confidence Area

Whether the existing `mcpPermissionBridge.ts` will work unmodified when invoked with `--strict-mcp-config` enabled. The bridge subprocess itself doesn't read that flag (it's a Claude-side flag). But the bridge depends on no other MCP servers being loaded — if Crystal had been merging in a base-project MCP that also responded to permission-prompt-tool, removing those servers via strict mode could change behavior at integration time. Epic 7 owns the bridge rename / refactor; this task's `--strict-mcp-config` flag is the trigger that exposes that dependency. If TASK-355 (the gate test) fails because Claude can't find a permission tool, the fault is in epic 7's bridge wiring, not in this task's `.mcp.json` shape.
