/**
 * Smoke test for build/afterSign.js (post-sign JAR tripwire + bundle hard checks).
 * Run as: node build/afterSign.test.js
 * Exits 0 on success, 1 on any failure.
 *
 * Cases A-D cover the warn-only JAR tripwire. Cases E onward cover the hard
 * checks that fail a release build: bundle architecture, the native-module ABI
 * probe, and the .app / app.asar size floors. Cases W-AA cover the Windows arm
 * (win-unpacked layout: PE machine check, load probe, unpacked size floor) and
 * run only on a win32 host.
 *
 * Where a check can be exercised honestly without building an app, it is:
 * `lipo` really runs against a real Mach-O binary, and the ABI probe really
 * spawns the host `node` and really `require()`s a real native module. Only the
 * cases that need a binary nobody has on hand (a deliberately wrong-arch build)
 * stub command execution.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const afterSignModule = require('./afterSign');
const afterSign = afterSignModule.default;
const helpers = afterSignModule._helpers;

const repoRoot = path.join(__dirname, '..');

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

/** Run afterSign while capturing console.warn output. */
async function runCapturingWarnings(ctx) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let threw = false;
  try {
    await afterSign(ctx);
  } catch (_err) {
    threw = true;
  } finally {
    console.warn = originalWarn;
  }
  return { threw, warnings };
}

function macContext(appOutDir, productName) {
  return {
    appOutDir,
    packager: {
      platform: { name: 'mac' },
      appInfo: { productName }
    }
  };
}

// ---------------------------------------------------------------------------
// Fixtures for the bundle hard checks
// ---------------------------------------------------------------------------

/** builder-util's Arch enum ordinals, as electron-builder passes them. */
const ARCH = { ia32: 0, x64: 1, armv7l: 2, arm64: 3, universal: 4 };

const PRODUCT_NAME = 'TestApp';

