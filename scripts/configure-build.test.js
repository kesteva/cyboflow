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
 *   Case D: lean packaging plan    → every foreign Claude/Codex native package and
 *                                    every non-target better-sqlite3 prebuild excluded
 *   Case E: BUILD_ARCH=<host arch> → generated config applies the tested plan
 *   Case F: BUILD_PLATFORM=win     → npmRebuild false + the Electron-ABI guard passes
 *                                    (probe stubbed via __setAbiProbeForTesting — no native
 *                                    artifact needed on the test host)
 *   Case F2: probe reports wrong ABI → hard exit(1) with the fix-it command
 *   Case F3: CYBOFLOW_WIN_NPM_REBUILD=1 → the ABI probe is skipped entirely
 *   Case G: win + full Azure env → win.azureSignOptions injected (and mac config untouched)
 *   Case G2: win, no Azure env   → win.azureSignOptions ABSENT (key presence selects the signer)
 *   Case G3: win + partial Azure env → hard exit(1) rather than a silently-unsigned build
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

function runCase(label, envOverrides, assertFn, preConfigure) {
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
    'BUILD_PLATFORM',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_CLIENT_CERTIFICATE_PATH',
    'AZURE_USERNAME',
    'CYBOFLOW_AZURE_PUBLISHER_NAME',
    'CYBOFLOW_AZURE_ENDPOINT',
    'CYBOFLOW_AZURE_ACCOUNT',
    'CYBOFLOW_AZURE_PROFILE',
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
    const mod = require('./configure-build.js');
    const { configureBuild, GENERATED_CONFIG_PATH } = mod;
    generatedPath = GENERATED_CONFIG_PATH;

    // Test seam: let a case inject a stub ABI probe (or otherwise touch the
    // fresh module) BEFORE configureBuild() runs.
    if (preConfigure) preConfigure(mod);

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
    // The peekaboo binary CANNOT be executed from inside the asar archive. If
    // this entry is ever dropped, native-screen verification breaks only in
    // PACKAGED builds — dev keeps resolving it through node_modules — which is
    // the kind of divergence that ships.
    assert(
      (config.asarUnpack || []).includes('node_modules/@steipete/peekaboo-mcp/**'),
      'the peekaboo capture binary must be unpacked out of the asar'
    );
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
    assert(
      plan.exclusions.includes(`!node_modules/better-sqlite3/prebuilds/darwin-${otherArch}.node`),
      `the foreign-arch better-sqlite3 prebuild should be excluded for ${targetArch}`
    );
    assert(
      plan.exclusions.includes('!node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node') &&
        plan.exclusions.includes('!node_modules/better-sqlite3/prebuilds/win32-arm64.node'),
      'foreign-platform better-sqlite3 prebuilds should be excluded'
    );
    assert(
      !plan.exclusions.includes(`!node_modules/better-sqlite3/prebuilds/darwin-${targetArch}.node`),
      'the target better-sqlite3 prebuild must not be excluded'
    );
    assert(
      !plan.exclusions.some((entry) => entry.startsWith('!node_modules/better-sqlite3/prebuilds/') && entry.endsWith('/**')),
      'better-sqlite3 exclusions must name files, never the whole prebuilds directory'
    );
  }
  assert(getLeanPackagingPlan(undefined) === null, 'an unset architecture should preserve universal packaging');
  console.log('\nPASS: Case D (lean Claude/Codex packaging plans)');
} catch (err) {
  console.error('FAIL: Case D — ' + err.message);
  failed = true;
}

