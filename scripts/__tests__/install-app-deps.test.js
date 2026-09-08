#!/usr/bin/env node
/**
 * Tests for scripts/install-app-deps.js.
 *
 * Plain Node built-in test runner (node:test + node:assert), matching the
 * other scripts/__tests__ suites. Runs in the `test:unit` chain.
 *
 * Run: node scripts/__tests__/install-app-deps.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { shouldRunElectronRebuild } = require(path.resolve(__dirname, '../install-app-deps.js'));

test('runs the Electron rebuild on every non-Windows platform', () => {
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    assert.equal(shouldRunElectronRebuild(platform, {}), true, platform);
    assert.equal(shouldRunElectronRebuild(platform, { CYBOFLOW_WIN_NPM_REBUILD: '0' }), true, platform);
  }
});

test('skips the Electron rebuild on Windows by default', () => {
  assert.equal(shouldRunElectronRebuild('win32', {}), false);
  assert.equal(shouldRunElectronRebuild('win32', { CYBOFLOW_WIN_NPM_REBUILD: '0' }), false);
  assert.equal(shouldRunElectronRebuild('win32', { CYBOFLOW_WIN_NPM_REBUILD: 'true' }), false);
});

test('CYBOFLOW_WIN_NPM_REBUILD=1 restores the rebuild on Windows (same switch as configure-build.js)', () => {
  assert.equal(shouldRunElectronRebuild('win32', { CYBOFLOW_WIN_NPM_REBUILD: '1' }), true);
});
