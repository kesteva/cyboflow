#!/usr/bin/env node

/**
 * Configure build settings based on environment.
 *
 * Reads the canonical electron-builder config from package.json's `build` field
 * (the committed source of truth — NEVER mutated) and writes an
 * environment-adjusted copy to build/electron-builder.generated.json. The build
 * scripts pass that file to electron-builder via `--config`, which uses it
 * INSTEAD of package.json's `build` (electron-builder reads a `--config` file
 * exclusively; it does not merge package.json `build` on top).
 *
 * Adjustments:
 *   - Signing/notarization posture is toggled based on the presence of Apple credentials.
 *   - When BUILD_VARIANT=dev, the dev appId / productName / artifactName / publish URL
 *     overrides are baked in.
 *   - When BUILD_PLATFORM=win (see the win branch below for the details):
 *     build.win is required instead of build.mac, npmRebuild is turned OFF and
 *     the installed better-sqlite3 artifact is probed against the Electron ABI
 *     (a wrong-ABI artifact fails the build), and the lean-packaging plan keeps
 *     the win32 agent binaries and excludes the darwin/linux ones.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');
const GENERATED_CONFIG_PATH = path.join(__dirname, '..', 'build', 'electron-builder.generated.json');

const CLAUDE_NATIVE_SUFFIXES = [
  'darwin-arm64', 'darwin-x64',
  'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl',
  'win32-x64', 'win32-arm64',
];
const CODEX_NATIVE_SUFFIXES = [
  'darwin-arm64', 'darwin-x64',
  'linux-x64', 'linux-arm64',
  'win32-x64', 'win32-arm64',
];
// better-sqlite3 >= 13 is N-API and ships one prebuild per platform as
// `prebuilds/<platform>-<arch>.node` (~2 MB each). Its loader picks exactly
// `prebuilds/<process.platform>-<process.arch>.node`, so a per-arch macOS build
// needs only the matching darwin file; the other seven are dead weight in the
// asar and the off-target darwin one would otherwise be the wrong arch.
const BETTER_SQLITE_PREBUILD_SUFFIXES = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64', 'linux-x64', 'linuxmusl-arm64', 'linuxmusl-x64',
  'win32-arm64', 'win32-x64',
];

function getLeanPackagingPlan(targetArch) {
  if (targetArch !== 'arm64' && targetArch !== 'x64') {
    return null;
  }

  const targetSuffix = `darwin-${targetArch}`;
  const codexTargetTriple = targetArch === 'arm64'
    ? 'aarch64-apple-darwin'
    : 'x86_64-apple-darwin';

  return {
    requiredBinaries: [
      {
        label: 'Claude Code',
        packageName: `@anthropic-ai/claude-agent-sdk-${targetSuffix}`,
        relativePath: path.join(
          'node_modules', '@anthropic-ai', `claude-agent-sdk-${targetSuffix}`, 'claude'
        ),
      },
      {
        label: 'Codex',
        packageName: `@openai/codex-${targetSuffix}`,
        relativePath: path.join(
          'node_modules', '@openai', `codex-${targetSuffix}`,
          'vendor', codexTargetTriple, 'bin', 'codex'
        ),
      },
    ],
    exclusions: [
      ...CLAUDE_NATIVE_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/@anthropic-ai/claude-agent-sdk-${suffix}/**`),
      ...CODEX_NATIVE_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/@openai/codex-${suffix}/**`),
      ...BETTER_SQLITE_PREBUILD_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/better-sqlite3/prebuilds/${suffix}.node`),
    ],
  };
}

/**
 * The Windows counterpart to getLeanPackagingPlan: a Windows installer needs
 * only the matching win32 agent packages; the darwin/linux ones are dead
 * weight (and would ride into the asar unchecked).
 */
