#!/usr/bin/env node

/**
 * Smoke test for scripts/configure-build.js.
 *
 * Exercises configureBuild(), which reads package.json's `build` field (never mutating it)
 * and writes an environment-adjusted copy to build/electron-builder.generated.json.
 *
 *   Case A: CSC_DISABLE=true       → unsigned posture (hardenedRuntime false, notarize false, no entitlements)
 *   Case B: All Apple env vars set → signed posture (hardenedRuntime true, notarize truthy, entitlements set)
 *   Case C: BUILD_VARIANT=dev      → dev appId / productName / artifactName / publish URL overrides
 *   Case D: lean packaging plan    → every foreign Claude/Codex native package excluded
 *   Case E: BUILD_ARCH=<host arch> → generated config applies the tested plan
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
    'BUILD_ARCH',
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
  // Case C: BUILD_VARIANT=dev → dev overrides baked into the generated config
  runCase(
    'Case C: BUILD_VARIANT=dev (dev overrides)',
    { BUILD_VARIANT: 'dev', CSC_DISABLE: 'true' },
    function (config) {
      assert(config.appId === 'com.cyboflow.app.dev', 'dev appId should be applied');
      assert(config.productName === 'Cyboflow Dev', 'dev productName should be applied');
      assert(
        config.mac.artifactName === 'Cyboflow-Dev-${version}-macOS-${arch}.${ext}',
        'dev artifactName should be applied with literal electron-builder tokens'
      );
      assert(
        config.publish && config.publish.url === 'https://updates.cyboflow.com/dev',
        'dev publish URL should be applied'
      );
      assert(config.publish.provider === 'generic', 'dev publish should preserve the base provider');
    }
  );
} catch (err) {
  console.error('FAIL: Case C — ' + err.message);
  failed = true;
}

try {
  // Case D is pure so every CI host covers both target architectures even when
  // optional darwin packages are not installed there.
  const { getLeanPackagingPlan } = require('./configure-build.js');
  for (const targetArch of ['arm64', 'x64']) {
    const otherArch = targetArch === 'arm64' ? 'x64' : 'arm64';
    const plan = getLeanPackagingPlan(targetArch);
    assert(plan !== null, `a ${targetArch} lean-packaging plan should exist`);
    assert(plan.requiredBinaries.length === 2, 'both agent binaries should be required');
    assert(
      plan.requiredBinaries.some((entry) => entry.packageName === `@openai/codex-darwin-${targetArch}`),
      `the ${targetArch} Codex binary should be required`
    );
    assert(
      plan.exclusions.includes(`!node_modules/@openai/codex-darwin-${otherArch}/**`),
      `the foreign Codex darwin package should be excluded for ${targetArch}`
    );
    assert(
      plan.exclusions.includes('!node_modules/@openai/codex-linux-x64/**') &&
        plan.exclusions.includes('!node_modules/@openai/codex-win32-arm64/**'),
      'foreign Codex operating-system packages should be excluded'
    );
    assert(
      !plan.exclusions.includes(`!node_modules/@openai/codex-darwin-${targetArch}/**`),
      'the target Codex package must not be excluded'
    );
    assert(
      !plan.exclusions.includes('!node_modules/@openai/codex/**'),
      'the portable Codex launcher must remain packaged'
    );
  }
  assert(getLeanPackagingPlan(undefined) === null, 'an unset architecture should preserve universal packaging');
  console.log('\nPASS: Case D (lean Claude/Codex packaging plans)');
} catch (err) {
  console.error('FAIL: Case D — ' + err.message);
  failed = true;
}

try {
  // Case E applies the plan to the generated config. The preflight requires both
  // TARGET binaries on disk, so only run when this darwin host has both packages.
  const hostArch = process.arch === 'x64' ? 'x64' : 'arm64';
  const otherArch = hostArch === 'x64' ? 'arm64' : 'x64';
  const claudeHostBinary = path.join(
    __dirname, '..', 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${hostArch}`, 'claude'
  );
  const codexTriple = hostArch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const codexHostBinary = path.join(
    __dirname, '..', 'node_modules', '@openai', `codex-darwin-${hostArch}`,
    'vendor', codexTriple, 'bin', 'codex'
  );
  if (
    process.platform === 'darwin' &&
    fs.existsSync(claudeHostBinary) &&
    fs.existsSync(codexHostBinary)
  ) {
    runCase(
      `Case E: BUILD_ARCH=${hostArch} (lean per-arch exclusion)`,
      { BUILD_ARCH: hostArch, CSC_DISABLE: 'true' },
      function (config) {
        const claudeExclusion = `!node_modules/@anthropic-ai/claude-agent-sdk-darwin-${otherArch}/**`;
        const codexExclusion = `!node_modules/@openai/codex-darwin-${otherArch}/**`;
        assert(
          Array.isArray(config.files) && config.files.includes(claudeExclusion),
          `files should exclude the non-target Claude arch (${claudeExclusion})`
        );
        assert(
          config.files.includes(codexExclusion),
          `files should exclude the non-target Codex arch (${codexExclusion})`
        );
        assert(
          !config.files.includes(`!node_modules/@anthropic-ai/claude-agent-sdk-darwin-${hostArch}/**`),
          'files must not exclude the target Claude arch'
        );
        assert(
          !config.files.includes(`!node_modules/@openai/codex-darwin-${hostArch}/**`),
          'files must not exclude the target Codex arch'
        );
      }
    );
  } else {
    console.log('\n--- Case E: skipped (both darwin agent binaries are not installed on this host) ---');
  }
} catch (err) {
  console.error('FAIL: Case E — ' + err.message);
  failed = true;
}

if (failed) {
  console.error('\nOne or more test cases failed.');
  process.exit(1);
} else {
  console.log('\nAll test cases passed.');
  process.exit(0);
}
