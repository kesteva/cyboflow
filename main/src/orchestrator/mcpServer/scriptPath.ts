/**
 * scriptPath — shared helper for resolving and extracting the
 * cyboflowMcpServer.js subprocess script.
 *
 * Used by both McpServerLifecycle (singleton spawn) and claudeCodeManager
 * (per-session .mcp.json injection) so both callers see the same script.
 *
 * Asar-extraction pattern lifted from the original claudeCodeManager
 * approach: if the candidate script path is inside an .asar archive
 * (packaged DMG), the script is extracted to ~/.cyboflow/ on first use
 * and subsequent calls return the extracted path.
 *
 * Standalone-typecheck invariant: this file imports from 'electron' only
 * for app.isPackaged which is mocked in the Vitest setup.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getCyboflowSubdirectory } from '../../utils/cyboflowDirectory';

/** Name of the MCP server script once extracted to the cyboflow directory. */
const SCRIPT_FILENAME = 'cyboflowMcpServer.js';

/**
 * Resolve the absolute path to the cyboflowMcpServer.js script.
 *
 * - Dev mode: returns the sibling .js file compiled by `pnpm run build:main`
 *   into main/dist/main/src/orchestrator/mcpServer/.
 * - Packaged DMG (asar): reads the script out of the .asar virtual FS via
 *   fs.readFileSync (which Electron patches to support .asar paths) and writes
 *   it to ~/.cyboflow/cyboflowMcpServer.js before returning that path.
 *
 * The extraction is idempotent — if the extracted file already exists it is
 * overwritten so updates delivered via a new DMG are picked up on next start.
 *
 * @param dirOverride  Optional absolute directory to look in instead of
 *                     __dirname.  Useful for tests that cannot set __dirname.
 */
export function resolveMcpServerScriptPath(dirOverride?: string): string {
  const searchDir = dirOverride ?? __dirname;
  const candidatePath = path.join(searchDir, SCRIPT_FILENAME);

  if (app.isPackaged && candidatePath.includes('.asar')) {
    // Packaged path — script is inside the .asar archive.  Extract it so Node
    // can require/spawn it directly (spawning from inside .asar is unsupported).
    const scriptContent = fs.readFileSync(candidatePath, 'utf8');
    const extractedPath = getCyboflowSubdirectory(SCRIPT_FILENAME);

    // Ensure the target directory exists.
    const targetDir = path.dirname(extractedPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(extractedPath, scriptContent, 'utf8');
    fs.chmodSync(extractedPath, 0o755);

    return extractedPath;
  }

  // Dev path — return as-is (the file is built into main/dist/ and is
  // directly executable by Node without extraction).
  return candidatePath;
}
