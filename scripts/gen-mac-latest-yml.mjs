#!/usr/bin/env node

/**
 * gen-mac-latest-yml — produce a combined macOS `latest-mac.yml` auto-update
 * manifest for a lean PER-ARCH release.
 *
 * WHY: cyboflow builds each macOS arch in a SEPARATE electron-builder invocation
 * (so each DMG can lean-exclude the other arch's ~200MB claude binary — see
 * scripts/configure-build.js). Each run writes its own latest-mac.yml and the next
 * run overwrites it, so no single manifest ever lists both arches. Without that,
 * electron-updater can't resolve the arch-matching artifact and in-app updates fail.
 *
 * electron-updater's MacUpdater.filterFilesForArch selects purely by whether a
 * file url contains "arm64" (arm64 Macs incl. Rosetta get the arm64 file; x64 Macs
 * get the non-arm64 file), then findFile() picks the .zip. So one manifest listing
 * every arch's zip+dmg is correct for both. This script computes each file's size +
 * base64(SHA-512) (the exact format electron-builder emits) and writes that manifest.
 *
 * Usage:
 *   node scripts/gen-mac-latest-yml.mjs <outFile> <artifact...>
 *     <outFile>    where to write the YAML (e.g. dist-electron/latest-mac.yml)
 *     <artifact>   one or more .zip/.dmg basenames located in dist-electron
 *
 * Version is read from package.json. The primary `path`/`sha512` (legacy single-file
 * fallback) points at the first .zip listed; prefer passing the arm64 zip first.
 *
 * `minimumSystemVersion` is the macOS floor of the bundled Electron (read from
 * Electron.app's LSMinimumSystemVersion; override with CYBOFLOW_MIN_MACOS). electron-updater
 * honours it, so a Mac below the floor is told "no update" instead of auto-installing a build
 * that cannot launch — Electron 44 raised the floor from macOS 11 to 13. Required on macOS
 * (where releases are cut); omitted with a note elsewhere (Linux CI has no Electron.app).
 */

import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist-electron');
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** macOS floor of the Electron this release bundles, e.g. '13.0'; null when unknowable. */
function resolveMinimumSystemVersion() {
  const override = process.env.CYBOFLOW_MIN_MACOS;
  if (override) {
    if (!/^\d+(\.\d+){0,2}$/.test(override)) fail(`CYBOFLOW_MIN_MACOS is not a version: ${override}`);
    return override;
  }
  let plist;
  try {
    const electronDir = dirname(require.resolve('electron/package.json'));
    plist = join(electronDir, 'dist', 'Electron.app', 'Contents', 'Info.plist');
  } catch {
    return null;
  }
  if (!existsSync(plist)) return null;
  const xml = readFileSync(plist, 'utf8');
  const match = xml.match(/<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1].trim() : null;
}

const [outFile, ...artifacts] = process.argv.slice(2);
if (!outFile || artifacts.length === 0) {
  fail('Usage: node scripts/gen-mac-latest-yml.mjs <outFile> <artifact.zip|.dmg ...>');
}

const allowed = new Set(['.zip', '.dmg']);
for (const name of artifacts) {
  if (!allowed.has(extname(name))) fail(`Unsupported artifact (need .zip/.dmg): ${name}`);
}

function sha512Base64(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(absPath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

const files = [];
for (const name of artifacts) {
  const abs = join(DIST_DIR, name);
  let size;
  try {
    size = statSync(abs).size;
  } catch {
    fail(`Artifact not found in ${DIST_DIR}: ${name}`);
  }
  // eslint-disable-next-line no-await-in-loop -- sequential hashing keeps memory flat
  const sha512 = await sha512Base64(abs);
  files.push({ url: name, sha512, size });
}

const primary = files.find((f) => extname(f.url) === '.zip');
if (!primary) fail('At least one .zip artifact is required (electron-updater downloads the zip).');

const minimumSystemVersion = resolveMinimumSystemVersion();
if (!minimumSystemVersion && process.platform === 'darwin') {
  fail(
    'Could not read LSMinimumSystemVersion from node_modules/electron/dist/Electron.app — ' +
      'run `pnpm exec electron --version` to download Electron, or set CYBOFLOW_MIN_MACOS.'
  );
}
if (!minimumSystemVersion) {
  console.warn('Note: no Electron.app on this host — omitting minimumSystemVersion from the manifest.');
}

// Emit YAML in the exact shape electron-builder produces (validated by diffing
// against a real generated manifest). Hand-built rather than via a YAML lib to
// keep the dependency surface tiny and the output byte-predictable.
const lines = [`version: ${version}`, 'files:'];
for (const f of files) {
  lines.push(`  - url: ${f.url}`);
  lines.push(`    sha512: ${f.sha512}`);
  lines.push(`    size: ${f.size}`);
}
lines.push(`path: ${primary.url}`);
lines.push(`sha512: ${primary.sha512}`);
lines.push(`releaseDate: '${new Date().toISOString()}'`);
if (minimumSystemVersion) lines.push(`minimumSystemVersion: '${minimumSystemVersion}'`);
const yaml = lines.join('\n') + '\n';

writeFileSync(outFile, yaml);
console.log(`\n✓ Wrote ${outFile} (version ${version}, ${files.length} file(s), primary ${primary.url}).\n`);
console.log(yaml);
