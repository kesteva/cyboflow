#!/usr/bin/env node
/**
 * copy-assets — copy the runtime SQL assets into the compiled bundle.
 *
 * Implemented in Node rather than a shell pipeline so the `main` build chain
 * runs identically on every host, including Windows cmd.
 *
 * Copies src/database/*.sql and src/database/migrations/*.sql into the
 * matching dist/main/src/database/ trees. Runs in the `main` build chain after
 * `tsc`; the workflow markdown copy is a separate step
 * (copy-workflow-assets.js). CommonJS to match the other build helpers here.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const COPIES = [
  {
    srcDir: path.join(ROOT, 'src', 'database'),
    destDir: path.join(ROOT, 'dist', 'main', 'src', 'database'),
  },
  {
    srcDir: path.join(ROOT, 'src', 'database', 'migrations'),
    destDir: path.join(ROOT, 'dist', 'main', 'src', 'database', 'migrations'),
  },
];

let copied = 0;
for (const { srcDir, destDir } of COPIES) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.warn(`[copy-assets] missing source dir ${srcDir} — skipping`);
      continue;
    }
    throw err;
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    copied += 1;
  }
}
console.log(`[copy-assets] copied ${copied} SQL file(s) to dist`);
