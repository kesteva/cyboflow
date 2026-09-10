/**
 * bundle-verify-driver — make the visual-verification driver CLI self-contained.
 *
 * `$VERIFY_DRIVER` runs `driverCli.js` as a STANDALONE node subprocess (the wrapper
 * VerificationAgentRunner writes execs the resolved node on it). In a packaged app
 * the driver directory is in `asarUnpack`, but the sibling modules it requires —
 * `utils/platformProcess`, `utils/shellDetector`, `utils/win32CmdLine`,
 * `services/processTable`, … — live inside `app.asar`, which stock node cannot
 * read, so the subprocess died with MODULE_NOT_FOUND on the first require and
 * every packaged verification failed before it reached the app (it only ever
 * worked in dev, where `main/dist` is on disk). Bundling inlines those siblings so
 * the file needs nothing beside it — the same fix `bundle-mcp-server.mjs` applies to
 * the MCP server, and self-guarding: an import esbuild cannot resolve fails the
 * BUILD, instead of the packaged driver.
 *
 * `playwright` stays EXTERNAL on purpose: the driver loads it lazily from
 * cyboflow's own install (`node_modules/playwright*` is in `asarUnpack`, and the
 * wrapper binds NODE_PATH to that root — see harnessEnv.resolveHarnessNodePath),
 * so the target project never needs a playwright install and a missing one
 * soft-fails at call time rather than at boot (driverCore's lazy-import contract).
 *
 * Runs after `tsc` in build:main; rewrites the compiled file in place (via a temp
 * file to avoid esbuild's overwrite-input guard). `driverCore.js` is left as-is
 * for the unit tests that import it.
 */
import { build } from 'esbuild';
import { renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'main', 'dist', 'main', 'src', 'orchestrator', 'verify', 'driver');
const entry = join(dir, 'driverCli.js');
const tmp = join(dir, 'driverCli.bundle.js');

await build({
  entryPoints: [entry],
  outfile: tmp,
  bundle: true,
  platform: 'node', // node builtins stay external
  format: 'cjs',
  target: 'node18',
  external: ['playwright'],
  logLevel: 'warning',
});
renameSync(tmp, entry);
console.log('[bundle-verify-driver] driverCli.js bundled self-contained (playwright external).');
