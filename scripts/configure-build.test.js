#!/usr/bin/env node

/**
 * Smoke test for scripts/configure-build.js.
 *
 * Exercises configureBuild(), which reads package.json's `build` field (never mutating it)
 * and writes an environment-adjusted copy to build/electron-builder.generated.json.
 *
 *   Case A: CSC_DISABLE=true       → unsigned posture (hardenedRuntime false, notarize false, no entitlements)
 *   Case B: All Apple env vars set → signed posture (hardenedRuntime true, notarize truthy, entitlements set)
 *   Case C: BUILD_VARIANT=beta     → beta appId / productName / artifactName / publish URL overrides
 *
 * Every case also asserts that package.json on disk is byte-for-byte UNCHANGED (the whole
 * point of the generated-config approach) and that the on-disk generated file matches the
 * returned config. The generated file is removed after each case.
 *
 * Run: node scripts/configure-build.test.js
 * Exit 0 on success, non-zero on failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');

function assert(condition, message) {
  if (!condition) {
    throw new Error('ASSERTION FAILED: ' + message);
  }
}

function runCase(label, envOverrides, assertFn) {
  console.log('\n--- ' + label + ' ---');

  // Snapshot package.json bytes to prove it is never mutated
  const packageJsonBefore = fs.readFileSync(PACKAGE_JSON, 'utf8');

  // Isolate env mutations
  const savedEnv = {};
  const managedKeys = [
    'CSC_DISABLE',
    'CSC_LINK',
    'APPLE_CERTIFICATE',
    'APPLE_ID',
    'APPLE_TEAM_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_APP_PASSWORD',
    'BUILD_VARIANT',
  ];

  for (const key of managedKeys) {
    if (key in process.env) {
      savedEnv[key] = process.env[key];
    }
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }

  let generatedPath;
  try {
    // Invalidate require cache so configure-build.js re-reads package.json fresh
    const cbPath = require.resolve('./configure-build.js');
    delete require.cache[cbPath];
    const { configureBuild, GENERATED_CONFIG_PATH } = require('./configure-build.js');
    generatedPath = GENERATED_CONFIG_PATH;

    const config = configureBuild();

    // package.json must be untouched
    const packageJsonAfter = fs.readFileSync(PACKAGE_JSON, 'utf8');
    assert(packageJsonAfter === packageJsonBefore, 'package.json must not be mutated by configureBuild()');

    // The on-disk generated config must match the returned value
    assert(fs.existsSync(generatedPath), 'generated config file should be written');
    const onDisk = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
    assert(
      JSON.stringify(onDisk) === JSON.stringify(config),
      'on-disk generated config should match the returned config'
    );

    assertFn(config);
    console.log('PASS: ' + label);
  } finally {
    // Clean up the generated artifact
    if (generatedPath && fs.existsSync(generatedPath)) {
      fs.unlinkSync(generatedPath);
    }
    // Restore env
    for (const key of managedKeys) {
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
  runCase('Case A: CSC_DISABLE=true (unsigned posture)', { CSC_DISABLE: 'true' }, function (config) {
    assert(config.mac.hardenedRuntime === false, 'hardenedRuntime should be false when signing disabled');
    assert(config.mac.notarize === false, 'notarize should be false when signing disabled');
    assert(config.mac.entitlements === undefined, 'entitlements should be removed when signing disabled');
    assert(config.mac.entitlementsInherit === undefined, 'entitlementsInherit should be removed when signing disabled');
  });
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
    function (config) {
      assert(config.mac.hardenedRuntime === true, 'hardenedRuntime should be true when signing enabled');
      assert(!!config.mac.notarize, 'notarize should be truthy when all credentials are present');
      assert(config.mac.entitlements === 'build/entitlements.mac.plist', 'entitlements should be set');
      assert(config.mac.entitlementsInherit === 'build/entitlements.mac.plist', 'entitlementsInherit should be set');
    }
  );
} catch (err) {
  console.error('FAIL: Case B — ' + err.message);
  failed = true;
}

try {
  // Case C: BUILD_VARIANT=beta → beta overrides baked into the generated config
  runCase(
    'Case C: BUILD_VARIANT=beta (beta overrides)',
    { BUILD_VARIANT: 'beta', CSC_DISABLE: 'true' },
    function (config) {
      assert(config.appId === 'com.cyboflow.app.beta', 'beta appId should be applied');
      assert(config.productName === 'Cyboflow Beta', 'beta productName should be applied');
      assert(
        config.mac.artifactName === 'Cyboflow-Beta-${version}-macOS-${arch}.${ext}',
        'beta artifactName should be applied with literal electron-builder tokens'
      );
      assert(
        config.publish && config.publish.url === 'https://updates.cyboflow.com/beta',
        'beta publish URL should be applied'
      );
      assert(config.publish.provider === 'generic', 'beta publish should preserve the base provider');
    }
  );
} catch (err) {
  console.error('FAIL: Case C — ' + err.message);
  failed = true;
}

if (failed) {
  console.error('\nOne or more test cases failed.');
  process.exit(1);
} else {
  console.log('\nAll test cases passed.');
  process.exit(0);
}
