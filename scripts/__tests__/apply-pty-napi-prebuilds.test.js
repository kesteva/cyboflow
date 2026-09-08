#!/usr/bin/env node
/**
 * Tests for scripts/apply-pty-napi-prebuilds.js.
 *
 * Plain Node built-in test runner (node:test + node:assert), matching the
 * other scripts/__tests__ suites. Runs in the `test:unit` chain.
 *
 * Run: node scripts/__tests__/apply-pty-napi-prebuilds.test.js
 *
 * The hook runs against a fixture pnpm store via PTY_NAPI_STORE_DIR, so no
 * real install is touched. The case that matters most is a store with NO
 * `prebuilds/<platform>-<arch>` directory: @homebridge/node-pty-prebuilt-
 * multiarch ships prebuilds for linux and win32 only, so that is the shape
 * every macOS install has, and the hook has to create the directory itself.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/apply-pty-napi-prebuilds.js');

const PKG_REL = path.join(
  '@homebridge+node-pty-prebuilt-multiarch@0.14.1',
  'node_modules',
  '@homebridge',
  'node-pty-prebuilt-multiarch',
);
const ARCH_DIR = `${process.platform}-${process.arch === 'armv7l' ? 'arm' : process.arch}`;
const SOURCE_BYTES = 'pty-binary-bytes';
const HOST_HELPER_BYTES = 'host-spawn-helper-bytes';
const CROSS_BYTES = 'cross-arch-pty-bytes';
const CROSS_HELPER_BYTES = 'cross-arch-spawn-helper-bytes';
/** The darwin arch this host is NOT — the one a cross-arch build targets. */
const OTHER_ARCH = process.arch === 'arm64' ? 'x64' : 'arm64';
const IS_DARWIN = process.platform === 'darwin';

/**
 * A throwaway pnpm store holding one node-pty package dir. `prebuildify`
 * controls whether the package declares the tool @electron/rebuild detects on;
 * `buildRelease` puts a binary where the package's own install script leaves
 * one, which is all a macOS install has.
 */
function makeStore({
  prebuildify = true,
  buildRelease = true,
  spawnHelper = false,
  fetcher = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-napi-'));
  const store = path.join(root, '.pnpm');
  const pkgDir = path.join(store, PKG_REL);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@homebridge/node-pty-prebuilt-multiarch',
      version: '0.14.1',
      devDependencies: prebuildify ? { prebuildify: '^6.0.1' } : {},
    }),
  );
  if (buildRelease) {
    fs.mkdirSync(path.join(pkgDir, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'build', 'Release', 'pty.node'), SOURCE_BYTES);
  }

  if (spawnHelper) {
    fs.mkdirSync(path.join(pkgDir, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'build', 'Release', 'spawn-helper'), HOST_HELPER_BYTES);
  }
  // Stand in for the real `prebuild-install`, which would download the other
  // arch's tarball. `succeed` reproduces what it leaves in its CWD; `fail`
  // reproduces an offline install.
  if (fetcher) {
    const binDir = path.join(pkgDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'prebuild-install');
    fs.writeFileSync(
      binPath,
      fetcher === 'succeed'
        ? '#!/bin/sh\nmkdir -p build/Release\n' +
            `printf '%s' '${CROSS_BYTES}' > build/Release/pty.node\n` +
            `printf '%s' '${CROSS_HELPER_BYTES}' > build/Release/spawn-helper\n`
        : '#!/bin/sh\nexit 1\n',
    );
    fs.chmodSync(binPath, 0o755);
  }

  return {
    root,
    store,
    pkgDir,
    prebuildsDir: path.join(pkgDir, 'prebuilds', ARCH_DIR),
    crossPrebuildsDir: path.join(pkgDir, 'prebuilds', `darwin-${OTHER_ARCH}`),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function run(fixture) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PTY_NAPI_STORE_DIR: fixture.store },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** The alias files the hook placed for this host, if the directory exists. */
function aliasFiles(fixture) {
  if (!fs.existsSync(fixture.prebuildsDir)) return [];
  return fs.readdirSync(fixture.prebuildsDir).sort();
}

