#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get the build date
const buildDate = new Date().toISOString();

// Path to the main package.json
const packageJsonPath = path.join(__dirname, '..', 'package.json');

// Read the package.json
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Get git commit information
let gitCommit = 'unknown';
try {
  const gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  
  // Check if the working directory is clean (no uncommitted changes)
  try {
    execSync('git diff-index --quiet HEAD --', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    gitCommit = gitHash;
  } catch {
    // Working directory has uncommitted changes
    gitCommit = `${gitHash} (modified)`;
  }
} catch (err) {
  console.warn('Could not get git commit information:', err.message);
  gitCommit = 'unknown';
}

// Check if this is a canary build
const isCanaryBuild = process.env.CANARY_BUILD === 'true';
let version = packageJson.version;

if (isCanaryBuild) {
  // For canary builds, append -canary.{git-hash}
  const shortHash = gitCommit.includes('(modified)') ? gitCommit.split(' ')[0] : gitCommit;
  version = `${packageJson.version}-canary.${shortHash}`;
  console.log(`Canary build detected, using version: ${version}`);
}

// Create build info
const buildInfo = {
  version: version,
  buildDate: buildDate,
  gitCommit: gitCommit,
  buildTimestamp: Date.now(),
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  isCanary: isCanaryBuild,
  // Which app variant this build is: 'stable' (default) or 'dev'. Surfaced in
  // the About dialog and used to confirm the right artifact was built.
  variant: process.env.BUILD_VARIANT === 'dev' ? 'dev' : 'stable',
  // Telemetry environment. Resolution:
  //   1. CYBOFLOW_BUILD_ENV ('stable' | 'dev' | 'local') — explicit override.
  //      The release pipeline sets it (release:mac -> 'stable',
  //      release:mac:dev -> 'dev'); set 'local' by hand for a throwaway build
  //      that must not pollute release telemetry.
  //   2. Otherwise the build VARIANT: 'dev' for build:mac:dev*, else 'stable'.
  // Every packaged .dmg is distributable in practice, so it must report a
  // filterable environment. The old default ('local' unless the release
  // pipeline stamped it) hid tester errors from build:mac artifacts in the
  // same Sentry bucket as pnpm-dev runs — the 0.1.14 lesson. 'local' now
  // means: unpackaged pnpm dev, an explicit CYBOFLOW_BUILD_ENV=local build,
  // or a pre-fix artifact.
  environment:
    process.env.CYBOFLOW_BUILD_ENV === 'stable' ||
    process.env.CYBOFLOW_BUILD_ENV === 'dev' ||
    process.env.CYBOFLOW_BUILD_ENV === 'local'
      ? process.env.CYBOFLOW_BUILD_ENV
      : process.env.BUILD_VARIANT === 'dev'
        ? 'dev'
        : 'stable',
  // Telemetry client credentials, BAKED at build time. A distributed packaged
  // app has none of the build shell's env vars at runtime, so without this the
  // SDKs never get a DSN/key and silently no-op (the cause of "zero usage from
  // installed apps"). These are client-side keys designed to ship in the binary:
  // a Sentry DSN is public + write-only, an Aptabase app key is embedded in the
  // client SDK. null when absent from the build env → that SDK stays a no-op.
  // buildInfo.json lives in gitignored main/dist/, so these never enter the repo.
  sentryDsn: process.env.SENTRY_DSN || null,
  aptabaseAppKey: process.env.APTABASE_APP_KEY || null
};

// Write build info to a file in the main dist directory
const buildInfoPath = path.join(__dirname, '..', 'main', 'dist', 'buildInfo.json');

// Ensure the dist directory exists
const distDir = path.join(__dirname, '..', 'main', 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Write the build info
fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2));

// Redact the baked credentials in the log (presence only — never the values).
console.log('Build info injected:', {
  ...buildInfo,
  sentryDsn: buildInfo.sentryDsn ? '<set>' : null,
  aptabaseAppKey: buildInfo.aptabaseAppKey ? '<set>' : null,
});