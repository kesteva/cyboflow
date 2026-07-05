#!/usr/bin/env node
/**
 * Integration tests for the release / auto-update scripts (B11 scripts slice).
 *
 * Plain Node built-in test runner (node:test + node:assert) — no extra deps,
 * matching scripts/__tests__/verify-schema-parity.test.js. Runs in the
 * `test:unit` chain.
 *
 * Run: node scripts/__tests__/release-scripts.test.js
 *
 * Why each matters (from the plan's "Retires"):
 *   - gen-mac-latest-yml: a broken auto-update MANIFEST ships to every user and
 *     silently breaks in-app updates. Pin the exact shape electron-updater reads
 *     (version / files[].{url,sha512,size} / path / sha512 / releaseDate) and the
 *     SHA-512 base64 digest.
 *   - publish-update: the manifest/alias derivation that the website + updater
 *     resolve against. Exercised via UPDATE_DRY_RUN so no R2 upload happens.
 *   - bundle-mcp-server: a broken bundle only surfaces at runtime in a PACKAGED
 *     build (MODULE_NOT_FOUND for @modelcontextprotocol/sdk inside app.asar).
 *     Prove the bundle is self-contained + a resolvable entrypoint.
 *   - inject-build-info → restore-version: the build must never mutate the
 *     committed package.json. Pin the round-trip as byte-identical.
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_DIR = path.join(REPO_ROOT, 'dist-electron');

function run(scriptRelPath, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, scriptRelPath), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

/**
 * Ensure dist-electron exists (creating it if needed) and write the given
 * {name -> Buffer} fixtures into it. Returns a cleanup fn that removes exactly
 * those fixtures and the dir if this call created it — never clobbers a real
 * build output.
 */
function withDistFixtures(files) {
  const createdDir = !fs.existsSync(DIST_DIR);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  for (const [name, buf] of Object.entries(files)) {
    fs.writeFileSync(path.join(DIST_DIR, name), buf);
  }
  return function cleanup() {
    for (const name of Object.keys(files)) {
      fs.rmSync(path.join(DIST_DIR, name), { force: true });
    }
    if (createdDir) {
      try {
        fs.rmdirSync(DIST_DIR);
      } catch {
        /* dir not empty (real build output landed) — leave it */
      }
    }
  };
}

// ---------------------------------------------------------------------------
// gen-mac-latest-yml.mjs
// ---------------------------------------------------------------------------