/** Run afterSign capturing warnings AND the thrown error. */
async function runCapturing(ctx) {
  const warnings = [];
  const logs = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  let error = null;
  try {
    await afterSign(ctx);
  } catch (err) {
    error = err;
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  return { error, message: error ? error.message : '', warnings, logs };
}

function macArchContext(appOutDir, arch) {
  return {
    appOutDir,
    arch,
    packager: {
      platform: { name: 'mac' },
      appInfo: { productName: PRODUCT_NAME }
    }
  };
}

/**
 * Create a file with a large apparent size without writing its bytes.
 * ftruncate leaves a sparse file on APFS, so a 160 MB fixture costs no disk —
 * and the size check under test reads st.size, which sees the full length.
 */
function writeSparseFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A real Mach-O binary that is NOT a loadable node addon — the honest fixture
 * for "the arch is right but the module will not load".
 */
function machOButNotAnAddon() {
  return fs.existsSync('/bin/ls') ? '/bin/ls' : process.execPath;
}

/** Does this .node load in THIS process? The independent oracle for the probe. */
function loadsInProcess(file) {
  try {
    require(file);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * A better_sqlite3.node that the host `node` can actually load, if this
 * checkout has one. Either the installed artifact (when it currently carries
 * the host ABI) or a host-keyed entry banked in .abi-cache by
 * scripts/ensure-sqlite-abi.mjs.
 */
function resolveHostLoadableAddon() {
  const candidates = [];
  try {
    const moduleDir = path.dirname(
      require.resolve('better-sqlite3/package.json', { paths: [repoRoot] })
    );
    candidates.push(path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node'));
  } catch (_err) {
    // Not installed in (or above) this checkout.
  }
  for (const dir of abiCacheEntries('host-')) {
    candidates.push(path.join(dir, 'better_sqlite3.node'));
  }
  return candidates.find((file) => fs.existsSync(file) && loadsInProcess(file)) || null;
}

/**
 * A better_sqlite3.node built for the ELECTRON ABI, if one is banked here.
 * Loading it under host `node` is a genuine NODE_MODULE_VERSION mismatch — the
 * exact third historical release failure. Absent on a checkout that has only
 * ever run the unit suite, hence opportunistic.
 */
function resolveElectronAbiAddon() {
  for (const dir of abiCacheEntries('electron-')) {
    const file = path.join(dir, 'better_sqlite3.node');
    if (fs.existsSync(file) && !loadsInProcess(file)) return file;
  }
  return null;
}

/**
 * The installed Electron binary, or null. Electron and host Node have
 * different NODE_MODULE_VERSIONs, so pointing the probe at Electron with a
 * HOST-ABI module reproduces the third historical release failure exactly —
 * no packaged app required.
 */
function resolveElectronBinary() {
  try {
    const entry = require(require.resolve('electron', { paths: [repoRoot] }));
    return typeof entry === 'string' && fs.existsSync(entry) ? entry : null;
  } catch (_err) {
    return null;
  }
}

function abiCacheEntries(prefix) {
  const cacheDir = process.env.SQLITE_ABI_CACHE_DIR || path.join(repoRoot, '.abi-cache');
  if (!fs.existsSync(cacheDir)) return [];
  return fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(cacheDir, entry.name));
}

/**
 * Build a fake .app tree under `tmpDir`.
 *
 * Defaults produce a bundle that passes every check on this host: an Info.plist
 * naming a main executable that is a symlink to the running `node` (a real
 * host-arch Mach-O that really behaves as Node when spawned), a
 * better_sqlite3.node, a fat-enough app.asar and enough padding to clear the
 * .app floor. Each option turns exactly one of those off.
 */
function buildAppFixture(tmpDir, options = {}) {
  const opts = {
    executableName: PRODUCT_NAME,
    withInfoPlist: true,
    withExecutable: true,
    addons: undefined,
    asarBytes: 20 * 1024 * 1024,
    padBytes: 160 * 1024 * 1024,
    ...options
  };

  const appPath = path.join(tmpDir, `${PRODUCT_NAME}.app`);
  const contents = path.join(appPath, 'Contents');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  if (opts.withInfoPlist) {
    fs.writeFileSync(
      path.join(contents, 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<plist version="1.0">\n<dict>\n' +
        '\t<key>CFBundleExecutable</key>\n' +
        `\t<string>${opts.executableName}</string>\n` +
        '</dict>\n</plist>\n'
    );
  }

  if (opts.withExecutable) {
    // A symlink, not a copy: `lipo` and the spawned probe both follow it, and
    // it avoids duplicating a ~100 MB binary per fixture.
    fs.symlinkSync(process.execPath, path.join(contents, 'MacOS', opts.executableName));
  }

  const addons = opts.addons === undefined
    ? [{ name: 'better_sqlite3.node', source: resolveHostLoadableAddon() || machOButNotAnAddon() }]
    : opts.addons;
  for (const addon of addons) {
    const dest = path.join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      addon.dep || 'some-dep',
      'build',
      'Release',
      addon.name
    );
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(addon.source, dest);
  }

  if (opts.asarBytes !== false) {
    writeSparseFile(path.join(resources, 'app.asar'), opts.asarBytes);
  }
  if (opts.padBytes > 0) {
    writeSparseFile(path.join(resources, 'padding.bin'), opts.padBytes);
  }

  return appPath;
}

async function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    return await fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** The Arch ordinal matching the host, so a healthy fixture is expected to pass. */
function hostArchOrdinal() {
  return process.arch === 'x64' ? ARCH.x64 : ARCH.arm64;
}

// ---------------------------------------------------------------------------
// Case A: non-mac context resolves without throwing or warning
// ---------------------------------------------------------------------------
async function caseA() {
  const { threw, warnings } = await runCapturingWarnings({
    appOutDir: '/tmp',
    packager: {
      platform: { name: 'linux' },
      appInfo: { productName: 'X' }
    }
  });
  assert(!threw, 'Case A: non-mac returns without throwing');
  assert(warnings.length === 0, 'Case A: non-mac emits no warnings');
}

// ---------------------------------------------------------------------------
// Case B: mac tree WITH JARs — warns, does NOT delete (post-sign bundle is sealed)
// ---------------------------------------------------------------------------
async function caseB() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    const unpackedBase = path.join(
      tmpDir,
      `${productName}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'some-dep'
    );
    const subDir = path.join(unpackedBase, 'sub');
    fs.mkdirSync(subDir, { recursive: true });

    const jar1 = path.join(unpackedBase, 'foo.jar');
    const jar2 = path.join(subDir, 'bar.jar');
    fs.writeFileSync(jar1, 'fake-jar-content');
    fs.writeFileSync(jar2, 'fake-jar-content');

    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    const warnText = warnings.join('\n');

    assert(!threw, 'Case B: mac context does not throw');
    assert(fs.existsSync(jar1), 'Case B: top-level jar NOT deleted (foo.jar)');
    assert(fs.existsSync(jar2), 'Case B: nested jar NOT deleted (sub/bar.jar)');
    assert(warnText.includes('foo.jar'), 'Case B: warning names foo.jar');
    assert(warnText.includes('bar.jar'), 'Case B: warning names nested bar.jar');
    assert(warnText.includes('2 JAR file(s)'), 'Case B: warning reports the count');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case C: mac tree with no JARs — resolves quietly
// ---------------------------------------------------------------------------
async function caseC() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    const unpackedBase = path.join(
      tmpDir,
      `${productName}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'some-dep'
    );
    fs.mkdirSync(unpackedBase, { recursive: true });
    fs.writeFileSync(path.join(unpackedBase, 'index.js'), 'module.exports = {};');

    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    assert(!threw, 'Case C: mac context without JARs does not throw');
    assert(warnings.length === 0, 'Case C: no warnings when no JARs present');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case D: mac context with no app.asar.unpacked directory at all — no throw
// ---------------------------------------------------------------------------
async function caseD() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    fs.mkdirSync(path.join(tmpDir, `${productName}.app`, 'Contents', 'Resources'), {
      recursive: true
    });
    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    assert(!threw, 'Case D: missing app.asar.unpacked does not throw');
    assert(warnings.length === 0, 'Case D: missing app.asar.unpacked emits no warnings');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case E: arch resolution — the enum ordinals electron-builder actually passes
// ---------------------------------------------------------------------------
async function caseE() {
  const { resolveExpectedArch, archMatches } = helpers;
  assert(resolveExpectedArch(ARCH.x64) === 'x64', 'Case E: ordinal 1 resolves to x64');
  assert(resolveExpectedArch(ARCH.arm64) === 'arm64', 'Case E: ordinal 3 resolves to arm64');
  assert(resolveExpectedArch(ARCH.universal) === 'universal', 'Case E: ordinal 4 resolves to universal');
  assert(resolveExpectedArch(99) === null, 'Case E: an unknown ordinal resolves to null');
  assert(resolveExpectedArch('arm64') === 'arm64', 'Case E: a string arch is accepted');
  assert(resolveExpectedArch('x86_64') === 'x64', 'Case E: the Mach-O slice name normalizes to x64');

  assert(archMatches(['x86_64'], 'x64'), 'Case E: x86_64 satisfies x64');
  assert(!archMatches(['x86_64'], 'arm64'), 'Case E: x86_64 does NOT satisfy arm64');
  assert(archMatches(['arm64e'], 'arm64'), 'Case E: arm64e satisfies arm64');
  assert(
    !archMatches(['arm64'], 'universal'),
    'Case E: a single slice does NOT satisfy a universal main executable'
  );
  assert(
    archMatches(['arm64'], 'universal', true),
    'Case E: a single-slice addon is allowed inside a universal bundle'
  );
}

// ---------------------------------------------------------------------------
// Case F: wrong architecture hard-fails — REAL `lipo` against a real Mach-O.
// No mac binary carries an i386 slice any more, so demanding ia32 of the host
// `node` is a genuine mismatch rather than a stubbed one.
// ---------------------------------------------------------------------------
async function caseF() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir);
    const { message } = await runCapturing(macArchContext(tmpDir, ARCH.ia32));

    assert(message !== '', 'Case F: a wrong-arch bundle throws');
    assert(
      message.includes('do not contain the expected ia32 architecture'),
      'Case F: the error names the expected architecture'
    );
    assert(
      message.includes(`${PRODUCT_NAME}.app/Contents/MacOS/${PRODUCT_NAME}`),
      'Case F: the error lists the offending main executable'
    );
    assert(
      message.includes('better_sqlite3.node'),
      'Case F: the error also lists the offending native addon'
    );
  });
}

