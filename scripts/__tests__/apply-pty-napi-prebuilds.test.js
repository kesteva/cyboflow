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

/**
 * A throwaway pnpm store holding one node-pty package dir. `prebuildify`
 * controls whether the package declares the tool @electron/rebuild detects on;
 * `buildRelease` puts a binary where the package's own install script leaves
 * one, which is all a macOS install has.
 */
function makeStore({ prebuildify = true, buildRelease = true } = {}) {
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

  return {
    root,
    store,
    pkgDir,
    prebuildsDir: path.join(pkgDir, 'prebuilds', ARCH_DIR),
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
