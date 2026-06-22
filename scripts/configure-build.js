#!/usr/bin/env node

/**
 * Configure build settings based on environment.
 *
 * Reads the canonical electron-builder config from package.json's `build` field
 * (the committed source of truth — NEVER mutated) and writes an environment-adjusted
 * copy to build/electron-builder.generated.json. The mac build scripts pass that file
 * to electron-builder via `--config`, which uses it INSTEAD of package.json's `build`
 * (electron-builder reads a `--config` file exclusively; it does not merge package.json
 * `build` on top — see app-builder-lib getConfig). This keeps the tracked package.json
 * clean across signed, unsigned, and dev builds.
 *
 * Adjustments:
 *   - Signing/notarization posture is toggled based on the presence of Apple credentials.
 *   - When BUILD_VARIANT=dev, the dev appId / productName / artifactName / publish URL
 *     overrides are baked in (these used to be inline `--config.*` flags on build:mac:dev).
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');
const GENERATED_CONFIG_PATH = path.join(__dirname, '..', 'build', 'electron-builder.generated.json');

function configureBuild() {
  console.log('Configuring build for current environment...');

  // Check if signing is explicitly disabled
  const signingDisabled = process.env.CSC_DISABLE === 'true';

  // Check if we have Apple signing credentials
  const hasAppleCertificate = !!(process.env.CSC_LINK || process.env.APPLE_CERTIFICATE);
  const hasAppleId = !!process.env.APPLE_ID;
  const hasTeamId = !!process.env.APPLE_TEAM_ID;
  const hasAppPassword = !!(process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_APP_PASSWORD);

  const canSign = !signingDisabled && hasAppleCertificate;
  const canNotarize = canSign && hasAppleId && hasTeamId && hasAppPassword;
  const isDev = process.env.BUILD_VARIANT === 'dev';

  console.log('Environment check:');
  console.log(`  - Signing Disabled: ${signingDisabled ? '✓' : '✗'}`);
  console.log(`  - Apple Certificate: ${hasAppleCertificate ? '✓' : '✗'}`);
  console.log(`  - Apple ID: ${hasAppleId ? '✓' : '✗'}`);
  console.log(`  - Team ID: ${hasTeamId ? '✓' : '✗'}`);
  console.log(`  - App Password: ${hasAppPassword ? '✓' : '✗'}`);
  console.log(`  - Can Sign: ${canSign ? '✓' : '✗'}`);
  console.log(`  - Can Notarize: ${canNotarize ? '✓' : '✗'}`);
  console.log(`  - Build Variant: ${isDev ? 'dev' : 'stable'}`);

  // Read the canonical config from package.json (source of truth — not mutated)
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

  if (!packageJson.build || !packageJson.build.mac) {
    console.error('Error: No macOS build configuration found in package.json');
    process.exit(1);
  }

  // Deep-clone so the source package.json is never touched
  const config = JSON.parse(JSON.stringify(packageJson.build));

  // Configure macOS signing posture based on capabilities
  config.mac.notarize = canNotarize;

  if (!canSign) {
    console.log('Configuring for unsigned build...');
    config.mac.hardenedRuntime = false;
    // Keep gatekeeperAssess false so unsigned apps can run locally
    config.mac.gatekeeperAssess = false;
    delete config.mac.entitlements;
    delete config.mac.entitlementsInherit;
  } else {
    console.log('Configuring for signed build...');
    config.mac.hardenedRuntime = true;
    config.mac.gatekeeperAssess = false;
    config.mac.entitlements = 'build/entitlements.mac.plist';
    config.mac.entitlementsInherit = 'build/entitlements.mac.plist';
  }

  // Dev-variant overrides (previously inline --config.* flags on build:mac:dev).
  // Template tokens like ${version} are electron-builder placeholders and must stay literal.
  if (isDev) {
    console.log('Applying dev-variant overrides...');
    config.appId = 'com.cyboflow.app.dev';
    config.productName = 'Cyboflow Dev';
    config.mac.artifactName = 'Cyboflow-Dev-${version}-macOS-${arch}.${ext}';
    config.publish = { ...(config.publish || {}), url: 'https://updates.cyboflow.com/dev' };
  }

  // Lean per-arch packaging. The claude-agent-sdk ships its (~200 MB) native
  // `claude` CLI as a per-arch package (`…-darwin-arm64` / `…-darwin-x64`). A
  // cross-arch dev box can have BOTH installed, and electron-builder bundles
  // node_modules wholesale — so a single-arch build would otherwise also ship
  // the OTHER arch's (dead-weight, wrong-arch) binary. When BUILD_ARCH names a
  // single arch, exclude the other arch's package and fail fast if the target
  // arch's binary is absent (which would silently break the SDK substrate at
  // runtime). BUILD_ARCH unset / 'universal' leaves files untouched.
  const targetArch = process.env.BUILD_ARCH;
  if (targetArch === 'arm64' || targetArch === 'x64') {
    const otherArch = targetArch === 'arm64' ? 'x64' : 'arm64';
    const sdkBase = '@anthropic-ai/claude-agent-sdk';
    const targetBinary = path.join(
      __dirname, '..', 'node_modules', `${sdkBase}-darwin-${targetArch}`, 'claude'
    );
    if (!fs.existsSync(targetBinary)) {
      console.error(
        `Error: the ${targetArch} Claude Code binary is missing ` +
          `(${sdkBase}-darwin-${targetArch}/claude). A ${targetArch} build would ship ` +
          `without it and break the SDK substrate at runtime. ` +
          `Run "pnpm run install:darwin-cross" before a cross-arch build.`
      );
      process.exit(1);
    }
    config.files = [...(config.files || []), `!node_modules/${sdkBase}-darwin-${otherArch}/**`];
    console.log(`Lean packaging: excluding ${sdkBase}-darwin-${otherArch} (target arch ${targetArch}).`);
  }

  // Write the environment-adjusted config; package.json stays pristine
  fs.mkdirSync(path.dirname(GENERATED_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(GENERATED_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  const relPath = path.relative(path.join(__dirname, '..'), GENERATED_CONFIG_PATH);
  console.log(`Build configuration written to ${relPath}`);
  console.log(`Notarization: ${config.mac.notarize ? 'enabled' : 'disabled'}`);
  console.log(`Hardened Runtime: ${config.mac.hardenedRuntime ? 'enabled' : 'disabled'}`);

  return config;
}

if (require.main === module) {
  configureBuild();
}

module.exports = { configureBuild, GENERATED_CONFIG_PATH };