// ---------------------------------------------------------------------------
// Case G: a healthy bundle passes every check — REAL lipo, REAL ABI probe.
// ---------------------------------------------------------------------------
async function caseG() {
  const addon = resolveHostLoadableAddon();
  if (!addon) {
    console.log(
      'SKIP: Case G needs a host-ABI better_sqlite3.node ' +
        '(run `node scripts/ensure-sqlite-abi.mjs host` to produce one)'
    );
    return;
  }
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { addons: [{ name: 'better_sqlite3.node', source: addon }] });
    const { message, warnings } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(message === '', `Case G: a healthy bundle does not throw (got: ${message})`);
    assert(warnings.length === 0, 'Case G: a healthy bundle emits no warnings');
  });
}

// ---------------------------------------------------------------------------
// Case H: the native module does not load — REAL spawn, REAL require failure.
// The fixture is a real host-arch Mach-O that simply is not a node addon, so
// the architecture check passes and only the ABI probe fails.
// ---------------------------------------------------------------------------
async function caseH() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, {
      addons: [{ name: 'better_sqlite3.node', source: machOButNotAnAddon() }]
    });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message !== '', 'Case H: an unloadable native module throws');
    assert(
      message.includes('cannot load the packaged better_sqlite3.node'),
      'Case H: the error identifies the ABI/load failure'
    );
    assert(
      !message.includes('do not contain the expected'),
      'Case H: the architecture check passes — only the load fails'
    );
  });
}

// ---------------------------------------------------------------------------
// Case I: the ABI probe helper, exercised directly against real binaries.
// The verdict is cross-checked against an independent oracle: whether THIS
// process can require the same file.
// ---------------------------------------------------------------------------
async function caseI() {
  const { probeNativeModule } = helpers;

  const notAnAddon = machOButNotAnAddon();
  const badProbe = probeNativeModule(process.execPath, notAnAddon);
  assert(badProbe.ok === false, 'Case I: probing a non-addon Mach-O reports failure');
  assert(
    typeof badProbe.detail === 'string' && badProbe.detail.length > 0,
    'Case I: the failed probe carries the child stderr'
  );

  const addon = resolveHostLoadableAddon();
  if (addon) {
    const goodProbe = probeNativeModule(process.execPath, addon);
    assert(
      goodProbe.ok === loadsInProcess(addon),
      'Case I: the probe agrees with an in-process require of the same module'
    );
    assert(goodProbe.ok === true, 'Case I: a loadable native module probes clean');
  } else {
    console.log('SKIP: Case I positive probe needs a host-ABI better_sqlite3.node');
  }

  // A REAL NODE_MODULE_VERSION mismatch, reproduced without building anything:
  // point the probe at the two hosts whose ABIs actually ping-pong in this repo.
  // Electron loading a host-ABI module is precisely the failure that shipped.
  const electronBinary = resolveElectronBinary();
  if (electronBinary && addon) {
    const mismatch = probeNativeModule(electronBinary, addon);
    assert(
      mismatch.ok === false,
      'Case I: Electron refuses a host-ABI native module (real ABI mismatch)'
    );
    assert(
      mismatch.detail.includes('NODE_MODULE_VERSION'),
      `Case I: the failure reports the NODE_MODULE_VERSION mismatch verbatim (got: ${mismatch.detail})`
    );
  } else {
    console.log('SKIP: Case I NODE_MODULE_VERSION check needs Electron plus a host-ABI module');
  }

  // A banked Electron-ABI artifact, if this checkout has one, is the same
  // mismatch from the other direction.
  const electronAbiAddon = resolveElectronAbiAddon();
  if (electronAbiAddon) {
    const reverse = probeNativeModule(process.execPath, electronAbiAddon);
    assert(reverse.ok === false, 'Case I: an Electron-ABI module fails under host node');
    assert(
      reverse.detail.includes('NODE_MODULE_VERSION'),
      'Case I: the reverse mismatch also names NODE_MODULE_VERSION'
    );
  }
}