test('a store with no prebuilds/<platform>-<arch> gets the directory and the alias', () => {
  const fixture = makeStore();
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);

    const files = aliasFiles(fixture);
    assert.equal(files.length, 1, `expected one alias, got ${JSON.stringify(files)}`);
    assert.match(files[0], /^node\.napi(\.armv8)?\.node$/);
    assert.equal(fs.readFileSync(path.join(fixture.prebuildsDir, files[0]), 'utf8'), SOURCE_BYTES);
  } finally {
    fixture.cleanup();
  }
});

test('a binary that cannot be placed exits non-zero instead of being swallowed', () => {
  const fixture = makeStore();
  try {
    // A file where the `prebuilds` directory belongs: mkdir fails with ENOTDIR.
    fs.writeFileSync(path.join(fixture.pkgDir, 'prebuilds'), 'not a directory');

    const result = run(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not write/);
  } finally {
    fixture.cleanup();
  }
});

test('a package that does not declare prebuildify is left alone', () => {
  const fixture = makeStore({ prebuildify: false });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(fixture.pkgDir, 'prebuilds')), false);
  } finally {
    fixture.cleanup();
  }
});

test('a store with no binary at all is skipped, not failed', () => {
  const fixture = makeStore({ buildRelease: false });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /no prebuilt pty binary found/);
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Cross-arch placement. Both macOS arches are release targets, but only the
// HOST arch's binary is on disk after an install, and the package ships no
// darwin prebuild directory. A build for the other arch therefore found nothing
// and fell through to a node-gyp source build; the arch that DID get placed
// then had to be the target's, because node-pty's darwin loader always lands on
// build/Release. These lock both halves down without touching the network.
// ---------------------------------------------------------------------------

test('the non-host darwin arch gets the addon and its spawn-helper', { skip: !IS_DARWIN }, () => {
  const fixture = makeStore({ spawnHelper: true, fetcher: 'succeed' });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);

    const expectedAlias = OTHER_ARCH === 'arm64' ? 'node.napi.armv8.node' : 'node.napi.node';
    const placed = fs.readdirSync(fixture.crossPrebuildsDir).sort();
    assert.deepEqual(placed, ['spawn-helper', expectedAlias].sort());

    // The other arch's payload, not a copy of the host's.
    assert.equal(
      fs.readFileSync(path.join(fixture.crossPrebuildsDir, expectedAlias), 'utf8'),
      CROSS_BYTES,
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.crossPrebuildsDir, 'spawn-helper'), 'utf8'),
      CROSS_HELPER_BYTES,
    );
  } finally {
    fixture.cleanup();
  }
});

test('build/Release keeps the HOST arch so the dev runtime still loads', { skip: !IS_DARWIN }, () => {
  const fixture = makeStore({ spawnHelper: true, fetcher: 'succeed' });
  try {
    assert.equal(run(fixture).status, 0);

    const release = path.join(fixture.pkgDir, 'build', 'Release');
    assert.equal(fs.readFileSync(path.join(release, 'pty.node'), 'utf8'), SOURCE_BYTES);
    assert.equal(fs.readFileSync(path.join(release, 'spawn-helper'), 'utf8'), HOST_HELPER_BYTES);
  } finally {
    fixture.cleanup();
  }
});

test('the host arch mirrors its spawn-helper beside the addon', { skip: !IS_DARWIN }, () => {
  const fixture = makeStore({ spawnHelper: true, fetcher: 'succeed' });
  try {
    assert.equal(run(fixture).status, 0);
    assert.equal(
      fs.readFileSync(path.join(fixture.prebuildsDir, 'spawn-helper'), 'utf8'),
      HOST_HELPER_BYTES,
    );
  } finally {
    fixture.cleanup();
  }
});

test('a failed cross-arch fetch warns but does not fail the install', { skip: !IS_DARWIN }, () => {
  const fixture = makeStore({ spawnHelper: true, fetcher: 'fail' });
  try {
    const result = run(fixture);
    // postinstall runs on every install; a network hiccup must not be fatal.
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /could not fetch the non-host darwin prebuild/);
    assert.equal(fs.existsSync(fixture.crossPrebuildsDir), false);
    // The host arch is still placed — the cross failure is not contagious.
    assert.ok(aliasFiles(fixture).some((f) => /^node\.napi(\.armv8)?\.node$/.test(f)));
  } finally {
    fixture.cleanup();
  }
});