test('gen-mac-latest-yml emits the electron-updater manifest shape with correct SHA-512', () => {
  const zipName = '__test-fixture-arm64.zip';
  const dmgName = '__test-fixture-arm64.dmg';
  const zipBytes = Buffer.from('fixture-zip-payload-abcdefghij');
  const dmgBytes = Buffer.from('fixture-dmg-payload-klmnopqrstuv');
  const cleanup = withDistFixtures({ [zipName]: zipBytes, [dmgName]: dmgBytes });
  const outFile = path.join(os.tmpdir(), `latest-mac-${process.pid}-${Date.now()}.yml`);

  try {
    const res = run('scripts/gen-mac-latest-yml.mjs', [outFile, zipName, dmgName]);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);

    const yaml = fs.readFileSync(outFile, 'utf-8');
    const pkgVersion = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
    ).version;

    // Required top-level manifest fields electron-updater's MacUpdater reads.
    assert.match(yaml, new RegExp(`^version: ${pkgVersion.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(yaml, /^files:$/m);
    assert.match(yaml, /^path: __test-fixture-arm64\.zip$/m); // primary = first .zip
    assert.match(yaml, /^releaseDate: '.+'$/m);

    // The releaseDate must be a valid ISO-8601 instant.
    const releaseDate = yaml.match(/^releaseDate: '(.+)'$/m)[1];
    assert.equal(new Date(releaseDate).toISOString(), releaseDate);

    // The SHA-512 must be the base64 digest electron-builder emits (per file).
    const zipSha = crypto.createHash('sha512').update(zipBytes).digest('base64');
    const dmgSha = crypto.createHash('sha512').update(dmgBytes).digest('base64');
    assert.match(yaml, new RegExp(`- url: ${zipName}\\n\\s+sha512: ${escapeRe(zipSha)}\\n\\s+size: ${zipBytes.length}`));
    assert.match(yaml, new RegExp(`- url: ${dmgName}\\n\\s+sha512: ${escapeRe(dmgSha)}\\n\\s+size: ${dmgBytes.length}`));

    // Top-level fallback path/sha512 point at the primary (.zip).
    assert.match(yaml, new RegExp(`^sha512: ${escapeRe(zipSha)}$`, 'm'));
  } finally {
    fs.rmSync(outFile, { force: true });
    cleanup();
  }
});

test('gen-mac-latest-yml fails when no .zip artifact is provided (updater downloads the zip)', () => {
  const dmgName = '__test-fixture-only.dmg';
  const cleanup = withDistFixtures({ [dmgName]: Buffer.from('dmg-only') });
  const outFile = path.join(os.tmpdir(), `latest-mac-nozip-${process.pid}.yml`);
  try {
    const res = run('scripts/gen-mac-latest-yml.mjs', [outFile, dmgName]);
    assert.notEqual(res.status, 0, 'expected non-zero exit when no .zip is passed');
    assert.match(res.stderr, /\.zip artifact is required/);
    assert.equal(fs.existsSync(outFile), false, 'no manifest should be written on failure');
  } finally {
    fs.rmSync(outFile, { force: true });
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// publish-update.mjs (dry run — no R2 upload)
// ---------------------------------------------------------------------------

test('publish-update (dry run) lists artifacts, maps content types, and derives the -latest- alias', () => {
  const dmg = 'Cyboflow-9.9.9-macOS-arm64.dmg';
  const zip = 'Cyboflow-9.9.9-macOS-arm64.zip';
  const yml = 'latest-mac.yml';
  const cleanup = withDistFixtures({
    [dmg]: Buffer.from('dmg'),
    [zip]: Buffer.from('zip'),
    [yml]: Buffer.from('version: 9.9.9\n'),
  });
  try {
    const res = run('scripts/publish-update.mjs', [], {
      UPDATE_DRY_RUN: 'true',
      PUBLISH_ONLY: [dmg, zip, yml].join(','),
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);

    // Publishes to the stable feed by default and reports the dry run.
    assert.match(res.stdout, /Publishing 3 stable artifact\(s\)/);
    assert.match(res.stdout, /dry run — nothing will be uploaded/);

    // The versioned .dmg derives the version-less website alias.
    assert.match(res.stdout, /alias stable\/Cyboflow-latest-macOS-arm64\.dmg/);

    // Content-type + cache mapping: the manifest is the only no-cache file.
    assert.match(res.stdout, /latest-mac\.yml.+text\/yaml.+cache=no-cache/);
    assert.match(res.stdout, /\.zip.+application\/zip.+cache=public, max-age=31536000, immutable/);
  } finally {
    cleanup();
  }
});

test('publish-update fails fast when a PUBLISH_ONLY name matches no real file', () => {
  const zip = 'Cyboflow-9.9.9-macOS-arm64.zip';
  const cleanup = withDistFixtures({ [zip]: Buffer.from('zip') });
  try {
    const res = run('scripts/publish-update.mjs', [], {
      UPDATE_DRY_RUN: 'true',
      PUBLISH_ONLY: `${zip},does-not-exist.dmg`,
    });
    assert.notEqual(res.status, 0, 'expected non-zero exit for a typo in PUBLISH_ONLY');
    assert.match(res.stderr, /not found in .*: does-not-exist\.dmg/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// bundle-mcp-server.mjs — self-contained, resolvable entrypoint
// ---------------------------------------------------------------------------

test('MCP server bundles self-contained and boots to a resolvable entrypoint', async () => {
  const esbuild = require('esbuild');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bundle-'));
  const outFile = path.join(tmpDir, 'cyboflowMcpServer.js');
  try {
    // Replicate the exact bundling contract bundle-mcp-server.mjs applies to the
    // tsc output, but against the TS SOURCE so this test needs no prior build.
    await esbuild.build({
      entryPoints: [
        path.join(REPO_ROOT, 'main/src/orchestrator/mcpServer/cyboflowMcpServer.ts'),
      ],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      logLevel: 'silent',
    });

    const bundled = fs.readFileSync(outFile, 'utf-8');
    // The SDK must be INLINED (no bare require) — that is what lets the subprocess
    // run from inside app.asar with no node_modules.
    assert.equal(
      /require\(["']@modelcontextprotocol/.test(bundled),
      false,
      'bundle still has a bare @modelcontextprotocol/sdk require — not self-contained',
    );
    // node builtins stay external (bundling them would be wrong).
    assert.match(bundled, /require\(["']net["']\)/);

    // Boot the bundle from a temp dir that has NO node_modules nearby. If the SDK
    // were not inlined it would die with MODULE_NOT_FOUND; instead it must reach
    // its own env-var guard, proving the entrypoint resolves and loads.
    const res = spawnSync(process.execPath, [outFile], {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: { PATH: process.env.PATH }, // deliberately omit CYBOFLOW_RUN_ID/SOCKET
    });
    assert.equal(res.status, 1, 'expected the env-var guard to exit 1');
    assert.match(res.stderr, /required env vars missing/);
    assert.doesNotMatch(res.stderr, /Cannot find module/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// inject-build-info.js → restore-version.js round-trip
// ---------------------------------------------------------------------------

test('inject-build-info → restore-version leaves package.json byte-identical and writes buildInfo.json', () => {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const pkgBefore = fs.readFileSync(pkgPath); // Buffer — byte comparison
  const biPath = path.join(REPO_ROOT, 'main', 'dist', 'buildInfo.json');
  const biExisted = fs.existsSync(biPath);
  const biBackup = biExisted ? fs.readFileSync(biPath) : null;

  try {
    const inject = run('scripts/inject-build-info.js');
    assert.equal(inject.status, 0, `inject-build-info failed: ${inject.stderr}`);

    // inject must NOT touch the committed package.json (it writes buildInfo.json).
    assert.ok(pkgBefore.equals(fs.readFileSync(pkgPath)), 'inject-build-info mutated package.json');

    // buildInfo.json carries the version from package.json plus the build metadata
    // the About dialog + telemetry read.
    const buildInfo = JSON.parse(fs.readFileSync(biPath, 'utf-8'));
    assert.equal(buildInfo.version, JSON.parse(pkgBefore.toString()).version);
    for (const key of ['buildDate', 'gitCommit', 'buildTimestamp', 'variant', 'environment']) {
      assert.ok(key in buildInfo, `buildInfo.json missing key: ${key}`);
    }

    // restore-version no-ops in CI (env forced) — assert the round-trip completes
    // and package.json is still byte-identical.
    const restore = run('scripts/restore-version.js', [], { GITHUB_ACTIONS: 'true' });
    assert.equal(restore.status, 0, `restore-version failed: ${restore.stderr}`);
    assert.match(restore.stdout, /Skipping package\.json restoration/);
    assert.ok(pkgBefore.equals(fs.readFileSync(pkgPath)), 'round-trip changed package.json bytes');
  } finally {
    // Restore buildInfo.json to its prior state so the test leaves no trace.
    if (biBackup) fs.writeFileSync(biPath, biBackup);
    else fs.rmSync(biPath, { force: true });
  }
});

// The telemetry-environment stamp matrix: CYBOFLOW_BUILD_ENV wins when set,
// otherwise the environment FOLLOWS THE VARIANT — a plain `build:mac` .dmg must
// report 'stable', not 'local', or its tester's Sentry events hide under the
// same bucket as pnpm-dev runs (the 0.1.14 lesson). Empty-string env vars model
// "unset" (run() merges process.env, so deletion isn't expressible here; the
// script's === checks treat '' as unset).
test('inject-build-info stamps environment from CYBOFLOW_BUILD_ENV, else the variant', () => {
  const biPath = path.join(REPO_ROOT, 'main', 'dist', 'buildInfo.json');
  const biExisted = fs.existsSync(biPath);
  const biBackup = biExisted ? fs.readFileSync(biPath) : null;

  const cases = [
    // [CYBOFLOW_BUILD_ENV, BUILD_VARIANT, expected environment, expected variant]
    ['', '', 'stable', 'stable'], // build:mac — the fixed case
    ['', 'dev', 'dev', 'dev'], // build:mac:dev
    ['stable', '', 'stable', 'stable'], // release:mac
    ['dev', 'dev', 'dev', 'dev'], // release:mac:dev
    ['local', '', 'local', 'stable'], // explicit throwaway-build opt-out
  ];

  try {
    for (const [buildEnv, variant, expectedEnv, expectedVariant] of cases) {
      const inject = run('scripts/inject-build-info.js', [], {
        CYBOFLOW_BUILD_ENV: buildEnv,
        BUILD_VARIANT: variant,
      });
      assert.equal(inject.status, 0, `inject-build-info failed: ${inject.stderr}`);
      const buildInfo = JSON.parse(fs.readFileSync(biPath, 'utf-8'));
      const label = `CYBOFLOW_BUILD_ENV='${buildEnv}' BUILD_VARIANT='${variant}'`;
      assert.equal(buildInfo.environment, expectedEnv, `${label}: wrong environment`);
      assert.equal(buildInfo.variant, expectedVariant, `${label}: wrong variant`);
    }
  } finally {
    if (biBackup) fs.writeFileSync(biPath, biBackup);
    else fs.rmSync(biPath, { force: true });
  }
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// Belt-and-suspenders: if a fixture leaked a freshly-created dist-electron, drop
// it when empty so the working tree stays clean.
after(() => {
  try {
    if (fs.existsSync(DIST_DIR) && fs.readdirSync(DIST_DIR).length === 0) {
      fs.rmdirSync(DIST_DIR);
    }
  } catch {
    /* ignore */
  }
});