// ---------------------------------------------------------------------------
// Case J: better_sqlite3.node missing from an otherwise populated bundle
// ---------------------------------------------------------------------------
async function caseJ() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, {
      addons: [{ name: 'pty.node', dep: 'node-pty', source: machOButNotAnAddon() }]
    });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message !== '', 'Case J: a bundle without better_sqlite3.node throws');
    assert(
      message.includes('better_sqlite3.node was not found'),
      'Case J: the error names the missing module'
    );
    assert(
      !message.includes('no *.node native addons found'),
      'Case J: other addons are present, so the empty-addons check does not fire'
    );
  });
}

// ---------------------------------------------------------------------------
// Case K: zero native addons at all
// ---------------------------------------------------------------------------
async function caseK() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { addons: [] });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message !== '', 'Case K: a bundle with no native addons throws');
    assert(
      message.includes('no *.node native addons found'),
      'Case K: the error explains that native modules were not unpacked'
    );
  });
}

// ---------------------------------------------------------------------------
// Case L: size floors — a stub .app and a stub asar, reported together
// ---------------------------------------------------------------------------
async function caseL() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { padBytes: 0, asarBytes: 4096 });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message !== '', 'Case L: an undersized bundle throws');
    assert(
      message.includes('the packaged app is only'),
      'Case L: the error reports the .app size floor'
    );
    assert(
      message.includes('app.asar is only'),
      'Case L: the error reports the app.asar size floor'
    );
    assert(
      /failed \d+ verification check\(s\)/.test(message),
      'Case L: both floors are reported in ONE error'
    );
  });
}

// ---------------------------------------------------------------------------
// Case M: app.asar missing entirely
// ---------------------------------------------------------------------------
async function caseM() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { asarBytes: false });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(message.includes('app.asar is missing'), 'Case M: a missing app.asar throws');
  });
}

// ---------------------------------------------------------------------------
// Case N: every failure is collected and reported at once
// ---------------------------------------------------------------------------
async function caseN() {
  await withTmpDir(async (tmpDir) => {
    // No Info.plist, no addons, no asar, no padding: four independent failures.
    buildAppFixture(tmpDir, {
      withInfoPlist: false,
      withExecutable: false,
      addons: [],
      asarBytes: false,
      padBytes: 0
    });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));

    assert(message.includes('Info.plist is missing'), 'Case N: reports the missing Info.plist');
    assert(message.includes('no *.node native addons'), 'Case N: reports the missing addons');
    assert(message.includes('better_sqlite3.node was not found'), 'Case N: reports the missing DB module');
    assert(message.includes('the packaged app is only'), 'Case N: reports the size floor');
    assert(message.includes('app.asar is missing'), 'Case N: reports the missing asar');
    assert(
      /failed 5 verification check\(s\)/.test(message),
      'Case N: all five failures arrive in a single error'
    );
    assert(
      message.includes('  1. ') && message.includes('  5. '),
      'Case N: the failures are enumerated for the release engineer'
    );
  });
}

// ---------------------------------------------------------------------------
// Case O: CYBOFLOW_SKIP_BUNDLE_CHECKS=1 skips the hard checks, loudly
// ---------------------------------------------------------------------------
async function caseO() {
  await withTmpDir(async (tmpDir) => {
    // A bundle that would fail every single check.
    buildAppFixture(tmpDir, {
      withInfoPlist: false,
      withExecutable: false,
      addons: [],
      asarBytes: false,
      padBytes: 0
    });

    const previous = process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS;
    process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS = '1';
    let result;
    try {
      result = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    } finally {
      if (previous === undefined) delete process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS;
      else process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS = previous;
    }

    assert(result.error === null, 'Case O: the skip switch suppresses the hard failure');
    const warnText = result.warnings.join('\n');
    assert(
      warnText.includes('CYBOFLOW_SKIP_BUNDLE_CHECKS=1'),
      'Case O: the skip is announced loudly on stderr'
    );
    assert(
      warnText.includes('Do not ship an artifact produced with this set.'),
      'Case O: the warning says the artifact must not ship'
    );
  });
}

// ---------------------------------------------------------------------------
// Case P: missing signing credentials do NOT skip the hard checks
// ---------------------------------------------------------------------------
async function caseP() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { addons: [] });

    const savedLink = process.env.CSC_LINK;
    const savedPassword = process.env.CSC_KEY_PASSWORD;
    delete process.env.CSC_LINK;
    delete process.env.CSC_KEY_PASSWORD;
    let result;
    try {
      result = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    } finally {
      if (savedLink !== undefined) process.env.CSC_LINK = savedLink;
      if (savedPassword !== undefined) process.env.CSC_KEY_PASSWORD = savedPassword;
    }

    assert(
      result.message.includes('no *.node native addons found'),
      'Case P: an unsigned dev build is still verified'
    );
  });
}

// ---------------------------------------------------------------------------
// Case Q: a bundle whose Info.plist points at a nonexistent executable
// ---------------------------------------------------------------------------
async function caseQ() {
  await withTmpDir(async (tmpDir) => {
    buildAppFixture(tmpDir, { withExecutable: false });
    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(
      message.includes('as CFBundleExecutable but'),
      'Case Q: a dangling CFBundleExecutable is reported'
    );
  });
}

