/**
 * Unit tests for McpConfigWriter.
 *
 * Behaviors covered (per TASK-353 test_strategy):
 * 1. writeForRun writes .mcp.json at worktree root with cyboflow-permissions entry
 * 2. args array matches the bridge subprocess signature [bridgeScriptPath, runId, orchSocketPath]
 * 3. env vars CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET are both present and correct
 *
 * Tests use withTempDir for filesystem isolation (auto-cleanup on exit).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { McpConfigWriter } from '../mcpConfigWriter';
import { withTempDir } from '../../__test_fixtures__/tmp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface McpConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  >;
}

function readMcpJson(worktreePath: string): McpConfig {
  const raw = readFileSync(join(worktreePath, '.mcp.json'), 'utf-8');
  return JSON.parse(raw) as McpConfig;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_RUN_ID = 'run-abc123';
const FIXTURE_ORCH_SOCKET = '/tmp/cyboflow-orch.sock';
const FIXTURE_BRIDGE_SCRIPT = '/app/dist/services/cyboflowPermissionBridge.js';
const FIXTURE_NODE_PATH = '/usr/local/bin/node';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpConfigWriter.writeForRun', () => {
  it('writes .mcp.json at worktree root', async () => {
    await withTempDir('mcpconfig-test-', async (worktreePath) => {
      const writer = new McpConfigWriter();
      const configPath = await writer.writeForRun({
        runId: FIXTURE_RUN_ID,
        worktreePath,
        orchSocketPath: FIXTURE_ORCH_SOCKET,
        bridgeScriptPath: FIXTURE_BRIDGE_SCRIPT,
        nodeExecutablePath: FIXTURE_NODE_PATH,
      });

      expect(configPath).toBe(join(worktreePath, '.mcp.json'));

      const config = readMcpJson(worktreePath);
      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers['cyboflow-permissions']).toBeDefined();
      expect(typeof config.mcpServers['cyboflow-permissions']).toBe('object');
    });
  });

  it('args match bridge subprocess signature [bridgeScriptPath, runId, orchSocketPath]', async () => {
    await withTempDir('mcpconfig-test-', async (worktreePath) => {
      const writer = new McpConfigWriter();
      await writer.writeForRun({
        runId: FIXTURE_RUN_ID,
        worktreePath,
        orchSocketPath: FIXTURE_ORCH_SOCKET,
        bridgeScriptPath: FIXTURE_BRIDGE_SCRIPT,
        nodeExecutablePath: FIXTURE_NODE_PATH,
      });

      const config = readMcpJson(worktreePath);
      const server = config.mcpServers['cyboflow-permissions'];

      // command must be the node executable
      expect(server.command).toBe(FIXTURE_NODE_PATH);

      // args must be exactly 3 elements in the documented argv order
      expect(server.args).toHaveLength(3);
      expect(server.args[0]).toBe(FIXTURE_BRIDGE_SCRIPT);
      expect(server.args[1]).toBe(FIXTURE_RUN_ID);
      expect(server.args[2]).toBe(FIXTURE_ORCH_SOCKET);
    });
  });

  it('env vars CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET are present and correct', async () => {
    await withTempDir('mcpconfig-test-', async (worktreePath) => {
      const writer = new McpConfigWriter();
      await writer.writeForRun({
        runId: FIXTURE_RUN_ID,
        worktreePath,
        orchSocketPath: FIXTURE_ORCH_SOCKET,
        bridgeScriptPath: FIXTURE_BRIDGE_SCRIPT,
        nodeExecutablePath: FIXTURE_NODE_PATH,
      });

      const config = readMcpJson(worktreePath);
      const env = config.mcpServers['cyboflow-permissions'].env;

      expect(env.CYBOFLOW_RUN_ID).toBe(FIXTURE_RUN_ID);
      expect(env.CYBOFLOW_ORCH_SOCKET).toBe(FIXTURE_ORCH_SOCKET);
    });
  });

  it('creates the worktree directory if it does not yet exist', async () => {
    await withTempDir('mcpconfig-test-', async (base) => {
      // Use a path inside the temp dir that has not been created
      const worktreePath = join(base, 'nested', 'worktree');

      const writer = new McpConfigWriter();
      await writer.writeForRun({
        runId: FIXTURE_RUN_ID,
        worktreePath,
        orchSocketPath: FIXTURE_ORCH_SOCKET,
        bridgeScriptPath: FIXTURE_BRIDGE_SCRIPT,
        nodeExecutablePath: FIXTURE_NODE_PATH,
      });

      const config = readMcpJson(worktreePath);
      expect(config.mcpServers['cyboflow-permissions']).toBeDefined();
    });
  });

  it('written JSON is valid and pretty-printed (not minified)', async () => {
    await withTempDir('mcpconfig-test-', async (worktreePath) => {
      const writer = new McpConfigWriter();
      await writer.writeForRun({
        runId: FIXTURE_RUN_ID,
        worktreePath,
        orchSocketPath: FIXTURE_ORCH_SOCKET,
        bridgeScriptPath: FIXTURE_BRIDGE_SCRIPT,
        nodeExecutablePath: FIXTURE_NODE_PATH,
      });

      const raw = readFileSync(join(worktreePath, '.mcp.json'), 'utf-8');
      // Pretty-printed JSON has newlines
      expect(raw).toContain('\n');
      // Round-trips cleanly
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });
});
