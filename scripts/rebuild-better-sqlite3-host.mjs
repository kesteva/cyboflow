/**
 * rebuild-better-sqlite3-host — rebuild better-sqlite3 against the host Node
 * ABI, then PROVE it loads before the unit suite depends on it.
 *
 * The root `postinstall` (electron-builder install-app-deps) rebuilds
 * better-sqlite3 against the Electron ABI; the unit suite runs under host
 * Node (vitest), so CI must flip it back. A bare `pnpm rebuild better-sqlite3`
 * can silently no-op or leave a stale wrong-arch `.node` behind (observed live:
 * a leftover x86_64 build/Release/better_sqlite3.node survived x86_64 packaging
 * and dlopen-failed with ERR_DLOPEN_FAILED until a source rebuild was forced) —
 * the DB-touching tests would then fail confusingly, far from the real cause.
 * This script rebuilds AND asserts a real `:memory:` database opens, retrying
 * once with a forced source build before giving up loudly.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function log(message) {
  console.log(`[rebuild-better-sqlite3-host] ${message}`);
}

function runRebuild(extraEnv) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const envNote = extraEnv
    ? ` (${Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`).join(' ')})`
    : '';
  log(`running: pnpm rebuild better-sqlite3${envNote}`);
  const result = spawnSync('pnpm', ['rebuild', 'better-sqlite3'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  });
  return result.status === 0;
}

// Runs the load-and-exec assertion in a FRESH child process rather than
// `require`-ing in-process — a native addon loaded once by this process would
// stay resident (Node caches the require by resolved path) even after a
// subsequent rebuild replaces the .node file on disk, masking exactly the
// stale-binary failure this script exists to catch.
function assertBetterSqlite3Loads() {
  const probe = `
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE probe (id INTEGER)');
    db.exec('DROP TABLE probe');
    db.close();
    process.stdout.write(JSON.stringify({
      nodeModuleVersion: process.versions.modules,
      arch: process.arch,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { ok: false, detail: result.stderr || result.error?.message || 'unknown failure' };
  }
  try {
    const info = JSON.parse(result.stdout.trim());
    return { ok: true, info };
  } catch {
    return { ok: false, detail: `could not parse probe output: ${result.stdout}\n${result.stderr}` };
  }
}

if (!runRebuild()) {
  console.error('[rebuild-better-sqlite3-host] pnpm rebuild better-sqlite3 failed.');
  process.exit(1);
}

let assertion = assertBetterSqlite3Loads();

if (!assertion.ok) {
  log('smoke check failed after the plain rebuild (likely a stale wrong-arch prebuild). Retrying once with a forced source build...');
  console.error(assertion.detail);

  if (!runRebuild({ npm_config_build_from_source: 'true' })) {
    console.error('[rebuild-better-sqlite3-host] forced source rebuild (npm_config_build_from_source=true) failed.');
    process.exit(1);
  }

  assertion = assertBetterSqlite3Loads();
}

if (!assertion.ok) {
  console.error('[rebuild-better-sqlite3-host] better-sqlite3 still fails to load a :memory: database after a forced source rebuild:');
  console.error(assertion.detail);
  process.exit(1);
}

log(`OK — better-sqlite3 loaded (NODE_MODULE_VERSION=${assertion.info.nodeModuleVersion}, arch=${assertion.info.arch})`);