// ---------------------------------------------------------------------------
// Case R: helper-level checks that do not need a bundle
// ---------------------------------------------------------------------------
async function caseR() {
  const { computeDirectorySize, collectNodeAddons, readBundleExecutableName, verifyBundle } = helpers;

  await withTmpDir(async (tmpDir) => {
    // Symlinks are skipped, so a link to a huge file cannot inflate the total.
    fs.writeFileSync(path.join(tmpDir, 'a.bin'), Buffer.alloc(1024));
    fs.symlinkSync(process.execPath, path.join(tmpDir, 'link-to-node'));
    assert(
      computeDirectorySize(tmpDir) === 1024,
      'Case R: directory size counts real files and skips symlinks'
    );

    fs.mkdirSync(path.join(tmpDir, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'nested', 'deeper', 'x.node'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'nested', 'notes.txt'), 'x');
    const addons = collectNodeAddons(path.join(tmpDir, 'nested'));
    assert(addons.length === 1 && addons[0].endsWith('x.node'), 'Case R: only *.node files are collected');

    assert(
      collectNodeAddons(path.join(tmpDir, 'does-not-exist')).length === 0,
      'Case R: a missing directory yields no addons rather than throwing'
    );

    const appPath = buildAppFixture(tmpDir);
    assert(
      readBundleExecutableName(appPath).name === PRODUCT_NAME,
      'Case R: CFBundleExecutable is read out of Info.plist'
    );

    // electron-builder writes XML today, but a binary plist must still resolve.
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    try {
      require('child_process').execFileSync('plutil', ['-convert', 'binary1', plistPath]);
      assert(
        fs.readFileSync(plistPath).slice(0, 8).toString('latin1') === 'bplist00',
        'Case R: the fixture Info.plist really is a binary plist now'
      );
      assert(
        readBundleExecutableName(appPath).name === PRODUCT_NAME,
        'Case R: a binary Info.plist is converted (to stdout) and read'
      );
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        console.log('SKIP: Case R binary-plist check needs plutil');
      } else {
        throw err;
      }
    }

    assert(
      verifyBundle({ appPath: path.join(tmpDir, 'Nope.app'), expectedArch: 'arm64' })[0]
        .includes('missing entirely'),
      'Case R: a missing .app is a single, self-explanatory failure'
    );

    const unresolved = verifyBundle({ appPath, expectedArch: null });
    assert(
      unresolved.some((failure) => failure.includes('could not determine the expected architecture')),
      'Case R: an unresolvable arch fails rather than silently skipping'
    );
  });
}

// ---------------------------------------------------------------------------
// Case S: the third historical release failure, end to end.
// The bundle's "Electron" is the real Electron binary and its
// better_sqlite3.node carries the HOST ABI — the exact shape of the mismatch
// that shipped. Nothing here is stubbed.
// ---------------------------------------------------------------------------
async function caseS() {
  const electronBinary = resolveElectronBinary();
  const addon = resolveHostLoadableAddon();
  if (!electronBinary || !addon) {
    console.log('SKIP: Case S needs Electron plus a host-ABI better_sqlite3.node');
    return;
  }
  await withTmpDir(async (tmpDir) => {
    const appPath = buildAppFixture(tmpDir, {
      withExecutable: false,
      addons: [{ name: 'better_sqlite3.node', source: addon }]
    });
    fs.symlinkSync(electronBinary, path.join(appPath, 'Contents', 'MacOS', PRODUCT_NAME));

    const { message } = await runCapturing(macArchContext(tmpDir, hostArchOrdinal()));
    assert(message !== '', 'Case S: an ABI-mismatched bundle fails the build');
    assert(
      message.includes('NODE_MODULE_VERSION'),
      'Case S: the build error carries the NODE_MODULE_VERSION diagnosis'
    );
    assert(
      message.includes('cannot load the packaged better_sqlite3.node'),
      'Case S: the build error explains which module is at fault'
    );
    assert(
      !message.includes('asar-fs-wrapper'),
      "Case S: Electron's minified bootstrap dump is stripped from the message"
    );
  });
}

// ---------------------------------------------------------------------------
// Case T: stderr summarization keeps the message, drops the bundle
// ---------------------------------------------------------------------------
async function caseT() {
  const { summarizeProbeStderr } = helpers;
  const minified = `(()=>{${'x'.repeat(9000)}})()`;
  const summarized = summarizeProbeStderr(
    `node:electron/js2c/node_init:2\n${minified}\n\nError: NODE_MODULE_VERSION 127 vs 136\n`
  );
  assert(!summarized.includes('xxxx'), 'Case T: the minified bootstrap line is dropped');
  assert(
    summarized.includes('NODE_MODULE_VERSION 127 vs 136'),
    'Case T: the human-readable error survives'
  );
  assert(
    summarizeProbeStderr(`${'short line\n'.repeat(2000)}TAIL MARKER`).includes('TAIL MARKER'),
    'Case T: when truncation is needed the TAIL is kept, not the head'
  );
}

