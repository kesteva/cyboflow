#!/usr/bin/env node
/**
 * install-app-deps — the root postinstall's Electron-ABI rebuild step, with the
 * one platform exception the packaging plan already makes.
 *
 * On macOS and Linux this is exactly `electron-builder install-app-deps`
 * (@electron/rebuild over main/'s native deps). On Windows it is skipped:
 *
 *   - Both native modules ship N-API prebuilds that load under Electron
 *     unchanged (better-sqlite3 >= 13 bundles prebuilds/win32-<arch>.node in
 *     its tarball; node-pty's install downloads its own), so there is nothing
 *     for a rebuild to produce.
 *   - electron-builder 26's bundled @electron/rebuild 3.7 still drives
 *     better-sqlite3 through node-gyp, whose *configure* step must find a
 *     Visual Studio it recognises before binding.gyp ever gets to skip the
 *     compile. That fails on any Windows host without VS 2017–2022 C++ tools
 *     — including GitHub's windows-latest image, which ships VS 2026 — and
 *     took every `pnpm install` down with it.
 *   - The Windows packaging plan (scripts/configure-build.js) already sets
 *     npmRebuild=false for the same reason; the install step now agrees
 *     with it.
 *
 * CYBOFLOW_WIN_NPM_REBUILD=1 — the same escape hatch configure-build.js
 * honours — restores the rebuild on a Windows host that has a toolchain.
 *
 * Exported for tests: shouldRunElectronRebuild(platform, env).
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function shouldRunElectronRebuild(platform, env) {
  if (platform !== 'win32') return true;
  return env.CYBOFLOW_WIN_NPM_REBUILD === '1';
}

function main() {
  if (!shouldRunElectronRebuild(process.platform, process.env)) {
    console.log(
      '[install-app-deps] win32: skipping electron-builder install-app-deps — both native ' +
        'modules ship N-API prebuilds and the Windows packaging plan runs with npmRebuild=false ' +
        '(set CYBOFLOW_WIN_NPM_REBUILD=1 to rebuild anyway).',
    );
    return 0;
  }
  // electron-builder's `install-app-deps.js` bin entry is inert when run as a
  // plain script (its main() is guarded on require.main inside the module it
  // requires), so go through the main CLI with the subcommand — exactly what
  // the previous `electron-builder install-app-deps` postinstall did.
  const cli = require.resolve('electron-builder/cli.js', {
    paths: [path.resolve(__dirname, '..')],
  });
  const result = spawnSync(process.execPath, [cli, 'install-app-deps'], { stdio: 'inherit' });
  if (result.error) {
    console.error('[install-app-deps] could not run electron-builder install-app-deps:', result.error.message);
    return 1;
  }
  return result.status == null ? 1 : result.status;
}

module.exports = { shouldRunElectronRebuild };

if (require.main === module) {
  process.exit(main());
}
