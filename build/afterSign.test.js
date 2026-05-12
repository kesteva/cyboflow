/**
 * Smoke test for build/afterSign.js.
 * Run as: node build/afterSign.test.js
 * Exits 0 on success, 1 on any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const afterSign = require('./afterSign').default;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    failed++;
  } else {
    console.log('PASS:', message);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Case A: non-mac context resolves without removing files
// ---------------------------------------------------------------------------
async function caseA() {
  const ctx = {
    appOutDir: '/tmp',
    packager: {
      platform: { name: 'linux' },
      appInfo: { productName: 'X' }
    }
  };

  let resolved = false;
  let threw = false;
  try {
    await afterSign(ctx);
    resolved = true;
  } catch (_err) {
    threw = true;
  }

  assert(resolved && !threw, 'Case A: non-mac returns without throwing');
}

// ---------------------------------------------------------------------------
// Case B: mac context with synthetic vendor tree — both JARs removed
// ---------------------------------------------------------------------------
async function caseB() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';

    // Build the fake vendor tree under <tmpDir>/<productName>.app/...
    const vendorBase = path.join(
      tmpDir,
      `${productName}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'vendor'
    );
    const subDir = path.join(vendorBase, 'sub');
    fs.mkdirSync(subDir, { recursive: true });

    const jar1 = path.join(vendorBase, 'foo.jar');
    const jar2 = path.join(subDir, 'bar.jar');
    fs.writeFileSync(jar1, 'fake-jar-content');
    fs.writeFileSync(jar2, 'fake-jar-content');

    const ctx = {
      appOutDir: tmpDir,
      packager: {
        platform: { name: 'mac' },
        appInfo: { productName }
      }
    };

    let threw = false;
    try {
      await afterSign(ctx);
    } catch (err) {
      threw = true;
      console.error('Case B threw unexpectedly:', err);
    }

    assert(!threw, 'Case B: mac context does not throw');
    assert(!fs.existsSync(jar1), 'Case B: top-level jar removed (foo.jar)');
    assert(!fs.existsSync(jar2), 'Case B: nested jar removed (sub/bar.jar)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('--- afterSign smoke test ---');
  await caseA();
  await caseB();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