// ---------------------------------------------------------------------------
// Case U: the universal-bundle rules, via the injectable command runner.
// A half-universal main executable cannot be produced on a single-arch host,
// so this is the one place command execution is stubbed.
// ---------------------------------------------------------------------------
async function caseU() {
  const { verifyBundle } = helpers;

  /** Stub `lipo` per file suffix; let the ABI probe succeed. */
  function stubExecFile(slicesBySuffix) {
    return (file, args) => {
      if (file !== 'lipo') return '';
      const target = args[args.length - 1];
      const suffix = Object.keys(slicesBySuffix).find((key) => target.endsWith(key));
      return `${slicesBySuffix[suffix] || 'arm64'}\n`;
    };
  }

  await withTmpDir(async (tmpDir) => {
    const appPath = buildAppFixture(tmpDir);

    const halfUniversal = verifyBundle({
      appPath,
      expectedArch: 'universal',
      execFile: stubExecFile({ [PRODUCT_NAME]: 'x86_64', 'better_sqlite3.node': 'arm64' })
    });
    assert(
      halfUniversal.length === 1 && halfUniversal[0].includes(`MacOS/${PRODUCT_NAME}`),
      'Case U: a universal bundle whose main executable has one slice is rejected'
    );
    assert(
      !halfUniversal[0].includes('better_sqlite3.node'),
      'Case U: a single-slice addon inside a universal bundle is allowed (x64ArchFiles)'
    );

    const fullyUniversal = verifyBundle({
      appPath,
      expectedArch: 'universal',
      execFile: stubExecFile({ [PRODUCT_NAME]: 'x86_64 arm64', 'better_sqlite3.node': 'arm64' })
    });
    assert(fullyUniversal.length === 0, 'Case U: a genuinely universal bundle passes');

    const lipoBroken = verifyBundle({
      appPath,
      expectedArch: 'arm64',
      execFile: (file) => {
        if (file === 'lipo') throw new Error('fat file has no architectures');
        return '';
      }
    });
    assert(
      lipoBroken.some((failure) => failure.includes('could not read the architecture')),
      'Case U: an unreadable binary is a failure, not a silent pass'
    );
  });
}

