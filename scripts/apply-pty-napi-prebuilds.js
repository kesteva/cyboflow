#!/usr/bin/env node
/**
 * apply-pty-napi-prebuilds — expose node-pty's prebuilt binary where
 * @electron/rebuild and the runtime loader can both find it.
 *
 * Why: @homebridge/node-pty-prebuilt-multiarch 0.14.1 ships and downloads
 * N-API-stable binaries (the same binary loads in Node and Electron), but
 * under names its own consumers do not look for:
 *   - @electron/rebuild accepts only `node.napi.node` inside
 *     `prebuilds/<platform>-<arch>/` (the package declares `prebuildify`, so
 *     the detector applies) — without it, electron-rebuild falls through to a
 *     node-gyp source build that fails on CI runners and compiler-less hosts.
 *   - the package's runtime loader reads `prebuilds/<...>/<runtime>.abi<ABI>.node`
 *     or falls back to `build/Release/pty.node`, and neither name is what the
 *     download leaves behind on every platform.
 *
 * This hook copies the installed binary to both names. Runs from the root
 * postinstall before `electron-builder install-app-deps`. A missing binary is
 * skipped quietly, but a binary that cannot be placed exits non-zero: leaving
 * it unplaced sends electron-rebuild down a node-gyp source build that this
 * package cannot satisfy, and the error it prints there names neither this
 * script nor the real cause.
 */
const fs = require('fs');
const path = require('path');

const STORE = process.env.PTY_NAPI_STORE_DIR || path.join(__dirname, '..', 'node_modules', '.pnpm');
const PKG_PREFIX = '@homebridge+node-pty-prebuilt-multiarch@';

function storePackageDirs() {
  try {
    return fs
      .readdirSync(STORE)
      .filter((entry) => entry.startsWith(PKG_PREFIX))
      .map((entry) =>
        path.join(STORE, entry, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'),
      )
      .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
      .sort()
      .reverse(); // newest store entry first when several are present
  } catch {
    return [];
  }
}

// The prebuilt binary, wherever this install put it: the shipped prebuild for
// this exact host ABI first, then any shipped prebuild (N-API is
// runtime-agnostic), then a build/Release artifact from prebuild-install.
function findSourceBinary(pkgDir, prebuildsDir) {
  const exact = path.join(prebuildsDir, `node.abi${process.versions.modules}.node`);
  if (fs.existsSync(exact)) return exact;
  try {
    const abiFiles = fs
      .readdirSync(prebuildsDir)
      .filter((f) => /^node\.abi\d+\.node$/.test(f))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (abiFiles.length > 0) return path.join(prebuildsDir, abiFiles[0]);
  } catch {}
  const buildRelease = path.join(pkgDir, 'build', 'Release', 'pty.node');
  return fs.existsSync(buildRelease) ? buildRelease : null;
}

let failed = false;

for (const pkgDir of storePackageDirs()) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  // The prebuildify detector only consults modules that declare the tool.
  if (!pkg.devDependencies || !pkg.devDependencies.prebuildify) continue;
  const archDir = process.arch === 'armv7l' ? 'arm' : process.arch;
  const prebuildsDir = path.join(pkgDir, 'prebuilds', `${process.platform}-${archDir}`);
  const source = findSourceBinary(pkgDir, prebuildsDir);
  if (!source) {
    console.warn('[apply-pty-napi-prebuilds] no prebuilt pty binary found — skipping');
    continue;
  }
  // arm64 prebuilds use the `armv8` filename suffix, matching
  // @electron/rebuild's prebuildify extension rule.
  const napiName = process.arch === 'arm64' ? 'node.napi.armv8.node' : 'node.napi.node';
  const napiDest = path.join(prebuildsDir, napiName);
  try {
    // Platforms the package ships no prebuild for — darwin is one — have no
    // `<platform>-<arch>` directory at all, so create the leaf, not its parent.
    fs.mkdirSync(prebuildsDir, { recursive: true });
    fs.copyFileSync(source, napiDest);
    // The runtime loader's POSIX fallback: build/Release/pty.node.
    const buildRelease = path.join(pkgDir, 'build', 'Release', 'pty.node');
    if (path.resolve(source) !== path.resolve(buildRelease) && !fs.existsSync(buildRelease)) {
      fs.mkdirSync(path.dirname(buildRelease), { recursive: true });
      fs.copyFileSync(source, buildRelease);
    }
  } catch (error) {
    console.error(
      `[apply-pty-napi-prebuilds] could not write ${napiDest}:`,
      error && error.message,
    );
    failed = true;
    continue;
  }
  console.log(`[apply-pty-napi-prebuilds] exposed ${path.relative(pkgDir, napiDest)}`);
}

process.exit(failed ? 1 : 0);