function getWinPackagingPlan(targetArch) {
  if (targetArch !== 'x64' && targetArch !== 'arm64') {
    return null;
  }

  const targetSuffix = `win32-${targetArch}`;
  const codexTargetTriple = targetArch === 'x64'
    ? 'x86_64-pc-windows-msvc'
    : 'aarch64-pc-windows-msvc';

  return {
    requiredBinaries: [
      {
        label: 'Claude Code',
        packageName: `@anthropic-ai/claude-agent-sdk-${targetSuffix}`,
        relativePath: path.join(
          'node_modules', '@anthropic-ai', `claude-agent-sdk-${targetSuffix}`, 'claude.exe'
        ),
      },
      {
        label: 'Codex',
        packageName: `@openai/codex-${targetSuffix}`,
        relativePath: path.join(
          'node_modules', '@openai', `codex-${targetSuffix}`,
          'vendor', codexTargetTriple, 'bin', 'codex.exe'
        ),
      },
    ],
    exclusions: [
      ...CLAUDE_NATIVE_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/@anthropic-ai/claude-agent-sdk-${suffix}/**`),
      ...CODEX_NATIVE_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/@openai/codex-${suffix}/**`),
      // better-sqlite3 >= 13's N-API prebuild ships one per platform too (see
      // BETTER_SQLITE_PREBUILD_SUFFIXES above) — a Windows installer needs only
      // its own win32-<arch> file; the other seven (~2 MB each) are dead weight.
      ...BETTER_SQLITE_PREBUILD_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/better-sqlite3/prebuilds/${suffix}.node`),
    ],
  };
}

/**
 * Warn, never fail, when the bundled screen-capture binary is absent. It is an
 * optional darwin-only dependency, so absence is normal off macOS, and
 * shipping without it falls back to resolving `peekaboo` off the user's PATH.
 */
/**
 * Point node-pty's `build/Release` at the TARGET arch before packaging.
 *
 * node-pty's darwin loader computes `prebuilds/<platform>-<arch>/<runtime>.abi<ABI>.node`
 * and, when that exact name is absent, requires `../build/Release/pty.node`.
 * Our prebuilds carry the `node.napi*.node` name @electron/rebuild demands, not
 * the ABI name the loader builds, so the packaged app always lands on the
 * build/Release fallback — which means that file, and the `spawn-helper` binary
 * beside it, must BE the target arch. They are the host's by default, so a
 * cross-arch build would otherwise ship an arm64 pty inside an x64 bundle.
 *
 * Leaves the tree holding the target arch afterwards: a cross-arch build is
 * followed by the host-ABI restore the release runbook already prescribes.
 */
function stageDarwinPtyForArch(targetArch) {
  if (targetArch !== 'arm64' && targetArch !== 'x64') return;

  const pkgDir = path.join(
    __dirname, '..', 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch',
  );
  if (!fs.existsSync(pkgDir)) return;

  const prebuildsDir = path.join(pkgDir, 'prebuilds', `darwin-${targetArch}`);
  const addon = path.join(
    prebuildsDir, targetArch === 'arm64' ? 'node.napi.armv8.node' : 'node.napi.node',
  );
  const helper = path.join(prebuildsDir, 'spawn-helper');
  if (!fs.existsSync(addon) || !fs.existsSync(helper)) {
    console.error(
      `Error: the darwin-${targetArch} node-pty prebuild is incomplete ` +
        `(${path.relative(path.join(__dirname, '..'), prebuildsDir)}). A ${targetArch} build ` +
        `would ship the host architecture's pty and break every terminal. ` +
        `Run "pnpm run install:darwin-cross" before a cross-arch build.`
    );
    process.exit(1);
  }

  const releaseDir = path.join(pkgDir, 'build', 'Release');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(addon, path.join(releaseDir, 'pty.node'));
  fs.copyFileSync(helper, path.join(releaseDir, 'spawn-helper'));
  fs.chmodSync(path.join(releaseDir, 'spawn-helper'), 0o755);
  console.log(`Staged node-pty build/Release for darwin-${targetArch}.`);
}

function warnIfPeekabooMissing() {
  if (process.platform !== 'darwin') return;
  const binary = path.join(
    __dirname, '..', 'node_modules', '@steipete', 'peekaboo-mcp', 'peekaboo'
  );
  if (fs.existsSync(binary)) return;
  console.warn(
    'Warning: the bundled peekaboo capture binary is missing ' +
      '(@steipete/peekaboo-mcp). This build will ship without it and ' +
      'native-screen verification will fall back to whatever is on the ' +
      "user's PATH. Run \"pnpm install\" to restore it."
  );
}

/**
 * Does the installed better-sqlite3 artifact LOAD under the Electron ABI?
 * Delegates to ensure-sqlite-abi.mjs --check, which opens a database in a real
 * child Electron rather than guessing from a marker file. A child process
 * because that script is ESM and this file is CommonJS; `--check` mutates
 * nothing. Module-level so tests can stub it via __setAbiProbeForTesting.
 */
function probeWinElectronAbi() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'ensure-sqlite-abi.mjs'), '--check', 'electron'],
    { encoding: 'utf8' }
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

/** Test seam: replace the ABI probe (see probeWinElectronAbi). */
let abiProbe = probeWinElectronAbi;
function __setAbiProbeForTesting(fn) {
  abiProbe = fn;
}

/**
 * Azure Artifact Signing (formerly Trusted Signing) — the Windows counterpart
 * to the Apple credentials above.
 *
 * None of these four values is a secret: every one of them is readable from
 * any signed binary we ship, so they live here rather than in CI config. The
 * SECRETS are the Microsoft Entra ID env vars (AZURE_*), which electron-builder
 * reads directly and which never touch this file.
 *
 * The endpoint's region prefix must match the region the signing account and
 * certificate profile were created in (eastus -> eus); a mismatch authenticates
 * fine and then fails at sign time.
 */
const WIN_AZURE_SIGN_DEFAULTS = {
  publisherName: 'Raimundo Esteva',
  endpoint: 'https://eus.codesigning.azure.net/',
  codeSigningAccountName: 'cyboflowsigning',
  certificateProfileName: 'cyboflow-public-trust',
};

/**
 * Resolve `win.azureSignOptions`, or null to leave the build unsigned.
 *
 * Presence of the key is what SELECTS the signer: electron-builder picks
 * WindowsSignAzureManager whenever `azureSignOptions != null` and then hard-fails
 * initialize() if the Entra env vars are incomplete. So an unsigned build must
 * omit the key entirely — emitting it "just in case" would break every local and
 * CI Windows build that has no credentials.
 *
 * electron-builder requires AZURE_TENANT_ID + AZURE_CLIENT_ID plus ONE of three
 * credential shapes (client secret / client certificate / username+password);
 * we gate on the same set so a half-configured host fails here, with a readable
 * message, instead of deep inside a PowerShell module install.
 */
function getWinAzureSignOptions() {
  if (process.env.CSC_DISABLE === 'true') return null;

  const hasTenant = !!process.env.AZURE_TENANT_ID;
  const hasClient = !!process.env.AZURE_CLIENT_ID;
  const hasCredential = !!(
    process.env.AZURE_CLIENT_SECRET ||
    process.env.AZURE_CLIENT_CERTIFICATE_PATH ||
    process.env.AZURE_USERNAME
  );

  if (!hasTenant && !hasClient && !hasCredential) return null;

  if (!hasTenant || !hasClient || !hasCredential) {
    console.error(
      'Error: Azure signing is partially configured. electron-builder needs ' +
        'AZURE_TENANT_ID and AZURE_CLIENT_ID plus one of AZURE_CLIENT_SECRET, ' +
        'AZURE_CLIENT_CERTIFICATE_PATH, or AZURE_USERNAME+AZURE_PASSWORD.'
    );
    console.error(
      `  - AZURE_TENANT_ID: ${hasTenant ? 'set' : 'MISSING'}\n` +
        `  - AZURE_CLIENT_ID: ${hasClient ? 'set' : 'MISSING'}\n` +
        `  - credential: ${hasCredential ? 'set' : 'MISSING'}`
    );
    console.error('Unset all three to build unsigned, or supply the full set to sign.');
    process.exit(1);
  }

  return {
    publisherName: process.env.CYBOFLOW_AZURE_PUBLISHER_NAME || WIN_AZURE_SIGN_DEFAULTS.publisherName,
    endpoint: process.env.CYBOFLOW_AZURE_ENDPOINT || WIN_AZURE_SIGN_DEFAULTS.endpoint,
    codeSigningAccountName:
      process.env.CYBOFLOW_AZURE_ACCOUNT || WIN_AZURE_SIGN_DEFAULTS.codeSigningAccountName,
    certificateProfileName:
      process.env.CYBOFLOW_AZURE_PROFILE || WIN_AZURE_SIGN_DEFAULTS.certificateProfileName,
  };
}

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
  const isWin = process.env.BUILD_PLATFORM === 'win';

  console.log('Environment check:');
  console.log(`  - Target Platform: ${isWin ? 'win' : 'mac'}`);
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

  if (!packageJson.build || (!isWin && !packageJson.build.mac)) {
    console.error('Error: No macOS build configuration found in package.json');
    process.exit(1);
  }
  if (isWin && !packageJson.build.win) {
    console.error('Error: No Windows build configuration found in package.json');
    process.exit(1);
  }

  // Deep-clone so the source package.json is never touched
  const config = JSON.parse(JSON.stringify(packageJson.build));

  // Configure macOS signing posture based on capabilities. A win build has no
  // Apple posture to adjust — the credentials above are darwin-only, and the
  // win config carries no signing fields to mutate.
  if (!isWin) {
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
  }

  // Dev-variant overrides. Template tokens like ${version} are
  // electron-builder placeholders and must stay literal.
  if (isDev) {
    console.log('Applying dev-variant overrides...');
    config.appId = 'com.cyboflow.app.dev';
    config.productName = 'Cyboflow Dev';
    config.mac.artifactName = 'Cyboflow-Dev-${version}-macOS-${arch}.${ext}';
    if (isWin && config.win) {
      config.win.artifactName = 'Cyboflow-Dev-${version}-Windows-${arch}.${ext}';
    }
    config.publish = { ...(config.publish || {}), url: 'https://updates.cyboflow.com/dev' };
  }

  // Build-version override. The continuous dev release
  // (.github/workflows/dev-release.yml) stamps `<next-patch>-dev.<run>` on
  // every main push; it must not edit the committed package.json (the tree
  // would read dirty and buildInfo.gitCommit would carry "(modified)"), so the
  // version rides electron-builder's extraMetadata instead — that is what the
  // packaged app's package.json, `app.getVersion()`, the artifact names and
  // latest*.yml all read. inject-build-info.js honours the same variable.
  const buildVersion = process.env.CYBOFLOW_BUILD_VERSION;
  if (buildVersion) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(buildVersion)) {
      console.error(`Error: CYBOFLOW_BUILD_VERSION "${buildVersion}" is not a semver version`);
      process.exit(1);
    }
    config.extraMetadata = { ...(config.extraMetadata || {}), version: buildVersion };
    console.log(`Build version override: ${buildVersion} (package.json says ${packageJson.version})`);
  }

  // Windows ships prebuilt native modules (docs/WINDOWS-BUILD.md), so they are
  // packaged as-is: a rebuild needs MSVC, which a Windows dev host may not
  // have, and would clobber the verified prebuilds.
  // CYBOFLOW_WIN_NPM_REBUILD=1 restores it for hosts with a toolchain.
  if (isWin) {
    const winNpmRebuild = process.env.CYBOFLOW_WIN_NPM_REBUILD === '1';
    config.npmRebuild = winNpmRebuild;
    console.log(`Windows packaging: npmRebuild=${config.npmRebuild}` +
      (winNpmRebuild ? '' : ' (prebuilt .node files are packaged as-is; set CYBOFLOW_WIN_NPM_REBUILD=1 to rebuild)'));

    // Windows code signing via Azure Artifact Signing. Injected here rather than
    // declared in package.json because the key's mere PRESENCE selects the Azure
    // signer (see getWinAzureSignOptions), so an uncredentialed build — every
    // local build, and the CI installer smoke — must not carry it.
    const azureSignOptions = getWinAzureSignOptions();
    if (azureSignOptions) {
      config.win.azureSignOptions = azureSignOptions;
      console.log(
        `Windows signing: Azure Artifact Signing as "${azureSignOptions.publisherName}" ` +
          `(${azureSignOptions.codeSigningAccountName}/${azureSignOptions.certificateProfileName}).`
      );
    } else {
      console.log('Windows signing: disabled (no Azure credentials); the installer will be unsigned.');
    }

    // With npmRebuild off the .node files ship exactly as they sit in
    // node_modules. Since better-sqlite3 v13 (the Electron 44 upgrade) its
    // ONLY Windows addon is the N-API prebuild at prebuilds/win32-<arch>.node,
    // which is RUNTIME-AGNOSTIC — the same file loads under host Node and
    // Electron alike — so `node scripts/ensure-sqlite-abi.mjs electron` is a
    // cheap no-op against it (the probe below succeeds immediately; there is
    // no per-ABI artifact left to flip, unlike the old build/Release story).
    // The abiProbe stays anyway: it is a REAL load check under the packaged
    // Electron ABI, not an assumption, and is still what would catch a
    // regression (a stray per-ABI build/Release artifact shadowing the
    // prebuild, a corrupted install, or a future non-N-API addon) before it
    // ships and hard-crashes the app on first database open.
    if (!winNpmRebuild) {
      const probe = abiProbe();
      if (!probe.ok) {
        console.error(
          'Error: the installed better-sqlite3 artifact does not load under the ' +
            'ELECTRON ABI, but this build packages it as-is (npmRebuild=false). Shipping ' +
            'it would hard-crash the app on first database open ' +
            '(NODE_MODULE_VERSION mismatch).'
        );
        console.error('Run "node scripts/ensure-sqlite-abi.mjs electron" first, then retry the build.');
        if (probe.output) console.error(`Probe output:\n${probe.output}`);
        process.exit(1);
      }
      console.log('Windows packaging: better-sqlite3 verified on the Electron ABI.');
    }
  }

  // Both agent distributions ship native CLIs as optional per-arch packages,
  // and electron-builder bundles node_modules wholesale, so a cross-arch dev
  // box can carry all of them. Exclude the foreign ones, and fail fast on a
  // missing target binary rather than breaking that runtime after release.
  const targetArch = process.env.BUILD_ARCH;
  const leanPackagingPlan = isWin
    ? getWinPackagingPlan(targetArch)
    : getLeanPackagingPlan(targetArch);
  if (leanPackagingPlan) {
    const leanPlatform = isWin ? 'Windows' : 'macOS';
    for (const required of leanPackagingPlan.requiredBinaries) {
      const targetBinary = path.join(__dirname, '..', required.relativePath);
      if (fs.existsSync(targetBinary)) continue;
      console.error(
        `Error: the ${targetArch} ${required.label} binary is missing ` +
          `(${required.packageName}). A ${targetArch} ${leanPlatform} build would ` +
          `ship without it and break that agent runtime. ` +
          (isWin
            ? `Run "pnpm install" on the Windows host (its os/cpu constraints ` +
              `materialize the win32 optional packages).`
            : `Run "pnpm run install:darwin-cross" before a cross-arch build.`)
      );
      process.exit(1);
    }
    config.files = [
      ...(config.files || []),
      ...leanPackagingPlan.exclusions,
    ];
    console.log(
      `Lean packaging: keeping only ${isWin ? 'win32' : 'darwin'}-${targetArch} ` +
        `agent binaries; excluding ${leanPackagingPlan.exclusions.length} foreign native packages.`
    );
  }

  if (!isWin) stageDarwinPtyForArch(targetArch);

  warnIfPeekabooMissing();

  // Write the environment-adjusted config; package.json stays pristine
  fs.mkdirSync(path.dirname(GENERATED_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(GENERATED_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  const relPath = path.relative(path.join(__dirname, '..'), GENERATED_CONFIG_PATH);
  console.log(`Build configuration written to ${relPath}`);
  if (!isWin) {
    console.log(`Notarization: ${config.mac.notarize ? 'enabled' : 'disabled'}`);
    console.log(`Hardened Runtime: ${config.mac.hardenedRuntime ? 'enabled' : 'disabled'}`);
  }

  return config;
}

if (require.main === module) {
  // CLI arg form (--platform/--arch/--variant) exists so package.json scripts
  // never need POSIX `VAR=value cmd` env syntax, which breaks on Windows' cmd
  // shell; it feeds the same env vars the mac scripts set inline.
  const argv = process.argv.slice(2);
  const takeValue = (flag) => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (!value || value.startsWith('--')) {
      console.error(`Error: ${flag} needs a value`);
      process.exit(2);
    }
    return value;
  };
  const platform = takeValue('--platform');
  const arch = takeValue('--arch');
  const variant = takeValue('--variant');
  if (platform !== undefined) process.env.BUILD_PLATFORM = platform;
  if (arch !== undefined) process.env.BUILD_ARCH = arch;
  if (variant !== undefined) process.env.BUILD_VARIANT = variant;
  configureBuild();
}

module.exports = {
  configureBuild,
  getLeanPackagingPlan,
  getWinPackagingPlan,
  GENERATED_CONFIG_PATH,
  __setAbiProbeForTesting,
};
