/**
 * ELECTRON_RUN_AS_NODE fork-bomb guard.
 *
 * findNodeExecutable() (see ./nodeFinder) falls back to `process.execPath` for a
 * packaged app that has no standalone `node` on the GUI process's PATH. That path
 * is the Cyboflow app binary, NOT a node binary — spawning it plainly boots a
 * whole NEW Cyboflow app instance instead of running the target script. Each new
 * instance repeats the fallback, spawning yet another app: an unkillable,
 * exponential loop of app windows. ELECTRON_RUN_AS_NODE=1 makes Electron run the
 * script as Node instead of launching the app. A real node binary ignores the
 * flag, so it is always safe to include.
 *
 * Every site that spawns a bridge/MCP subprocess via a resolved node path MUST
 * fold this into the child env. Return value is a spreadable env fragment so the
 * flag is only present when the guard actually applies (keeps test fixtures /
 * on-disk .mcp.json byte-identical when a real node is resolved).
 */
export function electronRunAsNodeGuardEnv(
  nodeExecutablePath: string,
): Record<string, string> {
  return nodeExecutablePath === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}
