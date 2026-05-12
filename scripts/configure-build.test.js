#!/usr/bin/env node

/**
 * Smoke test for scripts/configure-build.js.
 *
 * Exercises two branches of configureBuild():
 *   Case A: CSC_DISABLE=true  → unsigned posture (hardenedRuntime false, notarize false, no entitlements)
 *   Case B: All Apple env vars set → signed posture (hardenedRuntime true, notarize truthy, entitlements set)
 *
 * package.json is snapshotted to a .bak file and restored in a try/finally block so the
 * working tree is left clean regardless of test outcome.
 *
 * Run: node scripts/configure-build.test.js
 * Exit 0 on success, non-zero on failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');
const PACKAGE_BAK = PACKAGE_JSON + '.bak';

function readMacConfig() {
  const raw = fs.readFileSync(PACKAGE_JSON, 'utf8');
  return JSON.parse(raw).build.mac;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error('ASSERTION FAILED: ' + message);
  }
}

function runCase(label, envOverrides, assertFn) {
  console.log('\n--- ' + label + ' ---');

  // Snapshot
  fs.copyFileSync(PACKAGE_JSON, PACKAGE_BAK);

  // Isolate env mutations
  const savedEnv = {};

  // Clear all signing-related env vars first so cases are isolated
  const signingKeys = [
    'CSC_DISABLE',
    'CSC_LINK',
    'APPLE_CERTIFICATE',
    'APPLE_ID',
    'APPLE_TEAM_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_APP_PASSWORD',
  ];

  for (const key of signingKeys) {
    if (key in process.env) {
      savedEnv[key] = process.env[key];
    }
    delete process.env[key];
  }

  // Apply overrides for this case
  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }

  try {
    // Invalidate require cache so configure-build.js re-reads package.json fresh
    const cbPath = require.resolve('./configure-build.js');
    delete require.cache[cbPath];
    const { configureBuild } = require('./configure-build.js');
    configureBuild();

    const mac = readMacConfig();
    assertFn(mac);
    console.log('PASS: ' + label);
  } finally {
    // Restore package.json
    fs.copyFileSync(PACKAGE_BAK, PACKAGE_JSON);
    fs.unlinkSync(PACKAGE_BAK);

    // Restore env
    for (const key of signingKeys) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      process.env[key] = value;
    }
  }
}

let failed = false;

try {
  // Case A: CSC_DISABLE=true → unsigned posture
  runCase(
    'Case A: CSC_DISABLE=true (unsigned posture)',
    { CSC_DISABLE: 'true' },
    function (mac) {
      assert(mac.hardenedRuntime === false, 'hardenedRuntime should be false when signing disabled');
      assert(mac.notarize === false, 'notarize should be false when signing disabled');
      assert(mac.entitlements === undefined, 'entitlements should be removed when signing disabled');
      assert(mac.entitlementsInherit === undefined, 'entitlementsInherit should be removed when signing disabled');
    }
  );
} catch (err) {
  console.error('FAIL: Case A — ' + err.message);
  failed = true;
}

try {
  // Case B: All Apple credentials set → signed posture
  runCase(
    'Case B: All Apple env vars set (signed posture)',
    {
      CSC_LINK: 'fake-cert-data-for-test',
      APPLE_ID: 'test@example.com',
      APPLE_TEAM_ID: 'TESTTEAMID1',
      APPLE_APP_SPECIFIC_PASSWORD: 'test-app-specific-password',
    },
    function (mac) {
      assert(mac.hardenedRuntime === true, 'hardenedRuntime should be true when signing enabled');
      assert(!!mac.notarize, 'notarize should be truthy when all credentials are present');
      assert(
        mac.entitlements === 'build/entitlements.mac.plist',
        'entitlements should be set to build/entitlements.mac.plist'
      );
      assert(
        mac.entitlementsInherit === 'build/entitlements.mac.plist',
        'entitlementsInherit should be set to build/entitlements.mac.plist'
      );
    }
  );
} catch (err) {
  console.error('FAIL: Case B — ' + err.message);
  failed = true;
}

if (failed) {
  console.error('\nOne or more test cases failed.');
  process.exit(1);
} else {
  console.log('\nAll test cases passed.');
  process.exit(0);
}
