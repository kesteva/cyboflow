#!/usr/bin/env node

/**
 * publish-update.mjs — upload electron-builder output to the Cloudflare R2
 * update host that the in-app auto-updater polls.
 *
 * Why a custom script instead of `electron-builder --publish`: electron-builder's
 * `generic` provider (what the app reads from, see package.json build.publish) is
 * READ-ONLY — it cannot upload. R2 speaks the S3 API for writes but serves public
 * downloads over a plain custom domain (updates.cyboflow.com), so we publish with
 * the S3 SDK here and let the app fetch over HTTPS with no credentials. This keeps
 * the source repo private and ships NO token inside the app bundle.
 *
 * It mirrors the release artifacts in dist-electron to the bucket root:
 *   - latest-mac.yml      (the manifest the updater polls — must NOT be cached)
 *   - *.zip / *.zip.blockmap   (what the updater downloads + delta map)
 *   - *.dmg / *.dmg.blockmap   (first-install download for the website)
 *
 * Required env (set these in your release shell / CI secrets — see docs/UPDATES.md):
 *   R2_ACCOUNT_ID          Cloudflare account id (subdomain of the S3 endpoint)
 *   R2_ACCESS_KEY_ID       R2 API token access key id
 *   R2_SECRET_ACCESS_KEY   R2 API token secret
 * Optional:
 *   R2_BUCKET              bucket name (default: cyboflow-updates)
 *   R2_ENDPOINT            full S3 endpoint override (default derived from account id)
 *   UPDATE_DRY_RUN=true    list what would upload, but don't upload
 */

import { createReadStream, statSync, readdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist-electron');
const PUBLIC_BASE = 'https://updates.cyboflow.com';

// File extensions we publish, with their content type. The .yml manifest is the
// only mutable file (it's overwritten each release), so it gets no-cache; the
// binaries are content-addressed by version in their name and are immutable.
const CONTENT_TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.blockmap': 'application/octet-stream',
};

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET || 'cyboflow-updates';
const dryRun = process.env.UPDATE_DRY_RUN === 'true';
const endpoint =
  process.env.R2_ENDPOINT ||
  (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);

if (!dryRun) {
  if (!accountId && !process.env.R2_ENDPOINT) {
    fail('R2_ACCOUNT_ID (or R2_ENDPOINT) is not set. See docs/UPDATES.md.');
  }
  if (!accessKeyId || !secretAccessKey) {
    fail('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set. See docs/UPDATES.md.');
  }
}

// Collect publishable top-level artifacts (ignore the unpacked app dirs).
let entries;
try {
  entries = readdirSync(DIST_DIR, { withFileTypes: true });
} catch {
  fail(`No build output at ${DIST_DIR}. Run a build (e.g. pnpm build:mac) first.`);
}

// .zip.blockmap / .dmg.blockmap end in .blockmap; extname() returns '.blockmap'.
const artifacts = entries
  .filter((e) => e.isFile())
  .map((e) => e.name)
  .filter((name) => extname(name) in CONTENT_TYPES);

if (artifacts.length === 0) {
  fail(`No publishable artifacts (.yml/.zip/.dmg/.blockmap) found in ${DIST_DIR}.`);
}

console.log(`\nPublishing ${artifacts.length} artifact(s) → r2://${bucket} (${PUBLIC_BASE})`);
if (dryRun) console.log('(dry run — nothing will be uploaded)\n');

const client =
  dryRun || !endpoint
    ? null
    : new S3Client({
        region: 'auto',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      });

for (const name of artifacts) {
  const ext = extname(name);
  const contentType = CONTENT_TYPES[ext];
  const isManifest = ext === '.yml';
  const cacheControl = isManifest
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable';
  const sizeMb = (statSync(join(DIST_DIR, name)).size / 1024 / 1024).toFixed(1);

  if (dryRun) {
    console.log(`  • ${name}  (${sizeMb} MB, ${contentType}, cache=${cacheControl})`);
    continue;
  }

  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: name,
      Body: createReadStream(join(DIST_DIR, name)),
      ContentType: contentType,
      CacheControl: cacheControl,
    },
  });

  process.stdout.write(`  ↑ ${name} (${sizeMb} MB) … `);
  // eslint-disable-next-line no-await-in-loop -- sequential keeps progress legible + avoids R2 rate spikes
  await upload.done();
  console.log('done');
}

console.log(`\n✓ Published. The app polls ${PUBLIC_BASE}/latest-mac.yml\n`);