try {
  // Case D2 is pure: exercises the Windows lean-packaging plan on every host
  // regardless of which optional agent packages are installed there.
  const { getWinPackagingPlan } = require('./configure-build.js');
  for (const targetArch of ['x64', 'arm64']) {
    const otherArch = targetArch === 'x64' ? 'arm64' : 'x64';
    const plan = getWinPackagingPlan(targetArch);
    assert(plan !== null, `a ${targetArch} win lean-packaging plan should exist`);
    assert(plan.requiredBinaries.length === 2, 'both agent binaries should be required');
    assert(
      plan.requiredBinaries.some(
        (entry) => entry.packageName === `@anthropic-ai/claude-agent-sdk-win32-${targetArch}` &&
          entry.relativePath.endsWith('claude.exe')
      ),
      `the ${targetArch} Windows Claude binary (claude.exe) should be required`
    );
    const codexTriple = targetArch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
    assert(
      plan.requiredBinaries.some((entry) =>
        entry.relativePath.includes(`codex-win32-${targetArch}`) &&
        entry.relativePath.includes(`vendor${path.sep}${codexTriple}${path.sep}bin${path.sep}codex.exe`)
      ),
      `the ${targetArch} Windows Codex binary (codex.exe, ${codexTriple}) should be required`
    );
    assert(
      plan.exclusions.includes(`!node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**`) &&
        plan.exclusions.includes(`!node_modules/@anthropic-ai/claude-agent-sdk-win32-${otherArch}/**`),
      `foreign Claude packages (darwin, other win32 arch) should be excluded for ${targetArch}`
    );
    assert(
      plan.exclusions.includes(`!node_modules/@openai/codex-linux-x64/**`) &&
        plan.exclusions.includes(`!node_modules/@openai/codex-darwin-x64/**`),
      'foreign Codex operating-system packages should be excluded'
    );
    assert(
      !plan.exclusions.includes(`!node_modules/@openai/codex-win32-${targetArch}/**`) &&
        !plan.exclusions.includes(`!node_modules/@anthropic-ai/claude-agent-sdk-win32-${targetArch}/**`),
      'the target win32 packages must not be excluded'
    );
    // A Windows installer used to ship all eight better-sqlite3 v13 prebuilds
    // (~2 MB each, none of them loadable except its own) — only the win32-<arch>
    // file this build targets should remain.
    assert(
      plan.exclusions.includes(`!node_modules/better-sqlite3/prebuilds/win32-${otherArch}.node`),
      `the OTHER win32 arch's better-sqlite3 prebuild should be excluded for ${targetArch}`
    );
    assert(
      plan.exclusions.includes('!node_modules/better-sqlite3/prebuilds/darwin-arm64.node') &&
        plan.exclusions.includes('!node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node'),
      'foreign-platform better-sqlite3 prebuilds should be excluded from a win build'
    );
    assert(
      !plan.exclusions.includes(`!node_modules/better-sqlite3/prebuilds/win32-${targetArch}.node`),
      'the target win32 better-sqlite3 prebuild must not be excluded'
    );
    assert(
      !plan.exclusions.some((entry) => entry.startsWith('!node_modules/better-sqlite3/prebuilds/') && entry.endsWith('/**')),
      'better-sqlite3 exclusions must name files, never the whole prebuilds directory'
    );
  }
  assert(getWinPackagingPlan(undefined) === null, 'an unset architecture should preserve win packaging');
  console.log('\nPASS: Case D2 (win Claude/Codex packaging plans)');
} catch (err) {
  console.error('FAIL: Case D2 — ' + err.message);
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
        assert(
          config.files.includes(`!node_modules/better-sqlite3/prebuilds/darwin-${otherArch}.node`) &&
            !config.files.includes(`!node_modules/better-sqlite3/prebuilds/darwin-${hostArch}.node`),
          'files should exclude only the non-target better-sqlite3 prebuild'
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

try {
  // Case F: a full Windows configureBuild run. Like Case E, the preflight
  // requires the TARGET win32 binaries on disk, so only run on a host that
  // actually installed them (a Windows dev box).
  const claudeWinBinary = path.join(
    __dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'
  );
  const codexWinBinary = path.join(
    __dirname, '..', 'node_modules', '@openai', 'codex-win32-x64',
    'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'
  );
  if (fs.existsSync(claudeWinBinary) && fs.existsSync(codexWinBinary)) {
    runCase(
      'Case F: BUILD_PLATFORM=win (Windows packaging posture)',
      { BUILD_PLATFORM: 'win', BUILD_ARCH: 'x64' },
      function (config) {
        assert(config.npmRebuild === false, 'win build must package the prebuilt .node files, not rebuild');
        assert(
          config.win && config.win.artifactName === '${productName}-${version}-Windows-${arch}.${ext}',
          'the win artifactName should be the stable-variant convention'
        );
        assert(config.appId === 'com.cyboflow.app', 'win stable build keeps the stable appId');
        assert(
          Array.isArray(config.files) && config.files.includes('!node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**'),
          'win files should exclude the darwin Claude package'
        );
        assert(
          !config.files.includes('!node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**'),
          'win files must not exclude the target win32-x64 Claude package'
        );
        // The Apple signing posture must be left untouched for a win build.
        assert(config.mac.notarize === true, 'win build should not mutate the mac notarize field');
      },
      // The ABI probe spawns a real child Electron against the installed
      // better-sqlite3, which this host cannot guarantee (--ignore-scripts
      // checkouts have no native artifact). Stub it — the probe's own
      // branches are covered by Cases F2/F3.
      function (mod) {
        mod.__setAbiProbeForTesting(function () {
          return { ok: true, output: 'stub: artifact loads under the electron ABI' };
        });
      }
    );
  } else {
    console.log('\n--- Case F: skipped (win32 agent binaries are not installed on this host) ---');
  }
} catch (err) {
  console.error('FAIL: Case F — ' + err.message);
  failed = true;
}

try {
  // Case F2: with npmRebuild off, a probe that reports the installed
  // better-sqlite3 does NOT load under the Electron ABI must hard-exit(1)
  // before electron-builder runs — packaged as-is it would crash at runtime.
  const savedBuildPlatform = process.env.BUILD_PLATFORM;
  process.env.BUILD_PLATFORM = 'win';

  const packageJsonBefore = fs.readFileSync(PACKAGE_JSON, 'utf8');
  const cbPath = require.resolve('./configure-build.js');
  delete require.cache[cbPath];
  const mod = require('./configure-build.js');
  mod.__setAbiProbeForTesting(function () {
    return { ok: false, output: 'stub: artifact does NOT load under the electron ABI' };
  });

  const realExit = process.exit;
  let exitCode = null;
  process.exit = function (code) {
    exitCode = code;
    throw new Error('PROCESS_EXIT');
  };
  try {
    mod.configureBuild();
    throw new Error('configureBuild should have exited on the failed ABI probe');
  } catch (err) {
    if (err.message !== 'PROCESS_EXIT') throw err;
  } finally {
    process.exit = realExit;
    if (fs.existsSync(mod.GENERATED_CONFIG_PATH)) fs.unlinkSync(mod.GENERATED_CONFIG_PATH);
    if (savedBuildPlatform === undefined) delete process.env.BUILD_PLATFORM;
    else process.env.BUILD_PLATFORM = savedBuildPlatform;
  }

  assert(exitCode === 1, 'the failed ABI probe must exit with code 1');
  assert(
    fs.readFileSync(PACKAGE_JSON, 'utf8') === packageJsonBefore,
    'package.json must not be mutated on the ABI-guard failure path'
  );
  console.log('\nPASS: Case F2 (win ABI-guard hard failure)');
} catch (err) {
  console.error('FAIL: Case F2 — ' + err.message);
  failed = true;
}

try {
  // Case F3: CYBOFLOW_WIN_NPM_REBUILD=1 restores electron-builder's own
  // rebuild step, which puts better-sqlite3 on the Electron ABI itself — so
  // the prebuilt artifact's ABI is irrelevant and the probe must not run.
  const savedBuildPlatform = process.env.BUILD_PLATFORM;
  const savedNpmRebuild = process.env.CYBOFLOW_WIN_NPM_REBUILD;
  process.env.BUILD_PLATFORM = 'win';
  // BUILD_ARCH deliberately unset: the lean-packaging preflight needs the
  // win32 agent binaries on disk, so a universal build skips it — this case
  // is host-independent.
  process.env.CYBOFLOW_WIN_NPM_REBUILD = '1';

  const cbPath = require.resolve('./configure-build.js');
  delete require.cache[cbPath];
  const mod = require('./configure-build.js');
  let probeCalls = 0;
  mod.__setAbiProbeForTesting(function () {
    probeCalls++;
    return { ok: false, output: 'stub: must not be consulted' };
  });

  try {
    const config = mod.configureBuild();
    assert(config.npmRebuild === true, 'CYBOFLOW_WIN_NPM_REBUILD=1 must re-enable npmRebuild');
    assert(probeCalls === 0, 'the ABI probe must be skipped when electron-builder will rebuild');
  } finally {
    if (fs.existsSync(mod.GENERATED_CONFIG_PATH)) fs.unlinkSync(mod.GENERATED_CONFIG_PATH);
    if (savedBuildPlatform === undefined) delete process.env.BUILD_PLATFORM;
    else process.env.BUILD_PLATFORM = savedBuildPlatform;
    if (savedNpmRebuild === undefined) delete process.env.CYBOFLOW_WIN_NPM_REBUILD;
    else process.env.CYBOFLOW_WIN_NPM_REBUILD = savedNpmRebuild;
  }
  console.log('\nPASS: Case F3 (CYBOFLOW_WIN_NPM_REBUILD=1 skips the ABI probe)');
} catch (err) {
  console.error('FAIL: Case F3 — ' + err.message);
  failed = true;
}

try {
  // Case G: a fully-credentialed Windows build carries azureSignOptions with
  // exactly the four fields electron-builder's WindowsAzureSigningConfiguration
  // requires. The env vars themselves are NOT copied into the config — they are
  // read by electron-builder at sign time — so a leaked generated config holds
  // no secret.
  runCase(
    'Case G: BUILD_PLATFORM=win + Azure credentials (signed posture)',
    {
      BUILD_PLATFORM: 'win',
      CYBOFLOW_WIN_NPM_REBUILD: '1',
      AZURE_TENANT_ID: 'tenant-guid',
      AZURE_CLIENT_ID: 'client-guid',
      AZURE_CLIENT_SECRET: 'shhh',
    },
    function (config) {
      const opts = config.win.azureSignOptions;
      assert(opts, 'azureSignOptions should be injected when Azure credentials are present');
      assert(opts.publisherName === 'Raimundo Esteva', 'publisherName must match the certificate CN');
      assert(
        opts.endpoint === 'https://eus.codesigning.azure.net/',
        'endpoint must match the signing account region'
      );
      assert(opts.codeSigningAccountName === 'cyboflowsigning', 'codeSigningAccountName mismatch');
      assert(opts.certificateProfileName === 'cyboflow-public-trust', 'certificateProfileName mismatch');
      assert(
        config.win.signtoolOptions === undefined,
        'signtoolOptions must stay absent — electron-builder refuses both signers at once'
      );
      const serialized = JSON.stringify(config);
      assert(!serialized.includes('shhh'), 'the client secret must never reach the generated config');
      assert(!serialized.includes('tenant-guid'), 'the tenant id must never reach the generated config');
    }
  );
  console.log('PASS: Case G');
} catch (err) {
  console.error('FAIL: Case G — ' + err.message);
  failed = true;
}

try {
  // Case G2: the uncredentialed path. This is the one that MUST stay clean —
  // electron-builder selects the Azure signer on key presence alone, so an
  // empty-but-present azureSignOptions would break every local Windows build
  // and the CI installer smoke.
  runCase(
    'Case G2: BUILD_PLATFORM=win, no Azure credentials (unsigned posture)',
    { BUILD_PLATFORM: 'win', CYBOFLOW_WIN_NPM_REBUILD: '1' },
    function (config) {
      assert(
        !('azureSignOptions' in config.win),
        'azureSignOptions must be ABSENT (not null/empty) without credentials'
      );
    }
  );
  console.log('PASS: Case G2');
} catch (err) {
  console.error('FAIL: Case G2 — ' + err.message);
  failed = true;
}

try {
  // Case G3: half-configured credentials must hard-fail. Falling through to an
  // unsigned build would be worse than useless: the release would look like it
  // succeeded and ship unsigned.
  const saved = {};
  const keys = ['BUILD_PLATFORM', 'CYBOFLOW_WIN_NPM_REBUILD', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.BUILD_PLATFORM = 'win';
  process.env.CYBOFLOW_WIN_NPM_REBUILD = '1';
  process.env.AZURE_TENANT_ID = 'tenant-guid';
  // AZURE_CLIENT_ID and the credential deliberately omitted.

  const packageJsonBefore = fs.readFileSync(PACKAGE_JSON, 'utf8');
  const cbPath = require.resolve('./configure-build.js');
  delete require.cache[cbPath];
  const mod = require('./configure-build.js');

  const realExit = process.exit;
  let exitCode = null;
  process.exit = function (code) {
    exitCode = code;
    throw new Error('PROCESS_EXIT');
  };
  try {
    mod.configureBuild();
    throw new Error('configureBuild should have exited on partial Azure credentials');
  } catch (err) {
    if (err.message !== 'PROCESS_EXIT') throw err;
  } finally {
    process.exit = realExit;
    if (fs.existsSync(mod.GENERATED_CONFIG_PATH)) fs.unlinkSync(mod.GENERATED_CONFIG_PATH);
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  assert(exitCode === 1, 'partial Azure credentials must exit with code 1');
  assert(
    fs.readFileSync(PACKAGE_JSON, 'utf8') === packageJsonBefore,
    'package.json must not be mutated on the Azure-credential failure path'
  );
  console.log('\nPASS: Case G3 (partial Azure credentials hard-fail)');
} catch (err) {
  console.error('FAIL: Case G3 — ' + err.message);
  failed = true;
}

if (failed) {
  console.error('\nOne or more test cases failed.');
  process.exit(1);
} else {
  console.log('\nAll test cases passed.');
  process.exit(0);
}
