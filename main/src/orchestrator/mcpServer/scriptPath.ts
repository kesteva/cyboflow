/**
 * scriptPath — shared helper for resolving the cyboflowMcpServer.js subprocess
 * script path.
 *
 * Used by both McpServerLifecycle (singleton spawn) and claudeCodeManager
 * (per-session .mcp.json injection) so both callers see the same script.
 *
 * Resolution strategy:
 * - Packaged build: returns process.resourcesPath + app.asar.unpacked relative
 *   path.  The script is listed in package.json `build.asarUnpack` so it is
 *   placed outside the ASAR archive by electron-builder and is directly
 *   executable by Node without any extraction step.
 * - Dev mode: returns the sibling .js file compiled by `pnpm run build:main`
 *   into main/dist/main/src/orchestrator/mcpServer/ (__dirname at runtime).
 *
 * The result is memoized at module level.  Pass `dirOverride` to bypass the
 * cache — this is used by tests to drive both branches without module reload.
 *
 * Standalone-typecheck invariant: this file imports from 'electron' only
 * for app.isPackaged which is mocked in the Vitest setup.
 */
import * as path from 'path';
import { app } from 'electron';

/** Name of the MCP server script. */
const SCRIPT_FILENAME = 'cyboflowMcpServer.js';

/**
 * Relative path from process.resourcesPath to the unpacked script.
 * Mirrors the `build.asarUnpack` entry in package.json.
 */
const ASAR_UNPACKED_REL =
  'app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js';

/** Module-level cache so the resolution runs at most once per process. */
let cachedResolvedPath: string | null = null;

/**
 * Resolve the absolute path to the cyboflowMcpServer.js script.
 *
 * @param dirOverride  Optional absolute directory to look in instead of
 *                     __dirname.  When supplied the module-level cache is
 *                     bypassed so tests can exercise each branch independently.
 */
export function resolveMcpServerScriptPath(dirOverride?: string): string {
  // Bypass the cache when a dirOverride is provided (test-only path).
  if (dirOverride !== undefined) {
    return computeResolvedPath(dirOverride);
  }

  if (cachedResolvedPath === null) {
    cachedResolvedPath = computeResolvedPath(undefined);
  }
  return cachedResolvedPath;
}

function computeResolvedPath(dirOverride: string | undefined): string {
  if (app.isPackaged) {
    // Packaged build — the script is asar-unpacked and directly accessible.
    return path.join(process.resourcesPath, ASAR_UNPACKED_REL);
  }

  // Dev mode — the script is compiled alongside this file by tsc.
  const searchDir = dirOverride ?? __dirname;
  return path.join(searchDir, SCRIPT_FILENAME);
}

/**
 * Reset the module-level path cache.
 *
 * Exported for unit tests only — do NOT call from production code.
 */
export function __resetCacheForTests(): void {
  cachedResolvedPath = null;
}