// Case V: foreign-platform prebuilds are skipped, not fed to lipo.
// node-pty-prebuilt-multiarch bundles linux/win32/etc prebuilds that are ELF/PE,
// not Mach-O. They must be excluded from the arch check (they crashed lipo and
// produced 48 spurious failures on the 0.2.6 build).
async function caseV() {
  const { isForeignPrebuild, collectNodeAddons } = helpers;

  assert(isForeignPrebuild(`root/node-pty/prebuilds/linux-arm/node.abi127.node`),
    'Case V: linux-arm prebuild is foreign');
  assert(isForeignPrebuild(`root/node-pty/prebuilds/linux-x64/node.abi127.musl.node`),
    'Case V: linux-x64 musl prebuild is foreign');
  assert(isForeignPrebuild(`root/node-pty/prebuilds/win32-x64/node.abi127.node`),
    'Case V: win32-x64 prebuild is foreign');
  assert(!isForeignPrebuild(`root/node-pty/prebuilds/darwin-arm64/node.abi127.node`),
    'Case V: darwin-arm64 prebuild is NOT foreign');
  assert(!isForeignPrebuild(`root/node-pty/prebuilds/darwin-x64/node.abi127.node`),
    'Case V: darwin-x64 prebuild is NOT foreign');
  assert(!isForeignPrebuild(`root/better-sqlite3/build/Release/better_sqlite3.node`),
    'Case V: a non-prebuild addon is NOT foreign');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const root = path.join(tmpDir, 'app.asar.unpacked');
    const layout = {
      'better-sqlite3/build/Release/better_sqlite3.node': 'x',
      'node-pty/prebuilds/darwin-arm64/node.abi127.node': 'x',
      'node-pty/prebuilds/darwin-x64/node.abi127.node': 'x',
      'node-pty/prebuilds/linux-arm/node.abi127.node': 'x',
      'node-pty/prebuilds/linux-x64/node.abi127.musl.node': 'x',
      'node-pty/prebuilds/win32-x64/node.abi127.node': 'x',
    };
    for (const [rel, body] of Object.entries(layout)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }

    const collected = collectNodeAddons(root).map((f) => path.basename(path.dirname(f)));
    assert(collected.length === 3,
      `Case V: only the 3 macOS addons are collected (got ${collected.length}: ${collected.join(', ')})`);
    assert(!collected.includes('linux-arm') && !collected.includes('linux-x64') && !collected.includes('win32-x64'),
      'Case V: no foreign prebuild survives collection');
    assert(collected.includes('darwin-arm64') && collected.includes('darwin-x64'),
      'Case V: both darwin prebuilds survive collection');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Windows arm (cases W-AA). The mac arm's fixtures are Mach-O/symlink based,
// which only proves things on macOS; the win-unpacked layout needs its own.
// ---------------------------------------------------------------------------

/**
 * A minimal but structurally valid PE image carrying `machine` in its COFF
 * header — enough for readPeMachineType, and spawnable-but-broken when used
 * as a fake packaged executable.
 */
function peImageBuffer(machine) {
  const buffer = Buffer.alloc(0x100);
  buffer.writeUInt16LE(0x5a4d, 0); // 'MZ'
  buffer.writeUInt32LE(0x80, 0x3c); // PE signature offset
  buffer.writeUInt32LE(0x00004550, 0x80); // 'PE\0\0'
  buffer.writeUInt16LE(machine, 0x84); // COFF Machine field
  return buffer;
}

function winContext(appOutDir, arch, platformName = 'windows') {
  return {
    appOutDir,
    arch,
    packager: {
      platform: { name: platformName },
      appInfo: { productName: PRODUCT_NAME }
    }
  };
}

/**
 * Build a fake win-unpacked tree under `tmpDir` — the Windows counterpart of
 * buildAppFixture. Defaults produce a bundle whose only weakness is its size;
 * each option turns exactly one more check off.
 */
function buildWinUnpackedFixture(tmpDir, options = {}) {
  const opts = {
    withExecutable: true,
    executableBytes: undefined,
    addons: undefined,
    padBytes: 0,
    nestedLayout: false,
    ...options
  };

  // Real electron-builder shape on Windows: appOutDir IS the win-unpacked dir.
  // (nested=true lays it one level down, for the legacy-shape acceptance test.)
  const unpackedDir = opts.nestedLayout
    ? path.join(tmpDir, 'win-unpacked')
    : tmpDir;
  fs.mkdirSync(unpackedDir, { recursive: true });

  if (opts.withExecutable) {
    const exePath = path.join(unpackedDir, `${PRODUCT_NAME}.exe`);
    if (opts.executableBytes) {
      fs.writeFileSync(exePath, opts.executableBytes);
    } else {
      // The host binary is a real PE of the host arch that really behaves as
      // Node when spawned. Symlink where the FS allows it, else copy.
      try {
        fs.symlinkSync(process.execPath, exePath, 'file');
      } catch (_err) {
        fs.copyFileSync(process.execPath, exePath);
      }
    }
  }

  const addons = opts.addons === undefined
    ? [{ name: 'better_sqlite3.node', source: resolveHostLoadableAddon() || process.execPath }]
    : opts.addons;
  for (const addon of addons) {
    const dest = path.join(
      unpackedDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      addon.dep || 'some-dep',
      'build',
      'Release',
      addon.name
    );
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(addon.source, dest);
  }

  if (opts.padBytes > 0) {
    writeSparseFile(path.join(unpackedDir, 'resources', 'padding.bin'), opts.padBytes);
  }

  return unpackedDir;
}

// Case W: the PE machine-type parser, against crafted and REAL PE images.
async function caseW() {
  const { readPeMachineType, PE_MACHINE_BY_ARCH, DEFAULT_MIN_WIN_UNPACKED_BYTES } = helpers;

  assert(
    DEFAULT_MIN_WIN_UNPACKED_BYTES === 300 * 1024 * 1024,
    'Case W: the win-unpacked size floor defaults to 300 MB'
  );
  assert(readPeMachineType(peImageBuffer(0x8664)) === 0x8664, 'Case W: an x64 PE image parses to 0x8664');
  assert(readPeMachineType(peImageBuffer(0xaa64)) === 0xaa64, 'Case W: an arm64 PE image parses to 0xAA64');

  assert(readPeMachineType(Buffer.from('hello, not an executable at all')) === null,
    'Case W: a non-MZ buffer parses to null');
  assert(readPeMachineType(Buffer.from('MZ')) === null,
    'Case W: an MZ-only buffer shorter than the DOS header parses to null');
  assert(readPeMachineType(peImageBuffer(0x8664).subarray(0, 0x40)) === null,
    'Case W: a buffer cut off before the PE signature parses to null');
  const truncated = peImageBuffer(0x8664); truncated.writeUInt32LE(truncated.length - 4, 0x3c);
  assert(readPeMachineType(truncated) === null,
    'Case W: a PE signature with no room for the machine field parses to null');
  const wrongSig = peImageBuffer(0x8664); wrongSig.writeUInt32LE(0xdeadbeef, 0x80);
  assert(readPeMachineType(wrongSig) === null,
    'Case W: an MZ buffer with a bad PE signature parses to null');

  if (process.platform === 'win32') {
    // The host binary really is a PE; its machine must match this process.
    assert(
      readPeMachineType(fs.readFileSync(process.execPath)) === PE_MACHINE_BY_ARCH[process.arch],
      `Case W: the host executable's PE machine matches ${process.arch}`
    );
  }
}

// Case X: Windows addon collection skips prebuilds/ dirs ENTIRELY (every
// platform's prebuild rides along and none of them is the loadable addon).
async function caseX() {
  const { collectNodeAddonsForWindows } = helpers;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const root = path.join(tmpDir, 'app.asar.unpacked');
    const layout = {
      'better-sqlite3/build/Release/better_sqlite3.node': 'x',
      'node-pty/build/Release/pty.node': 'x',
      'node-pty/prebuilds/win32-x64/node.abi127.node': 'x',
      'node-pty/prebuilds/darwin-arm64/node.abi127.node': 'x',
      'some-dep/prebuilds/anything/node.node': 'x',
      'some-dep/notes.txt': 'x',
    };
    for (const [rel, body] of Object.entries(layout)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }

    const collected = collectNodeAddonsForWindows(root).map((f) => path.basename(f));
    assert(collected.length === 2,
      `Case X: exactly the two build/Release addons are collected (got ${collected.length}: ${collected.join(', ')})`);
    assert(collected.includes('better_sqlite3.node') && collected.includes('pty.node'),
      'Case X: the collected set is better_sqlite3.node and pty.node');

    assert(
      collectNodeAddonsForWindows(path.join(tmpDir, 'does-not-exist')).length === 0,
      'Case X: a missing directory yields no addons rather than throwing'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Case Y: a healthy win-unpacked bundle passes the HOOK end to end — real PE
// on the main executable, real ABI probe, default size floor. Needs a
// host-loadable better_sqlite3.node and an x64 host.
async function caseY() {
  const addon = resolveHostLoadableAddon();
  if (!addon || process.arch !== 'x64') {
    console.log(
      'SKIP: Case Y needs a host-loadable better_sqlite3.node on an x64 Windows host ' +
        '(install the win32-x64 node prebuild of better-sqlite3)'
    );
    return;
  }
  await withTmpDir(async (tmpDir) => {
    // The default floor is 300 MB and the hook does not inject a smaller one,
    // so the fixture pads past it; sparse, like the mac fixtures.
    buildWinUnpackedFixture(tmpDir, {
      addons: [{ name: 'better_sqlite3.node', source: addon }],
      padBytes: 310 * 1024 * 1024,
    });
    const { message, warnings } = await runCapturing(winContext(tmpDir, ARCH.x64));
    assert(message === '', `Case Y: a healthy win-unpacked bundle does not throw (got: ${message})`);
    assert(warnings.length === 0, 'Case Y: a healthy bundle emits no warnings');
  });
}

// Case Z: failing win bundles — every independent failure in ONE error.
async function caseZ() {
  // (a) win-unpacked missing entirely; also pins the bare "win" platform name.
  await withTmpDir(async (tmpDir) => {
    const { message } = await runCapturing(winContext(tmpDir, ARCH.x64, 'win'));
    assert(message !== '', 'Case Z(a): a missing win-unpacked directory throws');
    assert(
      message.includes('missing entirely') && message.includes('TestApp.exe'),
      'Case Z(a): the error names the missing app directory and expected exe'
    );
  });

  // (b) wrong-arch PE + unloadable addon + stub size — reported together.
  await withTmpDir(async (tmpDir) => {
    buildWinUnpackedFixture(tmpDir, {
      executableBytes: peImageBuffer(0xaa64), // arm64 where x64 is expected
      addons: [{ name: 'better_sqlite3.node', source: process.execPath }],
    });
    const { message } = await runCapturing(winContext(tmpDir, ARCH.x64));

    assert(message !== '', 'Case Z(b): a broken win bundle throws');
    assert(
      message.includes('PE machine 0xaa64') && message.includes('expected 0x8664'),
      'Case Z(b): the error reports the PE machine mismatch'
    );
    assert(
      message.includes('cannot load the packaged better_sqlite3.node'),
      'Case Z(b): the error reports the failed ABI probe'
    );
    assert(
      message.includes('the unpacked app is only'),
      'Case Z(b): the error reports the unpacked size floor'
    );
    assert(
      /failed 3 verification check\(s\)/.test(message),
      'Case Z(b): all three failures arrive in ONE error'
    );
  });

  // (c) the packaged executable missing from win-unpacked.
  await withTmpDir(async (tmpDir) => {
    buildWinUnpackedFixture(tmpDir, {
      withExecutable: false,
      addons: [{ name: 'better_sqlite3.node', source: process.execPath }],
    });
    const { message } = await runCapturing(winContext(tmpDir, ARCH.x64));
    assert(
      message.includes('missing entirely') && message.includes('TestApp.exe'),
      'Case Z(c): a missing <productName>.exe is reported as a missing app dir'
    );
    assert(
      !message.includes('cannot load the packaged'),
      'Case Z(c): the probe is skipped (no executable to spawn) rather than failing twice'
    );
  });

  // (d) no native addons at all.
  await withTmpDir(async (tmpDir) => {
    buildWinUnpackedFixture(tmpDir, { addons: [], padBytes: 310 * 1024 * 1024 });
    const { message } = await runCapturing(winContext(tmpDir, ARCH.x64));
    assert(message !== '', 'Case Z(d): a bundle with no native addons throws');
    assert(
      message.includes('no *.node native addons found'),
      'Case Z(d): the error explains that native modules were not unpacked'
    );
    assert(
      message.includes('better_sqlite3.node was not found'),
      'Case Z(d): the missing DB module is reported too'
    );
    assert(
      !message.includes('the unpacked app is only'),
      'Case Z(d): the size floor passes, so only the addon failures fire'
    );
  });
}

// Case AA: CYBOFLOW_SKIP_BUNDLE_CHECKS=1 suppresses the Windows checks, loudly.
async function caseAA() {
  await withTmpDir(async (tmpDir) => {
    const previous = process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS;
    process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS = '1';
    let result;
    try {
      result = await runCapturing(winContext(tmpDir, ARCH.x64));
    } finally {
      if (previous === undefined) delete process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS;
      else process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS = previous;
    }
    assert(result.error === null, 'Case AA: the skip switch suppresses the win hard failure');
    assert(
      result.warnings.join('\n').includes('CYBOFLOW_SKIP_BUNDLE_CHECKS=1'),
      'Case AA: the skip is announced loudly on stderr'
    );
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('--- afterSign smoke test ---');
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  await caseE();
  if (process.platform === 'darwin') {
    // Cases F–V exercise REAL macOS `codesign`/`lipo`/`plutil` against
    // Mach-O fixtures (and dlopen a host-ABI addon). The fixtures also
    // symlink the host binary into a fake .app, which Windows only permits
    // with admin/Developer-Mode privileges. These are mac-posture probes —
    // the mac arm of the hook is darwin-only; Windows gets verifyWindowsBundle
    // instead, pinned by cases W-AA below.
    await caseF();
    await caseG();
    await caseH();
    await caseI();
    await caseJ();
    await caseK();
    await caseL();
    await caseM();
    await caseN();
    await caseO();
    await caseP();
    await caseQ();
    await caseR();
    await caseS();
    await caseT();
    await caseU();
    await caseV();
  } else {
    console.log(
      `SKIP: cases F-V are darwin-only (host is ${process.platform}); codesign/lipo/Mach-O probes cannot run here.`,
    );
  }
  // W and X need no Windows host: W parses crafted PE buffers (its one real-
  // binary assertion is guarded inside), and X lists a temp directory. Running
  // them everywhere is what gives the macOS CI a signal on the Windows arm of
  // afterSign, which is the script that decides whether an artifact ships.
  await caseW();
  await caseX();

  if (process.platform === 'win32') {
    // Y-AA drive the hook against win-unpacked fixtures: Y needs a
    // host-loadable better_sqlite3.node, and Z and AA spawn the packaged
    // executable for the ABI probe.
    await caseY();
    await caseZ();
    await caseAA();
  } else {
    console.log(
      `SKIP: cases Y-AA are win32-only (host is ${process.platform}); the win-unpacked fixtures cannot run here.`,
    );
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
