/**
 * bundle-mcp-server — make cyboflowMcpServer.js self-contained.
 *
 * The MCP server is spawned as a STANDALONE node subprocess (by McpServerLifecycle
 * and via the per-run .mcp.json the SDK/CLI reads). In a packaged app its only
 * external dependency, `@modelcontextprotocol/sdk`, lives inside `app.asar`, which
 * stock node cannot read — so the subprocess dies with MODULE_NOT_FOUND and every
 * MCP connection fails. (It only works in dev because the repo's node_modules is on
 * disk.) Bundling inlines the SDK so the subprocess needs no node_modules at all and
 * runs from any location, asar or not. The server has no relative imports and no
 * native deps (only `net` + the SDK), so a single self-contained file is sufficient.
 *
 * Runs after `tsc` in build:main; rewrites the compiled file in place (via a temp
 * file to avoid esbuild's overwrite-input guard).
 */
import { build } from 'esbuild';
import { renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'main', 'dist', 'main', 'src', 'orchestrator', 'mcpServer');
const entry = join(dir, 'cyboflowMcpServer.js');
const tmp = join(dir, 'cyboflowMcpServer.bundle.js');

await build({
  entryPoints: [entry],
  outfile: tmp,
  bundle: true,
  platform: 'node', // node builtins (net, …) stay external
  format: 'cjs',
  target: 'node18',
  logLevel: 'warning',
});

renameSync(tmp, entry);
console.log('[bundle-mcp-server] cyboflowMcpServer.js bundled self-contained (no external node_modules).');
